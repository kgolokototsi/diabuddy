// Talks to the DiaBuddy relay (worker/worker.js): glucose readings, the log, foods,
// settings and phone access. Each phone has its own key (from a single-use invite);
// it's kept in this phone's storage and sent as X-DiaBuddy-Key.

const KEY = 'diabuddy.phoneKey';
export const FRESH_MINUTES = 10;

export function getCgmKey() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function setCgmKey(key) {
  try { key ? localStorage.setItem(KEY, key.trim()) : localStorage.removeItem(KEY); } catch {}
}

// An invite link ends in #join=<code>. Take the code and strip it from the address bar
// (and from history) straight away, so it isn't left lying around.
export function consumeJoinCode() {
  const m = /(?:^#|&)join=([A-Za-z0-9_-]{16,100})/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return m[1];
}

// Accepts a pasted invite link or just the code.
export function joinCodeFrom(text) {
  const m = /(?:join=)?([A-Za-z0-9_-]{16,100})$/.exec(String(text || '').trim());
  return m ? m[1] : null;
}

export const inviteLink = (code) => `${location.origin}/#join=${code}`;

const MESSAGES = {
  bad_key: 'This phone isn’t connected any more. Ask the admin for a new invite link.',
  bad_invite: 'That invite has expired or was already used. Ask the admin for a new one.',
  rate_limited: 'Too many tries. Wait a minute and try again.',
  admin_only: 'Only the admin can do that.',
  dexcom_login_failed: 'Dexcom rejected the login saved in the relay. The admin needs to update it.',
  dexcom_unavailable: 'Dexcom isn’t answering right now.',
  dexcom_no_readings: 'Dexcom has no readings from the last 24 hours.',
  libre_login_failed: 'LibreLinkUp rejected the login saved in the relay. The admin needs to update it.',
  libre_accept_terms: 'LibreLinkUp wants its terms accepted. Sign in to the LibreLinkUp app with the DiaBuddy account and accept them.',
  libre_no_connection: 'The LibreLinkUp account isn’t following him yet. Accept the invite in the LibreLinkUp app.',
  libre_no_readings: 'Libre has no recent readings.',
  libre_unavailable: 'LibreLinkUp isn’t answering right now.',
  no_readings: 'The sensor sent no readings.',
  not_configured:'The relay is missing its sensor login or family key.',
  read_only_key: 'This device can only view the log.',
  scan_not_configured: 'Label photos aren’t switched on yet. The admin needs to add the label-reader key to the relay.',
  scan_limit: 'That’s the limit of label photos for today. Type the carbs in instead.',
  scan_bad_api_key: 'The label reader’s key was rejected. The admin needs to check it.',
  scan_busy: 'The label reader is busy. Try again in a minute.',
  scan_unavailable: 'The label reader isn’t answering. Try again, or type the carbs in.',
  bad_photo: 'That photo couldn’t be read. Try another one.',
  photo_too_large: 'That photo is too large. Try again.',
  label_refused: 'The label reader couldn’t help with this photo. Type the carbs in instead.',
  label_unreadable: 'The label couldn’t be read clearly. Try a sharper photo, straight on.',
  bad_food: 'Fill in the name, serving and carbs.',
  alerts_not_configured: 'Alerts aren’t set up on the relay yet.',
  alerts_need_invite: 'Connect this phone with an invite from the admin to get alerts.',
  bad_subscription: 'This phone’s browser gave an alert address DiaBuddy can’t use.',
  not_subscribed: 'Turn alerts on first.',
  push_failed: 'The test alert didn’t go through. Try again in a minute.',
  log_unavailable:'The log isn’t set up on the relay.',
};

export async function fetchLatest(url, key = getCgmKey(), { timeoutMs = 8000 } = {}) {
  if (url == null) throw new Error('Glucose readings are not set up.');
  if (!key) throw new Error('This phone isn’t connected yet. Ask the admin for an invite link.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/latest`, {
      headers: { 'X-DiaBuddy-Key': key },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    const history = cleanHistory(body.history);
    // Errors carry the last hour's logged readings, so the trend still shows up to the gap.
    if (!res.ok) throw Object.assign(new Error(MESSAGES[body.error] || `The relay returned ${res.status}.`), { history });
    const reading = cleanReading(body.readings?.[0]);
    if (!reading) throw Object.assign(new Error(MESSAGES.no_readings), { history });
    reading.history = history;
    return reading;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('No answer from his sensor. Check the connection.');
    if (err instanceof TypeError) throw new Error('Can’t reach the glucose relay. Check the connection.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Calls to the relay's meal & dose log (/events). Errors carry the HTTP status so
// callers can tell "offline, try later" (no status) from "rejected" (4xx).
export async function relayFetch(url, path, { method = 'GET', body, key = getCgmKey(), timeoutMs = 8000 } = {}) {
  if (url == null || !key) throw new Error('This phone isn’t connected yet. Ask the admin for an invite link.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { 'X-DiaBuddy-Key': key, ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(MESSAGES[data.error] || `The relay returned ${res.status}.`), { status: res.status });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Readings are shown on screen and can fill in a dose, so only known values get through:
// numbers stay numbers and the trend comes from a fixed list, whatever the relay sends.
const TRENDS = {
  DoubleUp: ['⇈', 'rising fast', true], SingleUp: ['↑', 'rising', false], FortyFiveUp: ['↗', 'rising slowly', false],
  Flat: ['→', 'steady', false], FortyFiveDown: ['↘', 'falling slowly', false], SingleDown: ['↓', 'falling', false],
  DoubleDown: ['⇊', 'falling fast', true],
};
function cleanReading(r) {
  const mmol = Number(r?.mmol);
  const time = Date.parse(r?.time);
  if (!Number.isFinite(mmol) || !Number.isFinite(time)) return null;
  const [arrow, trendText, fast] = TRENDS[r.trend] || ['', 'no trend', false];
  return {
    source: r.source === 'libre' ? 'libre' : 'dexcom',
    mmol,
    mgdl: Number(r.mgdl) || Math.round(mmol * 18.0182),
    low: r.low === true,
    high: r.high === true,
    trend: TRENDS[r.trend] ? r.trend : null,
    arrow,
    trendText,
    fast,
    time: new Date(time).toISOString(),
    // Worked out on this device each time it's read, so a reading kept on screen
    // (or a cached response) can't look fresher than it is.
    get ageMinutes() { return Math.max(0, Math.round((Date.now() - time) / 60000)); },
  };
}

function cleanHistory(points) {
  return (Array.isArray(points) ? points : [])
    .map((p) => ({ mmol: Number(p?.mmol), time: String(p?.time || '') }))
    .filter((p) => Number.isFinite(p.mmol) && Date.parse(p.time));
}

// Whether a reading may fill the BG field by itself.
export function usableForDose(r) {
  return Boolean(r) && !r.low && !r.high && r.ageMinutes <= FRESH_MINUTES && r.mmol > 0;
}
