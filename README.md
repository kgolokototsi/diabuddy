# DiaBuddy Carb Counter

A carb counter and insulin dose calculator for the family. Pick what he's eating, enter his blood glucose, and DiaBuddy shows the dose and how it was worked out.

**Address:** https://diabuddy-dexcom.diabuddy-dexcom.workers.dev

Each phone joins with its own invite link from the admin. How DiaBuddy protects his data is described in [SECURITY.md](SECURITY.md). What's planned next is in [ROADMAP.md](ROADMAP.md).

> DiaBuddy is a calculator, not medical advice. Always follow his diabetes team's plan and use your own judgement.

## For the family

1. **Join.** Open the invite link the admin sent you. Give your phone a name ("Gran's iPhone") and tap **Connect**. An invite works once and expires after 24 hours.
   - **iPhone:** a Home Screen app keeps its own storage, separate from Safari. Add DiaBuddy to your Home Screen first (Safari → Share → *Add to Home Screen*), open it from the icon, then go to Settings → **Connect this phone** and paste the invite. If you open the invite in Safari, DiaBuddy offers to copy it for you.
   - **Android:** open the invite in Chrome, connect, then Chrome → ⋮ → *Add to Home screen*.
2. **Home** has two big choices:
   - **Meal dose:** opens **Foods**, the one place for every food. His usual foods are listed first. Tap each food he's eating; each tap adds one serving.
   - **Correction:** for a high BG when he isn't eating. Enter his BG and you get the correction.
3. Open the meal tray at the bottom of Foods to change amounts: use − / + for half servings, or tap a food to enter grams.
4. Tap **Work out dose** and enter his BG in mmol/L. The dose is rounded to the nearest 0.5 unit.

Other things you can do:

- **Carbs from a label:** type the carbs from a packet, either the total or per 100 g plus the grams eaten.
- **Barcode:** find a packaged product by its barcode. On Android you can scan with the camera.
- **Meal in progress:** if you leave Foods partway through a meal, Home shows it so you can carry on.
- **Insulin in the last 3 hours:** switch this on if he's had insulin recently. DiaBuddy then leaves out the high-BG correction so doses don't stack.
- If his BG is **below 4.0**, DiaBuddy won't show a dose. Treat the low first.
- **Disconnect this phone** (Settings) removes his data from the phone, e.g. before you hand it on.
- **Alerts** (Settings → Alerts), each switched on per phone:
  - **High for over 2.5 hours:** when he has been 14 mmol/L or higher for 2.5 hours, *"Glucose reading High for over 2.5 hours. Consider a correction dosage."* One alert per high spell.
  - **Falling fast:** when he drops 3 mmol/L or more in 15 minutes and is below 10, so you can get ready for a possible low. From 21:00 to 06:00 the alert also says he may be lying on his sensor, which can show a false drop. At most one alert an hour.
  - On iPhone, alerts only work from the Home Screen icon. They add to the Dexcom and Libre alarms; they don't replace them.

### School lunch

The **School** tab (Admin and Family phones) is where you plan today's school lunch, and where his teacher's phone gets it with the dose.

- **Plan today's lunch:** tap **Plan today's lunch** and search the foods list (the same foods and SA packaged products as the Foods tab), with − / + for half servings, or type in an item that isn't listed. You can also build it in Foods and use **Add to today's school lunch** on the meal tray. Add a note for his teacher if you like. You can change or remove it until its dose is recorded.
- **His teacher's phone:** invite it with **School** access (Settings → Phones → Invite a phone). It shows one screen:
  - his reading and trend
  - today's lunch, with **All · ¾ · ½ · ¼ · None** for each item
  - the dose, worked out as at home (food plus a correction from his BG), with the low warning and 15 g treatment
  - **Record as given**, and his alerts if switched on

  It can't see his log, Insights, settings or the food list.
- **When it's recorded:** the dose goes into his log at home, so insulin on board, alerts and Insights all count it. The School tab shows "Given at 12:10 · 2.5 U".
  - **Double doses:** recording a second dose for the same lunch needs a confirmation that another dose was really given.
  - **Undo:** his teacher can undo their own entry for 15 minutes; you can undo it at any time from the School tab.
- **You can dose at school too:** the School tab's Today card works the same way, for example if you're there at lunch.

### Insights

The **Insights** tab shows what his own history says. It never works out or suggests a dose.

- **Next hour** (also dotted on the Home chart): his own forecast for 30 minutes and 1 hour ahead, with its usual range. It's a small model refitted each night from his readings, insulin on board and carbs on board, with the rule that insulin can only lower it and carbs can only raise it. It's tested on his most recent days and only shown if it beats assuming his BG stays the same; Insights shows how accurate it has been. If the low end of the range is below 4, Home says to check him.
- **Low risk now:** from his current level and trend, how often he went low within 45 minutes in similar moments.
- **Forecasts:** for a **meal** (from the meal in progress or typed carbs), a **low treatment** (15 g, the 15-15 rule: where he usually is at the 15-minute recheck and how often a second 15 g was needed) and a **correction** (where he usually is 3 hours later). Each shows a range from his most similar past ones, and how many it's based on.
- **Time of day** and **After meals:** time in range by part of the day, and whether meals of each kind usually end high or low 3 hours later.
- **This week:** a short summary written by Claude from the week's percentages and averages.

It learns from the log, so **record doses and low treatments** ("Record as given", "Record 15 g low treatment"). Forecasts start after about 10 meals with full readings. The relay builds Insights each night.

### The food badges

| Badge | Meaning |
| --- | --- |
| Notebook | From the handwritten Food Guide. The family has already checked these. |
| Family | Added by the family (label photos, home recipes). |
| USDA | From USDA FoodData Central, net carbs (fibre removed). |
| Check label | Packaged SA products from Open Food Facts. These are entered by the public, so compare with the packet. |

## For the admin

An admin phone sees an extra **Admin** section in Settings:

- **Change dose settings:**
  - carb ratio (g per unit)
  - correction factor (mmol/L per unit)
  - target BG
  - low threshold
  - max-dose warning
  - rounding
  - whether to reduce the dose when BG is below target

  They're stored privately in the relay, not in the code repo. Family phones pick up changes the next time DiaBuddy is opened or brought back to the front.
- **Settings change history:** every change, with who made it.
- **Phones:** everyone who can see his readings, with their access and when they were last used.
  - **Invite a phone:** choose who it's for and the access (Family, View only for a TV, School for his teacher, or Admin), then share the link privately. It works once, for 24 hours.
  - **Remove** a phone: it stops working straight away. Do this for a lost phone, or for someone who no longer cares for him.
  - **Turn off the old shared link:** shown until you do it. Once every phone has joined with an invite, this ends the old `#cgm=` family link.
- **Delete his stored data:** readings, log and/or settings history, for example on a POPIA request.

## Glucose readings (Dexcom)

DiaBuddy can show his latest Dexcom reading and fill in the BG on the dose screen. The relay (`worker/worker.js`, on your free Cloudflare account) logs into **Dexcom Share** and passes on only the latest reading. His Dexcom password is stored as an encrypted Cloudflare secret and never reaches a phone or GitHub.

How the readings are used:

| Reading | What DiaBuddy does |
| --- | --- |
| 10 minutes old or newer | Fills in the BG field and shows the trend arrow and age. You can always type over it. |
| Older than 10 minutes | Shows it but doesn't use it. Do a finger-prick or check the Dexcom app. |
| LOW or HIGH | Doesn't use it. Do a finger-prick. |
| Rising or falling fast (⇈ ⇊) | Fills it in, with a warning to double-check before giving insulin. |

> Dexcom Share is the service behind the Dexcom follow feature. Dexcom doesn't officially support other apps using it, so it can stop working without warning. If it does, the app says so and you type the BG as before.

### Set it up (admin, once)

1. In his **Dexcom app**, turn on Share and make sure at least one follower is invited. Share only works with a follower.
2. In a terminal, type each command exactly as written, then type the value when it asks **"Enter a secret value"**:
   ```powershell
   cd diabuddy\worker
   node node_modules\wrangler\bin\wrangler.js secret put DEXCOM_USERNAME
   node node_modules\wrangler\bin\wrangler.js secret put DEXCOM_PASSWORD
   ```
   Enter his Dexcom username or email (the one his Dexcom app signs in with), then that account's password.

If his Dexcom password changes, run the `DEXCOM_PASSWORD` command again.

## Libre 2 readings

When he wears a Libre 2 scanned with the **FreeStyle LibreLink phone app**, the same relay can read it through **LibreLinkUp** (Libre's follow service). If both Libre and Dexcom are set up, DiaBuddy uses whichever reading is newest and shows where it came from ("Libre · 1 min ago"). The same rules apply as for Dexcom: only readings 10 minutes old or newer fill in the BG.

Libre works with a **follower** account, so his own LibreView password is never stored:

1. **Make a follower account.** Install **LibreLinkUp** on your phone and create a new account with an email used only for this, for example `yourname+diabuddy@gmail.com`.
2. **Invite it.** In his **FreeStyle LibreLink** app, go to Menu → **Connected Apps** → **LibreLinkUp** → **Add connection**, and enter that email.
3. **Accept the invite** in LibreLinkUp, and accept any terms it shows. The relay can't read anything until the invite and terms are accepted.
4. **Give the relay the follower login.** In a terminal, type each command exactly as written, then type the value when it asks **"Enter a secret value"**:
   ```powershell
   cd diabuddyworker
   node node_moduleswranglerinwrangler.js secret put LIBRE_EMAIL
   node node_moduleswranglerinwrangler.js secret put LIBRE_PASSWORD
   ```
5. Open DiaBuddy. Home should show his Libre reading.

If LibreLinkUp later asks the follower account to accept new terms, readings stop and DiaBuddy says so. Sign in to LibreLinkUp with that account and accept them.

> LibreLinkUp, like Dexcom Share, isn't officially offered for other apps to use, so it can stop working without warning. If it does, the app says so and you type the BG as before.

## Photo of a label

On **Foods**, tap **Photo of label** and take a picture of the nutrition table on a packet. DiaBuddy reads the carbohydrate per 100 g and the label's serving, then shows them next to your photo for checking. Fix anything that doesn't match the packet.

Then set **his serving**, since the label's serving often isn't what he eats:
- **Label serving:** as printed on the packet.
- **Weigh it:** the grams he has.
- **Count pieces:** e.g. 3 biscuits. The weight of one piece is worked out from the label, and you can change it.

The carbs update as you type. Then tap one of:
- **Save to family foods:** every family phone gets it.
- **Use for this meal only:** it's added to this meal and not saved.

The relay reads the label with Claude (Anthropic's AI), using the family relay. It only copies printed numbers. If something isn't legible it leaves the field empty rather than guessing. It also takes fibre off US-style "total carbohydrate" labels, so the numbers match DiaBuddy's net carbs.

**Set-up (admin, once):** create an API key at https://console.anthropic.com → **API Keys**, then add it to the relay as a secret:
```powershell
cd diabuddyworker
node node_moduleswranglerinwrangler.js secret put ANTHROPIC_API_KEY
```
Each photo costs about 2–4 US cents (Claude Opus 5.5). The relay allows 3 photos a minute per phone and 60 a day overall, so the bill stays small even if a phone is misused.

## His log

After **Work out dose**, the **Did you give it?** step records what he actually had:
- the foods and carbs
- his BG, and whether it came from Libre, Dexcom or was typed in
- the dose DiaBuddy worked out, and the units you actually gave (change the number if you gave a different amount)

When his BG is low, you can record what he ate to treat it, with no insulin.

- Entries are shared by every family phone and appear under **Today** on Home. Tap one to see it or delete it, and every save has **Undo**.
- With no signal, entries wait on the phone and send automatically later.
- The relay also keeps every glucose reading for 120 days and log entries for a year, stored in your Cloudflare account. Together they're the record we'll use to see how he responds to different meals.

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

Plain HTML, CSS and ES modules with no front-end build step. The app and the relay run in one Cloudflare Worker: the app is served as static assets from `dist/`, and the API is handled by `worker/worker.js`.

| File | What it does |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | UI |
| `dose.js` | Dose maths (pure functions) |
| `foods.js` | Food search, Open Food Facts |
| `spring.js` | Spring animations |
| `cgm.js` | Talks to the relay: readings, log, foods, settings, phone key |
| `config.js` | Relay address (same origin) and app version |
| `sw.js` | Offline cache for app files only (never API responses). Bump `VERSION` when you change app files. |
| `worker/worker.js` | Relay: API routes, Dexcom/Libre, log, foods, label photos, rate limits |
| `worker/auth.js` | Invites, per-phone keys (stored hashed), roles |
| `worker/settings.js` | Dose settings and their history |
| `worker/events.js` | Meal & dose log entries (shared by the log and school routes) |
| `worker/school.js` | School lunches: planning, the teacher's view, recording the dose |
| `worker/label.js` | Reads label photos with Claude |
| `scripts/build-site.mjs` | Copies only the app files into `dist/` and writes the security headers |
| `data/foods.json` | Notebook + USDA foods, built by `scripts/build-foods.mjs` |
| `data/za-products.json` | SA packaged products, built by `scripts/build-za-products.mjs` |
| `data/foods-custom.json` | Older family foods (read-only; new ones live in the relay) |

```sh
node --test tests/*.test.mjs        # dose maths, relay and access tests
cd worker && npm run deploy         # build dist/ and deploy app + relay
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
