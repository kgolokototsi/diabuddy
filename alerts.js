// High-glucose alerts on this phone (Web Push). The relay decides when to alert;
// this only turns alerts on or off for this phone and sends a test.
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

// On only when this phone has a subscription and the relay has it too.
export async function alertsOn() {
  if (alertSupport() !== 'ok' || Notification.permission !== 'granted' || !(await subscription())) return false;
  return (await relayFetch(RELAY_URL, '/push')).subscribed === true;
}

// Must be called straight from a tap: iPhone only asks for permission then.
export async function turnOnAlerts() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications aren’t allowed for DiaBuddy. Allow them in the phone’s settings, then try again.');
  const { publicKey } = await relayFetch(RELAY_URL, '/push');
  const reg = await registration();
  if (!reg) throw new Error('Alerts need the app to be fully loaded. Close DiaBuddy, open it again, and try once more.');
  const sub = (await reg.pushManager.getSubscription())
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(publicKey) });
  await relayFetch(RELAY_URL, '/push', { method: 'PUT', body: sub.toJSON() });
}

export async function turnOffAlerts() {
  await relayFetch(RELAY_URL, '/push', { method: 'DELETE' });
  await (await subscription())?.unsubscribe();
}

export const sendTestAlert = () => relayFetch(RELAY_URL, '/push/test', { method: 'POST' });
