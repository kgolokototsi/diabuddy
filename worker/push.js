// High-glucose alerts sent to phones as Web Push notifications.
//
// A phone that turns alerts on gives the relay its push subscription (stored as
// push:<device id>). The scheduled job checks the logged readings; once he has been
// 14 mmol/L or higher for 2.5 hours it sends one alert per high spell.
//
// Messages are encrypted for each phone (RFC 8291) and signed with the relay's
// VAPID key (RFC 8292), held as the VAPID_PRIVATE_JWK secret. Only the phone can
// read them; the push service (Google, Apple, Mozilla) only passes them on.

export const HIGH_MMOL = 14;
export const HIGH_FOR_MS = 2.5 * 3600000;
const MGDL_PER_MMOL = 18.0182;
const FRESH_MS = 15 * 60000;      // the newest reading must be this recent to judge
const MAX_GAP_MS = 30 * 60000;    // a longer gap in readings ends a spell: we can't say he stayed high
const ALERT_KEY = 'high-alert';   // set while the current spell has been alerted
export const HIGH_MESSAGE = 'Glucose reading High for over 2.5 hours. Consider a correction dosage.';
// Kinds of alert a phone can choose. Older subscriptions (before the choice) get high only.
export const ALERT_TYPES = ['high', 'fall'];
export const cleanTypes = (types) => {
  const t = Array.isArray(types) ? ALERT_TYPES.filter((k) => types.includes(k)) : ['high'];
  return t.length ? t : null;
};

// Only the browsers' own push services: the relay never posts to any other address.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

// ---------------------------------------------------------------- subscriptions

export function cleanSubscription(body) {
  try {
    const url = new URL(body?.endpoint);
    const p256dh = unb64u(String(body?.keys?.p256dh || ''));
    const auth = unb64u(String(body?.keys?.auth || ''));
    if (url.protocol !== 'https:' || !PUSH_HOSTS.test(url.hostname) || body.endpoint.length > 1000) return null;
    if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return null;
    return { endpoint: url.href, p256dh: body.keys.p256dh, auth: body.keys.auth };
  } catch {
    return null;
  }
}

export const subscriptionKey = (deviceId) => `push:${deviceId}`;

async function allSubscriptions(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.LOG.list({ prefix: 'push:', cursor });
    for (const k of page.keys) {
      const s = await env.LOG.get(k.name, 'json');
      if (s) out.push({ ...s, key: k.name });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------- sending

export function vapidPublicKey(env) {
  const { x, y } = JSON.parse(env.VAPID_PRIVATE_JWK);
  return b64u(concat([4], unb64u(x), unb64u(y)));
}

async function vapidHeader(env, endpoint) {
  const { kty, crv, x, y, d } = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', { kty, crv, x, y, d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (obj) => b64u(enc.encode(JSON.stringify(obj)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'https://diabuddy-dexcom.diabuddy-dexcom.workers.dev',
  })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapidPublicKey(env)}`;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// RFC 8291 "aes128gcm": one record, encrypted for this phone's keys.
export async function encryptPayload(sub, text) {
  const uaPublic = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(text), [2])));

  return concat(salt, [0, 0, 16, 0], [asPublic.length], asPublic, cipher); // record size 4096
}

// Returns 'sent', 'gone' (the phone unsubscribed; forget it) or 'failed'.
export async function sendPush(env, sub, message) {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(env, sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '3600',
        Urgency: 'high',
        Topic: message.tag || 'diabuddy',
      },
      body: await encryptPayload(sub, JSON.stringify(message)),
    });
    if (res.ok) return 'sent';
    if (res.status === 404 || res.status === 410) return 'gone';
    console.warn('push failed', res.status, new URL(sub.endpoint).hostname);
    return 'failed';
  } catch (err) {
    console.warn('push failed', err.name);
    return 'failed';
  }
}

// Sends to every phone that chose this kind of alert.
export async function sendToAll(env, message, type = 'high') {
  const subs = (await allSubscriptions(env)).filter((s) => (s.types || ['high']).includes(type));
  const results = await Promise.all(subs.map(async (s) => {
    const result = await sendPush(env, s, message);
    if (result === 'gone') await env.LOG.delete(s.key);
    return result;
  }));
  return results.filter((r) => r === 'sent').length;
}

// ---------------------------------------------------------------- the high check

// When the current high spell began, if he is high now; else null.
// points: one sensor's logged readings { mgdl, time }.
export function highSince(points, now = Date.now()) {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const isHigh = (p) => Math.round((p.mgdl / MGDL_PER_MMOL) * 10) / 10 >= HIGH_MMOL;
  const newest = sorted.at(-1);
  if (!newest || now - newest.time > FRESH_MS || !isHigh(newest)) return null;
  let start = newest;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const p = sorted[i];
    if (!isHigh(p) || start.time - p.time > MAX_GAP_MS) break;
    start = p;
  }
  return start.time;
}

// Run after each scheduled reading. logged: the last few hours of logged readings.
export async function checkHigh(env, logged, now = Date.now()) {
  if (!env.LOG || !env.VAPID_PRIVATE_JWK) return null;
  const newest = logged.reduce((a, p) => (!a || p.time > a.time ? p : a), null);
  if (!newest || now - newest.time > FRESH_MS) return null; // no recent readings: leave things as they are
  const points = logged.filter((p) => p.source === newest.source);
  const since = highSince(points, now);
  const alerted = await env.LOG.get(ALERT_KEY);

  if (since == null) {
    if (alerted) await env.LOG.delete(ALERT_KEY); // the spell is over; the next one alerts again
    return null;
  }
  if (alerted || newest.time - since < HIGH_FOR_MS) return null;

  const mmol = Math.round((newest.mgdl / MGDL_PER_MMOL) * 10) / 10;
  // No app name in the title: the phone already shows "DiaBuddy" above every alert.
  const message = { title: `High: ${mmol.toFixed(1)} mmol/L`, body: HIGH_MESSAGE, tag: 'high-glucose' };
  // Mark it first, so a slow send can't lead to a second alert from the next run.
  await env.LOG.put(ALERT_KEY, new Date(since).toISOString(), { expirationTtl: 24 * 3600 });
  return sendToAll(env, message);
}

// ---------------------------------------------------------------- the falling-fast check

// Falling at least this much over 15 minutes (mmol/L; 0.2 a minute), to below 10, alerts the family.
export const FALL_DROP = 3;
const FALL_FROM_BELOW = 10; // falls from higher up (e.g. after a correction) are expected
const FALL_KEY = 'fall-alert';  // set for an hour after an alert, so one fall sends one alert
const FALL_QUIET_S = 3600;

const isNight = (ms) => { const h = new Date(ms + 2 * 3600000).getUTCHours(); return h >= 21 || h < 6; }; // SA time

// How fast he's falling now, if it's a sharp fall. points: one sensor's { mgdl, time }.
export function fallingFast(points, now = Date.now()) {
  const pts = points.map((p) => ({ t: p.time, v: Math.round((p.mgdl / MGDL_PER_MMOL) * 10) / 10 })).sort((a, b) => a.t - b.t);
  const cur = pts.at(-1);
  if (!cur || now - cur.t > 6 * 60000) return null;
  const near = (mins, tol) => pts.filter((p) => Math.abs(cur.t - p.t - mins * 60000) <= tol * 60000)
    .sort((a, b) => Math.abs(cur.t - a.t - mins * 60000) - Math.abs(cur.t - b.t - mins * 60000))[0];
  const b15 = near(15, 4);
  const b5 = near(5, 3);
  if (!b15 || !b5) return null;
  const rate = (cur.v - b15.v) / ((cur.t - b15.t) / 60000);
  // Still falling over the last 5 minutes too, so a single odd reading doesn't count.
  if (Math.round(-rate * 15 * 10) / 10 < FALL_DROP || cur.v >= b5.v || cur.v >= FALL_FROM_BELOW) return null;
  return { bg: cur.v, drop: Math.round((b15.v - cur.v) * 10) / 10, minutes: Math.round((cur.t - b15.t) / 60000), rate: Math.round(rate * 100) / 100, night: isNight(cur.t) };
}

export function fallMessage(f, low = 4) {
  const where = f.bg < low ? `He's ${f.bg.toFixed(1)} and still falling` : `Down ${f.drop.toFixed(1)} in ${f.minutes} min, now ${f.bg.toFixed(1)}`;
  const body = f.night
    ? `${where}. He may be heading low, or lying on his sensor (that can show a false drop). Check him with a finger-prick.`
    : `${where}. Prepare for a possible low: check him and have 15 g of fast carbs ready.`;
  return { title: `Falling fast: ${f.bg.toFixed(1)} mmol/L`, body, tag: 'falling-fast' };
}

export async function checkFall(env, logged, now = Date.now(), { low = 4 } = {}) {
  if (!env.LOG || !env.VAPID_PRIVATE_JWK) return null;
  const newest = logged.reduce((a, p) => (!a || p.time > a.time ? p : a), null);
  if (!newest) return null;
  const f = fallingFast(logged.filter((p) => p.source === newest.source && now - p.time <= 30 * 60000), now);
  if (!f || (await env.LOG.get(FALL_KEY))) return null;
  await env.LOG.put(FALL_KEY, new Date(now).toISOString(), { expirationTtl: FALL_QUIET_S });
  return sendToAll(env, fallMessage(f, low), 'fall');
}
