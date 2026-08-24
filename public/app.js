"use strict";

const STORAGE_KEY = "stocktracker.holdings.v1";
const REFRESH_MS = 60000; // auto-refresh cadence while the app is open (1 min)

let holdings = [];        // populated in boot(); NOT via loadHoldings() here,
                          // because loadHoldings() -> save() assigns to
                          // `holdings`, which would hit the temporal dead zone
                          // if done during this binding's initialization.
let quotes = {};          // symbol -> { price, previousClose, ... }
let editingId = null;
let refreshTimer = null;

// ---------- persistence ----------
function loadHoldings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Only trust a non-empty array. An empty array can happen if the very
      // first load ran before seed.js was ready (e.g. during a cold start),
      // so we re-seed instead of getting stuck on an empty portfolio.
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) { /* fall through to seed */ }
  return seedHoldings();
}

function seedHoldings() {
  const seed = (window.SEED_HOLDINGS || []).map((h) => ({
    id: cryptoId(),
    symbol: String(h.symbol).toUpperCase(),
    shares: Number(h.shares) || 0,
    price: Number(h.price) || 0,   // fallback / manual price
    manual: !!h.manual,
  }));
  // Never persist an empty seed (would happen only if seed.js failed to load);
  // leaving storage untouched lets the next load seed correctly.
  if (seed.length > 0) save(seed);
  return seed;
}

function save(list) {
  holdings = list || holdings;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings)); } catch (e) {}
}

function cryptoId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------- pricing helpers ----------
// Effective price for a holding: live quote if available & not manual,
// otherwise the stored (fallback/manual) price.
function effectivePrice(h) {
  if (!h.manual) {
    const q = quotes[h.symbol];
    if (q && typeof q.price === "number") return q.price;
  }
  return h.price;
}

function isStale(h) {
  if (h.manual) return false;
  const q = quotes[h.symbol];
  return !q || typeof q.price !== "number";
}

function dayChangeFor(h) {
  // returns { abs, pct } change in *value* for today, or null if unknown
  if (h.manual) return null;
  const q = quotes[h.symbol];
  if (!q || typeof q.price !== "number" || typeof q.previousClose !== "number" || q.previousClose === 0) return null;
  const perShare = q.price - q.previousClose;
  return { abs: perShare * h.shares, pct: (perShare / q.previousClose) * 100 };
}

function holdingValue(h) { return effectivePrice(h) * h.shares; }

// ---------- formatting ----------
const fmtMoney = (n, max = 2) => {
  // minimumFractionDigits must never exceed maximumFractionDigits, otherwise
  // toLocaleString throws a RangeError. When max is 0 (whole-dollar totals) we
  // want min 0 too.
  const min = Math.min(2, max);
  return "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
};

function fmtPrice(n) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 1 ? (abs < 0.01 ? 5 : 4) : 2;
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

const fmtShares = (n) =>
  Number(n).toLocaleString("en-US", { maximumFractionDigits: 6 });

function fmtSigned(n) {
  const s = n >= 0 ? "+" : "−";
  return s + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- rendering ----------
function render() {
  const list = document.getElementById("holdings");
  const empty = document.getElementById("empty");

  const sorted = [...holdings].sort((a, b) => holdingValue(b) - holdingValue(a));

  empty.hidden = sorted.length > 0;
  list.innerHTML = "";

  let total = 0;
  let dayAbs = 0;
  let prevTotal = 0; // total value at yesterday's close (for %), only over live holdings

  for (const h of sorted) {
    const value = holdingValue(h);
    total += value;

    const dc = dayChangeFor(h);
    if (dc) {
      dayAbs += dc.abs;
      const q = quotes[h.symbol];
      prevTotal += q.previousClose * h.shares;
    }
    list.appendChild(renderRow(h, value, dc));
  }

  document.getElementById("networth").textContent = fmtMoney(total, 0);

  const dayEl = document.getElementById("day-change");
  if (prevTotal > 0) {
    const pct = (dayAbs / prevTotal) * 100;
    dayEl.textContent = `${fmtSigned(dayAbs)}  (${dayAbs >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%) today`;
    dayEl.className = "day-change " + (dayAbs > 0 ? "up" : dayAbs < 0 ? "down" : "neutral");
  } else {
    dayEl.textContent = "Day change unavailable";
    dayEl.className = "day-change neutral";
  }
}

function yahooUrl(symbol) {
  return "https://finance.yahoo.com/quote/" + encodeURIComponent(symbol);
}

function renderRow(h, value, dc) {
  const li = document.createElement("li");
  li.className = "row";
  // Tapping a row opens the ticker on Yahoo Finance. Manual-only holdings
  // (CUSIPs, warrants, delisted) have no Yahoo page, so tapping edits instead.
  li.addEventListener("click", () => {
    if (h.manual) { openModal(h); return; }
    window.open(yahooUrl(h.symbol), "_blank", "noopener,noreferrer");
  });

  const price = effectivePrice(h);
  const stale = isStale(h);

  let chgHtml = '<div class="chg neutral">—</div>';
  if (dc) {
    const cls = dc.pct > 0 ? "up" : dc.pct < 0 ? "down" : "neutral";
    const arrow = dc.pct > 0 ? "▲" : dc.pct < 0 ? "▼" : "";
    chgHtml = `<div class="chg ${cls}">${arrow} ${Math.abs(dc.pct).toFixed(2)}%</div>`;
  }

  const badges =
    (h.manual ? '<span class="badge manual">manual</span>' : "") +
    (stale && !h.manual ? '<span class="badge stale">no live</span>' : "");

  li.innerHTML = `
    <div class="row-main">
      <div class="row-sym">${escapeHtml(h.symbol)} ${badges}</div>
      <div class="row-sub">${fmtShares(h.shares)} sh · ${fmtPrice(price)}</div>
    </div>
    <div class="row-price">
      <div class="p">${fmtPrice(price)}</div>
      ${chgHtml}
    </div>
    <div class="row-val">
      <div class="v">${fmtMoney(value, 0)}</div>
      <div class="w">${(value ? (value / currentTotal() * 100) : 0).toFixed(1)}%</div>
    </div>
    <button class="edit-btn" aria-label="Edit ${escapeHtml(h.symbol)}" title="Edit">✎</button>`;
  // The pencil edits the holding; stop propagation so it doesn't also open Yahoo.
  const editBtn = li.querySelector(".edit-btn");
  if (editBtn) editBtn.addEventListener("click", (e) => { e.stopPropagation(); openModal(h); });
  return li;
}

function currentTotal() {
  return holdings.reduce((s, h) => s + holdingValue(h), 0) || 1;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- live quotes ----------
async function refresh() {
  const btn = document.getElementById("refresh-btn");
  btn.classList.add("spin");
  const symbols = [...new Set(holdings.filter((h) => !h.manual).map((h) => h.symbol))];
  try {
    if (symbols.length) {
      const url = "/api/quotes?symbols=" + encodeURIComponent(symbols.join(","));
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      quotes = data.quotes || {};
      // Persist last good live price as the new fallback, so net worth stays
      // accurate even if a later fetch fails or the app is opened offline.
      let changed = false;
      for (const h of holdings) {
        const q = quotes[h.symbol];
        if (q && typeof q.price === "number" && h.price !== q.price) { h.price = q.price; changed = true; }
      }
      if (changed) save();
    }
    setUpdated(new Date());
    setMarketState();
  } catch (e) {
    document.getElementById("updated").textContent = "Offline · showing last known prices";
  } finally {
    btn.classList.remove("spin");
    render();
  }
}

function setUpdated(date) {
  const t = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  document.getElementById("updated").textContent = "Updated " + t;
}

function setMarketState() {
  const states = Object.values(quotes).map((q) => q && q.marketState).filter(Boolean);
  const open = states.includes("REGULAR");
  const dot = document.getElementById("market-dot");
  const label = document.getElementById("market-label");
  dot.className = "dot " + (open ? "open" : "closed");
  if (open) label.textContent = "Net Worth · Market open";
  else if (states.some((s) => s === "PRE" || s === "POST")) label.textContent = "Net Worth · Extended hours";
  else label.textContent = "Net Worth · Market closed";
}

// ---------- growth chart ----------
// We fetch just two datasets ("base" = daily, "max" = monthly) and derive every
// range from them by slicing, so switching ranges costs no extra API calls.
const HISTORY = { range: "1y", base: null, max: null, retries: {} };

const RANGE_LABELS = {
  "1w": "past week", "10d": "past 10 days", "1mo": "past month",
  "3mo": "past 3 months", "6mo": "past 6 months", "1y": "past year",
  "max": "since inception",
};
// How many trailing daily points each range slices from the "base" dataset.
const RANGE_POINTS = {
  "1w": 5, "10d": 8, "1mo": 22, "3mo": 65, "6mo": 130, "1y": 260,
};

// On-device cache so the chart pulls fresh data only every couple of days,
// keeping us well within Twelve Data's free per-minute / per-day limits.
const HIST_STORE_KEY = "stocktracker.history.v1";
const HIST_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

function loadHistStore() {
  try { return JSON.parse(localStorage.getItem(HIST_STORE_KEY)) || {}; } catch (e) { return {}; }
}
function saveHistStore(store) {
  try { localStorage.setItem(HIST_STORE_KEY, JSON.stringify(store)); } catch (e) { /* ignore quota */ }
}

function topSymbols() {
  return [...new Set(
    holdings
      .filter((h) => !h.manual)
      .map((h) => ({ sym: h.symbol, val: effectivePrice(h) * h.shares }))
      .sort((a, b) => b.val - a.val)
      .map((x) => x.sym)
  )];
}

function invalidateChart() {
  HISTORY.base = null;
  HISTORY.max = null;
  HISTORY.retries = {};
  saveHistStore({}); // holdings changed -> force a fresh pull
  loadChart(HISTORY.range);
}

function sliceData(data, n) {
  const len = data.timeline.length;
  const start = Math.max(0, len - n);
  const series = {};
  for (const k in data.series) series[k] = data.series[k].slice(start);
  return { ...data, timeline: data.timeline.slice(start), series };
}

async function fetchDataset(kind) {
  const sig = topSymbols().join(",");

  // 1) Reuse on-device cache if it's fresh and for the same holdings.
  const store = loadHistStore();
  const entry = store[kind];
  if (entry && entry.sig === sig && (Date.now() - entry.at) < HIST_MAX_AGE_MS &&
      entry.data && (entry.data.timeline || []).length >= 2) {
    HISTORY[kind] = entry.data;
    return entry.data;
  }

  // 2) Otherwise fetch from the server.
  const url = `/api/history?range=${kind}&symbols=${encodeURIComponent(sig)}`;
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  if ((data && data.error) || (data.timeline || []).length >= 2) {
    HISTORY[kind] = data;
    if (!data.error && (data.timeline || []).length >= 2) {
      store[kind] = { at: Date.now(), sig, data };
      saveHistStore(store);
    }
  }
  return data;
}

async function loadChart(range) {
  HISTORY.range = range;
  updateRangeTabs();
  const msg = document.getElementById("chart-msg");
  msg.textContent = "Loading chart…";
  msg.hidden = false;
  try {
    const kind = range === "max" ? "max" : "base";
    let data = HISTORY[kind] || (await fetchDataset(kind));
    const ok = data && !data.error && (data.timeline || []).length >= 2;
    if (ok && kind === "base") data = sliceData(data, RANGE_POINTS[range] || 260);
    renderChart(data, range);

    // If it came back empty (free-tier rate limit), retry a couple of times.
    if (data && !data.error && (data.timeline || []).length < 2) {
      const n = (HISTORY.retries[kind] || 0);
      if (n < 3) {
        HISTORY.retries[kind] = n + 1;
        setTimeout(() => { if (HISTORY.range === range) loadChart(range); }, 12000);
      }
    } else {
      HISTORY.retries[kind] = 0;
    }
  } catch (e) {
    document.getElementById("chart-svg").innerHTML = "";
    msg.textContent = "Chart unavailable right now.";
    msg.hidden = false;
  }
}

function updateRangeTabs() {
  document.querySelectorAll(".range-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.range === HISTORY.range);
  });
}

// Reconstruct portfolio value over time from the tracked (largest) holdings,
// then scale that basket up to the whole portfolio's current value so the curve
// represents overall net worth even though we only pull history for a few names.
function portfolioSeries(data) {
  const timeline = data.timeline || [];
  const series = data.series || {};
  if (timeline.length < 2) return null;

  const values = new Array(timeline.length).fill(0);
  let trackedCurrent = 0;
  let totalCurrent = 0;
  for (const h of holdings) {
    const current = effectivePrice(h) * h.shares;
    totalCurrent += current;
    const s = !h.manual ? series[h.symbol] : null;
    if (s) {
      trackedCurrent += current;
      for (let i = 0; i < timeline.length; i++) values[i] += (s[i] || 0) * h.shares;
    }
  }
  if (trackedCurrent <= 0) return null;

  const scale = totalCurrent / trackedCurrent;   // extrapolate to full portfolio
  for (let i = 0; i < timeline.length; i++) values[i] *= scale;
  const trackedCount = Object.keys(series).length;
  const estimated = trackedCount < holdings.filter((h) => !h.manual).length;
  return { timeline, values, estimated };
}

function renderChart(data, uiRange) {
  const svg = document.getElementById("chart-svg");
  const msg = document.getElementById("chart-msg");
  const clearHeader = () => {
    svg.innerHTML = "";
    document.getElementById("chart-change").textContent = "—";
    document.getElementById("chart-change").className = "chart-change neutral";
    document.getElementById("chart-range-label").textContent = "";
    document.getElementById("chart-start").textContent = "";
    document.getElementById("chart-end").textContent = "";
  };
  if (data && data.error === "no_key") {
    clearHeader();
    msg.textContent = "Add a free Twelve Data API key to enable the growth chart.";
    msg.hidden = false;
    return;
  }
  if (!data || (data.timeline || []).length < 2) {
    clearHeader();
    msg.textContent = "History is warming up… retrying shortly.";
    msg.hidden = false;
    return;
  }
  const ps = portfolioSeries(data);
  if (!ps) {
    clearHeader();
    msg.textContent = "Not enough history yet.";
    msg.hidden = false;
    return;
  }
  msg.hidden = true;

  const { timeline, values } = ps;
  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const W = 1000, H = 300, pad = 12;
  const xAt = (i) => (i / (n - 1)) * W;
  const yAt = (v) => pad + (1 - (v - min) / span) * (H - 2 * pad);

  let line = "";
  for (let i = 0; i < n; i++) line += (i ? " L" : "M") + xAt(i).toFixed(1) + " " + yAt(values[i]).toFixed(1);
  const area = line + ` L${W} ${H} L0 ${H} Z`;

  const up = values[n - 1] >= values[0];
  const color = up ? "#2ec26b" : "#ff5c6c";
  svg.innerHTML = `
    <defs><linearGradient id="chartgrad" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#chartgrad)"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.5"
          vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${xAt(n - 1).toFixed(1)}" cy="${yAt(values[n - 1]).toFixed(1)}" r="4" fill="${color}"/>`;

  const first = values[0], last = values[n - 1];
  const chg = last - first;
  const pct = first ? (chg / first) * 100 : 0;
  const el = document.getElementById("chart-change");
  const sign = chg >= 0 ? "+" : "−";
  el.textContent = `${sign}$${Math.abs(chg).toLocaleString("en-US", { maximumFractionDigits: 0 })} (${sign}${Math.abs(pct).toFixed(1)}%)`;
  el.className = "chart-change " + (chg > 0 ? "up" : chg < 0 ? "down" : "neutral");
  document.getElementById("chart-range-label").textContent =
    (RANGE_LABELS[uiRange] || "") + (ps.estimated ? " · estimate" : "");

  const withYear = uiRange === "1y" || uiRange === "max";
  const fmtD = (t) => new Date(t * 1000).toLocaleDateString("en-US",
    { month: "short", day: "numeric", ...(withYear ? { year: "2-digit" } : {}) });
  document.getElementById("chart-start").textContent = fmtD(timeline[0]);
  document.getElementById("chart-end").textContent = fmtD(timeline[n - 1]);
}

// ---------- modal (add / edit) ----------
function openModal(h) {
  editingId = h ? h.id : null;
  document.getElementById("modal-title").textContent = h ? "Edit holding" : "Add holding";
  document.getElementById("f-symbol").value = h ? h.symbol : "";
  document.getElementById("f-shares").value = h ? h.shares : "";
  document.getElementById("f-price").value = h && h.manual ? h.price : "";
  document.getElementById("f-manual").checked = h ? !!h.manual : false;
  document.getElementById("f-symbol").disabled = !!h; // don't rename existing symbol
  document.getElementById("modal-delete").hidden = !h;
  document.getElementById("modal").hidden = false;
}

function closeModal() {
  document.getElementById("modal").hidden = true;
  editingId = null;
}

function saveModal() {
  const symbol = document.getElementById("f-symbol").value.trim().toUpperCase();
  const shares = parseFloat(document.getElementById("f-shares").value);
  const priceRaw = document.getElementById("f-price").value.trim();
  const manual = document.getElementById("f-manual").checked;
  const priceVal = priceRaw === "" ? null : parseFloat(priceRaw);

  if (!symbol) { alert("Enter a ticker symbol."); return; }
  if (!isFinite(shares) || shares < 0) { alert("Enter a valid number of shares."); return; }
  if (priceRaw !== "" && (!isFinite(priceVal) || priceVal < 0)) { alert("Enter a valid price."); return; }

  if (editingId) {
    const h = holdings.find((x) => x.id === editingId);
    if (h) {
      h.shares = shares;
      h.manual = manual;
      if (priceVal != null) h.price = priceVal; // else keep existing fallback price
    }
  } else {
    if (holdings.some((x) => x.symbol === symbol)) {
      if (!confirm(symbol + " already exists. Add another lot anyway?")) return;
    }
    holdings.push({
      id: cryptoId(),
      symbol,
      shares,
      price: priceVal != null ? priceVal : 0,
      manual,
    });
  }
  save();
  closeModal();
  render();
  refresh();
  invalidateChart();
}

function deleteHolding() {
  if (!editingId) return;
  const h = holdings.find((x) => x.id === editingId);
  if (h && confirm("Remove " + h.symbol + "?")) {
    holdings = holdings.filter((x) => x.id !== editingId);
    save();
    closeModal();
    render();
    invalidateChart();
  }
}

// ---------- events ----------
document.getElementById("refresh-btn").addEventListener("click", refresh);
document.getElementById("add-btn").addEventListener("click", () => openModal(null));
document.getElementById("modal-cancel").addEventListener("click", closeModal);
document.getElementById("modal-save").addEventListener("click", saveModal);
document.getElementById("modal-delete").addEventListener("click", deleteHolding);
document.getElementById("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});
document.getElementById("reset-btn").addEventListener("click", () => {
  if (confirm("Reset all holdings back to the original portfolio? This clears your edits.")) {
    localStorage.removeItem(STORAGE_KEY);
    holdings = seedHoldings();
    render();
    refresh();
    invalidateChart();
  }
});
document.getElementById("range-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".range-tab");
  if (btn) loadChart(btn.dataset.range);
});

// Refresh when the app regains focus (e.g. reopened from home screen)
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
}

// ---------- boot ----------
holdings = loadHoldings();
render();
refresh();
loadChart(HISTORY.range);
startAutoRefresh();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
