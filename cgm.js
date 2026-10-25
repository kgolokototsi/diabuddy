// Live Dexcom readings via the DiaBuddy relay (worker/worker.js).
// The relay URL is shared in settings.json; the family key is kept per device
// and arrives either pasted or through a family link ending in #cgm=<key>.

const KEY = 'diabuddy.cgmKey';
export const FRESH_MINUTES = 10;

export function getCgmKey() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function setCgmKey(key) {
  try { key ? localStorage.setItem(KEY, key.trim()) : localStorage.removeItem(KEY); } catch {}
}

// Store a key from a family link and strip it from the address bar.
export function consumeLinkKey() {
  const m = /(?:^#|&)cgm=([A-Za-z0-9_-]{16,})/.exec(location.hash);
  if (!m) return false;
  setCgmKey(m[1]);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

export function generateKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function familyLink(key) {
  return `${location.origin}${location.pathname}#cgm=${key}`;
}

const MESSAGES = {
  bad_key: 'The family key doesn’t match the relay. Ask the admin for a new family link.',
  dexcom_login_failed: 'Dexcom rejected the login saved in the relay. The admin needs to update it.',
  dexcom_unavailable: 'Dexcom isn’t answering right now.',
  no_readings: 'Dexcom has no readings from the last 24 hours.',
  not_configured: 'The relay is missing its Dexcom login or family key.',
};

export async function fetchLatest(url, key = getCgmKey(), { timeoutMs = 8000 } = {}) {
  if (!url) throw new Error('Dexcom readings are not set up.');
  if (!key) throw new Error('This device needs the family key.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/latest`, {
      headers: { 'X-DiaBuddy-Key': key },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(MESSAGES[body.error] || `The relay returned ${res.status}.`);
    const reading = body.readings?.[0];
    if (!reading) throw new Error(MESSAGES.no_readings);
    // Recompute age on this device so a cached response can't look fresher than it is.
    reading.ageMinutes = Math.max(0, Math.round((Date.now() - Date.parse(reading.time)) / 60000));
    return reading;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('No answer from Dexcom. Check the connection.');
    if (err instanceof TypeError) throw new Error('Can’t reach the Dexcom relay. Check the connection.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Whether a reading may fill the BG field by itself.
export function usableForDose(r) {
  return Boolean(r) && !r.low && !r.high && r.ageMinutes <= FRESH_MINUTES && r.mmol > 0;
}
