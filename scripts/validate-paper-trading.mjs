#!/usr/bin/env node
/**
 * Validate paper-trading results against real Polymarket tick data.
 *
 * Reads data/detect-log.jsonl (your OPEN/CLOSE events) and for each market,
 * fetches the CLOB prices-history. For each trade:
 *   - looks up the real market midpoint at the exact timestamp we opened
 *   - looks up the real market midpoint at the exact timestamp we closed
 *   - computes entry_delta = ourEntry - realMid  (should be small; if >1¢
 *     our simulator is entering at unrealistic prices)
 *   - computes exit_delta  = ourExit - realMid   (should be near 0 for
 *     maxhold-taker exits, 1.0 for settle-win, 0.0 for settle-lose)
 *
 * Flags anything that looks fake / too-good-to-be-true.
 *
 * Usage:
 *   node scripts/validate-paper-trading.mjs
 *   node scripts/validate-paper-trading.mjs --since=2026-04-22T00:00:00Z
 *   node scripts/validate-paper-trading.mjs --concurrency=4
 *
 * Output:
 *   data/validation.csv                    — per-trade forensic row
 *   stdout                                  — summary + red flags
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const LOG_FILE = path.resolve("data/detect-log.jsonl");
const OUT_CSV = path.resolve("data/validation.csv");
const OUT_SUMMARY = path.resolve("data/validation-summary.txt");
const CONCURRENCY = Number(argv.concurrency ?? "6");
const SINCE_TS = argv.since ? Math.floor(new Date(argv.since).getTime() / 1000) : 0;
const ENTRY_TOLERANCE = Number(argv.entrytol ?? "0.02");  // 2¢ before flagging
const EXIT_TOLERANCE  = Number(argv.exittol  ?? "0.03");  // 3¢ before flagging

async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { __error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) { return { __error: String(e?.message || e) }; }
}

async function runParallel(items, worker, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  async function loop() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await worker(items[i], i); }
      catch (e) { out[i] = { error: e?.message || String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, loop));
  return out;
}

async function fetchTokens(conditionId) {
  const data = await fetchJson(`${GAMMA}/markets?conditionIds=${conditionId}`);
  if (data?.__error) return { error: data.__error };
  const mk = Array.isArray(data) ? data[0] : data;
  if (!mk) return { error: "no-market" };
  const tokens = typeof mk.clobTokenIds === "string" ? JSON.parse(mk.clobTokenIds) : mk.clobTokenIds;
  return { tokens, title: mk.question || mk.title, endDate: mk.endDate };
}

async function fetchPriceHistory(tokenId, startTs, endTs) {
  // Polymarket CLOB prices-history endpoint: ?market=TOKEN_ID&startTs=...&endTs=...&fidelity=60
  const url = `${CLOB}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=60`;
  const data = await fetchJson(url);
  if (data?.__error) return { error: data.__error };
  const hist = data?.history || [];
  return {
    ticks: hist.map(p => ({ ts: Number(p.t), price: Number(p.p) })).filter(x => Number.isFinite(x.ts) && Number.isFinite(x.price)),
  };
}

function findPriceAt(ticks, ts) {
  if (!ticks || !ticks.length) return null;
  // Ticks are usually 60s-spaced. Find the one nearest to ts (within a 5min window).
  let best = null;
  let bestDelta = Infinity;
  for (const p of ticks) {
    const d = Math.abs(p.ts - ts);
    if (d < bestDelta && d <= 600) { best = p; bestDelta = d; }
    if (p.ts > ts + 600) break;
  }
  return best;
}

function fmtSigned(n, digits=4) {
  if (!Number.isFinite(n)) return "";
  return (n >= 0 ? "+" : "") + n.toFixed(digits);
}

async function main() {
  if (!existsSync(LOG_FILE)) {
    console.error(`No log file found at ${LOG_FILE}.`);
    console.error(`Start detect.mjs first so it can generate trade events.`);
    process.exit(1);
  }

  console.log(`Reading ${LOG_FILE}…`);
  const text = await fs.readFile(LOG_FILE, "utf8");
  const events = text.trim().split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter(e => !SINCE_TS || (e.openedTs || 0) >= SINCE_TS);
  const opens = events.filter(e => e.type === "OPEN");
  const closes = events.filter(e => e.type === "CLOSE");
  const closeByKey = new Map();
  for (const c of closes) closeByKey.set(`${c.conditionId}|${c.openedTs}`, c);

  console.log(`Found ${opens.length} OPEN events · ${closes.length} CLOSE events`);
  if (!opens.length) {
    console.log(`No OPEN events to validate. Run detect.mjs first.`);
    process.exit(0);
  }

  // Determine unique markets + time window per market
  const marketMeta = new Map();
  for (const o of opens) {
    const m = marketMeta.get(o.conditionId) || { minTs: Infinity, maxTs: 0, title: o.title };
    m.minTs = Math.min(m.minTs, o.openedTs);
    m.maxTs = Math.max(m.maxTs, o.openedTs);
    marketMeta.set(o.conditionId, m);
  }
  for (const c of closes) {
    const m = marketMeta.get(c.conditionId);
    if (!m) continue;
    const closeTs = new Date(c.closedAt).getTime() / 1000;
    m.maxTs = Math.max(m.maxTs, closeTs);
  }
  const conditionIds = [...marketMeta.keys()];
  console.log(`Across ${conditionIds.length} unique markets.`);
  console.log(`Fetching tokens + price history (concurrency=${CONCURRENCY})…`);

  // Fetch tokens + price history for each market
  const marketData = new Map();
  let fetched = 0;
  let gammaFailed = 0, clobFailed = 0;
  await runParallel(conditionIds, async (cid) => {
    const meta = marketMeta.get(cid);
    const tk = await fetchTokens(cid);
    if (tk.error) { gammaFailed++; marketData.set(cid, { error: `gamma: ${tk.error}` }); return; }
    const startTs = Math.max(0, meta.minTs - 1800);
    const endTs = meta.maxTs + 1800;
    const [yesRes, noRes] = await Promise.all([
      fetchPriceHistory(tk.tokens[0], startTs, endTs),
      fetchPriceHistory(tk.tokens[1], startTs, endTs),
    ]);
    if (yesRes.error && noRes.error) clobFailed++;
    marketData.set(cid, {
      tokens: tk.tokens,
      title: tk.title,
      endDate: tk.endDate,
      yesTicks: yesRes.ticks || [],
      noTicks: noRes.ticks || [],
    });
    fetched++;
    if (fetched % 10 === 0 || fetched === conditionIds.length) {
      console.log(`  … ${fetched}/${conditionIds.length} markets fetched`);
    }
  }, CONCURRENCY);

  // Per-trade validation
  const results = [];
  for (const o of opens) {
    const md = marketData.get(o.conditionId);
    if (!md || md.error) {
      results.push({
        ...o, _skip: true, _reason: md?.error || "no-data",
      });
      continue;
    }
    const c = closeByKey.get(`${o.conditionId}|${o.openedTs}`);
    const ticks = o.side === "NO" ? md.noTicks : md.yesTicks;
    const entryTick = findPriceAt(ticks, o.openedTs);
    const closeTs = c ? Math.floor(new Date(c.closedAt).getTime() / 1000) : null;
    const exitTick = closeTs ? findPriceAt(ticks, closeTs) : null;

    const entryDelta = entryTick ? o.entryPrice - entryTick.price : null;
    const exitDelta = exitTick && c ? c.exitPrice - exitTick.price : null;

    // Sanity-check settlement exits: if status says settle-win, market at close
    // should be ≥0.95. If settle-lose, should be ≤0.05. Otherwise we might be
    // "settling" a market that's actually still trading.
    let settleFlag = "";
    if (c?.status?.startsWith("settle-win") && exitTick && exitTick.price < 0.8) {
      settleFlag = `settled-win but market at ${exitTick.price.toFixed(3)}`;
    } else if (c?.status?.startsWith("settle-lose") && exitTick && exitTick.price > 0.2) {
      settleFlag = `settled-lose but market at ${exitTick.price.toFixed(3)}`;
    }

    results.push({
      openedAt: o.openedAt,
      closedAt: c?.closedAt || "",
      side: o.side,
      city: o.city,
      date: o.date,
      title: o.title,
      reason: o.reason,
      cushion: o.cushion,
      ourEntry: o.entryPrice,
      marketEntry: entryTick?.price ?? null,
      entryDelta,
      ourExit: c?.exitPrice ?? null,
      marketExit: exitTick?.price ?? null,
      exitDelta,
      shares: o.shares,
      ourPnl: c?.pnl ?? null,
      status: c?.status || "open",
      settleFlag,
    });
  }

  // CSV output
  const cols = ["openedAt","closedAt","side","city","date","reason","cushion",
    "ourEntry","marketEntry","entryDelta","ourExit","marketExit","exitDelta",
    "shares","ourPnl","status","settleFlag","title"];
  const rows = [cols.join(",")];
  for (const r of results) {
    rows.push(cols.map(k => {
      const v = r[k];
      if (v == null) return "";
      if (typeof v === "number") return Number.isInteger(v) ? v : v.toFixed(4);
      const s = String(v).replace(/"/g, '""');
      return /,|"/.test(s) ? `"${s}"` : s;
    }).join(","));
  }
  await fs.writeFile(OUT_CSV, rows.join("\n") + "\n");

  // Summary
  const skipped = results.filter(r => r._skip).length;
  const valid = results.filter(r => !r._skip);
  const withEntry = valid.filter(r => r.entryDelta != null);
  const withExit = valid.filter(r => r.exitDelta != null);
  const meanEntryAbs = withEntry.length ? withEntry.reduce((s,r)=>s+Math.abs(r.entryDelta),0)/withEntry.length : 0;
  const medianEntryAbs = withEntry.length ? [...withEntry].sort((a,b)=>Math.abs(a.entryDelta)-Math.abs(b.entryDelta))[Math.floor(withEntry.length/2)].entryDelta : 0;
  const meanExitAbs = withExit.length ? withExit.reduce((s,r)=>s+Math.abs(r.exitDelta),0)/withExit.length : 0;
  const flaggedEntries = withEntry.filter(r => Math.abs(r.entryDelta) > ENTRY_TOLERANCE);
  const flaggedExits = withExit.filter(r => Math.abs(r.exitDelta) > EXIT_TOLERANCE && !r.status.startsWith("settle-"));
  const fakeSettle = results.filter(r => r.settleFlag);
  const totalPnl = results.reduce((s,r) => s + (r.ourPnl || 0), 0);

  const byStatus = {};
  for (const r of results) { byStatus[r.status] = (byStatus[r.status]||0)+1; }

  const summary = [];
  summary.push(`=== VALIDATION REPORT ===`);
  summary.push(``);
  summary.push(`Events:      ${opens.length} OPENs / ${closes.length} CLOSEs (${events.length} total)`);
  summary.push(`Markets:     ${conditionIds.length}  (gamma-fail=${gammaFailed}  clob-fail=${clobFailed})`);
  summary.push(`Validated:   ${valid.length} / ${opens.length}   skipped=${skipped}`);
  summary.push(``);
  summary.push(`Status breakdown:`);
  for (const [s, n] of Object.entries(byStatus).sort((a,b)=>b[1]-a[1])) {
    summary.push(`  ${s.padEnd(28)} ${String(n).padStart(5)}`);
  }
  summary.push(``);
  summary.push(`=== ENTRY PRICE ACCURACY ===`);
  summary.push(`  Matched with market ticks: ${withEntry.length} / ${valid.length}`);
  summary.push(`  Mean |our - market|:       ${meanEntryAbs.toFixed(4)} (${(meanEntryAbs*100).toFixed(2)}¢)`);
  summary.push(`  Median  our - market:      ${medianEntryAbs.toFixed(4)} (${(medianEntryAbs*100).toFixed(2)}¢)`);
  summary.push(`  Flagged (>${(ENTRY_TOLERANCE*100).toFixed(0)}¢ off): ${flaggedEntries.length}`);
  summary.push(``);
  summary.push(`=== EXIT PRICE ACCURACY (non-settle exits only) ===`);
  summary.push(`  Matched: ${withExit.length}`);
  summary.push(`  Mean |our - market|: ${meanExitAbs.toFixed(4)} (${(meanExitAbs*100).toFixed(2)}¢)`);
  summary.push(`  Flagged (>${(EXIT_TOLERANCE*100).toFixed(0)}¢ off): ${flaggedExits.length}`);
  summary.push(``);
  summary.push(`=== SETTLEMENT SANITY CHECK ===`);
  summary.push(`  settle-win with market <0.80:  ${fakeSettle.filter(r => r.settleFlag.startsWith("settled-win")).length}`);
  summary.push(`  settle-lose with market >0.20: ${fakeSettle.filter(r => r.settleFlag.startsWith("settled-lose")).length}`);
  summary.push(``);
  summary.push(`=== P&L SANITY ===`);
  summary.push(`  Sum of simulated PnL: $${totalPnl.toFixed(2)}`);
  summary.push(``);
  if (flaggedEntries.length) {
    summary.push(`=== TOP 10 ENTRY DEVIATIONS ===`);
    summary.push(`  (our entry vs actual market midpoint at that timestamp)`);
    flaggedEntries.sort((a,b) => Math.abs(b.entryDelta) - Math.abs(a.entryDelta)).slice(0, 10).forEach(r => {
      summary.push(`  ${r.openedAt?.slice(11,19)}  ${r.side.padEnd(3)}  ${r.city.padEnd(15)}  ${r.date}  our=${r.ourEntry.toFixed(4)} mkt=${r.marketEntry.toFixed(4)} Δ=${fmtSigned(r.entryDelta)}`);
    });
    summary.push(``);
  }
  if (fakeSettle.length) {
    summary.push(`=== SUSPICIOUS SETTLEMENTS ===`);
    summary.push(`  (we booked a win/loss but the market's ticks disagree)`);
    fakeSettle.slice(0, 10).forEach(r => {
      summary.push(`  ${r.closedAt?.slice(11,19)}  ${r.side.padEnd(3)}  ${r.city.padEnd(15)}  ${r.date}  status=${r.status}  flag: ${r.settleFlag}`);
    });
    summary.push(``);
  }
  summary.push(`Full CSV:   ${OUT_CSV}`);
  summary.push(`This file:  ${OUT_SUMMARY}`);

  const txt = summary.join("\n");
  await fs.writeFile(OUT_SUMMARY, txt + "\n");
  console.log("\n" + txt);
}

main().catch(e => { console.error(e); process.exit(1); });
