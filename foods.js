// Food database: notebook + USDA (data/foods.json), family additions (data/foods-custom.json),
// and South African packaged products from Open Food Facts.

import { readShared } from './admin.js';

export const CATEGORIES = [
  'Breakfast', 'Bread & bakery', 'Grains & starches', 'Fruit', 'Vegetables', 'Dairy',
  'Drinks', 'Snacks', 'Sweets & spreads', 'Meals & takeaway', 'Protein',
];

export const SOURCE_LABEL = {
  notebook: 'Notebook',
  custom: 'Family',
  usda: 'USDA',
  off: 'Check label',
  manual: 'Label',
};

export async function loadFoods() {
  const base = await fetch('./data/foods.json').then((r) => r.json());
  let custom = [];
  try {
    custom = (await readShared('data/foods-custom.json')).data.foods || [];
  } catch {}
  return { base: base.foods, custom };
}

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

// Tokenise each name once; searching ~10k packaged products runs on every keystroke.
const tokenCache = new WeakMap();
function tokensOf(food) {
  let tokens = tokenCache.get(food);
  if (!tokens) {
    tokens = norm(food.name).split(/[^a-z0-9]+/).filter(Boolean);
    tokenCache.set(food, tokens);
  }
  return tokens;
}

// Every query word must match the start of a word in the name.
// Notebook and family foods rank first because the family has checked them.
export function searchFoods(foods, query, category) {
  const words = norm(query).split(/[^a-z0-9]+/).filter(Boolean);
  const rank = { notebook: 0, custom: 0, usda: 1, off: 2 };
  return foods
    .filter((f) => !category || f.category === category)
    .filter((f) => {
      if (!words.length) return true;
      const tokens = tokensOf(f);
      return words.every((w) => tokens.some((t) => t.startsWith(w)));
    })
    .sort((a, b) => (rank[a.source] ?? 3) - (rank[b.source] ?? 3) || a.name.localeCompare(b.name));
}

// ---- Open Food Facts ---------------------------------------------------------
// data/za-products.json is a snapshot of South African products from the Open Food
// Facts export (see scripts/build-za-products.mjs). SA labels list carbohydrate
// excluding fibre, so it already matches "glycemic carbs". Values are crowd-sourced,
// so the app always says "check the label".

function offFood({ code, name, brand, per100g, grams, servingSize }) {
  const g = grams > 0 ? grams : 100;
  return {
    id: `off-${code}`,
    name: brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${name} – ${brand}` : name,
    category: 'Packaged',
    serving: { label: servingSize || `${g} g`, grams: g },
    netCarbs: Math.round(per100g * g) / 100,
    per100g,
    source: 'off',
    barcode: code,
  };
}

let products = null;
export async function loadPackaged() {
  if (!products) {
    products = fetch('./data/za-products.json')
      .then((r) => r.json())
      .then((j) => j.products.map((p) => offFood({ code: p.c, name: p.n, brand: p.b, per100g: p.k, grams: p.g, servingSize: p.s })))
      .catch((err) => { products = null; throw err; });
  }
  return products;
}

export async function lookupBarcode(code, { signal } = {}) {
  const clean = String(code).replace(/\D/g, '');
  if (clean.length < 8) throw new Error('Barcodes are 8 to 13 digits.');
  const local = (await loadPackaged().catch(() => [])).find((f) => f.barcode === clean);
  if (local) return local;
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${clean}.json?fields=code,product_name,brands,nutriments,serving_quantity,serving_size`, { signal });
  const json = await res.json().catch(() => ({}));
  if (json.status !== 1) throw new Error('Product not found. Use "Carbs from a label" instead.');
  const p = json.product;
  const per100g = Number(p.nutriments?.carbohydrates_100g);
  if (!p.product_name || !Number.isFinite(per100g)) throw new Error('Product found, but it has no carb value. Use "Carbs from a label".');
  return offFood({
    code: clean,
    name: p.product_name.trim(),
    brand: String(p.brands || '').split(',')[0].trim(),
    per100g: Math.round(per100g * 10) / 10,
    grams: Math.round(Number(p.serving_quantity)) || 0,
    servingSize: p.serving_size,
  });
}
