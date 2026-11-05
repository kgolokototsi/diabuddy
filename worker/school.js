// School lunch: his parents plan today's lunches, one for each break (first break at
// lunch:<SA date>, second break at lunch:<SA date>:2); his teacher's phone sees them with the
// dose, sets how much he ate and records the dose given. The relay works out the carbs and
// the dose itself, so the teacher's phone can only record what was planned.

import { calculateDose, BG_MIN, BG_MAX } from '../dose.js';
import { can } from './auth.js';
import { cleanEvent, eventKey, listEvents, num, str, EVENT_TTL_S } from './events.js';
import { invalidateDay, saDate } from './insights.js';
import { readSettings } from './settings.js';

const LUNCH_TTL_S = 45 * 24 * 3600; // kept a while after the day, as a record of what was dosed
const MAX_ITEMS = 12;
const UNDO_MS = 15 * 60000; // the teacher can undo their own entry this long; parents any time
const RECENT_INSULIN_MS = 3 * 3600000;
const FRACTIONS = [0, 0.25, 0.5, 0.75, 1];
export const LOW_TREATMENT_G = 15;
const DOSE_FIELDS = ['icr', 'cf', 'targetBg', 'roundTo', 'maxDose', 'hypoThreshold', 'negativeCorrection', 'updatedAt'];

export const SLOTS = [1, 2]; // first break, second break
const SLOT_NAMES = { 1: 'first break', 2: 'second break' };
const lunchKey = (date, slot = 1) => (slot === 1 ? `lunch:${date}` : `lunch:${date}:${slot}`);
const isLunchNote = (note) => note === 'School lunch' || note === 'At school' || SLOTS.some((s) => note === `School lunch (${SLOT_NAMES[s]})`);
const newId = () => crypto.getRandomValues(new Uint32Array(2)).reduce((s, n) => s + n.toString(36), '').slice(0, 12).padEnd(8, '0');

export function cleanLunch(body, date, slot = 1) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.items) || body.items.length > MAX_ITEMS) return null;
  const items = [];
  for (const it of body.items) {
    const name = str(it?.name, 60)?.trim();
    const carbs = num(it?.carbs, 0, 200);
    if (!name || carbs == null) return null;
    const item = { id: /^[a-z0-9]{4,16}$/.test(it.id) ? it.id : newId(), name, carbs: Math.round(carbs * 10) / 10 };
    // From the food database: the serving and how many, for the screens.
    const serving = str(it.serving, 60)?.trim();
    const servings = num(it.servings, 0.25, 20);
    const perServing = num(it.perServing, 0, 200);
    if (serving && servings != null && perServing != null) Object.assign(item, { serving, servings, perServing });
    items.push(item);
  }
  if (!items.length) return null;
  return { date, slot, items, note: str(body.note, 200)?.trim() || null };
}

// Carbs he ate: each planned item × how much of it he ate (missing means all of it).
export function eatenCarbs(lunch, eaten = {}) {
  const parts = [];
  for (const item of lunch.items) {
    const f = eaten && Object.hasOwn(eaten, item.id) ? eaten[item.id] : 1;
    if (!FRACTIONS.includes(f)) return null;
    parts.push({ item, fraction: f, carbs: Math.round(item.carbs * f * 10) / 10 });
  }
  return { parts, carbs: Math.round(parts.reduce((s, p) => s + p.carbs, 0) * 10) / 10 };
}

const doseSettings = (s) => (s ? Object.fromEntries(DOSE_FIELDS.map((k) => [k, s[k] ?? null])) : null);

async function recentInsulin(env, now) {
  return (await listEvents(env, 1)).some((e) => e.insulinGiven > 0 && now - Date.parse(e.at) <= RECENT_INSULIN_MS);
}


export async function handleSchool(request, env, device, url, cors, json, readJson, now = Date.now()) {
  const plan = can(device, 'lunch');
  if (!plan && !can(device, 'school')) return json({ error: 'not_allowed' }, 403, cors);
  const today = saDate(now);
  // ['school'], ['school', date, slot?, 'record'?] or ['school', 'record', id].
  // A missing slot means the first break, as older versions of the app send.
  const parts = url.pathname.split('/').filter(Boolean);
  const method = request.method;

  if (parts.length === 1 && method === 'GET') {
    const settings = await readSettings(env);
    const lunches = [];
    for (const slot of SLOTS) {
      const lunch = await env.LOG.get(lunchKey(today, slot), 'json');
      if (lunch) lunches.push({ ...lunch, slot });
    }
    return json({ today, lunches, settings: doseSettings(settings), recentInsulin: await recentInsulin(env, now) }, 200, cors);
  }

  // Undo an entry made from the lunch screen.
  if (parts[1] === 'record' && parts.length === 3 && method === 'DELETE') {
    const id = parts[2];
    if (!/^[a-z0-9]{6,20}$/.test(id)) return json({ error: 'bad_id' }, 400, cors);
    const event = (await listEvents(env, 2)).find((e) => e.id === id);
    if (!event || !isLunchNote(event.note)) return json({ error: 'not_found' }, 404, cors);
    if (!plan && (event.device !== device.id || now - Date.parse(event.savedAt) > UNDO_MS)) return json({ error: 'undo_expired' }, 403, cors);
    await env.LOG.delete(eventKey(event));
    const lunchDate = saDate(Date.parse(event.at));
    for (const slot of SLOTS) {
      const lunch = await env.LOG.get(lunchKey(lunchDate, slot), 'json');
      if (lunch?.recorded?.eventId !== id) continue;
      delete lunch.recorded;
      await env.LOG.put(lunchKey(lunchDate, slot), JSON.stringify(lunch), { expirationTtl: LUNCH_TTL_S });
    }
    await invalidateDay(env, event.at, now);
    return json({ deleted: id }, 200, cors);
  }

  const date = parts[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || Number.isNaN(Date.parse(date))) return json({ error: 'bad_date' }, 400, cors);
  let slot = 1;
  if (/^\d+$/.test(parts[2] || '')) {
    slot = Number(parts[2]);
    if (!SLOTS.includes(slot)) return json({ error: 'bad_slot' }, 400, cors);
    parts.splice(2, 1); // the routes below are the same for each break
  }
  const key = lunchKey(date, slot);
  const existing = await env.LOG.get(key, 'json');

  if (parts.length === 2 && method === 'PUT') {
    if (!plan) return json({ error: 'not_allowed' }, 403, cors);
    if (date !== today) return json({ error: 'bad_date' }, 400, cors); // today's lunch only
    if (existing?.recorded) return json({ error: 'already_recorded', recorded: existing.recorded }, 409, cors);
    const { body, bad, tooLarge } = await readJson(request, 6000);
    const lunch = bad || tooLarge ? null : cleanLunch(body, date, slot);
    if (!lunch) return json({ error: 'bad_lunch' }, 400, cors);
    Object.assign(lunch, { updatedBy: device.name, updatedAt: new Date(now).toISOString() });
    await env.LOG.put(key, JSON.stringify(lunch), { expirationTtl: LUNCH_TTL_S });
    return json({ lunch }, 200, cors);
  }

  if (parts.length === 2 && method === 'DELETE') {
    if (!plan) return json({ error: 'not_allowed' }, 403, cors);
    if (existing?.recorded) return json({ error: 'already_recorded', recorded: existing.recorded }, 409, cors);
    await env.LOG.delete(key);
    return json({ deleted: date, slot }, 200, cors);
  }

  if (parts.length === 3 && parts[2] === 'record' && method === 'POST') {
    if (date !== today) return json({ error: 'not_today' }, 400, cors);
    const { body, bad, tooLarge } = await readJson(request, 2000);
    if (bad || tooLarge || !body || typeof body !== 'object') return json({ error: 'bad_request' }, 400, cors);
    const bg = body.bg == null ? null : num(body.bg, BG_MIN, BG_MAX);
    if (body.bg != null && bg == null) return json({ error: 'bad_bg' }, 400, cors);
    const settings = await readSettings(env);
    const base = {
      id: newId(),
      at: new Date(now).toISOString(),
      bg,
      bgSource: bg == null ? null : body.bgSource,
      settings: settings && { icr: settings.icr, cf: settings.cf, targetBg: settings.targetBg },
      device: device.id,
    };

    if (body.type === 'low-treatment') {
      const event = cleanEvent({ ...base, type: 'low-treatment', carbs: LOW_TREATMENT_G, insulinGiven: 0, note: 'At school' }, now);
      await env.LOG.put(eventKey(event), JSON.stringify(event), { expirationTtl: EVENT_TTL_S });
      return json({ event }, 201, cors);
    }

    if (!existing) return json({ error: 'no_lunch' }, 404, cors);
    if (existing.recorded && body.confirmAgain !== true) return json({ error: 'already_recorded', recorded: existing.recorded }, 409, cors);
    const ate = eatenCarbs(existing, body.eaten);
    const insulinGiven = num(body.insulinGiven, 0, 50);
    if (!ate || insulinGiven == null) return json({ error: 'bad_request' }, 400, cors);
    const recent = body.recentInsulin === true;
    const r = calculateDose({ carbs: ate.carbs, bg, recentInsulin: recent, settings });
    if (r.status === 'not-configured') return json({ error: 'settings_missing' }, 503, cors);
    if (r.status === 'hypo') return json({ error: 'bg_low' }, 400, cors);
    if (r.status !== 'ok') return json({ error: 'bad_bg' }, 400, cors);

    const event = cleanEvent({
      ...base,
      type: 'dose',
      carbs: ate.carbs,
      foods: ate.parts.filter((p) => p.fraction > 0).map((p) => ({ name: p.item.name, servings: p.fraction, carbs: p.carbs, source: 'school' })),
      insulinGiven,
      calculated: { rounded: r.rounded, exact: Math.round(r.exact * 100) / 100, food: Math.round(r.foodDose * 100) / 100, correction: Math.round(r.correction * 100) / 100 },
      recentInsulin: recent,
      note: `School lunch (${SLOT_NAMES[slot]})`,
    }, now);
    await env.LOG.put(eventKey(event), JSON.stringify(event), { expirationTtl: EVENT_TTL_S });
    existing.recorded = { eventId: event.id, at: event.at, units: insulinGiven, carbs: ate.carbs, by: device.name, deviceId: device.id };
    await env.LOG.put(key, JSON.stringify(existing), { expirationTtl: LUNCH_TTL_S });
    return json({ event, recorded: existing.recorded }, 201, cors);
  }

  return json({ error: 'not_found' }, 404, cors);
}
