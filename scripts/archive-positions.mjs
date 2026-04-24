#!/usr/bin/env node
/**
 * One-shot: move current detect state aside as a timestamped archive,
 * leaving the project ready for a clean detect.mjs restart.
 *
 * After running:
 *   - data/detect-positions.json         → moved to data/detect-positions.<TS>.archive.json
 *   - data/detect-log.jsonl              → moved to data/detect-log.<TS>.archive.jsonl
 *   - Next `npm run detect` starts at $10k, 0 positions, fresh log
 *   - Next `npm run dashboard` shows only the new strategy's data
 *   - The archived positions are still trackable via `npm run settle-archive`
 *
 * Usage:
 *   node scripts/archive-positions.mjs              # use timestamp
 *   node scripts/archive-positions.mjs --tag=v22    # use custom tag
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));

const TAG = argv.tag ?? new Date().toISOString().replace(/[:.]/g, "-");
const POSITIONS = path.resolve("data/detect-positions.json");
const LOG = path.resolve("data/detect-log.jsonl");

async function main() {
  const archivedPositions = POSITIONS.replace(/\.json$/, `.${TAG}.archive.json`);
  const archivedLog = LOG.replace(/\.jsonl$/, `.${TAG}.archive.jsonl`);

  let did = 0;
  if (existsSync(POSITIONS)) {
    const st = JSON.parse(await fs.readFile(POSITIONS, "utf8"));
    const summary = {
      open: (st.positions || []).length,
      closed: (st.trades || []).length,
      bankroll: st.bankroll,
      realizedPnl: st.realizedPnl,
    };
    await fs.rename(POSITIONS, archivedPositions);
    console.log(`✓ ${POSITIONS}`);
    console.log(`  → ${archivedPositions}`);
    console.log(`     ${summary.open} open · ${summary.closed} closed · bankroll $${summary.bankroll?.toFixed(2)} · realized $${summary.realizedPnl?.toFixed(2)}`);
    did++;
  } else {
    console.log(`(no ${POSITIONS} to archive)`);
  }

  if (existsSync(LOG)) {
    const txt = await fs.readFile(LOG, "utf8");
    const lines = txt.trim().split("\n").filter(Boolean).length;
    await fs.rename(LOG, archivedLog);
    console.log(`✓ ${LOG}`);
    console.log(`  → ${archivedLog}`);
    console.log(`     ${lines} log lines`);
    did++;
  } else {
    console.log(`(no ${LOG} to archive)`);
  }

  if (!did) {
    console.log("Nothing to archive.");
    return;
  }

  console.log(`\nDone. Tag: \"${TAG}\"`);
  console.log(`Next steps:`);
  console.log(`  1. Restart detect:  npm run detect`);
  console.log(`     (will start at $10k, 0 positions — your new strategy's clean ledger)`);
  console.log(`  2. Restart dashboard: npm run dashboard`);
  console.log(`  3. Tomorrow after resolutions: npm run settle-archive -- --tag=${TAG}`);
  console.log(`     (reports PnL outcome of the archived ${TAG} positions WITHOUT touching live state)`);
}

main().catch(e => { console.error(e); process.exit(1); });
