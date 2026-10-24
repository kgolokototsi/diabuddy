// Builds data/foods.json from two sources:
//   1. NOTEBOOK – the family's handwritten Food Guide, transcribed exactly.
//   2. USDA     – curated items from USDA FoodData Central SR Legacy (public domain).
//
// Usage:
//   1. Download https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip
//   2. Unzip it, then run:
//      node scripts/build-foods.mjs path/to/FoodData_Central_sr_legacy_food_json_2018-04.json
//
// USDA "carbohydrate, by difference" includes fibre, so we store net (glycemic)
// carbs = carbohydrate − fibre, which matches the notebook's "Glycemic Carbs" column.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '..', 'data', 'foods.json');

// [name, category, serving label, serving grams (null if not weighable), net carbs per serving, note?, free?]
const NOTEBOOK = [
  ['Futurelife', 'Breakfast', '50 g', 50, 24],
  ['Oats', 'Breakfast', '50 g', 50, 28.5],
  ['Raspberries', 'Fruit', '30 g', 30, 3.6],
  ['Blueberries', 'Fruit', '30 g', 30, 6],
  ['Blackberries', 'Fruit', '30 g', 30, 3],
  ['Strawberries', 'Fruit', '30 g', 30, 2.1],
  ['Mangoes', 'Fruit', '30 g', 30, 6],
  ['Potatoes', 'Vegetables', '≈100 g', 100, 25, 'Approximate'],
  ['Sweet potatoes', 'Vegetables', '100 g', 100, 17, 'Approximate'],
  ['Corn', 'Vegetables', '100 g', 100, 21, 'Normal serving should be smaller than 100 g'],
  ['Broccoli', 'Vegetables', 'Unlimited', null, 0, null, true],
  ['Cucumber', 'Vegetables', 'Unlimited', null, 0, null, true],
  ['Tomatoes', 'Vegetables', 'Unlimited', null, 0, null, true],
  ['Carrots', 'Vegetables', 'Unlimited', null, 0, null, true],
  ['Spinach', 'Vegetables', 'Unlimited', null, 0, null, true],
  ['Mushrooms', 'Vegetables', 'Unlimited', null, 0, null, true],
  ['Cabbage', 'Vegetables', 'Unlimited', null, 0, null, true],
  ['Green beans', 'Vegetables', 'Unlimited', null, 0, null, true],
  ['Chips', 'Vegetables', '8–10 pieces', null, 15],
  ['Butternut', 'Vegetables', '50 g', 50, 5.5],
  ['Gem squash', 'Vegetables', '100 g', 100, 3.6],
  ['Gherkins', 'Vegetables', '30 g (2 pcs)', 30, 2],
];

// [fdcId, name, category, serving label, serving grams, note?]
const USDA = [
  // Bread & bakery
  [174924, 'White bread', 'Bread & bakery', '1 slice (35 g)', 35, 'SA slices vary – weigh if unsure'],
  [172688, 'Brown / whole-wheat bread', 'Bread & bakery', '1 slice (35 g)', 35, 'SA slices vary – weigh if unsure'],
  [174925, 'White toast', 'Bread & bakery', '1 slice (30 g)', 30],
  [172796, 'Bread roll / hot dog roll', 'Bread & bakery', '1 roll (45 g)', 45],
  [174915, 'Pita bread', 'Bread & bakery', '1 small (30 g)', 30],
  [175037, 'Flour tortilla / wrap', 'Bread & bakery', '1 wrap (45 g)', 45],
  [175063, 'English muffin', 'Bread & bakery', '1 muffin (57 g)', 57],
  [174987, 'Croissant', 'Bread & bakery', '1 medium (57 g)', 57],
  [175009, 'Pancake, homemade', 'Bread & bakery', '1 pancake (38 g)', 38],
  [175038, 'Waffle, frozen', 'Bread & bakery', '1 waffle (35 g)', 35],
  [172765, 'Blueberry muffin', 'Bread & bakery', '1 small (60 g)', 60],
  [174990, 'Doughnut, plain', 'Bread & bakery', '1 medium (47 g)', 47],
  [174992, 'Doughnut, glazed', 'Bread & bakery', '1 medium (47 g)', 47],
  [174934, 'Chocolate cake with icing', 'Bread & bakery', '1 kids slice (50 g)', 50],

  // Breakfast
  [174648, 'Corn flakes', 'Breakfast', '30 g (about 1 cup)', 30, 'Check your box – brands differ'],
  [169040, 'Weet-Bix / Weetabix', 'Breakfast', '1 biscuit (19 g)', 19, 'Check your box – biscuit weight varies'],
  [172975, 'Granola / muesli with raisins', 'Breakfast', '30 g', 30],
  [173905, 'Oats porridge, cooked with water', 'Breakfast', '100 g cooked', 100],
  [171659, 'Tasty Wheat / farina porridge, cooked', 'Breakfast', '100 g cooked', 100],

  // Grains & starches
  [168878, 'White rice, cooked', 'Grains & starches', '100 g cooked', 100],
  [169704, 'Brown rice, cooked', 'Grains & starches', '100 g cooked', 100],
  [169737, 'Pasta / spaghetti / macaroni, cooked', 'Grains & starches', '100 g cooked', 100],
  [169732, 'Egg noodles, cooked', 'Grains & starches', '100 g cooked', 100],
  [169700, 'Couscous, cooked', 'Grains & starches', '100 g cooked', 100],
  [171655, 'Soft maize porridge (slap pap)', 'Grains & starches', '100 g cooked', 100, 'Soft/runny pap only. Stiff pap is denser – weigh the dry maize meal for accuracy'],
  [168922, 'Maize meal, dry (weigh before cooking)', 'Grains & starches', '30 g dry', 30, 'Weigh his portion of dry meal, then cook'],
  [168555, 'Mashed potato (milk & butter)', 'Grains & starches', '100 g', 100],
  [170093, 'Baked potato with skin', 'Grains & starches', '100 g', 100],
  [170437, 'Oven chips / fries', 'Grains & starches', '100 g', 100],

  // Fruit
  [171688, 'Apple', 'Fruit', '1 small (100 g)', 100],
  [173944, 'Banana', 'Fruit', '1 small, peeled (100 g)', 100],
  [169097, 'Orange', 'Fruit', '1 small, peeled (100 g)', 100],
  [169105, 'Naartjie / mandarin', 'Fruit', '1 medium, peeled (75 g)', 75],
  [174683, 'Grapes', 'Fruit', '10 grapes (50 g)', 50],
  [169118, 'Pear', 'Fruit', '1 small (100 g)', 100],
  [169928, 'Peach', 'Fruit', '1 small (100 g)', 100],
  [169949, 'Plum', 'Fruit', '1 plum (66 g)', 66],
  [171697, 'Apricot', 'Fruit', '1 apricot (35 g)', 35],
  [167765, 'Watermelon', 'Fruit', '1 cup cubes (150 g)', 150],
  [169092, 'Spanspek / cantaloupe', 'Fruit', '100 g', 100],
  [169124, 'Pineapple', 'Fruit', '100 g', 100],
  [168153, 'Kiwi fruit', 'Fruit', '1 kiwi (70 g)', 70],
  [171719, 'Cherries', 'Fruit', '10 cherries (70 g)', 70],
  [169086, 'Litchis', 'Fruit', '5 litchis (50 g)', 50],
  [173044, 'Guava', 'Fruit', '1 guava (55 g)', 55],
  [169926, 'Pawpaw / papaya', 'Fruit', '100 g', 100],
  [168165, 'Raisins', 'Fruit', '1 mini box (14 g)', 14],
  [173941, 'Dried apricots', 'Fruit', '3 pieces (21 g)', 21],
  [171695, 'Apple purée, unsweetened', 'Fruit', '100 g', 100],
  [174668, 'Fruit cocktail in juice', 'Fruit', '100 g', 100],
  [171705, 'Avocado', 'Fruit', '50 g', 50],

  // Vegetables & legumes
  [175182, 'Baked beans in tomato sauce', 'Vegetables', '100 g', 100],
  [175194, 'Red kidney beans, cooked', 'Vegetables', '100 g', 100],
  [173757, 'Chickpeas, cooked', 'Vegetables', '100 g', 100],
  [172421, 'Lentils, cooked', 'Vegetables', '100 g', 100],
  [170017, 'Peas, cooked', 'Vegetables', '50 g', 50],
  [169214, 'Sweetcorn kernels, canned', 'Vegetables', '50 g', 50],
  [168449, 'Pumpkin, cooked', 'Vegetables', '100 g', 100],
  [170000, 'Onion', 'Vegetables', '50 g', 50],
  [170108, 'Red pepper', 'Vegetables', '50 g', 50],
  [169248, 'Lettuce', 'Vegetables', '30 g', 30],

  // Dairy
  [171265, 'Full cream milk', 'Dairy', '1 cup (250 ml)', 250],
  [171267, 'Low fat milk (2%)', 'Dairy', '1 cup (250 ml)', 250],
  [170880, 'Chocolate milk', 'Dairy', '1 cup (250 ml)', 250, 'Check the bottle – flavoured milks vary a lot'],
  [171284, 'Plain yoghurt', 'Dairy', '100 g', 100],
  [173456, 'Fruit yoghurt, low fat', 'Dairy', '100 g', 100, 'Check the tub – brands vary'],
  [171304, 'Greek yoghurt, plain', 'Dairy', '100 g', 100],
  [167575, 'Vanilla ice cream', 'Dairy', '1 scoop (65 g)', 65],
  [168773, 'Custard (made with milk)', 'Dairy', '100 g', 100],
  [168778, 'Chocolate pudding', 'Dairy', '100 g', 100],
  [170899, 'Cheddar cheese', 'Dairy', '1 slice (20 g)', 20],
  [170845, 'Mozzarella cheese', 'Dairy', '30 g', 30],

  // Drinks
  [169098, 'Orange juice', 'Drinks', '1 glass (200 ml)', 200],
  [173933, 'Apple juice', 'Drinks', '1 glass (200 ml)', 200],
  [173042, 'Grape juice', 'Drinks', '1 glass (200 ml)', 200],
  [174852, 'Cola, regular', 'Drinks', '1 can (330 ml)', 340],
  [173205, 'Lemonade / lemon-lime soda, regular', 'Drinks', '1 can (330 ml)', 340],

  // Snacks
  [169677, 'Crisps (potato chips)', 'Snacks', '1 small packet (30 g)', 30, 'Check the packet size'],
  [167959, 'Popcorn, air-popped', 'Snacks', '10 g (about 1¼ cups)', 10],
  [167555, 'Pretzels', 'Snacks', '30 g', 30],
  [170250, 'Rice cakes', 'Snacks', '1 cake (9 g)', 9],
  [172746, 'Salty crackers (saltines)', 'Snacks', '5 crackers (15 g)', 15],
  [171867, 'Marie biscuits', 'Snacks', '2 biscuits (15 g)', 15],
  [174950, 'Butter biscuits', 'Snacks', '2 biscuits (15 g)', 15],
  [172716, 'Choc chip cookie', 'Snacks', '1 cookie (10 g)', 10],
  [172718, 'Chocolate cream biscuit (Oreo-type)', 'Snacks', '1 biscuit (11 g)', 11],
  [167954, 'Cereal / granola bar', 'Snacks', '1 bar (28 g)', 28],
  [174289, 'Hummus', 'Snacks', '2 tbsp (30 g)', 30],

  // Sweets & spreads
  [169640, 'Honey', 'Sweets & spreads', '1 tsp (7 g)', 7],
  [169655, 'Sugar', 'Sweets & spreads', '1 tsp (4 g)', 4],
  [169641, 'Jam', 'Sweets & spreads', '1 tsp (7 g)', 7],
  [169578, 'Pancake syrup', 'Sweets & spreads', '1 tbsp (20 g)', 20],
  [172470, 'Peanut butter', 'Sweets & spreads', '1 tbsp (16 g)', 16],
  [168556, 'Tomato sauce (ketchup)', 'Sweets & spreads', '1 tbsp (15 g)', 15],
  [167587, 'Milk chocolate', 'Sweets & spreads', '10 g', 10],
  [167991, 'Jelly beans', 'Sweets & spreads', '10 beans (11 g)', 11],
  [167989, 'Jelly sweets / gums', 'Sweets & spreads', '10 g', 10],
  [167995, 'Marshmallows', 'Sweets & spreads', '1 large (7 g)', 7],

  // Meals & takeaway
  [170693, 'Hamburger, plain (takeaway)', 'Meals & takeaway', '1 burger (90 g)', 90],
  [170317, 'Cheese pizza', 'Meals & takeaway', '1 slice (70 g)', 70],
  [172111, 'Chicken nuggets', 'Meals & takeaway', '4 nuggets (64 g)', 64],
  [170718, 'Fried chicken strips / popcorn chicken', 'Meals & takeaway', '100 g', 100],
  [174195, 'Fish fingers', 'Meals & takeaway', '3 fingers (75 g)', 75],
  [169033, 'Spaghetti with tomato sauce', 'Meals & takeaway', '150 g', 150],
  [167680, 'Spaghetti bolognese', 'Meals & takeaway', '150 g', 150],
  [171176, 'Tomato soup', 'Meals & takeaway', '1 cup (250 ml)', 250],

  // Protein (close to zero carbs, listed so nobody has to guess)
  [173424, 'Egg, boiled', 'Protein', '1 egg (50 g)', 50],
  [171477, 'Chicken breast, roasted', 'Protein', '100 g', 100],
  [174033, 'Beef mince, cooked', 'Protein', '100 g', 100],
  [174614, 'Vienna / hot dog sausage', 'Protein', '1 sausage (45 g)', 45],
];

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const round1 = (n) => Math.round(n * 10) / 10;

const srcFile = process.argv[2];
if (!srcFile) {
  console.error('Usage: node scripts/build-foods.mjs <FoodData_Central_sr_legacy_food_json.json>');
  process.exit(1);
}
const sr = JSON.parse(fs.readFileSync(srcFile, 'utf8')).SRLegacyFoods;
const byId = new Map(sr.map((f) => [f.fdcId, f]));
const nutrient = (f, number) => f.foodNutrients.find((n) => n.nutrient.number === number)?.amount ?? 0;

const foods = [];

for (const [name, category, label, grams, netCarbs, note, free] of NOTEBOOK) {
  foods.push({
    id: `nb-${slug(name)}`,
    name,
    category,
    serving: { label, grams },
    netCarbs,
    source: 'notebook',
    ...(note && { note }),
    ...(free && { free: true }),
  });
}

for (const [fdcId, name, category, label, grams, note] of USDA) {
  const f = byId.get(fdcId);
  if (!f) throw new Error(`FDC ${fdcId} (${name}) not found in dataset`);
  const per100g = round1(Math.max(0, nutrient(f, '205') - nutrient(f, '291')));
  foods.push({
    id: `usda-${fdcId}`,
    name,
    category,
    serving: { label, grams },
    netCarbs: round1((per100g * grams) / 100),
    per100g,
    source: 'usda',
    fdcId,
    usdaName: f.description,
    ...(note && { note }),
  });
}

const ids = new Set();
for (const f of foods) {
  if (ids.has(f.id)) throw new Error(`Duplicate id ${f.id}`);
  ids.add(f.id);
}

fs.writeFileSync(outFile, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), foods }, null, 1) + '\n');
console.log(`Wrote ${foods.length} foods (${NOTEBOOK.length} notebook, ${USDA.length} USDA) to ${path.relative(process.cwd(), outFile)}`);
