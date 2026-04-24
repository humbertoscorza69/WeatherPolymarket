#!/usr/bin/env node
/**
 * Catalog every HIGHEST-temperature weather market found in data/tick-history/.
 * For each market: parse (city, date, bucket range in °C) from the title of
 * the first tick, then record first/last tick timestamps and tick count so
 * downstream feature extraction can snapshot at any point in a market's life.
 *
 * Output: data/analysis/universe-markets.jsonl
 *   one JSON object per line, conditionId-keyed
 *
 * Usage:  node scripts/analysis/build-universe.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";

const TICK_DIR = path.resolve("data/tick-history");
const OUT = path.resolve("data/analysis/universe-markets.jsonl");
const REPORT = path.resolve("data/analysis/universe-report.txt");

function parseTitle(title) {
  if (!title) return null;
  if (!/highest temperature/i.test(title)) return null;  // only HIGHEST markets
  const cityM = title.match(/in ([A-Z][A-Za-z .'-]+?) be /);
  if (!cityM) return null;
  const city = cityM[1].trim();

  let bucketLo = null, bucketHi = null, kind = null, unit = null;
  let m;
  if ((m = title.match(/be (\d+(?:\.\d+)?)\s*°?([CF])\s*or below/i))) {
    bucketLo = -Infinity; bucketHi = Number(m[1]); kind = "or_below"; unit = m[2].toUpperCase();
  } else if ((m = title.match(/be (\d+(?:\.\d+)?)\s*°?([CF])\s*or above/i))) {
    bucketLo = Number(m[1]); bucketHi = Infinity; kind = "or_above"; unit = m[2].toUpperCase();
  } else if ((m = title.match(/be (\d+)-(\d+)\s*°?([CF])/i))) {
    bucketLo = Number(m[1]); bucketHi = Number(m[2]); kind = "range"; unit = m[3].toUpperCase();
  } else if ((m = title.match(/be (\d+(?:\.\d+)?)\s*°?([CF])/i))) {
    bucketLo = Number(m[1]); bucketHi = Number(m[1]); kind = "exact"; unit = m[2].toUpperCase();
  } else {
    return null;
  }

  let date = null;
  const iso = title.match(/on\s+(\d{4}-\d{2}-\d{2})/);
  const mon = title.match(/on\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+)(?:,\s*(\d{4}))?/i);
  if (iso) date = iso[1];
  else if (mon) {
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const mi = months.findIndex(x => x.toLowerCase() === mon[1].toLowerCase());
    const y = mon[3] || "2026";
    date = `${y}-${String(mi+1).padStart(2,"0")}-${String(mon[2]).padStart(2,"0")}`;
  }
  if (!date) return null;

  return { city, date, kind, bucketLo, bucketHi, unit };
}

const toC = (v, u) => u === "F" ? (v - 32) * 5/9 : v;

async function main() {
  const t0 = Date.now();
  const files = (await fs.readdir(TICK_DIR)).filter(f => f.endsWith(".jsonl"));
  console.log(`scanning ${files.length} tick files in ${TICK_DIR}`);

  const lines = [];
  let parsed = 0, skippedTitle = 0, skippedEmpty = 0, skippedNoTitle = 0;
  const cityDateGroups = new Map();  // "city|date" -> count

  for (let i = 0; i < files.length; i++) {
    if (i % 2000 === 0) process.stdout.write(`  ${i}/${files.length}\n`);
    const file = path.join(TICK_DIR, files[i]);
    const conditionId = files[i].replace(/\.jsonl$/, "");

    let fh;
    try { fh = await fs.readFile(file, "utf8"); } catch { skippedEmpty++; continue; }
    const tickLines = fh.trim().split("\n");
    if (!tickLines.length || !tickLines[0]) { skippedEmpty++; continue; }

    let firstTick, lastTick;
    try { firstTick = JSON.parse(tickLines[0]); lastTick = JSON.parse(tickLines[tickLines.length - 1]); }
    catch { skippedEmpty++; continue; }

    const title = firstTick.title;
    if (!title) { skippedNoTitle++; continue; }

    const p = parseTitle(title);
    if (!p) { skippedTitle++; continue; }

    const bucketLoC = p.kind === "or_below" ? -Infinity : toC(p.bucketLo, p.unit);
    const bucketHiC = p.kind === "or_above" ? Infinity  : toC(p.bucketHi, p.unit);

    // first/last ts across all ticks
    let firstTs = firstTick.timestamp, lastTs = lastTick.timestamp;
    for (const l of tickLines) {
      try { const t = JSON.parse(l).timestamp; if (t < firstTs) firstTs = t; if (t > lastTs) lastTs = t; } catch {}
    }

    const row = {
      conditionId, title,
      city: p.city, date: p.date,
      kind: p.kind, unit: p.unit,
      bucketLo: p.bucketLo, bucketHi: p.bucketHi,
      bucketLoC: bucketLoC === -Infinity ? null : Number(bucketLoC.toFixed(3)),
      bucketHiC: bucketHiC === Infinity  ? null : Number(bucketHiC.toFixed(3)),
      firstTs, lastTs, nTicks: tickLines.length,
    };
    lines.push(JSON.stringify(row));
    parsed++;
    const key = `${p.city}|${p.date}`;
    cityDateGroups.set(key, (cityDateGroups.get(key) || 0) + 1);
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, lines.join("\n") + "\n");

  // Report
  const report = [];
  report.push(`=== build-universe report ===`);
  report.push(`scanned:        ${files.length} tick files`);
  report.push(`parsed:         ${parsed} HIGHEST-temp markets`);
  report.push(`skipped:        noTitle=${skippedNoTitle} titleFail=${skippedTitle} empty=${skippedEmpty}`);
  report.push(`city-date groups: ${cityDateGroups.size}`);
  const sizes = [...cityDateGroups.values()].sort((a,b)=>a-b);
  const p = q => sizes[Math.floor(q * sizes.length)];
  report.push(`markets per group: min=${sizes[0]} p25=${p(.25)} p50=${p(.5)} p75=${p(.75)} p90=${p(.9)} max=${sizes[sizes.length-1]}`);
  const byKind = {};
  for (const l of lines) { const r = JSON.parse(l); byKind[r.kind] = (byKind[r.kind] || 0) + 1; }
  report.push(`by kind: ${Object.entries(byKind).map(([k,v])=>`${k}=${v}`).join(" ")}`);
  report.push(`elapsed: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  report.push(`output: ${OUT}`);

  const txt = report.join("\n");
  console.log("\n" + txt);
  await fs.writeFile(REPORT, txt + "\n");
}

main().catch(e => { console.error(e); process.exit(1); });
