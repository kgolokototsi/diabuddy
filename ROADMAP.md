# DiaBuddy roadmap

What's planned next. Done work lives in the README and Git history.

## Forecasts

### Step 1: personal linear forecast (live since 5 November 2026)

His own 30/60-minute forecast, refitted each night (`worker/model.js`, `forecast.js`). It's shown only when it beats "BG stays the same" on his most recent days.

**Nothing to do here:**
- **4 November:** the first day of minute-by-minute readings.
- **About 7 days of readings:** first fit and test.
- **After that:** the forecast appears on Home and Insights, if it passes.

### Step 2: small neural network (when there are 4–8 weeks of his data)

**Goal:** a more accurate forecast at 1 hour, where the linear model is weakest. In the Imperial study (Zhu et al., FCNN, OhioT1DM adults), a recurrent network averaged 1.7 mmol/L error at 60 minutes, against 2.0 for a classic method (ARIMA). At 30 minutes the gap was small: 1.0 vs 1.1.

**Start when all of these are true:**
- **His data:** at least 4 weeks of readings with a full day each, ideally 8.
- **The log:** doses and low treatments recorded for most meals.
- **Room to improve:** Step 1 is live, and its 1-hour error is noticeably worse than its 30-minute error.

**Plan:**
1. **Export:** an admin-only download of his training rows (the `fcrows` format, plus 3 hours of history per row). A script on the admin's PC fetches it; nothing goes to a third party.
2. **Train:** on the PC (Python, `scripts/train-gru.py`).
   - **Model:** one small GRU layer (16–32 units) with a dense output for the 30- and 60-minute change, plus a range: the 10th and 90th percentiles, or an evidential output as in FCNN.
   - **Inputs:** the same as Step 1 (BG, recent changes, insulin on board, carbs on board, time of day as sin/cos), over the last 3 hours at 5-minute steps.
   - **Split by time:** train on older days and test on the newest, as Step 1 does.
3. **Physiology rule:** insulin must not raise the forecast, nor carbs lower it. Check this on synthetic "what-if" inputs, and reject a model that breaks it. The FCNN paper reports this failure in its own network.
4. **Run it in the app:** export the weights to JSON, and write a GRU forward pass in plain JavaScript (about 100 lines). No ML library and no outside scripts, so the CSP stays `script-src 'self'`. The paper's on-phone version took 4 ms per forecast; ours should be similar.
5. **Switch only if it wins:** compare on the same held-out days as Step 1, in mmol/L at 30 and 60 minutes, and on low warnings caught vs false warnings. Insights shows which model is in use and its accuracy.
6. **Retrain:** monthly, by the admin. The model is a static file shipped with the app; the relay doesn't train it.

**Not planned:**
- **Pre-training on other people's data** (meta-learning, as in both papers). The public datasets are adults and need data-use agreements, so they don't fit a 6-year-old. We'd reconsider only if a paediatric dataset becomes available.
- **Sending his readings to an outside ML service.**

## Security and set-up

- **Retire the old shared link:**
  1. Once every phone has joined with its own invite, Settings → Phones → **Turn off the old shared link**.
  2. Then delete the `FAMILY_KEY` and `TV_KEY` secrets. The TV app still uses `TV_KEY`: give it its own invite first, or keep that key.
- **Make the GitHub repo private.** This also turns off the old github.io copy of the app.
- **Scoped Cloudflare token:** replace this PC's Wrangler login with a token that can only edit Workers scripts and KV.
- **Dexcom readings:** set `DEXCOM_USERNAME` and `DEXCOM_PASSWORD` (after changing his Dexcom password).

## Watch

- **Relay CPU:** each 2-minute run uses 7–16 ms, against the free plan's ~10 ms limit. If runs start failing (`wrangler tail` shows errors), move to Workers Paid ($5 a month).
