// Pure insulin dose maths. No DOM, no storage – unit-tested in tests/dose.test.mjs.
//
//   food dose  = carbs ÷ insulin-to-carb ratio (ICR, grams covered by 1 unit)
//   correction = (current BG − target BG) ÷ correction factor (CF, mmol/L dropped by 1 unit)
//   total      = max(0, food dose + correction), rounded to the pen's step

export const BG_MIN = 1.0;
export const BG_MAX = 33.3; // most meters read "HI" above this

// Round to the nearest step (0.5 for a half-unit pen). The epsilon keeps
// values like 2.2499999 from floating-point noise rounding the wrong way.
export function roundToStep(value, step = 0.5) {
  if (!(step > 0)) return value;
  return Math.round(value / step + 1e-9) * step;
}

export function isConfigured(settings) {
  return Boolean(settings) && settings.icr > 0 && settings.cf > 0 && settings.targetBg > 0;
}

export function parseBg(text) {
  if (text == null) return null;
  const s = String(text).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * @param {object} input
 * @param {number} input.carbs          total net carbs in grams
 * @param {number|null} input.bg        current blood glucose (mmol/L), null if not entered
 * @param {boolean} input.recentInsulin insulin given in the last ~3 h
 * @param {object} input.settings       { icr, cf, targetBg, roundTo, maxDose, hypoThreshold, negativeCorrection }
 */
export function calculateDose({ carbs, bg = null, recentInsulin = false, settings }) {
  if (!isConfigured(settings)) return { status: 'not-configured' };

  const step = settings.roundTo > 0 ? settings.roundTo : 0.5;
  const hypoThreshold = settings.hypoThreshold > 0 ? settings.hypoThreshold : 4.0;
  const safeCarbs = Math.max(0, Number(carbs) || 0);

  if (bg != null && (Number.isNaN(bg) || bg < BG_MIN || bg > BG_MAX)) {
    return { status: 'invalid-bg' };
  }
  if (bg != null && bg < hypoThreshold) {
    return { status: 'hypo', bg, hypoThreshold };
  }

  const foodDose = safeCarbs / settings.icr;

  let correction = 0;
  let correctionNote = null;
  if (bg == null) {
    correctionNote = 'no-bg';
  } else {
    const raw = (bg - settings.targetBg) / settings.cf;
    if (raw > 0 && recentInsulin) {
      // Don't stack a correction on insulin that is still working.
      correctionNote = 'skipped-recent';
    } else if (raw < 0 && settings.negativeCorrection === false) {
      correctionNote = 'negative-off';
    } else {
      correction = raw;
    }
  }

  const exact = Math.max(0, foodDose + correction);
  const rounded = Math.max(0, roundToStep(exact, step));
  const maxDose = settings.maxDose > 0 ? settings.maxDose : null;

  return {
    status: 'ok',
    carbs: safeCarbs,
    bg,
    foodDose,
    correction,
    correctionNote,
    exact,
    rounded,
    step,
    overMax: maxDose != null && rounded > maxDose,
    maxDose,
  };
}

// Net carbs for one meal line. `servings` is a multiplier of the food's serving.
export function lineCarbs(food, servings) {
  if (!food || food.free) return 0;
  return Math.max(0, (Number(food.netCarbs) || 0) * (Number(servings) || 0));
}
