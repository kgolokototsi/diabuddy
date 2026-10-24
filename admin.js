// Shared JSON files (settings.json, data/foods-custom.json) are stored in the GitHub repo.
// Everyone reads them; only someone with a token that can push to the repo can write.
// The token stays in this device's localStorage and is only ever sent to api.github.com.

import { REPO } from './config.js';

const TOKEN_KEY = 'diabuddy.token';
const API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/contents/`;

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

function setToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch {}
}

export const isAdmin = () => Boolean(getToken());

function headers(token = getToken(), accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Read the latest committed JSON straight from the API (no GitHub Pages cache lag),
// falling back to the copy served alongside the app.
export async function readShared(path) {
  try {
    const res = await fetch(`${API}${path}?ref=${REPO.branch}&t=${Date.now()}`, {
      headers: headers(getToken(), 'application/vnd.github.raw+json'),
      cache: 'no-store',
    });
    if (res.ok) return { data: await res.json(), from: 'github' };
  } catch {}
  const res = await fetch(`./${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load ${path}`);
  return { data: await res.json(), from: 'pages' };
}

// Check a pasted token can push to this repo before keeping it.
export async function unlock(token) {
  token = token.trim();
  const res = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}`, { headers: headers(token) });
  if (res.status === 401) throw new Error('That token was not accepted by GitHub.');
  if (res.status === 404) throw new Error('This token cannot see the diabuddy repo. Give it access to that repository.');
  if (!res.ok) throw new Error(`GitHub said ${res.status}. Try again.`);
  const repo = await res.json();
  if (!repo.permissions?.push) throw new Error('This token can read but not write. Give it "Contents: Read and write".');
  setToken(token);
}

export function lock() {
  setToken('');
}

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

// Commit a JSON file. Fetches the current sha first so we never overwrite blindly;
// if someone else saved in between, GitHub returns 409 and we surface it.
export async function writeShared(path, data, message) {
  const token = getToken();
  if (!token) throw new Error('Unlock admin first.');
  const meta = await fetch(`${API}${path}?ref=${REPO.branch}`, { headers: headers(token), cache: 'no-store' });
  if (!meta.ok && meta.status !== 404) throw new Error(`Could not read ${path} (${meta.status}).`);
  const sha = meta.ok ? (await meta.json()).sha : undefined;

  const res = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: toBase64(JSON.stringify(data, null, 1) + '\n'),
      branch: REPO.branch,
      ...(sha && { sha }),
    }),
  });
  if (res.status === 409 || res.status === 422) throw new Error('Someone else just saved. Reload and try again.');
  if (res.status === 401 || res.status === 403) throw new Error('GitHub refused the save. The token may have expired.');
  if (!res.ok) throw new Error(`Save failed (${res.status}).`);
  return res.json();
}
