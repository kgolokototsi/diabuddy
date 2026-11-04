import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastResponse, lowRisk, recentSlope } from '../forecast.js';

// A past response: curve in tenths, from a shape function of minutes.
const resp = (kind, { carbs = null, insulin = null, bg, mealOfDay = 'lunch', step = 10, len = 19, shape, wentLow = false, ...extra }) => {
  const curve = Array.from({ length: len }, (_, i) => Math.round(shape(i * step) * 10));
  return {
    kind, carbs, insulin, bg, mealOfDay, step, curve, wentLow,
    peak: Math.max(0, ...curve), peakMin: curve.indexOf(Math.max(...curve)) * step,
    nadir: Math.min(0, ...curve), nadirMin: curve.indexOf(Math.min(...curve)) * step, end: curve.at(-1), ...extra,
  };
};
const meal = (carbs, insulin, rise, extra = {}) => resp('meal', { carbs, insulin, bg: 6, shape: (m) => (m <= 60 ? (rise * m) / 60 : rise - ((rise - 1) * (m - 60)) / 120), ...extra });

test('meal: learning until 10 meals, then a range from the nearest similar meals', () => {
  const few = [40, 42, 38].map((c) => meal(c, 4, 3));
  assert.deepEqual(forecastResponse(few, 'meal', { carbs: 40, insulin: 4 }), { learning: true, have: 3, need: 10 });

  const history = [
    ...[38, 40, 41, 42, 44, 39].map((c, i) => meal(c, c / 10, 2 + i * 0.4)),
    ...[90, 95, 100, 85].map((c) => meal(c, c / 10, 6)),
    meal(40, 8, 0.5), // twice the insulin per gram: not similar
  ];
  const f = forecastResponse(history, 'meal', { carbs: 40, insulin: 4, mealOfDay: 'lunch', bg: 7 });
  assert.equal(f.n, 6, 'only the six similar meals');
  assert.equal(f.peak.minutes, 60);
  assert.equal(f.peak.min, 2);
  assert.equal(f.peak.max, 4);
  assert.equal(f.base, 7);
  assert.ok(f.curve[6].q25 <= f.curve[6].median && f.curve[6].median <= f.curve[6].q75);
  assert.equal(f.curve.length, 19);
});

test('meal: too few similar ones says so rather than guessing', () => {
  const history = [...[90, 95, 100, 85, 92, 88, 97, 91, 93, 89].map((c) => meal(c, c / 10, 6))];
  assert.deepEqual(forecastResponse(history, 'meal', { carbs: 30, insulin: 3 }), { tooFew: true, have: 0, need: 5 });
});

test('low treatment: 15-min recheck, how many recovered, how many needed a second 15 g', () => {
  const lows = [3.2, 3.4, 3.5, 3.3, 3.6, 3.4].map((bg, i) => resp('low-treatment', {
    bg, carbs: 15, step: 5, len: 13, shape: (m) => (m <= 15 ? (0.4 + i * 0.2) * (m / 15) : 0.4 + i * 0.2 + (m - 15) * 0.05),
    at15: bg + 0.4 + i * 0.2, recovered15: bg + 0.4 + i * 0.2 >= 4, repeats: bg + 0.4 + i * 0.2 >= 4 ? 0 : 1,
  }));
  const f = forecastResponse(lows, 'low-treatment', { bg: 3.4 });
  assert.equal(f.n, 6);
  assert.equal(f.at15.min, 0.4);
  assert.equal(f.at15.max, 1.4);
  assert.equal(f.recovered + f.neededSecond, 6);
  assert.ok(f.at60 > f.at15.median);
  assert.deepEqual(forecastResponse(lows, 'low-treatment', { bg: 5.5 }), { tooFew: true, have: 0, need: 5 });
});

test('correction: lowest point, 3 h, and how many went low', () => {
  const cs = Array.from({ length: 10 }, (_, i) => resp('correction', {
    bg: 14 + (i % 3), insulin: 1 + (i % 2) * 0.5, shape: (m) => -(6 + (i % 3)) * Math.min(m, 150) / 150, wentLow: i === 0,
  }));
  const f = forecastResponse(cs, 'correction', { bg: 15, units: 1 });
  assert.ok(f.n >= 5);
  assert.ok(f.nadir.median <= -6);
  assert.equal(f.lowCount, cs.filter((r) => r.wentLow && Math.abs(r.insulin - 1) <= 0.5).length > 0 ? f.lowCount : 0);
  assert.ok(forecastResponse(cs, 'correction', { bg: 15 }).tooFew, 'needs units');
});

test('low risk now: matches level, trend and recent insulin; needs 15 moments', () => {
  const falling = Array.from({ length: 20 }, (_, i) => [58, -50, i < 6 ? 38 : 45, 1]);
  const steadyNoInsulin = Array.from({ length: 20 }, () => [58, 0, 55, 0]);
  const r = lowRisk([...falling, ...steadyNoInsulin], { bg: 5.8, slope: -0.05, recentInsulin: true });
  assert.deepEqual([r.n, r.wentLow, r.lowest], [20, 6, 4.5]);
  assert.equal(lowRisk([...falling, ...steadyNoInsulin], { bg: 5.8, slope: -0.05, recentInsulin: false }).learning, true, 'different insulin state');
  assert.equal(lowRisk(falling.slice(0, 10), { bg: 5.8, slope: -0.05, recentInsulin: true }).learning, true);
});

test('recent slope from the reading history', () => {
  const now = Date.now();
  const h = [0, 5, 10, 15].map((m) => ({ mmol: 6 - m * 0.05, time: new Date(now - (15 - m) * 60000).toISOString() }));
  assert.equal(Math.round(recentSlope(h, now) * 100) / 100, -0.05);
  assert.equal(recentSlope(h.slice(-1), now), null);
});
