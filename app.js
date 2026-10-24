import { calculateDose, parseBg, lineCarbs, isConfigured, BG_MIN, BG_MAX } from './dose.js';
import { loadFoods, searchFoods, loadPackaged, lookupBarcode, CATEGORIES, SOURCE_LABEL } from './foods.js';
import { readShared, writeShared, isAdmin, unlock, lock } from './admin.js';
import { spring, project, rubberband, VelocityTracker } from './spring.js';
import { REPO, APP_VERSION } from './config.js';

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
  tab: 'meal',
  base: [],
  custom: [],
  packaged: null,
  packagedLoading: false,
  settings: null,
  settingsMeta: null, // { from: 'github' | 'pages' | 'cache', fetchedAt }
  meal: [],
  recent: store.get('recent', []),
  mealQuery: '',
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

async function loadAllFoods() {
  const cachedCustom = store.get('custom', []);
  try {
    const { base, custom } = await loadFoods();
    state.base = base;
    state.custom = custom.map((f) => ({ ...f, source: 'custom' }));
    store.set('custom', state.custom);
  } catch {
    state.custom = cachedCustom;
  }
  indexFoods(allLocalFoods());
}

function ensurePackaged() {
  if (state.packaged || state.packagedLoading) return;
  state.packagedLoading = true;
  loadPackaged()
    .then((list) => { state.packaged = list; indexFoods(list); })
    .catch(() => { state.packaged = []; })
    .finally(() => {
      state.packagedLoading = false;
      renderMealResults();
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
  renderMealResults();
  renderFoods();
}

// ---------------------------------------------------------------- Meal screen

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

function renderMealResults() {
  const el = $('#meal-results');
  const q = state.mealQuery.trim();
  if (!q) {
    const notebook = state.base.filter((f) => f.source === 'notebook');
    const recent = state.recent.slice(0, 6);
    el.innerHTML = [
      recent.length ? section('Recent', recent.map((f) => foodRow(f)).join('')) : '',
      state.custom.length ? section('Family foods', state.custom.map((f) => foodRow(f)).join('')) : '',
      section('From the notebook', notebook.map((f) => foodRow(f)).join(''), 'Tap a food to add one serving. Change the amount in the meal tray below.'),
    ].join('');
    return;
  }

  ensurePackaged();
  const local = searchFoods(allLocalFoods(), q).slice(0, 40);
  const packaged = state.packaged ? searchFoods(state.packaged, q).slice(0, 25) : [];
  const parts = [];
  if (local.length) parts.push(section('Foods', local.map((f) => foodRow(f)).join('')));
  if (state.packagedLoading) parts.push(`<section class="section"><h2 class="section-header">Packaged in South Africa</h2>${loadingRow('Loading products…')}</section>`);
  else if (packaged.length) {
    parts.push(section('Packaged in South Africa', packaged.map((f) => foodRow(f)).join(''),
      'From Open Food Facts. These are entered by the public, so check the carbs against the label.'));
  }
  if (!parts.length) {
    parts.push(`<div class="empty"><strong>No foods match “${esc(q)}”</strong>Use the carbs on the label instead.</div>
      <div class="sheet-actions"><button class="btn btn-secondary" data-action="manual">Carbs from a label</button></div>`);
  }
  el.innerHTML = parts.join('');
}

// ---------------------------------------------------------------- Foods screen

function renderFoods() {
  const cats = ['All', ...CATEGORIES, ...(state.custom.length ? ['Family'] : []), 'Packaged'];
  $('#foods-chips').innerHTML = cats.map((c) => {
    const selected = (state.category ?? 'All') === c;
    return `<button class="chip" role="tab" data-cat="${esc(c)}" aria-selected="${selected}">${esc(c === 'Packaged' ? 'Packaged (SA)' : c)}</button>`;
  }).join('');

  $('#foods-admin').innerHTML = isAdmin()
    ? `<div class="quick-actions"><button class="pill-button" data-action="add-family-food">${ICON.plus} Add a family food</button></div>`
    : '';

  const el = $('#foods-results');
  const q = state.foodsQuery.trim();
  const cat = state.category;

  if (cat === 'Packaged') {
    ensurePackaged();
    if (state.packagedLoading) { el.innerHTML = loadingRow('Loading products…'); return; }
    if (!q) {
      el.innerHTML = `<div class="empty"><strong>Search packaged foods</strong>${state.packaged?.length ? `${state.packaged.length.toLocaleString('en-ZA')} South African products` : 'South African products'} from Open Food Facts. Try “Weet-Bix” or “Pronutro”.</div>`;
      return;
    }
    const hits = searchFoods(state.packaged || [], q).slice(0, 60);
    el.innerHTML = hits.length
      ? section(null, hits.map((f) => foodRow(f, 'detail')).join(''), 'Entered by the public. Check the carbs against the label.')
      : `<div class="empty"><strong>No products match “${esc(q)}”</strong>Try the brand name, or scan the barcode on the Meal tab.</div>`;
    return;
  }

  let list = cat === 'Family' ? state.custom : allLocalFoods();
  list = searchFoods(list, q, cat && cat !== 'Family' ? cat : null);
  if (!list.length) {
    el.innerHTML = `<div class="empty"><strong>No foods found</strong>Try another word, or look under Packaged (SA).</div>`;
    return;
  }
  if (cat) {
    el.innerHTML = section(null, list.map((f) => foodRow(f, 'detail')).join(''));
    return;
  }
  const groups = new Map();
  for (const f of list) {
    const key = f.source === 'custom' ? 'Family' : f.category;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const order = ['Family', ...CATEGORIES];
  el.innerHTML = [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([name, foods]) => section(name, foods.map((f) => foodRow(f, 'detail')).join('')))
    .join('');
}

// ---------------------------------------------------------------- Settings screen

function settingRow(label, value) {
  return `<div class="row"><span class="row-main"><span class="row-title">${esc(label)}</span></span><span class="row-value">${value}</span></div>`;
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
    ${section('His dose settings', doseRows, `${esc(loadedFrom)} Last changed ${fmtDate(s?.updatedAt)}. Only the admin can change these.`)}
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
  $('#tray-count').textContent = n === 1 ? '1 food · tap to see' : `${n} foods · tap to see`;
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

  document.body.classList.toggle('has-tray', n > 0);
  if (n && !tray.visible) {
    tray.visible = true;
    tray.el.hidden = false;
    setTrayY(tray.hiddenY);
    tray.expanded = false;
    animateTray(tray.collapsedY);
  } else if (!n && tray.visible) {
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

function mountAmount(root, food, initialServings, onChange) {
  const st = { mode: 'servings', servings: initialServings };
  const canGrams = food.serving.grams > 0;
  const step = 0.5;

  const preview = () => {
    const carbs = lineCarbs(food, st.servings);
    $('#amt-preview', root).textContent = food.free
      ? 'Free food. No carbs counted.'
      : `${fmt(st.servings, 2)} × ${food.serving.label} = ${fmt(carbs)} g carbs`;
    onChange?.(st.servings);
  };

  const paint = () => {
    const value = st.mode === 'grams' ? fmt(st.servings * food.serving.grams, 0) : fmt(st.servings, 2);
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
            <input id="amt-input" inputmode="decimal" value="${value}" style="width:4.5rem" aria-label="${st.mode === 'grams' ? 'Grams' : 'Servings'}">
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
      ${isAdmin() && food.source === 'off' ? '<button class="btn btn-secondary" id="detail-save">Save to family foods</button>' : ''}
      ${isAdmin() && food.source === 'custom' ? '<button class="btn btn-danger" id="detail-remove">Remove from family foods</button>' : ''}
    </div>`, {
    onMount(root) {
      const getServings = mountAmount($('#amount', root), food, 1);
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
    <div id="amount"></div>
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
    ${sheetHeader(correctionOnly ? 'BG correction' : 'Dose', correctionOnly ? 'No food. Correction for a high BG only.' : `${fmt(carbs)} g carbs from ${count} ${count === 1 ? 'food' : 'foods'}`)}
    <section class="section" style="margin-top:14px"><div class="group">
      <div class="bg-entry"><label for="bg-input">Current BG</label><input id="bg-input" inputmode="decimal" placeholder="–" autocomplete="off" aria-describedby="bg-error"><span class="unit">mmol/L</span></div>
      <div class="row"><span class="row-main"><label for="recent-insulin" class="row-title">Insulin in the last 3 hours</label><span class="row-sub">Leaves out a correction for high BG</span></span><input type="checkbox" class="switch" id="recent-insulin"></div>
    </div><p class="field-error" id="bg-error" hidden></p></section>
    <div id="dose-out" aria-live="polite"></div>
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
        if (r.status === 'ok' && r.rounded !== lastRounded) {
          if (lastRounded !== null) $('.dose-result', root)?.classList.add('dose-pop');
          lastRounded = r.rounded;
        }
      };

      input.addEventListener('input', paint);
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
          const { data } = await readShared('data/foods-custom.json');
          const foods = [...(data.foods || []), food];
          await writeShared('data/foods-custom.json', { foods }, `Add family food: ${name}`);
          state.custom = foods.map((f) => ({ ...f, source: 'custom' }));
          store.set('custom', state.custom);
          indexFoods(state.custom);
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

async function removeFamilyFood(food, btn) {
  btn.disabled = true;
  try {
    const { data } = await readShared('data/foods-custom.json');
    const foods = (data.foods || []).filter((f) => f.id !== food.id);
    await writeShared('data/foods-custom.json', { foods }, `Remove family food: ${food.name}`);
    state.custom = foods.map((f) => ({ ...f, source: 'custom' }));
    store.set('custom', state.custom);
    closeSheet();
    refreshRows();
    toast(`Removed ${food.name}`);
  } catch (ex) {
    btn.disabled = false;
    toast(ex.message);
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
  if (tray.expanded) setTrayExpanded(false);
  scrollTo(0, state.scroll[tab] || 0);
}

const actions = {
  'close-sheet': () => closeSheet(),
  manual: openManual,
  barcode: openBarcode,
  calculate: () => openDose(),
  correction: () => openDose({ correctionOnly: true }),
  'clear-meal': () => { setTrayExpanded(false); clearMeal(); },
  unlock: openUnlock,
  lock: () => { lock(); renderSettings(); renderFoods(); toast('Admin locked on this device'); },
  'edit-settings': openSettingsEditor,
  'add-family-food': () => openFamilyFoodForm(),
};

function initEvents() {
  // Lets :active press states fire immediately on iOS.
  document.addEventListener('touchstart', () => {}, { passive: true });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab], [data-add], [data-detail], [data-action], [data-line], [data-step], [data-cat]');
    if (!t) return;
    const d = t.dataset;
    if (d.tab) switchTab(d.tab);
    else if (d.add) addToMeal(foodIndex.get(d.add));
    else if (d.detail) { const f = foodIndex.get(d.detail); if (f) openFoodDetail(f); }
    else if (d.action) actions[d.action]?.();
    else if (d.line) openLineEditor(d.line);
    else if (d.step) {
      const line = state.meal.find((l) => l.food.id === d.id);
      if (line) setServings(d.id, line.servings + Number(d.step) * 0.5);
    } else if (d.cat) {
      state.category = d.cat === 'All' ? null : d.cat;
      renderFoods();
      t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });

  $('#meal-search').addEventListener('input', (e) => { state.mealQuery = e.target.value; renderMealResults(); });
  $('#foods-search').addEventListener('input', (e) => { state.foodsQuery = e.target.value; renderFoods(); });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (await loadSettings()) { renderSettings(); renderSetupBanner(); }
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  restoreMeal();
  initEvents();
  initTray();
  initSheet();
  renderTray();
  renderMealResults();
  await Promise.all([loadSettings(), loadAllFoods()]);
  renderSetupBanner();
  renderMealResults();
  renderFoods();
  renderSettings();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
