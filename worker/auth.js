// Per-phone access for the relay.
//
// Each phone joins with a single-use invite (24 h) and gets its own random token.
// The relay keeps only a SHA-256 hash of each token, so a copy of the KV store
// can't be used to sign in. Roles limit what each phone can do, and any phone
// can be removed without touching the others.
//
// The old shared FAMILY_KEY / TV_KEY keep working as "legacy" phones until the
// admin turns them off, so the move never leaves the family unable to dose.

const PERMISSIONS = {
  admin: ['read', 'log', 'foods', 'scan', 'alerts', 'admin'],
  family: ['read', 'log', 'foods', 'scan', 'alerts'],
  tv: ['read'],
};
export const ROLES = Object.keys(PERMISSIONS);
export const can = (device, permission) => Boolean(device && PERMISSIONS[device.role]?.includes(permission));

const INVITE_TTL_S = 24 * 3600;

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newSecret(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Constant-time comparison so a key can't be guessed byte by byte from timing.
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const legacyOff = async (env) => Boolean(env.LOG && (await env.LOG.get('legacy-off')));
export const legacyKeysSet = (env) => Boolean(env.FAMILY_KEY || env.TV_KEY);

// Who is calling? Returns the device record, or null.
export async function authenticate(request, env, ctx) {
  const token = request.headers.get('X-DiaBuddy-Key') || '';
  if (token.length < 8 || token.length > 200) return null;

  if (legacyKeysSet(env) && !(await legacyOff(env))) {
    // Check both keys (no early exit) so timing doesn't reveal which one matched.
    const family = Boolean(env.FAMILY_KEY) && safeEqual(token, env.FAMILY_KEY);
    const tv = Boolean(env.TV_KEY) && safeEqual(token, env.TV_KEY);
    if (family) return { id: 'legacy-family', name: 'Old shared family link', role: 'family', legacy: true };
    if (tv) return { id: 'legacy-tv', name: 'Old TV key', role: 'tv', legacy: true };
  }

  if (!env.LOG) return null;
  const hash = await sha256Hex(token);
  const device = await env.LOG.get(`device:${hash}`, 'json');
  if (!device) return null;

  // "Last used" is updated at most once a day, to stay inside the free KV write budget.
  const today = new Date().toISOString().slice(0, 10);
  if (device.lastSeenDay !== today) {
    const write = env.LOG.put(`device:${hash}`, JSON.stringify({ ...device, lastSeenDay: today }));
    ctx?.waitUntil ? ctx.waitUntil(write) : await write;
  }
  return { ...device, hash };
}

export async function createInvite(env, { role, name, by }) {
  const code = newSecret(18);
  const expiresAt = new Date(Date.now() + INVITE_TTL_S * 1000).toISOString();
  await env.LOG.put(`invite:${await sha256Hex(code)}`, JSON.stringify({ role, name, by, expiresAt }), { expirationTtl: INVITE_TTL_S });
  return { code, expiresAt };
}

// Swap a single-use invite for a device token. The invite is deleted first, so it can't be used twice.
export async function enroll(env, code, deviceName) {
  if (typeof code !== 'string' || code.length < 16 || code.length > 100) return null;
  const key = `invite:${await sha256Hex(code)}`;
  const invite = await env.LOG.get(key, 'json');
  if (!invite || Date.parse(invite.expiresAt) < Date.now()) return null;
  await env.LOG.delete(key);
  const token = newSecret(32);
  const device = {
    id: `dev-${newSecret(9).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 16),
    name: (typeof deviceName === 'string' && deviceName.trim().slice(0, 40)) || invite.name || 'Phone',
    role: invite.role,
    createdAt: new Date().toISOString(),
    invitedBy: invite.by || null,
  };
  await env.LOG.put(`device:${await sha256Hex(token)}`, JSON.stringify(device));
  return { token, device };
}

export async function listDevices(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.LOG.list({ prefix: 'device:', cursor });
    for (const k of page.keys) {
      const d = await env.LOG.get(k.name, 'json');
      if (d) out.push({ ...d, hash: k.name.slice(7) });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export async function removeDevice(env, id) {
  const match = (await listDevices(env)).find((d) => d.id === id);
  if (!match) return false;
  await env.LOG.delete(`device:${match.hash}`);
  await env.LOG.delete(`push:${match.id}`); // and its alerts
  return true;
}

export async function turnOffLegacy(env) {
  await env.LOG.put('legacy-off', new Date().toISOString());
}

export async function legacyActive(env) {
  return legacyKeysSet(env) && !(await legacyOff(env));
}
