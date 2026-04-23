#!/usr/bin/env node
/**
 * Diagnose why fetchLiveWeatherMarkets() is returning 0 markets.
 * Tries multiple filter variations against Gamma and reports counts.
 * Run:  node scripts/debug-gamma.mjs
 */
const GAMMA = "https://gamma-api.polymarket.com";

async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { __error: `HTTP ${r.status}`, __body: (await r.text()).slice(0, 200) };
    return await r.json();
  } catch (e) { return { __error: String(e?.message || e) }; }
}

function countTemp(arr) {
  if (!Array.isArray(arr)) return { total: 0, temperature: 0 };
  return {
    total: arr.length,
    temperature: arr.filter(m => /temperature/i.test(m.question || m.title || "")).length,
  };
}

async function probe(label, url) {
  const data = await fetchJson(url);
  if (data?.__error) {
    console.log(`  ${label}: ERROR ${data.__error} body=${data.__body || ""}`);
    return;
  }
  const c = countTemp(data);
  console.log(`  ${label}: total=${c.total}  temperature=${c.temperature}  url=${url.length > 160 ? url.slice(0, 157) + "..." : url}`);
  if (c.total && c.total <= 3) {
    for (const m of data.slice(0, 3)) {
      console.log(`     └─ ${m.question?.slice(0, 60) || "?"} · closed=${m.closed} · endDate=${m.endDate}`);
    }
  } else if (c.total > 3 && c.temperature > 0) {
    const samples = data.filter(m => /temperature/i.test(m.question || m.title || "")).slice(0, 3);
    for (const m of samples) {
      console.log(`     └─ ${m.question?.slice(0, 60) || "?"} · closed=${m.closed} · endDate=${m.endDate}`);
    }
  }
}

async function main() {
  const nowIso = new Date().toISOString();
  const in48h = new Date(Date.now() + 86400_000 * 2).toISOString();
  const in7d  = new Date(Date.now() + 86400_000 * 7).toISOString();

  console.log(`=== Gamma diagnostic · ${nowIso} ===\n`);

  console.log("A · Current detect.mjs query (our baseline):");
  await probe("A1", `${GAMMA}/markets?closed=false&tag_slug=weather&limit=500&offset=0&end_date_min=${nowIso}&end_date_max=${in48h}`);

  console.log("\nB · Same query without tag_slug (maybe the slug changed):");
  await probe("B1", `${GAMMA}/markets?closed=false&limit=500&offset=0&end_date_min=${nowIso}&end_date_max=${in48h}`);

  console.log("\nC · Same query without end_date filters (any open market at all?):");
  await probe("C1", `${GAMMA}/markets?closed=false&tag_slug=weather&limit=500&offset=0`);

  console.log("\nD · Try alternative tag slugs:");
  for (const slug of ["weather-markets", "weather-forecasts", "daily-weather", "temperature", "weather-daily"]) {
    await probe(`D:${slug}`, `${GAMMA}/markets?closed=false&tag_slug=${slug}&limit=50`);
  }

  console.log("\nE · Try bigger end-date window (7d instead of 48h):");
  await probe("E1", `${GAMMA}/markets?closed=false&tag_slug=weather&limit=500&offset=0&end_date_min=${nowIso}&end_date_max=${in7d}`);

  console.log("\nF · Try querying events (weather is sometimes grouped as events):");
  await probe("F1", `${GAMMA}/events?closed=false&tag_slug=weather&limit=50`);

  console.log("\nG · Keyword search for temperature in live markets:");
  await probe("G1", `${GAMMA}/markets?closed=false&limit=500&offset=0&end_date_min=${nowIso}&end_date_max=${in48h}`);

  console.log("\nF2 · Deep-dive event structure (do events contain child markets inline?):");
  const events = await fetchJson(`${GAMMA}/events?closed=false&tag_slug=weather&limit=5`);
  if (Array.isArray(events) && events.length) {
    const sample = events[0];
    console.log(`  sample event keys: ${Object.keys(sample).join(", ")}`);
    if (Array.isArray(sample.markets)) {
      console.log(`  sample event has ${sample.markets.length} child markets`);
      const child = sample.markets[0];
      if (child) {
        console.log(`    child keys: ${Object.keys(child).join(", ")}`);
        console.log(`    child.question: ${child.question?.slice(0, 80)}`);
        console.log(`    child.conditionId: ${child.conditionId}`);
        console.log(`    child.endDate: ${child.endDate}`);
        console.log(`    child.closed: ${child.closed}`);
        console.log(`    child.clobTokenIds: ${typeof child.clobTokenIds === "string" ? child.clobTokenIds.slice(0, 100) : child.clobTokenIds}`);
      }
    } else {
      console.log(`  NO child markets inline. Need to fetch /markets?event_id=${sample.id}`);
      console.log(`  sample event title: ${sample.title}`);
      console.log(`  sample event id: ${sample.id}  slug: ${sample.slug}`);
    }
  }

  console.log("\nH · Check tags list (see what tag slugs exist):");
  const tags = await fetchJson(`${GAMMA}/tags?limit=100`);
  if (Array.isArray(tags)) {
    const weatherish = tags.filter(t => /weather|temp|forecast/i.test(t.slug || t.label || ""));
    console.log(`  found ${weatherish.length} weather-ish tags out of ${tags.length} total`);
    for (const t of weatherish.slice(0, 10)) {
      console.log(`     └─ slug=\"${t.slug}\"  label=\"${t.label}\"  id=${t.id}`);
    }
  } else {
    console.log(`  /tags returned: ${JSON.stringify(tags).slice(0, 200)}`);
  }

  console.log("\n=== Interpretation guide ===");
  console.log("- If A1 is 0 but B1 has many temperature markets → tag_slug issue");
  console.log("- If A1 is 0 but C1 has temperature markets → end_date filter issue");
  console.log("- If all A/B/C are 0 but G1 has temperature markets → tag filter wrong");
  console.log("- If D-variant finds many → that's the new slug to use");
  console.log("- If H lists a different weather slug → rename in detect.mjs");
}

main().catch(e => { console.error(e); process.exit(1); });
