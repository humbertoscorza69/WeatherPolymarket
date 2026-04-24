#!/usr/bin/env node
/**
 * Read an archived detect-positions.*.archive.json, look up each position's
 * resolution status via Polymarket /events, compute hypothetical realized
 * PnL as if those positions had settled in the live state. Does NOT touch
 * the live state — read-only analysis.
 *
 * Usage:
 *   node scripts/settle-archive.mjs                    # auto-picks most recent archive
 *   node scripts/settle-archive.mjs --tag=v22
 *   node scripts/settle-archive.mjs --file=data/detect-positions.v22.archive.json
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { __error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) { return { __error: String(e?.message || e) }; }
}

async function fetchWeatherMarketsByCondition() {
  const map = new Map();
  for (const closedFilter of [false, true]) {
    let offset = 0;
    while (offset < 5000) {
      const url = `${GAMMA}/events?closed=${closedFilter}&tag_slug=weather&limit=100&offset=${offset}`;
      const page = await fetchJson(url);
      if (!Array.isArray(page) || !page.length) break;
      for (const ev of page) {
        for (const m of (ev.markets || [])) {
          if (!m.conditionId) continue;
          let yesPrice = null, noPrice = null;
          if (m.outcomePrices) {
            try {
              const parsed = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
              if (Array.isArray(parsed) && parsed.length >= 2) {
                yesPrice = Number(parsed[0]); noPrice = Number(parsed[1]);
              }
            } catch {}
          }
          map.set(String(m.conditionId).toLowerCase(), {
            yesPrice, noPrice,
            closed: m.closed === true,
            lastTradePrice: m.lastTradePrice != null ? Number(m.lastTradePrice) : null,
          });
        }
      }
      if (page.length < 100) break;
      offset += 100;
    }
  }
  return map;
}

async function fetchBookMidpoint(noTokenId) {
  if (!noTokenId) return null;
  const r = await fetchJson(`${CLOB}/book?token_id=${noTokenId}`);
  const bids = Array.isArray(r?.bids) ? r.bids : [];
  const asks = Array.isArray(r?.asks) ? r.asks : [];
  const bb = bids.length ? Number(bids[bids.length - 1]?.price) : null;
  const ba = asks.length ? Number(asks[0]?.price) : null;
  if (Number.isFinite(bb) && Number.isFinite(ba)) return (bb + ba) / 2;
  if (Number.isFinite(bb)) return bb;
  if (Number.isFinite(ba)) return ba;
  return null;
}

async function findArchive() {
  if (argv.file) return path.resolve(argv.file);
  const dir = path.resolve("data");
  const entries = await fs.readdir(dir);
  const tag = argv.tag;
  const matches = entries
    .filter(f => /^detect-positions\..+\.archive\.json$/.test(f))
    .filter(f => !tag || f.includes(tag))
    .map(f => path.join(dir, f));
  if (!matches.length) return null;
  const stats = await Promise.all(matches.map(async f => ({ f, mtime: (await fs.stat(f)).mtimeMs })));
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats[0].f;
}

async function main() {
  const archiveFile = await findArchive();
  if (!archiveFile || !existsSync(archiveFile)) {
    console.error(`No archive found. Expected data/detect-positions.*.archive.json.`);
    console.error(`Run 'npm run archive' first, or pass --file=<path>.`);
    process.exit(1);
  }
  console.log(`Archive: ${archiveFile}`);
  const state = JSON.parse(await fs.readFile(archiveFile, "utf8"));
  const open = Array.isArray(state.positions) ? state.positions : [];
  const closedAtArchive = Array.isArray(state.trades) ? state.trades : [];

  console.log(`\nArchived state snapshot:`);
  console.log(`  Open at archive time:    ${open.length}`);
  console.log(`  Closed at archive time:  ${closedAtArchive.length}`);
  console.log(`  Realized at archive:     $${(state.realizedPnl || 0).toFixed(2)}`);

  // Fetch current resolution state for all conditionIds
  console.log(`\nFetching resolution state from Polymarket /events…`);
  const marketMap = await fetchWeatherMarketsByCondition();
  console.log(`  Indexed ${marketMap.size} weather markets.`);

  // Classify each archived open position
  const results = { resolved_win: [], resolved_loss: [], still_pending: [], not_found: [] };
  const needTaker = [];
  for (const p of open) {
    const cid = String(p.conditionId).toLowerCase();
    const m = marketMap.get(cid);
    if (!m) { results.not_found.push(p); continue; }
    const yesP = m.yesPrice, noP = m.noPrice;
    const priceResolved = Number.isFinite(yesP) && Number.isFinite(noP)
      && Math.max(yesP, noP) >= 0.999 && Math.min(yesP, noP) <= 0.001;
    if (priceResolved) {
      const yesWon = yesP >= 0.5;
      const ourSideWon = (p.side === "YES" && yesWon) || (p.side === "NO" && !yesWon);
      const exitPrice = ourSideWon ? 1 : 0;
      const pnl = Number(p.shares) * (exitPrice - Number(p.entryPrice));
      (ourSideWon ? results.resolved_win : results.resolved_loss).push({ ...p, exitPrice, pnl });
    } else if (m.closed) {
      // Closed but prices ambiguous — take current mid as best-effort exit
      needTaker.push(p);
    } else {
      results.still_pending.push(p);
    }
  }

  // Resolve taker prices (closed-but-ambiguous) by querying CLOB book
  if (needTaker.length) {
    console.log(`  Taker-exit lookup for ${needTaker.length} closed-but-ambiguous markets…`);
    for (const p of needTaker) {
      const tokens = p.clobTokenIds;
      let exitPrice = null;
      if (Array.isArray(tokens) && tokens.length >= 2) {
        const mid = await fetchBookMidpoint(tokens[1]);
        if (mid != null) exitPrice = p.side === "NO" ? mid : (1 - mid);
      }
      if (exitPrice != null) {
        const pnl = Number(p.shares) * (exitPrice - Number(p.entryPrice));
        if (pnl > 0.01) results.resolved_win.push({ ...p, exitPrice, pnl, status: "taker" });
        else results.resolved_loss.push({ ...p, exitPrice, pnl, status: "taker" });
      } else {
        results.still_pending.push(p);
      }
    }
  }

  // Summaries
  const wins = results.resolved_win;
  const losses = results.resolved_loss;
  const sumWin = wins.reduce((s, p) => s + (p.pnl || 0), 0);
  const sumLoss = losses.reduce((s, p) => s + (p.pnl || 0), 0);
  const totalDecided = wins.length + losses.length;
  const netPnl = sumWin + sumLoss;
  const wr = totalDecided ? wins.length / totalDecided : 0;
  const costBasis = open.reduce((s, p) => s + Number(p.positionSize || 0), 0);

  console.log(`\n=== Hypothetical archive settlement ===`);
  console.log(`  Resolved wins:   ${wins.length}  (+$${sumWin.toFixed(2)})`);
  console.log(`  Resolved losses: ${losses.length}  ($${sumLoss.toFixed(2)})`);
  console.log(`  Still pending:   ${results.still_pending.length}`);
  console.log(`  Not found:       ${results.not_found.length}`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  WR (decided):    ${(wr*100).toFixed(1)}% (${wins.length}/${totalDecided})`);
  console.log(`  Net PnL:         $${netPnl.toFixed(2)}`);
  console.log(`  Cost basis:      $${costBasis.toFixed(2)}`);
  console.log(`  ROI on exposure: ${costBasis > 0 ? (netPnl/costBasis*100).toFixed(1)+"%" : "—"}`);

  // Per-reason breakdown
  const byReason = new Map();
  for (const arr of [wins, losses]) for (const p of arr) {
    const k = p.reason || "?";
    if (!byReason.has(k)) byReason.set(k, { n: 0, w: 0, pnl: 0 });
    const g = byReason.get(k);
    g.n++; g.pnl += p.pnl;
    if ((p.pnl || 0) > 0.01) g.w++;
  }
  if (byReason.size) {
    console.log(`\n=== By signal reason ===`);
    console.log(`  ${"reason".padEnd(28)}  ${"n".padStart(5)}  ${"W".padStart(5)}  ${"WR".padStart(6)}  ${"PnL".padStart(9)}`);
    for (const [k, g] of [...byReason.entries()].sort((a,b) => b[1].pnl - a[1].pnl)) {
      console.log(`  ${k.padEnd(28)}  ${String(g.n).padStart(5)}  ${String(g.w).padStart(5)}  ${(100*g.w/g.n).toFixed(1).padStart(5)}%  ${("$"+g.pnl.toFixed(2)).padStart(9)}`);
    }
  }

  // Top losers
  if (losses.length) {
    losses.sort((a, b) => a.pnl - b.pnl);
    console.log(`\n=== Top 10 losers (worst first) ===`);
    for (const p of losses.slice(0, 10)) {
      console.log(`  ${p.side.padEnd(4)} ${(p.city||"?").padEnd(14)} ${(p.reason||"?").padEnd(24)} entry ${Number(p.entryPrice).toFixed(4)} → exit ${Number(p.exitPrice).toFixed(4)}  pnl ${p.pnl.toFixed(2)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
