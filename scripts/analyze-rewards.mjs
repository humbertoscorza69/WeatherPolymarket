#!/usr/bin/env node
/**
 * List every Polymarket market in the Liquidity Rewards Program with:
 *   - daily reward pool ($)
 *   - max spread to qualify (cents from mid)
 *   - minimum order size
 *   - estimated per-$ daily reward at 1¢ from mid (our quoting target)
 *
 * The core question for us: are there enough rewards-program markets with
 * high enough `rate_per_day` that our $100 capital can earn meaningful LP
 * rewards at 10% competitive share?
 *
 * Usage:
 *   npm run analyze-rewards
 *   npm run analyze-rewards -- --competitive-share=0.05     # more pessimistic
 *   npm run analyze-rewards -- --min-rate=0.5               # hide markets below $0.50/day
 */

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { parseRewardsList, estimatedDailyReward, isFeasible } from "../dist/src/adapters/rewardsApi.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);
const competitiveShare = Number(args["competitive-share"] ?? "0.1");
const minRate = Number(args["min-rate"] ?? "0");
const topN = Number(args.top ?? "50");

const host = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
if (!privateKey) {
  console.error("POLYMARKET_PRIVATE_KEY is required in .env");
  process.exit(1);
}
const signer = new Wallet(privateKey);
const client = new ClobClient(
  host,
  137,
  signer,
  {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE
  },
  Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "1"),
  process.env.POLYMARKET_FUNDER_ADDRESS
);

async function main() {
  console.log(`\nFetching Polymarket rewards-program markets...`);
  const raw = await client.getCurrentRewards();
  const all = parseRewardsList(raw);
  const filtered = all.filter((m) => m.ratePerDay >= minRate);
  filtered.sort((a, b) => b.ratePerDay - a.ratePerDay);

  console.log(`  ${raw.length} markets in program, ${all.length} with active configs today, ${filtered.length} above $${minRate}/day.\n`);

  // Show capital-scale feasibility for several order sizes so the floor is obvious.
  const orderSizes = [2, 10, 50, 200, 500];
  console.log(`Feasibility by order size (shares = order_size / assumed_price 0.5):\n`);
  console.log(
    "order_size".padStart(12),
    "max_shares".padStart(12),
    "feasible_markets".padStart(18),
    "est_daily_LP".padStart(14),
    "est_weekly_LP".padStart(14)
  );
  console.log("-".repeat(85));
  for (const os of orderSizes) {
    const feasible = filtered.filter((m) => isFeasible(m, os));
    const estDaily = feasible.reduce(
      (s, m) => s + estimatedDailyReward(m, os, 1, competitiveShare),
      0
    );
    console.log(
      `$${os}`.padStart(12),
      (os / 0.5).toFixed(0).padStart(12),
      String(feasible.length).padStart(18),
      `$${estDaily.toFixed(3)}`.padStart(14),
      `$${(estDaily * 7).toFixed(2)}`.padStart(14)
    );
  }

  const currentOrderSize = 2;
  const feasibleForUs = filtered.filter((m) => isFeasible(m, currentOrderSize));
  console.log(
    `\nAt our current $${currentOrderSize} order size: ${feasibleForUs.length} of ${filtered.length} rewards-program markets qualify.`
  );

  console.log(`\nTop markets ranked by pool size (✓ = we qualify at $${currentOrderSize} order, ✗ = we don't):\n`);
  console.log(
    "rank".padEnd(5),
    "feas".padStart(5),
    "market".padEnd(50),
    "pool/day".padStart(10),
    "max¢".padStart(6),
    "min_sh".padStart(7),
    "est $/day".padStart(11)
  );
  console.log("-".repeat(100));

  for (let i = 0; i < Math.min(topN, filtered.length); i++) {
    const m = filtered[i];
    const feas = isFeasible(m, currentOrderSize) ? "✓" : "✗";
    const estDaily = estimatedDailyReward(m, currentOrderSize, 1, competitiveShare);
    const label = (m.eventSlug || m.question || m.conditionId).slice(0, 48);
    console.log(
      String(i + 1).padEnd(5),
      feas.padStart(5),
      label.padEnd(50),
      `$${m.ratePerDay.toFixed(2)}`.padStart(10),
      m.maxSpreadCents.toFixed(0).padStart(6),
      m.minSize.toFixed(0).padStart(7),
      `$${estDaily.toFixed(4)}`.padStart(11)
    );
  }

  const top10Feasible = feasibleForUs.slice(0, 10);
  if (top10Feasible.length > 0) {
    console.log(`\nTop 10 markets WE QUALIFY for at $${currentOrderSize} order size:\n`);
    for (const m of top10Feasible) {
      const estDaily = estimatedDailyReward(m, currentOrderSize, 1, competitiveShare);
      console.log(
        `  ${m.conditionId.slice(0, 20)}...  pool=$${m.ratePerDay.toFixed(2)}/day  min_sz=${m.minSize}  est=$${estDaily.toFixed(4)}/day`
      );
    }
  } else {
    console.log(
      `\nWe qualify for ZERO rewards-program markets at $${currentOrderSize} order size.`
    );
    console.log(`To earn LP rewards on Polymarket:`);
    console.log(`  - Increase order size to ~$50 → qualifies for markets with min_size ≤ 100 at prices ≥ 0.50`);
    console.log(`  - Or increase to ~$200 → qualifies for most 250-share markets`);
    console.log(`  - Or increase to ~$500 → qualifies for top-pool 1000-share markets`);
    console.log(
      `  The $100 bankroll can only support ${Math.floor(100 / 50)}-${Math.floor(100 / 30)} concurrent $30-$50 orders.`
    );
  }

  console.log(`\nNote: "competitive share" is ${(competitiveShare * 100).toFixed(0)}% — real number depends on how many other makers compete.`);
  console.log(`Calibrate live with client.getUserEarningsAndMarketsConfig(date) after a few active days.\n`);
}

main().catch((err) => {
  console.error("analyze-rewards failed:", err);
  process.exit(1);
});
