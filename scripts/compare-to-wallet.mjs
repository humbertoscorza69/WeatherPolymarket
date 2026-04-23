#!/usr/bin/env node
/**
 * Live comparison: our open positions vs 0x937bcac3...bfab (the guide wallet).
 *
 * The ultimate validation — if our detection engine is truly running 937's
 * strategy, we should be entering the same markets on the same sides. Not
 * necessarily at the same price (they're a real-money maker, we simulate
 * taker at mid) or exact timing, but the SET of markets should overlap.
 *
 * Fetches 937's live positions from Polymarket data-api, loads our
 * detect-positions.json, reports:
 *   - Overlap:      markets both of us hold (good — replicating)
 *   - 937 only:     markets they hold that we didn't catch (signal we missed)
 *   - We only:      markets we hold that they didn't (signal they ignored,
 *                   probably noise we're picking up)
 *
 * Usage:
 *   node scripts/compare-to-wallet.mjs                  # defaults to 0x937
 *   node scripts/compare-to-wallet.mjs --wallet=0xabc   # another wallet
 *   node scripts/compare-to-wallet.mjs --watch          # re-run every 60s
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));

const WALLET = argv.wallet ?? "0x937bcac3ef9d02d0d00da0c5e2b2a6e26f2ebfab";
const POSITIONS_FILE = path.resolve("data/detect-positions.json");
const DATA_API = "https://data-api.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const WATCH = argv.watch === "true";

async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { __error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) { return { __error: String(e?.message || e) }; }
}

async function fetchWalletPositions(wallet) {
  // Polymarket data-api returns current positions for a wallet
  const url = `${DATA_API}/positions?user=${wallet}&limit=500`;
  const data = await fetchJson(url);
  if (data?.__error) return { error: data.__error, positions: [] };
  const arr = Array.isArray(data) ? data : [];
  return { positions: arr };
}

// Build a Map<conditionId, marketTitle> from /events so we can name
// conditionIds we recognize (weather markets especially).
async function fetchWeatherMarketMap() {
  const map = new Map();
  for (const closedFilter of [false, true]) {
    let offset = 0;
    while (offset < 5000) {
      const url = `${GAMMA}/events?closed=${closedFilter}&tag_slug=weather&limit=100&offset=${offset}`;
      const page = await fetchJson(url);
      if (!Array.isArray(page) || !page.length) break;
      for (const ev of page) {
        for (const m of (ev.markets || [])) {
          if (m.conditionId) map.set(String(m.conditionId).toLowerCase(), m.question || m.title || "?");
        }
      }
      if (page.length < 100) break;
      offset += 100;
    }
  }
  return map;
}

function parseTitle(t) {
  if (!t) return { city: "?", type: "?", threshold: "?", date: "?" };
  const lowest = /lowest temperature/i.test(t);
  const cityMatch = t.match(/temperature in ([A-Z][\w .\-']+?) be/i);
  const thrMatch = t.match(/be\s+(?:between\s+)?(\d+)/i);
  const dateMatch = t.match(/on\s+(\d{4}-\d{2}-\d{2}|[A-Z][a-z]+\s+\d+)/);
  return {
    city: cityMatch?.[1]?.trim() || "?",
    type: lowest ? "LOW" : "HIGH",
    threshold: thrMatch?.[1] || "?",
    date: dateMatch?.[1] || "?",
  };
}

async function compare() {
  console.log(`=== Compare ${WALLET} → our bot ===`);
  console.log(`[${new Date().toISOString()}]\n`);

  const [walletRes, weatherMap] = await Promise.all([
    fetchWalletPositions(WALLET),
    fetchWeatherMarketMap(),
  ]);
  if (walletRes.error) {
    console.log(`❌ Wallet fetch failed: ${walletRes.error}`);
    if (!WATCH) process.exit(1);
    return;
  }

  // 937's positions — filter to weather + non-zero size
  const guide = walletRes.positions
    .filter(p => {
      const cid = String(p.conditionId || p.condition_id || "").toLowerCase();
      return weatherMap.has(cid) && Math.abs(Number(p.size || 0)) > 0.01;
    })
    .map(p => ({
      conditionId: String(p.conditionId || p.condition_id).toLowerCase(),
      side: Number(p.outcomeIndex ?? p.outcome_index) === 0 ? "YES" : "NO",
      size: Number(p.size || 0),
      avgPrice: Number(p.avgPrice || p.avg_price || p.entryPrice || 0),
      title: weatherMap.get(String(p.conditionId || p.condition_id).toLowerCase()) || "?",
    }));

  // Our positions
  let ours = [];
  if (existsSync(POSITIONS_FILE)) {
    try {
      const st = JSON.parse(await fs.readFile(POSITIONS_FILE, "utf8"));
      ours = (st.positions || []).map(p => ({
        conditionId: String(p.conditionId).toLowerCase(),
        side: p.side,
        size: Number(p.shares || 0),
        avgPrice: Number(p.entryPrice || 0),
        title: p.title || "?",
      }));
    } catch {}
  }

  // Build keyed sets
  const keyOf = (p) => `${p.conditionId}|${p.side}`;
  const guideBy = new Map(guide.map(p => [keyOf(p), p]));
  const oursBy = new Map(ours.map(p => [keyOf(p), p]));

  const both = [];
  const guideOnly = [];
  const ourOnly = [];

  for (const [k, p] of guideBy) {
    if (oursBy.has(k)) both.push({ guide: p, us: oursBy.get(k) });
    else guideOnly.push(p);
  }
  for (const [k, p] of oursBy) {
    if (!guideBy.has(k)) ourOnly.push(p);
  }

  // Report
  console.log(`937's weather positions: ${guide.length}`);
  console.log(`Our weather positions:   ${ours.length}`);
  console.log(`\n=== Overlap (both holding same market+side) ===  ${both.length} positions`);
  if (both.length) {
    console.log(`  ${"market".padEnd(50)}  ${"937 side".padEnd(8)}  937@price    us@price    Δentry`);
    for (const b of both.slice(0, 30)) {
      const parsed = parseTitle(b.guide.title);
      const label = `${parsed.type} ${parsed.city} ${parsed.threshold}°`.padEnd(50);
      const delta = b.us.avgPrice - b.guide.avgPrice;
      console.log(`  ${label}  ${b.guide.side.padEnd(8)}  ${b.guide.avgPrice.toFixed(4)}    ${b.us.avgPrice.toFixed(4)}    ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`);
    }
    if (both.length > 30) console.log(`  ... and ${both.length - 30} more`);
  }

  console.log(`\n=== 937 holds but we MISSED ===  ${guideOnly.length} positions`);
  if (guideOnly.length) {
    console.log(`  (signals 937 caught that our detector didn't fire on)`);
    for (const p of guideOnly.slice(0, 30)) {
      const parsed = parseTitle(p.title);
      console.log(`  ${(parsed.type + " " + parsed.city + " " + parsed.threshold + "°").padEnd(50)}  ${p.side}  avg=${p.avgPrice.toFixed(4)}  size=${p.size.toFixed(1)}  [${parsed.date}]`);
    }
    if (guideOnly.length > 30) console.log(`  ... and ${guideOnly.length - 30} more`);
  }

  console.log(`\n=== We hold but 937 IGNORED ===  ${ourOnly.length} positions`);
  if (ourOnly.length) {
    console.log(`  (signals our detector fired on but 937 didn't — potential noise)`);
    for (const p of ourOnly.slice(0, 30)) {
      const parsed = parseTitle(p.title);
      console.log(`  ${(parsed.type + " " + parsed.city + " " + parsed.threshold + "°").padEnd(50)}  ${p.side}  entry=${p.avgPrice.toFixed(4)}  size=${p.size.toFixed(1)}`);
    }
    if (ourOnly.length > 30) console.log(`  ... and ${ourOnly.length - 30} more`);
  }

  console.log(`\n=== Verdict ===`);
  const overlapPct = guide.length ? (both.length / guide.length * 100).toFixed(1) : "—";
  const noisePct = ours.length ? (ourOnly.length / ours.length * 100).toFixed(1) : "—";
  console.log(`  Overlap with 937:  ${overlapPct}%  (${both.length}/${guide.length} of their positions we caught)`);
  console.log(`  Noise ratio:       ${noisePct}%  (${ourOnly.length}/${ours.length} of our positions they skipped)`);
  console.log(`  Signal missed:     ${guideOnly.length}  (positions to investigate)`);
  if (both.length && guideOnly.length === 0 && ourOnly.length < ours.length * 0.3) {
    console.log(`\n  ✅ STRONG replication: we match most of 937's book + low noise.`);
  } else if (both.length > guideOnly.length && ourOnly.length < ours.length * 0.5) {
    console.log(`\n  🟡 PARTIAL replication: hitting more than missing, but still tuning needed.`);
  } else if (guideOnly.length > both.length) {
    console.log(`\n  ❌ UNDER-firing: missing more signals than we catch. Loosen entry filters.`);
  } else if (ourOnly.length > ours.length * 0.7) {
    console.log(`\n  ❌ OVER-firing: most of our positions aren't in 937's book. Tighten filters.`);
  }
}

async function main() {
  if (WATCH) {
    while (true) {
      await compare();
      console.log(`\n[waiting 60s — Ctrl-C to stop]`);
      await new Promise(r => setTimeout(r, 60_000));
      console.log("\n");
    }
  } else {
    await compare();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
