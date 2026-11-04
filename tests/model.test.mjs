import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayRows, sumsOf, fitSums, evaluate, storeDay, refit, MODEL_KEY } from '../worker/model.js';
import { featureRow, forecastNow, onBoard } from '../forecast.js';

const MIN = 60000;
const DAY = 24 * 3600000;
const SA = 2 * 3600000;

function memoryKv() {
  const data = new Map();
  return {
    async get(key, type) { const v = data.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
  };
}

// A simple simulated child: carbs raise BG 0.1 mmol/L per gram as they're absorbed
// (0.5 g/min after 15 min); insulin lowers it 1.5 mmol/L per unit over 4 hours.
// Meals at 07:00, 12:30 and 18:00 SA with a dose of carbs/10; slow drift; reading noise.
function simulateDay(start, seed = 1) {
  let rnd = seed;
  const noise = () => { rnd = (rnd * 16807) % 2147483647; return (rnd / 2147483647 - 0.5) * 0.2; };
  const events = [];
  [7, 12.5, 18].forEach((h, i) => {
    const carbs = 30 + ((seed + i) % 4) * 10;
    events.push({ type: 'dose', at: new Date(start + h * 3600000 - SA).toISOString(), carbs, insulinGiven: Math.round((carbs / 10) * 2 * (0.8 + ((seed + i) % 3) * 0.15)) / 2 });
  });
  const points = [];
  let g = 6.5;
  for (let t = start - SA - 60 * MIN; t < start - SA + DAY + 90 * MIN; t += MIN) {
    let dg = (6.5 - g) * 0.002; // drifts back slowly
    for (const e of events) {
      const m = (t - Date.parse(e.at)) / MIN;
      if (m > 15 && m <= 15 + e.carbs / 0.5) dg += 0.5 * 0.1;
      if (m > 0 && m <= 240) dg -= (e.insulinGiven * 1.5) / 240;
    }
    g = Math.max(2.5, g + dg);
    points.push({ t, v: Math.round((g + noise()) * 10) / 10 });
  }
  return { points, events, from: start - SA, to: start - SA + DAY };
}
const dayStart = (i) => Date.UTC(2026, 9, 1 + i);

test('inputs: insulin and carbs on board follow the 4-hour and 0.5 g/min rules', () => {
  const t0 = Date.UTC(2026, 9, 1, 10);
  const events = [{ type: 'dose', at: new Date(t0).toISOString(), carbs: 40, insulinGiven: 4 }];
  assert.deepEqual(onBoard(events, t0 + 60 * MIN), { iob: 3, cob: 17.5 });
  assert.deepEqual(onBoard(events, t0 + 240 * MIN), { iob: 0, cob: 0 });
  const pts = [0, 5, 15, 30].map((m) => ({ t: t0 - m * MIN, v: 8 - m * 0.05 })).reverse();
  const x = featureRow(pts, [], t0);
  assert.equal(x[1], 8);
  assert.ok(Math.abs(x[4] - 1.5) < 1e-9, 'd30');
  assert.equal(featureRow(pts.slice(1), [], t0 - 30 * MIN), null, 'needs 30 minutes of readings');
});

test('fit: learns that carbs raise and insulin lowers, and beats "stays the same"', () => {
  const train = [], hold = [];
  for (let i = 0; i < 10; i++) {
    const { points, events, from, to } = simulateDay(dayStart(i), i + 3);
    (i < 8 ? train : hold).push(...dayRows(points, events, from, to));
  }
  const s = sumsOf(train);
  const c30 = fitSums(s, 30);
  const c60 = fitSums(s, 60);
  assert.ok(c30[6] > 0 && c60[6] > 0, 'carbs on board raise the forecast');
  assert.ok(c30[5] <= 0 && c60[5] <= 0, 'insulin on board lowers it');
  const ev = evaluate(hold, c30, c60);
  assert.ok(ev.rmse30 < ev.base30 * 0.8, `30 min ${ev.rmse30} vs ${ev.base30}`);
  assert.ok(ev.rmse60 < ev.base60 * 0.8, `60 min ${ev.rmse60} vs ${ev.base60}`);
  assert.ok(ev.q30[0] < 0 && ev.q30[1] > 0);
});

test('sign rule: insulin can never push the forecast up, even if the data says so', () => {
  // Rows where insulin on board goes with a later rise (e.g. insulin given with a big meal).
  const rows = Array.from({ length: 400 }, (_, i) => {
    const iob = (i % 10) / 2;
    return [7, 0, 0, 0, iob, 0, 0, 1, iob * 0.4, iob * 0.6];
  });
  const c = fitSums(sumsOf(rows), 30);
  assert.equal(c[5], 0);
});

test('refit: learning until 7 days, then tested on the latest days it was not fitted on', async () => {
  const env = { LOG: memoryKv() };
  const dates = [];
  for (let i = 0; i < 9; i++) {
    const { points, events, from, to } = simulateDay(dayStart(i), i + 5);
    const date = new Date(dayStart(i)).toISOString().slice(0, 10);
    await storeDay(env, date, dayRows(points, events, from, to));
    dates.push(date);
  }
  const early = await refit(env, dates.slice(0, 4));
  assert.equal(early.learning, true);
  assert.equal(early.days, 4);
  const m = await refit(env, dates);
  assert.equal(m.days, 9);
  assert.equal(m.eval.days, 2);
  assert.equal(m.ready30, true);
  assert.equal(m.coef30.length, 9);
  assert.deepEqual(await env.LOG.get(MODEL_KEY, 'json'), m);
});

test('live forecast: range around the prediction, and a "may go low" note when falling toward low', () => {
  const model = { ready30: true, ready60: true, coef30: [0, 0, 0, 0, 1, 0, 0, 0, 0], coef60: [0, 0, 0, 0, 2, 0, 0, 0, 0], eval: { q30: [-0.8, 0.8], q60: [-1.5, 1.5] } };
  const now = Date.now();
  const history = [30, 15, 5, 0].map((m) => ({ mmol: 6 + m * 0.05, time: new Date(now - m * 60000).toISOString() }));
  const f = forecastNow(model, history, []);
  assert.equal(f.bg, 6);
  assert.equal(f.at30.v, 4.5); // falling 1.5 per 30 min
  assert.deepEqual([f.at30.lo, f.at30.hi], [3.7, 5.3]);
  assert.equal(f.at60.v, 3);
  assert.equal(f.mayGoLow, true);
  assert.equal(forecastNow({ ...model, ready30: false }, history, []), null, 'not shown unless it beat "stays the same"');
  assert.equal(forecastNow(model, history.slice(2), []), null, 'needs 30 minutes of readings');
});
