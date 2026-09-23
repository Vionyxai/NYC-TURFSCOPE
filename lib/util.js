// Shared helpers. Zero dependencies — Node 18.17+ (global fetch).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RAW_DIR = process.env.RAW_DIR || path.join(ROOT, 'data', 'raw');
export const OUT_DIR = process.env.OUT_DIR || path.join(ROOT, 'm3-map', 'data');
export const EXPORT_DIR = process.env.EXPORT_DIR || path.join(ROOT, 'exports');

export const log = (...a) => console.log('[turfscope]', ...a);
export const warn = (...a) => console.warn('[turfscope] WARN', ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
export function readJSONIfExists(p) {
  return fs.existsSync(p) ? readJSON(p) : null;
}
export function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}
export function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
export function config(name) {
  return readJSON(path.join(ROOT, 'config', name));
}
export const raw = (name) => path.join(RAW_DIR, name);
export const out = (name) => path.join(OUT_DIR, name);

// Census uses large negative sentinels (e.g. -666666666) for "no estimate".
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
export const clamp01 = (x) => (x == null || !Number.isFinite(x) ? 0 : Math.max(0, Math.min(1, x)));
export const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function activeCounties() {
  const a = config('areas.json');
  return Object.entries(a.counties)
    .filter(([, c]) => c.phase <= a.active_phase)
    .map(([fips, c]) => ({ fips, ...c }));
}

export async function fetchWithRetry(url, opts = {}, retries = 3) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;
      const body = (await res.text()).slice(0, 300);
      const err = new Error(`HTTP ${res.status} for ${url}\n${body}`);
      err.status = res.status;
      throw err;
    } catch (e) {
      lastErr = e;
      // Client errors (except rate limiting) will not fix themselves on retry.
      if (e.status && e.status < 500 && e.status !== 429) throw e;
    }
    if (i < retries) await sleep(1000 * 2 ** i);
  }
  throw lastErr;
}
export async function fetchJSON(url, opts) {
  return (await fetchWithRetry(url, opts)).json();
}
export async function fetchText(url, opts) {
  return (await fetchWithRetry(url, opts)).text();
}

export function toCSV(rows, cols) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

// True when the calling module was run directly (node file.js), on any OS.
export const isMain = (metaUrl) => process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
