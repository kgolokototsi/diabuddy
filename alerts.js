// Alerts on this phone (Web Push): high for 2.5 hours, and falling fast. The relay decides
// when to alert; this only chooses which alerts this phone gets and sends a test.
import { RELAY_URL } from './config.js';
import { relayFetch } from './cgm.js';

const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

// 'ok', 'home-screen' (iPhone: only from the Home Screen icon), 'blocked' or 'unsupported'.
export function alertSupport() {
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !standalone) return 'home-screen';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return 'ok';
}

// No registration means no alerts (e.g. a plain-http test copy of the app).
const registration = () => navigator.serviceWorker.getRegistration();
const subscription = async () => (await registration())?.pushManager.getSubscription();

// The alerts this phone gets ('high', 'fall'): only those the relay has for this phone's
// subscription, and none if the browser's side is gone.
export async function alertTypes() {
  if (alertSupport() !== 'ok' || Notification.permission !== 'granted' || !(await subscription())) return [];
  const res = await relayFetch(RELAY_URL, '/push');
  return res.subscribed ? res.types || ['high'] : [];
}

// Choose which alerts this phone gets; none turns alerts off.
// Must be called straight from a tap: iPhone only asks for permission then.
export async function setAlertTypes(types) {
  if (!types.length) return turnOffAlerts();
  return turnOnAlerts(types);
}

async function turnOnAlerts(types) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications aren’t allowed for DiaBuddy. Allow them in the phone’s settings, then try again.');
  const { publicKey } = await relayFetch(RELAY_URL, '/push');
  const reg = await registration();
  if (!reg) throw new Error('Alerts need the app to be fully loaded. Close DiaBuddy, open it again, and try once more.');
  const sub = (await reg.pushManager.getSubscription())
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(publicKey) });
  await relayFetch(RELAY_URL, '/push', { method: 'PUT', body: { ...sub.toJSON(), types } });
}

async function turnOffAlerts() {
  await relayFetch(RELAY_URL, '/push', { method: 'DELETE' });
  await (await subscription())?.unsubscribe();
}

export const sendTestAlert = () => relayFetch(RELAY_URL, '/push/test', { method: 'POST' });
