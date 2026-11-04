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
  let writes = 0;
  return {
    async get(key, type) { const v = data.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { writes++; data.set(key, value); },
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

test('log keeps two hours and only the newest sensor shows in history', async () => {
  const w = await load();
  const LOG = memoryKv();
  const now = Date.now();
  await LOG.put('log', JSON.stringify([
    { source: 'libre', mgdl: 100, time: now - 3 * 3600e3 },
    { source: 'dexcom', mgdl: 200, time: now - 5 * 60000 },
    { source: 'libre', mgdl: 120, time: now - 5 * 60000 },
  ]));
  const env = { ...libreEnv, LOG };
  await runScheduled(w, env);
  const log = await LOG.get('log', 'json');
  assert.ok(!log.some((p) => p.mgdl === 100), 'old entry dropped');
  const body = await (await get(w, env)).json();
  assert.ok(body.history.every((p) => p.mmol < 11), 'no Dexcom points in a Libre history');
});

test('relay still works with no KV bound', async () => {
  const w = await load();
  await runScheduled(w, libreEnv);
  assert.equal((await get(w, libreEnv)).status, 200);
});
