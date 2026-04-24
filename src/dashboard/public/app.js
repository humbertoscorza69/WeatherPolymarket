const POLL_MS = 2000;
const pnlHistory = [];

async function refresh() {
  let state;
  try {
    const res = await fetch("/state");
    if (!res.ok) throw new Error("fetch failed: " + res.status);
    state = await res.json();
    setStatus(true);
  } catch (err) {
    setStatus(false);
    console.error(err);
    return;
  }

  render(state);
}

function setStatus(online) {
  const el = document.getElementById("status-badge");
  el.textContent = online ? "ONLINE · LIVE" : "OFFLINE";
  el.className = "value " + (online ? "status-online" : "status-offline");
}

function render(state) {
  document.getElementById("uptime").textContent = formatUptime(state.uptimeMs);
  document.getElementById("started").textContent = formatTime(state.startTime);
  document.getElementById("last-update").textContent = "updated " + formatTime(state.now);

  const m = state.metrics;
  document.getElementById("round-trips").textContent = m.roundTrips.toString();
  document.getElementById("win-rate").textContent =
    m.roundTrips > 0 ? (m.winRate * 100).toFixed(1) + "%" : "—";
  const pnl = m.realizedPnlUsdc;
  const pnlEl = document.getElementById("pnl");
  pnlEl.textContent = (pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(2);
  pnlEl.classList.toggle("negative", pnl < 0);
  document.getElementById("pnl-sub").textContent =
    m.roundTrips + (m.roundTrips === 1 ? " round-trip" : " round-trips");

  document.getElementById("buys-placed").textContent = m.buysPlaced.toString();
  document.getElementById("sells-placed").textContent = m.sellsPlaced.toString();
  document.getElementById("buy-rejects").textContent = m.buyRejects.toString();
  document.getElementById("sell-rejects").textContent = m.sellRejects.toString();
  document.getElementById("taker-fills").textContent = m.takerFills.toString();

  renderPositions(state.engine.positions || []);
  renderOrders(state.engine.activeBuys || [], state.engine.activeSells || []);
  renderMarkets(state.engine.markets || []);
  renderEvents(state.events || []);
  updatePnlChart(state.events || []);
}

function renderPositions(positions) {
  document.getElementById("position-count").textContent =
    positions.length + (positions.length === 1 ? " position" : " positions");
  const body = document.getElementById("positions-body");
  if (positions.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="muted">no open positions</td></tr>`;
    return;
  }
  body.innerHTML = positions
    .map((p) => {
      const unrealizedPerShare = (p.activeSellPrice ?? p.avgEntryPrice) - p.avgEntryPrice;
      const unrealized = unrealizedPerShare * p.shares;
      const cls = unrealized > 0 ? "pnl-pos" : unrealized < 0 ? "pnl-neg" : "";
      const sellCell = p.activeSellPrice != null
        ? p.activeSellPrice.toFixed(3)
        : `<span class="muted">none</span>`;
      return `<tr>
        <td><strong>${escape(p.outcome ?? "?")}</strong></td>
        <td>${fmt(p.shares, 2)}</td>
        <td>${fmt(p.avgEntryPrice, 3)}</td>
        <td>${sellCell}</td>
        <td class="${cls}">${(unrealized >= 0 ? "+" : "") + "$" + unrealized.toFixed(3)}</td>
      </tr>`;
    })
    .join("");
}

function renderOrders(buys, sells) {
  document.getElementById("buys-count").textContent = buys.length.toString();
  document.getElementById("sells-count").textContent = sells.length.toString();
  const rows = [
    ...buys.map((o) => orderRow(o, "BUY")),
    ...sells.map((o) => orderRow(o, "SELL"))
  ];
  const body = document.getElementById("orders-body");
  body.innerHTML = rows.length
    ? rows.join("")
    : `<tr><td colspan="4" class="muted">no active orders</td></tr>`;
}

function orderRow(o, side) {
  const cls = side === "BUY" ? "side-buy" : "side-sell";
  return `<tr>
    <td class="${cls}">${side}</td>
    <td>${escape(o.outcome ?? "?")}</td>
    <td>${fmt(o.price, 3)}</td>
    <td title="${escape(o.orderId)}">${escape(shortId(o.orderId))}</td>
  </tr>`;
}

function renderMarkets(markets) {
  document.getElementById("market-count").textContent = markets.length + " markets";
  const body = document.getElementById("markets-body");
  if (markets.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="muted">no markets discovered</td></tr>`;
    return;
  }
  body.innerHTML = markets
    .map(
      (m) => `<tr>
        <td><strong>${escape(m.outcome ?? "?")}</strong></td>
        <td>${m.temperatureC ?? "—"}</td>
        <td>${m.tickSize ?? "—"}</td>
        <td>${fmtVolume(m.volume24hr)}</td>
        <td title="${escape(m.conditionId)}">${escape(shortId(m.conditionId))}</td>
      </tr>`
    )
    .join("");
}

function renderEvents(events) {
  const body = document.getElementById("events-body");
  if (events.length === 0) {
    body.innerHTML = `<tr><td colspan="8" class="muted">no events yet</td></tr>`;
    return;
  }
  // Newest first for the log view
  const reversed = [...events].reverse();
  body.innerHTML = reversed
    .map((e) => {
      const sideCls = e.side === "BUY" ? "side-buy" : e.side === "SELL" ? "side-sell" : "";
      const pnl =
        e.profitUsdc != null
          ? `<span class="${e.profitUsdc >= 0 ? "pnl-pos" : "pnl-neg"}">${
              (e.profitUsdc >= 0 ? "+" : "") + "$" + e.profitUsdc.toFixed(3)
            }</span>`
          : "—";
      return `<tr>
        <td>${formatTime(e.ts)}</td>
        <td><span class="event-tag event-${e.type}">${e.type}</span></td>
        <td>${escape(e.outcome ?? "—")}</td>
        <td class="${sideCls}">${e.side ?? "—"}</td>
        <td>${e.price != null ? fmt(e.price, 3) : "—"}</td>
        <td>${e.shares != null ? fmt(e.shares, 2) : "—"}</td>
        <td>${pnl}</td>
        <td>${escape(e.message ?? "")}</td>
      </tr>`;
    })
    .join("");
}

function updatePnlChart(events) {
  const trips = events.filter((e) => e.type === "ROUND_TRIP");
  let cum = 0;
  const points = trips.map((e) => {
    cum += e.profitUsdc ?? 0;
    return { ts: new Date(e.ts).getTime(), cum };
  });
  drawChart(points);
}

function drawChart(points) {
  const canvas = document.getElementById("pnl-chart");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 44, r: 16, t: 14, b: 22 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;

  ctx.strokeStyle = "#1d2a37";
  ctx.fillStyle = "#6b7a89";
  ctx.font = "10px ui-monospace, monospace";
  ctx.lineWidth = 1;
  // horizontal gridlines
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (innerH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }

  if (points.length === 0) {
    ctx.fillText("no round-trips yet", pad.l + 8, h / 2);
    return;
  }
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.cum);
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  const ymin = Math.min(0, ...ys);
  const ymax = Math.max(0.001, ...ys, ymin + 0.01);

  const x = (t) => pad.l + ((t - xmin) / Math.max(1, xmax - xmin)) * innerW;
  const y = (v) => pad.t + innerH - ((v - ymin) / (ymax - ymin)) * innerH;

  // zero line
  ctx.strokeStyle = "#2b3947";
  ctx.beginPath();
  ctx.moveTo(pad.l, y(0));
  ctx.lineTo(w - pad.r, y(0));
  ctx.stroke();

  // gradient fill
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + innerH);
  grad.addColorStop(0, "rgba(91,227,184,0.35)");
  grad.addColorStop(1, "rgba(91,227,184,0)");
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(p.ts);
    const py = y(p.cum);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.lineTo(x(points[points.length - 1].ts), y(0));
  ctx.lineTo(x(points[0].ts), y(0));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // line
  ctx.strokeStyle = "#5be3b8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(p.ts);
    const py = y(p.cum);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // dots
  ctx.fillStyle = "#5be3b8";
  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(x(p.ts), y(p.cum), 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // y-axis labels
  ctx.fillStyle = "#6b7a89";
  ctx.fillText("$" + ymax.toFixed(2), 4, pad.t + 10);
  ctx.fillText("$" + ymin.toFixed(2), 4, pad.t + innerH);
}

function escape(v) {
  if (v == null) return "";
  return String(v).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function fmt(v, d = 3) {
  if (v == null || Number.isNaN(v)) return "—";
  return Number(v).toFixed(d);
}
function fmtVolume(v) {
  if (v == null) return "—";
  if (v >= 1000) return "$" + (v / 1000).toFixed(1) + "k";
  return "$" + Number(v).toFixed(0);
}
function shortId(id) {
  if (!id) return "—";
  return id.length > 12 ? id.slice(0, 6) + "…" + id.slice(-4) : id;
}
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
}
function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

refresh();
setInterval(refresh, POLL_MS);
