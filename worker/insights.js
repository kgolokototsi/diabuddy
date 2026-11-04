// Insights: what his own readings and log say about meals, low treatments, corrections
// and times of day. Nothing here suggests a dose; the app shows ranges from his past.
//
// The Workers free plan allows ~10 ms of CPU per request, too little to read weeks of
// minute readings on every open. So the scheduled job builds one small summary per
// day (insights-day:<SA date>), one day per hourly run, and the app reads only those.
//
// Days and times of day are South African time (UTC+2 all year, no daylight saving).

const MGDL_PER_MMOL = 18.0182;
const SA_OFFSET_MS = 2 * 3600000;
const MIN = 60000;
const DAY_MS = 24 * 3600000;
export const TARGET_TOP = 10;
export const HIGH_MMOL = 14;
const SUMMARY_TTL_S = 120 * 24 * 3600;
const DONE_KEY = 'insights-done';
const KEEP_DAYS = 90;
const MOMENT_DAYS = 30;

// How each kind of logged event is followed: window and sampling step, in minutes.
const KINDS = {
  meal: { window: 180, step: 10 },
  'low-treatment': { window: 60, step: 5 },
  correction: { window: 180, step: 10 },
};

export const saDate = (ms) => new Date(ms + SA_OFFSET_MS).toISOString().slice(0, 10);
const saHour = (ms) => new Date(ms + SA_OFFSET_MS).getUTCHours() + new Date(ms + SA_OFFSET_MS).getUTCMinutes() / 60;
const saMidnight = (date) => Date.parse(`${date}T00:00:00Z`) - SA_OFFSET_MS;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const mmol = (mgdl) => Math.round((mgdl / MGDL_PER_MMOL) * 10) / 10;
const tenths = (v) => Math.round(v * 10);

// Same boundaries as mealOfDay() in app.js.
export function mealOfDay(ms) {
  const h = saHour(ms);
  return h >= 5 && h < 10 ? 'breakfast' : h >= 11.5 && h < 14.5 ? 'lunch' : h >= 17 && h < 20.5 ? 'supper' : 'snack';
}
const blockOf = (ms) => Math.floor(saHour(ms) / 6); // 0 night, 1 morning, 2 afternoon, 3 evening

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The reading nearest to t, if one is within tol. points: sorted { t, v }.
function valueAt(points, t, tol = 7 * MIN) {
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

// One sensor's readings as sorted { t, v } in mmol/L: the sensor with the most readings.
export function toPoints(logged) {
  const count = {};
  for (const p of logged) count[p.source] = (count[p.source] || 0) + 1;
  const source = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  return logged.filter((p) => p.source === source && Number.isFinite(p.mgdl) && Number.isFinite(p.time))
    .map((p) => ({ t: p.time, v: mmol(p.mgdl) }))
    .sort((a, b) => a.t - b.t);
}

const kindOf = (e) => (e.type === 'dose' && e.carbs > 0 ? 'meal' : e.type === 'low-treatment' ? 'low-treatment' : e.type === 'correction' ? 'correction' : null);
const insulinOf = (e) => e.insulinGiven ?? e.calculated?.rounded ?? null;

// How his glucose went after each logged meal, low treatment and correction.
// events: the log around this day (any order); points: from toPoints().
export function responses(events, points, { low = 4, from = -Infinity, to = Infinity } = {}) {
  const log = events.map((e) => ({ ...e, t: Date.parse(e.at) })).filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  const out = [];
  for (const e of log) {
    const kind = kindOf(e);
    if (!kind || e.t < from || e.t >= to) continue;
    const { window, step } = KINDS[kind];
    const end = e.t + window * MIN;
    const others = log.filter((o) => o !== e && o.t > e.t && o.t <= end);
    let repeats = 0;
    if (kind === 'low-treatment') {
      // 15-15 rule: a treatment within an hour of an earlier one is a repeat, not a new low.
      if (log.some((o) => o !== e && o.type === 'low-treatment' && o.t < e.t && e.t - o.t <= 60 * MIN)) continue;
      repeats = others.filter((o) => o.type === 'low-treatment').length;
      if (others.some((o) => o.type !== 'low-treatment')) continue;
    } else if (others.length) {
      continue; // something else happened in the window: can't tell what did what
    }

    const baseline = valueAt(points, e.t, 10 * MIN) ?? (e.bg > 0 ? e.bg : null);
    if (baseline == null) continue;
    const values = [];
    for (let m = 0; m <= window; m += step) values.push(m === 0 ? baseline : valueAt(points, e.t + m * MIN));
    const seen = values.filter((v) => v != null);
    if (seen.length / values.length < 0.8) continue;

    let peak = 0, peakMin = 0, nadir = 0, nadirMin = 0;
    values.forEach((v, i) => {
      if (v == null) return;
      const d = v - baseline;
      if (d > peak) { peak = d; peakMin = i * step; }
      if (d < nadir) { nadir = d; nadirMin = i * step; }
    });
    const last = [...values].reverse().find((v) => v != null);
    const r = {
      kind,
      at: e.t,
      bg: Math.round(baseline * 10) / 10,
      carbs: e.carbs ?? null,
      insulin: insulinOf(e),
      mealOfDay: mealOfDay(e.t),
      step,
      curve: values.map((v) => (v == null ? null : tenths(v - baseline))),
      peak: tenths(peak),
      peakMin,
      nadir: tenths(nadir),
      nadirMin,
      end: tenths(last - baseline),
      wentLow: values.some((v, i) => v != null && v < low && (kind !== 'low-treatment' || i * step >= 15)),
    };
    if (kind === 'low-treatment') {
      const at15 = values[15 / step];
      r.at15 = at15 == null ? null : Math.round(at15 * 10) / 10;
      r.recovered15 = at15 != null && at15 >= low;
      r.repeats = repeats;
    }
    out.push(r);
  }
  return out;
}

// A sample every 15 minutes for the "low risk now" forecast:
// [BG ×10, 15-min slope ×1000 (mmol/L per min), lowest in the next 45 min ×10, insulin in last 2 h].
export function moments(points, events, { from, to }) {
  const insulinTimes = events.filter((e) => (insulinOf(e) || 0) > 0).map((e) => Date.parse(e.at));
  const out = [];
  for (let t = Math.ceil(from / (15 * MIN)) * 15 * MIN; t < to; t += 15 * MIN) {
    const v = valueAt(points, t, 4 * MIN);
    const before = valueAt(points, t - 15 * MIN, 4 * MIN);
    if (v == null || before == null) continue;
    const ahead = points.filter((p) => p.t > t && p.t <= t + 45 * MIN);
    if (ahead.length < 3 || ahead.at(-1).t < t + 35 * MIN) continue;
    const lowest = Math.min(...ahead.map((p) => p.v));
    const recent = insulinTimes.some((it) => it <= t && t - it <= 2 * 3600000) ? 1 : 0;
    out.push([tenths(v), Math.round(((v - before) / 15) * 1000), tenths(lowest), recent]);
  }
  return out;
}

// Readings per time-of-day block, split into bands: [below low, low–10, 10–14, 14+].
export function blockStats(points, { low = 4, from, to }) {
  const blocks = [0, 1, 2, 3].map(() => ({ n: 0, bands: [0, 0, 0, 0], sum: 0 }));
  for (const p of points) {
    if (p.t < from || p.t >= to) continue;
    const b = blocks[blockOf(p.t)];
    b.n++;
    b.sum += p.v;
    b.bands[p.v < low ? 0 : p.v <= TARGET_TOP ? 1 : p.v < HIGH_MMOL ? 2 : 3]++;
  }
  for (const b of blocks) b.sum = Math.round(b.sum * 10) / 10;
  return blocks;
}

export function daySummary(date, logged, events, { low = 4 } = {}) {
  const from = saMidnight(date);
  const to = from + DAY_MS;
  const points = toPoints(logged);
  const inDay = points.filter((p) => p.t >= from && p.t < to).length;
  return {
    date,
    readings: inDay,
    blocks: blockStats(points, { low, from, to }),
    responses: responses(events, points, { low, from, to }),
    moments: moments(points, events, { from, to }),
  };
}

// ---------------------------------------------------------------- KV glue

// Glucose day keys are UTC days; an SA day plus 3 hours after it spans three of them.
async function loggedAround(env, date) {
  const keys = [addDays(date, -1), date, addDays(date, 1)].map((d) => `glucose:${d}`);
  return (await Promise.all(keys.map((k) => env.LOG.get(k, 'json')))).flat().filter(Boolean);
}

async function eventsAround(env, date) {
  const names = [];
  for (const d of [addDays(date, -1), date, addDays(date, 1)]) {
    let cursor;
    do {
      const page = await env.LOG.list({ prefix: `event:${d}`, cursor });
      names.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }
  return (await Promise.all(names.map((n) => env.LOG.get(n, 'json')))).filter(Boolean);
}

async function readDone(env) {
  return (await env.LOG.get(DONE_KEY, 'json')) || { dates: [], floor: null };
}

// Build one missing day: yesterday once its late meals have had 3 hours (03:00 SA),
// otherwise the newest older day not built yet, back to the first day with readings.
export async function buildNextDay(env, now = Date.now(), { low = 4 } = {}) {
  if (!env.LOG) return null;
  const done = await readDone(env);
  const today = saDate(now);
  const newest = now - saMidnight(today) >= 3 * 3600000 ? addDays(today, -1) : addDays(today, -2);
  let date = null;
  for (let i = 0; i < KEEP_DAYS; i++) {
    const d = addDays(newest, -i);
    if (done.floor && d <= done.floor) break;
    if (!done.dates.includes(d)) { date = d; break; }
  }
  if (!date) return null;

  const logged = await loggedAround(env, date);
  const summary = daySummary(date, logged, await eventsAround(env, date), { low });
  if (summary.readings > 0) {
    await env.LOG.put(`insights-day:${date}`, JSON.stringify(summary), { expirationTtl: SUMMARY_TTL_S });
    done.dates = [...done.dates, date].filter((d) => d > addDays(today, -KEEP_DAYS - 2)).sort();
  } else if (date < newest) {
    done.floor = date; // nothing logged this far back: stop going further
  } else {
    done.dates = [...done.dates, date].sort(); // no readings yesterday: nothing to build
  }
  await env.LOG.put(DONE_KEY, JSON.stringify(done));
  return date;
}

// A logged event changed on a day already built: rebuild that day (and the one before,
// whose 3-hour windows can reach past midnight).
export async function invalidateDay(env, atIso, now = Date.now()) {
  if (!env.LOG) return;
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return;
  const dates = [...new Set([saDate(t), saDate(t - 3 * 3600000)])].filter((d) => d < saDate(now));
  if (!dates.length) return;
  const done = await readDone(env);
  if (!dates.some((d) => done.dates.includes(d))) return;
  done.dates = done.dates.filter((d) => !dates.includes(d));
  if (done.floor && dates.some((d) => d <= done.floor)) done.floor = null;
  await Promise.all(dates.map((d) => env.LOG.delete(`insights-day:${d}`)));
  await env.LOG.put(DONE_KEY, JSON.stringify(done));
}

export async function readDays(env, days, now = Date.now()) {
  const today = saDate(now);
  const dates = Array.from({ length: days }, (_, i) => addDays(today, -1 - i));
  return (await Promise.all(dates.map((d) => env.LOG.get(`insights-day:${d}`, 'json')))).filter(Boolean);
}

// Totals per block over some days, as percentages.
export function combineBlocks(summaries) {
  return [0, 1, 2, 3].map((i) => {
    const n = summaries.reduce((a, s) => a + s.blocks[i].n, 0);
    const bands = [0, 1, 2, 3].map((j) => summaries.reduce((a, s) => a + s.blocks[i].bands[j], 0));
    const sum = summaries.reduce((a, s) => a + s.blocks[i].sum, 0);
    return { n, pct: bands.map((b) => (n ? Math.round((b / n) * 1000) / 10 : 0)), mean: n ? Math.round((sum / n) * 10) / 10 : null };
  });
}

export function mealTypeStats(rs) {
  const out = {};
  for (const type of ['breakfast', 'lunch', 'supper', 'snack']) {
    const meals = rs.filter((r) => r.kind === 'meal' && r.mealOfDay === type);
    out[type] = {
      n: meals.length,
      end: median(meals.map((r) => r.end / 10)),
      peak: median(meals.map((r) => r.peak / 10)),
      lows: meals.filter((r) => r.wentLow).length,
    };
  }
  return out;
}

export async function readInsights(env, now = Date.now()) {
  const days = await readDays(env, KEEP_DAYS, now);
  const cutoff = (n) => addDays(saDate(now), -n - 1);
  const last = (n) => days.filter((s) => s.date > cutoff(n));
  const rs = days.flatMap((s) => s.responses);
  const count = (kind) => rs.filter((r) => r.kind === kind).length;
  return {
    through: days[0]?.date || null,
    coverage: {
      days14: last(14).length, days30: last(30).length, days90: days.length,
      meals: count('meal'), lowTreatments: count('low-treatment'), corrections: count('correction'),
    },
    blocks: { 14: combineBlocks(last(14)), 30: combineBlocks(last(30)) },
    mealTypes: mealTypeStats(rs.filter((r) => saDate(r.at) > cutoff(30))),
    responses: rs,
    moments: last(MOMENT_DAYS).flatMap((s) => s.moments),
  };
}
