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

function median(arr) {
  if (!arr?.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

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
  const url = `${DATA_API}/positions?user=${wallet}&limit=500`;
  const data = await fetchJson(url);
  if (data?.__error) return { error: data.__error, positions: [] };
  const arr = Array.isArray(data) ? data : [];
  return { positions: arr };
}

// Recent activity (trades, redeems) — shows what they ENTERED and CLOSED
// in the last N hours, even if they hold no positions right now.
async function fetchWalletActivity(wallet, hoursBack = 36) {
  const sinceMs = Date.now() - hoursBack * 3600_000;
  const all = [];
  let offset = 0;
  while (offset < 2000) {
    const url = `${DATA_API}/activity?user=${wallet}&limit=500&offset=${offset}`;
    const data = await fetchJson(url);
    if (data?.__error || !Array.isArray(data) || !data.length) break;
    for (const a of data) {
      const ts = Number(a.timestamp ?? a.timeStamp ?? 0) * 1000;
      if (ts < sinceMs) return all;
      all.push({
        ...a,
        ts,
        conditionId: String(a.conditionId || a.condition_id || "").toLowerCase(),
      });
    }
    if (data.length < 500) break;
    offset += 500;
  }
  return all;
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

  const [walletRes, activity, weatherMap] = await Promise.all([
    fetchWalletPositions(WALLET),
    fetchWalletActivity(WALLET, 36),
    fetchWeatherMarketMap(),
  ]);
  if (walletRes.error) {
    console.log(`❌ Wallet fetch failed: ${walletRes.error}`);
    if (!WATCH) process.exit(1);
    return;
  }

  // Filter activity to weather markets only, last 36h
  const weatherActivity = activity
    .filter(a => weatherMap.has(a.conditionId))
    .map(a => ({
      ts: a.ts,
      conditionId: a.conditionId,
      type: String(a.type || a.eventType || "").toUpperCase(),  // TRADE | REDEEM
      side: String(a.side || "").toUpperCase(),                  // BUY | SELL
      outcome: String(a.outcome || "").toUpperCase(),            // YES | NO
      price: Number(a.price || 0),
      size: Number(a.size || 0),
      usdcSize: Number(a.usdcSize || 0),
      title: weatherMap.get(a.conditionId) || "?",
    }));

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
  console.log(`937's open weather positions now:  ${guide.length}`);
  console.log(`937's weather activity (36h):      ${weatherActivity.length}`);
  console.log(`Our open weather positions:        ${ours.length}`);

  if (weatherActivity.length) {
    // Bucket activity by hour to reveal 937's timing pattern
    const hourBuckets = new Map();
    for (const a of weatherActivity) {
      const hourKey = new Date(a.ts).toISOString().slice(0, 13); // "2026-04-23T14"
      hourBuckets.set(hourKey, (hourBuckets.get(hourKey) || 0) + 1);
    }
    const sorted = [...hourBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    console.log(`\n=== 937's weather activity timing (last 36h, UTC) ===`);
    for (const [hour, n] of sorted) {
      console.log(`  ${hour}:00Z  ${"█".repeat(Math.min(n, 50))}  ${n} event${n===1?"":"s"}`);
    }

    // Show 937's recent trades grouped by side + type
    const buys = weatherActivity.filter(a => a.type === "TRADE" && a.side === "BUY");
    const sells = weatherActivity.filter(a => a.type === "TRADE" && a.side === "SELL");
    const redeems = weatherActivity.filter(a => a.type === "REDEEM");
    console.log(`\n  BUYs:    ${buys.length}   (median price ${median(buys.map(b => b.price)).toFixed(3)})`);
    console.log(`  SELLs:   ${sells.length}   (median price ${median(sells.map(s => s.price)).toFixed(3)})`);
    console.log(`  REDEEMs: ${redeems.length}  (collected $1 payouts)`);

    if (buys.length) {
      console.log(`\n  Last 10 BUY entries by 937 (time · side · city · threshold · price · size):`);
      for (const b of buys.slice(0, 10)) {
        const t = new Date(b.ts).toISOString().slice(11, 19);
        const p = parseTitle(b.title);
        console.log(`    ${t}  ${b.outcome.padEnd(4)} ${p.type} ${p.city.padEnd(12)} ${p.threshold}°  @${b.price.toFixed(4)}  size ${b.size.toFixed(1)}`);
      }
    }
  }

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
