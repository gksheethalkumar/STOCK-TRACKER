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
}

function deleteHolding() {
  if (!editingId) return;
  const h = holdings.find((x) => x.id === editingId);
  if (h && confirm("Remove " + h.symbol + "?")) {
    holdings = holdings.filter((x) => x.id !== editingId);
    save();
    closeModal();
    render();
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
  }
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
startAutoRefresh();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
