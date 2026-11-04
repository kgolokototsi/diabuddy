// His dose settings, kept in the relay's private store (not the public repo).
// Only an admin phone can change them; every change is kept with who made it.

const FIELDS = {
  icr: { min: 1, max: 150, required: true },
  cf: { min: 0.5, max: 30, required: true },
  targetBg: { min: 3, max: 15, required: true },
  hypoThreshold: { min: 2.5, max: 6, required: true },
  maxDose: { min: 0.5, max: 50, required: false },
};
const HISTORY_TTL_S = 2 * 365 * 24 * 3600;

// Returns { settings } or { error } naming the first bad field.
export function validateSettings(input) {
  if (!input || typeof input !== 'object') return { error: 'bad_settings' };
  const out = {};
  for (const [key, rule] of Object.entries(FIELDS)) {
    const v = input[key];
    if (v == null || v === '') {
      if (rule.required) return { error: `missing_${key}` };
      out[key] = null;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < rule.min || v > rule.max) return { error: `bad_${key}` };
    out[key] = v;
  }
  if (![0.5, 1].includes(input.roundTo)) return { error: 'bad_roundTo' };
  if (typeof input.negativeCorrection !== 'boolean') return { error: 'bad_negativeCorrection' };
  out.roundTo = input.roundTo;
  out.negativeCorrection = input.negativeCorrection;
  return { settings: out };
}

export async function readSettings(env) {
  return (await env.LOG.get('settings', 'json')) || null;
}

export async function settingsHistory(env, limit = 50) {
  const page = await env.LOG.list({ prefix: 'settings-history:' });
  const keys = page.keys.map((k) => k.name).sort().reverse().slice(0, limit);
  return (await Promise.all(keys.map((k) => env.LOG.get(k, 'json')))).filter(Boolean);
}

export async function writeSettings(env, input, device) {
  const { settings, error } = validateSettings(input);
  if (error) return { error };
  const before = (await readSettings(env)) || {};
  const changes = Object.keys(settings).filter((k) => before[k] !== settings[k]).map((k) => ({ field: k, from: before[k] ?? null, to: settings[k] }));
  const now = new Date().toISOString();
  const next = { ...settings, updatedAt: now, updatedBy: device.name };
  await env.LOG.put('settings', JSON.stringify(next));
  if (changes.length) {
    await env.LOG.put(`settings-history:${now}`, JSON.stringify({ at: now, by: device.name, changes }), { expirationTtl: HISTORY_TTL_S });
  }
  return { settings: next, changes };
}
