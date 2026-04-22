/* ============================================================
   PORTFOLIO DASHBOARD — script.js
   Fuentes: Rava (AR), Yahoo Finance (Global), CoinGecko (Crypto)
   Todo vía /api/proxy (Netlify Function)
   ============================================================ */

'use strict';

// ─── CONSTANTS ───────────────────────────────────────────────
const PROXY = '/api/proxy';
const LS_POSITIONS = 'portfolio_positions_v2';
const LS_PRICES    = 'portfolio_prices_v2';
const LS_HISTORY   = 'portfolio_history_v2';
const LS_MACRO     = 'macroData_v2';
const CACHE_TTL    = 15 * 60 * 1000;   // 15 min
const MACRO_TTL    = 24 * 60 * 60 * 1000; // 24 h
const PIE_COLORS   = [
  '#378ADD','#1D9E75','#E8A838','#E05C5C','#8B5CF6',
  '#F472B6','#34D399','#FB923C','#60A5FA','#A78BFA'
];

// ─── STATE ───────────────────────────────────────────────────
let positions  = [];   // [{ticker, type, quantity, avgPrice, currency}]
let priceCache = {};   // {ticker: {price, change, changeAbs, timestamp, cached}}
let mepRate    = null; // ARS per USD
let lineChart  = null;
let pieChart   = null;
let currentRange = '1M';
let activeType   = 'ar';

// ─── UTILS ───────────────────────────────────────────────────
const fmt = {
  usd:  v => '$' + Math.abs(v).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}),
  ars:  v => '$' + Math.abs(v).toLocaleString('es-AR', {minimumFractionDigits:0, maximumFractionDigits:0}),
  pct:  v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%',
  sign: v => v >= 0 ? '+' : '−',
  mep:  v => '$ ' + Math.round(v).toLocaleString('es-AR'),
};

function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

function el(id) { return document.getElementById(id); }

function setVal(id, html, cls) {
  const e = el(id);
  if (!e) return;
  e.innerHTML = html;
  if (cls) { e.className = e.className.replace(/\b(pos|neg)\b/g, ''); e.classList.add(cls); }
}

function colorClass(v) { return v >= 0 ? 'pos' : 'neg'; }

// ─── LOCAL STORAGE HELPERS ───────────────────────────────────
function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ─── CACHE: PRICES ───────────────────────────────────────────
function getCachedPrices() {
  const raw = lsGet(LS_PRICES);
  if (!raw) return {};
  const now = Date.now();
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (now - v.timestamp < CACHE_TTL) out[k] = { ...v, cached: false };
    else if (v.price)                   out[k] = { ...v, cached: true };
  }
  return out;
}
function setCachedPrices(data) {
  const prev = lsGet(LS_PRICES) || {};
  for (const [k, v] of Object.entries(data)) {
    prev[k] = { ...v, timestamp: Date.now() };
  }
  lsSet(LS_PRICES, prev);
}

// ─── CACHE: MACRO ─────────────────────────────────────────────
function getCachedMacro() {
  const raw = lsGet(LS_MACRO);
  if (!raw) return null;
  const age = Date.now() - (raw.timestamp || 0);
  if (age < MACRO_TTL) return { ...raw, cached: false };
  if (raw.mep)         return { ...raw, cached: true };
  return null;
}
function setCachedMacro(data) {
  lsSet(LS_MACRO, { ...data, timestamp: Date.now() });
}

// ─── PROXY FETCH ─────────────────────────────────────────────
async function fetchViaProxy(url, timeout = 10000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${PROXY}?url=${encodeURIComponent(url)}`, {
      signal: controller.signal
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

// ─── DATA: MEP RATE ──────────────────────────────────────────
async function fetchMepRate() {
  // AL30 en pesos / AL30D en dólares = MEP implícito
  try {
    const data = await fetchViaProxy('https://api.bluelytics.com.ar/v2/latest');
    if (data && data.blue && data.blue.value_sell) {
      return parseFloat(data.blue.value_sell);
    }
  } catch {}
  // fallback: dolarito API
  try {
    const data = await fetchViaProxy('https://dolarapi.com/v1/dolares/bolsa');
    if (data && data.venta) return parseFloat(data.venta);
  } catch {}
  return null;
}

// ─── DATA: MACRO (MEP + RIESGO PAÍS) ─────────────────────────
async function fetchMacroData() {
  let mep = null, riesgo = null;

  // MEP
  try {
    const d = await fetchViaProxy('https://dolarapi.com/v1/dolares/bolsa');
    if (d && d.venta) mep = parseFloat(d.venta);
  } catch {}
  if (!mep) {
    try {
      const d = await fetchViaProxy('https://api.bluelytics.com.ar/v2/latest');
      if (d && d.blue) mep = parseFloat(d.blue.value_sell);
    } catch {}
  }

  // Riesgo país (EMBI Argentina) vía ambito/api pública
  try {
    const d = await fetchViaProxy('https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais/ultimo');
    if (d && d.valor) riesgo = Math.round(parseFloat(d.valor));
  } catch {}

  return { mep, riesgo };
}

function renderMacro(data, cached) {
  const mepStr    = data.mep    ? fmt.mep(data.mep)          : '—';
  const riesgoStr = data.riesgo ? String(data.riesgo)         : '—';
  const suffix    = cached ? ' <span style="opacity:.55">(cache)</span>' : '';
  el('sourceRow').innerHTML =
    `Dólar MEP: ${mepStr} · Riesgo País: ${riesgoStr}${suffix}`;
}

async function loadMacro() {
  const cached = getCachedMacro();
  if (cached) {
    renderMacro(cached, cached.cached);
    mepRate = cached.mep;
    if (!cached.cached) return; // fresh
  }
  try {
    const fresh = await fetchMacroData();
    if (fresh.mep || fresh.riesgo) {
      setCachedMacro(fresh);
      renderMacro(fresh, false);
      mepRate = fresh.mep;
    }
  } catch {
    if (!cached) renderMacro({ mep: null, riesgo: null }, false);
  }
}

// ─── DATA: ARGENTINA (RAVA) ───────────────────────────────────
async function fetchArPrice(ticker) {
  // Rava Bursátil JSON endpoint
  const url = `https://www.rava.com/servicios/cotizaciones.php?pizarra=${encodeURIComponent(ticker)}&formato=JSON`;
  const data = await fetchViaProxy(url);
  // Rava devuelve array o objeto
  const item = Array.isArray(data) ? data[0] : (data.datos ? data.datos[0] : data);
  if (!item) throw new Error('No data');
  const price     = parseFloat(item.ult || item.ultimo || item.cierre || 0);
  const prev      = parseFloat(item.ant || item.anterior || item.precierre || price);
  const changeAbs = price - prev;
  const change    = prev ? (changeAbs / prev) * 100 : 0;
  return { price, change, changeAbs };
}

// ─── DATA: GLOBAL / CEDEAR (YAHOO FINANCE) ───────────────────
async function fetchGlobalPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`;
  const data = await fetchViaProxy(url);
  const meta   = data.chart.result[0].meta;
  const price  = meta.regularMarketPrice;
  const prev   = meta.chartPreviousClose || meta.previousClose || price;
  const changeAbs = price - prev;
  const change    = prev ? (changeAbs / prev) * 100 : 0;
  return { price, change, changeAbs };
}

// ─── DATA: CRYPTO (COINGECKO) ────────────────────────────────
const COINGECKO_MAP = {
  BTC:'bitcoin', ETH:'ethereum', BNB:'binancecoin', SOL:'solana',
  ADA:'cardano', XRP:'ripple', DOGE:'dogecoin', MATIC:'matic-network',
  DOT:'polkadot', AVAX:'avalanche-2', LINK:'chainlink', UNI:'uniswap',
  ATOM:'cosmos', LTC:'litecoin', BCH:'bitcoin-cash', NEAR:'near',
  APT:'aptos', ARB:'arbitrum', OP:'optimism', INJ:'injective-protocol',
  USDT:'tether', USDC:'usd-coin',
};

async function fetchCryptoPrice(ticker) {
  const id = COINGECKO_MAP[ticker.toUpperCase()] || ticker.toLowerCase();
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`;
  const data = await fetchViaProxy(url);
  const info = data[id];
  if (!info) throw new Error(`CoinGecko: ${id} not found`);
  const price     = info.usd;
  const change    = info.usd_24h_change || 0;
  const changeAbs = price * change / 100;
  return { price, change, changeAbs };
}

// ─── FETCH ALL PRICES ─────────────────────────────────────────
async function fetchAllPrices(forceRefresh = false) {
  if (!positions.length) return {};

  const cached = getCachedPrices();
  const result = { ...cached };
  const toFetch = forceRefresh
    ? positions
    : positions.filter(p => !cached[p.ticker] || cached[p.ticker].cached);

  const fetchers = toFetch.map(async p => {
    try {
      let data;
      if      (p.type === 'ar')     data = await fetchArPrice(p.ticker);
      else if (p.type === 'global') data = await fetchGlobalPrice(p.ticker);
      else                          data = await fetchCryptoPrice(p.ticker);
      result[p.ticker] = { ...data, cached: false };
    } catch {
      // keep cached if available
      if (!result[p.ticker]) result[p.ticker] = { price: 0, change: 0, changeAbs: 0, cached: true };
    }
  });

  await Promise.allSettled(fetchers);
  setCachedPrices(result);
  priceCache = result;
  return result;
}

// ─── CALCULATIONS ─────────────────────────────────────────────
function toUSD(valueInCurrency, currency) {
  if (currency === 'USD') return valueInCurrency;
  if (!mepRate || mepRate <= 0) return valueInCurrency / 1000; // rough fallback
  return valueInCurrency / mepRate;
}

function calculatePortfolio(prices) {
  let totalUSD   = 0;
  let totalCostUSD = 0;
  let todayAbsUSD  = 0;
  const rows = [];

  for (const pos of positions) {
    const info = prices[pos.ticker];
    if (!info) continue;

    const price    = info.price || 0;
    const change   = info.change || 0;
    const currency = pos.currency || (pos.type === 'crypto' ? 'USD' : pos.type === 'ar' ? 'ARS' : 'USD');

    const totalVal  = price * pos.quantity;
    const totalCost = pos.avgPrice * pos.quantity;
    const gainAbs   = totalVal - totalCost;
    const gainPct   = totalCost > 0 ? (gainAbs / totalCost) * 100 : 0;
    const dayAbsLocal = (info.changeAbs || 0) * pos.quantity;

    const totalValUSD  = toUSD(totalVal, currency);
    const totalCostUSD_ = toUSD(totalCost, currency);
    const dayAbsUSD_   = toUSD(dayAbsLocal, currency);

    totalUSD     += totalValUSD;
    totalCostUSD += totalCostUSD_;
    todayAbsUSD  += dayAbsUSD_;

    rows.push({
      ticker: pos.ticker, type: pos.type, quantity: pos.quantity,
      avgPrice: pos.avgPrice, currency,
      price, change, changeAbs: info.changeAbs || 0,
      totalVal, totalCost, gainAbs, gainPct,
      totalValUSD, cached: info.cached
    });
  }

  const totalGainUSD  = totalUSD - totalCostUSD;
  const totalGainPct  = totalCostUSD > 0 ? (totalGainUSD / totalCostUSD) * 100 : 0;
  const todayPct      = (totalUSD - todayAbsUSD) > 0
    ? (todayAbsUSD / (totalUSD - todayAbsUSD)) * 100 : 0;

  // Best performer today
  const best = rows.reduce((a, b) => (b.change > (a?.change || -Infinity) ? b : a), null);

  return { rows, totalUSD, totalGainUSD, totalGainPct, todayAbsUSD, todayPct, best };
}

// ─── RENDER: METRICS ──────────────────────────────────────────
function renderMetrics(calc) {
  const { totalUSD, totalGainUSD, totalGainPct, todayAbsUSD, todayPct, best, rows } = calc;

  setVal('totalVal', fmt.usd(totalUSD));

  const gainSign = totalGainUSD >= 0 ? '+' : '−';
  setVal('totalGain', gainSign + fmt.usd(Math.abs(totalGainUSD)), colorClass(totalGainUSD));
  setVal('totalGainPct', fmt.pct(totalGainPct), colorClass(totalGainPct));

  setVal('todayPct', fmt.pct(todayPct), colorClass(todayPct));
  const todaySign = todayAbsUSD >= 0 ? '+' : '−';
  setVal('todayAbs', todaySign + fmt.usd(Math.abs(todayAbsUSD)) + ' hoy');

  setVal('posCount', rows.length);

  if (best) {
    setVal('bestTicker', best.ticker);
    setVal('bestPct', fmt.pct(best.change), colorClass(best.change));
  }
}

// ─── RENDER: TABLE ────────────────────────────────────────────
function renderTable(rows) {
  const tbody = el('posTable');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">Agregá tu primera posición arriba ↑</td></tr>';
    return;
  }

  const currLabel = { ar: 'ARS', global: 'USD', crypto: 'USD' };

  tbody.innerHTML = rows.map((r, i) => {
    const cur = r.currency;
    const fmtPrice = cur === 'ARS' ? fmt.ars : fmt.usd;
    return `
    <tr>
      <td>
        <div class="ticker-name">${r.ticker}
          <span class="type-badge">${r.type.toUpperCase()}</span>
          ${r.cached ? '<span class="src-badge">cache</span>' : ''}
        </div>
        <div class="ticker-sub">${currLabel[r.type] || cur}</div>
      </td>
      <td>${fmtPrice(r.price)}</td>
      <td class="${colorClass(r.change)}">${fmt.pct(r.change)}</td>
      <td>${r.quantity.toLocaleString('es-AR', {maximumFractionDigits:4})}</td>
      <td>${fmtPrice(r.avgPrice)}</td>
      <td>${fmtPrice(r.totalVal)}</td>
      <td class="${colorClass(r.gainAbs)}">${r.gainAbs >= 0 ? '+' : '−'}${fmtPrice(Math.abs(r.gainAbs))}</td>
      <td class="${colorClass(r.gainPct)}">${fmt.pct(r.gainPct)}</td>
      <td><button class="del-btn" data-idx="${i}" title="Eliminar">✕</button></td>
    </tr>`;
  }).join('');

  // Delete handlers
  tbody.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const origIdx = positions.findIndex(p => p.ticker === rows[btn.dataset.idx].ticker);
      if (origIdx !== -1) { positions.splice(origIdx, 1); savePositions(); refresh(); }
    });
  });
}

// ─── RENDER: PIE CHART ───────────────────────────────────────
function renderPie(rows) {
  const ctx = el('pieChart').getContext('2d');
  const labels = rows.map(r => r.ticker);
  const data   = rows.map(r => r.totalValUSD);

  if (pieChart) pieChart.destroy();
  pieChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: PIE_COLORS, borderWidth: 0, hoverOffset: 6 }]
    },
    options: {
      cutout: '62%',
      plugins: { legend: { display: false }, tooltip: {
        callbacks: {
          label: ctx => ` ${ctx.label}: ${fmt.usd(ctx.raw)} (${((ctx.raw / ctx.dataset.data.reduce((a,b)=>a+b,0))*100).toFixed(1)}%)`
        }
      }},
      animation: { duration: 600 }
    }
  });

  // Custom legend
  const legend = el('pieLegend');
  legend.innerHTML = labels.map((l, i) =>
    `<span><span class="leg-dot" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>${l}</span>`
  ).join('');
}

// ─── DATA: HISTORY (line chart) ───────────────────────────────
async function fetchHistoryYahoo(ticker, range) {
  const rangeMap = { '1M':'1mo', '6M':'6mo', 'YTD':'ytd', '1Y':'1y' };
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${rangeMap[range]||'1mo'}`;
  try {
    const data = await fetchViaProxy(url);
    const ts     = data.chart.result[0].timestamp;
    const closes = data.chart.result[0].indicators.quote[0].close;
    return ts.map((t, i) => ({ t: t * 1000, v: closes[i] })).filter(d => d.v != null);
  } catch { return []; }
}

function normalizeHistory(series) {
  if (!series.length) return [];
  const base = series[0].v;
  return series.map(d => ({ t: d.t, v: base > 0 ? ((d.v - base) / base) * 100 : 0 }));
}

async function buildLineData(range) {
  // Use BRK-B as benchmark
  const benchmark = await fetchHistoryYahoo('BRK-B', range);
  const benchNorm = normalizeHistory(benchmark);

  // Portfolio: weight history by current allocation
  const total = positions.reduce((s, p) => {
    const price = priceCache[p.ticker]?.price || 0;
    return s + price * p.quantity;
  }, 0);

  if (!total || !positions.length) return { portfolio: [], benchmark: benchNorm };

  // Fetch histories for all positions
  const histories = await Promise.allSettled(
    positions
      .filter(p => p.type === 'global' || p.type === 'crypto')
      .map(p => fetchHistoryYahoo(p.ticker, range).then(h => ({ ticker: p.ticker, h })))
  );

  // Build weighted portfolio series aligned to benchmark dates
  const dates = benchNorm.map(d => d.t);
  const portfolio = dates.map((t, i) => {
    let weightedPct = 0;
    let weightSum   = 0;
    for (const res of histories) {
      if (res.status !== 'fulfilled') continue;
      const { ticker, h } = res.value;
      if (!h.length) continue;
      const norm  = normalizeHistory(h);
      const point = norm.find(d => Math.abs(d.t - t) < 86400000 * 2) || norm[clamp(i, 0, norm.length-1)];
      const price = priceCache[ticker]?.price || 0;
      const pos   = positions.find(p => p.ticker === ticker);
      if (!pos) continue;
      const weight = (price * pos.quantity) / total;
      weightedPct += (point?.v || 0) * weight;
      weightSum   += weight;
    }
    return { t, v: weightSum > 0 ? weightedPct / weightSum : 0 };
  });

  return { portfolio, benchmark: benchNorm };
}

// ─── RENDER: LINE CHART ───────────────────────────────────────
async function renderLineChart(range) {
  const { portfolio, benchmark } = await buildLineData(range);

  const labels = benchmark.map(d =>
    new Date(d.t).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })
  );

  const ctx = el('lineChart').getContext('2d');
  if (lineChart) lineChart.destroy();

  lineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Mi portfolio',
          data: portfolio.map(d => parseFloat(d.v.toFixed(2))),
          borderColor: '#378ADD',
          backgroundColor: 'rgba(55,138,221,0.08)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'BRK-B',
          data: benchmark.map(d => parseFloat(d.v.toFixed(2))),
          borderColor: '#1D9E75',
          borderDash: [5, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.raw >= 0 ? '+' : ''}${ctx.raw}%`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 6, color: '#a09f9a', font: { size: 11 } }
        },
        y: {
          grid: { color: 'rgba(0,0,0,0.06)' },
          ticks: {
            color: '#a09f9a', font: { size: 11 },
            callback: v => (v >= 0 ? '+' : '') + v + '%'
          }
        }
      },
      animation: { duration: 500 }
    }
  });
}

// ─── RENDER: FULL UI ──────────────────────────────────────────
function renderUI(prices) {
  const calc = calculatePortfolio(prices);
  renderMetrics(calc);
  renderTable(calc.rows);
  if (calc.rows.length) {
    renderPie(calc.rows);
    renderLineChart(currentRange);
  }
}

// ─── POSITIONS PERSISTENCE ────────────────────────────────────
function loadPositions() {
  positions = lsGet(LS_POSITIONS) || [];
}
function savePositions() {
  lsSet(LS_POSITIONS, positions);
}

// ─── DETECT TYPE FROM TICKER ──────────────────────────────────
function detectType(ticker) {
  const t = ticker.toUpperCase();
  if (COINGECKO_MAP[t]) return 'crypto';
  // AR tickers: letras + números, típicamente 4-6 chars o bonos (AL30, GD35, etc.)
  if (/^[A-Z]{2,5}\d{0,2}[A-Z]?$/.test(t) && activeType === 'ar') return 'ar';
  return activeType;
}

// ─── FORM: ADD POSITION ───────────────────────────────────────
function showError(msg) {
  const e = el('addError');
  e.textContent = msg;
  e.style.display = msg ? 'block' : 'none';
}

async function handleAdd() {
  const ticker = el('tickerInput').value.trim().toUpperCase();
  const qty    = parseFloat(el('qtyInput').value);
  const avg    = parseFloat(el('avgInput').value);

  if (!ticker)      return showError('Ingresá un ticker.');
  if (isNaN(qty) || qty <= 0) return showError('Cantidad inválida.');
  if (isNaN(avg) || avg <= 0) return showError('Precio promedio inválido.');
  if (positions.find(p => p.ticker === ticker)) return showError('Ya existe esa posición.');

  showError('');
  const btn = el('addBtn');
  btn.disabled = true;
  btn.textContent = 'Cargando…';

  const type     = detectType(ticker);
  const currency = type === 'ar' ? 'ARS' : 'USD';

  positions.push({ ticker, type, quantity: qty, avgPrice: avg, currency });
  savePositions();

  // Fetch price immediately
  await fetchAllPrices(false);
  renderUI(priceCache);

  el('tickerInput').value = '';
  el('qtyInput').value    = '';
  el('avgInput').value    = '';
  btn.disabled  = false;
  btn.textContent = '+ Agregar';
}

// ─── REFRESH ──────────────────────────────────────────────────
async function refresh(force = false) {
  await loadMacro();
  const prices = await fetchAllPrices(force);
  renderUI(prices);
}

// ─── CLOCKS ───────────────────────────────────────────────────
function updateClocks() {
  const now = new Date();
  const toStr = (tz) => now.toLocaleTimeString('es-AR', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  el('clockAR').textContent = 'AR ' + toStr('America/Argentina/Buenos_Aires');
  el('clockNY').textContent = 'NY ' + toStr('America/New_York');
}

// ─── SMART REFRESH SCHEDULE ───────────────────────────────────
function scheduleRefresh() {
  const now    = new Date();
  const nyHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));

  // Market sessions (NY time): open ~9:30, mid ~12:00, close ~16:00
  const targets = [9.5, 12, 16];
  const nowHour = nyHour + now.getMinutes() / 60;
  let nextMs    = null;

  for (const t of targets) {
    if (t > nowHour) { nextMs = (t - nowHour) * 3600 * 1000; break; }
  }
  if (!nextMs) nextMs = (24 - nowHour + 9.5) * 3600 * 1000; // next day open
  // Cap to 2h fallback
  const delay = Math.min(nextMs, 2 * 3600 * 1000);
  setTimeout(() => { refresh(true); scheduleRefresh(); }, delay);
}

// ─── RANGE BUTTONS ───────────────────────────────────────────
function initRangeButtons() {
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = btn.dataset.range;
      renderLineChart(currentRange);
    });
  });
}

// ─── TYPE TOGGLE ─────────────────────────────────────────────
function initTypeToggle() {
  const placeholders = {
    ar:     'Ticker argentino (ej: GGAL, AL30, S31O3)',
    global: 'Ticker global (ej: AAPL, MSFT, BRK-B)',
    crypto: 'Cripto (ej: BTC, ETH, SOL)'
  };
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeType = btn.dataset.type;
      el('tickerInput').placeholder = placeholders[activeType];
    });
  });
}

// ─── INIT ─────────────────────────────────────────────────────
async function init() {
  loadPositions();
  initRangeButtons();
  initTypeToggle();

  el('addBtn').addEventListener('click', handleAdd);
  el('tickerInput').addEventListener('keydown', e => { if (e.key === 'Enter') handleAdd(); });

  setInterval(updateClocks, 1000);
  updateClocks();

  // Load macro + prices
  await refresh(false);
  scheduleRefresh();
}

document.addEventListener('DOMContentLoaded', init);
