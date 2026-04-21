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
import { parseRewardsList, estimatedDailyReward } from "../dist/src/adapters/rewardsApi.js";

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

  const ORDER_SIZE = 2; // $2 — the sweep default
  console.log(
    "rank".padEnd(5),
    "market".padEnd(55),
    "pool/day".padStart(10),
    "max¢".padStart(6),
    "min_sh".padStart(7),
    "est $/day @1¢".padStart(14),
    "breakeven $".padStart(13)
  );
  console.log("-".repeat(115));

  let totalRewardIfQuoteAllMarkets = 0;
  for (let i = 0; i < Math.min(topN, filtered.length); i++) {
    const m = filtered[i];
    const estDaily = estimatedDailyReward(m, ORDER_SIZE, 1, competitiveShare);
    totalRewardIfQuoteAllMarkets += estDaily;
    const breakeven = estDaily > 0 ? (ORDER_SIZE / estDaily).toFixed(1) + "d" : "—";
    const label = (m.eventSlug || m.question || m.conditionId).slice(0, 53);
    console.log(
      String(i + 1).padEnd(5),
      label.padEnd(55),
      `$${m.ratePerDay.toFixed(2)}`.padStart(10),
      m.maxSpreadCents.toFixed(0).padStart(6),
      m.minSize.toFixed(0).padStart(7),
      `$${estDaily.toFixed(4)}`.padStart(14),
      breakeven.padStart(13)
    );
  }

  // Capital deployment scenario
  console.log(`\nScenario: $${ORDER_SIZE} resting at 1¢ from mid, competitive share = ${(competitiveShare * 100).toFixed(0)}%`);
  console.log(`  If we quote the TOP ${Math.min(topN, filtered.length)} markets simultaneously:`);
  console.log(`    Capital deployed:       $${(ORDER_SIZE * Math.min(topN, filtered.length)).toFixed(2)}`);
  console.log(`    Expected daily LP:      $${totalRewardIfQuoteAllMarkets.toFixed(3)}`);
  console.log(`    Expected weekly LP:     $${(totalRewardIfQuoteAllMarkets * 7).toFixed(2)}`);
  console.log(`    Annualized rate:        ${((totalRewardIfQuoteAllMarkets * 365) / (ORDER_SIZE * Math.min(topN, filtered.length)) * 100).toFixed(1)}%/year`);

  const top20Total = filtered.slice(0, 20).reduce((s, m) => s + estimatedDailyReward(m, ORDER_SIZE, 1, competitiveShare), 0);
  console.log(`\n  If we filter to TOP 20 by pool size:`);
  console.log(`    Capital deployed:       $${(ORDER_SIZE * 20).toFixed(2)}`);
  console.log(`    Expected daily LP:      $${top20Total.toFixed(3)}`);
  console.log(`    Expected weekly LP:     $${(top20Total * 7).toFixed(2)}`);
  console.log(`    Annualized rate:        ${((top20Total * 365) / (ORDER_SIZE * 20) * 100).toFixed(1)}%/year`);

  console.log(
    `\nNote: "competitive share" is a pessimistic scalar (${(competitiveShare * 100).toFixed(0)}%) — the real number depends on how many other makers are quoting each market.`
  );
  console.log(
    `Calibrate live with \`client.getUserEarningsAndMarketsConfig(date)\` once we've been active for a few days.\n`
  );
}

main().catch((err) => {
  console.error("analyze-rewards failed:", err);
  process.exit(1);
});
