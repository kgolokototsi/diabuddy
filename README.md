# DiaBuddy Carb Counter

A carb counter and insulin dose calculator for the family. Pick what he's eating, enter his blood glucose, and DiaBuddy shows the dose and how it was worked out.

**Open it:** https://kgolokototsi.github.io/diabuddy/

> DiaBuddy is a calculator, not medical advice. Always follow his diabetes team's plan and use your own judgement.

## For the family

1. Open the link on your phone and add it to your home screen:
   - **iPhone:** Safari → Share → *Add to Home Screen*
   - **Android:** Chrome → ⋮ → *Add to Home screen*
   
   It then works like an app, and it works without signal after the first open.
2. On **Meal**, tap each food he's eating. Each tap adds one serving.
3. Open the tray at the bottom to change amounts: use − / + for half servings, or tap a food to enter grams.
4. Tap **Calculate dose** and enter his BG in mmol/L. The dose is rounded to the nearest 0.5 unit.

Other things you can do:

- **Carbs from a label:** type the carbs from a packet, either the total or per 100 g plus the grams eaten.
- **Barcode:** find a packaged product by its barcode. On Android you can scan with the camera.
- **BG correction only:** works out a correction for a high BG when he isn't eating.
- **Insulin in the last 3 hours:** switch this on if he's had insulin recently. DiaBuddy then leaves out the high-BG correction so doses don't stack.
- If his BG is **below 4.0**, DiaBuddy won't show a dose. Treat the low first.

### The food badges

| Badge | Meaning |
| --- | --- |
| Notebook | From the handwritten Food Guide. The family has already checked these. |
| Family | Added by the admin. |
| USDA | From USDA FoodData Central, net carbs (fibre removed). |
| Check label | Packaged SA products from Open Food Facts. These are entered by the public, so compare with the packet. |

## For the admin

His carb ratio, correction factor and target live in `settings.json` in this repo. Everyone's app reads that file, but only someone holding a GitHub token for the repo can change it. Every change is a commit, so the [history of settings.json](https://github.com/kgolokototsi/diabuddy/commits/main/settings.json) records who changed what and when.

### Unlock admin on your phone (once)

1. On GitHub, go to **Settings → Developer settings → Fine-grained tokens → [Generate new token](https://github.com/settings/personal-access-tokens/new)**.
2. Fill in the form:
   - Name: `DiaBuddy admin`
   - Expiration: up to a year (set a reminder to renew it)
   - Repository access: **Only select repositories → diabuddy**
   - Permissions: **Contents → Read and write**
3. Generate the token and copy it.
4. In DiaBuddy, go to **Settings → Unlock admin**, paste the token and tap **Unlock**.

The token is stored only on that phone and is sent only to GitHub. To remove it, tap **Lock admin on this device**. If a phone is lost, delete the token on GitHub.

### What the admin can do

- **Change dose settings:**
  - carb ratio (g per unit)
  - correction factor (mmol/L per unit)
  - target BG
  - low threshold
  - max-dose warning
  - rounding
  - whether to reduce the dose when BG is below target
- **Add a family food:** a food with its carbs per serving. Everyone sees it.
- **Save a packaged product to family foods** from its detail page, after checking it against the label.

Family phones pick up changes the next time DiaBuddy is opened or brought back to the front.

## How the dose is worked out

```
food dose   = carbs ÷ carb ratio
correction  = (current BG − target BG) ÷ correction factor
total       = food dose + correction, never below 0, rounded to the nearest 0.5 U
```

- **No BG entered:** food dose only.
- **BG below target:** the correction is negative and lowers the dose. The admin can switch this off.
- **Insulin in the last 3 hours:** a positive correction is left out.
- **BG below the low threshold:** no dose is shown.
- **Dose above the max-dose warning:** an amber warning appears.

## For developers

It's a static site with no build step: plain HTML, CSS and ES modules, hosted on GitHub Pages.

| File | What it does |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | UI |
| `dose.js` | Dose maths (pure functions) |
| `foods.js` | Food search, Open Food Facts |
| `admin.js` | GitHub read/write of the shared files |
| `spring.js` | Spring animations |
| `sw.js` | Offline cache. Bump `VERSION` when you change app files. |
| `data/foods.json` | Notebook + USDA foods, built by `scripts/build-foods.mjs` |
| `data/za-products.json` | SA packaged products, built by `scripts/build-za-products.mjs` |
| `data/foods-custom.json`, `settings.json` | Edited from the admin screen |

```sh
node --test tests/*.test.mjs        # dose maths tests
python -m http.server 8765          # run locally at http://localhost:8765
```

### Rebuilding the food data

```sh
# USDA SR Legacy (public domain)
curl -LO https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip
unzip FoodData_Central_sr_legacy_food_json_2018-04.zip
node scripts/build-foods.mjs FoodData_Central_sr_legacy_food_json_2018-04.json

# Open Food Facts, South Africa (about 1.5 GB streamed, nothing large is saved)
curl -sL https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz | gunzip | node scripts/build-za-products.mjs
```

## Data sources and licences

- **Family Food Guide notebook:** the family's own values.
- **[USDA FoodData Central](https://fdc.nal.usda.gov/)**, SR Legacy: public domain.
- **[Open Food Facts](https://world.openfoodfacts.org/):** `data/za-products.json` is a derivative of the Open Food Facts database. It is available under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/), and individual contents under the Database Contents License.
