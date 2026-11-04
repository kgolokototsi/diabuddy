// DiaBuddy glucose relay – a Cloudflare Worker.
//
// Reads his latest glucose from Dexcom Share and/or LibreLinkUp (whichever are
// set up), and returns the newest reading to callers holding the family key.
// Both are the services behind the Dexcom and Libre follow apps. Neither company
// officially supports third-party use of them, so they can change without notice.
//
// Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   FAMILY_KEY       the key from the DiaBuddy family link
//   TV_KEY           optional second key for the home-screen TV app, so it can be revoked without
//                    touching the family phones
//   DEXCOM_USERNAME  his Dexcom account username/email (the one his Dexcom app uses)
//   DEXCOM_PASSWORD  that account's password
//   LIBRE_EMAIL      a LibreLinkUp follower account that his LibreLink app shares with
//   LIBRE_PASSWORD   that follower account's password
//   ANTHROPIC_API_KEY optional; turns on "Photo of label" (reads nutrition tables with Claude)
//   ANTHROPIC_WORKSPACE_ID only needed if that key isn't scoped to a workspace (wrkspc_…)
// Plain variables:
//   DEXCOM_REGION    "ous" (outside the US – South Africa), "us" or "jp". Default "ous".
//   ALLOWED_ORIGIN   https://kgolokototsi.github.io

import Anthropic from '@anthropic-ai/sdk';
import { readLabel } from './label.js';
import { authenticate, can, createInvite, enroll, listDevices, removeDevice, turnOffLegacy, legacyActive, ROLES, sha256Hex } from './auth.js';
import { readSettings, settingsHistory, writeSettings } from './settings.js';

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
  const read = (sid) => dexcomPost(env, `/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${encodeURIComponent(sid)}&minutes=1440&maxCount=13`);
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
    const when = (x) => Number(/\d+/.exec(x.WT || x.ST || '')?.[0]);
    const history = values.map((x) => ({ mgdl: Number(x.Value), time: when(x) }));
    return { source: 'dexcom', mgdl: Number(v.Value), time: when(v), trend, history };
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
    const point = (x) => ({ mgdl: Number(x.ValueInMgPerDl ?? x.Value), time: parseLibreTime(x.FactoryTimestamp || x.Timestamp) });
    // History comes from the graph; if that fails we still have the latest reading.
    let history = [];
    try {
      const graph = await libreRequest(libre.base, `/llu/connections/${encodeURIComponent(people[0].patientId)}/graph`, { token: libre.token, accountId: libre.accountId });
      history = (graph?.data?.graphData || []).map(point);
    } catch {}
    return { source: 'libre', ...point(g), trend: LIBRE_TRENDS[g.TrendArrow] || null, history: [...history, point(g)] };
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


function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  // file:// and null are what a Tizen TV app sends; the key, not the origin, is what protects the data.
  const allowed = [env.ALLOWED_ORIGIN || 'https://kgolokototsi.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765', 'file://', 'null'];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'X-DiaBuddy-Key, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// Every API response: no caching, no sniffing, no referrer, HTTPS only.
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, ...SECURITY_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------- reading + minute log

function setUpSources(env) {
  const sources = [];
  if (env.DEXCOM_USERNAME && env.DEXCOM_PASSWORD) sources.push(['dexcom', dexcomLatest]);
  if (env.LIBRE_EMAIL && env.LIBRE_PASSWORD) sources.push(['libre', libreLatest]);
  return sources;
}

// Ask every set-up sensor at once; newest reading first.
async function readSensors(env) {
  const sources = setUpSources(env);
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
  readings.sort((a, b) => b.time - a.time);
  return { readings, status };
}

// The sensors only hand out their newest reading (Libre's history is every 15 minutes),
// so a scheduled job stores each new one in KV: one key per UTC day, kept 120 days.
// That history is what meals and doses get matched against later.
const GLUCOSE_TTL_S = 120 * 24 * 3600;
const dayKey = (ms) => `glucose:${new Date(ms).toISOString().slice(0, 10)}`;

async function recordReadings(env, readings, now = Date.now()) {
  if (!env.LOG || !readings.length) return;
  const byDay = new Map();
  for (const { source, mgdl, time } of readings) {
    const key = dayKey(time);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ source, mgdl, time });
  }
  for (const [key, fresh] of byDay) {
    const log = (await env.LOG.get(key, 'json')) || [];
    const known = new Set(log.map((p) => `${p.source}|${p.time}`));
    const add = fresh.filter((p) => !known.has(`${p.source}|${p.time}`) && now - p.time < GLUCOSE_TTL_S * 1000);
    if (!add.length) continue;
    await env.LOG.put(key, JSON.stringify([...log, ...add].sort((a, b) => a.time - b.time)), { expirationTtl: GLUCOSE_TTL_S });
  }
}

// The last hour's logged points for one sensor, or for every sensor when source is null.
async function loggedPoints(env, source, now = Date.now()) {
  if (!env.LOG) return [];
  try {
    const days = [...new Set([dayKey(now - 60 * 60000), dayKey(now)])];
    const logs = await Promise.all(days.map((k) => env.LOG.get(k, 'json')));
    return logs.flat().filter((p) => p && (source == null || p.source === source));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- meal & dose log

// One KV key per entry (event:<ISO time>:<id>), so two phones saving at once can't
// overwrite each other. Kept a year.
const EVENT_TTL_S = 365 * 24 * 3600;
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

function cleanEvent(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return null;
  const at = Date.parse(body.at);
  if (!Number.isFinite(at) || at > now + 5 * 60000 || at < now - 30 * 24 * 3600e3) return null;
  const type = ['dose', 'low-treatment', 'correction'].includes(body.type) ? body.type : null;
  if (!type) return null;
  const foods = Array.isArray(body.foods) ? body.foods.slice(0, 40).map((f) => ({
    name: str(f?.name, 80) || 'Food',
    servings: num(f?.servings, 0, 50),
    carbs: num(f?.carbs, 0, 500),
    source: str(f?.source, 20),
  })) : [];
  return {
    id: /^[a-z0-9]{6,20}$/.test(body.id) ? body.id : Math.random().toString(36).slice(2, 12),
    at: new Date(at).toISOString(),
    type,
    carbs: num(body.carbs, 0, 1000),
    foods,
    bg: num(body.bg, 0, 40),
    bgSource: ['typed', 'libre', 'dexcom'].includes(body.bgSource) ? body.bgSource : null,
    insulinGiven: num(body.insulinGiven, 0, 50),
    calculated: body.calculated && typeof body.calculated === 'object' ? {
      rounded: num(body.calculated.rounded, 0, 50),
      exact: num(body.calculated.exact, 0, 50),
      food: num(body.calculated.food, 0, 50),
      correction: num(body.calculated.correction, -50, 50),
    } : null,
    recentInsulin: body.recentInsulin === true,
    settings: body.settings && typeof body.settings === 'object' ? {
      icr: num(body.settings.icr, 0, 500), cf: num(body.settings.cf, 0, 100), targetBg: num(body.settings.targetBg, 0, 40),
    } : null,
    note: str(body.note, 200),
    device: str(body.device, 40),
    savedAt: new Date(now).toISOString(),
  };
}

const eventKey = (e) => `event:${e.at}:${e.id}`;

async function listEvents(env, days) {
  const since = new Date(Date.now() - days * 24 * 3600e3).toISOString();
  const keys = [];
  let cursor;
  do {
    const page = await env.LOG.list({ prefix: 'event:', cursor });
    keys.push(...page.keys.map((k) => k.name).filter((name) => name.slice(6) >= since));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const events = await Promise.all(keys.map((k) => env.LOG.get(k, 'json')));
  return events.filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1));
}

async function handleEvents(request, env, url, cors, canWrite) {
  if (!env.LOG) return json({ error: 'log_unavailable' }, 503, cors);

  if (request.method === 'GET') {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
    return json({ events: await listEvents(env, days) }, 200, cors);
  }
  if (!canWrite) return json({ error: 'read_only_key' }, 403, cors);

  if (request.method === 'POST') {
    const text = await request.text();
    if (text.length > 16000) return json({ error: 'too_large' }, 413, cors);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'bad_json' }, 400, cors); }
    const event = cleanEvent(body);
    if (!event) return json({ error: 'bad_event' }, 400, cors);
    await env.LOG.put(eventKey(event), JSON.stringify(event), { expirationTtl: EVENT_TTL_S });
    return json({ event }, 201, cors);
  }

  if (request.method === 'DELETE') {
    const id = url.pathname.split('/')[2] || '';
    if (!/^[a-z0-9]{6,20}$/.test(id)) return json({ error: 'bad_id' }, 400, cors);
    const match = (await listEvents(env, 31)).find((e) => e.id === id);
    if (!match) return json({ error: 'not_found' }, 404, cors);
    await env.LOG.delete(eventKey(match));
    return json({ deleted: id }, 200, cors);
  }
  return json({ error: 'not_found' }, 404, cors);
}

// ---------------------------------------------------------------- label photos

const SCANS_PER_DAY = 60; // keeps a leaked family link from running up the API bill
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

async function handleScan(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'scan_not_configured' }, 503, cors);
  const text = await request.text();
  if (text.length > 7_000_000) return json({ error: 'photo_too_large' }, 413, cors);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'bad_json' }, 400, cors); }
  if (typeof body.image !== 'string' || !body.image || !IMAGE_TYPES.includes(body.mediaType)) return json({ error: 'bad_photo' }, 400, cors);

  if (env.LOG) {
    const key = `scans:${new Date().toISOString().slice(0, 10)}`;
    const used = Number(await env.LOG.get(key)) || 0;
    if (used >= SCANS_PER_DAY) return json({ error: 'scan_limit' }, 429, cors);
    await env.LOG.put(key, String(used + 1), { expirationTtl: 3 * 24 * 3600 });
  }

  try {
    const label = await readLabel(env, { image: body.image, mediaType: body.mediaType });
    return json({ label }, 200, cors);
  } catch (err) {
    if (err.code) return json({ error: err.code }, 422, cors);
    // Visible only in the Cloudflare log (wrangler tail), never sent to phones.
    console.error('label scan failed', err.status, err.message);
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return json({ error: 'scan_bad_api_key' }, 502, cors);
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'scan_busy' }, 503, cors);
    // A 400 can be about the key's set-up (e.g. not in a workspace) rather than the photo.
    if (err instanceof Anthropic.BadRequestError) return json({ error: /api key|workspace/i.test(err.message) ? 'scan_bad_api_key' : 'bad_photo' }, 400, cors);
    return json({ error: 'scan_unavailable' }, 502, cors);
  }
}

// ---------------------------------------------------------------- shared family foods

// Foods any family phone can add (label photos, home recipes). One key per food.
function cleanFood(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return null;
  const name = str(body.name, 80)?.trim();
  const label = str(body.serving?.label, 60)?.trim();
  const netCarbs = num(body.netCarbs, 0, 500);
  if (!name || !label || netCarbs == null) return null;
  const grams = num(body.serving?.grams, 0.1, 5000);
  return {
    id: /^fam-[a-z0-9-]{3,60}$/.test(body.id) ? body.id : `fam-${Math.random().toString(36).slice(2, 12)}`,
    name,
    category: str(body.category, 40) || 'Snacks',
    serving: { label, grams },
    netCarbs,
    per100g: num(body.per100g, 0, 100),
    note: str(body.note, 200),
    barcode: /^\d{8,14}$/.test(body.barcode || '') ? body.barcode : null,
    fromPhoto: body.fromPhoto === true,
    addedBy: str(body.addedBy, 40),
    addedAt: new Date(now).toISOString(),
  };
}

async function handleFoods(request, env, url, cors, canWrite) {
  if (!env.LOG) return json({ error: 'log_unavailable' }, 503, cors);
  if (request.method === 'GET') {
    const keys = [];
    let cursor;
    do {
      const page = await env.LOG.list({ prefix: 'food:', cursor });
      keys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    const foods = (await Promise.all(keys.map((k) => env.LOG.get(k, 'json')))).filter(Boolean);
    return json({ foods: foods.sort((a, b) => a.name.localeCompare(b.name)) }, 200, cors);
  }
  if (!canWrite) return json({ error: 'read_only_key' }, 403, cors);
  if (request.method === 'POST') {
    const text = await request.text();
    if (text.length > 8000) return json({ error: 'too_large' }, 413, cors);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'bad_json' }, 400, cors); }
    const food = cleanFood(body);
    if (!food) return json({ error: 'bad_food' }, 400, cors);
    await env.LOG.put(`food:${food.id}`, JSON.stringify(food));
    return json({ food }, 201, cors);
  }
  if (request.method === 'DELETE') {
    const id = url.pathname.split('/')[2] || '';
    if (!/^fam-[a-z0-9-]{3,60}$/.test(id)) return json({ error: 'bad_id' }, 400, cors);
    await env.LOG.delete(`food:${id}`);
    return json({ deleted: id }, 200, cors);
  }
  return json({ error: 'not_found' }, 404, cors);
}

// ---------------------------------------------------------------- data deletion (POPIA)

// Deletes stored readings and/or log entries. KV allows 1,000 deletes a day on the free
// plan, so a large purge may need running again; the reply says how many are left.
async function purge(env, what) {
  const prefixes = { glucose: ['glucose:'], events: ['event:'], all: ['glucose:', 'event:', 'settings-history:', 'scans:'] }[what];
  if (!prefixes) return null;
  let deleted = 0;
  let remaining = 0;
  for (const prefix of prefixes) {
    let cursor;
    do {
      const page = await env.LOG.list({ prefix, cursor });
      for (const k of page.keys) {
        if (deleted < 900) { await env.LOG.delete(k.name); deleted++; } else remaining++;
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }
  return { deleted, remaining };
}

// ---------------------------------------------------------------- rate limits

// Cloudflare's rate-limit bindings (wrangler.toml). Limits are per location and
// approximate, which is enough to stop scripted abuse. Missing in tests: no limit.
async function limited(binding, key) {
  if (!binding) return false;
  try {
    const { success } = await binding.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

const ipTag = async (request) => (await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown')).slice(0, 10);

// ---------------------------------------------------------------- entry point

const API_PATHS = ['/latest', '/events', '/foods', '/scan-label', '/settings', '/me', '/enroll', '/invites', '/devices', '/erase', '/legacy-off'];
const isApi = (path) => API_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

async function readJson(request, maxChars = 8000) {
  const text = await request.text();
  if (text.length > maxChars) return { tooLarge: true };
  try { return { body: JSON.parse(text) }; } catch { return { bad: true }; }
}

async function latest(env, cors) {
  if (!setUpSources(env).length) return json({ error: 'not_configured' }, 500, cors);
  const { readings, status } = await readSensors(env);
  const now = Date.now();
  if (!readings.length) {
    // No sensor answered: still send what the scheduled job logged, so the app can
    // show the trend up to the gap.
    const logged = await loggedPoints(env, null, now);
    const newest = logged.reduce((a, p) => (!a || p.time > a.time ? p : a), null);
    const first = Object.entries(status)[0];
    return json({ error: `${first[0]}_${first[1]}`, sources: status, history: lastHour(newest ? logged.filter((p) => p.source === newest.source) : [], now) }, 502, cors);
  }
  // The newest sensor's readings, plus what the scheduled job logged.
  const points = [...(readings[0].history || []), ...(await loggedPoints(env, readings[0].source, now))];
  return json({ readings: readings.map(({ history: _h, ...r }) => toReading(r, now)), history: lastHour(points, now), sources: status }, 200, cors);
}

// Readings from the last hour, oldest first, in mmol/L. Points under 30 s apart are one reading.
function lastHour(points, now) {
  return points
    .filter((p) => Number.isFinite(p.mgdl) && Number.isFinite(p.time) && now - p.time <= 60 * 60000)
    .sort((a, b) => a.time - b.time)
    .filter((p, i, all) => i === 0 || p.time - all[i - 1].time >= 30000)
    .map((p) => ({ mmol: Math.round((p.mgdl / MGDL_PER_MMOL) * 10) / 10, time: new Date(p.time).toISOString() }));
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...SECURITY_HEADERS } });

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    // Anything that isn't the API is the app itself (static files, served before this code runs).
    if (!isApi(path)) return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'not_found' }, 404, cors);

    // Joining with an invite is the only call that doesn't need a phone key.
    if (path === '/enroll' && method === 'POST') {
      if (!env.LOG) return json({ error: 'log_unavailable' }, 503, cors);
      if (await limited(env.RL_ENROLL, await ipTag(request))) return json({ error: 'rate_limited' }, 429, cors);
      const { body, bad, tooLarge } = await readJson(request, 1000);
      if (bad || tooLarge) return json({ error: 'bad_request' }, 400, cors);
      const result = await enroll(env, body.code, body.deviceName);
      if (!result) {
        console.warn('enroll failed', await ipTag(request));
        return json({ error: 'bad_invite' }, 400, cors);
      }
      const { token, device } = result;
      return json({ token, device: { id: device.id, name: device.name, role: device.role } }, 201, cors);
    }

    const device = await authenticate(request, env, ctx);
    if (!device) {
      console.warn('auth failed', method, path, await ipTag(request));
      return json({ error: 'bad_key' }, 401, cors);
    }
    if (await limited(env.RL_API, device.id)) return json({ error: 'rate_limited' }, 429, cors);
    const denied = () => json({ error: 'read_only_key' }, 403, cors);
    const adminOnly = () => json({ error: 'admin_only' }, 403, cors);

    if (path === '/me' && method === 'GET') {
      return json({ device: { id: device.id, name: device.name, role: device.role, legacy: Boolean(device.legacy) } }, 200, cors);
    }
    if (path === '/latest' && method === 'GET') return latest(env, cors);
    if (path === '/events' || path.startsWith('/events/')) return handleEvents(request, env, url, cors, can(device, 'log'));
    if (path === '/foods' || path.startsWith('/foods/')) return handleFoods(request, env, url, cors, can(device, 'foods'));
    if (path === '/scan-label' && method === 'POST') {
      if (!can(device, 'scan')) return denied();
      if (await limited(env.RL_SCAN, device.id)) return json({ error: 'scan_limit' }, 429, cors);
      return handleScan(request, env, cors);
    }

    if (!env.LOG) return json({ error: 'log_unavailable' }, 503, cors);

    if (path === '/settings' && method === 'GET') {
      if (url.searchParams.get('history')) return json({ history: await settingsHistory(env) }, 200, cors);
      return json({ settings: await readSettings(env) }, 200, cors);
    }
    if (path === '/settings' && method === 'PUT') {
      if (!can(device, 'admin')) return adminOnly();
      const { body, bad, tooLarge } = await readJson(request);
      if (bad || tooLarge) return json({ error: 'bad_request' }, 400, cors);
      const result = await writeSettings(env, body, device);
      return result.error ? json({ error: result.error }, 400, cors) : json(result, 200, cors);
    }

    // A phone may always remove itself; removing others is for the admin.
    if (path.startsWith('/devices/') && method === 'DELETE') {
      const id = path.split('/')[2] || '';
      if (id !== device.id && !can(device, 'admin')) return adminOnly();
      if (!/^dev-[a-z0-9]{3,20}$/.test(id)) return json({ error: 'bad_id' }, 400, cors);
      return (await removeDevice(env, id)) ? json({ removed: id }, 200, cors) : json({ error: 'not_found' }, 404, cors);
    }

    if (!can(device, 'admin')) return adminOnly();

    if (path === '/devices' && method === 'GET') {
      const devices = (await listDevices(env)).map(({ hash, ...d }) => ({ ...d, current: hash === device.hash }));
      return json({ devices, legacyActive: await legacyActive(env) }, 200, cors);
    }
    if (path === '/invites' && method === 'POST') {
      const { body, bad } = await readJson(request, 1000);
      if (bad || !ROLES.includes(body.role)) return json({ error: 'bad_request' }, 400, cors);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
      return json(await createInvite(env, { role: body.role, name, by: device.name }), 201, cors);
    }
    if (path === '/legacy-off' && method === 'POST') {
      await turnOffLegacy(env);
      return json({ legacyActive: false }, 200, cors);
    }
    if (path === '/erase' && method === 'POST') {
      const { body, bad } = await readJson(request, 200);
      const result = bad ? null : await purge(env, body.what);
      return result ? json(result, 200, cors) : json({ error: 'bad_request' }, 400, cors);
    }
    return json({ error: 'not_found' }, 404, cors);
  },

  // Cron trigger (wrangler.toml): log each new reading so we have every minute.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(readSensors(env).then(({ readings }) => recordReadings(env, readings)).catch(() => {}));
  },
};
