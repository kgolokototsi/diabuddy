import { calculateDose, parseBg, lineCarbs, isConfigured, BG_MIN, BG_MAX } from './dose.js';
import { loadFoods, searchFoods, loadPackaged, lookupBarcode, CATEGORIES, SOURCE_LABEL } from './foods.js';
import { spring, project, rubberband, VelocityTracker } from './spring.js';
import { RELAY_URL, APP_VERSION } from './config.js';
import { forecastResponse, lowRisk, recentSlope } from './forecast.js';
import { alertSupport, alertsOn, turnOnAlerts, turnOffAlerts, sendTestAlert } from './alerts.js';
import { getCgmKey, setCgmKey, consumeJoinCode, joinCodeFrom, inviteLink, fetchLatest, relayFetch, usableForDose, FRESH_MINUTES } from './cgm.js';

// ---------------------------------------------------------------- helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n, d = 1) => {
  const s = (Math.round(n * 10 ** d) / 10 ** d).toFixed(d);
  return d ? s.replace(/\.?0+$/, '') : s;
};
const fmtSigned = (n, d = 2) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}`;
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : 'never';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (text) => {
  const n = parseBg(text);
  return n == null || Number.isNaN(n) ? null : n;
};

const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(`diabuddy.${key}`); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`diabuddy.${key}`, JSON.stringify(value)); } catch {}
  },
};

const ICON = {
  plus: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  close: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  chevron: '<svg class="row-chevron" aria-hidden="true" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>',
  warn: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
  info: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/></svg>',
  drop: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/></svg>',
};

const MEAL_TTL_MS = 4 * 60 * 60 * 1000;

// ---------------------------------------------------------------- state

const state = {
  tab: 'home',
  base: [],
  custom: [],
  packaged: null,
  packagedLoading: false,
  settings: null,
  settingsMeta: null, // { from: 'github' | 'pages' | 'cache', fetchedAt }
  meal: [],
  recent: store.get('recent', []),
  cgm: { reading: null, error: null, at: 0, loading: false },
  alerts: { on: null },
  insights: { data: null, at: 0, loading: false, error: null, summary: null, kind: 'meal', days: 14, table: false, carbs: null, units: null, bgTyped: null, mealOfDay: null },
  me: store.get('me', null), // { id, name, role, legacy } from the relay
  githubFoods: [],
  relayFoods: store.get('relay-foods', []),
  foodsQuery: '',
  category: null,
  scroll: {},
};

const foodIndex = new Map();
function indexFoods(list) { for (const f of list) foodIndex.set(f.id, f); }
const allLocalFoods = () => [...state.custom, ...state.base];
const mealCarbs = () => state.meal.reduce((sum, l) => sum + lineCarbs(l.food, l.servings), 0);
const mealCount = (id) => state.meal.find((l) => l.food.id === id)?.servings || 0;

function saveMeal() {
  store.set('meal', { savedAt: Date.now(), lines: state.meal });
}
function restoreMeal() {
  const saved = store.get('meal');
  if (saved && Date.now() - saved.savedAt < MEAL_TTL_MS) state.meal = saved.lines || [];
  indexFoods(state.meal.map((l) => l.food));
  indexFoods(state.recent);
}

// ---------------------------------------------------------------- data loading

async function loadSettings() {
  const before = JSON.stringify(state.settings);
  if (cgmReady()) {
    try {
      const { settings } = await relayFetch(RELAY_URL, '/settings');
      // Numbers only: these values fill form fields and drive the dose.
      for (const k of ['icr', 'cf', 'targetBg', 'hypoThreshold', 'maxDose', 'roundTo']) {
        if (settings && settings[k] != null) settings[k] = Number.isFinite(Number(settings[k])) ? Number(settings[k]) : null;
      }
      state.settings = settings;
      state.settingsMeta = { from: 'relay', fetchedAt: Date.now() };
      store.set('settings', { data: settings, fetchedAt: Date.now() });
      return JSON.stringify(state.settings) !== before;
    } catch {}
  }
  const cached = store.get('settings');
  if (cached && cgmReady()) {
    state.settings = cached.data;
    state.settingsMeta = { from: 'cache', fetchedAt: cached.fetchedAt };
  }
  return JSON.stringify(state.settings) !== before;
}

// Who is this phone? The role decides what Settings shows; the relay enforces it either way.
async function loadMe() {
  if (!getCgmKey()) { state.me = null; store.set('me', null); return; }
  try {
    const { device } = await relayFetch(RELAY_URL, '/me');
    state.me = device;
    store.set('me', device);
  } catch (err) {
    if (err.status === 401) { forgetThisPhone(); toast('This phone was removed. Ask the admin for a new invite link.'); }
  }
}

function forgetThisPhone() {
  setCgmKey('');
  state.me = null;
  state.settings = null;
  state.cgm = { reading: null, error: null, at: 0, loading: false };
  for (const k of ['me', 'settings', 'relay-foods', 'pending-events']) store.set(k, null);
  try { localStorage.removeItem('diabuddy.meal'); } catch {}
  // The relay forgets this phone's alerts with the phone; drop the browser's side too.
  state.alerts = { on: null };
  state.insights = { ...state.insights, data: null, at: 0, summary: null };
  navigator.serviceWorker?.getRegistration().then((reg) => reg?.pushManager.getSubscription()).then((sub) => sub?.unsubscribe()).catch(() => {});
}

// Family foods come from two places: the admin's GitHub file (older) and the relay,
// where any family phone can add them (label photos, home recipes).
function setCustomFoods() {
  state.custom = [...state.relayFoods, ...state.githubFoods];
  store.set('custom', state.custom);
  indexFoods(state.custom);
}

async function loadAllFoods() {
  try {
    const { base, custom } = await loadFoods();
    state.base = base;
    state.githubFoods = custom.map((f) => ({ ...f, source: 'custom' }));
    setCustomFoods();
  } catch {
    state.custom = store.get('custom', []);
  }
  indexFoods(allLocalFoods());
}

async function loadRelayFoods() {
  if (!cgmReady()) return;
  try {
    const { foods } = await relayFetch(RELAY_URL, '/foods');
    state.relayFoods = foods.map((f) => ({ ...f, source: 'custom', relay: true }));
    store.set('relay-foods', state.relayFoods);
    setCustomFoods();
    refreshRows();
  } catch {}
}

function ensurePackaged() {
  if (state.packaged || state.packagedLoading) return;
  state.packagedLoading = true;
  loadPackaged()
    .then((list) => { state.packaged = list; indexFoods(list); })
    .catch(() => { state.packaged = []; })
    .finally(() => {
      state.packagedLoading = false;
      renderFoods();
    });
}

// ---------------------------------------------------------------- meal actions

function addToMeal(food, servings = 1) {
  if (!food) return;
  const line = state.meal.find((l) => l.food.id === food.id);
  if (line) line.servings = Math.round((line.servings + servings) * 100) / 100;
  else state.meal.push({ food, servings });
  indexFoods([food]);
  state.recent = [food, ...state.recent.filter((f) => f.id !== food.id)].slice(0, 10);
  store.set('recent', state.recent);
  saveMeal();
  navigator.vibrate?.(8);
  renderTray({ pulse: true });
  refreshRows();
}

function setServings(foodId, servings) {
  const i = state.meal.findIndex((l) => l.food.id === foodId);
  if (i < 0) return;
  if (servings <= 0) {
    const [removed] = state.meal.splice(i, 1);
    toast(`Removed ${removed.food.name}`, {
      action: 'Undo',
      onAction: () => { state.meal.splice(i, 0, removed); saveMeal(); renderTray(); refreshRows(); },
    });
  } else {
    state.meal[i].servings = Math.round(servings * 100) / 100;
  }
  saveMeal();
  renderTray();
  refreshRows();
}

function clearMeal() {
  const previous = state.meal;
  state.meal = [];
  saveMeal();
  renderTray();
  refreshRows();
  toast('Meal cleared', {
    action: 'Undo',
    onAction: () => { state.meal = previous; saveMeal(); renderTray(); refreshRows(); },
  });
}

// ---------------------------------------------------------------- rows

function badge(food) {
  if (food.free) return '<span class="badge badge-free">Free</span>';
  const label = SOURCE_LABEL[food.source];
  return label ? `<span class="badge badge-${food.source}">${label}</span>` : '';
}

function carbText(food) {
  return food.free ? 'no carbs' : `${fmt(food.netCarbs)} g carbs`;
}

// A soft emoji badge per food group. The colour is mixed into the card colour in CSS.
const CATEGORY_STYLE = {
  Breakfast: ['🥣', '#f2a541'],
  'Bread & bakery': ['🍞', '#d9925b'],
  'Grains & starches': ['🍚', '#c9a66b'],
  Fruit: ['🍓', '#e86a6a'],
  Vegetables: ['🥦', '#6faf5f'],
  Dairy: ['🥛', '#6fa3d8'],
  Drinks: ['🧃', '#9c8fe0'],
  Snacks: ['🍪', '#d98b4e'],
  'Sweets & spreads': ['🍯', '#e8b23a'],
  'Meals & takeaway': ['🍕', '#e07b5a'],
  Protein: ['🥚', '#c8a27a'],
  Packaged: ['📦', '#a8968a'],
  Family: ['🏠', '#7faf7a'],
};
const categoryStyle = (name) => CATEGORY_STYLE[name] || ['🍽️', '#c8a27a'];

// First match wins, so more specific words come before general ones.
const FOOD_EMOJI = [
  // Dishes and mixed foods first, so their ingredients don't win.
  [/popcorn chicken|chicken|nugget/, '🍗'], [/popcorn/, '🍿'], [/rice cake/, '🍘'], [/pizza/, '🍕'], [/burger/, '🍔'],
  [/spaghetti|pasta|macaroni|noodle|couscous/, '🍝'], [/baked beans/, '🥫'], [/fruit cocktail/, '🍑'],
  [/corn flakes|granola bar|cereal/, '🥣'], [/jelly/, '🍬'], [/chocolate milk/, '🥛'],
  [/biscuit|cookie|cracker/, '🍪'], [/custard|yoghurt|pudding/, '🍮'], [/pancake/, '🥞'], [/cake|doughnut/, '🍩'], [/chocolate/, '🍫'],
  [/english muffin/, '🍞'], [/muffin/, '🧁'], [/juice/, '🧃'], [/\bcola\b|soda|lemonade/, '🥤'], [/soup/, '🍲'],
  // Fruit
  [/pineapple/, '🍍'], [/blueberr/, '🫐'], [/strawberr|raspberr|blackberr/, '🍓'], [/mango|pawpaw|papaya|guava/, '🥭'],
  [/banana/, '🍌'], [/\bapple/, '🍎'], [/orange|naartjie|mandarin/, '🍊'], [/grape|raisin/, '🍇'], [/\bpear/, '🍐'],
  [/peach|apricot|plum/, '🍑'], [/cherr|litchi/, '🍒'], [/kiwi/, '🥝'], [/watermelon/, '🍉'], [/melon|spanspek/, '🍈'],
  [/avocado/, '🥑'],
  // Vegetables and starches
  [/sweet potato/, '🍠'], [/crisps/, '🥔'], [/chips|fries/, '🍟'], [/potato/, '🥔'], [/\bpap\b|maize|\bcorn\b|sweetcorn/, '🌽'],
  [/broccoli/, '🥦'], [/cucumber|gherkin/, '🥒'], [/ketchup|tomato/, '🍅'], [/carrot/, '🥕'], [/spinach|lettuce|cabbage/, '🥬'],
  [/mushroom/, '🍄'], [/\bbeans?\b|lentil|chickpea|\bpeas?\b|hummus/, '🌱'], [/pumpkin|butternut|squash/, '🎃'],
  [/onion/, '🧅'], [/pepper/, '🫑'], [/rice/, '🍚'],
  // Bakery, breakfast, dairy, sweets, protein
  [/pancake/, '🥞'], [/waffle/, '🧇'], [/croissant/, '🥐'], [/toast|bread|roll|pita/, '🍞'], [/wrap|tortilla/, '🌯'],
  [/oat|porridge|futurelife|weet-bix|granola|muesli|wheat/, '🥣'], [/milk/, '🥛'], [/ice cream/, '🍨'], [/cheese/, '🧀'],
  [/honey|syrup/, '🍯'], [/\bjam\b/, '🍓'], [/peanut/, '🥜'], [/sugar|marshmallow|gums/, '🍬'], [/pretzel/, '🥨'],
  [/fish/, '🐟'], [/\begg\b/, '🥚'], [/sausage|vienna/, '🌭'], [/beef|mince/, '🥩'],
];

function foodAvatar(food) {
  const [catEmoji, color] = food.source === 'manual' ? ['🏷️', '#a8968a'] : categoryStyle(food.category);
  const name = food.name.toLowerCase();
  const emoji = food.source === 'off' || food.source === 'manual' ? catEmoji : FOOD_EMOJI.find(([re]) => re.test(name))?.[1] || catEmoji;
  return `<span class="food-avatar" style="--cat:${color}" aria-hidden="true">${emoji}</span>`;
}

function categoryTitle(name) {
  return name;
}

// `mode`: "add" adds one serving on tap; "detail" opens the food sheet.
function foodRow(food, mode = 'add') {
  // Packaged products have unreliable serving sizes – always ask for the amount.
  if (food.source === 'off') mode = 'detail';
  const count = mealCount(food.id);
  const trailing = count
    ? `<span class="in-meal" aria-label="${fmt(count)} in meal">×${fmt(count)}</span>`
    : mode === 'add' ? `<span class="add-btn" aria-hidden="true">${ICON.plus}</span>` : ICON.chevron;
  const label = mode === 'add' ? `Add ${food.name}` : `${food.name}, details`;
  return `<button class="row" data-${mode}="${esc(food.id)}" aria-label="${esc(label)}">
    ${foodAvatar(food)}
    <span class="row-main">
      <span class="row-title">${esc(food.name)}</span>
      <span class="row-sub"><span>${esc(food.serving.label)} · ${carbText(food)}</span>${badge(food)}</span>
    </span>
    ${trailing}
  </button>`;
}

function section(title, rowsHtml, footer = '') {
  return `<section class="section">
    ${title ? `<h2 class="section-header">${esc(title)}</h2>` : ''}
    <div class="group">${rowsHtml}</div>
    ${footer ? `<p class="section-footer">${footer}</p>` : ''}
  </section>`;
}

const loadingRow = (text) => `<div class="loading-row"><span class="spinner" aria-hidden="true"></span>${esc(text)}</div>`;

function refreshRows() {
  renderHome();
  renderFoods();
}

// ---------------------------------------------------------------- Glucose readings (Dexcom or Libre)

const cgmUrl = () => RELAY_URL;
const cgmReady = () => Boolean(getCgmKey());
const isAdmin = () => state.me?.role === 'admin';
let cgmPending = null;

// One request serves every screen; readings only change every 5 minutes.
function getReading({ maxAgeMs = 60000 } = {}) {
  if (!cgmReady()) return Promise.reject(new Error('Glucose readings are not set up.'));
  if (state.cgm.reading && Date.now() - state.cgm.at < maxAgeMs) return Promise.resolve(state.cgm.reading);
  if (cgmPending) return cgmPending;
  state.cgm.loading = true;
  renderCgmCard();
  cgmPending = fetchLatest(cgmUrl())
    .then((r) => { state.cgm = { reading: r, error: null, at: Date.now(), loading: false }; return r; })
    .catch((err) => {
      // Keep the newest trend we have: the relay's logged readings, else what's already on screen.
      const history = err.history?.length ? err.history : state.cgm.history || state.cgm.reading?.history || [];
      state.cgm = { ...state.cgm, error: err.message, history, loading: false };
      throw err;
    })
    .finally(() => {
      cgmPending = null;
      renderCgmCard();
      if (state.tab === 'settings') renderSettings();
      // Keep "Low risk now" current, but don't redraw under someone typing.
      if (state.tab === 'insights' && !$('#insights-body').contains(document.activeElement)) renderInsights();
    });
  return cgmPending;
}

const readingAge = (r) => r.ageMinutes === 0 ? 'just now' : r.ageMinutes === 1 ? '1 min ago' : `${r.ageMinutes} min ago`;
const sourceName = (r) => (r.source === 'libre' ? 'Libre' : 'Dexcom');
// Low treatments follow the 15-15 rule: 15 g of fast carbs, recheck after 15 minutes.
const LOW_TREATMENT_G = 15;
// From this a reading shows in orange (his team counts 14 as high).
const HIGH_MMOL = 14;
// Top of the shaded target range on the trend chart.
const TARGET_TOP = 10;
const readingValue = (r) => r.low ? 'LOW' : r.high ? 'HIGH' : fmt(r.mmol);

function renderCgmCard() {
  const el = $('#cgm-card');
  if (!el) return;
  if (!getCgmKey()) {
    el.innerHTML = section(null, `<button class="row" data-action="join"><span class="row-main"><span class="row-title row-link">Connect this phone</span><span class="row-sub">Open the invite link from the admin, or paste it here.</span></span>${ICON.chevron}</button>`);
    return;
  }
  const r = state.cgm.reading;
  if (!r && !state.cgm.error) {
    el.innerHTML = section(null, loadingRow('Getting his glucose reading…'));
    return;
  }
  // No reading, or none recent: say so plainly, and still show the trend up to the gap.
  if (!r || r.ageMinutes > FRESH_MINUTES) {
    const history = state.cgm.error && state.cgm.history?.length ? state.cgm.history : r?.history || state.cgm.history || [];
    const lastPoint = history.at(-1);
    const last = r ? `Last ${sourceName(r)}: ${readingValue(r)} at ${clockTime(r.time)} (${readingAge(r)})`
      : lastPoint ? `Last: ${fmt(lastPoint.mmol)} at ${clockTime(lastPoint.time)}` : '';
    const sub = [last, state.cgm.error && esc(state.cgm.error), 'Tap to try again.'].filter(Boolean).join(' · ');
    el.innerHTML = section(null, `<button class="row cgm-row cgm-stale" data-action="cgm-refresh">
      <span class="cgm-value" aria-hidden="true">– –</span>
      <span class="row-main"><span class="row-title">No glucose reading. Check the CGM app.</span>
        <span class="row-sub">${sub}</span></span>
    </button>
    ${trendChart(history)}`);
    return;
  }
  const lowThreshold = state.settings?.hypoThreshold ?? 4;
  const isLow = r.low || r.mmol < lowThreshold;
  const isHigh = r.high || r.mmol >= HIGH_MMOL;
  const tone = isLow ? 'cgm-low' : isHigh ? 'cgm-high' : '';
  // A low reading gets a plain warning, not just a red number.
  const lowBanner = isLow
    ? `<div class="banner banner-danger" role="alert">${ICON.drop}<div><strong>${sourceName(r)} shows ${readingValue(r)}. That’s low.</strong>Check with a finger-prick and treat the low first. Don’t give insulin now.</div></div>`
    : '';
  el.innerHTML = lowBanner + section(null, `<button class="row cgm-row ${tone}" data-action="cgm-refresh" aria-label="${sourceName(r)} ${readingValue(r)} mmol/L, ${esc(r.trendText)}, ${readingAge(r)}. Tap to refresh.">
    <span class="cgm-value">${readingValue(r)}<span class="cgm-arrow" aria-hidden="true">${r.arrow}</span></span>
    <span class="row-main"><span class="row-title">mmol/L · ${esc(r.trendText)}</span>
      <span class="row-sub">${sourceName(r)} · ${readingAge(r)}${state.cgm.error ? ' · couldn’t update' : ''}</span></span>
  </button>
  ${trendChart(r.history)}`);
}

const clockTime = (iso) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false });

// Small last-hour chart of the real readings only: no smoothing, no made-up points.
function trendChart(history = [], now = Date.now()) {
  const points = history
    .map((p) => ({ mmol: p.mmol, t: Date.parse(p.time), time: p.time }))
    .filter((p) => now - p.t <= 60 * 60000)
    .sort((a, b) => a.t - b.t);

  const W = 300, H = 64, padX = 8, padY = 8;
  const values = points.map((p) => p.mmol);
  const lo = Math.min(3, Math.min(...values) - 0.5);
  const hi = Math.max(11, Math.max(...values) + 0.5);
  const x = (t) => padX + ((t - (now - 60 * 60000)) / (60 * 60000)) * (W - 2 * padX);
  const y = (v) => padY + (1 - (v - lo) / (hi - lo)) * (H - 2 * padY);
  const low = state.settings?.hypoThreshold ?? 4;

  // Break the line where readings are more than 20 minutes apart.
  const segments = [];
  for (const p of points) {
    const last = segments.at(-1);
    if (last && p.t - last.at(-1).t <= 20 * 60000) last.push(p);
    else segments.push([p]);
  }
  const lines = segments.filter((s) => s.length > 1)
    .map((s) => `<polyline points="${s.map((p) => `${x(p.t).toFixed(1)},${y(p.mmol).toFixed(1)}`).join(' ')}" />`).join('');
  const dots = points.map((p, i) => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.mmol).toFixed(1)}" r="${i === points.length - 1 ? 4.5 : 3}" class="${i === points.length - 1 ? 'trend-last' : ''}"><title>${fmt(p.mmol)} at ${clockTime(p.time)}</title></circle>`).join('');

  // Shade each stretch with no readings: between segments, and from the last reading to now.
  const cur = points.at(-1);
  const gapSince = !cur ? now - 60 * 60000 : now - cur.t > FRESH_MINUTES * 60000 ? cur.t : null;
  const gaps = segments.slice(1).map((s, i) => [segments[i].at(-1).t, s[0].t]);
  if (gapSince != null) gaps.push([gapSince, now]);
  const gapRects = gaps.map(([a, b]) => {
    const left = x(a), right = b >= now ? W : x(b); // a gap up to now runs to the chart's edge
    return `<rect class="trend-gap" x="${left.toFixed(1)}" y="0" width="${(right - left).toFixed(1)}" height="${H}" rx="4" />`;
  }).join('');

  const signed = (d) => `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d))}`;
  // Prefer a real reading 8–15 minutes back (closest to 10); otherwise compare with the previous one.
  const tenAgo = cur && points
    .filter((p) => cur.t - p.t >= 8 * 60000 && cur.t - p.t <= 15 * 60000)
    .sort((a, b) => Math.abs(cur.t - a.t - 10 * 60000) - Math.abs(cur.t - b.t - 10 * 60000))[0];
  const prev = points.length > 1 ? points.at(-2) : null;
  const change = !cur ? 'No readings in the last hour'
    : gapSince != null ? `No readings since ${clockTime(cur.time)}`
    : tenAgo ? `${signed(cur.mmol - tenAgo.mmol)} in ${Math.round((cur.t - tenAgo.t) / 60000)} min`
    : prev ? `${signed(cur.mmol - prev.mmol)} since ${clockTime(prev.time)}`
    : 'One reading in the last hour';
  const label = `Last hour: ${points.map((p) => `${fmt(p.mmol)} at ${clockTime(p.time)}`).join(', ') || 'no readings'}. ${change === 'No readings in the last hour' ? '' : change + '. '}Shaded band is ${low} to ${TARGET_TOP} mmol/L.`;

  return `<div class="trend" role="group" aria-label="Last hour of readings">
    <svg class="trend-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
      <rect class="trend-band" x="0" y="${y(TARGET_TOP).toFixed(1)}" width="${W}" height="${(y(low) - y(TARGET_TOP)).toFixed(1)}" rx="6" />
      <line class="trend-low" x1="0" x2="${W}" y1="${y(low).toFixed(1)}" y2="${y(low).toFixed(1)}" />
      ${gapRects}${lines}${dots}
    </svg>
    <div class="trend-caption"><span>1 h ago</span><strong>${esc(change)}</strong><span>now</span></div>
    <p class="trend-key">Shaded: ${low}–${TARGET_TOP} mmol/L · dashed line: low (${low})</p>
  </div>`;
}

function refreshCgm() {
  if (cgmReady()) getReading({ maxAgeMs: 0 }).catch(() => {});
}

// ---------------------------------------------------------------- Home screen

function mealOfDay(now = new Date()) {
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 5 * 60 && mins < 10 * 60 ? 'breakfast'
    : mins >= 11 * 60 + 30 && mins < 14 * 60 + 30 ? 'lunch'
    : mins >= 17 * 60 && mins < 20 * 60 + 30 ? 'supper'
    : 'snack';
}

function renderGreeting(now = new Date()) {
  const mins = now.getHours() * 60 + now.getMinutes();
  $('#greeting').textContent = mins < 12 * 60 ? 'Good morning' : mins < 17 * 60 ? 'Good afternoon' : 'Good evening';
  // "Wednesday 4 November" (en-ZA would give "Wednesday, 04 November").
  const part = (opts) => now.toLocaleDateString('en-GB', opts);
  $('#today-date').textContent = `${part({ weekday: 'long' })} ${now.getDate()} ${part({ month: 'long' })}`;
  const meal = mealOfDay(now);
  $('#foods-sub').textContent = `Tap what he’s eating for ${meal === 'snack' ? 'a snack' : meal}`;
}

function renderSetupBanner() {
  const el = $('#setup-banner');
  if (!getCgmKey()) {
    el.innerHTML = `<div class="banner banner-info">${ICON.info}<div><strong>This phone isn’t connected yet</strong>Open the invite link the admin sent you, or tap “Connect this phone” below.</div></div>`;
  } else if (!state.settings) {
    el.innerHTML = `<div class="banner banner-warn">${ICON.warn}<div><strong>Settings not loaded</strong>Connect to the internet once so DiaBuddy can load his carb ratio.</div></div>`;
  } else if (!isConfigured(state.settings)) {
    el.innerHTML = `<div class="banner banner-warn">${ICON.warn}<div><strong>Carb ratio not set yet</strong>You can count carbs, but doses need the admin to set his carb ratio, correction factor and target in Settings.</div></div>`;
  } else {
    el.innerHTML = '';
  }
}

// A meal in progress gets a card on Home so nobody loses track of it.
function renderHome() {
  const el = $('#home-meal');
  const n = state.meal.length;
  const names = state.meal.map((l) => l.food.name).slice(0, 3).join(', ') + (n > 3 ? ` and ${n - 3} more` : '');
  const meal = n ? section('Meal in progress', `
    <button class="row" data-action="start-meal">
      <span class="row-main"><span class="row-title">${fmt(mealCarbs())} g carbs · ${n} ${n === 1 ? 'food' : 'foods'}</span><span class="row-sub">${esc(names)}</span></span>
      ${ICON.chevron}
    </button>
    <button class="row" data-action="calculate"><span class="row-main"><span class="row-title row-link">Work out dose</span></span>${ICON.chevron}</button>`) : '';
  el.innerHTML = meal + todayLogHtml();
}

// ---------------------------------------------------------------- Meal & dose log
// Entries live on the relay (shared by every family phone). Each one is queued on
// the phone first and sent when there's signal, so nothing is lost offline.

const PENDING_KEY = 'pending-events';
const deviceId = store.get('device') || (() => { const d = `phone-${Math.random().toString(36).slice(2, 8)}`; store.set('device', d); return d; })();
const logReady = () => cgmReady();
const newId = () => Math.random().toString(36).slice(2, 12).padEnd(10, '0');
const isToday = (iso) => new Date(iso).toDateString() === new Date().toDateString();

async function flushPending() {
  const pending = store.get(PENDING_KEY, []);
  if (!pending.length || !logReady()) return;
  const left = [];
  for (const e of pending) {
    try {
      await relayFetch(cgmUrl(), '/events', { method: 'POST', body: e });
    } catch (err) {
      if (!(err.status >= 400 && err.status < 500)) left.push(e); // keep for later unless rejected
    }
  }
  store.set(PENDING_KEY, left);
}

async function loadTodayLog() {
  if (!logReady()) return;
  try {
    await flushPending();
    const { events } = await relayFetch(cgmUrl(), '/events?days=1');
    state.todayLog = events.filter((e) => isToday(e.at));
  } catch {}
  renderHome();
}

async function saveEvent(event) {
  store.set(PENDING_KEY, [...store.get(PENDING_KEY, []), event]);
  renderHome();
  await loadTodayLog();
}

async function removeEvent(id) {
  const pending = store.get(PENDING_KEY, []);
  if (pending.some((e) => e.id === id)) store.set(PENDING_KEY, pending.filter((e) => e.id !== id));
  else await relayFetch(cgmUrl(), `/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.todayLog = (state.todayLog || []).filter((e) => e.id !== id);
  renderHome();
}

function eventTitle(e) {
  const units = e.insulinGiven != null ? `${fmt(e.insulinGiven)} U` : 'No insulin';
  if (e.type === 'low-treatment') return `Low treated · ${fmt(e.carbs || 0)} g carbs`;
  if (e.type === 'correction') return `${units} correction`;
  return `${units} for ${fmt(e.carbs || 0)} g carbs`;
}

function eventSub(e) {
  const bg = e.bg != null ? `BG ${fmt(e.bg)}${e.bgSource && e.bgSource !== 'typed' ? ` (${e.bgSource === 'libre' ? 'Libre' : 'Dexcom'})` : ''}` : 'No BG';
  const foods = (e.foods || []).map((f) => f.name).slice(0, 3).join(', ');
  return [bg, foods].filter(Boolean).join(' · ');
}

function todayLogHtml() {
  if (!logReady()) return '';
  const pending = store.get(PENDING_KEY, []).filter((e) => isToday(e.at)).map((e) => ({ ...e, pending: true }));
  const saved = (state.todayLog || []).filter((e) => !pending.some((p) => p.id === e.id));
  const all = [...pending, ...saved].sort((a, b) => (a.at < b.at ? 1 : -1));
  if (!all.length) return '';
  return section('Today', all.map((e) => `
    <button class="row" data-event="${esc(e.id)}">
      <span class="log-time">${clockTime(e.at)}</span>
      <span class="row-main"><span class="row-title">${esc(eventTitle(e))}</span><span class="row-sub">${esc(eventSub(e))}${e.pending ? ' · waiting for signal' : ''}</span></span>
      ${ICON.chevron}
    </button>`).join(''), 'Saved for the whole family. This builds up the record we’ll use to learn how he responds to meals.');
}

function openEvent(id) {
  const e = [...store.get(PENDING_KEY, []), ...(state.todayLog || [])].find((x) => x.id === id);
  if (!e) return;
  const rows = [
    settingRow('Time', clockTime(e.at)),
    settingRow('Carbs', `${fmt(e.carbs || 0)} g`),
    settingRow('BG', e.bg != null ? `${fmt(e.bg)} mmol/L` : '–'),
    settingRow('Insulin given', e.insulinGiven != null ? `<strong>${fmt(e.insulinGiven)} U</strong>` : '–'),
    e.calculated?.rounded != null ? settingRow('DiaBuddy worked out', `${fmt(e.calculated.rounded)} U`) : '',
  ].join('');
  const foods = (e.foods || []).map((f) => `<div class="row"><span class="row-main"><span class="row-title">${esc(f.name)}</span></span><span class="row-value">${f.carbs != null ? `${fmt(f.carbs)} g` : ''}</span></div>`).join('');
  openSheet(`
    ${sheetHeader(eventTitle(e), esc(new Date(e.at).toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' })))}
    ${section(null, rows)}
    ${foods ? section('Foods', foods) : ''}
    <div class="sheet-actions"><button class="btn btn-danger" id="event-delete">Delete this entry</button></div>`, {
    onMount(root) {
      $('#event-delete', root).addEventListener('click', async (ev) => {
        ev.currentTarget.disabled = true;
        try {
          await removeEvent(e.id);
          closeSheet();
          toast('Entry deleted');
        } catch (err) {
          ev.currentTarget.disabled = false;
          toast(err.message);
        }
      });
    },
  });
}

// ---------------------------------------------------------------- Foods screen (the one place for food)

const VIEWS = [
  ['usual', 'His usual'],
  ['all', 'All'],
  ...CATEGORIES.map((c) => [c, categoryTitle(c)]),
  ['Family', categoryTitle('Family')],
  ['Packaged', `${categoryTitle('Packaged')} (SA)`],
];

function renderFoods() {
  const view = state.category || 'usual';
  $('#foods-chips').innerHTML = VIEWS
    .filter(([key]) => key !== 'Family' || state.custom.length)
    .map(([key, label]) => `<button class="chip" role="tab" data-cat="${esc(key)}" aria-selected="${view === key}">${esc(label)}</button>`)
    .join('');
  $('#foods-admin').innerHTML = isAdmin() || cgmReady()
    ? `<button class="pill-button" data-action="add-family-food">${ICON.plus} Add a family food</button>`
    : '';

  const el = $('#foods-results');
  const q = state.foodsQuery.trim();
  const rows = (list) => list.map((f) => foodRow(f)).join('');

  // Typing searches everything, whatever chip is selected.
  if (q) {
    ensurePackaged();
    const local = searchFoods(allLocalFoods(), q).slice(0, 40);
    const packaged = state.packaged ? searchFoods(state.packaged, q).slice(0, 25) : [];
    const parts = [];
    if (local.length) parts.push(section('Foods', rows(local)));
    if (state.packagedLoading) parts.push(`<section class="section"><h2 class="section-header">Packaged in South Africa</h2>${loadingRow('Loading products…')}</section>`);
    else if (packaged.length) {
      parts.push(section('Packaged in South Africa', rows(packaged),
        'From Open Food Facts. These are entered by the public, so check the carbs against the label.'));
    }
    if (!parts.length) {
      parts.push(`<div class="empty"><span class="empty-emoji" aria-hidden="true">🤔</span><strong>No matches for “${esc(q)}”</strong>Enter the carbs from the label instead.</div>
        <div class="sheet-actions"><button class="btn btn-secondary" data-action="manual">Carbs from a label</button></div>`);
    }
    el.innerHTML = parts.join('');
    return;
  }

  if (view === 'usual') {
    const notebook = state.base.filter((f) => f.source === 'notebook');
    // Notebook and family foods are listed below already; don't show them twice.
    const recent = state.recent.filter((f) => f.source !== 'notebook' && f.source !== 'custom').slice(0, 6);
    el.innerHTML = [
      recent.length ? section('Also had recently', rows(recent)) : '',
      state.custom.length ? section('Family foods', rows(state.custom)) : '',
      section('His usual foods', rows(notebook), 'Tap a food to add one serving. Adjust amounts in the meal tray.'),
    ].join('');
    return;
  }

  if (view === 'Packaged') {
    ensurePackaged();
    el.innerHTML = state.packagedLoading ? loadingRow('Loading products…')
      : `<div class="empty"><span class="empty-emoji" aria-hidden="true">📦</span><strong>Search packaged foods</strong>${state.packaged?.length ? `${state.packaged.length.toLocaleString('en-ZA')} South African products` : 'South African products'} from Open Food Facts. Type a name above, like “Weet-Bix”, or use Barcode.</div>`;
    return;
  }

  if (view === 'all') {
    const groups = new Map();
    for (const f of allLocalFoods()) {
      const key = f.source === 'custom' ? 'Family' : f.category;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const order = ['Family', ...CATEGORIES];
    el.innerHTML = [...groups.entries()]
      .sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0]))
      .map(([name, foods]) => section(categoryTitle(name), rows(searchFoods(foods, ''))))
      .join('');
    return;
  }

  const list = view === 'Family' ? searchFoods(state.custom, '') : searchFoods(allLocalFoods(), '', view);
  el.innerHTML = list.length ? section(null, rows(list))
    : `<div class="empty"><span class="empty-emoji" aria-hidden="true">🤔</span><strong>Nothing here yet</strong>Try another group, or search above.</div>`;
}

// ---------------------------------------------------------------- Settings screen

function settingRow(label, value) {
  return `<div class="row"><span class="row-main"><span class="row-title">${esc(label)}</span></span><span class="row-value">${value}</span></div>`;
}

function phoneRows() {
  const me = state.me;
  if (!getCgmKey()) {
    return `<button class="row" data-action="join"><span class="row-main"><span class="row-title row-link">Connect this phone</span><span class="row-sub">Open the invite link from the admin, or paste it here.</span></span>${ICON.chevron}</button>`;
  }
  const r = state.cgm.reading;
  const roleName = { admin: 'Admin', family: 'Family', tv: 'View only' }[me?.role] || 'Connected';
  return [
    settingRow('This phone', esc(me?.name || 'Connected')),
    settingRow('Access', `${roleName}${me?.legacy ? ' (old shared link)' : ''}`),
    settingRow('Glucose readings', state.cgm.error && !r ? 'Not working' : r ? `${readingValue(r)} ${r.arrow} · ${readingAge(r)}` : 'Connecting…'),
    state.cgm.error ? `<div class="row"><span class="row-main"><span class="row-sub">${esc(state.cgm.error)}</span></span></div>` : '',
    `<button class="row" data-action="remove-this-phone"><span class="row-main"><span class="row-title row-danger">Disconnect this phone</span></span></button>`,
  ].join('');
}

// High-glucose alerts for this phone. state.alerts.on: null until checked, then true/false.
function alertRows() {
  const me = state.me;
  if (!getCgmKey() || !me || me.role === 'tv') return '';
  const title = 'High for over 2.5 hours';
  const note = (sub) => `<div class="row"><span class="row-main"><span class="row-title">${title}</span><span class="row-sub">${sub}</span></span></div>`;
  if (me.legacy) return note('Connect this phone with an invite from the admin to get alerts.');
  const support = alertSupport();
  if (support === 'home-screen') return note('On iPhone, alerts only work from the Home Screen icon. Add DiaBuddy to the Home Screen (Share → Add to Home Screen), open it from there, then turn alerts on here.');
  if (support === 'blocked') return note('Notifications are blocked for DiaBuddy. Allow them in the phone’s settings, then come back here.');
  if (support === 'unsupported') return note('This browser can’t show alerts. Try Chrome on Android, or the Home Screen app on iPhone.');

  const { on, busy } = state.alerts;
  if (on == null && !busy) {
    state.alerts.busy = true;
    alertsOn().then((v) => { state.alerts = { on: v }; }, () => { state.alerts = { on: false }; })
      .finally(() => { if (state.tab === 'settings') renderSettings(); });
  }
  return `<div class="row"><span class="row-main"><label for="alerts-high" class="row-title">${title}</label>
      <span class="row-sub">Notifies this phone when he’s been ${HIGH_MMOL} mmol/L or higher for 2.5 hours.</span></span>
      <input type="checkbox" class="switch" id="alerts-high" ${on ? 'checked' : ''} ${on == null || busy ? 'disabled' : ''}></div>
    ${on ? '<button class="row" data-action="test-alert"><span class="row-main"><span class="row-title row-link">Send a test alert</span></span></button>' : ''}`;
}

async function toggleAlerts(input) {
  const want = input.checked;
  state.alerts = { on: !want, busy: true };
  input.disabled = true;
  try {
    if (want) await turnOnAlerts(); else await turnOffAlerts();
    state.alerts = { on: want };
    toast(want ? 'Alerts are on for this phone' : 'Alerts are off for this phone');
  } catch (err) {
    state.alerts = { on: !want };
    toast(err.message || 'Couldn’t change alerts. Try again.');
  }
  renderSettings();
}

async function testAlert() {
  try {
    await sendTestAlert();
    toast('Test alert sent');
  } catch (err) {
    toast(err.message || 'The test alert didn’t send. Try again.');
  }
}

function renderSettings() {
  const s = state.settings;
  const el = $('#settings-body');
  const meta = state.settingsMeta;
  const loadedFrom = !meta ? 'Not loaded yet.'
    : meta.from === 'cache' ? `Offline. Showing the copy saved on ${fmtDate(new Date(meta.fetchedAt).toISOString())}.`
    : 'Up to date.';
  const dash = '<span>Not set</span>';

  const doseRows = s ? [
    settingRow('Carb ratio', s.icr > 0 ? `<strong>1 U : ${fmt(s.icr)} g</strong>` : dash),
    settingRow('Correction factor', s.cf > 0 ? `<strong>1 U : ${fmt(s.cf)} mmol/L</strong>` : dash),
    settingRow('Target BG', s.targetBg > 0 ? `<strong>${fmt(s.targetBg)} mmol/L</strong>` : dash),
    settingRow('Low (no insulin) below', `${fmt(s.hypoThreshold ?? 4)} mmol/L`),
    settingRow('Max dose warning', s.maxDose > 0 ? `${fmt(s.maxDose)} U` : 'Off'),
    settingRow('Reduce dose when below target', s.negativeCorrection === false ? 'Off' : 'On'),
    settingRow('Round doses to', `${s.roundTo ?? 0.5} U`),
  ].join('') : settingRow('Settings', getCgmKey() ? 'Not loaded' : 'Connect this phone first');

  const adminRows = isAdmin() ? `
    <button class="row" data-action="edit-settings"><span class="row-main"><span class="row-title row-link">Change dose settings</span></span>${ICON.chevron}</button>
    <button class="row" data-action="settings-history"><span class="row-main"><span class="row-title row-link">Settings change history</span></span>${ICON.chevron}</button>
    <button class="row" data-action="phones"><span class="row-main"><span class="row-title row-link">Phones</span><span class="row-sub">Invite, see and remove family phones</span></span>${ICON.chevron}</button>
    <button class="row" data-action="delete-data"><span class="row-main"><span class="row-title row-danger">Delete his stored data</span></span>${ICON.chevron}</button>` : '';

  const alerts = alertRows();
  el.innerHTML = `
    ${s && !isConfigured(s) ? `<div class="banner banner-warn">${ICON.warn}<div><strong>Not set up yet</strong>${isAdmin() ? 'Tap “Change dose settings” and enter the numbers from his diabetes team.' : 'Ask the admin to set his carb ratio, correction factor and target.'}</div></div>` : ''}
    ${section('His numbers', doseRows, s ? `${esc(loadedFrom)} Last changed ${fmtDate(s.updatedAt)}${s.updatedBy ? ` by ${esc(s.updatedBy)}` : ''}. Only the admin can change these.` : '')}
    ${section('This phone', phoneRows(), 'Each phone has its own key. Removing one doesn’t affect the others.')}
    ${alerts ? section('Alerts', alerts, 'These add to the Dexcom and Libre app alarms; they don’t replace them. A notification can arrive late, or be silenced by Focus or Do Not Disturb.') : ''}
    ${adminRows ? section('Admin', adminRows, 'Changes reach every family phone the next time DiaBuddy opens.') : ''}
    ${section('How the dose is worked out', `
      <div class="row"><span class="row-main"><span class="row-title">Food dose</span><span class="row-sub">Carbs ÷ carb ratio</span></span></div>
      <div class="row"><span class="row-main"><span class="row-title">Correction</span><span class="row-sub">(Current BG − target BG) ÷ correction factor</span></span></div>
      <div class="row"><span class="row-main"><span class="row-title">Total</span><span class="row-sub">Food dose + correction, rounded to the nearest ${s?.roundTo ?? 0.5} U</span></span></div>`,
      'If insulin was given in the last 3 hours, a correction for high BG is left out so doses don’t stack.')}
    ${section('About', `
      <div class="row"><span class="row-main"><span class="row-title">Privacy</span><span class="row-sub">His readings, log and settings are stored in the family’s private Cloudflare account and only reach connected phones.</span></span></div>
      <div class="row"><span class="row-main"><span class="row-title">Food data</span><span class="row-sub">Family notebook · USDA FoodData Central · Open Food Facts (ODbL)</span></span></div>
      <div class="row"><span class="row-main"><span class="row-title">Version</span></span><span class="row-value">${APP_VERSION}</span></div>`,
      'DiaBuddy is a calculator, not medical advice. Always follow the plan from his diabetes team, and use your own judgement.')}
  `;
}

// ---------------------------------------------------------------- Insights

// Forecasts and patterns from his own history (worker/insights.js builds them nightly).
// Information only: ranges from past meals, lows and corrections, never a dose.

const BLOCK_NAMES = ['Night', 'Morning', 'Afternoon', 'Evening'];
const BLOCK_HOURS = ['00–06', '06–12', '12–18', '18–24'];
const MEAL_NAMES = { breakfast: 'Breakfast', lunch: 'Lunch', supper: 'Supper', snack: 'Snacks' };
const KIND_NAMES = { meal: 'Meal', 'low-treatment': 'Low treatment', correction: 'Correction' };
const signed = (d) => `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d))}`;

async function loadInsights({ force = false } = {}) {
  const st = state.insights;
  if (!getCgmKey() || st.loading) return;
  if (!force && st.data && Date.now() - st.at < 10 * 60000) return;
  st.loading = true;
  if (!st.data) renderInsights();
  try {
    const [data, summary] = await Promise.all([
      relayFetch(RELAY_URL, '/insights'),
      relayFetch(RELAY_URL, '/insights/summary').catch(() => null),
    ]);
    Object.assign(st, { data, summary, at: Date.now(), error: null });
  } catch (err) {
    st.error = err.message;
  }
  st.loading = false;
  if (state.tab === 'insights') renderInsights();
}

// The reading Insights may use as "now": fresh and a real number.
function insightsReading() {
  const r = state.cgm.reading;
  return r && !r.low && !r.high && r.ageMinutes <= FRESH_MINUTES ? r : null;
}

function renderInsights() {
  const el = $('#insights-body');
  if (!el) return;
  const st = state.insights;
  if (!getCgmKey()) {
    el.innerHTML = section(null, `<button class="row" data-action="join"><span class="row-main"><span class="row-title row-link">Connect this phone</span><span class="row-sub">Insights come from his readings and log, so this phone needs an invite first.</span></span>${ICON.chevron}</button>`);
    return;
  }
  if (!st.data) {
    el.innerHTML = st.error
      ? `<div class="banner banner-warn">${ICON.warn}<div>${esc(st.error)}</div></div>${section(null, '<button class="row" data-ins="reload"><span class="row-main"><span class="row-title row-link">Try again</span></span></button>')}`
      : section(null, loadingRow('Looking through his history…'));
    return;
  }
  const d = st.data;
  el.innerHTML = [
    insightsStatus(d),
    insightsSummary(d),
    insightsLowRisk(d),
    insightsForecast(d),
    insightsTimeOfDay(d),
    insightsMealTypes(d),
    '<p class="insights-foot">DiaBuddy is a calculator, not medical advice. Always follow his diabetes team’s plan.</p>',
  ].join('');
}

function insightsStatus(d) {
  const c = d.coverage;
  const need = 10;
  const ready = c.meals >= need;
  const updated = d.through ? `Updated to ${esc(fmtDate(d.through))}` : 'The first update runs tonight';
  return section(null, `<div class="row"><span class="row-main">
      <span class="row-title">${ready ? `Based on ${c.meals} meals and ${c.days90} days of readings` : `Learning: ${c.meals} of ${need} meals with full 3-hour readings`}</span>
      <span class="row-sub">${c.lowTreatments} low treatments · ${c.corrections} corrections · ${updated}</span>
      ${ready ? '' : `<span class="progress" role="progressbar" aria-label="Meals learned" aria-valuemin="0" aria-valuemax="${need}" aria-valuenow="${c.meals}"><span style="width:${Math.min(100, (c.meals / need) * 100)}%"></span></span>`}
    </span></div>`);
}

function insightsSummary(d) {
  if (!d.summaries) return '';
  const st = state.insights;
  const s = st.summary?.summary;
  const canWrite = state.me && state.me.role !== 'tv';
  if (!s) {
    const body = canWrite
      ? `<button class="row" data-ins="summary"${st.summaryBusy ? ' disabled' : ''}><span class="row-main"><span class="row-title row-link">${st.summaryBusy ? 'Writing…' : 'Write this week’s summary'}</span><span class="row-sub">Claude reads this week’s numbers (percentages and averages only) and writes a short summary.</span></span></button>`
      : '<div class="row"><span class="row-main"><span class="row-sub">This week’s summary hasn’t been written yet.</span></span></div>';
    return section('This week', body);
  }
  const points = s.points.map((p) => `<li>${esc(p)}</li>`).join('');
  return section('This week', `<div class="row summary-row"><span class="row-main">
      <span class="row-title">${esc(s.headline)}</span>
      ${points ? `<ul class="summary-points">${points}</ul>` : ''}
      ${s.discussWithTeam ? `<span class="summary-team">${ICON.warn}<span><strong>Worth discussing with his diabetes team:</strong> ${esc(s.discussWithTeam)}</span></span>` : ''}
    </span></div>
    ${isAdmin() ? `<button class="row" data-ins="summary-refresh"${st.summaryBusy ? ' disabled' : ''}><span class="row-main"><span class="row-title row-link">${st.summaryBusy ? 'Writing…' : 'Write it again'}</span></span></button>` : ''}`,
  'Written by Claude from this week’s numbers. Not medical advice.');
}

function insightsLowRisk(d) {
  const r = insightsReading();
  const low = d.low;
  let tone = '';
  let text;
  if (!r) {
    text = '<span class="row-title">Needs a current reading</span><span class="row-sub">Shown when there’s a reading from the last 10 minutes.</span>';
  } else if (r.mmol < low) {
    tone = 'risk-high';
    text = `<span class="row-title">He’s low now (${fmt(r.mmol)})</span><span class="row-sub">Treat the low first: ${LOW_TREATMENT_G} g of fast carbs, recheck in 15 minutes.</span>`;
  } else {
    const slope = recentSlope(r.history);
    const lastInsulin = (state.todayLog || []).some((e) => (e.insulinGiven ?? 0) > 0 && Date.now() - Date.parse(e.at) <= 2 * 3600000);
    const trend = slope == null ? r.trendText : slope <= -0.06 ? 'falling fast' : slope <= -0.02 ? 'falling' : slope >= 0.06 ? 'rising fast' : slope >= 0.02 ? 'rising' : 'steady';
    const res = slope == null ? null : lowRisk(d.moments, { bg: r.mmol, slope, recentInsulin: lastInsulin }, { low });
    const now = `Now ${fmt(r.mmol)} and ${esc(trend)}${lastInsulin ? ', insulin in the last 2 hours' : ''}.`;
    if (!res || res.learning) {
      text = `<span class="row-title">${now}</span><span class="row-sub">Still learning: ${res ? `${res.have} of ${res.need}` : 'not enough'} similar moments in his history so far.</span>`;
    } else {
      tone = res.wentLow * 3 >= res.n ? 'risk-high' : res.wentLow > 0 ? 'risk-some' : '';
      text = `<span class="row-title">${now}</span><span class="row-sub">In similar moments he went below ${fmt(low)} within 45 minutes in <strong>${res.wentLow} of ${res.n}</strong> (lowest usually ${fmt(res.lowest)}).</span>`;
    }
  }
  return section('Low risk now', `<div class="row low-risk ${tone}">${tone ? ICON.warn : ''}<span class="row-main">${text}</span></div>`,
    'From his history at this level and trend. Check with a finger-prick if unsure.');
}

function forecastInput(kind) {
  const st = state.insights;
  const r = insightsReading();
  const bg = st.bgTyped ?? (r ? r.mmol : null);
  const s = state.settings;
  if (kind === 'meal') {
    const trayCarbs = Math.round(mealCarbs());
    const carbs = st.carbs ?? (trayCarbs > 0 ? trayCarbs : 40);
    return { carbs, insulin: s?.icr > 0 ? carbs / s.icr : null, mealOfDay: st.mealOfDay || mealOfDay(), bg, fromTray: st.carbs == null && trayCarbs > 0 };
  }
  if (kind === 'low-treatment') return { bg: st.bgTyped ?? (r && r.mmol < 5 ? r.mmol : 3.5) };
  let units = st.units;
  if (units == null && bg != null && isConfigured(s)) {
    const dose = calculateDose({ carbs: 0, bg, settings: s });
    units = dose.status === 'ok' && dose.rounded > 0 ? dose.rounded : null;
  }
  return { bg: bg ?? 14, units: units ?? 1 };
}

function insightsForecast(d) {
  const st = state.insights;
  const kind = st.kind;
  const input = forecastInput(kind);
  const f = forecastResponse(d.responses, kind, input, { low: d.low });
  const r = insightsReading();
  const bgFromSensor = st.bgTyped == null && r && (kind !== 'low-treatment' || r.mmol < 5);

  const tabs = `<div class="segmented ins-seg" role="group" aria-label="Forecast for">${Object.entries(KIND_NAMES).map(([k, label]) =>
    `<button type="button" data-ins-kind="${k}" aria-pressed="${k === kind}">${label}</button>`).join('')}</div>`;
  const bgRow = `<div class="row field-row"><label for="ins-bg">Starting BG<span class="row-sub">${bgFromSensor ? `From ${sourceName(r)}, ${readingAge(r)}` : 'Type his BG, mmol/L'}</span></label>
      <input id="ins-bg" data-ins-input="bg" inputmode="decimal" value="${input.bg != null ? fmt(input.bg) : ''}" placeholder="–" style="width:4rem;text-align:center"></div>`;
  let fields = '';
  if (kind === 'meal') {
    fields = `<div class="row field-row"><label for="ins-carbs">Carbs<span class="row-sub">${input.fromTray ? 'From the meal in progress' : 'Grams of carbs'}</span></label>
        <span class="stepper"><button type="button" data-ins-step="carbs:-5" aria-label="5 g less">${ICON.minus}</button></span>
        <input id="ins-carbs" data-ins-input="carbs" inputmode="numeric" value="${Math.round(input.carbs)}" style="width:3.5rem;text-align:center">
        <span class="stepper"><button type="button" data-ins-step="carbs:5" aria-label="5 g more">${ICON.plus}</button></span></div>
      <div class="chips ins-chips" role="group" aria-label="Meal">${Object.entries(MEAL_NAMES).map(([k, label]) =>
        `<button type="button" class="chip" data-ins-meal="${k}" aria-selected="${k === input.mealOfDay}">${label.replace(/s$/, '')}</button>`).join('')}</div>
      ${bgRow}`;
  } else if (kind === 'low-treatment') {
    fields = `${bgRow}<div class="row"><span class="row-main"><span class="row-title">${LOW_TREATMENT_G} g of fast carbs</span><span class="row-sub">The 15-15 rule: recheck after 15 minutes</span></span></div>`;
  } else {
    fields = `${bgRow}<div class="row field-row"><label for="ins-units">Correction<span class="row-sub">${st.units == null ? 'Worked out from his BG; change it to compare' : 'Units'}</span></label>
        <span class="stepper"><button type="button" data-ins-step="units:-0.5" aria-label="Half a unit less">${ICON.minus}</button></span>
        <input id="ins-units" data-ins-input="units" inputmode="decimal" value="${fmt(input.units)}" style="width:3.5rem;text-align:center">
        <span class="stepper"><button type="button" data-ins-step="units:0.5" aria-label="Half a unit more">${ICON.plus}</button></span></div>`;
  }

  let result;
  const noun = { meal: 'meals', 'low-treatment': 'low treatments', correction: 'corrections' }[kind];
  if (f.learning) {
    result = `<div class="row"><span class="row-main"><span class="row-title">Still learning</span><span class="row-sub">${f.have} of ${f.need} ${noun} with full readings so far. Forecasts start once there are ${f.need}.</span></span></div>`;
  } else if (f.tooFew) {
    result = `<div class="row"><span class="row-main"><span class="row-title">Not enough similar ${noun} yet</span><span class="row-sub">${f.have} of ${f.need} needed. Try other numbers, or check back as his log grows.</span></span></div>`;
  } else {
    result = `${forecastChart(f)}<p class="forecast-caption">${forecastCaption(f, input)}</p>
      ${f.lowCount > 0 ? `<div class="banner banner-warn">${ICON.warn}<div>${f.lowCount} of ${f.n} similar ${noun} went low afterwards.</div></div>` : ''}`;
  }
  return section('Forecast', `${tabs}<div class="ins-fields">${fields}</div><div class="forecast">${result}</div>`,
    'A pattern from his past, not a dose. The dose screen works out doses.');
}

// Plain-language summary of a forecast, in mmol/L when the starting BG is known.
function forecastCaption(f, input) {
  const at = (delta) => (f.base != null ? fmt(f.base + delta) : signed(delta));
  const from = f.base != null ? ` from ${fmt(f.base)}` : '';
  if (f.kind === 'meal') {
    return `After about ${Math.round(input.carbs)} g${from}, he usually peaks at <strong>${at(f.peak.median)}</strong> (range ${at(f.peak.min)} to ${at(f.peak.max)}) about ${f.peak.minutes} min after eating; 3 hours later about ${at(f.end)}. From ${f.n} similar meals.`;
  }
  if (f.kind === 'low-treatment') {
    return `${f.base != null ? `From ${fmt(f.base)}, ` : ''}${LOW_TREATMENT_G} g usually gets him to <strong>${at(f.at15.median)}</strong> at the 15-minute recheck (range ${at(f.at15.min)} to ${at(f.at15.max)}). Back above ${fmt(f.low)} in ${f.recovered} of ${f.n} lows; ${f.neededSecond} needed a second ${LOW_TREATMENT_G} g.${f.at60 != null ? ` An hour later he’s usually ${at(f.at60)}.` : ''}`;
  }
  return `After about ${fmt(input.units)} U${from}, he usually comes down to <strong>${at(f.end)}</strong> after 3 hours (lowest ${at(f.nadir.median)}, about ${f.nadir.minutes} min in). From ${f.n} similar corrections.`;
}

// Fan chart: the middle half of past responses (band) and the typical one (line).
function forecastChart(f) {
  const W = 300, H = 132, padL = 30, padR = 10, padT = 10, padB = 22;
  const abs = f.base != null;
  const val = (delta) => (delta == null ? null : abs ? f.base + delta : delta);
  const pts = f.curve.filter((c) => c.median != null);
  const lowsHighs = pts.flatMap((c) => [val(c.q25), val(c.q75), val(c.median)]).filter((v) => v != null);
  const lo = Math.floor(Math.min(abs ? Math.min(3, f.low - 0.5) : -2, ...lowsHighs));
  const hi = Math.ceil(Math.max(abs ? TARGET_TOP + 1 : 3, ...lowsHighs));
  const maxMin = f.curve.at(-1).min;
  const x = (m) => padL + (m / maxMin) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const xy = (m, v) => `${x(m).toFixed(1)},${y(v).toFixed(1)}`;

  const band = `${pts.map((c) => xy(c.min, val(c.q75))).join(' ')} ${[...pts].reverse().map((c) => xy(c.min, val(c.q25))).join(' ')}`;
  const line = pts.map((c) => xy(c.min, val(c.median))).join(' ');
  const ticks = f.kind === 'low-treatment' ? [0, 15, 30, 45, 60] : [0, 60, 120, 180];
  const tickLabel = (m) => (f.kind === 'low-treatment' ? (m === 0 ? 'now' : `${m} min`) : m === 0 ? 'now' : `${m / 60} h`);
  const yTicks = abs ? [f.low, TARGET_TOP].filter((v) => v > lo && v < hi) : [0];

  let marker = '';
  if (f.kind === 'meal') {
    const c = f.curve[Math.round(f.peak.minutes / f.step)];
    if (c?.median != null) marker = `<circle class="fc-dot" cx="${x(c.min).toFixed(1)}" cy="${y(val(c.median)).toFixed(1)}" r="4" />`;
  } else if (f.kind === 'correction') {
    const c = f.curve[Math.round(f.nadir.minutes / f.step)];
    if (c?.median != null) marker = `<circle class="fc-dot" cx="${x(c.min).toFixed(1)}" cy="${y(val(c.median)).toFixed(1)}" r="4" />`;
  } else {
    marker = `<line class="fc-recheck" x1="${x(15).toFixed(1)}" x2="${x(15).toFixed(1)}" y1="${padT}" y2="${H - padB}" /><text class="fc-label" x="${(x(15) + 4).toFixed(1)}" y="${padT + 9}">Recheck</text>`;
  }
  // Wide invisible columns carry the per-point tooltip, so it's easy to hit on a phone.
  const colW = (W - padL - padR) / Math.max(1, pts.length - 1);
  const hits = pts.map((c) => `<rect class="fc-hit" x="${(x(c.min) - colW / 2).toFixed(1)}" y="0" width="${colW.toFixed(1)}" height="${H}"><title>${tickLabel(c.min) === 'now' ? 'Start' : tickLabel(c.min)}: usually ${abs ? fmt(val(c.median)) : signed(c.median)} (${abs ? `${fmt(val(c.q25))}–${fmt(val(c.q75))}` : `${signed(c.q25)} to ${signed(c.q75)}`})</title></rect>`).join('');
  const summary = `${KIND_NAMES[f.kind]} forecast from ${f.n} similar: ${pts.filter((c) => ticks.includes(c.min)).map((c) => `${tickLabel(c.min)} ${abs ? fmt(val(c.median)) : signed(c.median)}`).join(', ')}.`;

  return `<svg class="forecast-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(summary)}">
    ${abs ? `<rect class="trend-band" x="${padL}" y="${y(Math.min(TARGET_TOP, hi)).toFixed(1)}" width="${W - padL - padR}" height="${Math.max(0, y(Math.max(f.low, lo)) - y(Math.min(TARGET_TOP, hi))).toFixed(1)}" rx="4" />
      <line class="trend-low" x1="${padL}" x2="${W - padR}" y1="${y(f.low).toFixed(1)}" y2="${y(f.low).toFixed(1)}" />` : `<line class="fc-zero" x1="${padL}" x2="${W - padR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" />`}
    ${yTicks.map((v) => `<text class="fc-axis" x="${padL - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${abs ? fmt(v, 0) : '0'}</text>`).join('')}
    ${ticks.map((m) => `<text class="fc-axis" x="${x(m).toFixed(1)}" y="${H - 6}" text-anchor="${m === 0 ? 'start' : m === maxMin ? 'end' : 'middle'}">${tickLabel(m)}</text>`).join('')}
    <polygon class="fc-band" points="${band}" />
    <polyline class="fc-line" points="${line}" />
    ${marker}${hits}
  </svg>
  <p class="trend-key">Line: typical · shaded: middle half of past ${f.kind === 'meal' ? 'meals' : f.kind === 'correction' ? 'corrections' : 'lows'}${abs ? ` · green: ${fmt(f.low)}–${TARGET_TOP}` : ' · change from start'}</p>`;
}

function insightsTimeOfDay(d) {
  const st = state.insights;
  const blocks = d.blocks[st.days];
  const any = blocks.some((b) => b.n > 0);
  const seg = `<div class="segmented ins-seg" role="group" aria-label="Period">${[14, 30].map((n) =>
    `<button type="button" data-ins-days="${n}" aria-pressed="${n === st.days}">${n} days</button>`).join('')}</div>`;
  if (!any) return section('Time of day', `${seg}<div class="row"><span class="row-main"><span class="row-sub">No readings in these days yet.</span></span></div>`);
  const legend = `<div class="band-legend" aria-hidden="true">
      <span><i class="b-low"></i>Below ${fmt(d.low)}</span><span><i class="b-in"></i>${fmt(d.low)}–${TARGET_TOP}</span><span><i class="b-mid"></i>${TARGET_TOP}–${HIGH_MMOL}</span><span><i class="b-high"></i>${HIGH_MMOL}+</span></div>`;
  const body = st.table
    ? `<table class="band-table"><thead><tr><th scope="col">Time</th><th scope="col">Below ${fmt(d.low)}</th><th scope="col">${fmt(d.low)}–${TARGET_TOP}</th><th scope="col">${TARGET_TOP}–${HIGH_MMOL}</th><th scope="col">${HIGH_MMOL}+</th></tr></thead><tbody>
        ${blocks.map((b, i) => `<tr><th scope="row">${BLOCK_NAMES[i]}</th>${b.pct.map((p) => `<td>${b.n ? `${Math.round(p)}%` : '–'}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : blocks.map((b, i) => {
      const label = b.n ? `${Math.round(b.pct[1])}% in range · high ${Math.round(b.pct[2] + b.pct[3])}%${b.pct[0] >= 0.5 ? ` · low ${Math.round(b.pct[0])}%` : ''}` : 'No readings';
      const segs = b.pct.map((p, j) => (p > 0 ? `<span class="b-${['low', 'in', 'mid', 'high'][j]}" style="width:${p}%"></span>` : '')).join('');
      return `<div class="row block-row"><span class="row-main"><span class="row-title">${BLOCK_NAMES[i]} <span class="block-hours">${BLOCK_HOURS[i]}</span></span>
          <span class="band-bar" role="img" aria-label="${esc(`${BLOCK_NAMES[i]}: ${b.pct.map((p, j) => `${Math.round(p)}% ${['below low', 'in range', '10 to 14', '14 or more'][j]}`).join(', ')}`)}">${segs}</span>
          <span class="row-sub">${label}${b.mean != null ? ` · average ${fmt(b.mean)}` : ''}</span></span></div>`;
    }).join('');
  return section('Time of day', `${seg}${st.table ? '' : legend}${body}
    <button class="row" data-ins="table"><span class="row-main"><span class="row-title row-link">${st.table ? 'Show as bars' : 'Show as table'}</span></span></button>`);
}

function insightsMealTypes(d) {
  const rows = Object.entries(MEAL_NAMES).map(([k, label]) => {
    const m = d.mealTypes[k];
    let tag;
    let note = '';
    if (m.n < 5) tag = `<span class="ins-tag">Needs 5 meals (has ${m.n})</span>`;
    else if (m.end >= 3) { tag = '<span class="ins-tag tag-high">Often ends high</span>'; note = 'Worth discussing with his diabetes team.'; }
    else if (m.end <= -2 || m.lows * 5 >= m.n) { tag = '<span class="ins-tag tag-low">Often ends low</span>'; note = 'Worth discussing with his diabetes team.'; }
    else tag = '<span class="ins-tag tag-ok">Looks on target</span>';
    const detail = m.n ? `${m.n} meal${m.n === 1 ? '' : 's'}${m.end != null ? ` · 3 h later usually ${signed(m.end)}` : ''}${m.lows ? ` · ${m.lows} went low` : ''}` : 'No meals logged yet';
    return `<div class="row"><span class="row-main"><span class="row-title">${label}</span><span class="row-sub">${detail}${note ? `. ${note}` : ''}</span></span>${tag}</div>`;
  }).join('');
  return section('After meals', rows, 'Last 30 days: where he is 3 hours after eating, compared with before.');
}

async function writeWeeklySummary(refresh) {
  const st = state.insights;
  st.summaryBusy = true;
  renderInsights();
  try {
    st.summary = await relayFetch(RELAY_URL, '/insights/summary', { method: 'POST', body: refresh ? { refresh: true } : {}, timeoutMs: 60000 });
  } catch (err) {
    toast(err.message);
  }
  st.summaryBusy = false;
  renderInsights();
}

function initInsights() {
  const el = $('#insights-body');
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-ins], [data-ins-kind], [data-ins-days], [data-ins-meal], [data-ins-step]');
    if (!t) return;
    const st = state.insights;
    const d = t.dataset;
    if (d.ins === 'reload') loadInsights({ force: true });
    else if (d.ins === 'summary') writeWeeklySummary(false);
    else if (d.ins === 'summary-refresh') writeWeeklySummary(true);
    else if (d.ins === 'table') st.table = !st.table;
    else if (d.insKind) { st.kind = d.insKind; st.bgTyped = null; st.units = null; }
    else if (d.insDays) st.days = Number(d.insDays);
    else if (d.insMeal) st.mealOfDay = d.insMeal;
    else if (d.insStep) {
      const [field, by] = d.insStep.split(':');
      const input = forecastInput(st.kind);
      const next = Math.round(((field === 'carbs' ? input.carbs : input.units) + Number(by)) * 2) / 2;
      st[field] = Math.max(field === 'carbs' ? 5 : 0.5, Math.min(field === 'carbs' ? 200 : 20, next));
    }
    if (!d.ins || d.ins === 'table') renderInsights();
  });
  // Typed values update the forecast once the field is left (or Enter), so typing isn't interrupted.
  el.addEventListener('change', (e) => {
    const field = e.target.dataset.insInput;
    if (!field) return;
    const v = num(e.target.value);
    const st = state.insights;
    if (field === 'bg') st.bgTyped = v != null && v >= 1 && v <= 33 ? v : null;
    if (field === 'carbs') st.carbs = v != null && v > 0 && v <= 300 ? Math.round(v) : null;
    if (field === 'units') st.units = v != null && v > 0 && v <= 20 ? Math.round(v * 2) / 2 : null;
    renderInsights();
  });
}

// ---------------------------------------------------------------- Tray

const tray = {
  el: null, head: null, scrim: null,
  y: 0, anim: null, visible: false, expanded: false,
  get height() { return this.el.offsetHeight; },
  get peek() { return this.head.offsetHeight; },
  get collapsedY() { return this.height - this.peek; },
  get hiddenY() { return this.height + 12; },
};

function setTrayY(y) {
  tray.y = y;
  tray.el.style.transform = `translate3d(0, ${y}px, 0)`;
  const openness = clamp(1 - y / Math.max(1, tray.collapsedY), 0, 1);
  tray.scrim.style.opacity = String(openness);
  // Keep the list from showing through the translucent tab bar while collapsed.
  tray.body.style.opacity = String(clamp(openness * 3, 0, 1));
  tray.body.style.visibility = openness > 0.01 ? 'visible' : 'hidden';
  tray.scrim.classList.toggle('active', openness > 0.05);
}

function animateTray(to, { velocity = 0, dampingRatio = 1, response = 0.35, onComplete } = {}) {
  tray.anim?.stop();
  tray.anim = spring({ from: tray.y, to, velocity, dampingRatio, response, onUpdate: setTrayY, onComplete });
}

function setTrayExpanded(expanded, velocity = 0) {
  tray.expanded = expanded;
  $('#tray-toggle').setAttribute('aria-expanded', String(expanded));
  // A little bounce only when a flick carried momentum into the release.
  const bounce = Math.abs(velocity) > 300;
  animateTray(expanded ? 0 : tray.collapsedY, { velocity, dampingRatio: bounce ? 0.8 : 1, response: bounce ? 0.3 : 0.35 });
}

function renderTray({ pulse = false } = {}) {
  const carbs = mealCarbs();
  const n = state.meal.length;
  $('#tray-carbs').textContent = `${fmt(carbs)} g carbs`;
  $('#tray-count').textContent = n === 1 ? '1 food · tap to check' : `${n} foods · tap to check`;
  if (pulse && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const c = $('#tray-carbs');
    c.classList.remove('dose-pop');
    void c.offsetWidth;
    c.classList.add('dose-pop');
  }

  $('#tray-body').innerHTML = n ? `
    <section class="section" style="margin-top:6px">
      <div class="group">${state.meal.map((l) => `
        <div class="row">
          <button class="row-main" data-line="${esc(l.food.id)}" style="text-align:left" aria-label="Change amount of ${esc(l.food.name)}">
            <span class="row-title">${esc(l.food.name)}</span>
            <span class="row-sub"><span class="line-qty">${fmt(l.servings, 2)} × ${esc(l.food.serving.label)}</span>${badge(l.food)}</span>
          </button>
          <span class="row-value"><strong>${l.food.free ? '0' : fmt(lineCarbs(l.food, l.servings))} g</strong></span>
          <span class="stepper">
            <button data-step="-1" data-id="${esc(l.food.id)}" aria-label="Less ${esc(l.food.name)}">${ICON.minus}</button>
            <button data-step="1" data-id="${esc(l.food.id)}" aria-label="More ${esc(l.food.name)}">${ICON.plus}</button>
          </span>
        </div>`).join('')}
      </div>
      <p class="section-footer">Steps are half a serving. Tap a food to enter grams instead.</p>
    </section>
    <div class="sheet-actions"><button class="btn btn-danger" data-action="clear-meal">Clear meal</button></div>` : '';

  const show = n > 0 && state.tab === 'foods';
  document.body.classList.toggle('has-tray', show);
  if (show && !tray.visible) {
    tray.visible = true;
    tray.el.hidden = false;
    setTrayY(tray.hiddenY);
    tray.expanded = false;
    animateTray(tray.collapsedY);
  } else if (!show && tray.visible) {
    tray.visible = false;
    tray.expanded = false;
    animateTray(tray.hiddenY, { onComplete: () => { if (!tray.visible) tray.el.hidden = true; } });
  }
}

function initTray() {
  tray.el = $('#tray');
  tray.head = $('#tray-head');
  tray.body = $('#tray-body');
  tray.scrim = $('#tray-scrim');
  let drag = null;
  let suppressClick = false;

  tray.head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('[data-action]')) return;
    tray.anim?.stop(); // grab it mid-flight
    drag = { startY: e.clientY, originY: tray.y, moved: false, tracker: new VelocityTracker(), id: e.pointerId };
    drag.tracker.add(e.clientY);
  });
  tray.head.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < 6) return;
    if (!drag.moved) { drag.moved = true; tray.head.setPointerCapture(e.pointerId); }
    drag.tracker.add(e.clientY);
    let y = drag.originY + dy;
    if (y < 0) y = -rubberband(-y, tray.height);
    setTrayY(Math.min(y, tray.collapsedY + rubberband(Math.max(0, y - tray.collapsedY), tray.height)));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const wasDrag = drag.moved;
    const v = drag.tracker.velocity();
    drag = null;
    if (!wasDrag) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    const projected = tray.y + project(v);
    setTrayExpanded(Math.abs(projected) < Math.abs(projected - tray.collapsedY), v);
  };
  tray.head.addEventListener('pointerup', end);
  tray.head.addEventListener('pointercancel', end);

  $('#tray-toggle').addEventListener('click', (e) => {
    if (suppressClick) { e.stopPropagation(); return; }
    setTrayExpanded(!tray.expanded);
  });
  tray.scrim.addEventListener('click', () => setTrayExpanded(false));
  addEventListener('resize', () => {
    if (tray.visible) { tray.anim?.stop(); setTrayY(tray.expanded ? 0 : tray.collapsedY); }
  });
}

// ---------------------------------------------------------------- Modal sheet

const sheet = { el: null, scrim: null, content: null, y: 0, anim: null, open: false, onClose: null, returnFocus: null };

function setSheetY(y) {
  sheet.y = y;
  sheet.el.style.transform = `translate3d(0, ${y}px, 0)`;
  sheet.scrim.style.opacity = String(clamp(1 - y / Math.max(1, sheet.el.offsetHeight), 0, 1));
}

function animateSheet(to, { velocity = 0, onComplete } = {}) {
  sheet.anim?.stop();
  sheet.anim = spring({ from: sheet.y, to, velocity, dampingRatio: 1, response: 0.35, onUpdate: setSheetY, onComplete });
}

function openSheet(html, { onMount, onClose } = {}) {
  const wasOpen = sheet.open;
  sheet.onClose?.();
  sheet.onClose = onClose || null;
  // A fresh root per sheet, so listeners from the previous sheet go away with it.
  const root = document.createElement('div');
  root.innerHTML = html;
  sheet.content.replaceChildren(root);
  sheet.content.scrollTop = 0;
  if (!wasOpen) {
    sheet.returnFocus = document.activeElement;
    sheet.open = true;
    sheet.el.hidden = false;
    sheet.scrim.hidden = false;
    document.body.classList.add('locked');
    setSheetY(sheet.el.offsetHeight);
  }
  animateSheet(0);
  onMount?.(root);
  if (!wasOpen) $('.close-btn', root)?.focus({ preventScroll: true });
}

function closeSheet(velocity = 0) {
  if (!sheet.open) return;
  sheet.open = false;
  sheet.onClose?.();
  sheet.onClose = null;
  document.body.classList.remove('locked');
  animateSheet(sheet.el.offsetHeight, {
    velocity,
    onComplete: () => {
      if (sheet.open) return;
      sheet.el.hidden = true;
      sheet.scrim.hidden = true;
      sheet.content.innerHTML = '';
      sheet.returnFocus?.focus?.({ preventScroll: true });
    },
  });
}

function sheetHeader(title, subtitle = '') {
  return `<div class="sheet-header">
    <div><h2 class="sheet-title" id="sheet-title">${esc(title)}</h2>${subtitle ? `<p class="sheet-subtitle">${subtitle}</p>` : ''}</div>
    <button class="close-btn" data-action="close-sheet" aria-label="Close">${ICON.close}</button>
  </div>`;
}

function initSheet() {
  sheet.el = $('#sheet');
  sheet.scrim = $('#scrim');
  sheet.content = $('#sheet-content');
  sheet.scrim.addEventListener('click', () => closeSheet());
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet.open) closeSheet(); });

  // Drag down to dismiss, from the grabber or the header.
  let drag = null;
  sheet.el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.target.closest('.sheet-grab, .sheet-header') || e.target.closest('button, input, a')) return;
    sheet.anim?.stop();
    drag = { startY: e.clientY, originY: sheet.y, tracker: new VelocityTracker(), id: e.pointerId };
    drag.tracker.add(e.clientY);
    sheet.el.setPointerCapture(e.pointerId);
  });
  sheet.el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.tracker.add(e.clientY);
    let y = drag.originY + e.clientY - drag.startY;
    if (y < 0) y = -rubberband(-y, sheet.el.offsetHeight);
    setSheetY(y);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const v = drag.tracker.velocity();
    drag = null;
    const h = sheet.el.offsetHeight;
    if (sheet.y + project(v) > h * 0.45) closeSheet(v);
    else animateSheet(0, { velocity: v });
  };
  sheet.el.addEventListener('pointerup', end);
  sheet.el.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------- Toast

let toastTimer = 0;
function toast(message, { action, onAction } = {}) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  if (action) {
    $('button', el).addEventListener('click', () => { onAction?.(); el.classList.remove('show'); }, { once: true });
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 5000 : 2600);
}

// ---------------------------------------------------------------- Amount editor

// `askGrams`: start in grams with an empty field, so an unreliable default
// serving (packaged products) is never added without someone typing the amount.
function mountAmount(root, food, initialServings, onChange, { askGrams = false } = {}) {
  const canGrams = food.serving.grams > 0;
  const st = { mode: askGrams && canGrams ? 'grams' : 'servings', servings: askGrams && canGrams ? 0 : initialServings };
  const step = 0.5;

  const preview = () => {
    const carbs = lineCarbs(food, st.servings);
    $('#amt-preview', root).textContent = !(st.servings > 0) ? 'Enter how many grams he is eating.' : food.free
      ? 'Free food. No carbs counted.'
      : `${fmt(st.servings, 2)} × ${food.serving.label} = ${fmt(carbs)} g carbs`;
    onChange?.(st.servings);
  };

  const paint = () => {
    const value = !(st.servings > 0) ? '' : st.mode === 'grams' ? fmt(st.servings * food.serving.grams, 0) : fmt(st.servings, 2);
    root.innerHTML = `
      ${canGrams ? `<div class="segmented" role="group" aria-label="Amount in">
        <button type="button" data-mode="servings" aria-pressed="${st.mode === 'servings'}">Servings</button>
        <button type="button" data-mode="grams" aria-pressed="${st.mode === 'grams'}">Grams</button>
      </div>` : ''}
      <section class="section" style="margin-top:12px">
        <div class="group">
          <div class="row field-row">
            <label for="amt-input">${st.mode === 'grams' ? 'Grams eaten' : 'Servings'}<span class="row-sub">${st.mode === 'grams' ? 'Weigh it if you can' : 'Half steps'}</span></label>
            ${st.mode === 'servings' ? `<span class="stepper"><button type="button" data-amt="-1" aria-label="Less">${ICON.minus}</button></span>` : ''}
            <input id="amt-input" inputmode="decimal" value="${value}" placeholder="0" style="width:4.5rem" aria-label="${st.mode === 'grams' ? 'Grams' : 'Servings'}">
            ${st.mode === 'servings' ? `<span class="stepper"><button type="button" data-amt="1" aria-label="More">${ICON.plus}</button></span>` : '<span class="unit">g</span>'}
          </div>
        </div>
        <p class="section-footer" id="amt-preview"></p>
      </section>`;
    preview();
  };

  root.addEventListener('click', (e) => {
    const mode = e.target.closest('[data-mode]')?.dataset.mode;
    if (mode && mode !== st.mode) { st.mode = mode; paint(); return; }
    const dir = Number(e.target.closest('[data-amt]')?.dataset.amt);
    if (dir) {
      st.servings = Math.max(step, Math.round((st.servings + dir * step) / step) * step);
      $('#amt-input', root).value = fmt(st.servings, 2);
      preview();
    }
  });
  root.addEventListener('input', (e) => {
    if (e.target.id !== 'amt-input') return;
    const n = num(e.target.value);
    if (n == null || n < 0) return;
    st.servings = st.mode === 'grams' ? n / food.serving.grams : n;
    preview();
  });
  paint();
  return () => st.servings;
}

// ---------------------------------------------------------------- Food detail / line edit

function sourceDetail(food) {
  switch (food.source) {
    case 'notebook': return 'From the family Food Guide notebook.';
    case 'custom': return 'Added by the family admin.';
    case 'usda': return `USDA FoodData Central: “${esc(food.usdaName)}”. Net carbs (fibre removed).`;
    case 'off': return `Open Food Facts, barcode ${esc(food.barcode)}. Entered by the public. Check the label.`;
    case 'manual': return 'Typed in from a label.';
    default: return '';
  }
}

function openFoodDetail(food) {
  const inMeal = mealCount(food.id);
  openSheet(`
    ${sheetHeader(food.name, badge(food))}
    ${food.note ? `<div class="banner banner-info">${ICON.info}<div>${esc(food.note)}</div></div>` : ''}
    ${food.source === 'off' ? `<div class="banner banner-warn">${ICON.warn}<div>Check this against the label: ${fmt(food.per100g)} g carbs per 100 g. If the label says something else, use “Carbs from a label”.</div></div>` : ''}
    ${section(null, [
      settingRow('Serving', esc(food.serving.label)),
      settingRow('Carbs per serving', food.free ? 'Free' : `<strong>${fmt(food.netCarbs)} g</strong>`),
      food.per100g != null ? settingRow('Carbs per 100 g', `${fmt(food.per100g)} g`) : '',
    ].join(''), sourceDetail(food))}
    <div id="amount"></div>
    <div class="sheet-actions">
      <button class="btn btn-primary" id="detail-add">${inMeal ? 'Add more to meal' : 'Add to meal'}</button>
      ${(isAdmin() || cgmReady()) && food.source === 'off' ? '<button class="btn btn-secondary" id="detail-save">Save to family foods</button>' : ''}
      ${food.source === 'custom' && food.relay && cgmReady() ? '<button class="btn btn-danger" id="detail-remove">Remove from family foods</button>' : ''}
    </div>`, {
    onMount(root) {
      const getServings = mountAmount($('#amount', root), food, 1, null, { askGrams: food.source === 'off' });
      $('#detail-add', root).addEventListener('click', () => {
        const s = getServings();
        if (!(s > 0)) return toast('Enter an amount first');
        addToMeal(food, s);
        closeSheet();
        toast(`Added ${food.name}`);
      });
      $('#detail-save', root)?.addEventListener('click', () => openFamilyFoodForm(food));
      $('#detail-remove', root)?.addEventListener('click', (e) => removeFamilyFood(food, e.currentTarget));
    },
  });
}

function openLineEditor(foodId) {
  const line = state.meal.find((l) => l.food.id === foodId);
  if (!line) return;
  const food = line.food;
  openSheet(`
    ${sheetHeader(food.name, badge(food))}
    ${food.note ? `<div class="banner banner-info">${ICON.info}<div>${esc(food.note)}</div></div>` : ''}
    <div id="amount"></div>
    <p class="section-footer">${food.free ? 'Free food. ' : `${fmt(food.netCarbs)} g carbs per ${esc(food.serving.label)}${food.per100g != null ? ` · ${fmt(food.per100g)} g per 100 g` : ''}. `}${sourceDetail(food)}</p>
    <div class="sheet-actions">
      <button class="btn btn-primary" id="line-save">Update</button>
      <button class="btn btn-danger" id="line-remove">Remove from meal</button>
    </div>`, {
    onMount(root) {
      const getServings = mountAmount($('#amount', root), food, line.servings);
      $('#line-save', root).addEventListener('click', () => { setServings(food.id, getServings()); closeSheet(); });
      $('#line-remove', root).addEventListener('click', () => { setServings(food.id, 0); closeSheet(); });
    },
  });
}

// ---------------------------------------------------------------- Manual carbs

function openManual() {
  let mode = 'total';
  openSheet(`
    ${sheetHeader('Carbs from a label', 'Use the “Carbohydrate” line on the nutrition table.')}
    <div class="segmented" role="group" aria-label="Label shows">
      <button type="button" data-m="total" aria-pressed="true">Total carbs</button>
      <button type="button" data-m="per100" aria-pressed="false">Per 100 g</button>
    </div>
    <section class="section" style="margin-top:12px"><div class="group">
      <div class="row field-row"><label for="m-name">Name</label><input id="m-name" class="wide" placeholder="Optional" autocomplete="off"></div>
      <div class="row field-row" data-show="total"><label for="m-carbs">Carbs eaten</label><input id="m-carbs" inputmode="decimal" placeholder="0"><span class="unit">g</span></div>
      <div class="row field-row" data-show="per100" hidden><label for="m-per100">Carbs per 100 g</label><input id="m-per100" inputmode="decimal" placeholder="0"><span class="unit">g</span></div>
      <div class="row field-row" data-show="per100" hidden><label for="m-grams">Grams eaten</label><input id="m-grams" inputmode="decimal" placeholder="0"><span class="unit">g</span></div>
    </div><p class="section-footer" id="m-preview">South African labels already leave out fibre, so use the carbohydrate number as it is.</p></section>
    <div class="sheet-actions"><button class="btn btn-primary" id="m-add">Add to meal</button></div>`, {
    onMount(root) {
      const compute = () => {
        if (mode === 'total') return num($('#m-carbs', root).value);
        const per100 = num($('#m-per100', root).value);
        const grams = num($('#m-grams', root).value);
        return per100 != null && grams != null ? (per100 * grams) / 100 : null;
      };
      root.addEventListener('click', (e) => {
        const m = e.target.closest('[data-m]')?.dataset.m;
        if (!m) return;
        mode = m;
        $$('[data-m]', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === mode)));
        $$('[data-show]', root).forEach((r) => { r.hidden = r.dataset.show !== mode; });
      });
      root.addEventListener('input', () => {
        const c = compute();
        if (mode === 'per100' && c != null) $('#m-preview', root).textContent = `= ${fmt(c)} g carbs`;
      });
      $('#m-add', root).addEventListener('click', () => {
        const carbs = compute();
        if (carbs == null || carbs < 0 || carbs > 500) return toast('Enter the carbs from the label');
        const grams = mode === 'per100' ? num($('#m-grams', root).value) : null;
        const name = $('#m-name', root).value.trim() || 'Carbs from a label';
        addToMeal({
          id: `manual-${Date.now()}`,
          name,
          category: 'Packaged',
          serving: { label: grams ? `${fmt(grams, 0)} g` : `${fmt(carbs)} g carbs`, grams: null },
          netCarbs: Math.round(carbs * 10) / 10,
          source: 'manual',
        });
        closeSheet();
      });
    },
  });
}

// ---------------------------------------------------------------- Label photo

function openPhotoLabel() {
  if (!cgmReady()) { toast('Label photos need the family link. Open it on this phone first.'); return; }
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.setAttribute('capture', 'environment');
  picker.addEventListener('change', () => { if (picker.files?.[0]) scanLabel(picker.files[0]); }, { once: true });
  picker.click();
}

// Phone photos are large; 1568 px on the long side is plenty for reading a table.
async function shrinkPhoto(file, maxSide = 1568) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return { url, data: url.slice(url.indexOf(',') + 1), mediaType: 'image/jpeg' };
}

async function scanLabel(file) {
  openSheet(`
    ${sheetHeader('Reading the label…', 'This takes a few seconds.')}
    <img class="label-photo" id="scan-preview" alt="Your photo of the label" hidden>
    ${loadingRow('Looking at the nutrition table…')}`);
  let photo;
  try {
    photo = await shrinkPhoto(file);
    const preview = $('#scan-preview');
    if (preview) { preview.src = photo.url; preview.hidden = false; }
    const { label } = await relayFetch(cgmUrl(), '/scan-label', { method: 'POST', body: { image: photo.data, mediaType: photo.mediaType }, timeoutMs: 90000 });
    if (sheet.open) openLabelReview(label, photo.url);
  } catch (err) {
    if (!sheet.open) return;
    openSheet(`
      ${sheetHeader('Couldn’t read the label')}
      ${photo ? `<img class="label-photo" src="${photo.url}" alt="Your photo of the label">` : ''}
      <div class="banner banner-warn">${ICON.warn}<div>${esc(err.name === 'AbortError' ? 'No answer from the label reader. Check your signal and try again.' : err.message)}</div></div>
      <div class="sheet-actions">
        <button class="btn btn-primary" data-action="photo-label">Try another photo</button>
        <button class="btn btn-secondary" data-action="manual">Type the carbs in instead</button>
      </div>`);
  }
}

// "2 biscuits (40 g)" → { count: 2, noun: 'biscuit', grams: 40 }. Used to suggest a piece weight.
function parsePieces(label, grams) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s+([a-zA-Z][a-zA-Z -]*?)\s*(?:\(|$)/.exec(label || '');
  if (!m || !(grams > 0)) return null;
  const count = Number(m[1].replace(',', '.'));
  if (!(count > 0) || /^(g|ml|grams?)\b/i.test(m[2])) return null;
  const noun = m[2].trim().replace(/(ies)$/i, 'y').replace(/(es)$/i, (s) => (/(ch|sh|x|s)es$/i.test(m[2].trim()) ? '' : 'e')).replace(/s$/i, '');
  return { count, noun, pieceGrams: Math.round((grams / count) * 10) / 10 };
}

function openLabelReview(label, photoUrl) {
  if (!label.is_nutrition_label) {
    openSheet(`
      ${sheetHeader('That doesn’t look like a nutrition table')}
      <img class="label-photo" src="${photoUrl}" alt="Your photo">
      ${label.notes ? `<div class="banner banner-info">${ICON.info}<div>${esc(label.notes)}</div></div>` : ''}
      <div class="sheet-actions">
        <button class="btn btn-primary" data-action="photo-label">Try another photo</button>
        <button class="btn btn-secondary" data-action="manual">Type the carbs in instead</button>
      </div>`);
    return;
  }

  // DiaBuddy counts carbs without fibre. US-style "total carbohydrate" includes it, so take it off.
  let per100 = label.carbs_per_100g;
  let fibreNote = '';
  if (per100 != null && label.carbs_excludes_fibre === false && label.fibre_per_100g != null) {
    per100 = Math.max(0, Math.round((per100 - label.fibre_per_100g) * 10) / 10);
    fibreNote = `Fibre (${fmt(label.fibre_per_100g)} g) taken off the label’s total carbohydrate.`;
  }
  const labelGrams = label.serving_size_grams || null;
  // Only a per-serving figure printed: work out per 100 g from it when the serving weight is known.
  if (per100 == null && label.carbs_per_serving != null && labelGrams && label.carbs_excludes_fibre !== false) {
    per100 = Math.round((label.carbs_per_serving / labelGrams) * 1000) / 10;
  }
  const labelServing = label.serving_size_label || (labelGrams ? `${fmt(labelGrams, 0)} g` : '');
  const labelServingCarbs = per100 != null && labelGrams ? Math.round(per100 * labelGrams) / 100 : label.carbs_per_serving;
  const pieces = parsePieces(label.serving_size_label, labelGrams);
  const name = [label.product_name, label.brand].filter(Boolean).filter((v, i, a) => i === 0 || !a[0].toLowerCase().includes(v.toLowerCase())).join(' – ');
  const unsure = label.confidence === 'low' ? '<strong>The reader wasn’t sure about this photo.</strong> Look extra carefully. ' : '';
  const canWeigh = per100 != null;
  let mode = labelServing && labelServingCarbs != null ? 'label' : canWeigh ? 'weigh' : 'label';

  openSheet(`
    ${sheetHeader('Check the label', 'Compare every number with the packet.')}
    <img class="label-photo" src="${photoUrl}" alt="Your photo of the label">
    <div class="banner banner-warn">${ICON.warn}<div>${unsure}These numbers are used for his insulin, so check them against the packet before saving.${label.notes ? ` ${esc(label.notes)}` : ''}</div></div>

    <section class="section"><h2 class="section-header">From the label</h2><div class="group">
      <div class="row field-row"><label for="lr-name">Name</label><input id="lr-name" class="wide" value="${esc(name)}" placeholder="What is it?" autocomplete="off"></div>
      <div class="row field-row"><label for="lr-cat">Group</label><select id="lr-cat" class="wide">${CATEGORIES.map((c) => `<option ${c === 'Snacks' ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="row field-row"><label for="lr-100">Carbs per 100 g</label><input id="lr-100" inputmode="decimal" value="${per100 ?? ''}" placeholder="–" style="width:4.5rem"><span class="unit">g</span></div>
      ${labelServing ? `<div class="row"><span class="row-main"><span class="row-title">Label’s serving</span><span class="row-sub">${esc(labelServing)}${labelServingCarbs != null ? ` = ${fmt(labelServingCarbs)} g carbs` : ''}</span></span></div>` : ''}
    </div>${fibreNote ? `<p class="section-footer">${esc(fibreNote)}</p>` : ''}</section>

    <section class="section"><h2 class="section-header">His serving</h2>
      <div class="segmented" role="group" aria-label="His serving" style="margin-top:0;margin-bottom:10px">
        ${labelServing && labelServingCarbs != null ? '<button type="button" data-serve="label">Label serving</button>' : ''}
        ${canWeigh ? '<button type="button" data-serve="weigh">Weigh it</button>' : ''}
        ${canWeigh ? '<button type="button" data-serve="pieces">Count pieces</button>' : ''}
      </div>
      <div class="group">
        <div class="row field-row" data-show="weigh"><label for="lr-g">Grams he has<span class="row-sub">Weigh it if you can</span></label><input id="lr-g" inputmode="decimal" value="${labelGrams ?? ''}" placeholder="0" style="width:4.5rem"><span class="unit">g</span></div>
        <div class="row field-row" data-show="pieces"><label for="lr-n">How many</label><input id="lr-n" inputmode="decimal" value="${pieces?.count ?? 1}" style="width:4.5rem"></div>
        <div class="row field-row" data-show="pieces"><label for="lr-noun">Piece</label><input id="lr-noun" class="wide" value="${esc(pieces?.noun || 'piece')}" placeholder="biscuit, slice…" autocomplete="off"></div>
        <div class="row field-row" data-show="pieces"><label for="lr-pw">One piece weighs<span class="row-sub">${pieces ? 'Worked out from the label' : 'Weigh one if you can'}</span></label><input id="lr-pw" inputmode="decimal" value="${pieces?.pieceGrams ?? ''}" placeholder="0" style="width:4.5rem"><span class="unit">g</span></div>
        <div class="row field-row" data-show="label"><label for="lr-carbs">Carbs per serving<span class="row-sub">From the label</span></label><input id="lr-carbs" inputmode="decimal" value="${labelServingCarbs != null ? fmt(labelServingCarbs) : ''}" placeholder="0" style="width:4.5rem"><span class="unit">g</span></div>
      </div>
      <div class="serve-total" id="lr-total" aria-live="polite"></div>
      <p class="field-error" id="lr-error" hidden></p>
    </section>

    <div class="sheet-actions">
      <button class="btn btn-primary" id="lr-save">Save to family foods</button>
      <button class="btn btn-secondary" id="lr-meal">Use for this meal only</button>
    </div>`, {
    onMount(root) {
      // Works out his serving from whichever mode is selected: { label, grams, carbs } or a problem.
      const serving = () => {
        const p100 = num($('#lr-100', root).value);
        if (mode === 'label') {
          const carbs = num($('#lr-carbs', root).value);
          return carbs == null ? { problem: 'Enter the carbs per serving from the label.' } : { label: labelServing, grams: labelGrams, carbs };
        }
        if (p100 == null) return { problem: 'Enter the carbs per 100 g from the label.' };
        if (mode === 'weigh') {
          const g = num($('#lr-g', root).value);
          return !(g > 0) ? { problem: 'Enter how many grams he has.' } : { label: `${fmt(g)} g`, grams: g, carbs: (p100 * g) / 100 };
        }
        const n = num($('#lr-n', root).value);
        const w = num($('#lr-pw', root).value);
        const noun = $('#lr-noun', root).value.trim() || 'piece';
        if (!(n > 0)) return { problem: 'Enter how many pieces he has.' };
        if (!(w > 0)) return { problem: 'Enter what one piece weighs.' };
        const plural = n === 1 ? noun : /(s|x|ch|sh)$/i.test(noun) ? `${noun}es` : /[^aeiou]y$/i.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
        return { label: `${fmt(n)} ${plural} (${fmt(n * w)} g)`, grams: n * w, carbs: (p100 * n * w) / 100 };
      };
      const paint = () => {
        $$('[data-serve]', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.serve === mode)));
        $$('[data-show]', root).forEach((r) => { r.hidden = r.dataset.show !== mode; });
        const s = serving();
        $('#lr-total', root).innerHTML = s.problem
          ? `<span>${esc(s.problem)}</span>`
          : `<strong>${fmt(s.carbs)} g carbs</strong><span>for ${esc(s.label)}</span>`;
      };
      root.addEventListener('click', (e) => {
        const m = e.target.closest('[data-serve]')?.dataset.serve;
        if (m) { mode = m; paint(); }
      });
      root.addEventListener('input', paint);
      paint();

      const collect = () => {
        const s = serving();
        const food = {
          name: $('#lr-name', root).value.trim(),
          category: $('#lr-cat', root).value,
          serving: { label: s.label, grams: s.grams ? Math.round(s.grams * 10) / 10 : null },
          netCarbs: s.carbs != null ? Math.round(s.carbs * 10) / 10 : null,
          per100g: num($('#lr-100', root).value),
          note: fibreNote || null,
          fromPhoto: true,
        };
        const problem = s.problem || (!food.name ? 'Give it a name.' : food.netCarbs < 0 || food.netCarbs > 300 ? 'Those carbs look wrong. Check the label.' : '');
        const err = $('#lr-error', root);
        err.hidden = !problem;
        err.textContent = problem;
        return problem ? null : food;
      };
      $('#lr-meal', root).addEventListener('click', () => {
        const food = collect();
        if (!food) return;
        addToMeal({ ...food, id: `photo-${Date.now().toString(36)}`, source: 'manual' });
        closeSheet();
        toast(`Added ${food.name}`);
      });
      $('#lr-save', root).addEventListener('click', async (e) => {
        const food = collect();
        if (!food) return;
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          await saveFamilyFood({ ...food, id: `fam-${Date.now().toString(36)}` });
          closeSheet();
          refreshRows();
          const saved = state.relayFoods.find((f) => f.name === food.name) || state.custom.find((f) => f.name === food.name);
          toast(`Saved ${food.name} for everyone`, saved ? { action: 'Add to meal', onAction: () => addToMeal(saved) } : {});
        } catch (ex) {
          btn.disabled = false;
          btn.textContent = 'Save to family foods';
          const err = $('#lr-error', root);
          err.hidden = false;
          err.textContent = ex.message;
        }
      });
    },
  });
}

// ---------------------------------------------------------------- Barcode

function openBarcode() {
  const canScan = 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia;
  let stream = null;
  let raf = 0;
  const stopCamera = () => { cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); stream = null; };

  openSheet(`
    ${sheetHeader('Barcode', 'Find a packaged product by its barcode.')}
    <div id="scanner-slot"></div>
    <section class="section"><div class="group">
      <div class="row field-row"><label for="bc-input">Barcode</label><input id="bc-input" class="wide" inputmode="numeric" placeholder="6001…" autocomplete="off"></div>
    </div><p class="section-footer" id="bc-status">The numbers under the stripes.</p></section>
    <div class="sheet-actions">
      <button class="btn btn-primary" id="bc-find">Find product</button>
      ${canScan ? '<button class="btn btn-secondary" id="bc-scan">Scan with camera</button>' : ''}
    </div>`, {
    onClose: stopCamera,
    onMount(root) {
      const status = $('#bc-status', root);
      const find = async (code) => {
        status.innerHTML = `<span class="loading-row" style="padding:0;justify-content:flex-start"><span class="spinner"></span>Looking it up…</span>`;
        try {
          const food = await lookupBarcode(code);
          stopCamera();
          indexFoods([food]);
          openFoodDetail(food);
        } catch (err) {
          status.textContent = err.message || 'Could not look that up. Check your connection.';
        }
      };
      $('#bc-find', root).addEventListener('click', () => find($('#bc-input', root).value));
      $('#bc-input', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') find(e.target.value); });
      $('#bc-scan', root)?.addEventListener('click', async (e) => {
        e.currentTarget.hidden = true;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          const slot = $('#scanner-slot', root);
          slot.innerHTML = '<div class="scanner"><video playsinline muted></video></div>';
          const video = $('video', slot);
          video.srcObject = stream;
          await video.play();
          const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
          const scan = async () => {
            if (!stream) return;
            const codes = await detector.detect(video).catch(() => []);
            if (codes[0]?.rawValue) {
              navigator.vibrate?.(15);
              $('#bc-input', root).value = codes[0].rawValue;
              stopCamera();
              slot.innerHTML = '';
              return find(codes[0].rawValue);
            }
            raf = requestAnimationFrame(scan);
          };
          scan();
        } catch {
          status.textContent = 'Camera not available. Type the barcode instead.';
        }
      });
    },
  });
}

// ---------------------------------------------------------------- Dose

function openDose({ correctionOnly = false } = {}) {
  let recentInsulin = false;
  const carbs = correctionOnly ? 0 : mealCarbs();
  const count = correctionOnly ? 0 : state.meal.length;

  openSheet(`
    ${sheetHeader(correctionOnly ? 'BG correction' : 'His dose', correctionOnly ? 'No food. Correction for a high BG only.' : `${fmt(carbs)} g carbs from ${count} ${count === 1 ? 'food' : 'foods'}`)}
    <section class="section" style="margin-top:14px"><div class="group">
      <div class="bg-entry"><label for="bg-input">Current BG</label><input id="bg-input" inputmode="decimal" placeholder="–" autocomplete="off" aria-describedby="bg-error"><span class="unit">mmol/L</span></div>
      <div class="row cgm-note" id="cgm-note" hidden></div>
      <div class="row"><span class="row-main"><label for="recent-insulin" class="row-title">Insulin in the last 3 hours</label><span class="row-sub">Leaves out a correction for high BG</span></span><input type="checkbox" class="switch" id="recent-insulin"></div>
    </div><p class="field-error" id="bg-error" hidden></p></section>
    <div id="cgm-warn"></div>
    <div id="dose-out" aria-live="polite"></div>
    <div id="dose-record"></div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" data-action="close-sheet">Done</button>
      ${correctionOnly ? '' : '<button class="btn btn-plain" id="dose-new">Start a new meal</button>'}
    </div>`, {
    onMount(root) {
      const input = $('#bg-input', root);
      let lastRounded = null;

      const paint = () => {
        const bg = parseBg(input.value);
        const r = calculateDose({ carbs, bg, recentInsulin, settings: state.settings });
        const err = $('#bg-error', root);
        err.hidden = r.status !== 'invalid-bg';
        err.textContent = `Enter a reading between ${BG_MIN} and ${BG_MAX} mmol/L.`;
        $('#dose-out', root).innerHTML = doseHtml(r, { correctionOnly });
        // Keep "Did you give it?" right under the dose; moving the same element keeps what was typed.
        const slot = $('.record-slot', root);
        if (slot) slot.replaceWith(recordEl);
        else $('#dose-out', root).after(recordEl);
        if (r.status === 'ok' && r.rounded !== lastRounded) {
          if (lastRounded !== null) $('.dose-result', root)?.classList.add('dose-pop');
          lastRounded = r.rounded;
        }
        paintRecord(r, bg);
      };

      // "Record as given": the units actually given, which may differ from the calculation.
      let givenEdited = false;
      let latest = null;
      const recordEl = $('#dose-record', root);
      const paintRecord = (r, bg) => {
        latest = { r, bg };
        if (!logReady()) { recordEl.innerHTML = ''; return; }
        const isLow = r.status === 'hypo';
        if (r.status !== 'ok' && !isLow) { recordEl.innerHTML = ''; return; }
        if (isLow) {
          if (!$('#record-low', recordEl)) {
            recordEl.innerHTML = `<div class="sheet-actions"><button class="btn btn-secondary" id="record-low">Record ${LOW_TREATMENT_G} g low treatment</button></div>
              <p class="section-footer">15-15 rule: give ${LOW_TREATMENT_G} g of fast carbs, recheck in 15 minutes, and repeat if he’s still low. Record each one.</p>`;
          }
          return;
        }
        if (!$('#given', recordEl)) {
          recordEl.innerHTML = `
            <section class="section"><h2 class="section-header">Record dose</h2><div class="group">
              <div class="row field-row"><label for="given">Units given<span class="row-sub">Change it if you gave a different amount</span></label>
                <span class="stepper"><button type="button" data-given="-1" aria-label="Half a unit less">${ICON.minus}</button></span>
                <input id="given" inputmode="decimal" style="width:3.5rem;text-align:center">
                <span class="stepper"><button type="button" data-given="1" aria-label="Half a unit more">${ICON.plus}</button></span>
              </div>
            </div><p class="section-footer">Saves the foods, BG and units to his log for the whole family.</p></section>
            <div class="sheet-actions"><button class="btn btn-primary" id="record-dose">Record as given</button></div>`;
        }
        if (!givenEdited) $('#given', recordEl).value = r.rounded.toFixed(1);
      };

      const bgSourceNow = () => (cgmFilled !== null && input.value === cgmFilled && cgmReading ? cgmReading.source || 'dexcom' : 'typed');
      const record = async (type, insulinGiven) => {
        const { r, bg } = latest;
        const lines = correctionOnly ? [] : state.meal;
        const event = {
          id: newId(),
          type,
          at: new Date().toISOString(),
          carbs: type === 'low-treatment' ? LOW_TREATMENT_G : carbs,
          foods: lines.map((l) => ({ name: l.food.name, servings: l.servings, carbs: Math.round(lineCarbs(l.food, l.servings) * 10) / 10, source: l.food.source })),
          bg: bg != null && !Number.isNaN(bg) ? bg : null,
          bgSource: bg != null ? bgSourceNow() : null,
          insulinGiven,
          calculated: r.status === 'ok' ? { rounded: r.rounded, exact: Math.round(r.exact * 100) / 100, food: Math.round(r.foodDose * 100) / 100, correction: Math.round(r.correction * 100) / 100 } : null,
          recentInsulin,
          settings: { icr: state.settings?.icr, cf: state.settings?.cf, targetBg: state.settings?.targetBg },
          device: deviceId,
        };
        const previousMeal = state.meal;
        closeSheet();
        if (!correctionOnly) { state.meal = []; saveMeal(); renderTray(); refreshRows(); }
        await saveEvent(event);
        toast(type === 'low-treatment'
          ? `${LOW_TREATMENT_G} g saved. Recheck in 15 minutes; if still below ${fmt(state.settings?.hypoThreshold ?? 4)}, give another ${LOW_TREATMENT_G} g and record it again.`
          : `${fmt(insulinGiven)} U saved to his log`, {
          action: 'Undo',
          onAction: async () => {
            try { await removeEvent(event.id); } catch {}
            if (!correctionOnly) { state.meal = previousMeal; saveMeal(); renderTray(); refreshRows(); }
          },
        });
      };

      recordEl.addEventListener('input', (e) => { if (e.target.id === 'given') givenEdited = true; });
      recordEl.addEventListener('click', (e) => {
        const step = Number(e.target.closest('[data-given]')?.dataset.given);
        if (step) {
          const field = $('#given', recordEl);
          const v = num(field.value) ?? 0;
          field.value = Math.max(0, Math.round((v + step * 0.5) * 2) / 2).toFixed(1);
          givenEdited = true;
          return;
        }
        if (e.target.closest('#record-low')) { record('low-treatment', 0); return; }
        if (e.target.closest('#record-dose')) {
          const units = num($('#given', recordEl).value);
          if (units == null || units < 0 || units > 50) { toast('Enter the units you gave'); return; }
          if (latest.r.maxDose && units > latest.r.maxDose && !confirm(`${fmt(units)} U is more than the ${fmt(latest.r.maxDose)} U limit. Record it anyway?`)) return;
          record(correctionOnly ? 'correction' : 'dose', units);
        }
      });

      // Fill in BG from the sensor when the reading is fresh enough to trust.
      let cgmFilled = null;
      let cgmReading = null;
      const note = $('#cgm-note', root);
      const paintCgm = () => {
        const r = cgmReading;
        if (!r) return;
        note.hidden = false;
        const filled = cgmFilled !== null && input.value === cgmFilled;
        let text;
        if (r.low || r.high) text = `${sourceName(r)} shows ${readingValue(r)}. Use a finger-prick reading.`;
        else if (r.ageMinutes > FRESH_MINUTES) text = `Last ${sourceName(r)} reading was ${readingAge(r)} (${fmt(r.mmol)}). Too old to use. Check his ${sourceName(r)} app or do a finger-prick.`;
        else if (filled) text = `From ${sourceName(r)} ${r.arrow} ${r.trendText} · ${readingAge(r)}. Change it if a finger-prick says otherwise.`;
        else text = `${sourceName(r)} says ${fmt(r.mmol)} ${r.arrow} (${readingAge(r)}). You typed your own reading.`;
        note.innerHTML = `<span class="row-sub">${esc(text)}</span>`;
        $('#cgm-warn', root).innerHTML = r.fast && !r.low && !r.high && r.ageMinutes <= FRESH_MINUTES
          ? `<div class="banner banner-warn">${ICON.warn}<div><strong>BG is ${esc(r.trendText)} ${r.arrow}</strong>Double-check before giving insulin.</div></div>`
          : '';
      };
      if (cgmReady()) {
        note.hidden = false;
        note.innerHTML = '<span class="row-sub">Getting his glucose reading…</span>';
        getReading().then((r) => {
          if (!root.isConnected) return;
          cgmReading = r;
          if (usableForDose(r) && input.value.trim() === '') {
            input.value = fmt(r.mmol);
            cgmFilled = input.value;
            paint();
          }
          paintCgm();
        }).catch((err) => {
          if (root.isConnected) note.innerHTML = `<span class="row-sub">${esc(err.message)} Type the BG instead.</span>`;
        });
      }

      input.addEventListener('input', () => { paint(); paintCgm(); });
      $('#recent-insulin', root).addEventListener('change', (e) => { recentInsulin = e.target.checked; paint(); });
      $('#dose-new', root)?.addEventListener('click', () => { closeSheet(); clearMeal(); });
      paint();

      // Make sure the newest ratios are used, then repaint if anything changed.
      loadSettings().then((changed) => {
        if (changed && sheet.open && root.contains(input)) {
          paint();
          toast('Dose settings were just updated');
        }
        if (changed) { renderSettings(); renderSetupBanner(); }
      });
    },
  });
}

function doseHtml(r, { correctionOnly }) {
  const s = state.settings;
  if (r.status === 'not-configured') {
    return `<div class="banner banner-warn" style="margin-top:18px">${ICON.warn}<div><strong>No carb ratio yet</strong>The admin needs to set his carb ratio, correction factor and target BG in Settings before DiaBuddy can work out a dose.</div></div>`;
  }
  if (r.status === 'invalid-bg') {
    return `<div class="dose-result muted"><p class="dose-label">Check the BG reading</p><p class="dose-value">–</p></div>`;
  }
  if (correctionOnly && r.correctionNote === 'no-bg') {
    return `<div class="dose-result muted"><p class="dose-label">Enter his BG</p><p class="dose-value">–</p></div>`;
  }
  if (r.status === 'hypo') {
    return `<div class="banner banner-danger" style="margin-top:18px">${ICON.drop}<div><strong>BG ${fmt(r.bg)} is low. Treat the low first.</strong>Give fast-acting sugar and recheck in 15 minutes. Don’t give insulin now. Work out the dose again once BG is above ${fmt(r.hypoThreshold)}.</div></div>`;
  }

  let corrSub;
  if (r.correctionNote === 'no-bg') corrSub = 'No BG entered. Food dose only.';
  else if (r.correctionNote === 'skipped-recent') corrSub = 'BG is high, but insulin was given in the last 3 hours, so no correction is added.';
  else if (r.correctionNote === 'negative-off') corrSub = 'BG is below target. Reducing the dose is switched off in Settings.';
  else corrSub = `(${fmt(r.bg)} − ${fmt(s.targetBg)}) ÷ ${fmt(s.cf)}`;

  const lines = [
    correctionOnly ? '' : `<div class="row calc-line"><span class="row-main"><span class="row-title">Food</span><span class="row-sub">${fmt(r.carbs)} g ÷ ${fmt(s.icr)}</span></span><span class="row-value"><strong>${r.foodDose.toFixed(2)} U</strong></span></div>`,
    `<div class="row calc-line"><span class="row-main"><span class="row-title">Correction</span><span class="row-sub">${corrSub}</span></span><span class="row-value"><strong>${fmtSigned(r.correction)} U</strong></span></div>`,
  ].join('');

  const warn = r.overMax
    ? `<div class="banner banner-warn">${ICON.warn}<div><strong>More than the ${fmt(r.maxDose)} U limit</strong>Double-check the foods and the BG reading before giving this.</div></div>`
    : '';
  const flooredNote = r.foodDose + r.correction < 0 ? ' · below zero, so no insulin' : '';

  return `
    ${section(null, lines)}
    ${warn}
    <div class="dose-result">
      <p class="dose-label">Give</p>
      <p class="dose-value">${r.rounded.toFixed(1)}<small>${r.rounded === 1 ? 'unit' : 'units'}</small></p>
      <p class="dose-exact">Exact ${r.exact.toFixed(2)} U, rounded to the nearest ${r.step} U${flooredNote}</p>
    </div>
    <div class="record-slot"></div>
    <p class="meta-line">Carb ratio 1:${fmt(s.icr)} · Correction 1:${fmt(s.cf)} · Target ${fmt(s.targetBg)} mmol/L<br>Settings last changed ${fmtDate(s.updatedAt)}${state.settingsMeta?.from === 'cache' ? ' (offline copy)' : ''}</p>
    <p class="meta-line">DiaBuddy is a calculator. Always follow his diabetes team’s plan and use your judgement.</p>`;
}

// ---------------------------------------------------------------- Admin

const SETTING_FIELDS = [
  { key: 'icr', label: 'Carb ratio', unit: 'g per unit', min: 1, max: 150, required: true, hint: '1 unit covers this many grams' },
  { key: 'cf', label: 'Correction factor', unit: 'mmol/L', min: 0.5, max: 30, required: true, hint: '1 unit lowers BG by this much' },
  { key: 'targetBg', label: 'Target BG', unit: 'mmol/L', min: 3, max: 15, required: true },
  { key: 'hypoThreshold', label: 'Low below', unit: 'mmol/L', min: 2.5, max: 6, required: true, hint: 'No dose shown below this' },
  { key: 'maxDose', label: 'Max dose warning', unit: 'U', min: 0.5, max: 50, required: false, hint: 'Optional' },
];

async function openSettingsEditor() {
  await loadSettings(); // edit the newest copy
  const s = { ...state.settings };
  openSheet(`
    ${sheetHeader('Dose settings', 'Use the numbers from his diabetes team.')}
    <section class="section"><div class="group">
      ${SETTING_FIELDS.map((f) => `
        <div class="row field-row">
          <label for="set-${f.key}">${f.label}${f.hint ? `<span class="row-sub">${f.hint}</span>` : ''}</label>
          <input id="set-${f.key}" inputmode="decimal" value="${s[f.key] ?? ''}" placeholder="${f.required ? 'Required' : 'Off'}" style="width:4.5rem">
          <span class="unit">${f.unit}</span>
        </div>`).join('')}
      <div class="row field-row"><label for="set-roundTo">Round doses to</label>
        <select id="set-roundTo" style="width:auto">${[0.5, 1].map((v) => `<option value="${v}" ${Number(s.roundTo ?? 0.5) === v ? 'selected' : ''}>${v} U</option>`).join('')}</select></div>
      <div class="row"><span class="row-main"><label class="row-title" for="set-neg">Reduce dose when below target</label><span class="row-sub">Uses a negative correction</span></span>
        <input type="checkbox" class="switch" id="set-neg" ${s.negativeCorrection === false ? '' : 'checked'}></div>
    </div><p class="field-error" id="set-error" hidden></p></section>
    <div class="sheet-actions"><button class="btn btn-primary" id="set-save">Save for everyone</button></div>`, {
    onMount(root) {
      $('#set-save', root).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const next = { ...s };
        const errors = [];
        for (const f of SETTING_FIELDS) {
          const raw = $(`#set-${f.key}`, root).value;
          const v = num(raw);
          if (raw.trim() === '' && !f.required) { next[f.key] = null; continue; }
          if (v == null || v < f.min || v > f.max) errors.push(`${f.label} must be between ${f.min} and ${f.max}.`);
          else next[f.key] = v;
        }
        next.roundTo = Number($('#set-roundTo', root).value);
        next.negativeCorrection = $('#set-neg', root).checked;
        const err = $('#set-error', root);
        if (errors.length) { err.hidden = false; err.textContent = errors.join(' '); return; }
        err.hidden = true;

        const changes = ['icr', 'cf', 'targetBg', 'hypoThreshold', 'maxDose', 'roundTo', 'negativeCorrection']
          .filter((k) => s[k] !== next[k])
          .map((k) => `${k} ${s[k] ?? '–'} → ${next[k] ?? '–'}`);
        if (!changes.length) { closeSheet(); return; }
        next.updatedAt = new Date().toISOString();

        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          const { settings: saved } = await relayFetch(RELAY_URL, '/settings', { method: 'PUT', body: next });
          state.settings = saved;
          state.settingsMeta = { from: 'relay', fetchedAt: Date.now() };
          store.set('settings', { data: saved, fetchedAt: Date.now() });
          closeSheet();
          renderSettings();
          renderSetupBanner();
          toast('Saved for everyone');
        } catch (ex) {
          err.hidden = false;
          err.textContent = ex.message;
          btn.disabled = false;
          btn.textContent = 'Save for everyone';
        }
      });
    },
  });
}

function openFamilyFoodForm(prefill = null) {
  const p = prefill || {};
  openSheet(`
    ${sheetHeader(prefill ? 'Save to family foods' : 'Add a family food', 'Everyone will see it in their food list.')}
    <section class="section"><div class="group">
      <div class="row field-row"><label for="ff-name">Name</label><input id="ff-name" class="wide" value="${esc(p.name || '')}" placeholder="e.g. Granny’s pap" autocomplete="off"></div>
      <div class="row field-row"><label for="ff-cat">Category</label><select id="ff-cat" class="wide">${CATEGORIES.map((c) => `<option ${c === p.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="row field-row"><label for="ff-serving">Serving</label><input id="ff-serving" class="wide" value="${esc(p.serving?.label || '')}" placeholder="e.g. 1 cup, 2 slices" autocomplete="off"></div>
      <div class="row field-row"><label for="ff-grams">Serving weight<span class="row-sub">Optional, lets you enter grams</span></label><input id="ff-grams" inputmode="decimal" value="${p.serving?.grams ?? ''}" placeholder="–" style="width:4.5rem"><span class="unit">g</span></div>
      <div class="row field-row"><label for="ff-carbs">Carbs per serving</label><input id="ff-carbs" inputmode="decimal" value="${p.netCarbs ?? ''}" placeholder="0" style="width:4.5rem"><span class="unit">g</span></div>
      <div class="row field-row"><label for="ff-note">Note</label><input id="ff-note" class="wide" value="${esc(p.note || '')}" placeholder="Optional" autocomplete="off"></div>
    </div><p class="field-error" id="ff-error" hidden></p></section>
    <div class="sheet-actions"><button class="btn btn-primary" id="ff-save">Save for everyone</button></div>`, {
    onMount(root) {
      $('#ff-save', root).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const name = $('#ff-name', root).value.trim();
        const label = $('#ff-serving', root).value.trim();
        const grams = num($('#ff-grams', root).value);
        const carbs = num($('#ff-carbs', root).value);
        const err = $('#ff-error', root);
        const problem = !name ? 'Give it a name.' : !label ? 'Describe the serving.' : carbs == null || carbs < 0 || carbs > 300 ? 'Enter the carbs per serving.' : grams != null && grams <= 0 ? 'Serving weight must be more than 0.' : '';
        if (problem) { err.hidden = false; err.textContent = problem; return; }

        const food = {
          id: `fam-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36)}`,
          name,
          category: $('#ff-cat', root).value,
          serving: { label, grams: grams || null },
          netCarbs: Math.round(carbs * 10) / 10,
          ...(grams ? { per100g: Math.round((carbs / grams) * 1000) / 10 } : {}),
          ...($('#ff-note', root).value.trim() && { note: $('#ff-note', root).value.trim() }),
          ...(p.barcode && { barcode: p.barcode }),
          addedAt: new Date().toISOString(),
        };
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          await saveFamilyFood(food);
          closeSheet();
          refreshRows();
          toast(`Saved ${name}`);
        } catch (ex) {
          err.hidden = false;
          err.textContent = ex.message;
          btn.disabled = false;
          btn.textContent = 'Save for everyone';
        }
      });
    },
  });
}

// The relay when it's set up (any family phone), otherwise the admin's GitHub file.
async function saveFamilyFood(food) {
  const { food: saved } = await relayFetch(RELAY_URL, '/foods', { method: 'POST', body: { ...food, addedBy: state.me?.name || deviceId } });
  state.relayFoods = [...state.relayFoods.filter((f) => f.id !== saved.id), { ...saved, source: 'custom', relay: true }];
  store.set('relay-foods', state.relayFoods);
  setCustomFoods();
}

async function removeFamilyFood(food, btn) {
  btn.disabled = true;
  try {
    await relayFetch(RELAY_URL, `/foods/${encodeURIComponent(food.id)}`, { method: 'DELETE' });
    state.relayFoods = state.relayFoods.filter((f) => f.id !== food.id);
    store.set('relay-foods', state.relayFoods);
    setCustomFoods();
    closeSheet();
    refreshRows();
    toast(`Removed ${food.name}`);
  } catch (ex) {
    btn.disabled = false;
    toast(ex.message);
  }
}

// ---------------------------------------------------------------- Phones & joining

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Join with a single-use invite. On iPhone, a home-screen app has its own storage,
// so if the link opened in Safari we offer to keep the invite for the home-screen app.
function openJoin(code = null) {
  const suggested = isIos() ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'This device';
  const safariFirst = code && isIos() && !isStandalone();
  openSheet(`
    ${sheetHeader('Connect this phone', 'Uses the invite link the admin sent you.')}
    ${safariFirst ? `<div class="banner banner-info">${ICON.info}<div><strong>Using DiaBuddy from your Home Screen?</strong>Copy the invite, add DiaBuddy to your Home Screen (Share → Add to Home Screen), open it from there and paste the invite. An invite works once.</div></div>` : ''}
    <section class="section"><div class="group">
      ${code ? '' : '<div class="row field-row"><label for="join-code">Invite</label><input id="join-code" class="wide" placeholder="Paste the invite link" autocomplete="off" spellcheck="false"></div>'}
      <div class="row field-row"><label for="join-name">Name this phone</label><input id="join-name" class="wide" value="${esc(suggested)}" autocomplete="off"></div>
    </div><p class="section-footer" id="join-status">The admin sees this name and can remove the phone later.</p></section>
    <div class="sheet-actions">
      ${safariFirst ? '<button class="btn btn-primary" id="join-copy">Copy invite</button>' : ''}
      <button class="btn ${safariFirst ? 'btn-secondary' : 'btn-primary'}" id="join-go">${safariFirst ? 'Use it here in Safari instead' : 'Connect'}</button>
    </div>`, {
    onMount(root) {
      const status = $('#join-status', root);
      $('#join-copy', root)?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(inviteLink(code)); status.textContent = 'Copied. Now open DiaBuddy from your Home Screen and paste it.'; } catch { status.textContent = inviteLink(code); }
      });
      $('#join-go', root).addEventListener('click', async (e) => {
        const c = code || joinCodeFrom($('#join-code', root).value);
        if (!c) { status.textContent = 'Paste the whole invite link.'; return; }
        const btn = e.currentTarget;
        btn.disabled = true;
        status.textContent = 'Connecting…';
        try {
          const res = await fetch(`${RELAY_URL}/enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: c, deviceName: $('#join-name', root).value.trim() }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error === 'bad_invite' ? 'That invite has expired or was already used. Ask the admin for a new one.' : data.error === 'rate_limited' ? 'Too many tries. Wait a minute.' : 'Couldn’t connect. Check your signal and try again.');
          setCgmKey(data.token);
          state.me = data.device;
          store.set('me', data.device);
          closeSheet();
          await loadSettings();
          renderSetupBanner(); renderSettings(); renderCgmCard(); renderHome();
          refreshCgm(); loadTodayLog(); loadRelayFoods();
          toast(data.device.role === 'admin' ? 'Connected as admin' : 'This phone is connected');
        } catch (err) {
          status.textContent = err.message;
          btn.disabled = false;
        }
      });
    },
  });
}

async function removeThisPhone() {
  if (!confirm('Disconnect this phone? It will need a new invite to see his readings again.')) return;
  try { if (state.me?.id && !state.me.legacy) await relayFetch(RELAY_URL, `/devices/${encodeURIComponent(state.me.id)}`, { method: 'DELETE' }); } catch {}
  forgetThisPhone();
  renderSetupBanner(); renderSettings(); renderCgmCard(); renderHome(); refreshRows();
  toast('This phone is disconnected');
}

const ROLE_LABEL = { admin: 'Admin', family: 'Family', tv: 'View only (TV)' };

async function openPhones() {
  openSheet(`${sheetHeader('Phones', 'Everyone who can see his readings.')}${loadingRow('Loading…')}`);
  let data;
  try {
    data = await relayFetch(RELAY_URL, '/devices');
  } catch (err) {
    if (sheet.open) openSheet(`${sheetHeader('Phones')}<div class="banner banner-warn">${ICON.warn}<div>${esc(err.message)}</div></div>`);
    return;
  }
  if (!sheet.open) return;
  const rows = data.devices.map((d) => `
    <div class="row">
      <span class="row-main"><span class="row-title">${esc(d.name)}${d.current ? ' (this phone)' : ''}</span>
        <span class="row-sub">${esc(ROLE_LABEL[d.role] || d.role)} · added ${esc(fmtDate(d.createdAt))}${d.lastSeenDay ? ` · last used ${esc(fmtDate(d.lastSeenDay))}` : ''}</span></span>
      ${d.current ? '' : `<button class="btn btn-danger btn-compact" data-remove-device="${esc(d.id)}" data-name="${esc(d.name)}">Remove</button>`}
    </div>`).join('');
  openSheet(`
    ${sheetHeader('Phones', 'Everyone who can see his readings.')}
    ${data.legacyActive ? `<div class="banner banner-warn">${ICON.warn}<div><strong>The old shared link still works</strong>Anyone with the old family link can still connect. Once every phone below has joined with an invite, turn it off.</div></div>` : ''}
    ${section(null, rows || '<div class="row"><span class="row-main"><span class="row-sub">No phones yet.</span></span></div>')}
    <div class="sheet-actions">
      <button class="btn btn-primary" id="ph-invite">Invite a phone</button>
      ${data.legacyActive ? '<button class="btn btn-danger" id="ph-legacy">Turn off the old shared link</button>' : ''}
    </div>`, {
    onMount(root) {
      root.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-remove-device]');
        if (!btn) return;
        if (!confirm(`Remove ${btn.dataset.name}? It will stop seeing his readings straight away.`)) return;
        btn.disabled = true;
        try {
          await relayFetch(RELAY_URL, `/devices/${encodeURIComponent(btn.dataset.removeDevice)}`, { method: 'DELETE' });
          toast(`${btn.dataset.name} removed`);
          openPhones();
        } catch (err) { btn.disabled = false; toast(err.message); }
      });
      $('#ph-invite', root).addEventListener('click', openInvite);
      $('#ph-legacy', root)?.addEventListener('click', async (e) => {
        if (!confirm('Turn off the old shared link? Phones that haven’t joined with an invite will stop working.')) return;
        e.currentTarget.disabled = true;
        try { await relayFetch(RELAY_URL, '/legacy-off', { method: 'POST' }); toast('Old shared link turned off'); openPhones(); } catch (err) { toast(err.message); }
      });
    },
  });
}

function openInvite() {
  openSheet(`
    ${sheetHeader('Invite a phone', 'The link works once and expires in 24 hours.')}
    <section class="section"><div class="group">
      <div class="row field-row"><label for="inv-name">Who is it for?</label><input id="inv-name" class="wide" placeholder="e.g. Gran" autocomplete="off"></div>
      <div class="row field-row"><label for="inv-role">Access</label><select id="inv-role" class="wide">
        <option value="family" selected>Family: readings, log, foods</option>
        <option value="tv">View only (TV)</option>
        <option value="admin">Admin: also settings and phones</option>
      </select></div>
    </div><p class="section-footer" id="inv-status">Send it privately, e.g. in a direct message, not a group chat.</p></section>
    <div class="sheet-actions"><button class="btn btn-primary" id="inv-go">Create invite link</button></div>`, {
    onMount(root) {
      $('#inv-go', root).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const name = $('#inv-name', root).value.trim();
        if (!name) { $('#inv-status', root).textContent = 'Say who it’s for, so you can recognise the phone later.'; return; }
        btn.disabled = true;
        try {
          const { code, expiresAt } = await relayFetch(RELAY_URL, '/invites', { method: 'POST', body: { role: $('#inv-role', root).value, name } });
          const link = inviteLink(code);
          openSheet(`
            ${sheetHeader(`Invite for ${esc(name)}`, `Works once, until ${esc(new Date(expiresAt).toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}.`)}
            ${section(null, `<div class="row"><span class="row-main"><span class="row-title" style="user-select:all;-webkit-user-select:all;overflow-wrap:anywhere">${esc(link)}</span></span></div>`, 'Anyone who opens this link first gets the access you chose, so send it only to that person.')}
            <div class="sheet-actions">
              <button class="btn btn-primary" id="inv-share">Share</button>
              <button class="btn btn-secondary" data-action="phones">Back to phones</button>
            </div>`, {
            onMount(r2) {
              $('#inv-share', r2).addEventListener('click', async () => {
                try {
                  if (navigator.share) { await navigator.share({ title: 'DiaBuddy invite', text: `DiaBuddy invite for ${name}. Open it once on your phone:`, url: link }); return; }
                } catch (err) { if (err.name === 'AbortError') return; }
                try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch { toast('Copy the link above'); }
              });
            },
          });
        } catch (err) {
          btn.disabled = false;
          $('#inv-status', root).textContent = err.message;
        }
      });
    },
  });
}

async function openSettingsHistory() {
  openSheet(`${sheetHeader('Settings history')}${loadingRow('Loading…')}`);
  try {
    const { history } = await relayFetch(RELAY_URL, '/settings?history=1');
    if (!sheet.open) return;
    const label = { icr: 'Carb ratio', cf: 'Correction factor', targetBg: 'Target BG', hypoThreshold: 'Low below', maxDose: 'Max dose', roundTo: 'Rounding', negativeCorrection: 'Reduce below target' };
    const rows = history.map((h) => `
      <div class="row"><span class="row-main"><span class="row-title">${esc(fmtDate(h.at))} · ${esc(h.by)}</span>
        <span class="row-sub">${h.changes.map((c) => `${esc(label[c.field] || c.field)}: ${esc(String(c.from ?? '–'))} → ${esc(String(c.to ?? '–'))}`).join(' · ')}</span></span></div>`).join('');
    openSheet(`${sheetHeader('Settings history', 'Every change to his numbers, newest first.')}${section(null, rows || '<div class="row"><span class="row-main"><span class="row-sub">No changes recorded yet.</span></span></div>')}`);
  } catch (err) {
    if (sheet.open) openSheet(`${sheetHeader('Settings history')}<div class="banner banner-warn">${ICON.warn}<div>${esc(err.message)}</div></div>`);
  }
}

function openDeleteData() {
  openSheet(`
    ${sheetHeader('Delete his stored data', 'This can’t be undone.')}
    <section class="section"><div class="group">
      <div class="row field-row"><label for="del-what">Delete</label><select id="del-what" class="wide">
        <option value="glucose">Glucose readings</option>
        <option value="events">Meal and dose log</option>
        <option value="all">Readings, log and settings history</option>
      </select></div>
      <div class="row field-row"><label for="del-confirm">Type DELETE</label><input id="del-confirm" class="wide" autocomplete="off" spellcheck="false"></div>
    </div><p class="section-footer" id="del-status">His dose settings, phones and family foods are kept.</p></section>
    <div class="sheet-actions"><button class="btn btn-danger" id="del-go">Delete</button></div>`, {
    onMount(root) {
      $('#del-go', root).addEventListener('click', async (e) => {
        const status = $('#del-status', root);
        if ($('#del-confirm', root).value.trim() !== 'DELETE') { status.textContent = 'Type DELETE to confirm.'; return; }
        e.currentTarget.disabled = true;
        try {
          const { deleted, remaining } = await relayFetch(RELAY_URL, '/erase', { method: 'POST', body: { what: $('#del-what', root).value } });
          status.textContent = remaining ? `Deleted ${deleted}. ${remaining} left; run it again tomorrow (daily limit).` : `Deleted ${deleted} records.`;
          state.todayLog = [];
          renderHome();
        } catch (err) {
          status.textContent = err.message;
          e.currentTarget.disabled = false;
        }
      });
    },
  });
}

// ---------------------------------------------------------------- Tabs & events

function switchTab(tab) {
  if (tab === state.tab) {
    scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    return;
  }
  state.scroll[state.tab] = scrollY;
  state.tab = tab;
  for (const s of $$('.screen')) s.hidden = s.dataset.screen !== tab;
  for (const t of $$('.tab')) {
    if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  }
  if (tab === 'settings') renderSettings();
  if (tab === 'foods') renderFoods();
  if (tab === 'home') renderHome();
  if (tab === 'insights') { renderInsights(); loadInsights(); }
  if (tray.expanded) setTrayExpanded(false);
  renderTray();
  scrollTo(0, state.scroll[tab] || 0);
}

const actions = {
  'close-sheet': () => closeSheet(),
  'start-meal': () => switchTab('foods'),
  manual: openManual,
  barcode: openBarcode,
  calculate: () => openDose(),
  correction: () => openDose({ correctionOnly: true }),
  'clear-meal': () => { setTrayExpanded(false); clearMeal(); },
  'edit-settings': openSettingsEditor,
  'settings-history': openSettingsHistory,
  phones: openPhones,
  'delete-data': openDeleteData,
  'remove-this-phone': removeThisPhone,
  join: () => openJoin(),
  'add-family-food': () => openFamilyFoodForm(),
  'photo-label': openPhotoLabel,
  'cgm-refresh': refreshCgm,
  'test-alert': testAlert,
};

function initEvents() {
  // Lets :active press states fire immediately on iOS.
  document.addEventListener('touchstart', () => {}, { passive: true });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab], [data-add], [data-detail], [data-action], [data-line], [data-step], [data-cat], [data-event]');
    if (!t) return;
    const d = t.dataset;
    if (d.tab) switchTab(d.tab);
    else if (d.add) addToMeal(foodIndex.get(d.add));
    else if (d.detail) { const f = foodIndex.get(d.detail); if (f) openFoodDetail(f); }
    else if (d.action) actions[d.action]?.();
    else if (d.line) openLineEditor(d.line);
    else if (d.event) openEvent(d.event);
    else if (d.step) {
      const line = state.meal.find((l) => l.food.id === d.id);
      if (line) setServings(d.id, line.servings + Number(d.step) * 0.5);
    } else if (d.cat) {
      state.category = d.cat === 'All' ? null : d.cat;
      renderFoods();
      t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });

  $('#foods-search').addEventListener('input', (e) => { state.foodsQuery = e.target.value; renderFoods(); });
  document.addEventListener('change', (e) => { if (e.target.id === 'alerts-high') toggleAlerts(e.target); });
  initInsights();

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (updateReady && !sheet.open) { location.reload(); return; }
    navigator.serviceWorker?.getRegistration().then((reg) => reg?.update()).catch(() => {});
    renderGreeting();
    await loadMe();
    if (await loadSettings()) { renderSettings(); renderSetupBanner(); }
    refreshCgm();
    loadTodayLog();
    loadRelayFoods();
  });
}

// ---------------------------------------------------------------- boot

// Home Screen apps are rarely fully closed, so a new version could wait for days.
// When one takes over, load it the next time DiaBuddy comes to the front (or now, from the toast).
let updateReady = false;
function watchForUpdates() {
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || updateReady) return; // first install: this page is already current
    updateReady = true;
    toast('DiaBuddy has been updated', { action: 'Reload', onAction: () => location.reload() });
  });
}

async function boot() {
  const joinCode = consumeJoinCode();
  renderGreeting();
  restoreMeal();
  initEvents();
  initTray();
  initSheet();
  renderTray();
  renderHome();
  await loadMe();
  await Promise.all([loadSettings(), loadAllFoods()]);
  renderSetupBanner();
  renderHome();
  renderFoods();
  renderSettings();
  renderCgmCard();
  refreshCgm();
  loadTodayLog();
  loadRelayFoods();
  addEventListener('online', () => loadTodayLog());
  if (joinCode) openJoin(joinCode);
  // The invite link opened in a tab where DiaBuddy is already running.
  addEventListener('hashchange', () => {
    const code = consumeJoinCode();
    if (code) openJoin(code);
  });
  // Libre updates every minute and Dexcom every 5; check every 2.5 minutes.
  setInterval(() => { if (document.visibilityState === 'visible') refreshCgm(); }, 150000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    watchForUpdates();
  }
}

boot();
