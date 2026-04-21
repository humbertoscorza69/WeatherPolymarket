#!/usr/bin/env node
/**
 * Targeted 1-minute price-history fetcher for markets traded by a wallet.
 *
 * Input:  data/wallet-trades/<addr>.jsonl
 * Output: data/resolved-market-cache/<conditionId>-<side>.json
 *         (same schema as fetch-resolved-markets.mjs; samples at fidelity=1)
 *
 * Difference from fetch-resolved-markets.mjs:
 *   - Starts from the wallet's trade list, not Gamma discovery.
 *     So we don't miss markets that resolved outside our Gamma lookback.
 *   - Uses the public CLOB /prices-history endpoint (no auth required).
 *   - Window per market is bounded by the wallet's earliest-open and
 *     latest-close timestamps (padded ±1h) — minimizes API calls.
 *   - fidelity=1 minute (sub-minute fill detection for scalp backtests).
 *
 * Usage:
 *   npm run fetch-wallet-market-history
 *   node scripts/fetch-wallet-market-history.mjs -- \
 *     --wallet=0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab --fidelity=1
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const WALLET  = args.wallet  ?? "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab";
const FIDELITY = Number(args.fidelity ?? "1");
const PAD_HOURS = Number(args["pad-hours"] ?? "2");
const REFRESH = args.refresh === "true";
const HOST = "https://clob.polymarket.com";
const CHUNK_SEC = FIDELITY < 5 ? 24 * 3600 : 7 * 24 * 3600;

const TRADE_FILE = path.resolve(`data/wallet-trades/${WALLET}.jsonl`);
const CACHE_DIR = path.resolve("data/resolved-market-cache");
await fs.mkdir(CACHE_DIR, { recursive: true });

async function fetchChunk(tokenId, startTs, endTs) {
  const url = `${HOST}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=${FIDELITY}`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const h = Array.isArray(j) ? j : j?.history ?? j?.data ?? [];
    return {
      samples: h
        .map((x) => ({ t: Number(x.t), p: Number(x.p) }))
        .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p) && x.p > 0 && x.p < 1)
    };
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
}

async function fetchFullWindow(tokenId, startTs, endTs) {
  const all = [];
  let cursor = startTs;
  let lastError = null;
  while (cursor < endTs) {
    const chunkEnd = Math.min(cursor + CHUNK_SEC, endTs);
    const { samples, error } = await fetchChunk(tokenId, cursor, chunkEnd);
    if (error) {
      lastError = error;
    } else if (samples?.length) {
      all.push(...samples);
    }
    cursor = chunkEnd;
    await new Promise((r) => setTimeout(r, 50));
  }
  const seen = new Set();
  const deduped = all.sort((a, b) => a.t - b.t).filter((s) => (seen.has(s.t) ? false : (seen.add(s.t), true)));
  return { samples: deduped, error: lastError && !deduped.length ? lastError : null };
}

function cachePath(conditionId, side) {
  return path.join(CACHE_DIR, `${conditionId}-${side}.json`);
}

async function alreadyFresh(p) {
  if (REFRESH) return false;
  if (!existsSync(p)) return false;
  try {
    const j = JSON.parse(await fs.readFile(p, "utf8"));
    return j.fidelity === FIDELITY && Array.isArray(j.samples) && j.samples.length >= 20;
  } catch { return false; }
}

async function main() {
  if (!existsSync(TRADE_FILE)) {
    console.error(`Missing ${TRADE_FILE}`);
    process.exit(1);
  }
  const trades = (await fs.readFile(TRADE_FILE, "utf8"))
    .trim().split("\n").filter(Boolean).map(JSON.parse);
  console.log(`Loaded ${trades.length} trades for ${WALLET}`);

  // Group by (conditionId, side): track tokenId + earliest/latest timestamps
  const markets = new Map();
  for (const t of trades) {
    const key = `${t.conditionId}-${t.side}`;
    if (!markets.has(key)) {
      markets.set(key, {
        conditionId: t.conditionId,
        side: t.side,
        tokenId: t.asset,
        title: t.title,
        minTs: t.openTs,
        maxTs: t.closeTs ?? t.openTs
      });
    } else {
      const m = markets.get(key);
      if (t.openTs < m.minTs) m.minTs = t.openTs;
      if ((t.closeTs ?? t.openTs) > m.maxTs) m.maxTs = t.closeTs ?? t.openTs;
    }
  }
  console.log(`Unique (conditionId, side): ${markets.size}`);
  console.log(`Fidelity: ${FIDELITY}min  pad: ±${PAD_HOURS}h  refresh: ${REFRESH}\n`);

  const padSec = PAD_HOURS * 3600;
  let fetched = 0, skipped = 0, failed = 0, zero = 0;
  const marketList = [...markets.values()];
  for (let i = 0; i < marketList.length; i++) {
    const m = marketList[i];
    const tag = `[${i + 1}/${marketList.length}]`;
    const p = cachePath(m.conditionId, m.side);
    if (await alreadyFresh(p)) {
      skipped++;
      if ((i + 1) % 20 === 0) process.stdout.write(`  ${tag} ${skipped} cached at fidelity=${FIDELITY} \r`);
      continue;
    }
    const startTs = m.minTs - padSec;
    const endTs   = m.maxTs + padSec;
    process.stdout.write(`  ${tag} ${m.conditionId.slice(0, 12)} ${m.side} "${(m.title || "").slice(0, 50)}" `);
    const { samples, error } = await fetchFullWindow(m.tokenId, startTs, endTs);
    if (!samples.length) {
      console.log(`no samples${error ? ` (${error.slice(0, 50)})` : ""}`);
      if (error) failed++; else zero++;
      continue;
    }
    // Merge with existing cache if present (preserve old samples outside our window)
    let existing = {};
    if (existsSync(p)) {
      try { existing = JSON.parse(await fs.readFile(p, "utf8")); } catch { /* ignore */ }
    }
    const mergedSamples = [...(existing.samples ?? []), ...samples]
      .sort((a, b) => a.t - b.t);
    const seen = new Set();
    const dedupe = mergedSamples.filter((s) => seen.has(s.t) ? false : (seen.add(s.t), true));

    const payload = {
      id: existing.id ?? `${m.conditionId}-${m.side}`,
      conditionId: m.conditionId,
      tokenId: m.tokenId,
      side: m.side,
      tokenResolutionValue: existing.tokenResolutionValue ?? null,
      resolutionTs: existing.resolutionTs ?? null,
      tickSize: existing.tickSize ?? 0.001,
      title: m.title ?? existing.title ?? null,
      category: existing.category ?? "weather",
      volumeUsdc: existing.volumeUsdc ?? null,
      samples: dedupe,
      fetchedAt: Date.now(),
      fidelity: FIDELITY,
      windowSpanHours: ((endTs - startTs) / 3600).toFixed(1)
    };
    await fs.writeFile(p, JSON.stringify(payload));
    console.log(`${samples.length} samples (merged=${dedupe.length})`);
    fetched++;
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`\n  Done. Fetched ${fetched}, skipped ${skipped}, failed ${failed}, zero-samples ${zero}.`);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
