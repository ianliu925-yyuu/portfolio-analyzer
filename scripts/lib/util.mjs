// Small pure helpers shared by every parser.

const MISSING = new Set(['', '-', '--', '---', '----', 'N/A', 'NA', 'null', '除息', '除權', '除權息']);

// "1,234.50" / "+1.5" / "-0.05 " / "$12.3" / "-3.47%" -> number; placeholders -> null
export function num(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (MISSING.has(s)) return null;
  const cleaned = s.replace(/[,$%\s]/g, '');
  if (cleaned === '' || MISSING.has(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function round(x, dp = 2) {
  if (x == null || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f;
}

// Price-like values keep 4 decimals below 1 (US low-priced stocks), 2 otherwise.
export function roundPx(x) {
  if (x == null || !Number.isFinite(x)) return null;
  return Math.abs(x) >= 1 ? round(x, 2) : round(x, 4);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// ROC "1151008" (or "991231", "115/10/08") -> "2026-10-08"
export function rocDate(value) {
  const s = String(value ?? '').trim();
  let m = s.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${Number(m[1]) + 1911}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{2,3})(\d{2})(\d{2})$/);
  if (!m) return null;
  return isoDate(Number(m[1]) + 1911, Number(m[2]), Number(m[3]));
}

// ROC "11508" -> "2026-08"
export function rocYm(value) {
  const m = String(value ?? '').trim().match(/^(\d{2,3})(\d{2})$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${Number(m[1]) + 1911}-${m[2]}`;
}

// Gregorian "20261008" -> "2026-10-08"
export function gregDate(value) {
  const m = String(value ?? '').trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? isoDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

function isoDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

export const compactDate = (iso) => iso.replaceAll('-', '');

// Keys are compared with all whitespace removed and full-width brackets folded,
// so TPEx keys like " Foreign Investors ...-Total Sell" still match.
export function normKey(key) {
  return String(key).replace(/[\s　]+/g, '').replace(/（/g, '(').replace(/）/g, ')').toLowerCase();
}

// Returns get(...candidateKeys) -> first present value for a row with irregular keys.
export function keyed(row) {
  const map = new Map();
  for (const [k, v] of Object.entries(row ?? {})) map.set(normKey(k), v);
  return (...keys) => {
    for (const k of keys) {
      const v = map.get(normKey(k));
      if (v !== undefined) return v;
    }
    return undefined;
  };
}

export const clean = (s) => String(s ?? '').replace(/[\s　]+$/g, '').replace(/^[\s　]+/g, '');

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Taiwan universe: ordinary 4-digit codes and 00-prefixed ETFs/ETNs (0050, 006208, 00679B, 00400A)
export const isTwCode = (code) => /^\d{4}$/.test(code) || /^00\d{2,4}[A-Z]?$/.test(code);

export function twType(code) {
  if (/^00\d+B$/.test(code)) return 'bond_etf';
  if (/^00/.test(code)) return 'etf';
  return 'stock';
}

export const twBucket = (code) => code.slice(0, 2);
export const usBucket = (code) => code[0].toUpperCase();

export function pctChange(close, change) {
  if (close == null || change == null) return null;
  const prev = close - change;
  return prev > 0 ? round((change / prev) * 100, 2) : null;
}
