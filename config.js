// The app and its relay are served from the same Cloudflare Worker, so API calls
// are same-origin ('' = this site). Nothing in here is secret.
export const RELAY_URL = '';
export const APP_VERSION = '2.0.0';
