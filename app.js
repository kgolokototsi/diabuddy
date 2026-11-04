import { calculateDose, parseBg, lineCarbs, isConfigured, BG_MIN, BG_MAX } from './dose.js';
import { loadFoods, searchFoods, loadPackaged, lookupBarcode, CATEGORIES, SOURCE_LABEL } from './foods.js';
import { readShared, writeShared, isAdmin, unlock, lock } from './admin.js';
import { spring, project, rubberband, VelocityTracker } from './spring.js';
import { REPO, APP_VERSION } from './config.js';
import { getCgmKey, setCgmKey, consumeLinkKey, generateKey, familyLink, fetchLatest, relayFetch, usableForDose, FRESH_MINUTES } from './cgm.js';

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
  try {
    const { data, from } = await readShared('settings.json');
    state.settings = data;
    state.settingsMeta = { from, fetchedAt: Date.now() };
    store.set('settings', { data, fetchedAt: Date.now() });
  } catch {
    const cached = store.get('settings');
    if (cached) {
      state.settings = cached.data;
      state.settingsMeta = { from: 'cache', fetchedAt: cached.fetchedAt };
    }
  }
  return JSON.stringify(state.settings) !== before;
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
    const { foods } = await relayFetch(cgmUrl(), '/foods');
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

const cgmUrl = () => state.settings?.cgmUrl || '';
const cgmReady = () => Boolean(cgmUrl() && getCgmKey());
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
    .catch((err) => { state.cgm = { ...state.cgm, error: err.message, loading: false }; throw err; })
    .finally(() => { cgmPending = null; renderCgmCard(); if (state.tab === 'settings') renderSettings(); });
  return cgmPending;
}

const readingAge = (r) => r.ageMinutes === 0 ? 'just now' : r.ageMinutes === 1 ? '1 min ago' : `${r.ageMinutes} min ago`;
const sourceName = (r) => (r.source === 'libre' ? 'Libre' : 'Dexcom');
const readingValue = (r) => r.low ? 'LOW' : r.high ? 'HIGH' : fmt(r.mmol);

function renderCgmCard() {
  const el = $('#cgm-card');
  if (!el) return;
  if (!cgmUrl()) { el.innerHTML = ''; return; }
  if (!getCgmKey()) {
    el.innerHTML = section(null, `<button class="row" data-action="cgm-key"><span class="row-main"><span class="row-title row-link">Show his glucose readings here</span><span class="row-sub">Open the family link from the admin, or enter the family key.</span></span>${ICON.chevron}</button>`);
    return;
  }
  const r = state.cgm.reading;
  if (!r) {
    el.innerHTML = section(null, state.cgm.error
      ? `<button class="row" data-action="cgm-refresh"><span class="row-main"><span class="row-title">Glucose reading</span><span class="row-sub">${esc(state.cgm.error)} Tap to try again.</span></span></button>`
      : loadingRow('Getting his glucose reading…'));
    return;
  }
  const stale = r.ageMinutes > FRESH_MINUTES;
  const lowThreshold = state.settings?.hypoThreshold ?? 4;
  const tone = r.low || r.mmol < lowThreshold ? 'cgm-low' : stale ? 'cgm-stale' : '';
  // A fresh low reading gets a plain warning, not just a red number.
  const lowBanner = !stale && (r.low || r.mmol < lowThreshold)
    ? `<div class="banner banner-danger" role="alert">${ICON.drop}<div><strong>${sourceName(r)} shows ${readingValue(r)}. That’s low.</strong>Check with a finger-prick and treat the low first. Don’t give insulin now.</div></div>`
    : '';
  el.innerHTML = lowBanner + section(null, `<button class="row cgm-row ${tone}" data-action="cgm-refresh" aria-label="${sourceName(r)} ${readingValue(r)} mmol/L, ${esc(r.trendText)}, ${readingAge(r)}. Tap to refresh.">
    <span class="cgm-value">${readingValue(r)}<span class="cgm-arrow" aria-hidden="true">${r.arrow}</span></span>
    <span class="row-main"><span class="row-title">mmol/L · ${esc(r.trendText)}</span>
      <span class="row-sub">${sourceName(r)} · ${readingAge(r)}${stale ? ' · too old to use for a dose' : ''}${state.cgm.error ? ' · couldn’t update' : ''}</span></span>
  </button>
  ${trendChart(r)}`);
}

const clockTime = (iso) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false });

// Small last-hour chart of the real readings only: no smoothing, no made-up points.
function trendChart(r, now = Date.now()) {
  const points = (r.history || [])
    .map((p) => ({ mmol: p.mmol, t: Date.parse(p.time), time: p.time }))
    .filter((p) => now - p.t <= 60 * 60000)
    .sort((a, b) => a.t - b.t);
  if (!points.length) return '';

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

  const cur = points.at(-1);
  const signed = (d) => `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d))}`;
  // Prefer a real reading 8–15 minutes back (closest to 10); otherwise compare with the previous one.
  const tenAgo = points
    .filter((p) => cur.t - p.t >= 8 * 60000 && cur.t - p.t <= 15 * 60000)
    .sort((a, b) => Math.abs(cur.t - a.t - 10 * 60000) - Math.abs(cur.t - b.t - 10 * 60000))[0];
  const prev = points.length > 1 ? points.at(-2) : null;
  const change = tenAgo ? `${signed(cur.mmol - tenAgo.mmol)} in ${Math.round((cur.t - tenAgo.t) / 60000)} min`
    : prev ? `${signed(cur.mmol - prev.mmol)} since ${clockTime(prev.time)}`
    : 'One reading in the last hour';
  const label = `Last hour: ${points.map((p) => `${fmt(p.mmol)} at ${clockTime(p.time)}`).join(', ')}. Shaded band is ${low} to 10 mmol/L.`;

  return `<div class="trend" role="group" aria-label="Last hour of readings">
    <svg class="trend-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
      <rect class="trend-band" x="0" y="${y(10).toFixed(1)}" width="${W}" height="${(y(low) - y(10)).toFixed(1)}" rx="6" />
      <line class="trend-low" x1="0" x2="${W}" y1="${y(low).toFixed(1)}" y2="${y(low).toFixed(1)}" />
      ${lines}${dots}
    </svg>
    <div class="trend-caption"><span>1 h ago</span><strong>${esc(change)}</strong><span>now</span></div>
    <p class="trend-key">Shaded: ${low}–10 mmol/L · dashed line: low (${low})</p>
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
  $('#foods-sub').textContent = `Tap what he’s eating for ${mealOfDay(now)}`;
}

function renderSetupBanner() {
  const el = $('#setup-banner');
  if (!state.settings) {
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
  else await relayFetch(cgmUrl(), `/events/${id}`, { method: 'DELETE' });
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

function cgmRows() {
  const rows = [];
  const r = state.cgm.reading;
  const status = !cgmUrl() ? 'Not set up'
    : !getCgmKey() ? 'Needs the family key'
    : state.cgm.error && !r ? 'Not working'
    : r ? `${readingValue(r)} ${r.arrow} · ${readingAge(r)}` : 'Connecting…';
  rows.push(settingRow('Status', status));
  if (state.cgm.error && getCgmKey()) rows.push(`<div class="row"><span class="row-main"><span class="row-sub">${esc(state.cgm.error)}</span></span></div>`);
  if (isAdmin()) rows.push(`<button class="row" data-action="cgm-setup"><span class="row-main"><span class="row-title row-link">${cgmUrl() ? 'Change glucose readings set-up' : 'Set up glucose readings'}</span></span>${ICON.chevron}</button>`);
  if (isAdmin() && cgmReady()) rows.push(`<button class="row" data-action="cgm-share"><span class="row-main"><span class="row-title row-link">Share the family link</span><span class="row-sub">Send it to family phones so they see his readings</span></span></button>`);
  if (!isAdmin() && cgmUrl() && !getCgmKey()) rows.push(`<button class="row" data-action="cgm-key"><span class="row-main"><span class="row-title row-link">Enter the family key</span></span>${ICON.chevron}</button>`);
  if (getCgmKey()) rows.push(`<button class="row" data-action="cgm-forget"><span class="row-main"><span class="row-title row-danger">Stop showing readings on this phone</span></span></button>`);
  return rows.join('');
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
  ].join('') : settingRow('Settings', 'Not loaded');

  const adminRows = isAdmin()
    ? `<button class="row" data-action="edit-settings"><span class="row-main"><span class="row-title row-link">Change dose settings</span></span>${ICON.chevron}</button>
       <button class="row" data-action="add-family-food"><span class="row-main"><span class="row-title row-link">Add a family food</span></span>${ICON.chevron}</button>
       <button class="row" data-action="lock"><span class="row-main"><span class="row-title row-danger">Lock admin on this device</span></span></button>`
    : `<button class="row" data-action="unlock"><span class="row-main"><span class="row-title row-link">Unlock admin</span><span class="row-sub">Only the parent who manages his settings needs this.</span></span>${ICON.chevron}</button>`;

  const history = `https://github.com/${REPO.owner}/${REPO.repo}/commits/${REPO.branch}/settings.json`;
  el.innerHTML = `
    ${s && !isConfigured(s) ? `<div class="banner banner-warn">${ICON.warn}<div><strong>Not set up yet</strong>${isAdmin() ? 'Tap “Change dose settings” and enter the numbers from his diabetes team.' : 'Ask the admin to set his carb ratio, correction factor and target.'}</div></div>` : ''}
    ${section('His numbers', doseRows, `${esc(loadedFrom)} Last changed ${fmtDate(s?.updatedAt)}. Only the admin can change these.`)}
    ${section('Glucose readings', cgmRows(), cgmUrl() ? 'Readings come from his Libre or Dexcom (whichever is newest) through the family relay. Each phone needs the family link once.' : '')}
    ${section('Admin', adminRows, isAdmin() ? 'Saving updates every family phone the next time DiaBuddy opens.' : '')}
    ${section('How the dose is worked out', `
      <div class="row"><span class="row-main"><span class="row-title">Food dose</span><span class="row-sub">Carbs ÷ carb ratio</span></span></div>
      <div class="row"><span class="row-main"><span class="row-title">Correction</span><span class="row-sub">(Current BG − target BG) ÷ correction factor</span></span></div>
      <div class="row"><span class="row-main"><span class="row-title">Total</span><span class="row-sub">Food dose + correction, rounded to the nearest ${s?.roundTo ?? 0.5} U</span></span></div>`,
      'If insulin was given in the last 3 hours, a correction for high BG is left out so doses don’t stack.')}
    ${section('About', `
      <a class="row" href="${history}" target="_blank" rel="noopener"><span class="row-main"><span class="row-title row-link">Settings change history</span></span>${ICON.chevron}</a>
      <div class="row"><span class="row-main"><span class="row-title">Food data</span><span class="row-sub">Family notebook · USDA FoodData Central · Open Food Facts (ODbL)</span></span></div>
      <div class="row"><span class="row-main"><span class="row-title">Version</span></span><span class="row-value">${APP_VERSION}</span></div>`,
      'DiaBuddy is a calculator, not medical advice. Always follow the plan from his diabetes team, and use your own judgement.')}
  `;
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
      ${food.source === 'custom' && (food.relay ? cgmReady() : isAdmin()) ? '<button class="btn btn-danger" id="detail-remove">Remove from family foods</button>' : ''}
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
        const lowWithFood = r.status === 'hypo' && carbs > 0;
        if (r.status !== 'ok' && !lowWithFood) { recordEl.innerHTML = ''; return; }
        if (lowWithFood) {
          if (!$('#record-low', recordEl)) {
            recordEl.innerHTML = `<div class="sheet-actions"><button class="btn btn-secondary" id="record-low">Record low treatment</button></div>`;
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
          carbs,
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
        toast(type === 'low-treatment' ? 'Low treatment saved to his log' : `${fmt(insulinGiven)} U saved to his log`, {
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

function openUnlock() {
  const tokenUrl = 'https://github.com/settings/personal-access-tokens/new';
  openSheet(`
    ${sheetHeader('Unlock admin', 'Lets this device change the shared settings.')}
    ${section('Make a key (once)', `
      <div class="row"><span class="row-main"><span class="row-title">1. Open GitHub’s token page</span><span class="row-sub"><a href="${tokenUrl}" target="_blank" rel="noopener">${tokenUrl.replace('https://', '')}</a></span></span></div>
      <div class="row"><span class="row-main"><span class="row-title">2. Repository access</span><span class="row-sub">Only select repositories → ${esc(REPO.repo)}</span></span></div>
      <div class="row"><span class="row-main"><span class="row-title">3. Permissions</span><span class="row-sub">Contents → Read and write</span></span></div>
      <div class="row"><span class="row-main"><span class="row-title">4. Generate, copy and paste below</span></span></div>`)}
    <section class="section"><div class="group">
      <div class="row field-row"><label for="tok">Token</label><input id="tok" class="wide" type="password" placeholder="github_pat_…" autocomplete="off" spellcheck="false"></div>
    </div><p class="section-footer" id="tok-status">The token stays on this device and is only sent to GitHub.</p></section>
    <div class="sheet-actions"><button class="btn btn-primary" id="tok-go">Unlock</button></div>`, {
    onMount(root) {
      const go = async () => {
        const btn = $('#tok-go', root);
        btn.disabled = true;
        $('#tok-status', root).textContent = 'Checking with GitHub…';
        try {
          await unlock($('#tok', root).value);
          closeSheet();
          renderSettings();
          renderFoods();
          toast('Admin unlocked on this device');
        } catch (err) {
          $('#tok-status', root).textContent = err.message || 'Could not reach GitHub.';
          btn.disabled = false;
        }
      };
      $('#tok-go', root).addEventListener('click', go);
      $('#tok', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    },
  });
}

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
          await writeShared('settings.json', next, `Update dose settings: ${changes.join(', ')}`);
          state.settings = next;
          state.settingsMeta = { from: 'github', fetchedAt: Date.now() };
          store.set('settings', { data: next, fetchedAt: Date.now() });
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
  if (cgmReady()) {
    const { food: saved } = await relayFetch(cgmUrl(), '/foods', { method: 'POST', body: { ...food, addedBy: deviceId } });
    state.relayFoods = [...state.relayFoods.filter((f) => f.id !== saved.id), { ...saved, source: 'custom', relay: true }];
    store.set('relay-foods', state.relayFoods);
  } else {
    const { data } = await readShared('data/foods-custom.json');
    const foods = [...(data.foods || []), food];
    await writeShared('data/foods-custom.json', { foods }, `Add family food: ${food.name}`);
    state.githubFoods = foods.map((f) => ({ ...f, source: 'custom' }));
  }
  setCustomFoods();
}

async function removeFamilyFood(food, btn) {
  btn.disabled = true;
  try {
    if (food.relay) {
      await relayFetch(cgmUrl(), `/foods/${food.id}`, { method: 'DELETE' });
      state.relayFoods = state.relayFoods.filter((f) => f.id !== food.id);
      store.set('relay-foods', state.relayFoods);
    } else {
      const { data } = await readShared('data/foods-custom.json');
      const foods = (data.foods || []).filter((f) => f.id !== food.id);
      await writeShared('data/foods-custom.json', { foods }, `Remove family food: ${food.name}`);
      state.githubFoods = foods.map((f) => ({ ...f, source: 'custom' }));
    }
    setCustomFoods();
    closeSheet();
    refreshRows();
    toast(`Removed ${food.name}`);
  } catch (ex) {
    btn.disabled = false;
    toast(ex.message);
  }
}

// ---------------------------------------------------------------- Glucose readings set-up

async function openCgmSetup() {
  await loadSettings();
  const key = getCgmKey();
  openSheet(`
    ${sheetHeader('Glucose readings', 'Connect the relay running on your Cloudflare account.')}
    <section class="section"><div class="group">
      <div class="row field-row"><label for="cgm-url">Relay address</label><input id="cgm-url" class="wide" inputmode="url" value="${esc(cgmUrl())}" placeholder="https://diabuddy-dexcom….workers.dev" autocomplete="off" spellcheck="false"></div>
      <div class="row field-row"><label for="cgm-k">Family key</label><input id="cgm-k" class="wide" value="${esc(key)}" placeholder="Tap Generate" autocomplete="off" spellcheck="false"></div>
      <button class="row" id="cgm-gen" type="button"><span class="row-main"><span class="row-title row-link">Generate a new family key</span></span></button>
    </div><p class="section-footer" id="cgm-status">Put this same key in Cloudflare as the FAMILY_KEY secret. A new key stops old family links working.</p></section>
    <div class="sheet-actions">
      <button class="btn btn-secondary" id="cgm-test">Test connection</button>
      <button class="btn btn-primary" id="cgm-save">Save</button>
    </div>`, {
    onMount(root) {
      const status = $('#cgm-status', root);
      const values = () => ({ url: $('#cgm-url', root).value.trim().replace(/\/+$/, ''), key: $('#cgm-k', root).value.trim() });
      const valid = ({ url, key }) => {
        if (!/^https:\/\/[^\s/]+/.test(url)) return 'Enter the relay address, starting with https://';
        if (key.length < 16) return 'Generate a family key first.';
        return '';
      };
      $('#cgm-gen', root).addEventListener('click', () => {
        $('#cgm-k', root).value = generateKey();
        status.textContent = 'New key made. Copy it into Cloudflare as FAMILY_KEY, then test.';
      });
      $('#cgm-test', root).addEventListener('click', async () => {
        const v = values();
        const problem = valid(v);
        if (problem) { status.textContent = problem; return; }
        status.textContent = 'Asking his sensor…';
        try {
          const r = await fetchLatest(v.url, v.key);
          status.textContent = `Working: ${readingValue(r)} mmol/L ${r.arrow}, ${readingAge(r)}.`;
        } catch (err) {
          status.textContent = err.message;
        }
      });
      $('#cgm-save', root).addEventListener('click', async (e) => {
        const v = values();
        const problem = valid(v);
        if (problem) { status.textContent = problem; return; }
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          if (v.url !== cgmUrl()) {
            await loadSettings();
            const next = { ...state.settings, cgmUrl: v.url };
            await writeShared('settings.json', next, 'Set glucose relay address');
            state.settings = next;
            store.set('settings', { data: next, fetchedAt: Date.now() });
          }
          setCgmKey(v.key);
          state.cgm = { reading: null, error: null, at: 0, loading: false };
          closeSheet();
          renderSettings();
          renderCgmCard();
          refreshCgm();
          toast('Glucose readings set up');
        } catch (err) {
          status.textContent = err.message;
          btn.disabled = false;
          btn.textContent = 'Save';
        }
      });
    },
  });
}

function openCgmKeyEntry() {
  openSheet(`
    ${sheetHeader('Family key', 'Lets this phone show his glucose readings.')}
    <section class="section"><div class="group">
      <div class="row field-row"><label for="fk">Key</label><input id="fk" class="wide" placeholder="Paste the key" autocomplete="off" spellcheck="false"></div>
    </div><p class="section-footer" id="fk-status">Easier: open the family link the admin sent you, and it sets this up by itself.</p></section>
    <div class="sheet-actions"><button class="btn btn-primary" id="fk-go">Connect</button></div>`, {
    onMount(root) {
      $('#fk-go', root).addEventListener('click', async () => {
        const key = $('#fk', root).value.trim();
        const status = $('#fk-status', root);
        status.textContent = 'Checking…';
        try {
          await fetchLatest(cgmUrl(), key);
          setCgmKey(key);
          closeSheet();
          renderSettings();
          renderCgmCard();
          refreshCgm();
          toast('Readings connected');
        } catch (err) {
          status.textContent = err.message;
        }
      });
    },
  });
}

async function shareFamilyLink() {
  const link = familyLink(getCgmKey());
  try {
    if (navigator.share) {
      await navigator.share({ title: 'DiaBuddy', text: 'DiaBuddy with his glucose readings. Open this once on your phone:', url: link });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(link);
    toast('Family link copied');
  } catch {
    openSheet(`${sheetHeader('Family link')}<section class="section"><div class="group"><div class="row"><span class="row-main"><span class="row-title" style="user-select:all;-webkit-user-select:all">${esc(link)}</span></span></div></div><p class="section-footer">Copy this and send it to family phones.</p></section>`);
  }
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
  unlock: openUnlock,
  lock: () => { lock(); renderSettings(); renderFoods(); toast('Admin locked on this device'); },
  'edit-settings': openSettingsEditor,
  'add-family-food': () => openFamilyFoodForm(),
  'photo-label': openPhotoLabel,
  'cgm-refresh': refreshCgm,
  'cgm-setup': openCgmSetup,
  'cgm-key': openCgmKeyEntry,
  'cgm-share': shareFamilyLink,
  'cgm-forget': () => {
    setCgmKey('');
    state.cgm = { reading: null, error: null, at: 0, loading: false };
    renderCgmCard();
    renderSettings();
    toast('Readings removed from this phone');
  },
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

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    renderGreeting();
    if (await loadSettings()) { renderSettings(); renderSetupBanner(); }
    refreshCgm();
    loadTodayLog();
    loadRelayFoods();
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  const linked = consumeLinkKey();
  renderGreeting();
  restoreMeal();
  initEvents();
  initTray();
  initSheet();
  renderTray();
  renderHome();
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
  if (linked) toast(cgmUrl() ? 'His glucose readings are on this phone now' : 'Family key saved');
  // The family link opened in a tab where DiaBuddy is already running.
  addEventListener('hashchange', () => {
    if (!consumeLinkKey()) return;
    state.cgm = { reading: null, error: null, at: 0, loading: false };
    renderCgmCard();
    renderSettings();
    refreshCgm();
    toast('His glucose readings are on this phone now');
  });
  // Libre updates every minute and Dexcom every 5; check every 2.5 minutes.
  setInterval(() => { if (document.visibilityState === 'visible') refreshCgm(); }, 150000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
