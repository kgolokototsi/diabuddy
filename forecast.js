// Forecasts from his own history: find the past meals, low treatments or corrections most
// like this one and show what happened after them, as a range. No model is trained and
// nothing here works out a dose; the result is always "after N similar ones, he usually…".
//
// responses: from the relay's /insights (worker/insights.js). Curves are change from the
// starting BG in tenths of mmol/L, sampled every `step` minutes.

const NEED = { meal: 10, 'low-treatment': 6, correction: 10 }; // usable responses before forecasting
const MIN_MATCHES = 5;
const K = 12;
const LOW_RISK_NEED = 15;

function quantile(xs, q) {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}
const median = (xs) => quantile(xs, 0.5);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// How unlike the input a past response is (lower is closer), or null if too different.
function distance(kind, r, input) {
  if (kind === 'meal') {
    if (!(r.carbs > 0) || !(input.carbs > 0)) return null;
    const tol = Math.max(10, input.carbs * 0.4);
    const dc = Math.abs(r.carbs - input.carbs);
    if (dc > tol) return null;
    let d = dc / tol;
    if (input.insulin > 0 && r.insulin > 0) {
      const ratio = (r.insulin / r.carbs) / (input.insulin / input.carbs);
      if (Math.abs(ratio - 1) > 0.3) return null;
      d += Math.abs(ratio - 1) / 0.3;
    }
    if (input.mealOfDay && r.mealOfDay !== input.mealOfDay) d += 0.5;
    if (input.bg > 0) d += Math.abs(r.bg - input.bg) / 5;
    return d;
  }
  if (!(input.bg > 0)) return null;
  const db = Math.abs(r.bg - input.bg);
  if (kind === 'low-treatment') return db <= 0.7 ? db / 0.7 : null;
  // correction
  if (db > 2 || !(r.insulin > 0) || !(input.units > 0)) return null;
  const tol = Math.max(0.5, input.units * 0.3);
  const du = Math.abs(r.insulin - input.units);
  return du <= tol ? db / 2 + du / tol : null;
}

// kind: 'meal' | 'low-treatment' | 'correction'.
// input: { carbs, insulin, mealOfDay, bg } for a meal; { bg } for a low; { bg, units } for a correction.
export function forecastResponse(responses, kind, input, { low = 4 } = {}) {
  const pool = (responses || []).filter((r) => r.kind === kind && Array.isArray(r.curve));
  if (pool.length < NEED[kind]) return { learning: true, have: pool.length, need: NEED[kind] };
  const matches = pool.map((r) => ({ r, d: distance(kind, r, input) }))
    .filter((x) => x.d != null)
    .sort((a, b) => a.d - b.d)
    .slice(0, K)
    .map((x) => x.r);
  if (matches.length < MIN_MATCHES) return { tooFew: true, have: matches.length, need: MIN_MATCHES };

  const step = matches[0].step;
  const len = Math.min(...matches.map((r) => r.curve.length));
  const at = (i) => matches.map((r) => (r.curve[i] == null ? null : r.curve[i] / 10));
  const curve = Array.from({ length: len }, (_, i) => ({ min: i * step, median: round1(median(at(i))), q25: round1(quantile(at(i), 0.25)), q75: round1(quantile(at(i), 0.75)) }));
  const deltaAt = (min) => curve[Math.round(min / step)]?.median ?? null;
  const base = input.bg > 0 ? input.bg : null;

  const out = { kind, n: matches.length, step, base, curve, lowCount: matches.filter((r) => r.wentLow).length };
  if (kind === 'meal') {
    const peaks = matches.map((r) => r.peak / 10);
    out.peak = { median: round1(median(peaks)), min: round1(Math.min(...peaks)), max: round1(Math.max(...peaks)), minutes: Math.round(median(matches.map((r) => r.peakMin))) };
    out.end = round1(median(matches.map((r) => r.end / 10)));
  } else if (kind === 'low-treatment') {
    const d15 = at(Math.round(15 / step));
    out.at15 = { median: round1(median(d15)), min: round1(Math.min(...d15.filter((v) => v != null))), max: round1(Math.max(...d15.filter((v) => v != null))) };
    out.recovered = matches.filter((r) => r.recovered15).length;
    out.neededSecond = matches.filter((r) => r.repeats > 0).length;
    out.at30 = deltaAt(30);
    out.at60 = deltaAt(60);
  } else {
    const nadirs = matches.map((r) => r.nadir / 10);
    out.nadir = { median: round1(median(nadirs)), min: round1(Math.min(...nadirs)), minutes: Math.round(median(matches.map((r) => r.nadirMin))) };
    out.end = round1(median(matches.map((r) => r.end / 10)));
  }
  out.low = low;
  return out;
}

// "Low risk now": in past moments at about this level and trend (and the same
// insulin-in-the-last-2-hours state), how often did he go below low within 45 minutes?
// moments: [BG ×10, slope ×1000, lowest in next 45 min ×10, insulin in last 2 h].
export function lowRisk(moments, { bg, slope, recentInsulin }, { low = 4 } = {}) {
  const matches = (moments || []).filter((m) => Math.abs(m[0] / 10 - bg) <= 1 && Math.abs(m[1] / 1000 - slope) <= 0.04 && m[3] === (recentInsulin ? 1 : 0));
  if (matches.length < LOW_RISK_NEED) return { learning: true, have: matches.length, need: LOW_RISK_NEED };
  const lowest = matches.map((m) => m[2] / 10);
  return { n: matches.length, wentLow: lowest.filter((v) => v < low).length, lowest: round1(median(lowest)) };
}

// mmol/L per minute over about the last 15 minutes, from the reading history; null if unknown.
export function recentSlope(history, now = Date.now()) {
  const pts = (history || []).map((p) => ({ t: Date.parse(p.time), v: p.mmol })).filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const cur = pts.at(-1);
  if (!cur || now - cur.t > 10 * 60000) return null;
  const before = pts.filter((p) => cur.t - p.t >= 12 * 60000 && cur.t - p.t <= 18 * 60000)
    .sort((a, b) => Math.abs(cur.t - a.t - 15 * 60000) - Math.abs(cur.t - b.t - 15 * 60000))[0];
  return before ? (cur.v - before.v) / ((cur.t - before.t) / 60000) : null;
}

// ---------------------------------------------------------------- 30/60-minute forecast
//
// A small personal model, refitted each night on the relay (worker/model.js) from his own
// readings and log. It predicts the change in BG 30 and 60 minutes ahead (predicting the
// change rather than the level reduces bias; Zhu et al., IEEE JBHI) from:
//   his BG now and how it moved over the last 5, 15 and 30 minutes,
//   insulin on board (linear over 4 hours) and carbs on board (0.5 g/min after 15 minutes),
//   and time of day.
// The same code builds the inputs for training (relay) and for the live forecast (app).

export const MODEL_FEATURES = ['bias', 'bg', 'd5', 'd15', 'd30', 'iob', 'cob', 'sin', 'cos'];
const MIN_MS = 60000;
const IOB_MIN = 240;
const COB_RATE = 0.5;
const COB_DELAY = 15;

// The reading nearest to t, if one is within tol. points: sorted { t, v } (mmol/L).
export function valueAt(points, t, tol = 7 * MIN_MS) {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1; else hi = mid;
  }
  let best = null;
  for (const i of [lo - 1, lo]) {
    const p = points[i];
    if (p && Math.abs(p.t - t) <= tol && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
  }
  return best ? best.v : null;
}

// Insulin and carbs still working at time t, from the log.
export function onBoard(events, t) {
  let iob = 0;
  let cob = 0;
  for (const e of events) {
    const at = Date.parse(e.at);
    if (!(at <= t)) continue;
    const m = (t - at) / MIN_MS;
    const units = e.insulinGiven ?? e.calculated?.rounded ?? 0;
    if (units > 0 && m < IOB_MIN) iob += units * (1 - m / IOB_MIN);
    const carbs = e.type === 'correction' ? 0 : e.carbs || 0;
    if (carbs > 0) cob += Math.max(0, carbs - COB_RATE * Math.max(0, m - COB_DELAY));
  }
  return { iob, cob };
}

// The model's inputs at time t, or null without enough recent readings.
export function featureRow(points, events, t) {
  const g0 = valueAt(points, t, 4 * MIN_MS);
  const g5 = valueAt(points, t - 5 * MIN_MS, 3 * MIN_MS);
  const g15 = valueAt(points, t - 15 * MIN_MS, 4 * MIN_MS);
  const g30 = valueAt(points, t - 30 * MIN_MS, 5 * MIN_MS);
  if (g0 == null || g5 == null || g15 == null || g30 == null) return null;
  const { iob, cob } = onBoard(events, t);
  const hour = ((t / 3600000) + 2) % 24; // South African time
  const a = (2 * Math.PI * hour) / 24;
  return [1, g0, g0 - g5, g0 - g15, g0 - g30, iob, cob, Math.sin(a), Math.cos(a)];
}

const dot = (coef, x) => coef.reduce((s, c, i) => s + c * x[i], 0);
const clampBg = (v) => Math.min(22.2, Math.max(2.2, v));

// Live forecast from his latest readings. history: [{ mmol, time }] (last hour);
// events: recent log entries. Returns null when there's no ready model or recent data.
export function forecastNow(model, history, events, { low = 4 } = {}) {
  if (!model?.ready30) return null;
  const points = (history || []).map((p) => ({ t: Date.parse(p.time), v: p.mmol })).filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const now = points.at(-1);
  if (!now) return null;
  const x = featureRow(points, events || [], now.t);
  if (!x) return null;
  const at = (coef, q) => {
    const v = clampBg(now.v + dot(coef, x));
    return { v: Math.round(v * 10) / 10, lo: Math.round(clampBg(v + q[0]) * 10) / 10, hi: Math.round(clampBg(v + q[1]) * 10) / 10 };
  };
  const at30 = at(model.coef30, model.eval.q30);
  const at60 = model.ready60 ? at(model.coef60, model.eval.q60) : null;
  return { from: now.t, bg: now.v, at30, at60, mayGoLow: at30.lo < low && now.v >= low };
}
