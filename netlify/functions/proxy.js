/* ============================================================
   NETLIFY FUNCTION — netlify/functions/proxy.js
   Server-side proxy para evitar CORS en APIs financieras.
   Endpoint: /api/proxy?url=<encoded_url>
   ============================================================ */

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

exports.handler = async function(event) {
  // CORS headers for browser
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const targetUrl = (event.queryStringParameters || {}).url;

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
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: `Domain not allowed: ${new URL(decoded).hostname}` })
    };
  }

  // Abort controller for timeout
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(decoded, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PortfolioDashboard/1.0)',
        'Accept':     'application/json, text/html, */*',
      }
    });
    clearTimeout(tid);

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers,
        body: JSON.stringify({ error: `Upstream HTTP ${res.status}`, url: decoded })
      };
    }

    const contentType = res.headers.get('content-type') || '';
    let body;

    if (contentType.includes('application/json')) {
      const json = await res.json();
      body = JSON.stringify(json);
    } else {
      // Try to parse as JSON anyway (some APIs return wrong content-type)
      const text = await res.text();
      try {
        JSON.parse(text); // validate
        body = text;
      } catch {
        // Return as plain text wrapped in JSON
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
        body: JSON.stringify({ error: 'Upstream timeout', url: decoded })
      };
    }

    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message || 'Proxy error', url: decoded })
    };
  }
};