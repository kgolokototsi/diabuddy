import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInvite } from '../worker/auth.js';
import { encryptPayload, highSince, checkHigh, cleanSubscription, HIGH_MESSAGE } from '../worker/push.js';

const { subtle } = crypto;
const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const MGDL = 18.0182;
const MIN = 60000;

function memoryKv() {
  const data = new Map();
  return {
    async get(key, type) { const v = data.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) { return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
    has: (key) => data.has(key),
  };
}

// A phone's push keys, as a browser would make them.
async function phoneKeys() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { pair, p256dh: b64u(pub), auth: b64u(auth) };
}

async function hkdf(salt, ikm, info, len) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// What the phone does on arrival (RFC 8291, receiving side).
async function decrypt(phone, body) {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const asPublic = body.slice(21, 21 + idLen);
  const cipher = body.slice(21 + idLen);
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, phone.pair.privateKey, 256));
  const uaPublic = unb64u(phone.p256dh);
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(unb64u(phone.auth), shared, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, cipher));
  assert.equal(plain.at(-1), 2, 'last-record delimiter');
  return new TextDecoder().decode(plain.slice(0, -1));
}

const vapidPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const VAPID_PRIVATE_JWK = JSON.stringify(await subtle.exportKey('jwk', vapidPair.privateKey));

// Fake push services: record what arrives; answer with pushReply.
let pushed;
let pushReply;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === 'fcm.googleapis.com' || u.hostname === 'web.push.apple.com') {
    pushed.push({ url: u.href, headers: init.headers, body: new Uint8Array(init.body) });
    return new Response('', { status: pushReply });
  }
  return new Response('{}', { status: 404 });
};
beforeEach(() => { pushed = []; pushReply = 201; });

const { default: worker } = await import('../worker/worker.js');
const makeEnv = () => ({ LOG: memoryKv(), VAPID_PRIVATE_JWK, FAMILY_KEY: 'legacy-family-key-0123456789' });
const call = async (env, method, path, { key, body } = {}) => {
  const res = await worker.fetch(new Request(`https://diabuddy.example${path}`, {
    method,
    headers: { ...(key && { 'X-DiaBuddy-Key': key }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: () => {} });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const join = async (env, role) => {
  const { code } = await createInvite(env, { role, name: role, by: 'test' });
  return (await call(env, 'POST', '/enroll', { body: { code } })).body;
};
const subscribe = async (env, key, host = 'fcm.googleapis.com') => {
  const phone = await phoneKeys();
  const res = await call(env, 'PUT', '/push', { key, body: { endpoint: `https://${host}/push/abc${Math.random()}`, keys: { p256dh: phone.p256dh, auth: phone.auth } } });
  return { phone, res };
};

// Readings every 5 minutes from `fromMin` ago to `toMin` ago at a given mmol/L.
const readings = (fromMin, toMin, mmol, now, source = 'libre') => {
  const out = [];
  for (let m = fromMin; m >= toMin; m -= 5) out.push({ source, mgdl: Math.round(mmol * MGDL), time: now - m * MIN });
  return out;
};

test('the message is encrypted so only the phone can read it', async () => {
  const phone = await phoneKeys();
  const body = await encryptPayload(phone, JSON.stringify({ body: HIGH_MESSAGE }));
  assert.equal(JSON.parse(await decrypt(phone, body)).body, HIGH_MESSAGE);
  const other = await phoneKeys();
  await assert.rejects(decrypt({ ...other, p256dh: phone.p256dh }, body), 'a different phone cannot read it');
});

test('pushes are signed with the relay VAPID key for the push service', async () => {
  const env = makeEnv();
  const { token } = await join(env, 'family');
  const { phone } = await subscribe(env, token);
  assert.equal((await call(env, 'POST', '/push/test', { key: token })).status, 200);
  const [p] = pushed;
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(p.headers.Authorization);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 24 * 3600);
  const pub = await subtle.importKey('raw', unb64u(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(s), enc.encode(`${h}.${c}`)));
  assert.equal(p.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(JSON.parse(await decrypt(phone, p.body)).title, 'Test alert');
});

test('high spell: 2.5 hours at 14 or more, broken by a lower reading or a long gap', () => {
  const now = Date.now();
  assert.equal(highSince(readings(160, 0, 15, now), now), now - 160 * MIN);
  assert.equal(highSince([...readings(200, 100, 15, now), ...readings(95, 95, 12, now), ...readings(90, 0, 15, now)], now), now - 90 * MIN, 'a dip restarts it');
  assert.equal(highSince([...readings(200, 100, 15, now), ...readings(60, 0, 15, now)], now), now - 60 * MIN, 'a 40 min gap restarts it');
  assert.equal(highSince(readings(160, 0, 13.9, now), now), null, '13.9 is not high');
  assert.equal(highSince(readings(180, 20, 15, now), now), null, 'newest reading too old to judge');
});

test('alerts every subscribed phone once per spell, and again after the next spell', async () => {
  const env = makeEnv();
  const a = await join(env, 'family');
  const b = await join(env, 'admin');
  const { phone } = await subscribe(env, a.token);
  await subscribe(env, b.token, 'web.push.apple.com');
  const now = Date.now();

  assert.equal(await checkHigh(env, readings(140, 0, 15, now), now), null, '2h20 is not yet 2.5 h');
  assert.equal(pushed.length, 0);
  assert.equal(await checkHigh(env, readings(155, 0, 15.2, now), now), 2);
  assert.equal(pushed.length, 2);
  const msg = JSON.parse(await decrypt(phone, pushed.find((p) => p.url.includes('fcm')).body));
  assert.equal(msg.body, 'Glucose reading High for over 2.5 hours. Consider a correction dosage.');
  assert.equal(msg.title, 'High: 15.2 mmol/L', 'no app name: the phone shows it already');

  assert.equal(await checkHigh(env, readings(160, 0, 15, now), now), null, 'same spell: no second alert');
  assert.equal(await checkHigh(env, readings(170, 25, 15, now), now), null, 'no recent readings: nothing changes');
  assert.equal(pushed.length, 2);
  await checkHigh(env, [...readings(170, 5, 15, now), ...readings(0, 0, 9, now)], now);
  assert.ok(!env.LOG.has('high-alert'), 'spell over');
  await checkHigh(env, readings(155, 0, 16, now), now);
  assert.equal(pushed.length, 4, 'next spell alerts again');
});

test('only the newest sensor counts', async () => {
  const env = makeEnv();
  await subscribe(env, (await join(env, 'family')).token);
  const now = Date.now();
  await checkHigh(env, [...readings(160, 10, 15, now, 'dexcom'), ...readings(160, 0, 8, now, 'libre')], now);
  assert.equal(pushed.length, 0);
});

test('alerts: family and admin phones only, push-service addresses only, gone phones forgotten', async () => {
  const env = makeEnv();
  const tv = await join(env, 'tv');
  assert.equal((await subscribe(env, tv.token)).res.status, 403);
  assert.equal((await subscribe(env, 'legacy-family-key-0123456789')).res.status, 403, 'old shared link needs an invite');

  const fam = await join(env, 'family');
  assert.equal((await subscribe(env, fam.token, 'evil.example.com')).res.status, 400, 'no other hosts (SSRF)');
  assert.equal(cleanSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys: {} }), null);
  assert.equal((await subscribe(env, fam.token)).res.status, 200);
  assert.equal((await call(env, 'GET', '/push', { key: fam.token })).body.subscribed, true);

  pushReply = 410; // the phone unsubscribed
  const now = Date.now();
  await checkHigh(env, readings(160, 0, 15, now), now);
  assert.ok(!env.LOG.has(`push:${fam.device.id}`));

  pushReply = 201;
  await subscribe(env, fam.token);
  assert.equal((await call(env, 'DELETE', '/push', { key: fam.token })).body.subscribed, false);
  await subscribe(env, fam.token);
  const admin = await join(env, 'admin');
  assert.equal((await call(env, 'DELETE', `/devices/${fam.device.id}`, { key: admin.token })).status, 200);
  assert.ok(!env.LOG.has(`push:${fam.device.id}`), 'removing a phone stops its alerts');
});

test('without the VAPID key, alerts say they are not set up', async () => {
  const env = { ...makeEnv(), VAPID_PRIVATE_JWK: undefined };
  const { token } = await join(env, 'family');
  assert.equal((await call(env, 'GET', '/push', { key: token })).body.error, 'alerts_not_configured');
});
