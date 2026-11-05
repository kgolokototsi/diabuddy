// The meal & dose log: one entry per dose, low treatment or correction.

// One KV key per entry (event:<ISO time>:<id>), so two phones saving at once can't
// overwrite each other. Kept a year.
export const EVENT_TTL_S = 365 * 24 * 3600;
export const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
export const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

export function cleanEvent(body, now = Date.now()) {
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

export const eventKey = (e) => `event:${e.at}:${e.id}`;

export async function listEvents(env, days) {
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
