// Fits his personal 30/60-minute forecast (the inputs are in ../forecast.js).
//
// A linear model of the change in BG, fitted by ridge regression. Each day keeps only
// running sums (XᵀX, Xᵀy), so a nightly refit over 60 days is a few small reads.
// Physiological rules are enforced: more insulin on board can only lower the forecast and
// more carbs on board can only raise it (deep models without this can predict a rise
// after insulin; Zhu et al.). It is then tested on his most recent days, which it wasn't
// fitted on, against simply assuming his BG stays where it is, and is only marked ready
// if it does better.

import { featureRow, valueAt, MODEL_FEATURES } from '../forecast.js';

const P = MODEL_FEATURES.length;
const MIN = 60000;
// Typical size of each input, so the ridge penalty treats them alike (bias unpenalised).
const SCALE = [0, 3, 0.3, 0.8, 1.5, 1.5, 20, 0.7, 0.7];
const SIGN = { 5: -1, 6: 1 }; // iob coefficient ≤ 0, cob coefficient ≥ 0
const LAMBDA = 0.01;
const SUM_TTL_S = 120 * 24 * 3600;
const ROWS_TTL_S = 20 * 24 * 3600;
export const MODEL_KEY = 'forecast-model';
export const MIN_DAYS = 7;
const FIT_DAYS = 60;

const round2 = (v) => Math.round(v * 100) / 100;

// Training rows for one day: inputs every 5 minutes with the actual change 30 and 60 minutes later.
export function dayRows(points, events, from, to) {
  const rows = [];
  for (let t = Math.ceil(from / (5 * MIN)) * 5 * MIN; t < to; t += 5 * MIN) {
    const x = featureRow(points, events, t);
    if (!x) continue;
    const g30 = valueAt(points, t + 30 * MIN, 4 * MIN);
    const g60 = valueAt(points, t + 60 * MIN, 4 * MIN);
    if (g30 == null || g60 == null) continue;
    rows.push([...x.slice(1).map(round2), round2(g30 - x[1]), round2(g60 - x[1])]);
  }
  return rows;
}
const xOf = (row) => [1, ...row.slice(0, P - 1)];

export function sumsOf(rows) {
  const s = { n: 0, xtx: Array(P * P).fill(0), xy30: Array(P).fill(0), xy60: Array(P).fill(0) };
  for (const row of rows) {
    const x = xOf(row);
    const [y30, y60] = row.slice(P - 1);
    s.n++;
    for (let i = 0; i < P; i++) {
      s.xy30[i] += x[i] * y30;
      s.xy60[i] += x[i] * y60;
      for (let j = 0; j < P; j++) s.xtx[i * P + j] += x[i] * x[j];
    }
  }
  return s;
}

function mergeSums(list) {
  const s = { n: 0, xtx: Array(P * P).fill(0), xy30: Array(P).fill(0), xy60: Array(P).fill(0) };
  for (const d of list) {
    s.n += d.n;
    d.xtx.forEach((v, i) => { s.xtx[i] += v; });
    d.xy30.forEach((v, i) => { s.xy30[i] += v; });
    d.xy60.forEach((v, i) => { s.xy60[i] += v; });
  }
  return s;
}

// Solve A·b = y on the chosen inputs only (Gaussian elimination with partial pivoting).
function solveOn(A, y, idx) {
  const k = idx.length;
  const M = idx.map((i) => [...idx.map((j) => A[i * P + j]), y[i]]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  const b = Array(P).fill(0);
  idx.forEach((i, r) => { b[i] = M[r][k] / M[r][r]; });
  return b;
}

// Ridge fit with sign rules: an input that breaks its rule is fixed at 0 and the rest refitted.
export function fitSums(s, which) {
  const A = s.xtx.map((v, i) => (i % (P + 1) === 0 ? v + LAMBDA * s.n * SCALE[i / (P + 1)] ** 2 : v));
  const y = which === 30 ? s.xy30 : s.xy60;
  let idx = [...Array(P).keys()];
  for (let tries = 0; tries < 3; tries++) {
    const b = solveOn(A, y, idx);
    if (!b) return null;
    const broken = Object.entries(SIGN).filter(([i, sign]) => idx.includes(Number(i)) && b[i] * sign < 0).map(([i]) => Number(i));
    if (!broken.length) return b.map((v) => Math.round(v * 1e5) / 1e5);
    idx = idx.filter((i) => !broken.includes(i));
  }
  return null;
}

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = (s.length - 1) * q;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
};
const rmse = (xs) => Math.sqrt(xs.reduce((a, r) => a + r * r, 0) / Math.max(1, xs.length));
const dot = (coef, x) => coef.reduce((a, c, i) => a + c * x[i], 0);
const r2 = (v) => Math.round(v * 100) / 100;

// How the model does on days it wasn't fitted on, against "BG stays the same".
export function evaluate(rows, coef30, coef60, low = 4) {
  const res30 = [], res60 = [], y30s = [], y60s = [];
  let lows = 0, caught = 0, warned = 0, rightWarned = 0;
  const q = (res) => [quantile(res, 0.1), quantile(res, 0.9)];
  for (const row of rows) {
    const x = xOf(row);
    const [y30, y60] = row.slice(P - 1);
    res30.push(y30 - dot(coef30, x));
    res60.push(y60 - dot(coef60, x));
    y30s.push(y30);
    y60s.push(y60);
  }
  const q30 = q(res30);
  // Low warnings 30 minutes ahead: the low end of the band below his low threshold.
  rows.forEach((row) => {
    const x = xOf(row);
    if (x[1] < low) return; // already low: not a forecast
    const wentLow = x[1] + row[P - 1] < low;
    const warn = x[1] + dot(coef30, x) + q30[0] < low;
    if (wentLow) { lows++; if (warn) caught++; }
    if (warn) { warned++; if (wentLow) rightWarned++; }
  });
  return {
    n: rows.length,
    rmse30: r2(rmse(res30)), base30: r2(rmse(y30s)),
    rmse60: r2(rmse(res60)), base60: r2(rmse(y60s)),
    q30: q30.map(r2), q60: q(res60).map(r2),
    lows, caught, warned, rightWarned,
  };
}

export async function storeDay(env, date, rows) {
  await env.LOG.put(`fcsum:${date}`, JSON.stringify(sumsOf(rows)), { expirationTtl: SUM_TTL_S });
  await env.LOG.put(`fcrows:${date}`, JSON.stringify(rows), { expirationTtl: ROWS_TTL_S });
}

// Refit from the days built so far (dates: oldest first) and store the model.
export async function refit(env, dates, { low = 4, now = Date.now() } = {}) {
  const recent = dates.slice(-FIT_DAYS);
  const sums = (await Promise.all(recent.map(async (d) => [d, await env.LOG.get(`fcsum:${d}`, 'json')])))
    .filter(([, s]) => s && s.n > 50);
  const days = sums.map(([d]) => d);
  let model = { learning: true, days: days.length, need: MIN_DAYS, trainedAt: new Date(now).toISOString() };
  if (days.length >= MIN_DAYS) {
    // Hold back the most recent quarter of days (2–7) to test on.
    const holdN = Math.max(2, Math.min(7, Math.round(days.length / 4)));
    const train = mergeSums(sums.slice(0, -holdN).map(([, s]) => s));
    const holdRows = (await Promise.all(days.slice(-holdN).map((d) => env.LOG.get(`fcrows:${d}`, 'json')))).flat().filter(Boolean);
    const t30 = fitSums(train, 30);
    const t60 = fitSums(train, 60);
    const all = mergeSums(sums.map(([, s]) => s));
    const coef30 = fitSums(all, 30);
    const coef60 = fitSums(all, 60);
    if (t30 && t60 && coef30 && coef60 && holdRows.length >= 100) {
      const ev = { ...evaluate(holdRows, t30, t60, low), days: holdN };
      model = {
        version: 1,
        trainedAt: new Date(now).toISOString(),
        through: days.at(-1),
        days: days.length,
        rows: all.n,
        features: MODEL_FEATURES,
        coef30,
        coef60,
        eval: ev,
        ready30: ev.rmse30 < ev.base30 * 0.95,
        ready60: ev.rmse60 < ev.base60 * 0.95,
      };
    }
  }
  await env.LOG.put(MODEL_KEY, JSON.stringify(model));
  return model;
}
