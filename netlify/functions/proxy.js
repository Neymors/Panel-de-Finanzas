'use strict';

const ALLOWED_ORIGINS = [
  'rava.com',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'api.coingecko.com',
  'dolarapi.com',
  'api.bluelytics.com.ar',
  'api.argentinadatos.com',
  'restcountries.com',
  'api.exchangerate-api.com',
];

const TIMEOUT_MS = 12000;

function isAllowed(url) {
  try {
    const { hostname } = new URL(url);
    return ALLOWED_ORIGINS.some(o => hostname === o || hostname.endsWith('.' + o));
  } catch {
    return false;
  }
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const params = event.queryStringParameters || {};
  const targetUrl = params.url;

  if (!targetUrl) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing url parameter' }) };
  }

  let decoded;
  try {
    decoded = decodeURIComponent(targetUrl);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid url encoding' }) };
  }

  if (!isAllowed(decoded)) {
    let hostname = decoded;
    try { hostname = new URL(decoded).hostname; } catch {}
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: `Domain not allowed: ${hostname}` }),
    };
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(decoded, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PortfolioDashboard/1.0)',
        'Accept': 'application/json, text/html, */*',
      },
    });
    clearTimeout(tid);

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers,
        body: JSON.stringify({ error: `Upstream HTTP ${res.status}`, url: decoded }),
      };
    }

    const contentType = res.headers.get('content-type') || '';
    let body;

    if (contentType.includes('application/json')) {
      const json = await res.json();
      body = JSON.stringify(json);
    } else {
      const text = await res.text();
      try {
        JSON.parse(text);
        body = text;
      } catch {
        body = JSON.stringify({ raw: text });
      }
    }

    return { statusCode: 200, headers, body };

  } catch (err) {
    clearTimeout(tid);

    if (err.name === 'AbortError') {
      return {
        statusCode: 504,
        headers,
        body: JSON.stringify({ error: 'Upstream timeout', url: decoded }),
      };
    }

    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message || 'Proxy error', url: decoded }),
    };
  }
};
