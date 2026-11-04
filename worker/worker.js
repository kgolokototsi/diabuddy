// DiaBuddy glucose relay – a Cloudflare Worker.
//
// Reads his latest glucose from Dexcom Share and/or LibreLinkUp (whichever are
// set up), and returns the newest reading to callers holding the family key.
// Both are the services behind the Dexcom and Libre follow apps. Neither company
// officially supports third-party use of them, so they can change without notice.
//
// Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   FAMILY_KEY       the key from the DiaBuddy family link
//   DEXCOM_USERNAME  his Dexcom account username/email (the one his Dexcom app uses)
//   DEXCOM_PASSWORD  that account's password
//   LIBRE_EMAIL      a LibreLinkUp follower account that his LibreLink app shares with
//   LIBRE_PASSWORD   that follower account's password
// Plain variables:
//   DEXCOM_REGION    "ous" (outside the US – South Africa), "us" or "jp". Default "ous".
//   ALLOWED_ORIGIN   https://kgolokototsi.github.io

const MGDL_PER_MMOL = 18.0182;

// ---------------------------------------------------------------- Dexcom Share

const DEXCOM_SERVERS = {
  us: 'https://share2.dexcom.com/ShareWebServices/Services',
  ous: 'https://shareous1.dexcom.com/ShareWebServices/Services',
  jp: 'https://share.dexcom.jp/ShareWebServices/Services',
};
const DEXCOM_APP_IDS = {
  us: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
  ous: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
  jp: 'd8665ade-9673-4e27-9ff6-92db4ce13d13',
};
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const DEXCOM_TRENDS = [null, 'DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat', 'FortyFiveDown', 'SingleDown', 'DoubleDown'];

// Survives between requests while the Worker instance stays warm.
let dexcomSession = null;

const dexcomRegion = (env) => (DEXCOM_SERVERS[env.DEXCOM_REGION] ? env.DEXCOM_REGION : 'ous');

async function dexcomPost(env, path, body) {
  const res = await fetch(`${DEXCOM_SERVERS[dexcomRegion(env)]}${path}`, {
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

async function dexcomLogin(env) {
  const applicationId = DEXCOM_APP_IDS[dexcomRegion(env)];
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

async function dexcomLatest(env) {
  const read = (sid) => dexcomPost(env, `/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${encodeURIComponent(sid)}&minutes=1440&maxCount=1`);
  try {
    if (!dexcomSession) dexcomSession = await dexcomLogin(env);
    let values;
    try {
      values = await read(dexcomSession);
    } catch (err) {
      if (!/Session/i.test(err.code || '')) throw err;
      dexcomSession = await dexcomLogin(env); // expired session: log in again once
      values = await read(dexcomSession);
    }
    const v = Array.isArray(values) ? values[0] : null;
    if (!v) throw Object.assign(new Error('No Dexcom readings'), { code: 'no_readings' });
    const trend = typeof v.Trend === 'number' ? DEXCOM_TRENDS[v.Trend] : v.Trend;
    return { source: 'dexcom', mgdl: Number(v.Value), time: Number(/\d+/.exec(v.WT || v.ST || '')?.[0]), trend };
  } catch (err) {
    dexcomSession = null;
    const badLogin = /AccountPassword|AccountNotFound|SSO_Authenticate/i.test(err.code || '');
    throw Object.assign(err, { code: badLogin ? 'login_failed' : err.code === 'no_readings' ? 'no_readings' : 'unavailable' });
  }
}

// ---------------------------------------------------------------- LibreLinkUp

const LIBRE_BASE = 'https://api.libreview.io';
// LibreLinkUp rejects old app versions; if it names a newer minimum we retry with that.
let libreVersion = '4.16.0';
let libre = null; // { base, token, accountId, expires, patientId }

// LibreLinkUp trend arrows: 1 falling fast … 5 rising fast.
const LIBRE_TRENDS = [null, 'DoubleDown', 'FortyFiveDown', 'Flat', 'FortyFiveUp', 'DoubleUp'];

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function libreRequest(base, path, { method = 'GET', body, token, accountId } = {}, retried = false) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    product: 'llu.android',
    version: libreVersion,
    'cache-control': 'no-cache',
    'User-Agent': 'DiaBuddy relay',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (accountId) headers['Account-Id'] = accountId;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  const minimum = data?.data?.minimumVersion;
  if (minimum && !retried && minimum !== libreVersion) {
    libreVersion = minimum;
    return libreRequest(base, path, { method, body, token, accountId }, true);
  }
  if (res.status === 401) throw Object.assign(new Error('LibreLinkUp session expired'), { code: 'session' });
  if (!res.ok) throw Object.assign(new Error(`LibreLinkUp returned ${res.status}`), { code: 'unavailable' });
  return data;
}

async function libreLogin(env) {
  const creds = { email: env.LIBRE_EMAIL, password: env.LIBRE_PASSWORD };
  let base = LIBRE_BASE;
  let res = await libreRequest(base, '/llu/auth/login', { method: 'POST', body: creds });
  if (res?.data?.redirect && res.data.region) {
    base = `https://api-${res.data.region}.libreview.io`;
    res = await libreRequest(base, '/llu/auth/login', { method: 'POST', body: creds });
  }
  if (res?.status === 2) throw Object.assign(new Error('LibreLinkUp login failed'), { code: 'login_failed' });
  if (res?.status === 4 || res?.data?.step) {
    // Terms or a new privacy notice need accepting in the LibreLinkUp app.
    throw Object.assign(new Error('LibreLinkUp needs terms accepted'), { code: 'accept_terms' });
  }
  const ticket = res?.data?.authTicket;
  const userId = res?.data?.user?.id;
  if (!ticket?.token || !userId) throw Object.assign(new Error('Unexpected LibreLinkUp login reply'), { code: 'unavailable' });
  return { base, token: ticket.token, accountId: await sha256Hex(userId), expires: Number(ticket.expires) * 1000 || Date.now() + 3600e3, patientId: null };
}

// "11/4/2026 7:53:12 AM" (FactoryTimestamp is UTC).
function parseLibreTime(text) {
  const m = /(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)(?: ?(AM|PM))?/i.exec(text || '');
  if (!m) return NaN;
  let hour = Number(m[4]) % 12;
  if (!m[7]) hour = Number(m[4]);
  else if (m[7].toUpperCase() === 'PM') hour += 12;
  return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour, Number(m[5]), Number(m[6]));
}

async function libreLatest(env) {
  const connections = async () => {
    if (!libre || Date.now() > libre.expires - 60e3) libre = await libreLogin(env);
    return libreRequest(libre.base, '/llu/connections', { token: libre.token, accountId: libre.accountId });
  };
  try {
    let res;
    try {
      res = await connections();
    } catch (err) {
      if (err.code !== 'session') throw err;
      libre = null; // expired token: log in again once
      res = await connections();
    }
    const people = Array.isArray(res?.data) ? res.data : [];
    if (!people.length) throw Object.assign(new Error('No LibreLinkUp connection'), { code: 'no_connection' });
    const g = people[0].glucoseMeasurement || people[0].glucoseItem;
    if (!g) throw Object.assign(new Error('No Libre readings'), { code: 'no_readings' });
    return {
      source: 'libre',
      mgdl: Number(g.ValueInMgPerDl ?? g.Value),
      time: parseLibreTime(g.FactoryTimestamp || g.Timestamp),
      trend: LIBRE_TRENDS[g.TrendArrow] || null,
    };
  } catch (err) {
    if (err.code !== 'accept_terms' && err.code !== 'login_failed') libre = null;
    throw Object.assign(err, { code: err.code || 'unavailable' });
  }
}

// ---------------------------------------------------------------- shared

const TRENDS = {
  DoubleUp: { arrow: '⇈', text: 'rising fast', fast: true },
  SingleUp: { arrow: '↑', text: 'rising', fast: false },
  FortyFiveUp: { arrow: '↗', text: 'rising slowly', fast: false },
  Flat: { arrow: '→', text: 'steady', fast: false },
  FortyFiveDown: { arrow: '↘', text: 'falling slowly', fast: false },
  SingleDown: { arrow: '↓', text: 'falling', fast: false },
  DoubleDown: { arrow: '⇊', text: 'falling fast', fast: true },
};

function toReading({ source, mgdl, time, trend }, now = Date.now()) {
  const t = TRENDS[trend] || { arrow: '', text: 'no trend', fast: false };
  const limits = source === 'libre' ? [40, 500] : [39, 401]; // sensors show LO/HI beyond these
  return {
    source,
    mgdl,
    mmol: Math.round((mgdl / MGDL_PER_MMOL) * 10) / 10,
    low: mgdl <= limits[0],
    high: mgdl >= limits[1],
    trend: trend || null,
    arrow: t.arrow,
    trendText: t.text,
    fast: t.fast,
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

    const sources = [];
    if (env.DEXCOM_USERNAME && env.DEXCOM_PASSWORD) sources.push(['dexcom', dexcomLatest]);
    if (env.LIBRE_EMAIL && env.LIBRE_PASSWORD) sources.push(['libre', libreLatest]);
    if (!env.FAMILY_KEY || !sources.length) return json({ error: 'not_configured' }, 500, cors);
    if (!safeEqual(request.headers.get('X-DiaBuddy-Key') || '', env.FAMILY_KEY)) return json({ error: 'bad_key' }, 401, cors);

    // Ask every set-up sensor at once and use the newest reading.
    const results = await Promise.allSettled(sources.map(([, read]) => read(env)));
    const status = {};
    const readings = [];
    results.forEach((r, i) => {
      const name = sources[i][0];
      if (r.status === 'fulfilled' && Number.isFinite(r.value.mgdl) && Number.isFinite(r.value.time)) {
        status[name] = 'ok';
        readings.push(r.value);
      } else {
        status[name] = r.reason?.code || 'unavailable';
      }
    });
    if (!readings.length) {
      const first = Object.entries(status)[0];
      return json({ error: `${first[0]}_${first[1]}`, sources: status }, 502, cors);
    }
    const now = Date.now();
    readings.sort((a, b) => b.time - a.time);
    return json({ readings: readings.map((r) => toReading(r, now)), sources: status }, 200, cors);
  },
};
