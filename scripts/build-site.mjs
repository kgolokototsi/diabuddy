// Builds dist/: only the files the app needs, plus the security headers.
// Nothing from worker/, tests/, scripts/ or node_modules is ever published.
//
//   node scripts/build-site.mjs     (then: cd worker && npx wrangler deploy)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const FILES = [
  'index.html', 'styles.css', 'manifest.webmanifest', 'sw.js',
  'app.js', 'dose.js', 'foods.js', 'spring.js', 'config.js', 'cgm.js', 'alerts.js',
  'data/foods.json', 'data/za-products.json', 'data/foods-custom.json',
];
const DIRS = ['fonts', 'icons'];

// Real HTTP headers for the app (Workers static assets read dist/_headers).
// 'unsafe-inline' styles: the templates set a few inline style="" attributes; scripts stay strict.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://world.openfoodfacts.org",
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const HEADERS = `/*
  Content-Security-Policy: ${CSP}
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()
  Strict-Transport-Security: max-age=31536000
  Cross-Origin-Opener-Policy: same-origin
  X-Frame-Options: DENY

/sw.js
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache
`;

fs.rmSync(dist, { recursive: true, force: true });
for (const f of FILES) {
  const to = path.join(dist, f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, f), to);
}
for (const d of DIRS) fs.cpSync(path.join(root, d), path.join(dist, d), { recursive: true });
fs.writeFileSync(path.join(dist, '_headers'), HEADERS);

const count = fs.readdirSync(dist, { recursive: true }).filter((f) => fs.statSync(path.join(dist, f)).isFile()).length;
console.log(`dist/ ready: ${count} files`);
