/* ============================================================
   PORTFOLIO DASHBOARD — script.js (CORREGIDO)
   Fuentes: Rava (AR), Yahoo Finance (Global), CoinGecko (Crypto)
   Validación de Tickers, Enrutamiento Estricto y Fallback 404
   ============================================================ */

'use strict';

// ─── CONSTANTES ───────────────────────────────────────────────
const PROXY = '/api/proxy';
const LS_POSITIONS = 'portfolio_positions_v2';
const LS_PRICES    = 'portfolio_prices_v2';
const LS_HISTORY   = 'portfolio_history_v2';
const LS_MACRO     = 'macroData_v2';
const CACHE_TTL    = 15 * 60 * 1000;   // 15 min
const MACRO_TTL    = 24 * 60 * 60 * 1000; // 24 h

const PIE_COLORS = [
  '#378ADD','#1D9E75','#E8A838','#E05C5C','#8B5CF6',
  '#F472B6','#34D399','#FB923C','#60A5FA','#A78BFA'
];

const COINGECKO_MAP = {
  'BTC': 'bitcoin',
  'ETH': 'ethereum',
  'SOL': 'solana',
  'USDT': 'tether',
  'BNB': 'binancecoin',
  'ADA': 'cardano',
  'DOT': 'polkadot',
  'MATIC': 'matic-network'
};

// ─── ESTADO ───────────────────────────────────────────────────
let positions  = [];   
let priceCache = {};   
let mepRate    = null; 
let activeType = 'ar'; 
let currentRange = '1M';
let portfolioChart = null;
let pieChart = null;

// ─── HELPERS ──────────────────────────────────────────────────
const el = id => document.getElementById(id);

function formatCurrency(val, symbol = '$') {
  if (val === null || isNaN(val)) return '—';
  return symbol + ' ' + val.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPct(val) {
  if (val === null || isNaN(val)) return '—';
  const sign = val >= 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

// ─── PROXY FETCH ──────────────────────────────────────────────
async function fetchViaProxy(url) {
  const res = await fetch(`${PROXY}?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ─── LÓGICA DE FUENTES (CORRECCIÓN 404) ───────────────────────

/**
 * 1. ARGENTINA: Intenta Rava, si falla (404/Error) hace fallback a Yahoo .BA
 */
async function fetchArPrice(ticker) {
  const cleanTicker = ticker.toUpperCase().trim();
  try {
    const url = `https://www.rava.com/servicios/cotizaciones.php?pizarra=${cleanTicker}&formato=JSON`;
    const data = await fetchViaProxy(url);
    
    // Rava devuelve a veces un array o un objeto con prop 'datos'
    const item = Array.isArray(data) ? data[0] : (data.datos ? data.datos[0] : null);
    
    if (!item || (!item.ult && !item.cierre)) throw new Error("Sin datos en Rava");

    const price = parseFloat(item.ult || item.cierre);
    const prev = parseFloat(item.ant || item.precierre || price);
    const changeAbs = price - prev;
    const change = prev !== 0 ? (changeAbs / prev) * 100 : 0;

    return { price, change, changeAbs };
  } catch (err) {
    console.warn(`[RAVA FALLBACK] ${cleanTicker} falló. Reintentando con Yahoo (.BA)...`);
    return await fetchGlobalPrice(`${cleanTicker}.BA`);
  }
}

/**
 * 2. GLOBAL / CEDEAR: Yahoo Finance únicamente
 */
async function fetchGlobalPrice(ticker) {
  const cleanTicker = ticker.toUpperCase().trim();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${cleanTicker}?interval=1d&range=2d`;
  
  const data = await fetchViaProxy(url);
  if (!data.chart?.result?.[0]) throw new Error(`Ticker global no encontrado: ${cleanTicker}`);

  const meta = data.chart.result[0].meta;
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose || price;
  const changeAbs = price - prev;
  const change = prev !== 0 ? (changeAbs / prev) * 100 : 0;

  return { price, change, changeAbs };
}

/**
 * 3. CRYPTO: CoinGecko únicamente
 */
async function fetchCryptoPrice(ticker) {
  const cleanTicker = ticker.toUpperCase().trim();
  const id = COINGECKO_MAP[cleanTicker] || cleanTicker.toLowerCase();
  
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`;
  const data = await fetchViaProxy(url);
  
  if (!data[id]) throw new Error(`Crypto no encontrada: ${id}`);

  const price = data[id].usd;
  const change = data[id].usd_24h_change || 0;
  const changeAbs = (price * change) / 100;

  return { price, change, changeAbs };
}

// ─── MEP RATE ─────────────────────────────────────────────────
async function fetchMep() {
  try {
    const data = await fetchViaProxy('https://dolarapi.com/v1/dolares/bolsa');
    return parseFloat(data.compra);
  } catch {
    return 1000; // Fallback hardcoded si falla la API de dólar
  }
}

// ─── COORDINADOR DE PRECIOS ───────────────────────────────────
async function fetchAllPrices(forceRefresh = false) {
  if (!positions.length) return {};

  const now = Date.now();
  const result = forceRefresh ? {} : { ...priceCache };

  const promises = positions.map(async (p) => {
    // Si ya tenemos precio fresco en caché, saltar
    if (!forceRefresh && result[p.ticker] && (now - result[p.ticker].timestamp < CACHE_TTL)) {
      return;
    }

    try {
      let data;
      // Enrutamiento basado en el tipo guardado en la posición
      if (p.type === 'crypto') {
        data = await fetchCryptoPrice(p.ticker);
      } else if (p.type === 'global') {
        data = await fetchGlobalPrice(p.ticker);
      } else {
        data = await fetchArPrice(p.ticker);
      }

      result[p.ticker] = { ...data, timestamp: now, cached: false };
    } catch (err) {
      console.error(`Error total en ${p.ticker}:`, err);
      // Mantener precio viejo si existe, sino 0
      if (!result[p.ticker]) {
        result[p.ticker] = { price: 0, change: 0, changeAbs: 0, timestamp: now, cached: true };
      }
    }
  });

  await Promise.allSettled(promises);
  priceCache = result;
  localStorage.setItem(LS_PRICES, JSON.stringify(priceCache));
  return result;
}

// ─── GESTIÓN DE POSICIONES ────────────────────────────────────
function loadPositions() {
  const saved = localStorage.getItem(LS_POSITIONS);
  positions = saved ? JSON.parse(saved) : [];
  const savedPrices = localStorage.getItem(LS_PRICES);
  priceCache = savedPrices ? JSON.parse(savedPrices) : {};
}

function savePositions() {
  localStorage.setItem(LS_POSITIONS, JSON.stringify(positions));
}

async function handleAdd() {
  const tInput = el('tickerInput');
  const qInput = el('qtyInput');
  const aInput = el('avgInput');
  const errEl  = el('addError');

  const ticker = tInput.value.toUpperCase().trim();
  const qty    = parseFloat(qInput.value);
  const avg    = parseFloat(aInput.value);

  if (!ticker || isNaN(qty) || isNaN(avg)) {
    errEl.textContent = "Completá todos los campos correctamente.";
    return;
  }
  errEl.textContent = "";

  positions.push({
    ticker,
    type: activeType,
    quantity: qty,
    avgPrice: avg,
    currency: (activeType === 'ar') ? 'ARS' : 'USD'
  });

  savePositions();
  tInput.value = ""; qInput.value = ""; aInput.value = "";
  await refreshUI(true);
}

function deletePosition(index) {
  positions.splice(index, 1);
  savePositions();
  refreshUI();
}

// ─── UI RENDERING ─────────────────────────────────────────────
async function refreshUI(forceFetch = false) {
  mepRate = await fetchMep();
  el('sourceRow').innerHTML = `Dólar MEP: <strong>${formatCurrency(mepRate)}</strong>`;
  
  const prices = await fetchAllPrices(forceFetch);
  renderAll(prices);
}

function renderAll(prices) {
  const tbody = el('posTable');
  tbody.innerHTML = "";

  let totalPortfolioUSD = 0;
  let totalInvestmentUSD = 0;

  positions.forEach((p, idx) => {
    const data = prices[p.ticker] || { price: 0, change: 0 };
    const currentPrice = data.price;
    
    // Conversiones a USD para totales
    const priceUSD = (p.currency === 'ARS') ? currentPrice / mepRate : currentPrice;
    const avgUSD   = (p.currency === 'ARS') ? p.avgPrice / mepRate : p.avgPrice;
    
    const valTotalUSD = priceUSD * p.quantity;
    const costTotalUSD = avgUSD * p.quantity;
    
    totalPortfolioUSD += valTotalUSD;
    totalInvestmentUSD += costTotalUSD;

    const gainAbs = valTotalUSD - costTotalUSD;
    const gainPct = costTotalUSD !== 0 ? (gainAbs / costTotalUSD) * 100 : 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div style="font-weight:bold">${p.ticker}</div>
        <div style="font-size:10px; color:var(--text3)">${p.type.toUpperCase()}</div>
      </td>
      <td>${formatCurrency(currentPrice, p.currency === 'ARS' ? '$' : 'u$s')}</td>
      <td class="${data.change >= 0 ? 'pos' : 'neg'}">${formatPct(data.change)}</td>
      <td>${p.quantity}</td>
      <td>${formatCurrency(p.avgPrice, p.currency === 'ARS' ? '$' : 'u$s')}</td>
      <td>${formatCurrency(valTotalUSD, 'u$s')}</td>
      <td class="${gainAbs >= 0 ? 'pos' : 'neg'}">${formatCurrency(gainAbs, 'u$s')}</td>
      <td class="${gainPct >= 0 ? 'pos' : 'neg'}">${formatPct(gainPct)}</td>
      <td><button class="del-btn" onclick="deletePosition(${idx})">✕</button></td>
    `;
    tbody.appendChild(tr);
  });

  // Totales Header
  const totalGainUSD = totalPortfolioUSD - totalInvestmentUSD;
  const totalGainPct = totalInvestmentUSD !== 0 ? (totalGainUSD / totalInvestmentUSD) * 100 : 0;

  el('totalVal').textContent = formatCurrency(totalPortfolioUSD, 'u$s');
  el('totalGain').textContent = formatCurrency(totalGainUSD, 'u$s');
  el('totalGainPct').textContent = formatPct(totalGainPct);
  el('totalGain').className = 'metric-val ' + (totalGainUSD >= 0 ? 'pos' : 'neg');

  renderPieChart();
}

// ─── CHARTS ───────────────────────────────────────────────────
function renderPieChart() {
  const ctx = el('pieChart').getContext('2d');
  if (pieChart) pieChart.destroy();

  const dataMap = {};
  positions.forEach(p => {
    const data = priceCache[p.ticker];
    const price = data ? data.price : 0;
    const valUSD = (p.currency === 'ARS') ? (price * p.quantity) / mepRate : (price * p.quantity);
    dataMap[p.ticker] = (dataMap[p.ticker] || 0) + valUSD;
  });

  const labels = Object.keys(dataMap);
  const values = Object.values(dataMap);

  pieChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: PIE_COLORS,
        borderWidth: 0
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      cutout: '70%'
    }
  });
}

// ─── INIT ─────────────────────────────────────────────────────
async function init() {
  loadPositions();
  
  // Toggle de tipos
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeType = btn.dataset.type;
      const ph = { ar: 'Ticker (ej: AL30, GGAL)', global: 'Ticker (ej: AAPL, XLV)', crypto: 'Cripto (ej: BTC, SOL)' };
      el('tickerInput').placeholder = ph[activeType];
    });
  });

  el('addBtn').addEventListener('click', handleAdd);
  
  // Refresh inicial
  await refreshUI();

  // Relojes
  setInterval(() => {
    const opt = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    el('clockAR').textContent = 'BA: ' + new Intl.DateTimeFormat('es-AR', { ...opt, timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
    el('clockNY').textContent = 'NY: ' + new Intl.DateTimeFormat('en-US', { ...opt, timeZone: 'America/New_York' }).format(new Date());
  }, 1000);
}

init();
