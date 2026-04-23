#!/usr/bin/env node
/**
 * Local trading dashboard for detect.mjs paper-trading output.
 *
 * Usage:
 *   node scripts/dashboard.mjs              # serves on http://localhost:8787
 *   node scripts/dashboard.mjs --port=9000
 *
 * Endpoints:
 *   GET /                → HTML dashboard (Sprint 2+)
 *   GET /api/stats       → JSON of computed metrics + all trades
 *   GET /api/health      → liveness
 */
import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));
const PORT = Number(argv.port ?? "8787");
const POSITIONS_FILE = path.resolve("data/detect-positions.json");
const LOG_FILE = path.resolve("data/detect-log.jsonl");
const UI_FILE = path.resolve("scripts/dashboard-ui.html");

const num = (x, d = 0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };

async function loadData() {
  let state = { positions: [], bankroll: 0, realizedPnl: 0, trades: [] };
  if (existsSync(POSITIONS_FILE)) {
    try { state = { ...state, ...JSON.parse(await fs.readFile(POSITIONS_FILE, "utf8")) }; } catch {}
  }
  let logLines = [];
  if (existsSync(LOG_FILE)) {
    try {
      const txt = await fs.readFile(LOG_FILE, "utf8");
      logLines = txt.trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {}
  }
  return { state, logLines };
}

function computeStats({ state, logLines }) {
  const opens = logLines.filter(e => e.type === "OPEN");
  const closes = logLines.filter(e => e.type === "CLOSE");
  const trades = state.trades || [];

  // core counts
  const totalAttempts = opens.length;
  const totalClosed = trades.length;
  const openCount = state.positions.length;

  // PnL buckets
  const wins = trades.filter(t => num(t.pnl) > 0.01);
  const losses = trades.filter(t => num(t.pnl) < -0.01);
  const flats = trades.filter(t => Math.abs(num(t.pnl)) <= 0.01);
  const winRate = totalClosed ? wins.length / totalClosed : 0;

  const grossWin = wins.reduce((s, t) => s + num(t.pnl), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + num(t.pnl), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const realizedPnl = trades.reduce((s, t) => s + num(t.pnl), 0);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
  const expectancy = totalClosed ? realizedPnl / totalClosed : 0;

  // Sharpe (per-trade, annualization skipped since these are paper prediction trades,
  // not daily returns; use normalized sharpe-like ratio: mean / std of pnl).
  const pnls = trades.map(t => num(t.pnl));
  const mean = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const variance = pnls.length ? pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / pnls.length : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? mean / std : 0;
  const downside = pnls.filter(p => p < 0);
  const downMean = downside.length ? downside.reduce((a, b) => a + b ** 2, 0) / downside.length : 0;
  const sortino = downMean > 0 ? mean / Math.sqrt(downMean) : 0;

  // streaks
  let curStreak = 0, curDir = 0, maxWinStreak = 0, maxLossStreak = 0;
  const sortedByClose = [...trades].sort((a, b) => new Date(a.closedAt || 0) - new Date(b.closedAt || 0));
  for (const t of sortedByClose) {
    const dir = num(t.pnl) > 0.01 ? 1 : (num(t.pnl) < -0.01 ? -1 : 0);
    if (dir === 0) continue;
    if (dir === curDir) curStreak++;
    else { curStreak = 1; curDir = dir; }
    if (dir > 0 && curStreak > maxWinStreak) maxWinStreak = curStreak;
    if (dir < 0 && curStreak > maxLossStreak) maxLossStreak = curStreak;
  }
  const currentStreak = curDir * curStreak;

  // equity curve + drawdown
  let equity = 0, peak = 0, maxDD = 0, maxRunup = 0, trough = 0;
  const equityCurve = [];
  for (const t of sortedByClose) {
    equity += num(t.pnl);
    equityCurve.push({ ts: t.closedAt, equity, pnl: num(t.pnl) });
    if (equity > peak) { peak = equity; trough = equity; }
    if (equity < trough) trough = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    const ru = equity - trough;
    if (ru > maxRunup) maxRunup = ru;
  }

  // hold time
  const holds = trades.map(t => {
    const o = new Date(t.openedAt).getTime();
    const c = new Date(t.closedAt || Date.now()).getTime();
    return (c - o) / 60000; // minutes
  }).filter(h => h > 0);
  const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;
  const medianHold = holds.length ? [...holds].sort((a, b) => a - b)[Math.floor(holds.length / 2)] : 0;

  // fill rate (OPEN events are always "filled" in paper mode, so use signal-to-close ratio)
  // Real fill rate requires knowing how many signals were REJECTED — we can use the
  // Insufficient-bankroll log as a proxy, but those are in console not JSONL. For now
  // report "attempt success" = closed / opened (open-still-running count excluded).
  const fillRate = totalAttempts ? (totalAttempts - openCount - 0) / totalAttempts : 0;

  // largest / smallest
  const sortedPnl = [...pnls].sort((a, b) => a - b);
  const largestLoss = sortedPnl[0] ?? 0;
  const largestWin = sortedPnl[sortedPnl.length - 1] ?? 0;

  // breakdowns
  const bySide = {};
  const byReason = {};
  const byCity = {};
  const byCushion = {};
  // Thermal-edge matrix: cushion-bucket × threshold-temp-bucket → { n, w, pnl }
  const thermalBuckets = {};  // key "cushion|threshold"
  const extractThreshold = (title) => {
    if (!title) return null;
    const m = String(title).match(/be\s+(-?\d+(?:\.\d+)?)°?C/i);
    return m ? Number(m[1]) : null;
  };
  for (const t of trades) {
    const s = t.side || "?"; bySide[s] = bySide[s] || { n: 0, pnl: 0, w: 0 };
    bySide[s].n++; bySide[s].pnl += num(t.pnl); if (num(t.pnl) > 0.01) bySide[s].w++;
    const r = t.reason || "?"; byReason[r] = byReason[r] || { n: 0, pnl: 0, w: 0 };
    byReason[r].n++; byReason[r].pnl += num(t.pnl); if (num(t.pnl) > 0.01) byReason[r].w++;
    const c = t.city || "?"; byCity[c] = byCity[c] || { n: 0, pnl: 0, w: 0 };
    byCity[c].n++; byCity[c].pnl += num(t.pnl); if (num(t.pnl) > 0.01) byCity[c].w++;
    const cu = Math.round(num(t.cushion) * 2) / 2;
    byCushion[cu] = byCushion[cu] || { n: 0, pnl: 0, w: 0 };
    byCushion[cu].n++; byCushion[cu].pnl += num(t.pnl); if (num(t.pnl) > 0.01) byCushion[cu].w++;

    const threshold = extractThreshold(t.title);
    const cushionBucket = Math.min(6, Math.max(0, Math.floor(num(t.cushion) + 0.5))); // 0..6 integer
    if (threshold != null) {
      const tBucket = Math.round(threshold); // 1°C buckets
      const key = `${cushionBucket}|${tBucket}`;
      thermalBuckets[key] = thermalBuckets[key] || { n: 0, w: 0, pnl: 0, cushion: cushionBucket, threshold: tBucket };
      thermalBuckets[key].n++;
      thermalBuckets[key].pnl += num(t.pnl);
      if (num(t.pnl) > 0.01) thermalBuckets[key].w++;
    }
  }

  // unrealized
  let unrealized = 0;
  for (const p of state.positions) {
    // without a live price we can't compute unrealized; show 0 + count
    unrealized += 0;
  }

  // rolling WR (last N trades)
  const rollingN = 30;
  const rollingWR = [];
  for (let i = 0; i < sortedByClose.length; i++) {
    const window = sortedByClose.slice(Math.max(0, i - rollingN + 1), i + 1);
    const w = window.filter(t => num(t.pnl) > 0.01).length;
    rollingWR.push({ idx: i + 1, wr: window.length ? w / window.length : 0 });
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      bankroll: num(state.bankroll),
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      unrealizedPnl: Math.round(unrealized * 100) / 100,
      totalPnl: Math.round((realizedPnl + unrealized) * 100) / 100,
      openPositions: openCount,
      totalClosed,
      totalAttempts,
      wins: wins.length,
      losses: losses.length,
      flats: flats.length,
      winRate,
      fillRate,
      profitFactor: Number.isFinite(profitFactor) ? profitFactor : null,
      payoffRatio: Number.isFinite(payoff) ? payoff : null,
      expectancy,
      avgWin, avgLoss,
      largestWin, largestLoss,
      sharpe, sortino,
      grossWin, grossLoss,
      maxDrawdown: maxDD,
      maxRunup,
      currentStreak,
      maxWinStreak,
      maxLossStreak,
      avgHoldMin: avgHold,
      medianHoldMin: medianHold,
    },
    equityCurve,
    rollingWR,
    breakdown: { bySide, byReason, byCity, byCushion },
    thermalEdge: Object.values(thermalBuckets),
    openPositions: state.positions,
    closedTrades: sortedByClose,
  };
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  try {
    if (u.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
      return;
    }
    if (u.pathname === "/api/stats") {
      const data = await loadData();
      const stats = computeStats(data);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(stats));
      return;
    }
    if (u.pathname === "/" || u.pathname === "/index.html") {
      if (existsSync(UI_FILE)) {
        const html = await fs.readFile(UI_FILE, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<html><body style="font-family:system-ui;padding:24px;background:#0b0e14;color:#c9d1d9">
          <h1>Dashboard API ready</h1>
          <p>Sprint 1 — server is up. UI lands in sprint 2.</p>
          <p>Try <a href="/api/stats" style="color:#58a6ff">/api/stats</a> for raw JSON.</p>
          </body></html>`);
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`API:       http://localhost:${PORT}/api/stats`);
  console.log(`Reads:     ${POSITIONS_FILE}`);
  console.log(`           ${LOG_FILE}`);
});
