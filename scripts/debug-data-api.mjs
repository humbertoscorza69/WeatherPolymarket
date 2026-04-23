#!/usr/bin/env node
/**
 * Diagnose whether Polymarket's data-api is returning anything for 0x937.
 * Zero activity + zero positions could mean:
 *   A. Wallet really hasn't traded (stopped, or hasn't entered today yet)
 *   B. Our API call is wrong (endpoint moved, param format changed)
 *
 * Tries multiple endpoint shapes and shows the raw responses so we can tell.
 *
 * Usage:
 *   node scripts/debug-data-api.mjs
 *   node scripts/debug-data-api.mjs --wallet=0xabc...
 */
const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));

const WALLET = argv.wallet ?? "0x937bcac3ef9d02d0d00da0c5e2b2a6e26f2ebfab";
const WALLET_CHECKSUM = "0x937BCAC3EF9D02D0D00DA0C5E2B2A6E26F2EBFAB"; // common alt format

async function fetchRaw(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const body = await r.text();
    return { status: r.status, body };
  } catch (e) { return { status: -1, body: String(e?.message || e) }; }
}

async function probe(label, url) {
  const { status, body } = await fetchRaw(url);
  const first120 = body.slice(0, 120);
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  const size = Array.isArray(parsed) ? parsed.length
    : parsed?.data ? (Array.isArray(parsed.data) ? parsed.data.length : "?")
    : parsed ? "obj" : "—";
  console.log(`  ${label.padEnd(55)}  HTTP ${status}  items=${size}`);
  console.log(`    url:  ${url}`);
  console.log(`    body: ${first120}${body.length > 120 ? "..." : ""}`);
  if (Array.isArray(parsed) && parsed.length > 0) {
    const sample = parsed[0];
    const keys = Object.keys(sample).slice(0, 10).join(", ");
    console.log(`    sample keys: ${keys}`);
  }
  console.log();
}

async function main() {
  console.log(`=== Data-API diagnostic · ${new Date().toISOString()} ===`);
  console.log(`Wallet (lower): ${WALLET}`);
  console.log(`Wallet (checksum): ${WALLET_CHECKSUM}\n`);

  console.log("A · /positions variants");
  await probe("A1 data-api positions (lowercase)", `https://data-api.polymarket.com/positions?user=${WALLET}&limit=10`);
  await probe("A2 data-api positions (checksum)",  `https://data-api.polymarket.com/positions?user=${WALLET_CHECKSUM}&limit=10`);
  await probe("A3 data-api positions (user= only)", `https://data-api.polymarket.com/positions?user=${WALLET}`);

  console.log("B · /activity variants");
  await probe("B1 data-api activity (lowercase)", `https://data-api.polymarket.com/activity?user=${WALLET}&limit=10`);
  await probe("B2 data-api activity (checksum)",  `https://data-api.polymarket.com/activity?user=${WALLET_CHECKSUM}&limit=10`);

  console.log("C · /trades variants (alternate endpoint)");
  await probe("C1 data-api trades (lowercase)",   `https://data-api.polymarket.com/trades?user=${WALLET}&limit=10`);
  await probe("C2 data-api trades (maker_address)", `https://data-api.polymarket.com/trades?maker_address=${WALLET}&limit=10`);

  console.log("D · Known-active wallet sanity check");
  // Try a wallet we know trades a lot — humberto could substitute a hot wallet
  const hotWallet = "0x2d99b3c86cc8ee35f8b3b2e6c76f7b62fc2aa4c3"; // 2d99 from earlier
  await probe("D1 positions for 2d99 (lowercase)",  `https://data-api.polymarket.com/positions?user=${hotWallet}&limit=10`);
  await probe("D2 activity for 2d99 (lowercase)",   `https://data-api.polymarket.com/activity?user=${hotWallet}&limit=10`);

  console.log("E · Try alternative API hosts");
  await probe("E1 clob.polymarket.com trades", `https://clob.polymarket.com/trades?user=${WALLET}&limit=10`);
  await probe("E2 api.polymarket.com activity", `https://api.polymarket.com/activity?user=${WALLET}&limit=10`);

  console.log("=== Interpretation ===");
  console.log("- If any A/B/C return items > 0 → API works, use that URL shape in compare-to-wallet.mjs");
  console.log("- If A1 is empty but D1 has items → 937 really has 0 positions right now");
  console.log("- If D1 is ALSO empty → API broken or endpoint moved");
  console.log("- If all HTTP != 200 → endpoint path changed or we need auth headers");
}

main().catch(e => { console.error(e); process.exit(1); });
