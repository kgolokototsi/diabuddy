import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInvite } from '../worker/auth.js';
import { saDate } from '../worker/insights.js';
import { cleanLunch, eatenCarbs } from '../worker/school.js';

function memoryKv() {
  const data = new Map();
  return {
    async get(key, type) { const v = data.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) { return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
    data,
  };
}

globalThis.fetch = async () => new Response('{}', { status: 404 });
const { default: worker } = await import('../worker/worker.js');

const SETTINGS = { icr: 10, cf: 7, targetBg: 5, hypoThreshold: 4, maxDose: null, roundTo: 0.5, negativeCorrection: true };
const makeEnv = () => {
  const env = { LOG: memoryKv() };
  env.LOG.data.set('settings', JSON.stringify(SETTINGS));
  return env;
};
const call = async (env, method, path, { key, body } = {}) => {
  const res = await worker.fetch(new Request(`https://diabuddy.example${path}`, {
    method,
    headers: { ...(key && { 'X-DiaBuddy-Key': key }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: () => {} });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const join = async (env, role) => {
  const { code } = await createInvite(env, { role, name: role === 'school' ? 'Class teacher' : role, by: 'test' });
  return (await call(env, 'POST', '/enroll', { body: { code } })).body;
};
const today = () => saDate(Date.now());
const plusDays = (n) => saDate(Date.now() + n * 86400000);
const LUNCH = { items: [{ id: 'sand1', name: 'Cheese sandwich', carbs: 24 }, { id: 'appl1', name: 'Apple', carbs: 12 }], note: 'Juice box at break is not counted' };

async function setUp() {
  const env = makeEnv();
  const parent = await join(env, 'family');
  const teacher = await join(env, 'school');
  return { env, parent: parent.token, teacher: teacher.token, teacherId: teacher.device.id };
}

test('the teacher\'s phone sees only his reading, the lunch and alerts', async () => {
  const { env, teacher } = await setUp();
  for (const [method, path] of [['GET', '/events'], ['GET', '/insights'], ['GET', '/insights/model'], ['GET', '/settings'], ['GET', '/foods'], ['POST', '/scan-label'], ['POST', '/invites'], ['GET', '/devices'], ['PUT', `/school/${today()}`], ['DELETE', `/school/${today()}`], ['POST', '/events']]) {
    const { status } = await call(env, method, path, { key: teacher, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
    assert.equal(status, 403, `${method} ${path}`);
  }
  const res = await call(env, 'GET', '/school', { key: teacher });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.settings).sort(), ['cf', 'hypoThreshold', 'icr', 'maxDose', 'negativeCorrection', 'roundTo', 'targetBg', 'updatedAt']);
  assert.notEqual((await call(env, 'GET', '/latest', { key: teacher })).status, 403);

  const tv = await join(env, 'tv');
  assert.equal((await call(env, 'GET', '/events', { key: tv.token })).status, 200);
  assert.equal((await call(env, 'GET', '/school', { key: tv.token })).status, 403);
});

test('parents plan only today\'s lunch; bad lunches are refused', async () => {
  const { env, parent, teacher } = await setUp();
  assert.equal((await call(env, 'PUT', `/school/${today()}`, { key: parent, body: LUNCH })).status, 200);
  assert.equal((await call(env, 'PUT', `/school/${plusDays(-1)}`, { key: parent, body: LUNCH })).status, 400, 'past day');
  assert.equal((await call(env, 'PUT', `/school/${plusDays(1)}`, { key: parent, body: LUNCH })).status, 400, 'tomorrow');
  assert.equal((await call(env, 'PUT', `/school/${today()}`, { key: parent, body: { items: [] } })).status, 400, 'no items');
  assert.equal((await call(env, 'PUT', `/school/${today()}`, { key: parent, body: { items: [{ name: 'Cake', carbs: 500 }] } })).status, 400, 'carbs out of range');
  assert.equal((await call(env, 'PUT', `/school/${today()}`, { key: parent, body: { items: Array.from({ length: 13 }, () => ({ name: 'x', carbs: 1 })) } })).status, 400, 'too many items');

  const seen = await call(env, 'GET', '/school', { key: teacher });
  assert.equal(seen.body.lunches.length, 1);
  assert.equal(seen.body.lunches[0].note, LUNCH.note);
  assert.equal(seen.body.lunches[0].updatedBy, 'family');
});

test('recording: the relay works out the carbs from what he ate, and the dose', async () => {
  const { env, parent, teacher, teacherId } = await setUp();
  await call(env, 'PUT', `/school/${today()}`, { key: parent, body: LUNCH });
  // Half the apple, all the sandwich: 24 + 6 = 30 g → 3 U, plus (8.5 − 5) ÷ 7 = 0.5 U.
  const res = await call(env, 'POST', `/school/${today()}/record`, { key: teacher, body: { eaten: { appl1: 0.5 }, carbs: 200, bg: 8.5, bgSource: 'libre', insulinGiven: 3.5, recentInsulin: false } });
  assert.equal(res.status, 201);
  assert.equal(res.body.event.carbs, 30, 'sent carbs are ignored');
  assert.equal(res.body.event.calculated.rounded, 3.5);
  assert.equal(res.body.event.note, 'School lunch');
  assert.equal(res.body.event.device, teacherId);
  assert.deepEqual(res.body.event.foods.map((f) => [f.name, f.servings, f.carbs]), [['Cheese sandwich', 1, 24], ['Apple', 0.5, 6]]);

  const log = await call(env, 'GET', '/events', { key: parent });
  assert.equal(log.body.events[0].id, res.body.event.id, 'in his log at home');
  const school = await call(env, 'GET', '/school', { key: teacher });
  assert.equal(school.body.lunches[0].recorded.units, 3.5);
  assert.equal(school.body.lunches[0].recorded.by, 'Class teacher');
  assert.equal(school.body.recentInsulin, true, 'the dose just given counts as recent insulin');

  assert.equal((await call(env, 'POST', `/school/${today()}/record`, { key: teacher, body: { eaten: { appl1: 0.3 }, bg: 8.5, insulinGiven: 3, confirmAgain: true } })).status, 400, 'fractions are quarters only');
});

test('double-dose guard: a second record needs confirmation; a recorded lunch can\'t be edited', async () => {
  const { env, parent, teacher } = await setUp();
  await call(env, 'PUT', `/school/${today()}`, { key: parent, body: LUNCH });
  const body = { eaten: {}, bg: 6, insulinGiven: 3.5 };
  assert.equal((await call(env, 'POST', `/school/${today()}/record`, { key: teacher, body })).status, 201);
  const again = await call(env, 'POST', `/school/${today()}/record`, { key: teacher, body });
  assert.equal(again.status, 409);
  assert.equal(again.body.recorded.units, 3.5);
  assert.equal((await call(env, 'PUT', `/school/${today()}`, { key: parent, body: LUNCH })).status, 409);
  assert.equal((await call(env, 'POST', `/school/${today()}/record`, { key: teacher, body: { ...body, confirmAgain: true } })).status, 201);
  assert.equal((await call(env, 'GET', '/events', { key: parent })).body.events.length, 2);
});

test('only today\'s lunch can be recorded, and not when he is low', async () => {
  const { env, parent, teacher } = await setUp();
  assert.equal((await call(env, 'POST', `/school/${plusDays(1)}/record`, { key: teacher, body: { bg: 6, insulinGiven: 3 } })).body.error, 'not_today');
  assert.equal((await call(env, 'POST', `/school/${today()}/record`, { key: teacher, body: { bg: 6, insulinGiven: 3 } })).body.error, 'no_lunch');
  await call(env, 'PUT', `/school/${today()}`, { key: parent, body: LUNCH });
  assert.equal((await call(env, 'POST', `/school/${today()}/record`, { key: teacher, body: { bg: 3.6, insulinGiven: 3 } })).body.error, 'bg_low');
});

test('low treatment at school: 15 g, recorded even with no lunch, and the lunch stays open', async () => {
  const { env, parent, teacher } = await setUp();
  const res = await call(env, 'POST', `/school/${today()}/record`, { key: teacher, body: { type: 'low-treatment', bg: 3.6, bgSource: 'typed', carbs: 50 } });
  assert.equal(res.status, 201);
  assert.equal(res.body.event.type, 'low-treatment');
  assert.equal(res.body.event.carbs, 15);
  assert.equal(res.body.event.note, 'At school');
  await call(env, 'PUT', `/school/${today()}`, { key: parent, body: LUNCH });
  assert.equal((await call(env, 'POST', `/school/${today()}/record`, { key: teacher, body: { bg: 5.2, insulinGiven: 3.5 } })).status, 201);
});

test('undo: the teacher within 15 minutes, parents any time; undoing reopens the lunch', async () => {
  const { env, parent, teacher } = await setUp();
  await call(env, 'PUT', `/school/${today()}`, { key: parent, body: LUNCH });
  const first = (await call(env, 'POST', `/school/${today()}/record`, { key: teacher, body: { bg: 6, insulinGiven: 3.5 } })).body.event;
  assert.equal((await call(env, 'DELETE', `/school/record/${first.id}`, { key: teacher })).status, 200);
  assert.equal((await call(env, 'GET', '/school', { key: teacher })).body.lunches[0].recorded, undefined);
  assert.equal((await call(env, 'GET', '/events', { key: parent })).body.events.length, 0);

  const second = (await call(env, 'POST', `/school/${today()}/record`, { key: teacher, body: { bg: 6, insulinGiven: 3.5 } })).body.event;
  const key = `event:${second.at}:${second.id}`;
  env.LOG.data.set(key, JSON.stringify({ ...second, savedAt: new Date(Date.now() - 20 * 60000).toISOString() }));
  assert.equal((await call(env, 'DELETE', `/school/record/${second.id}`, { key: teacher })).body.error, 'undo_expired');
  assert.equal((await call(env, 'DELETE', `/school/record/${second.id}`, { key: parent })).status, 200);

  // Only entries made from the lunch screen can be removed here.
  const other = (await call(env, 'POST', '/events', { key: parent, body: { type: 'dose', at: new Date().toISOString(), carbs: 20, insulinGiven: 2 } })).body.event;
  assert.equal((await call(env, 'DELETE', `/school/record/${other.id}`, { key: parent })).status, 404);
});

test('lunch and portion helpers', () => {
  assert.equal(cleanLunch({ items: [{ name: '  ', carbs: 3 }] }, '2026-11-06'), null);
  const l = cleanLunch({ items: [{ name: '<b>Wrap</b>', carbs: 20.04 }] }, '2026-11-06');
  assert.equal(l.items[0].carbs, 20, 'rounded to 0.1 g');
  assert.equal(l.items[0].name, '<b>Wrap</b>', 'stored as text; the app escapes it');
  assert.equal(eatenCarbs(l, { [l.items[0].id]: 0.75 }).carbs, 15);
  assert.equal(eatenCarbs(l, { [l.items[0].id]: 2 }), null);
  const food = cleanLunch({ items: [{ name: 'Weet-Bix', carbs: 42.6, serving: '2 biscuits (45 g)', servings: 1.5, perServing: 28.4 }, { name: 'Bad', carbs: 1, serving: 'x', servings: 99, perServing: 1 }] }, '2026-11-06');
  assert.deepEqual([food.items[0].serving, food.items[0].servings, food.items[0].perServing], ['2 biscuits (45 g)', 1.5, 28.4], 'database item keeps its serving');
  assert.equal(food.items[1].serving, undefined, 'out-of-range servings are dropped');
});
