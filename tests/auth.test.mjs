import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInvite } from '../worker/auth.js';
import { validateSettings } from '../worker/settings.js';

// In-memory stand-in for a Workers KV namespace (with TTL and list).
function memoryKv() {
  const data = new Map();
  return {
    async get(key, type) { const v = data.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) { return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
    keys: () => [...data.keys()],
    raw: (key) => data.get(key),
  };
}

const { default: worker } = await import('../worker/worker.js');
const LEGACY = 'legacy-family-key-0123456789';
const makeEnv = (extra = {}) => ({ LOG: memoryKv(), FAMILY_KEY: LEGACY, TV_KEY: 'legacy-tv-key-0123456789', LIBRE_EMAIL: 'f@example.com', LIBRE_PASSWORD: 'x', ...extra });
const call = async (env, method, path, { key, body, headers = {} } = {}) => {
  const res = await worker.fetch(new Request(`https://diabuddy.example${path}`, {
    method,
    headers: { ...(key && { 'X-DiaBuddy-Key': key }), ...(body && { 'Content-Type': 'application/json' }), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: () => {} });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};
const join = async (env, role, name = 'Phone') => {
  const { code } = await createInvite(env, { role, name, by: 'test' });
  const res = await call(env, 'POST', '/enroll', { body: { code, deviceName: name } });
  return res.body.token;
};

test('invite is single use and gives the phone its own token with the invited role', async () => {
  const env = makeEnv();
  const { code } = await createInvite(env, { role: 'family', name: 'Gran', by: 'Mum' });
  const first = await call(env, 'POST', '/enroll', { body: { code, deviceName: "Gran's iPhone" } });
  assert.equal(first.status, 201);
  assert.ok(first.body.token.length >= 40);
  assert.equal(first.body.device.role, 'family');
  assert.equal((await call(env, 'POST', '/enroll', { body: { code } })).status, 400, 'second use rejected');
  const me = await call(env, 'GET', '/me', { key: first.body.token });
  assert.deepEqual([me.body.device.name, me.body.device.role], ["Gran's iPhone", 'family']);
});

test('tokens and invite codes are stored only as hashes', async () => {
  const env = makeEnv();
  const { code } = await createInvite(env, { role: 'family', name: 'x', by: 'y' });
  const token = (await call(env, 'POST', '/enroll', { body: { code } })).body.token;
  const everything = env.LOG.keys().map((k) => k + (env.LOG.raw(k) || '')).join('\n');
  assert.ok(!everything.includes(token), 'raw token not stored');
  assert.ok(!everything.includes(code), 'raw invite code not stored');
});

test('expired or made-up invites are rejected', async () => {
  const env = makeEnv();
  const { code } = await createInvite(env, { role: 'family', name: 'x', by: 'y' });
  const key = env.LOG.keys().find((k) => k.startsWith('invite:'));
  await env.LOG.put(key, JSON.stringify({ ...(await env.LOG.get(key, 'json')), expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.equal((await call(env, 'POST', '/enroll', { body: { code } })).status, 400);
  assert.equal((await call(env, 'POST', '/enroll', { body: { code: 'not-a-real-invite-code-xyz' } })).status, 400);
});

test('roles: family cannot change settings or invite; TV can only read; admin can do both', async () => {
  const env = makeEnv();
  const admin = await join(env, 'admin', 'Mum');
  const family = await join(env, 'family', 'Gran');
  const tv = await join(env, 'tv', 'TV');
  const settings = { icr: 10, cf: 7, targetBg: 5, hypoThreshold: 4, maxDose: null, roundTo: 0.5, negativeCorrection: true };

  assert.equal((await call(env, 'PUT', '/settings', { key: family, body: settings })).status, 403);
  assert.equal((await call(env, 'POST', '/invites', { key: family, body: { role: 'family', name: 'x' } })).status, 403);
  assert.equal((await call(env, 'GET', '/devices', { key: family })).status, 403);
  assert.equal((await call(env, 'POST', '/events', { key: tv, body: { type: 'dose', at: new Date().toISOString() } })).status, 403);
  assert.equal((await call(env, 'POST', '/scan-label', { key: tv, body: {} })).status, 403);
  assert.equal((await call(env, 'GET', '/settings', { key: tv })).status, 200);

  const put = await call(env, 'PUT', '/settings', { key: admin, body: settings });
  assert.equal(put.status, 200);
  assert.equal(put.body.settings.updatedBy, 'Mum');
  assert.equal((await call(env, 'GET', '/settings', { key: family })).body.settings.icr, 10);
  const invite = await call(env, 'POST', '/invites', { key: admin, body: { role: 'family', name: 'Aunt' } });
  assert.equal(invite.status, 201);
  assert.ok(invite.body.code);
});

test('settings are validated and every change is kept with who made it', async () => {
  const env = makeEnv();
  const admin = await join(env, 'admin', 'Mum');
  const good = { icr: 10, cf: 7, targetBg: 5, hypoThreshold: 4, maxDose: 8, roundTo: 0.5, negativeCorrection: true };
  assert.equal((await call(env, 'PUT', '/settings', { key: admin, body: { ...good, icr: 500 } })).body.error, 'bad_icr');
  assert.equal((await call(env, 'PUT', '/settings', { key: admin, body: { ...good, cf: null } })).body.error, 'missing_cf');
  assert.equal(validateSettings({ ...good, roundTo: 0.25 }).error, 'bad_roundTo');
  await call(env, 'PUT', '/settings', { key: admin, body: good });
  await call(env, 'PUT', '/settings', { key: admin, body: { ...good, icr: 12 } });
  const { history } = (await call(env, 'GET', '/settings?history=1', { key: admin })).body;
  assert.equal(history[0].by, 'Mum');
  assert.deepEqual(history[0].changes, [{ field: 'icr', from: 10, to: 12 }]);
});

test('admin can see and remove a phone; a removed phone is locked out; a phone can remove itself', async () => {
  const env = makeEnv();
  const admin = await join(env, 'admin', 'Mum');
  const gran = await join(env, 'family', 'Gran');
  const aunt = await join(env, 'family', 'Aunt');
  const { devices } = (await call(env, 'GET', '/devices', { key: admin })).body;
  assert.equal(devices.length, 3);
  assert.ok(devices.find((d) => d.name === 'Mum').current);
  assert.ok(devices.every((d) => !('hash' in d)), 'hashes never leave the relay');
  const granId = devices.find((d) => d.name === 'Gran').id;
  assert.equal((await call(env, 'DELETE', `/devices/${granId}`, { key: aunt })).status, 403, 'family cannot remove others');
  assert.equal((await call(env, 'DELETE', `/devices/${granId}`, { key: admin })).status, 200);
  assert.equal((await call(env, 'GET', '/me', { key: gran })).status, 401);
  const auntId = devices.find((d) => d.name === 'Aunt').id;
  assert.equal((await call(env, 'DELETE', `/devices/${auntId}`, { key: aunt })).status, 200, 'self-removal');
});

test('old shared keys work until the admin turns them off', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'GET', '/me', { key: LEGACY })).body.device.legacy, true);
  const admin = await join(env, 'admin', 'Mum');
  assert.equal((await call(env, 'GET', '/devices', { key: admin })).body.legacyActive, true);
  assert.equal((await call(env, 'POST', '/legacy-off', { key: LEGACY })).status, 403, 'legacy family key is not admin');
  assert.equal((await call(env, 'POST', '/legacy-off', { key: admin })).status, 200);
  assert.equal((await call(env, 'GET', '/me', { key: LEGACY })).status, 401);
  assert.equal((await call(env, 'GET', '/me', { key: 'legacy-tv-key-0123456789' })).status, 401);
});

test('admin can delete his stored readings and log (POPIA erasure)', async () => {
  const env = makeEnv();
  const admin = await join(env, 'admin', 'Mum');
  await env.LOG.put('glucose:2026-11-01', '[]');
  await env.LOG.put('event:2026-11-01T08:00:00.000Z:abc123xyz', '{}');
  await env.LOG.put('settings', '{}');
  const res = await call(env, 'POST', '/erase', { key: admin, body: { what: 'all' } });
  assert.equal(res.body.deleted, 2);
  assert.ok(!env.LOG.keys().some((k) => k.startsWith('glucose:') || k.startsWith('event:')));
  assert.ok(env.LOG.keys().includes('settings'), 'settings are kept');
  const family = await join(env, 'family', 'Gran');
  assert.equal((await call(env, 'POST', '/erase', { key: family, body: { what: 'all' } })).status, 403);
});

test('rate limits: enrolment and API calls get 429 when the binding says no', async () => {
  const deny = { limit: async () => ({ success: false }) };
  const env = makeEnv({ RL_ENROLL: deny });
  assert.equal((await call(env, 'POST', '/enroll', { body: { code: 'x'.repeat(24) } })).status, 429);
  const env2 = makeEnv({ RL_API: deny });
  assert.equal((await call(env2, 'GET', '/me', { key: LEGACY })).status, 429);
});

test('security headers on every API response; bad keys logged without the key', async () => {
  const env = makeEnv();
  const warnings = [];
  const original = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const res = await call(env, 'GET', '/me', { key: 'wrong-key-that-should-not-be-logged' });
    assert.equal(res.status, 401);
    for (const [h, v] of [['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer'], ['cache-control', 'no-store']]) assert.equal(res.headers.get(h), v);
    assert.match(res.headers.get('strict-transport-security'), /max-age=/);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('wrong-key-that-should-not-be-logged'));
});

test('non-API paths go to the static app', async () => {
  const env = makeEnv({ ASSETS: { fetch: async () => new Response('app', { status: 200 }) } });
  const res = await worker.fetch(new Request('https://diabuddy.example/index.html'), env, {});
  assert.equal(await res.text(), 'app');
});
