import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const env = { DEXCOM_USERNAME: 'kid@example.com', DEXCOM_PASSWORD: 'pw', FAMILY_KEY: 'family-key-123', DEXCOM_REGION: 'ous', ALLOWED_ORIGIN: 'https://kgolokototsi.github.io' };
const ORIGIN = 'https://kgolokototsi.github.io';
let calls;
let dexcom;

// Fake Dexcom Share server.
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  calls.push(u.pathname.split('/').pop());
  assert.equal(u.host, 'shareous1.dexcom.com');
  const body = init.body ? JSON.parse(init.body) : null;
  const reply = (status, data) => new Response(JSON.stringify(data), { status });
  if (u.pathname.endsWith('AuthenticatePublisherAccount')) {
    return body.password === dexcom.password ? reply(200, 'acct-1') : reply(500, { Code: 'AccountPasswordInvalid', Message: 'bad' });
  }
  if (u.pathname.endsWith('LoginPublisherAccountById')) return reply(200, `session-${++dexcom.sessions}`);
  if (u.pathname.endsWith('ReadPublisherLatestGlucoseValues')) {
    if (dexcom.expire && u.searchParams.get('sessionId') === 'session-1') return reply(500, { Code: 'SessionIdNotFound' });
    return reply(200, dexcom.values);
  }
  return reply(404, {});
};

const { default: worker } = await import(`../worker/worker.js?${Date.now()}`);
const get = (key = env.FAMILY_KEY, path = '/latest') =>
  worker.fetch(new Request(`https://relay.example${path}`, { headers: { Origin: ORIGIN, ...(key && { 'X-DiaBuddy-Key': key }) } }), env);

beforeEach(() => {
  calls = [];
  const now = Date.now();
  dexcom = { password: 'pw', sessions: 0, expire: false, values: [{ WT: `Date(${now - 3 * 60000})`, Value: 142, Trend: 'FortyFiveUp' }] };
});

test('wrong or missing key is rejected without calling Dexcom', async () => {
  assert.equal((await get('nope')).status, 401);
  assert.equal((await get(null)).status, 401);
  assert.deepEqual(calls, []);
});

test('returns latest reading in mmol/L with trend and age', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const { readings: [r] } = await res.json();
  assert.equal(r.mgdl, 142);
  assert.equal(r.mmol, 7.9);
  assert.equal(r.arrow, '↗');
  assert.equal(r.ageMinutes, 3);
  assert.equal(r.low, false);
});

test('reuses the session, and logs in again when it expires', async () => {
  await get(); // may reuse a session from an earlier test
  calls = [];
  await get();
  assert.deepEqual(calls, ['ReadPublisherLatestGlucoseValues']);
});

test('LOW and fast trends are flagged', async () => {
  dexcom.values = [{ WT: `Date(${Date.now()})`, Value: 39, Trend: 'DoubleDown' }];
  const { readings: [r] } = await (await get()).json();
  assert.equal(r.low, true);
  assert.equal(r.fast, true);
  assert.equal(r.arrow, '⇊');
});

test('bad Dexcom password reports a login failure', async () => {
  const { default: fresh } = await import(`../worker/worker.js?fresh=${Date.now()}`);
  dexcom.password = 'changed';
  const res = await fresh.fetch(new Request('https://relay.example/latest', { headers: { 'X-DiaBuddy-Key': env.FAMILY_KEY } }), env);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'dexcom_login_failed');
});

test('expired session triggers one fresh login', async () => {
  const { default: fresh } = await import(`../worker/worker.js?expire=${Date.now()}`);
  dexcom.expire = true;
  const res = await fresh.fetch(new Request('https://relay.example/latest', { headers: { 'X-DiaBuddy-Key': env.FAMILY_KEY } }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['AuthenticatePublisherAccount', 'LoginPublisherAccountById', 'ReadPublisherLatestGlucoseValues',
    'AuthenticatePublisherAccount', 'LoginPublisherAccountById', 'ReadPublisherLatestGlucoseValues']);
});

test('CORS preflight is answered', async () => {
  const res = await worker.fetch(new Request('https://relay.example/latest', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  assert.equal(res.status, 204);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /X-DiaBuddy-Key/);
});
