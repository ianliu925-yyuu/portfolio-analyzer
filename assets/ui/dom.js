// 介面共用小工具：DOM、HTML 範本（自動跳脫）、數字與日期格式、提示訊息。

// ---------- 小工具 ----------

export const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK = '日一二三四五六';
export const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function validDate(s) {
  if (!DATE_RE.test(String(s ?? ''))) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
export const dayLabel = (s) => (validDate(s) ? `${s}（${WEEK[new Date(`${s}T00:00:00`).getDay()]}）` : '—');
export const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
export const cardId = (key) => `card-${key.replace(/[^0-9A-Za-z]/g, '-')}`;
export const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

// HTML 範本：插入的值一律跳脫，只有 Html 物件（由 html`` 產生）原樣輸出。
class Html {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const out = (v) => (v instanceof Html ? v.s : Array.isArray(v) ? v.map(out).join('') : v == null || v === false ? '' : esc(v));
export const html = (strings, ...vals) => new Html(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? out(vals[i]) : ''), ''));
export const setHtml = (el, h) => { el.innerHTML = out(h); };
const safeUrl = (u) => {
  const s = String(u ?? '').trim();
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : null;
};
export const extLink = (url, text) => {
  const u = safeUrl(url);
  return u ? html`<a href="${u}" target="_blank" rel="noopener noreferrer">${text}</a>` : html`${text}`;
};

// ---------- 數字格式 ----------

const nfCache = new Map();
const nf = (min, max) => {
  const k = `${min}:${max}`;
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max }));
  return nfCache.get(k);
};
const MINUS = '−';
export function fmtNum(n, min = 0, max = min, { sign = false } = {}) {
  if (!isNum(n)) return '—';
  const s = nf(min, max).format(Math.abs(n));
  const zero = Number(s.replace(/,/g, '')) === 0;
  return (zero ? '' : n < 0 ? MINUS : sign ? '+' : '') + s;
}
export function fmtMoney(n, currency, { sign = false } = {}) {
  if (!isNum(n)) return '—';
  const usd = currency === 'USD';
  const s = nf(usd ? 2 : 0, usd ? 2 : 0).format(Math.abs(n));
  const zero = Number(s.replace(/,/g, '')) === 0;
  return `${zero ? '' : n < 0 ? MINUS : sign ? '+' : ''}${usd ? 'US$' : 'NT$'}${s}`;
}
export const twd = (n, o) => fmtMoney(n, 'TWD', o);
export const usd = (n, o) => fmtMoney(n, 'USD', o);
export const fmtPct = (p, d = 2) => (isNum(p) ? `${fmtNum(p, d, d, { sign: true })}%` : '—');
export const fmtFrac = (f, d = 2) => (isNum(f) ? `${fmtNum(f * 100, d, d)}%` : '—');
export const fmtPrice = (n, market) => (market === 'US' ? fmtNum(n, 2, 2) : fmtNum(n, 0, 2));
export const fmtShares = (n) => fmtNum(n, 0, 4);
export const fmtLots = (shares, o) => (isNum(shares) ? fmtNum(shares / 1000, 0, Math.abs(shares) < 10000 ? 1 : 0, o) : '—');
export const dir = (n) => (isNum(n) && n > 0 ? 'up' : isNum(n) && n < 0 ? 'down' : '');
export const ntd = (x) => (x < 1 ? fmtNum(x, 2, 2) : fmtNum(x, 1, 1));
export const shortTwd = (v) => {
  if (!isNum(v)) return '—';
  if (Math.abs(v) >= 1e8) return `NT$${fmtNum(v / 1e8, 2, 2)} 億`;
  if (Math.abs(v) >= 1e4) return `NT$${fmtNum(v / 1e4, 0, 1)} 萬`;
  return twd(v);
};
export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

export const TYPE_LABEL = { stock: '股票', etf: 'ETF', bond_etf: '債券 ETF' };
const ACTION_CLASS = { 停損: 'stop', 停損觀察: 'watch', 分批停利: 'profit', 減碼: 'reduce', 加碼: 'add', 續抱: 'hold' };
export const tag = (action) => (action ? html`<span class="tag tag-${ACTION_CLASS[action] ?? 'hold'}">${action}</span>` : '');
export const aiBadge = html`<span class="ai-badge" title="AI 分析">AI</span>`;
const US_SECTOR = {
  Technology: '科技', 'Health Care': '醫療保健', Finance: '金融', Financials: '金融', 'Consumer Discretionary': '非必需消費',
  'Consumer Staples': '必需消費', Energy: '能源', Industrials: '工業', Utilities: '公用事業', 'Real Estate': '不動產',
  Telecommunications: '電信', 'Basic Materials': '原物料', Miscellaneous: '其他',
};
export const industryLabel = (s) => (s ? US_SECTOR[s] ?? s : s);

let toastTimer;
export function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

export const MARKET_LABEL = { TW: '台股', US: '美股' };
