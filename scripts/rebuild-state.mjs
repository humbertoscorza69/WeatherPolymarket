#!/usr/bin/env node
/**
 * Rebuild data/detect-positions.json from data/detect-log.jsonl.
 *
 * The log is append-only, so every OPEN and CLOSE event we've ever written is
 * still there. This script replays them in order:
 *   - Each OPEN adds to the open positions list
 *   - Each CLOSE removes the matching OPEN from the list and adds to trades[]
 * Bankroll is recomputed as: (start bankroll) − sum(open cost basis) + realized
 *
 * Usage:
 *   node scripts/rebuild-state.mjs                  # dry-run, prints summary
 *   node scripts/rebuild-state.mjs --write          # overwrite positions file
 *   node scripts/rebuild-state.mjs --startbankroll=10000 --write
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));
const LOG = path.resolve("data/detect-log.jsonl");
const POSITIONS = path.resolve("data/detect-positions.json");
const START_BANKROLL = Number(argv.startbankroll ?? "10000");
const WRITE = argv.write === "true";

if (!existsSync(LOG)) {
  console.error(`No log file at ${LOG} — nothing to rebuild from.`);
  process.exit(1);
}

const lines = (await fs.readFile(LOG, "utf8")).trim().split("\n").filter(Boolean);
console.log(`Replaying ${lines.length} events from ${LOG}…`);

const openByCid = new Map();  // conditionId -> [positions…]   (could be >1 per market)
const trades = [];
let opens = 0, closes = 0, orphanedCloses = 0;

for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev.type === "OPEN") {
    opens++;
    const { type, ...pos } = ev;
    if (!openByCid.has(pos.conditionId)) openByCid.set(pos.conditionId, []);
    openByCid.get(pos.conditionId).push(pos);
  } else if (ev.type === "CLOSE") {
    closes++;
    const { type, ...closedPos } = ev;
    const queue = openByCid.get(closedPos.conditionId);
    if (queue && queue.length) {
      queue.shift(); // FIFO — remove oldest open for this cid
      if (!queue.length) openByCid.delete(closedPos.conditionId);
    } else {
      orphanedCloses++;
    }
    trades.push(closedPos);
  }
}

const openPositions = [];
for (const arr of openByCid.values()) for (const p of arr) openPositions.push(p);

const exposure = openPositions.reduce((s, p) => s + (Number(p.positionSize) || 0), 0);
const realized = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
const wins = trades.filter(t => (Number(t.pnl) || 0) > 0.01).length;
const losses = trades.filter(t => (Number(t.pnl) || 0) < -0.01).length;
const bankroll = START_BANKROLL - exposure + realized;

console.log("\n=== REBUILT STATE ===");
console.log(`Events replayed:       ${lines.length} (opens=${opens} closes=${closes} orphans=${orphanedCloses})`);
console.log(`Open positions:        ${openPositions.length}`);
console.log(`Closed trades:         ${trades.length}  (wins=${wins} losses=${losses})`);
console.log(`Open exposure:         $${exposure.toFixed(2)}`);
console.log(`Realized PnL:          $${realized.toFixed(2)}`);
console.log(`Start bankroll:        $${START_BANKROLL.toFixed(2)}`);
console.log(`Current bankroll:      $${bankroll.toFixed(2)}`);

const state = {
  positions: openPositions,
  bankroll,
  realizedPnl: realized,
  trades,
};

if (WRITE) {
  // Write atomically via tmp + rename so a Ctrl-C here can't corrupt the file
  const tmp = POSITIONS + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, POSITIONS);
  console.log(`\n✅ Wrote ${POSITIONS} (${openPositions.length} open, ${trades.length} closed)`);
  console.log(`   Now restart detect.mjs and it'll pick up where you left off.`);
} else {
  console.log(`\n(dry run — add --write to overwrite ${POSITIONS})`);
}
