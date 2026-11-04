import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const ORIGIN = 'https://kgolokototsi.github.io';
const base = { FAMILY_KEY: 'family-key-123', DEXCOM_REGION: 'ous', ALLOWED_ORIGIN: ORIGIN };
const dexEnv = { ...base, DEXCOM_USERNAME: 'kid@example.com', DEXCOM_PASSWORD: 'pw' };
const libreEnv = { ...base, LIBRE_EMAIL: 'follower@example.com', LIBRE_PASSWORD: 'lpw' };
const bothEnv = { ...dexEnv, ...libreEnv };

let calls;
let dexcom;
let libre;
let claude;
let claudeCalls = [];

// "M/D/YYYY h:mm:ss AM" in UTC, like LibreLinkUp's FactoryTimestamp.
function lluTime(ms) {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h % 12 || 12}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
}

// Fake Dexcom Share and LibreLinkUp servers.
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  const reply = (status, data) => new Response(JSON.stringify(data), { status });
  calls.push(`${u.host}${u.pathname}`);

  if (u.host === 'api.anthropic.com') {
    claudeCalls.push(body);
    const jsonReply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (claude.status !== 200) return jsonReply(claude.status, { type: 'error', error: { type: claude.errorType, message: 'x' } });
    return jsonReply(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: claude.stop, stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(claude.label) }], usage: { input_tokens: 1500, output_tokens: 200 } });
  }
  if (u.host === 'shareous1.dexcom.com') {
    if (u.pathname.endsWith('AuthenticatePublisherAccount')) {
      return body.password === dexcom.password ? reply(200, 'acct-1') : reply(500, { Code: 'AccountPasswordInvalid', Message: 'bad' });
    }
    if (u.pathname.endsWith('LoginPublisherAccountById')) return reply(200, `session-${++dexcom.sessions}`);
    if (u.pathname.endsWith('ReadPublisherLatestGlucoseValues')) {
      if (dexcom.expire && u.searchParams.get('sessionId') === 'session-1') return reply(500, { Code: 'SessionIdNotFound' });
      return reply(200, dexcom.values);
    }
  }

  if (u.host.endsWith('libreview.io')) {
    const h = init.headers;
    if (h.version < libre.minimumVersion) return reply(200, { status: 920, data: { minimumVersion: libre.minimumVersion } });
    if (u.pathname === '/llu/auth/login') {
      if (u.host === 'api.libreview.io') return reply(200, { status: 0, data: { redirect: true, region: 'eu' } });
      if (body.password !== libre.password) return reply(200, { status: 2, error: { message: 'bad' } });
      if (libre.terms) return reply(200, { status: 4, data: { step: { componentName: 'tou' } } });
      return reply(200, { status: 0, data: { user: { id: 'user-42' }, authTicket: { token: 'tok', expires: Math.floor(Date.now() / 1000) + 3600 } } });
    }
    if (u.pathname === '/llu/connections') {
      assert.equal(h.Authorization, 'Bearer tok');
      assert.equal(h['Account-Id'], createHash('sha256').update('user-42').digest('hex'));
      return reply(200, { status: 0, data: [{ patientId: 'p1', glucoseMeasurement: libre.measurement }] });
    }
  }
  return reply(404, {});
};

const load = async () => (await import(`../worker/worker.js?${Math.random()}`)).default;
const get = (worker, env, key = env.FAMILY_KEY) =>
  worker.fetch(new Request('https://relay.example/latest', { headers: { Origin: ORIGIN, ...(key && { 'X-DiaBuddy-Key': key }) } }), env);

beforeEach(() => {
  calls = [];
  claudeCalls = [];
  claude = { status: 200, stop: 'end_turn', errorType: null, label: {
    is_nutrition_label: true, product_name: 'Weet-Bix', brand: 'Bokomo', carbs_per_100g: 63, carbs_per_serving: 28.4,
    serving_size_label: '2 biscuits (45 g)', serving_size_grams: 45, carbs_excludes_fibre: true, fibre_per_100g: 11,
    confidence: 'high', notes: '' } };
  const now = Date.now();
  dexcom = { password: 'pw', sessions: 0, expire: false, values: [{ WT: `Date(${now - 3 * 60000})`, Value: 142, Trend: 'FortyFiveUp' }] };
  libre = { password: 'lpw', terms: false, minimumVersion: '4.16.0', measurement: { ValueInMgPerDl: 110, TrendArrow: 3, FactoryTimestamp: lluTime(now - 60000) } };
});

test('wrong or missing key is rejected without calling any sensor', async () => {
  const w = await load();
  assert.equal((await get(w, bothEnv, 'nope')).status, 401);
  assert.equal((await get(w, bothEnv, null)).status, 401);
  assert.deepEqual(calls, []);
});

test('a separate TV key works alongside the family key, and either can be revoked on its own', async () => {
  const w = await load();
  const env = { ...dexEnv, TV_KEY: 'tv-key-456' };
  assert.equal((await get(w, env, 'tv-key-456')).status, 200);
  assert.equal((await get(w, env, 'family-key-123')).status, 200);
  assert.equal((await get(w, { ...env, TV_KEY: undefined }, 'tv-key-456')).status, 401);
  assert.equal((await get(w, { ...env, FAMILY_KEY: undefined }, 'family-key-123')).status, 401);
});

test('a TV app (Origin file://) gets an allow-origin header it can use', async () => {
  const w = await load();
  const res = await w.fetch(new Request('https://relay.example/latest', { headers: { Origin: 'file://', 'X-DiaBuddy-Key': 'family-key-123' } }), dexEnv);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'file://');
});

test('no sensor set up → not_configured', async () => {
  const w = await load();
  assert.equal((await (await get(w, base)).json()).error, 'not_configured');
});

test('Dexcom: latest reading in mmol/L with trend and age', async () => {
  const w = await load();
  const res = await get(w, dexEnv);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const { readings: [r] } = await res.json();
  assert.equal(r.source, 'dexcom');
  assert.equal(r.mmol, 7.9);
  assert.equal(r.arrow, '↗');
  assert.equal(r.ageMinutes, 3);
});

test('Dexcom: expired session triggers one fresh login, then reuses it', async () => {
  const w = await load();
  dexcom.expire = true;
  assert.equal((await get(w, dexEnv)).status, 200);
  calls = [];
  await get(w, dexEnv);
  assert.deepEqual(calls, ['shareous1.dexcom.com/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues']);
});

test('Dexcom: LOW and fast trends are flagged', async () => {
  const w = await load();
  dexcom.values = [{ WT: `Date(${Date.now()})`, Value: 39, Trend: 'DoubleDown' }];
  const { readings: [r] } = await (await get(w, dexEnv)).json();
  assert.equal(r.low, true);
  assert.equal(r.fast, true);
});

test('Dexcom: bad password reports a login failure', async () => {
  const w = await load();
  dexcom.password = 'changed';
  const res = await get(w, dexEnv);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'dexcom_login_failed');
});

test('Libre: follows region redirect, sends hashed Account-Id, parses the reading', async () => {
  const w = await load();
  const res = await get(w, libreEnv);
  assert.equal(res.status, 200);
  const { readings: [r] } = await res.json();
  assert.equal(r.source, 'libre');
  assert.equal(r.mmol, 6.1);
  assert.equal(r.arrow, '→');
  assert.equal(r.ageMinutes, 1);
  assert.ok(calls.includes('api-eu.libreview.io/llu/auth/login'));
});

test('Libre: retries with the minimum app version it asks for', async () => {
  const w = await load();
  libre.minimumVersion = '4.99.0';
  assert.equal((await get(w, libreEnv)).status, 200);
});

test('Libre: rising fast (arrow 5) is flagged; LO below 40 mg/dL', async () => {
  const w = await load();
  libre.measurement = { ...libre.measurement, ValueInMgPerDl: 38, TrendArrow: 5 };
  const { readings: [r] } = await (await get(w, libreEnv)).json();
  assert.equal(r.fast, true);
  assert.equal(r.arrow, '⇈');
  assert.equal(r.low, true);
});

test('Libre: terms prompt and bad password give clear errors', async () => {
  let w = await load();
  libre.terms = true;
  assert.equal((await (await get(w, libreEnv)).json()).error, 'libre_accept_terms');
  w = await load();
  libre.terms = false;
  libre.password = 'nope';
  assert.equal((await (await get(w, libreEnv)).json()).error, 'libre_login_failed');
});

test('Both: the newest reading wins, and one failing sensor does not block the other', async () => {
  const w = await load();
  let body = await (await get(w, bothEnv)).json();
  assert.equal(body.readings[0].source, 'libre'); // 1 min old beats Dexcom's 3 min
  assert.deepEqual(body.sources, { dexcom: 'ok', libre: 'ok' });

  dexcom.values = [{ WT: `Date(${Date.now()})`, Value: 150, Trend: 'Flat' }];
  body = await (await get(w, bothEnv)).json();
  assert.equal(body.readings[0].source, 'dexcom');

  const w2 = await load();
  dexcom.password = 'changed';
  const res = await get(w2, bothEnv);
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.readings[0].source, 'libre');
  assert.equal(body.sources.dexcom, 'login_failed');
});

test('CORS preflight is answered', async () => {
  const w = await load();
  const res = await w.fetch(new Request('https://relay.example/latest', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), bothEnv);
  assert.equal(res.status, 204);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /X-DiaBuddy-Key/);
});

// In-memory stand-in for a Workers KV namespace.
function memoryKv() {
  const data = new Map();
  const ttl = new Map();
  let writes = 0;
  return {
    async get(key, type) { const v = data.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value, opts) { writes++; data.set(key, value); ttl.set(key, opts?.expirationTtl); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) { return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
    ttlOf: (key) => ttl.get(key),
    get writes() { return writes; },
  };
}
const runScheduled = async (w, env) => {
  const jobs = [];
  await w.scheduled({}, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
};

test('scheduled job logs each new reading once, and /latest returns them as minute history', async () => {
  const w = await load();
  const LOG = memoryKv();
  const env = { ...libreEnv, LOG };
  const start = Date.now();
  for (let i = 10; i >= 0; i--) {
    libre.measurement = { ValueInMgPerDl: 180 - i * 4, TrendArrow: 4, FactoryTimestamp: lluTime(start - i * 60000) };
    await runScheduled(w, env);
    await runScheduled(w, env); // same reading again: no extra write
  }
  assert.equal(LOG.writes, 11);
  const body = await (await get(w, env)).json();
  assert.ok(body.history.length >= 11, `got ${body.history.length} points`);
  const times = body.history.map((p) => Date.parse(p.time));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(body.history.at(-1).mmol, 10);
});

test('readings are kept per day for 120 days, and only the newest sensor shows in history', async () => {
  const w = await load();
  const LOG = memoryKv();
  const now = Date.now();
  const today = `glucose:${new Date(now).toISOString().slice(0, 10)}`;
  await LOG.put(today, JSON.stringify([
    { source: 'dexcom', mgdl: 200, time: now - 5 * 60000 },
    { source: 'libre', mgdl: 120, time: now - 5 * 60000 },
  ]));
  const env = { ...libreEnv, LOG };
  await runScheduled(w, env);
  assert.equal(LOG.ttlOf(today), 120 * 24 * 3600);
  assert.equal((await LOG.get(today, 'json')).length, 3);
  const body = await (await get(w, env)).json();
  assert.ok(body.history.every((p) => p.mmol < 11), 'no Dexcom points in a Libre history');
});

const post = (w, env, body, key = env.FAMILY_KEY) => w.fetch(new Request('https://relay.example/events', {
  method: 'POST', headers: { 'X-DiaBuddy-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env);
const list = (w, env, key = env.FAMILY_KEY) => w.fetch(new Request('https://relay.example/events?days=7', { headers: { 'X-DiaBuddy-Key': key } }), env);

test('dose log: save, list newest first, and delete', async () => {
  const w = await load();
  const env = { ...libreEnv, LOG: memoryKv() };
  const at1 = new Date(Date.now() - 3600e3).toISOString();
  const at2 = new Date().toISOString();
  let res = await post(w, env, { id: 'abc123xyz', type: 'dose', at: at1, carbs: 27.6, foods: [{ name: 'Futurelife', servings: 1, carbs: 24 }], bg: 8.2, bgSource: 'libre', insulinGiven: 3, calculated: { rounded: 3, exact: 3.08, food: 2.76, correction: 0.32 } });
  assert.equal(res.status, 201);
  res = await post(w, env, { id: 'def456uvw', type: 'low-treatment', at: at2, carbs: 15, foods: [{ name: 'Apple juice', servings: 0.7, carbs: 15 }], bg: 3.4, bgSource: 'typed' });
  assert.equal(res.status, 201);
  const { events } = await (await list(w, env)).json();
  assert.deepEqual(events.map((e) => e.id), ['def456uvw', 'abc123xyz']);
  assert.equal(events[1].insulinGiven, 3);
  assert.equal(events[1].foods[0].name, 'Futurelife');

  res = await w.fetch(new Request('https://relay.example/events/abc123xyz', { method: 'DELETE', headers: { 'X-DiaBuddy-Key': env.FAMILY_KEY } }), env);
  assert.equal(res.status, 200);
  assert.deepEqual((await (await list(w, env)).json()).events.map((e) => e.id), ['def456uvw']);
});

test('dose log: bad entries are rejected and odd values dropped', async () => {
  const w = await load();
  const env = { ...libreEnv, LOG: memoryKv() };
  assert.equal((await post(w, env, { type: 'dose', at: 'not a date' })).status, 400);
  assert.equal((await post(w, env, { type: 'party', at: new Date().toISOString() })).status, 400);
  assert.equal((await post(w, env, { type: 'dose', at: new Date(Date.now() + 3600e3).toISOString() })).status, 400);
  const res = await post(w, env, { type: 'dose', at: new Date().toISOString(), insulinGiven: 999, bg: 'high', foods: [{ name: '<b>x</b>'.repeat(50), carbs: -4 }] });
  const { event } = await res.json();
  assert.equal(event.insulinGiven, null);
  assert.equal(event.bg, null);
  assert.equal(event.foods[0].carbs, null);
  assert.equal(event.foods[0].name.length, 80);
});

test('dose log: a TV key can read but not write', async () => {
  const w = await load();
  const env = { ...libreEnv, TV_KEY: 'tv-key-456', LOG: memoryKv() };
  assert.equal((await post(w, env, { type: 'dose', at: new Date().toISOString() }, 'tv-key-456')).status, 403);
  assert.equal((await list(w, env, 'tv-key-456')).status, 200);
  assert.equal((await post(w, env, { type: 'dose', at: new Date().toISOString() }, 'wrong-key')).status, 401);
});

test('relay still works with no KV bound', async () => {
  const w = await load();
  await runScheduled(w, libreEnv);
  assert.equal((await get(w, libreEnv)).status, 200);
});

const scan = (w, env, body = { image: 'aGVsbG8=', mediaType: 'image/jpeg' }, key = env.FAMILY_KEY) => w.fetch(new Request('https://relay.example/scan-label', {
  method: 'POST', headers: { 'X-DiaBuddy-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env);

test('label scan: sends the photo to Claude Opus 5.5 with a schema and fallback, returns the printed numbers', async () => {
  const w = await load();
  const env = { ...libreEnv, LOG: memoryKv(), ANTHROPIC_API_KEY: 'sk-test' };
  const res = await scan(w, env);
  assert.equal(res.status, 200);
  const { label } = await res.json();
  assert.equal(label.carbs_per_100g, 63);
  assert.equal(label.serving_size_grams, 45);
  const sent = claudeCalls[0];
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.fallbacks, 'default');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.equal(sent.messages[0].content[0].source.data, 'aGVsbG8=');
});

test('label scan: family key only, needs an API key, rejects bad photos, caps daily use', async () => {
  const w = await load();
  const LOG = memoryKv();
  const env = { ...libreEnv, TV_KEY: 'tv-key-456', LOG, ANTHROPIC_API_KEY: 'sk-test' };
  assert.equal((await scan(w, env, undefined, 'tv-key-456')).status, 403);
  assert.equal((await scan(w, { ...env, ANTHROPIC_API_KEY: undefined })).status, 503);
  assert.equal((await scan(w, env, { image: 'x', mediaType: 'application/pdf' })).status, 400);
  await LOG.put(`scans:${new Date().toISOString().slice(0, 10)}`, '60');
  assert.equal((await (await scan(w, env)).json()).error, 'scan_limit');
});

test('label scan: API problems come back as clear errors', async () => {
  const w = await load();
  const env = { ...libreEnv, ANTHROPIC_API_KEY: 'sk-bad' };
  claude.status = 401; claude.errorType = 'authentication_error';
  assert.equal((await (await scan(w, env)).json()).error, 'scan_bad_api_key');
  claude.status = 200; claude.stop = 'refusal';
  assert.equal((await (await scan(w, env)).json()).error, 'label_refused');
});

test('family foods: any family phone can add and remove; TV key can only read', async () => {
  const w = await load();
  const env = { ...libreEnv, TV_KEY: 'tv-key-456', LOG: memoryKv() };
  const req = (method, path, key, body) => w.fetch(new Request(`https://relay.example${path}`, {
    method, headers: { 'X-DiaBuddy-Key': key, ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body),
  }), env);
  let res = await req('POST', '/foods', env.FAMILY_KEY, { name: 'Weet-Bix – Bokomo', category: 'Breakfast', serving: { label: '2 biscuits (45 g)', grams: 45 }, netCarbs: 28.4, per100g: 63, fromPhoto: true });
  assert.equal(res.status, 201);
  const { food } = await res.json();
  assert.match(food.id, /^fam-/);
  assert.equal((await req('POST', '/foods', 'tv-key-456', { name: 'x', serving: { label: '1' }, netCarbs: 1 })).status, 403);
  assert.equal((await req('POST', '/foods', env.FAMILY_KEY, { name: 'No carbs given', serving: { label: '1' } })).status, 400);
  assert.equal((await (await req('GET', '/foods', 'tv-key-456')).json()).foods[0].name, 'Weet-Bix – Bokomo');
  assert.equal((await req('DELETE', `/foods/${food.id}`, env.FAMILY_KEY)).status, 200);
  assert.equal((await (await req('GET', '/foods', env.FAMILY_KEY)).json()).foods.length, 0);
});
