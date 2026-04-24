#!/usr/bin/env node
/**
 * Re-match FIFO from existing activity.jsonl files WITHOUT re-fetching.
 * Uses the fixed REDEEM logic (usdcSize/size instead of price=0).
 *
 * Usage:
 *   node scripts/rematch-fifo.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";

const DIR = path.resolve("data/wallet-complete");
const num = (x, d = 0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };

function matchFifo(events, wallet) {
  const books = new Map();
  const closed = [];
  events.sort((a, b) => num(a.timestamp) - num(b.timestamp));
  for (const ev of events) {
    const ts = num(ev.timestamp);
    const cid = ev.conditionId;
    if (!cid) continue;
    const outcomeIdx = ev.outcomeIndex !== undefined && ev.outcomeIndex < 2
      ? num(ev.outcomeIndex)
      : (String(ev.outcome || "").toLowerCase() === "yes" ? 0 : 1);
    const side = outcomeIdx === 0 ? "YES" : "NO";
    const key = `${cid}-${outcomeIdx}`;
    if (!books.has(key)) books.set(key, { lots: [], title: ev.title, asset: ev.asset });
    const book = books.get(key);
    if (!book.title && ev.title) book.title = ev.title;
    if (!book.asset && ev.asset) book.asset = ev.asset;
    const type = String(ev.type || "").toUpperCase();
    const action = String(ev.side || "").toUpperCase();
    if (type === "TRADE" && action === "BUY") {
      book.lots.push({ shares: num(ev.size), price: num(ev.price), usdc: num(ev.usdcSize || ev.size * ev.price), ts });
    } else if (type === "TRADE" && action === "SELL") {
      let remaining = num(ev.size);
      const exitPrice = num(ev.price);
      const lotsUsed = [];
      let costBasis = 0;
      while (remaining > 1e-9 && book.lots.length) {
        const lot = book.lots[0];
        const taken = Math.min(remaining, lot.shares);
        costBasis += taken * lot.price;
        lotsUsed.push({ shares: taken, price: lot.price, ts: lot.ts });
        lot.shares -= taken;
        remaining -= taken;
        if (lot.shares < 1e-9) book.lots.shift();
      }
      const matched = lotsUsed.reduce((s, l) => s + l.shares, 0);
      if (matched > 0) {
        const entryAvg = costBasis / matched;
        closed.push({
          wallet, conditionId: cid, outcomeIndex: outcomeIdx, side, asset: book.asset, title: book.title,
          type: "sell", openTs: lotsUsed[0].ts, closeTs: ts, holdMinutes: (ts - lotsUsed[0].ts) / 60,
          shares: matched, entryAvg, exitPrice,
          entryUsdc: costBasis, exitUsdc: matched * exitPrice,
          pnlUsdc: matched * (exitPrice - entryAvg), pnlPerShare: exitPrice - entryAvg,
        });
      }
    } else if (type === "REDEEM") {
      let remaining = book.lots.reduce((s, l) => s + l.shares, 0);
      if (remaining < 1e-9) continue;
      const size = num(ev.size, 0);
      const usdc = num(ev.usdcSize, 0);
      // REDEEM price=0 in the API is meaningless; compute actual per-share payout
      const redemptionPrice = size > 0 ? usdc / size : 0;
      const lotsUsed = [...book.lots];
      const costBasis = lotsUsed.reduce((s, l) => s + l.shares * l.price, 0);
      const entryAvg = costBasis / remaining;
      closed.push({
        wallet, conditionId: cid, outcomeIndex: outcomeIdx, side, asset: book.asset, title: book.title,
        type: "redeem", openTs: lotsUsed[0]?.ts ?? ts, closeTs: ts, holdMinutes: (ts - (lotsUsed[0]?.ts ?? ts)) / 60,
        shares: remaining, entryAvg, exitPrice: redemptionPrice,
        entryUsdc: costBasis, exitUsdc: remaining * redemptionPrice,
        pnlUsdc: remaining * (redemptionPrice - entryAvg),
        pnlPerShare: redemptionPrice - entryAvg,
        redemptionWon: redemptionPrice > 0.5,
      });
      book.lots = [];
    }
  }
  const openLots = [];
  for (const [key, book] of books) {
    if (book.lots.length > 0) {
      openLots.push({ key, title: book.title, lots: book.lots, totalShares: book.lots.reduce((s,l)=>s+l.shares,0) });
    }
  }
  return { closed, openLots };
}

const wallets = (await fs.readdir(DIR)).filter(f => f.startsWith("0x"));
console.log(`Re-matching FIFO for ${wallets.length} wallets with fixed REDEEM logic...\n`);

const allSummaries = [];
for (const w of wallets) {
  const walletDir = path.join(DIR, w);
  const activityFile = path.join(walletDir, "activity.jsonl");
  let activityText;
  try { activityText = await fs.readFile(activityFile, "utf8"); } catch { continue; }
  const events = activityText.trim().split("\n").filter(Boolean).map(JSON.parse);
  const { closed, openLots } = matchFifo(events, w);

  await fs.writeFile(path.join(walletDir, "closed-trades.jsonl"),
    closed.map(c => JSON.stringify(c)).join("\n") + (closed.length ? "\n" : ""));
  await fs.writeFile(path.join(walletDir, "open-lots.json"), JSON.stringify(openLots, null, 2));

  const realized = closed.reduce((s, c) => s + (c.pnlUsdc || 0), 0);
  const wins = closed.filter(c => c.pnlUsdc > 0.01).length;
  const losses = closed.filter(c => c.pnlUsdc < -0.01).length;
  const sellTrades = closed.filter(c => c.type === "sell");
  const redeemTrades = closed.filter(c => c.type === "redeem");
  const weatherClosed = closed.filter(c => /temperature/i.test(c.title || ""));
  const weatherSell = weatherClosed.filter(c => c.type === "sell");
  const weatherRedeem = weatherClosed.filter(c => c.type === "redeem");
  const weatherRealized = weatherClosed.reduce((s, c) => s + (c.pnlUsdc || 0), 0);
  const weatherWins = weatherClosed.filter(c => c.pnlUsdc > 0.01).length;
  const weatherRedeemWon = weatherRedeem.filter(c => c.redemptionWon).length;
  const weatherRedeemLost = weatherRedeem.filter(c => !c.redemptionWon).length;

  let oldSum = {};
  try { oldSum = JSON.parse(await fs.readFile(path.join(walletDir, "summary.json"), "utf8")); } catch {}
  const summary = {
    ...oldSum,
    wallet: w, fetchedAt: new Date().toISOString(),
    closedTradeCount: closed.length,
    closedSellCount: sellTrades.length,
    closedRedeemCount: redeemTrades.length,
    openLotCount: openLots.length,
    realizedPnlUsdc: realized,
    winRateStrict: closed.length ? wins / closed.length : 0,
    wins, losses,
    weatherClosedCount: weatherClosed.length,
    weatherSellCount: weatherSell.length,
    weatherRedeemCount: weatherRedeem.length,
    weatherRedeemWon, weatherRedeemLost,
    weatherRedeemWR: weatherRedeem.length ? weatherRedeemWon / weatherRedeem.length : null,
    weatherRealizedPnl: weatherRealized,
    weatherWinRate: weatherClosed.length ? weatherWins / weatherClosed.length : 0,
    weatherWins,
  };
  await fs.writeFile(path.join(walletDir, "summary.json"), JSON.stringify(summary, null, 2));
  allSummaries.push(summary);
}

allSummaries.sort((a, b) => (b.weatherRealizedPnl || 0) - (a.weatherRealizedPnl || 0));
await fs.writeFile(path.join(DIR, "_all-winners.json"), JSON.stringify(allSummaries, null, 2));

console.log("Top 15 by weather realized PnL (NOW WITH CORRECT REDEEMS):");
console.log("  wallet       total  sell  redeem  redWR%  weather$");
for (const s of allSummaries.slice(0, 15)) {
  const rwr = s.weatherRedeemWR != null ? (s.weatherRedeemWR*100).toFixed(0)+"%" : "-";
  const wallet = s.wallet.slice(0,12);
  console.log(`  ${wallet}  ${String(s.weatherClosedCount).padStart(5)} ${String(s.weatherSellCount).padStart(5)} ${String(s.weatherRedeemCount).padStart(7)} ${rwr.padStart(7)} $${(s.weatherRealizedPnl||0).toFixed(0).padStart(8)}`);
}
