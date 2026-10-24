// localStorage 讀寫與資料清理（localStorage、匯入檔都要過）。
import { BROKERS, DEFAULT_BROKER_ID, brokersFor } from '../fees.js';
import { normalizeCode } from '../portfolio.js';
import { ACTIONS, RULES } from '../rules.js';
import { renderBanner } from '../app.js';
import { newId, todayLocal, validDate } from './dom.js';

// ---------- 儲存（localStorage 一律包 try/catch） ----------

export const KEYS = {
  tx: 'pa:v1:transactions', cash: 'pa:v1:cash', settings: 'pa:v1:settings', stops: 'pa:v1:stops',
  manual: 'pa:v1:manualPrices', ai: 'pa:v1:aiResult', aiKey: 'pa:v1:aiKey', aiModel: 'pa:v1:aiModel',
  ui: 'pa:v1:ui', theme: 'pa:theme',
};
export let storageBroken = false;
export function loadRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function saveRaw(key, value) {
  try {
    if (value == null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    if (!storageBroken) {
      storageBroken = true;
      renderBanner();
    }
    return false;
  }
}
export function load(key, fallback) {
  const raw = loadRaw(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
export const save = (key, value) => saveRaw(key, value == null ? null : JSON.stringify(value));

// ---------- 資料清理（localStorage、匯入檔都要過） ----------

const CODE_RE = /^[0-9A-Z][0-9A-Z.-]{0,11}$/;
export const CODE_PATTERN = { TW: /^\d{4,6}[A-Z]?$/, US: /^[A-Z][A-Z0-9]{0,5}([.-][A-Z0-9]{1,2})?$/ };
const KEY_RE = /^(TW|US):[0-9A-Z][0-9A-Z.-]{0,11}$/;
// 券商自訂值的合理範圍（和「設定」對話框一致）：discount 0.01～1 = 0.1～10 折。
const OVERRIDE_RANGES = {
  TW: { discount: [0.01, 1], minFee: [0, 1000], oddLotMinFee: [0, 1000] },
  US: { rate: [0, 0.05], perShare: [0, 1], minFee: [0, 100], maxPct: [0, 1], etfFlat: [0, 100] },
};

export const SIDES = ['buy', 'sell', 'dividend', 'split'];
export const SIDE_LABEL = { buy: '買進', sell: '賣出', dividend: '股利', split: '分割' };

// strict（匯入用）：再套用新增交易表單的規則：代號格式、台股整數股、股數上限、日期不晚於今天。
export function sanitizeTx(t, { strict = false } = {}) {
  if (!t || typeof t !== 'object') return null;
  const market = t.market === 'TW' || t.market === 'US' ? t.market : null;
  const code = normalizeCode(t.code);
  const side = SIDES.includes(t.side) ? t.side : null;
  const date = String(t.date ?? '');
  const id = typeof t.id === 'string' && t.id.trim() ? t.id.trim().slice(0, 64) : newId();
  if (side === 'dividend' || side === 'split') {
    // 股利、分割沒有股數價位與費用；amount＝實收股利（原幣），ratio＝1 股變幾股
    const v = Number(side === 'dividend' ? t.amount : t.ratio);
    if (!market || !CODE_RE.test(code) || !(v > 0) || !Number.isFinite(v) || (side === 'split' && v === 1) ||
      !validDate(date)) return null;
    if (strict && (!CODE_PATTERN[market].test(code) || v > 1e12 || date > todayLocal())) return null;
    return { id, market, code, side, date, ...(side === 'dividend' ? { amount: v } : { ratio: v }) };
  }
  const shares = Number(t.shares);
  const price = Number(t.price);
  if (!market || !CODE_RE.test(code) || !side || !(shares > 0) || !Number.isFinite(shares) ||
    !(price >= 0) || !Number.isFinite(price) || !validDate(date)) return null;
  if (strict && (!CODE_PATTERN[market].test(code) || (market === 'TW' && !Number.isInteger(shares)) || shares > 1e9 ||
    date > todayLocal())) return null;
  const nonNeg = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const feeIncluded = t.feeIncluded === true;
  const broker = brokersFor(market).some((b) => b.id === t.broker) ? t.broker : DEFAULT_BROKER_ID[market];
  return {
    id,
    market, code, side, shares, price, date, feeIncluded,
    fee: feeIncluded ? 0 : nonNeg(t.fee),
    tax: feeIncluded ? 0 : nonNeg(t.tax),
    regFee: feeIncluded ? 0 : nonNeg(t.regFee),
    broker,
  };
}
export function sanitizeTxList(list, opts) {
  const seen = new Set();
  const txs = [];
  const bad = [];
  (Array.isArray(list) ? list : []).slice(0, 10000).forEach((t, i) => {
    const v = sanitizeTx(t, opts);
    if (!v) { bad.push(i + 1); return; }
    if (seen.has(v.id)) v.id = newId();
    seen.add(v.id);
    txs.push(v);
  });
  return { txs, bad };
}
export function sanitizePriceMap(o) {
  const res = {};
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) if (KEY_RE.test(k) && Number(v) > 0 && Number.isFinite(Number(v))) res[k] = Number(v);
  }
  return res;
}
function sanitizeOverrides(o) {
  const res = {};
  if (!o || typeof o !== 'object') return res;
  for (const [id, v] of Object.entries(o)) {
    const b = BROKERS.find((x) => x.id === id);
    if (!b || !v || typeof v !== 'object') continue;
    const clean = {};
    for (const [f, [lo, hi]] of Object.entries(OVERRIDE_RANGES[b.market] ?? {})) {
      const n = typeof v[f] === 'number' || (typeof v[f] === 'string' && v[f].trim() !== '') ? Number(v[f]) : NaN;
      if (Number.isFinite(n) && n >= lo && n <= hi) clean[f] = n;
    }
    if (Object.keys(clean).length) res[id] = clean;
  }
  return res;
}
export function sanitizeSettings(s) {
  const res = { twBroker: DEFAULT_BROKER_ID.TW, usBroker: DEFAULT_BROKER_ID.US, stopPct: RULES.stopPct, brokerOverrides: {} };
  if (!s || typeof s !== 'object') return res;
  if (brokersFor('TW').some((b) => b.id === s.twBroker)) res.twBroker = s.twBroker;
  if (brokersFor('US').some((b) => b.id === s.usBroker)) res.usBroker = s.usBroker;
  if (Number(s.stopPct) >= 0.01 && Number(s.stopPct) <= 0.5) res.stopPct = Number(s.stopPct);
  res.brokerOverrides = sanitizeOverrides(s.brokerOverrides);
  return res;
}
export function sanitizeCash(c) {
  const v = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
  return { twd: v(c?.twd), usd: v(c?.usd) };
}
const strArr = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
export function sanitizeAi(a) {
  if (!a || typeof a !== 'object' || !a.stocks || typeof a.stocks !== 'object') return null;
  const stocks = {};
  for (const [k, s] of Object.entries(a.stocks)) {
    if (!KEY_RE.test(k) || !s || typeof s !== 'object') continue;
    stocks[k] = {
      code: String(s.code ?? ''), action: ACTIONS.includes(s.action) ? s.action : null,
      summary: String(s.summary ?? ''), reasons: strArr(s.reasons), trigger: String(s.trigger ?? ''),
      bull: strArr(s.bull), bear: strArr(s.bear), watch: strArr(s.watch),
    };
  }
  const news = {};
  if (a.news && typeof a.news === 'object') {
    for (const [k, list] of Object.entries(a.news)) {
      if (KEY_RE.test(k) && Array.isArray(list)) {
        news[k] = list.filter((n) => n && typeof n.title === 'string').slice(0, 5)
          .map((n) => ({ title: n.title, link: String(n.link ?? ''), source: String(n.source ?? ''), pubDate: String(n.pubDate ?? '') }));
      }
    }
  }
  return {
    date: validDate(a.date) ? a.date : '',
    at: String(a.at ?? ''),
    model: String(a.model ?? ''),
    served: String(a.served ?? ''),
    stocks,
    portfolio: { risks: strArr(a.portfolio?.risks), advice: strArr(a.portfolio?.advice) },
    cost: a.cost && typeof a.cost === 'object' ? {
      usd: Number(a.cost.usd) || 0, inputTokens: Number(a.cost.inputTokens) || 0, outputTokens: Number(a.cost.outputTokens) || 0,
    } : null,
    news,
    newsOk: Number(a.newsOk) || 0,
    keys: strArr(a.keys),
  };
}
