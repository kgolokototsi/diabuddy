import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateDose, roundToStep, parseBg, lineCarbs, isConfigured } from '../dose.js';

const settings = { icr: 15, cf: 3, targetBg: 6, roundTo: 0.5, maxDose: 8, hypoThreshold: 4, negativeCorrection: true };

test('worked example: 45 g, BG 12, target 6, ICR 15, CF 3 → 5.0 U', () => {
  const r = calculateDose({ carbs: 45, bg: 12, settings });
  assert.equal(r.status, 'ok');
  assert.equal(r.foodDose, 3);
  assert.equal(r.correction, 2);
  assert.equal(r.rounded, 5);
});

test('rounds to nearest half unit', () => {
  assert.equal(roundToStep(2.24, 0.5), 2);
  assert.equal(roundToStep(2.25, 0.5), 2.5);
  assert.equal(roundToStep(2.74, 0.5), 2.5);
  assert.equal(roundToStep(2.75, 0.5), 3);
  assert.equal(roundToStep(0.2, 0.5), 0);
});

test('no BG → food dose only', () => {
  const r = calculateDose({ carbs: 30, bg: null, settings });
  assert.equal(r.correction, 0);
  assert.equal(r.correctionNote, 'no-bg');
  assert.equal(r.rounded, 2);
});

test('below target applies negative correction, never below zero', () => {
  const r = calculateDose({ carbs: 30, bg: 4.5, settings }); // 2 − 0.5 = 1.5
  assert.equal(r.correction, -0.5);
  assert.equal(r.rounded, 1.5);
  const z = calculateDose({ carbs: 0, bg: 4.5, settings });
  assert.equal(z.rounded, 0);
  assert.equal(z.exact, 0);
});

test('negative correction can be switched off', () => {
  const r = calculateDose({ carbs: 30, bg: 4.5, settings: { ...settings, negativeCorrection: false } });
  assert.equal(r.correction, 0);
  assert.equal(r.correctionNote, 'negative-off');
  assert.equal(r.rounded, 2);
});

test('recent insulin skips a positive correction but keeps a negative one', () => {
  const hi = calculateDose({ carbs: 30, bg: 12, recentInsulin: true, settings });
  assert.equal(hi.correction, 0);
  assert.equal(hi.correctionNote, 'skipped-recent');
  assert.equal(hi.rounded, 2);
  const lo = calculateDose({ carbs: 30, bg: 4.5, recentInsulin: true, settings });
  assert.equal(lo.correction, -0.5);
});

test('hypo blocks the dose', () => {
  assert.equal(calculateDose({ carbs: 30, bg: 3.5, settings }).status, 'hypo');
  assert.equal(calculateDose({ carbs: 30, bg: 4.0, settings }).status, 'ok');
});

test('implausible BG is rejected', () => {
  assert.equal(calculateDose({ carbs: 30, bg: 0.5, settings }).status, 'invalid-bg');
  assert.equal(calculateDose({ carbs: 30, bg: 40, settings }).status, 'invalid-bg');
  assert.equal(calculateDose({ carbs: 30, bg: NaN, settings }).status, 'invalid-bg');
});

test('max dose warning', () => {
  assert.equal(calculateDose({ carbs: 150, bg: 6, settings }).overMax, true);
  assert.equal(calculateDose({ carbs: 30, bg: 6, settings }).overMax, false);
  assert.equal(calculateDose({ carbs: 150, bg: 6, settings: { ...settings, maxDose: null } }).overMax, false);
});

test('unconfigured settings block calculation', () => {
  assert.equal(calculateDose({ carbs: 30, bg: 8, settings: { icr: null, cf: 3, targetBg: 6 } }).status, 'not-configured');
  assert.equal(isConfigured(null), false);
});

test('parseBg accepts comma decimals', () => {
  assert.equal(parseBg('8,4'), 8.4);
  assert.equal(parseBg(' 12 '), 12);
  assert.equal(parseBg(''), null);
  assert.ok(Number.isNaN(parseBg('abc')));
});

test('lineCarbs scales servings and ignores free foods', () => {
  assert.equal(lineCarbs({ netCarbs: 24 }, 1.5), 36);
  assert.equal(lineCarbs({ netCarbs: 0, free: true }, 3), 0);
});
