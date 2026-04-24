#!/usr/bin/env node
/**
 * Group closed trades by strategyVersion and report WR + PnL for each.
 * Lets us see if the broader 937-mimicking filters (v27) actually
 * outperform the narrow v22 baseline on real Polymarket settlements.
 *
 * Run AFTER tomorrow's settlements come in:
 *   node scripts/strategy-ab.mjs
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const POSITIONS_FILE = path.resolve("data/detect-positions.json");

function median(arr) {
  if (!arr?.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  if (!existsSync(POSITIONS_FILE)) {
    console.error(`No state file at ${POSITIONS_FILE}.`); process.exit(1);
  }
  const state = JSON.parse(await fs.readFile(POSITIONS_FILE, "utf8"));
  const trades = Array.isArray(state.trades) ? state.trades : [];
  const open = Array.isArray(state.positions) ? state.positions : [];

  console.log(`=== Strategy A/B report · ${new Date().toISOString()} ===`);
  console.log(`Closed trades: ${trades.length}`);
  console.log(`Open positions: ${open.length}`);
  console.log(`Realized PnL:  $${(state.realizedPnl || 0).toFixed(2)}`);
  console.log(`Bankroll:      $${(state.bankroll || 0).toFixed(2)}\n`);

  const byVersion = new Map();
  const tagOf = (t) => t.strategyVersion || "untagged";
  for (const t of trades) {
    const k = tagOf(t);
    if (!byVersion.has(k)) byVersion.set(k, { closed: [], open: [] });
    byVersion.get(k).closed.push(t);
  }
  for (const p of open) {
    const k = tagOf(p);
    if (!byVersion.has(k)) byVersion.set(k, { closed: [], open: [] });
    byVersion.get(k).open.push(p);
  }

  console.log(`${"Strategy".padEnd(18)}  ${"Closed".padStart(7)}  ${"Wins".padStart(5)}  ${"WR".padStart(7)}  ${"Realized PnL".padStart(13)}  ${"Avg PnL".padStart(9)}  ${"Median entry".padStart(13)}  ${"Open".padStart(5)}`);
  console.log("─".repeat(95));
  for (const [k, g] of [...byVersion.entries()].sort()) {
    const wins = g.closed.filter(t => Number(t.pnl) > 0.01).length;
    const wr = g.closed.length ? wins / g.closed.length : 0;
    const pnl = g.closed.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    const avgPnl = g.closed.length ? pnl / g.closed.length : 0;
    const medEntry = median(g.closed.map(t => Number(t.entryPrice) || 0));
    console.log(`${k.padEnd(18)}  ${String(g.closed.length).padStart(7)}  ${String(wins).padStart(5)}  ${(wr*100).toFixed(1).padStart(6)}%  ${("$"+pnl.toFixed(2)).padStart(13)}  ${("$"+avgPnl.toFixed(3)).padStart(9)}  ${medEntry.toFixed(4).padStart(13)}  ${String(g.open.length).padStart(5)}`);
  }
  console.log();

  // Per-status breakdown for each version
  console.log(`=== Status breakdown by version ===`);
  for (const [k, g] of [...byVersion.entries()].sort()) {
    const status = {};
    for (const t of g.closed) status[t.status || "?"] = (status[t.status || "?"] || 0) + 1;
    console.log(`  ${k}:`);
    for (const [s, n] of Object.entries(status).sort((a,b) => b[1]-a[1])) {
      console.log(`    ${s.padEnd(28)} ${String(n).padStart(5)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
