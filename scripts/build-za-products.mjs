// Builds data/za-products.json: South African packaged foods with a carb value,
// from the Open Food Facts data export (ODbL – https://world.openfoodfacts.org/data).
// Open Food Facts asks bots to use the export rather than the API, so stream it:
//
//   curl -sL https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz \
//     | gunzip | node scripts/build-za-products.mjs
//
// South African labels list carbohydrate excluding fibre, so carbohydrates_100g is
// used as-is (it matches "glycemic carbs"). Values are crowd-sourced – the app marks
// every one of these "check label".

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '..', 'data', 'za-products.json');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let col = null;
let rows = 0;
const byKey = new Map();

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

for await (const line of rl) {
  const cells = line.split('\t');
  if (!col) {
    col = Object.fromEntries(cells.map((name, i) => [name, i]));
    for (const need of ['code', 'product_name', 'brands', 'countries_tags', 'carbohydrates_100g']) {
      if (!(need in col)) throw new Error(`Export is missing column ${need}`);
    }
    continue;
  }
  rows++;
  if (!cells[col.countries_tags]?.includes('en:south-africa')) continue;

  const name = clean(cells[col.product_name]);
  const carbs = Number(cells[col.carbohydrates_100g]);
  // Drop zero/near-zero carbs: in this crowd-sourced data they are mostly missing
  // values (e.g. cereals entered as 0 g), and a wrong 0 means no insulin for real carbs.
  // Truly carb-free foods don't need counting anyway.
  if (!name || name.length < 2 || !Number.isFinite(carbs) || carbs < 0.5 || carbs > 100) continue;

  const brand = clean(cells[col.brands]).split(',')[0].trim();
  const qty = Number(cells[col.serving_quantity]);
  const servingSize = clean(cells[col.serving_size]);
  const item = {
    c: cells[col.code],
    n: name,
    ...(brand && { b: brand }),
    k: Math.round(carbs * 10) / 10,
    ...(qty > 0 && qty <= 1000 && { g: Math.round(qty) }),
    ...(qty > 0 && servingSize && servingSize.length <= 40 && { s: servingSize }),
  };

  // Many products are entered more than once; keep one per name + brand + carbs.
  const key = `${name.toLowerCase()}|${brand.toLowerCase()}|${item.k}`;
  if (!byKey.has(key)) byKey.set(key, item);
}

const products = [...byKey.values()].sort((a, b) => a.n.localeCompare(b.n));
fs.writeFileSync(outFile, JSON.stringify({
  source: 'Open Food Facts (ODbL), https://world.openfoodfacts.org',
  generated: new Date().toISOString().slice(0, 10),
  products,
}) + '\n');
console.error(`Scanned ${rows} rows, wrote ${products.length} South African products to ${path.relative(process.cwd(), outFile)}`);
