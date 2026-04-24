#!/usr/bin/env node
/**
 * Cleans METAR-authority settlements out of paper-trading state.
 *
 * The old resolvePositions() (v17-v21) used METAR observations as the
 * settlement oracle — booking $1/$0 payoffs based on observed max/min even
 * before Polymarket actually resolved. That produced phantom PnL that
 * wouldn't materialize in real trading. v22 removes that logic. This script
 * unwinds the damage in detect-positions.json:
 *
 *   - Backs up detect-positions.json and detect-log.jsonl
 *   - Scans state.trades[] for status containing "metar"
 *   - Moves those trades back to state.positions (re-opens them)
 *   - Subtracts their phantom PnL from state.realizedPnl
 *   - Subtracts their phantom payout from state.bankroll (add back cost basis)
 *   - Rewrites detect-log.jsonl without the CLOSE lines for tainted trades
 *
 * After running, restart detect.mjs. The re-opened positions will be settled
 * the correct way — waiting for Gamma's actual resolution.
 *
 * Usage:
 *   node scripts/reset-metar-taint.mjs --dry-run   # preview
 *   node scripts/reset-metar-taint.mjs             # apply
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));
const DRY = argv.dryRun === "true" || argv["dry-run"] === "true";

const POSITIONS_FILE = path.resolve("data/detect-positions.json");
const LOG_FILE = path.resolve("data/detect-log.jsonl");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

function isMetarTainted(status) {
  return typeof status === "string" && /metar/i.test(status);
}

async function main() {
  if (!existsSync(POSITIONS_FILE)) { console.error(`no ${POSITIONS_FILE}`); process.exit(1); }
  const state = JSON.parse(await fs.readFile(POSITIONS_FILE, "utf8"));
  const trades = Array.isArray(state.trades) ? state.trades : [];
  const positions = Array.isArray(state.positions) ? state.positions : [];

  const tainted = trades.filter(t => isMetarTainted(t.status));
  const clean = trades.filter(t => !isMetarTainted(t.status));

  const taintedPnl = tainted.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const taintedPayout = tainted.reduce((s, t) => s + (Number(t.shares) * Number(t.exitPrice) || 0), 0);
  const taintedCost = tainted.reduce((s, t) => s + (Number(t.positionSize) || 0), 0);

  console.log(`=== METAR-taint cleanup ${DRY ? "(DRY RUN)" : ""} ===`);
  console.log(`Current trades[]:        ${trades.length}`);
  console.log(`  ├─ METAR-settled:      ${tainted.length}   (${(100*tainted.length/Math.max(trades.length,1)).toFixed(1)}% of trades)`);
  console.log(`  └─ Gamma / taker:      ${clean.length}`);
  console.log(``);
  console.log(`Phantom PnL to reverse:    $${taintedPnl.toFixed(2)}`);
  console.log(`Phantom payout to refund:  $${taintedPayout.toFixed(2)}`);
  console.log(`Cost basis to redeploy:    $${taintedCost.toFixed(2)}`);
  console.log(``);

  // Rebuild positions: take the current open set, re-add the tainted ones
  // (stripping closed/exitPrice/pnl/status/closedAt so they look fresh).
  const reopened = tainted.map(t => {
    const { closed, closedAt, exitPrice, pnl, status, ...pos } = t;
    return pos;
  });
  const newPositions = [...positions, ...reopened];

  // Bankroll rebuild: the tainted settle added (shares × exitPrice) to bankroll.
  // We need to subtract that AND add back the cost basis (positionSize), which
  // was originally deducted when the position was opened. Net: bankroll
  // adjustment = -payout (remove) - cost_basis is ALREADY added back by
  // tainted settle if we just reverse the settle net.
  // Concretely, the tainted settle did: bankroll += shares*exitPrice.
  // Re-opening restores the position's cost, which was ALREADY deducted at
  // open time and NOT restored by the settle (the settle added payout).
  // So to revert: bankroll -= payout. That's it.
  const newBankroll = Number(state.bankroll) - taintedPayout;
  const newRealizedPnl = Number(state.realizedPnl) - taintedPnl;

  console.log(`Before: bankroll=$${Number(state.bankroll).toFixed(2)}  realizedPnl=$${Number(state.realizedPnl).toFixed(2)}  open=${positions.length}  closed=${trades.length}`);
  console.log(`After:  bankroll=$${newBankroll.toFixed(2)}  realizedPnl=$${newRealizedPnl.toFixed(2)}  open=${newPositions.length}  closed=${clean.length}`);

  if (DRY) {
    console.log(`\n(dry run — no files modified)`);
    return;
  }

  // Back up first
  const posBackup = POSITIONS_FILE.replace(/\.json$/, `.${STAMP}.bak.json`);
  await fs.copyFile(POSITIONS_FILE, posBackup);
  console.log(`backup: ${posBackup}`);

  if (existsSync(LOG_FILE)) {
    const logBackup = LOG_FILE.replace(/\.jsonl$/, `.${STAMP}.bak.jsonl`);
    await fs.copyFile(LOG_FILE, logBackup);
    console.log(`backup: ${logBackup}`);

    // Filter log — drop CLOSE events for tainted trades
    const taintedKeys = new Set(tainted.map(t => `${t.conditionId}|${t.openedTs}`));
    const text = await fs.readFile(LOG_FILE, "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    const keptLines = lines.filter(l => {
      try {
        const e = JSON.parse(l);
        if (e.type === "CLOSE" && taintedKeys.has(`${e.conditionId}|${e.openedTs}`)) return false;
        return true;
      } catch { return true; }
    });
    await fs.writeFile(LOG_FILE, keptLines.join("\n") + (keptLines.length ? "\n" : ""));
    console.log(`log:    dropped ${lines.length - keptLines.length} CLOSE lines, kept ${keptLines.length}`);
  }

  const newState = {
    ...state,
    positions: newPositions,
    trades: clean,
    bankroll: newBankroll,
    realizedPnl: newRealizedPnl,
  };
  await fs.writeFile(POSITIONS_FILE, JSON.stringify(newState, null, 2));
  console.log(`state:  ${POSITIONS_FILE} updated`);
  console.log(`\nDone. Restart detect.mjs — the ${tainted.length} re-opened positions will now wait for Gamma resolution.`);
}

main().catch(e => { console.error(e); process.exit(1); });
