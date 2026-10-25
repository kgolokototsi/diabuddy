// DiaBuddy Dexcom relay – a Cloudflare Worker.
//
// Logs into Dexcom Share with his Dexcom account (stored as Worker secrets) and
// returns only the latest glucose reading, to callers holding the family key.
// Dexcom Share is the API the Dexcom follow feature uses. Dexcom does not
// officially support third-party use of it, so it can change without notice.
//
// Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   DEXCOM_USERNAME  his Dexcom account username/email (the one his Dexcom app uses)
//   DEXCOM_PASSWORD  that account's password
//   FAMILY_KEY       the key from DiaBuddy → Settings → Dexcom readings
// Plain variables:
//   DEXCOM_REGION    "ous" (outside the US – South Africa), "us" or "jp". Default "ous".
//   ALLOWED_ORIGIN   https://kgolokototsi.github.io

const SERVERS = {
  us: 'https://share2.dexcom.com/ShareWebServices/Services',
  ous: 'https://shareous1.dexcom.com/ShareWebServices/Services',
  jp: 'https://share.dexcom.jp/ShareWebServices/Services',
};
const APP_IDS = {
  us: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
  ous: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
  jp: 'd8665ade-9673-4e27-9ff6-92db4ce13d13',
};
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const MGDL_PER_MMOL = 18.0182;

// Survives between requests while the Worker instance stays warm.
let session = null;

async function dexcomPost(env, path, body) {
  const region = SERVERS[env.DEXCOM_REGION] ? env.DEXCOM_REGION : 'ous';
  const res = await fetch(`${SERVERS[region]}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'DiaBuddy relay' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data?.Message || `Dexcom returned ${res.status}`);
    err.code = data?.Code || `HTTP_${res.status}`;
    throw err;
  }
  return data;
}

async function login(env) {
  const region = APP_IDS[env.DEXCOM_REGION] ? env.DEXCOM_REGION : 'ous';
  const applicationId = APP_IDS[region];
  const accountId = await dexcomPost(env, '/General/AuthenticatePublisherAccount', {
    accountName: env.DEXCOM_USERNAME,
    password: env.DEXCOM_PASSWORD,
    applicationId,
  });
  if (!accountId || accountId === ZERO_ID) throw Object.assign(new Error('Dexcom login failed'), { code: 'AccountPasswordInvalid' });
  const sessionId = await dexcomPost(env, '/General/LoginPublisherAccountById', {
    accountId,
    password: env.DEXCOM_PASSWORD,
    applicationId,
  });
  if (!sessionId || sessionId === ZERO_ID) throw Object.assign(new Error('Dexcom session failed'), { code: 'SessionNotValid' });
  return sessionId;
}

async function readLatest(env, count) {
  const read = (sid) => dexcomPost(env, `/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${encodeURIComponent(sid)}&minutes=1440&maxCount=${count}`);
  if (!session) session = await login(env);
  try {
    return await read(session);
  } catch (err) {
    if (!/Session/i.test(err.code || '')) throw err;
    session = await login(env); // expired session: log in again once
    return read(session);
  }
}

const TRENDS = {
  DoubleUp: { arrow: '⇈', text: 'rising fast', fast: true },
  SingleUp: { arrow: '↑', text: 'rising', fast: false },
  FortyFiveUp: { arrow: '↗', text: 'rising slowly', fast: false },
  Flat: { arrow: '→', text: 'steady', fast: false },
  FortyFiveDown: { arrow: '↘', text: 'falling slowly', fast: false },
  SingleDown: { arrow: '↓', text: 'falling', fast: false },
  DoubleDown: { arrow: '⇊', text: 'falling fast', fast: true },
};

function toReading(v, now = Date.now()) {
  const time = Number(/\d+/.exec(v.WT || v.ST || '')?.[0]);
  const mgdl = Number(v.Value);
  const trendKey = typeof v.Trend === 'number'
    ? [null, 'DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat', 'FortyFiveDown', 'SingleDown', 'DoubleDown'][v.Trend]
    : v.Trend;
  const trend = TRENDS[trendKey] || { arrow: '', text: 'no trend', fast: false };
  return {
    mgdl,
    mmol: Math.round((mgdl / MGDL_PER_MMOL) * 10) / 10,
    low: mgdl <= 39, // Dexcom shows LOW
    high: mgdl >= 401, // Dexcom shows HIGH
    trend: trendKey || null,
    arrow: trend.arrow,
    trendText: trend.text,
    fast: trend.fast,
    time: new Date(time).toISOString(),
    ageMinutes: Math.max(0, Math.round((now - time) / 60000)),
  };
}

// Constant-time comparison so the key can't be guessed byte by byte from timing.
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = [env.ALLOWED_ORIGIN || 'https://kgolokototsi.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-DiaBuddy-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname !== '/latest' || request.method !== 'GET') return json({ error: 'not_found' }, 404, cors);
    if (!env.FAMILY_KEY || !env.DEXCOM_USERNAME || !env.DEXCOM_PASSWORD) return json({ error: 'not_configured' }, 500, cors);
    if (!safeEqual(request.headers.get('X-DiaBuddy-Key') || '', env.FAMILY_KEY)) return json({ error: 'bad_key' }, 401, cors);

    const count = Math.min(12, Math.max(1, Number(url.searchParams.get('count')) || 1));
    try {
      const values = await readLatest(env, count);
      if (!Array.isArray(values) || !values.length) return json({ error: 'no_readings' }, 404, cors);
      const now = Date.now();
      return json({ readings: values.map((v) => toReading(v, now)) }, 200, cors);
    } catch (err) {
      session = null;
      const badLogin = /AccountPassword|AccountNotFound|SSO_Authenticate/i.test(err.code || '');
      return json({ error: badLogin ? 'dexcom_login_failed' : 'dexcom_unavailable', detail: err.code || null }, 502, cors);
    }
  },
};
