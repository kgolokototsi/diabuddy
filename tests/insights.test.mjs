import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInvite } from '../worker/auth.js';
import { responses, moments, toPoints, daySummary, buildNextDay, readInsights, saDate } from '../worker/insights.js';
import { summaryInput, isoWeek } from '../worker/summary.js';

const MIN = 60000;
const MGDL = 18.0182;
const SA = 2 * 3600000;
// SA local time → ms.
const sa = (iso) => Date.parse(`${iso}Z`) - SA;

function memoryKv() {
  const data = new Map();
  let writes = 0;
  return {
    async get(key, type) { const v = data.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { writes++; data.set(key, value); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) { return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
    has: (key) => data.has(key),
    keys: () => [...data.keys()],
    get writes() { return writes; },
  };
}

// Readings every `every` minutes from..to, glucose given by f(minutes since from), stored by UTC day.
async function addReadings(LOG, from, to, f, every = 2, source = 'libre') {
  const byDay = new Map();
  for (let t = from; t <= to; t += every * MIN) {
    const key = `glucose:${new Date(t).toISOString().slice(0, 10)}`;
    if (!byDay.has(key)) byDay.set(key, (await LOG.get(key, 'json')) || []);
    byDay.get(key).push({ source, mgdl: Math.round(f((t - from) / MIN) * MGDL), time: t });
  }
  for (const [k, v] of byDay) await LOG.put(k, JSON.stringify(v));
}
const logged = (from, to, f, every = 2) => {
  const out = [];
  for (let t = from; t <= to; t += every * MIN) out.push({ source: 'libre', mgdl: Math.round(f((t - from) / MIN) * MGDL), time: t });
  return out;
};
const ev = (type, t, extra = {}) => ({ id: Math.random().toString(36).slice(2, 10), type, at: new Date(t).toISOString(), ...extra });
// Up from 6 to 9 at 60 min, then down to 7 at 180.
const mealCurve = (m) => (m <= 60 ? 6 + (3 * m) / 60 : 9 - (2 * (m - 60)) / 120);

test('meal response: rise, time to peak and 3-hour change, with meal of day', () => {
  const t0 = sa('2026-11-09T12:00:00');
  const pts = toPoints(logged(t0 - 30 * MIN, t0 + 200 * MIN, (m) => mealCurve(m - 30)));
  const [r] = responses([ev('dose', t0, { carbs: 40, insulinGiven: 4 })], pts);
  assert.equal(r.kind, 'meal');
  assert.equal(r.mealOfDay, 'lunch');
  assert.equal(r.peak, 30);
  assert.equal(r.peakMin, 60);
  assert.equal(r.end, 10);
  assert.equal(r.curve.length, 19);
  assert.equal(r.wentLow, false);
});

test('meals with too few readings, or with something else in the 3 hours, are left out', () => {
  const t0 = sa('2026-11-09T12:00:00');
  const short = toPoints(logged(t0, t0 + 60 * MIN, mealCurve));
  assert.equal(responses([ev('dose', t0, { carbs: 40, insulinGiven: 4 })], short).length, 0, 'coverage');
  const full = toPoints(logged(t0, t0 + 200 * MIN, mealCurve));
  const rs = responses([ev('dose', t0, { carbs: 40, insulinGiven: 4 }), ev('correction', t0 + 90 * MIN, { insulinGiven: 1 })], full);
  assert.ok(!rs.some((r) => r.kind === 'meal'), 'confounded by the correction');
});

test('low treatment (15-15): value at the 15-min recheck, and a second 15 g counted as a repeat', () => {
  const t0 = sa('2026-11-09T16:00:00');
  const f = (m) => (m <= 15 ? 3.4 + (0.4 * m) / 15 : m <= 30 ? 3.8 + (1.2 * (m - 15)) / 15 : 5 + (1.5 * (m - 30)) / 30);
  const pts = toPoints(logged(t0, t0 + 70 * MIN, f, 1));
  const rs = responses([ev('low-treatment', t0, { carbs: 15 }), ev('low-treatment', t0 + 16 * MIN, { carbs: 15 })], pts);
  assert.equal(rs.length, 1, 'the follow-up is not a separate low');
  assert.equal(rs[0].at15, 3.8);
  assert.equal(rs[0].recovered15, false);
  assert.equal(rs[0].repeats, 1);
  assert.equal(rs[0].curve.length, 13);
});

test('correction: lowest point and 3-hour change; a meal in the window leaves it out', () => {
  const t0 = sa('2026-11-09T21:00:00');
  const pts = toPoints(logged(t0, t0 + 190 * MIN, (m) => 15 - (7 * Math.min(m, 150)) / 150));
  const [r] = responses([ev('correction', t0, { insulinGiven: 1, bg: 15 })], pts);
  assert.equal(r.kind, 'correction');
  assert.equal(r.nadir, -70);
  assert.equal(r.end, -70);
  assert.equal(responses([ev('correction', t0, { insulinGiven: 1 }), ev('dose', t0 + 60 * MIN, { carbs: 20, insulinGiven: 2 })], pts).filter((x) => x.kind === 'correction').length, 0);
});

test('moments: level, slope, lowest in the next 45 min, insulin in the last 2 h', () => {
  const t0 = sa('2026-11-09T10:00:00');
  const pts = toPoints(logged(t0 - 30 * MIN, t0 + 120 * MIN, (m) => Math.max(3.2, 8 - 0.05 * m), 1));
  const ms = moments(pts, [ev('dose', t0 - 60 * MIN, { carbs: 30, insulinGiven: 3 })], { from: t0, to: t0 + 16 * MIN });
  const [m] = ms;
  assert.equal(m[0], 65);  // 8 − 0.05 × 30
  assert.ok(Math.abs(m[1] + 50) <= 5, `slope ${m[1]}`); // about −0.05 per min (readings are stored to 0.1)
  assert.equal(m[2], 43);  // lowest in the next 45 min: 4.25 → 4.3
  assert.equal(m[3], 1);
});

test('time-of-day blocks follow SA time across midnight UTC', () => {
  const night = sa('2026-11-09T01:00:00'); // 23:00 UTC on the 8th
  const s = daySummary('2026-11-09', logged(night, night + 30 * MIN, () => 3.5), []);
  assert.equal(s.blocks[0].n, 16);
  assert.equal(s.blocks[0].bands[0], 16, 'below low');
  assert.equal(s.blocks[1].n, 0);
});

test('summaries: yesterday once its late meals have had 3 hours, then older days, then stop', async () => {
  const LOG = memoryKv();
  const env = { LOG };
  await addReadings(LOG, sa('2026-11-08T06:00:00'), sa('2026-11-09T23:00:00'), () => 7, 5);
  assert.equal(await buildNextDay(env, sa('2026-11-10T02:00:00')), '2026-11-08', 'before 03:00 SA, yesterday waits');
  assert.equal(await buildNextDay(env, sa('2026-11-10T08:00:00')), '2026-11-09');
  assert.ok(LOG.has('insights-day:2026-11-09'));
  assert.equal(await buildNextDay(env, sa('2026-11-10T08:02:00')), '2026-11-07', 'no readings: marks the floor');
  const writes = LOG.writes;
  assert.equal(await buildNextDay(env, sa('2026-11-10T08:04:00')), null, 'caught up');
  assert.equal(LOG.writes, writes, 'nothing written when caught up');
});

// ---------------------------------------------------------------- relay routes

let anthropicCalls;
globalThis.fetch = async (url, init = {}) => {
  if (new URL(url).host === 'api.anthropic.com') {
    anthropicCalls.push(JSON.parse(init.body));
    const label = { headline: 'A steadier week.', points: ['More time in range in the mornings.'], discussWithTeam: null };
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(label) }], usage: { input_tokens: 900, output_tokens: 80 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};
beforeEach(() => { anthropicCalls = []; });

const { default: worker } = await import('../worker/worker.js');
const call = async (env, method, path, { key, body } = {}) => {
  const res = await worker.fetch(new Request(`https://diabuddy.example${path}`, {
    method, headers: { ...(key && { 'X-DiaBuddy-Key': key }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: () => {} });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const join = async (env, role) => {
  const { code } = await createInvite(env, { role, name: role, by: 'test' });
  return (await call(env, 'POST', '/enroll', { body: { code } })).body.token;
};

// A week of days with readings and a meal each day, built as summaries.
async function weekOfData(env, now) {
  for (let i = 1; i <= 8; i++) {
    const date = saDate(now - i * 86400000);
    const t0 = sa(`${date}T12:00:00`);
    await addReadings(env.LOG, sa(`${date}T00:00:00`), sa(`${date}T23:58:00`), (m) => (m > 720 && m < 900 ? mealCurve(m - 720) : 6.5), 5);
    await env.LOG.put(`event:${new Date(t0).toISOString()}:m${i}`, JSON.stringify(ev('dose', t0, { carbs: 40, insulinGiven: 4 })));
  }
  for (let i = 0; i < 9; i++) await buildNextDay(env, now);
}

test('GET /insights: any phone can read; it returns blocks, meal types, responses and coverage', async () => {
  const env = { LOG: memoryKv(), ANTHROPIC_API_KEY: 'sk-test' };
  const now = Date.now();
  await weekOfData(env, now);
  const tv = await join(env, 'tv');
  const res = await call(env, 'GET', '/insights', { key: tv });
  assert.equal(res.status, 200);
  assert.ok(res.body.coverage.days14 >= 7);
  assert.ok(res.body.coverage.meals >= 7);
  assert.equal(res.body.blocks[14].length, 4);
  assert.ok(res.body.mealTypes.lunch.n >= 7);
  assert.equal(res.body.low, 4);
  assert.equal(res.body.summaries, true);
  const direct = await readInsights(env, now);
  assert.equal(direct.responses.length, res.body.responses.length);
});

test('weekly summary: Claude gets only aggregates; once a week; refresh is admin-only, once a day; TV cannot start it', async () => {
  const env = { LOG: memoryKv(), ANTHROPIC_API_KEY: 'sk-test' };
  await weekOfData(env, Date.now());
  const [tv, family, admin] = [await join(env, 'tv'), await join(env, 'family'), await join(env, 'admin')];

  assert.equal((await call(env, 'POST', '/insights/summary', { key: tv })).status, 403);
  const first = await call(env, 'POST', '/insights/summary', { key: family });
  assert.equal(first.status, 201);
  assert.equal(first.body.summary.headline, 'A steadier week.');
  assert.equal(first.body.summary.week, isoWeek(Date.now()));
  const sent = JSON.stringify(anthropicCalls[0].messages);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(sent), 'no timestamps sent');
  assert.ok(!/mgdl|curve|moments|family|admin/i.test(sent), 'no raw readings or names sent');
  assert.equal(anthropicCalls[0].model, 'claude-opus-5-5');

  assert.equal((await call(env, 'POST', '/insights/summary', { key: family })).status, 200, 'already written');
  assert.equal(anthropicCalls.length, 1);
  assert.equal((await call(env, 'GET', '/insights/summary', { key: tv })).body.summary.headline, 'A steadier week.');
  assert.equal((await call(env, 'POST', '/insights/summary', { key: family, body: { refresh: true } })).status, 403);
  assert.equal((await call(env, 'POST', '/insights/summary', { key: admin, body: { refresh: true } })).status, 201);
  assert.equal((await call(env, 'POST', '/insights/summary', { key: admin, body: { refresh: true } })).status, 429);
});

test('summary input holds only percentages, medians and counts', async () => {
  const env = { LOG: memoryKv() };
  const now = sa(`${saDate(Date.now())}T12:00:00`); // midday, so yesterday is built
  await weekOfData(env, now);
  const input = await summaryInput(env, now);
  assert.ok(input.thisWeek.daysWithReadings >= 3);
  assert.equal(input.mealsThisWeek.lunch.meals, 7);
  assert.ok(!JSON.stringify(input).includes('"at"'));
});

test('a late log entry for an earlier day rebuilds that day; erase removes insights', async () => {
  const env = { LOG: memoryKv() };
  const now = Date.now();
  await weekOfData(env, now);
  const family = await join(env, 'family');
  const date = saDate(now - 2 * 86400000);
  assert.ok(env.LOG.has(`insights-day:${date}`));
  const res = await call(env, 'POST', '/events', { key: family, body: { type: 'correction', at: new Date(sa(`${date}T20:00:00`)).toISOString(), insulinGiven: 1 } });
  assert.equal(res.status, 201);
  assert.ok(!env.LOG.has(`insights-day:${date}`), 'rebuilt on a later run');
  assert.equal(await buildNextDay(env, now), date);

  const admin = await join(env, 'admin');
  assert.equal((await call(env, 'POST', '/erase', { key: admin, body: { what: 'all' } })).status, 200);
  assert.ok(!env.LOG.keys().some((k) => k.startsWith('insights')));
});
