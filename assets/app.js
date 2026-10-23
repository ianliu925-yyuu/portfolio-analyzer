// 持倉分析：介面與狀態。計算交給 fees.js／portfolio.js／rules.js；這裡負責資料流、畫面與 localStorage。
import {
  BROKERS, DEFAULT_BROKER_ID, FEE_SOURCES, FEES_AS_OF, BOND_ETF_EXEMPT_UNTIL,
  brokersFor, getBroker, inferTwType, tradeCosts,
} from './fees.js';
import { buildHoldings, valueHolding, summarize, holdingKey, normalizeCode, sessionPosition, realizedByYear } from './portfolio.js';
import { RULES, ACTIONS, analyzeHolding, analyzePortfolio, industryPeFor, levels } from './rules.js';
import { loadMeta, loadIndex, loadRecords, searchIndex, findInIndex, hasFailedBuckets } from './data.js';
import { MODELS, DEFAULT_MODEL, modelInfo, buildPayload, estimateCost, runAnalysis } from './ai.js';
import { fetchStockNews } from './news.js';
import { dataFreshness } from './freshness.js';

// ---------- 小工具 ----------

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK = '日一二三四五六';
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function validDate(s) {
  if (!DATE_RE.test(String(s ?? ''))) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const dayLabel = (s) => (validDate(s) ? `${s}（${WEEK[new Date(`${s}T00:00:00`).getDay()]}）` : '—');
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
const cardId = (key) => `card-${key.replace(/[^0-9A-Za-z]/g, '-')}`;
const debounce = (fn, ms) => {
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
const html = (strings, ...vals) => new Html(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? out(vals[i]) : ''), ''));
const setHtml = (el, h) => { el.innerHTML = out(h); };
const safeUrl = (u) => {
  const s = String(u ?? '').trim();
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : null;
};
const extLink = (url, text) => {
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
function fmtNum(n, min = 0, max = min, { sign = false } = {}) {
  if (!isNum(n)) return '—';
  const s = nf(min, max).format(Math.abs(n));
  const zero = Number(s.replace(/,/g, '')) === 0;
  return (zero ? '' : n < 0 ? MINUS : sign ? '+' : '') + s;
}
function fmtMoney(n, currency, { sign = false } = {}) {
  if (!isNum(n)) return '—';
  const usd = currency === 'USD';
  const s = nf(usd ? 2 : 0, usd ? 2 : 0).format(Math.abs(n));
  const zero = Number(s.replace(/,/g, '')) === 0;
  return `${zero ? '' : n < 0 ? MINUS : sign ? '+' : ''}${usd ? 'US$' : 'NT$'}${s}`;
}
const twd = (n, o) => fmtMoney(n, 'TWD', o);
const usd = (n, o) => fmtMoney(n, 'USD', o);
const fmtPct = (p, d = 2) => (isNum(p) ? `${fmtNum(p, d, d, { sign: true })}%` : '—');
const fmtFrac = (f, d = 2) => (isNum(f) ? `${fmtNum(f * 100, d, d)}%` : '—');
const fmtPrice = (n, market) => (market === 'US' ? fmtNum(n, 2, 2) : fmtNum(n, 0, 2));
const fmtShares = (n) => fmtNum(n, 0, 4);
const fmtLots = (shares, o) => (isNum(shares) ? fmtNum(shares / 1000, 0, Math.abs(shares) < 10000 ? 1 : 0, o) : '—');
const dir = (n) => (isNum(n) && n > 0 ? 'up' : isNum(n) && n < 0 ? 'down' : '');
const ntd = (x) => (x < 1 ? fmtNum(x, 2, 2) : fmtNum(x, 1, 1));
const shortTwd = (v) => {
  if (!isNum(v)) return '—';
  if (Math.abs(v) >= 1e8) return `NT$${fmtNum(v / 1e8, 2, 2)} 億`;
  if (Math.abs(v) >= 1e4) return `NT$${fmtNum(v / 1e4, 0, 1)} 萬`;
  return twd(v);
};
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

const TYPE_LABEL = { stock: '股票', etf: 'ETF', bond_etf: '債券 ETF' };
const ACTION_CLASS = { 停損: 'stop', 停損觀察: 'watch', 分批停利: 'profit', 減碼: 'reduce', 加碼: 'add', 續抱: 'hold' };
const tag = (action) => (action ? html`<span class="tag tag-${ACTION_CLASS[action] ?? 'hold'}">${action}</span>` : '');
const aiBadge = html`<span class="ai-badge" title="AI 分析">AI</span>`;
const US_SECTOR = {
  Technology: '科技', 'Health Care': '醫療保健', Finance: '金融', Financials: '金融', 'Consumer Discretionary': '非必需消費',
  'Consumer Staples': '必需消費', Energy: '能源', Industrials: '工業', Utilities: '公用事業', 'Real Estate': '不動產',
  Telecommunications: '電信', 'Basic Materials': '原物料', Miscellaneous: '其他',
};
const industryLabel = (s) => (s ? US_SECTOR[s] ?? s : s);

// ---------- 儲存（localStorage 一律包 try/catch） ----------

const KEYS = {
  tx: 'pa:v1:transactions', cash: 'pa:v1:cash', settings: 'pa:v1:settings', stops: 'pa:v1:stops',
  manual: 'pa:v1:manualPrices', ai: 'pa:v1:aiResult', aiKey: 'pa:v1:aiKey', aiModel: 'pa:v1:aiModel',
  ui: 'pa:v1:ui', theme: 'pa:theme',
};
let storageBroken = false;
function loadRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function saveRaw(key, value) {
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
function load(key, fallback) {
  const raw = loadRaw(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
const save = (key, value) => saveRaw(key, value == null ? null : JSON.stringify(value));

// ---------- 資料清理（localStorage、匯入檔都要過） ----------

const CODE_RE = /^[0-9A-Z][0-9A-Z.-]{0,11}$/;
const CODE_PATTERN = { TW: /^\d{4,6}[A-Z]?$/, US: /^[A-Z][A-Z0-9]{0,5}([.-][A-Z0-9]{1,2})?$/ };
const KEY_RE = /^(TW|US):[0-9A-Z][0-9A-Z.-]{0,11}$/;
// 券商自訂值的合理範圍（和「設定」對話框一致）：discount 0.01～1 = 0.1～10 折。
const OVERRIDE_RANGES = {
  TW: { discount: [0.01, 1], minFee: [0, 1000], oddLotMinFee: [0, 1000] },
  US: { rate: [0, 0.05], perShare: [0, 1], minFee: [0, 100], maxPct: [0, 1], etfFlat: [0, 100] },
};

// strict（匯入用）：再套用新增交易表單的規則：代號格式、台股整數股、股數上限、日期不晚於今天。
function sanitizeTx(t, { strict = false } = {}) {
  if (!t || typeof t !== 'object') return null;
  const market = t.market === 'TW' || t.market === 'US' ? t.market : null;
  const code = normalizeCode(t.code);
  const side = t.side === 'buy' || t.side === 'sell' ? t.side : null;
  const shares = Number(t.shares);
  const price = Number(t.price);
  const date = String(t.date ?? '');
  if (!market || !CODE_RE.test(code) || !side || !(shares > 0) || !Number.isFinite(shares) ||
    !(price >= 0) || !Number.isFinite(price) || !validDate(date)) return null;
  if (strict && (!CODE_PATTERN[market].test(code) || (market === 'TW' && !Number.isInteger(shares)) || shares > 1e9 ||
    date > todayLocal())) return null;
  const nonNeg = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const feeIncluded = t.feeIncluded === true;
  const broker = brokersFor(market).some((b) => b.id === t.broker) ? t.broker : DEFAULT_BROKER_ID[market];
  return {
    id: typeof t.id === 'string' && t.id.trim() ? t.id.trim().slice(0, 64) : newId(),
    market, code, side, shares, price, date, feeIncluded,
    fee: feeIncluded ? 0 : nonNeg(t.fee),
    tax: feeIncluded ? 0 : nonNeg(t.tax),
    regFee: feeIncluded ? 0 : nonNeg(t.regFee),
    broker,
  };
}
function sanitizeTxList(list, opts) {
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
function sanitizePriceMap(o) {
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
function sanitizeSettings(s) {
  const res = { twBroker: DEFAULT_BROKER_ID.TW, usBroker: DEFAULT_BROKER_ID.US, stopPct: RULES.stopPct, brokerOverrides: {} };
  if (!s || typeof s !== 'object') return res;
  if (brokersFor('TW').some((b) => b.id === s.twBroker)) res.twBroker = s.twBroker;
  if (brokersFor('US').some((b) => b.id === s.usBroker)) res.usBroker = s.usBroker;
  if (Number(s.stopPct) >= 0.01 && Number(s.stopPct) <= 0.5) res.stopPct = Number(s.stopPct);
  res.brokerOverrides = sanitizeOverrides(s.brokerOverrides);
  return res;
}
function sanitizeCash(c) {
  const v = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
  return { twd: v(c?.twd), usd: v(c?.usd) };
}
const strArr = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
function sanitizeAi(a) {
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

// ---------- 狀態 ----------

const ui = load(KEYS.ui, {}) ?? {};
const state = {
  tx: sanitizeTxList(load(KEYS.tx, [])).txs,
  cash: sanitizeCash(load(KEYS.cash, {})),
  settings: sanitizeSettings(load(KEYS.settings, {})),
  stops: sanitizePriceMap(load(KEYS.stops, {})),
  manual: sanitizePriceMap(load(KEYS.manual, {})),
  ai: sanitizeAi(load(KEYS.ai, null)),
  meta: null,
  metaError: null,
  records: {},
  index: {},                 // market → rows | null（undefined 代表還沒載）
  sort: { key: ['code', 'name', 'market', 'shares', 'avgCost', 'price', 'change', 'value', 'netPL', 'ret', 'weight', 'action'].includes(ui.sortKey) ? ui.sortKey : 'value',
    dir: ui.sortDir === 'asc' ? 'asc' : 'desc' },
  alloc: ui.alloc === 'industry' ? 'industry' : 'stock',
  openCards: new Set(),
  knownCards: new Set(),
  editingId: null,
  model: null,
  ai_running: null,          // AbortController
};
const saveUi = () => save(KEYS.ui, { sortKey: state.sort.key, sortDir: state.sort.dir, alloc: state.alloc });
const saveTx = () => save(KEYS.tx, state.tx);

const usdTwd = () => (isNum(state.meta?.fx?.USDTWD) && state.meta.fx.USDTWD > 0 ? state.meta.fx.USDTWD : null);

// ---------- 計算 ----------

function compute() {
  const today = todayLocal();
  const built = buildHoldings(state.tx);
  const fx = usdTwd();
  const overrides = state.settings.brokerOverrides;
  const rows = built.holdings.map((h) => {
    const key = holdingKey(h.market, h.code);
    const rec = state.records[key] ?? null;
    const asOf = rec?.date ?? (h.market === 'US' ? state.meta?.us?.asOf : state.meta?.tw?.asOf);
    return valueHolding(h, rec, { fx, date: today, brokerOverrides: overrides, manualPrice: state.manual[key],
      session: rec ? sessionPosition(state.tx, h.market, h.code, asOf) : null });
  });
  const summary = summarize(rows, { cashTWD: state.cash.twd, cashUSD: state.cash.usd, fx, realizedTotal: built.realizedTotal });
  const analyses = {};
  for (const r of summary.rows) {
    const key = holdingKey(r.market, r.code);
    const m = r.market === 'TW' ? state.meta?.tw : state.meta?.us;
    analyses[key] = analyzeHolding(r, state.records[key] ?? null, {
      industryPe: state.meta?.industryPe, today, events: state.meta?.events, holidayNote: m?.holidayNote,
      upcomingHolidays: m?.upcomingHolidays, stopPct: state.settings.stopPct, userStop: state.stops[key],
    });
  }
  const portfolio = analyzePortfolio(summary.rows, summary, { analyses });
  return { today, built, summary, analyses, portfolio, fx };
}

const COLS = [
  { key: 'code', label: '代號', cls: 'l', val: (r) => r.code },
  { key: 'name', label: '名稱', cls: 'l', val: (r) => r.name },
  { key: 'market', label: '市場', cls: 'c', val: (r) => r.market },
  { key: 'shares', label: '股數', val: (r) => r.shares },
  { key: 'avgCost', label: '每股成本', val: (r) => r.avgCost },
  { key: 'price', label: '收盤價', val: (r) => r.price },
  { key: 'change', label: '漲跌%', val: (r) => r.dayChangePct },
  { key: 'value', label: '市值', val: (r) => r.valueTWD },
  { key: 'netPL', label: '未實現淨損益', val: (r) => r.netPLTWD },
  { key: 'ret', label: '報酬率', val: (r) => r.netPLPct },
  { key: 'weight', label: '占總資產', val: (r) => r.assetWeight },
  { key: 'action', label: '建議', cls: 'c', val: (r, m) => ACTIONS.indexOf(m.analyses[holdingKey(r.market, r.code)]?.action) },
];

function sortedRows(model) {
  const col = COLS.find((c) => c.key === state.sort.key) ?? COLS[7];
  const d = state.sort.dir === 'asc' ? 1 : -1;
  return [...model.summary.rows].sort((a, b) => {
    const va = col.val(a, model);
    const vb = col.val(b, model);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb, 'zh-Hant') : va - vb) * d;
  });
}

// ---------- 頁首、頁尾、提示 ----------

const STATUS_NAMES = {
  twse_quotes: '上市行情', tpex_quotes: '上櫃行情', t86: '三大法人', margin: '融資融券', revenue: '月營收', eps: 'EPS',
  pe: '本益比', us_quotes: '美股行情', history: '歷史價量', fx: '匯率', news: '新聞', index: '大盤指數',
};

function renderHeader() {
  const m = state.meta;
  if (!m) {
    $('dataDates').textContent = state.metaError ? '每日資料載入失敗（仍可手動輸入現價）' : '每日資料載入中…';
    return;
  }
  const age = ageText(dataFreshness(m)?.ageHours);
  setHtml($('dataDates'), html`資料日期：台股以 <b>${m.tw?.asOf ?? '—'}</b> 收盤計／美股以 <b>${m.us?.asOf ?? '—'}</b> 收盤計${age ? html`<span class="muted">・${age}</span>` : ''}`);
  $('nextDay').textContent = `下一個交易日：台股 ${dayLabel(m.tw?.nextTradingDay)}／美股 ${dayLabel(m.us?.nextTradingDay)}`;
  const notes = [];
  if (m.tw?.holidayNote) notes.push(`台股：${m.tw.holidayNote}`);
  if (m.us?.holidayNote) notes.push(`美股：${m.us.holidayNote}`);
  $('holidayNotes').textContent = notes.join('　');
  const idx = [
    ['加權指數', m.tw?.index?.taiex], ['櫃買指數', m.tw?.index?.tpex], ['S&P 500', m.us?.index?.spx],
    ['Nasdaq-100', m.us?.index?.ndx], ['費城半導體', m.us?.index?.sox],
  ].filter(([, v]) => isNum(v?.close));
  setHtml($('indices'), idx.map(([name, v]) =>
    html`<span class="idx">${name} <b>${fmtNum(v.close, 2, 2)}</b> <span class="${dir(v.change)}">${fmtPct(v.changePct)}</span></span>`));
}

function ageText(h) {
  if (!isNum(h)) return '';
  if (h < 1) return '剛更新';
  return h < 48 ? `${Math.floor(h)} 小時前更新` : `${Math.floor(h / 24)} 天前更新`;
}

function renderFooter() {
  const m = state.meta;
  $('updatedAt').textContent = `每日資料更新時間：${m?.generatedAt ? `${fmtDateTime(m.generatedAt)}（台灣時間）` : '—'}`;
  setHtml($('feeSources'), html`手續費與規費依據：${extLink(FEE_SOURCES.twTax, '證券交易稅條例')}、${extLink(FEE_SOURCES.bondEtfTax, '債券 ETF 證交稅停徵')}、${extLink(FEE_SOURCES.secFee, 'SEC 規費')}、${extLink(FEE_SOURCES.finraTaf, 'FINRA TAF')}；券商費率查證日 ${FEES_AS_OF}，實際以券商公告與你的契約為準。`);
}

function renderBanner() {
  const msgs = [];
  if (state.metaError) {
    msgs.push(html`<div class="msg error"><span>無法載入每日行情資料（data/latest），暫時沒有收盤價與分析資料。你仍然可以記錄交易，並在「持股明細」手動輸入現價。</span><button type="button" class="btn btn-sm" data-action="retry-data">重試</button></div>`);
  } else if (hasFailedBuckets()) {
    msgs.push(html`<div class="msg"><span>部分個股的每日資料載入失敗，這些股票可以先手動輸入現價。</span><button type="button" class="btn btn-sm" data-action="retry-data">重試</button></div>`);
  }
  const fresh = state.meta ? dataFreshness(state.meta) : null;
  for (const [key, label] of [['tw', '台股'], ['us', '美股']]) {
    const f = fresh?.[key];
    if (f?.stale) {
      msgs.push(html`<div class="msg" data-stale="${key}"><span>${label}資料停在 ${f.asOf ? dayLabel(f.asOf) : '—'}，${dayLabel(f.expected)} 的收盤應該已經更新，可能是排程延遲，價格不是最新。</span><button type="button" class="btn btn-sm" data-action="retry-data">重試</button></div>`);
    }
  }
  const bad = Object.entries(state.meta?.status ?? {}).filter(([, v]) => v !== 'ok').map(([k]) => STATUS_NAMES[k] ?? k);
  if (bad.length) msgs.push(html`<div class="msg"><span>部分資料來源這次沒有更新，沿用前一次的資料：${bad.join('、')}。</span></div>`);
  if (storageBroken) {
    msgs.push(html`<div class="msg error"><span>這個瀏覽器不允許儲存資料（可能是無痕模式或空間已滿），重新整理後交易紀錄會消失，請記得「匯出備份」。</span></div>`);
  }
  setHtml($('banner'), msgs);
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------- 總覽 ----------

function renderOverview(model) {
  const s = model.summary;
  const has = s.holdingCount > 0;
  const unpriced = s.holdingCount - s.pricedCount;
  const sumOf = (rows, f) => (rows.some((r) => isNum(r[f])) ? rows.reduce((a, r) => a + (r[f] ?? 0), 0) : null);
  const twValue = sumOf(s.rows.filter((r) => r.market === 'TW'), 'valueTWD');
  const usRows = s.rows.filter((r) => r.market === 'US');
  const usValue = sumOf(usRows, 'marketValue');
  const usNoFx = usRows.length > 0 && s.missingFx;
  const valueSub = !has ? '新增交易後顯示'
    : s.marketValue == null ? '持股都還沒有價格，可在持股明細輸入手動價格'
      : usNoFx ? html`台股 <b>${twd(twValue)}</b>・美股缺匯率未計入`
        : usRows.length ? html`台股 <b>${twd(twValue)}</b>・美股 <b>${usd(usValue)}</b>` : html`全部為台股`;
  const cashWarn = !has ? '' : s.cashRatio === 0 ? '全倉：沒有保留現金' : isNum(s.cashRatio) && s.cashRatio < RULES.portfolio.minCash ? '現金低於 10%' : '';
  const cashWhy = !has || s.cashRatio != null ? ''
    : unpriced ? `・有 ${unpriced} 檔沒有價格，無法計算` : '・缺美元匯率，無法計算';
  const cards = [
    { id: 'marketValue', label: '總市值', value: has ? twd(s.marketValue) : '—', sub: valueSub },
    { id: 'cost', label: '總成本（含買進手續費）', value: has ? twd(s.costTotal) : '—',
      sub: has ? `${s.holdingCount} 檔持股${usNoFx ? '・美股缺匯率未計入' : ''}` : '—' },
    {
      id: 'netPL', label: '未實現淨損益',
      value: has && s.netPL != null ? html`<span class="${dir(s.netPL)}">${twd(s.netPL, { sign: true })}</span> <span class="${dir(s.netPLPct)} small">${fmtPct(s.netPLPct)}</span>` : '—',
      sub: !has ? '已扣預估賣出手續費與交易稅' : s.netPL == null ? '持股都還沒有價格'
        : html`帳面損益 <b class="${dir(s.grossPL)}">${twd(s.grossPL, { sign: true })}</b>・預估賣出成本 <b>${twd(s.sellCosts)}</b>`,
    },
    {
      id: 'cashRatio', label: '現金比例', value: has || s.cashTotalTWD > 0 ? fmtFrac(s.cashRatio, 1) : '—',
      sub: html`現金 <b>${twd(s.cashTotalTWD)}</b>${s.cashUSD > 0 && usdTwd() ? html`（含 ${usd(s.cashUSD)}）` : ''}${cashWhy}`,
      warn: cashWarn,
    },
  ];
  setHtml($('stats'), cards.map((c) => html`<div class="stat" data-stat="${c.id}">
    <div class="stat-label">${c.label}</div>
    <div class="stat-value">${c.value}</div>
    <div class="stat-sub">${c.sub}</div>
    ${c.warn ? html`<span class="warn-chip">${c.warn}</span>` : ''}
  </div>`));

  const parts = [];
  if (has) {
    parts.push(html`<span data-stat="dayPL">今日損益 <b class="${dir(s.dayPL)}">${twd(s.dayPL, { sign: true })}</b>${isNum(s.dayPLPct) ? html` <span class="${dir(s.dayPLPct)}">${fmtPct(s.dayPLPct)}</span>` : ''}</span>`);
  }
  if (has || s.realized) parts.push(html`<span data-stat="realized">已實現損益 <b class="${dir(s.realized)}">${twd(s.realized, { sign: true })}</b></span>`);
  const fx = state.meta?.fx;
  if (usdTwd()) parts.push(html`<span>匯率 USD/TWD <b>${fmtNum(fx.USDTWD, 2, 4)}</b>（${fx.source ?? '匯率'}，${fx.date ?? '—'}）</span>`);
  if (s.missingPrice.length) parts.push(html`<span class="holiday">${s.missingPrice.length} 檔沒有收盤價，未計入市值，可在持股明細輸入手動價格</span>`);
  setHtml($('statsLine'), parts);
}

// ---------- 資產配置（圓環圖） ----------

// 圓環圖與明細表的百分比都以「總資產（股票市值＋現金）」為分母，和集中度規則一致。
function renderAllocation(model) {
  const s = model.summary;
  document.querySelectorAll('[data-alloc]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.alloc === state.alloc)));
  const groups = state.alloc === 'industry' ? s.allocation.byIndustry : s.allocation.byStock;
  if (!groups.length) {
    setHtml($('allocBody'), html`<p class="empty">${s.holdingCount ? '持股都還沒有價格，無法畫配置圖。' : '還沒有持股。'}</p>`);
    return;
  }
  const slices = groups.slice(0, 5).map((g, i) => ({
    label: state.alloc === 'industry' ? industryLabel(g.label) : g.label, weight: g.assetWeight, value: g.valueTWD, cls: `s${i + 1}`,
  }));
  if (groups.length > 5) {
    const rest = groups.slice(5);
    slices.push({
      label: `其他 ${rest.length} ${state.alloc === 'industry' ? '類' : '檔'}`, cls: 's0',
      weight: rest.reduce((a, g) => a + g.assetWeight, 0), value: rest.reduce((a, g) => a + g.valueTWD, 0),
    });
  }
  const withCash = s.cashTotalTWD > 0 && s.totalAssets > 0;
  if (withCash) slices.push({ label: '現金', weight: s.cashTotalTWD / s.totalAssets, value: s.cashTotalTWD, cls: 'sc' });
  const R = 70, C = 2 * Math.PI * R, gap = slices.length > 1 ? 2.5 : 0;
  let start = 0;
  const arcs = slices.map((sl) => {
    const len = sl.weight * C;
    const dash = Math.max(len - gap, 0.6);
    const a = html`<circle class="seg-arc ${sl.cls}" cx="95" cy="95" r="${R}" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-start).toFixed(2)}" transform="rotate(-90 95 95)"><title>${sl.label}：${fmtFrac(sl.weight, 1)}</title></circle>`;
    start += len;
    return a;
  });
  const notes = [];
  if (s.maxWeight) notes.push(html`<li>最大單檔：${s.maxWeight.label} 占總資產 ${fmtFrac(s.maxWeight.assetWeight, 1)}（占股票市值 ${fmtFrac(s.maxWeight.weight, 1)}）</li>`);
  if (s.topIndustry) notes.push(html`<li>最大產業：${industryLabel(s.topIndustry.label)} 占總資產 ${fmtFrac(s.topIndustry.assetWeight, 1)}（占股票市值 ${fmtFrac(s.topIndustry.weight, 1)}）</li>`);
  notes.push(html`<li class="muted">集中度規則：單檔占總資產超過 40%、同產業超過 60% 會提示（總資產含現金）。</li>`);
  for (const r of model.portfolio.risks.filter((x) => /占總資產|只持有|產業/.test(x))) notes.push(html`<li class="risk">⚠ ${r}</li>`);
  if (s.missingPrice.length) notes.push(html`<li>${s.missingPrice.length} 檔沒有價格，不在圖中</li>`);

  setHtml($('allocBody'), html`<div class="alloc">
    <svg class="donut" viewBox="0 0 190 190" role="img" aria-label="${state.alloc === 'industry' ? '依產業' : '依個股'}的資產配置圓環圖（占總資產${withCash ? '，含現金' : ''}）">
      <circle class="track" cx="95" cy="95" r="${R}"></circle>
      ${arcs}
      <text class="c-label" x="95" y="88" text-anchor="middle">總資產</text>
      <text class="c-value" x="95" y="110" text-anchor="middle">${shortTwd(s.totalAssets)}</text>
    </svg>
    <ul class="legend">${slices.map((sl) => html`<li><i class="sw ${sl.cls}"></i><span class="lg-name" title="${sl.label}">${sl.label}</span><span class="lg-pct">${fmtFrac(sl.weight, 1)}</span><span class="lg-val">${twd(sl.value)}</span></li>`)}</ul>
  </div>
  <ul class="alloc-notes list plain">${notes}</ul>`);
}

// ---------- 持股明細表 ----------

function priceCell(r, key) {
  if (r.price == null) {
    return html`<input class="manual-input" type="number" inputmode="decimal" min="0" step="any" placeholder="手動價格" aria-label="${r.code} 手動價格" data-manual="${key}">`;
  }
  if (r.priceSource === 'manual') {
    return html`${fmtPrice(r.price, r.market)}<button type="button" class="manual-flag" data-clear-manual="${key}" aria-label="清除 ${r.code} 的手動價格" title="清除手動價格">手動 ✕</button>`;
  }
  return fmtPrice(r.price, r.market);
}

function renderTable(model, rows) {
  const wrap = $('holdingsWrap');
  if (!rows.length) {
    setHtml(wrap, html`<p class="empty">還沒有持股，請先在上方「新增交易」。</p>`);
    return;
  }
  const s = model.summary;
  const head = COLS.map((c) => {
    const sorted = state.sort.key === c.key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return html`<th class="${c.cls ?? ''}" aria-sort="${sorted}" scope="col"><button type="button" class="th-sort" data-sort="${c.key}">${c.label}</button></th>`;
  });
  const body = rows.map((r) => {
    const key = holdingKey(r.market, r.code);
    const a = model.analyses[key];
    return html`<tr data-key="${key}">
      <td><button type="button" class="linklike" data-goto="${key}">${r.code}</button></td>
      <td class="l nm-cell" title="${r.name}">${r.name !== r.code ? r.name : '—'}</td>
      <td class="c">${r.market === 'TW' ? '台股' : '美股'}</td>
      <td>${fmtShares(r.shares)}</td>
      <td>${fmtNum(r.avgCost, 2, 2)}</td>
      <td>${priceCell(r, key)}</td>
      <td class="${dir(r.dayChangePct)}">${fmtPct(r.dayChangePct)}</td>
      <td>${fmtMoney(r.marketValue, r.currency)}</td>
      <td class="${dir(r.netPL)}">${fmtMoney(r.netPL, r.currency, { sign: true })}</td>
      <td class="${dir(r.netPLPct)}">${fmtPct(r.netPLPct)}</td>
      <td>${fmtFrac(r.assetWeight, 1)}</td>
      <td class="c">${tag(a?.action)}</td>
    </tr>`;
  });
  setHtml(wrap, html`<div class="table-scroll" role="region" aria-label="持股明細表（可左右捲動）" tabindex="0">
    <table class="data-table holdings-table">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td>合計（台幣）</td><td colspan="6"></td>
        <td>${twd(s.marketValue)}</td>
        <td class="${dir(s.netPL)}">${twd(s.netPL, { sign: true })}</td>
        <td class="${dir(s.netPLPct)}">${fmtPct(s.netPLPct)}</td>
        <td>${isNum(s.marketValue) && s.totalAssets > 0 ? fmtFrac(s.marketValue / s.totalAssets, 1) : '—'}</td><td></td>
      </tr></tfoot>
    </table>
  </div>`);
}

// ---------- 個股詳細卡 ----------

const block = (title, body, { wide = false, note = '' } = {}) =>
  html`<section class="sc-block${wide ? ' wide' : ''}"><h4>${title}${note ? html` <span class="muted">${note}</span>` : ''}</h4>${body}</section>`;
const li = (t) => html`<li>${t}</li>`;
const listOr = (items, empty) => (items.length ? items : html`<li class="empty-li">${empty}</li>`);
const aiLabel = () => (state.ai ? `AI 分析・${state.ai.date || '—'}・${modelShort(state.ai.served || state.ai.model)}` : '');
const modelShort = (id) => MODELS.find((m) => m.id === id)?.short ?? id;
const aiFor = (key) => state.ai?.stocks?.[key] ?? null;

function blockQuote(r, rec) {
  if (!rec) {
    return block('行情', html`<p class="muted">每日資料裡沒有這檔${r.priceSource === 'manual' ? html`；目前用手動價格 <b>${fmtPrice(r.price, r.market)}</b>` : '，請在持股明細輸入手動價格'}。</p>`);
  }
  const h = rec.hist ?? {};
  const vol = isNum(rec.volume) ? rec.volume : null;
  const avg = isNum(h.avgVol20) ? h.avgVol20 : null;
  const volText = (v) => (r.market === 'TW' ? `${fmtLots(v)} 張` : `${fmtNum(v, 0)} 股`);
  const ratio = vol != null && avg ? vol / avg : null;
  const pos = levels(r, rec).pos52;
  return block('行情', html`<dl class="kv">
      <dt>收盤${r.priceSource === 'manual' ? '（資料）' : ''}</dt>
      <dd><b>${fmtPrice(rec.close, r.market)}</b> <span class="${dir(rec.change)}">${fmtNum(rec.change, 0, 2, { sign: true })}（${fmtPct(rec.changePct)}）</span></dd>
      <dt>成交量</dt>
      <dd>${vol != null ? volText(vol) : '—'}${avg ? html` <span class="muted">／ 20 日均量 ${volText(avg)}</span>` : ''}${ratio != null ? html` <b class="${ratio >= RULES.signals.volumeSpike ? 'holiday' : ''}">×${fmtNum(ratio, 2, 2)}</b>` : ''}</dd>
      <dt>近一週</dt><dd class="${dir(h.d5Pct)}">${fmtPct(h.d5Pct)}</dd>
      <dt>近一月</dt><dd class="${dir(h.d20Pct)}">${fmtPct(h.d20Pct)}</dd>
      <dt>52 週高低</dt><dd>${fmtPrice(h.lo52, r.market)} – ${fmtPrice(h.hi52, r.market)}${isNum(pos) ? html` <span class="muted">（位置 ${fmtFrac(pos, 0)}）</span>` : ''}</dd>
    </dl>
    ${isNum(pos) ? html`<div class="range" role="img" aria-label="52 週區間位置 ${fmtFrac(pos, 0)}">
      <div class="range-track"><span class="range-dot" style="left:${(pos * 100).toFixed(1)}%"></span></div>
      <div class="range-ends"><span>低 ${fmtPrice(h.lo52, r.market)}</span><span>高 ${fmtPrice(h.hi52, r.market)}</span></div>
    </div>` : ''}`, { note: rec.date ?? '' });
}

const SCALE_MARKS = [
  ['cost', '成本', 'cost'], ['price', '現價', 'price'], ['support', '支撐', 'support'],
  ['resist', '壓力', 'resistance'], ['stop', '停損', 'stop'], ['hi', '52週高', 'hi52'],
];
function blockScale(r, a) {
  const lv = a.levels;
  const marks = SCALE_MARKS.map(([k, name, f]) => ({ k, name, v: lv[f] })).filter((m) => isNum(m.v) && m.v > 0);
  if (marks.length < 2 || !isNum(lv.price)) {
    return block('價位刻度', html`<p class="muted">資料不足，無法畫價位刻度。</p>`);
  }
  const vals = marks.map((m) => m.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || max * 0.1;
  const lo = min - span * 0.05;
  const hi = max + span * 0.05;
  const x = (v) => ((v - lo) / (hi - lo)) * 100;
  return block('價位刻度', html`<div class="scale" data-scale>
      <div class="scale-track"></div>
      ${marks.map((m) => html`<span class="scale-tick mk-${m.k}${m.k === 'price' ? ' price' : ''}" style="left:${x(m.v).toFixed(2)}%"></span>`)}
      ${marks.map((m) => html`<span class="scale-label" data-x="${x(m.v).toFixed(2)}" data-k="${m.k}"><i class="sw mk-${m.k}"></i>${m.name} <b>${fmtNum(m.v, 0, 2)}</b></span>`)}
    </div>
    <p class="sr-only">${marks.map((m) => `${m.name} ${fmtNum(m.v, 0, 2)}`).join('，')}</p>`);
}

function streakText(name, n) {
  if (!isNum(n)) return `${name} —`;
  if (n > 0) return `${name}連買 ${n} 天`;
  if (n < 0) return `${name}連賣 ${-n} 天`;
  return `${name}無連續買賣超`;
}

function blockChips(rec) {
  const c = rec?.chips;
  if (!c) return block('籌碼', html`<p class="muted">沒有法人與融資資料。</p>`);
  const bars = [['外資', c.foreign], ['投信', c.trust], ['自營', c.dealer]];
  const maxAbs = Math.max(...bars.map(([, v]) => (isNum(v) ? Math.abs(v) : 0)), 1);
  const w = (v) => `${((Math.abs(v) / maxAbs) * 100).toFixed(1)}%`;
  const ratio = isNum(c.short) && isNum(c.margin) && c.margin > 0 ? (c.short / c.margin) * 100 : null;
  return block('籌碼', html`<div class="chips-bars" role="img" aria-label="${bars.map(([n, v]) => `${n} ${fmtLots(v, { sign: true })} 張`).join('，')}">
      ${bars.map(([n, v]) => html`<div class="cb-row">
        <span class="cb-name">${n}</span>
        <span class="cb-neg">${isNum(v) && v < 0 ? html`<i style="width:${w(v)}"></i>` : ''}</span>
        <span class="cb-pos">${isNum(v) && v > 0 ? html`<i style="width:${w(v)}"></i>` : ''}</span>
        <span class="cb-val ${dir(v)}">${fmtLots(v, { sign: true })} 張</span>
      </div>`)}
    </div>
    <dl class="kv" style="margin-top:10px">
      <dt>5 日累計</dt><dd>外資 <span class="${dir(c.foreign5)}">${fmtLots(c.foreign5, { sign: true })}</span>・投信 <span class="${dir(c.trust5)}">${fmtLots(c.trust5, { sign: true })}</span>・自營 <span class="${dir(c.dealer5)}">${fmtLots(c.dealer5, { sign: true })}</span> 張</dd>
      <dt>連續</dt><dd>${streakText('外資', c.foreignStreak)}・${streakText('投信', c.trustStreak)}</dd>
      <dt>融資餘額</dt><dd>${fmtNum(c.margin, 0)} 張 <span class="${dir(c.marginChg)}">（${fmtNum(c.marginChg, 0, 0, { sign: true })}）</span></dd>
      <dt>融券</dt><dd>${fmtNum(c.short, 0)} 張</dd>
      <dt>券資比</dt><dd>${isNum(ratio) ? `${fmtNum(ratio, 2, 2)}%` : '—'}</dd>
    </dl>
    ${c.marginDate ? html`<p class="hint">融資融券資料日期 ${c.marginDate}</p>` : ''}`, { note: `${c.date ?? ''}・買超紅、賣超綠` });
}

function epsLabel(p) {
  const m = /^(\d{4})Q([1-4])(累計)?$/.exec(String(p ?? ''));
  if (!m) return p ? String(p) : '';
  const [, y, q, cum] = m;
  if (q === '1') return `${y} 年第 1 季`;
  return cum ? `${y} 年前 ${q} 季累計` : `${y} 年第 ${q} 季`;
}
const revText = (rev) => {
  if (!isNum(rev)) return '—';
  const v = rev * 1000; // 單位千元
  return v >= 1e8 ? `${fmtNum(v / 1e8, 2, 2)} 億元` : `${fmtNum(v / 1e4, 0)} 萬元`;
};

function blockFund(r, rec) {
  if (r.market === 'US') {
    const cap = rec?.marketCap;
    return block('基本面', html`<dl class="kv">
        <dt>產業</dt><dd>${[industryLabel(rec?.sector), rec?.industry].filter(Boolean).join('・') || '—'}</dd>
        <dt>市值</dt><dd>${isNum(cap) ? (cap >= 1e12 ? `US$${fmtNum(cap / 1e12, 2, 2)} 兆` : `US$${fmtNum(cap / 1e8, 0)} 億`) : '—'}</dd>
      </dl><p class="hint" style="margin-top:6px">美股每日資料不含營收、EPS 與本益比。</p>`);
  }
  const f = rec?.fund;
  if (!f) {
    return block('基本面', html`<p class="muted">${r.type === 'etf' || r.type === 'bond_etf' ? 'ETF 沒有月營收、EPS 與本益比資料。' : '沒有基本面資料。'}</p>`);
  }
  const indPe = industryPeFor(state.meta?.industryPe, 'TW', r.industry);
  const ym = /^\d{4}-\d{2}$/.test(f.revYm ?? '') ? `${f.revYm.slice(0, 4)} 年 ${+f.revYm.slice(5)} 月` : '';
  let peNote = '';
  if (isNum(f.pe) && isNum(indPe)) {
    const d = (f.pe / indPe - 1) * 100;
    peNote = Math.abs(d) < 1 ? '與同業相近' : d > 0 ? `高於同業 ${fmtNum(d, 0)}%` : `低於同業 ${fmtNum(-d, 0)}%`;
  }
  return block('基本面', html`<dl class="kv">
      <dt>月營收${ym ? `（${ym}）` : ''}</dt><dd>${revText(f.rev)}</dd>
      <dt>月增／年增</dt><dd><span class="${dir(f.mom)}">${fmtPct(f.mom)}</span>／<span class="${dir(f.yoy)}">${fmtPct(f.yoy)}</span></dd>
      <dt>累計年增</dt><dd class="${dir(f.ytdYoy)}">${fmtPct(f.ytdYoy)}</dd>
      <dt>EPS${f.epsPeriod ? `（${epsLabel(f.epsPeriod)}）` : ''}</dt><dd>${fmtNum(f.eps, 2, 2)} 元</dd>
      <dt>近四季 EPS</dt><dd>${isNum(f.eps4q) ? `${fmtNum(f.eps4q, 2, 2)} 元` : '—'}</dd>
      <dt>本益比 vs 同業中位數</dt><dd>${fmtNum(f.pe, 1, 1)} ／ ${fmtNum(indPe, 1, 1)}${peNote ? html` <span class="muted">（${peNote}）</span>` : ''}</dd>
      <dt>股價淨值比</dt><dd>${fmtNum(f.pb, 2, 2)}</dd>
      <dt>殖利率</dt><dd>${isNum(f.yield) ? `${fmtNum(f.yield, 2, 2)}%` : '—'}</dd>
    </dl>`, { note: r.industry ?? '' });
}

function blockBullBear(a, ai) {
  const items = (rule, aiList) => [
    ...rule.map((t) => li(t)),
    ...(aiList ?? []).map((t) => html`<li>${aiBadge}${t}</li>`),
  ];
  return block('多空觀點', html`<div class="bullbear">
      <div class="bb-col bb-bull"><h5>多方</h5><ul class="list">${listOr(items(a.bull, ai?.bull), '目前沒有明顯的多方訊號')}</ul></div>
      <div class="bb-col bb-bear"><h5>空方</h5><ul class="list">${listOr(items(a.bear, ai?.bear), '目前沒有明顯的空方訊號')}</ul></div>
    </div>`, { wide: true, note: ai ? '規則＋AI' : '依規則' });
}

function blockWatch(a, ai) {
  const items = [...a.watch.map((t) => li(t)), ...(ai?.watch ?? []).map((t) => html`<li>${aiBadge}${t}</li>`)];
  return block('今天該注意', html`<ul class="list">${listOr(items, '沒有特別要注意的事')}</ul>`);
}

function blockReco(a, ai) {
  return block('建議與理由', html`<div class="reco-head">${tag(a.action)}<span class="muted small">依規則的參考提示</span></div>
    <ul class="list">${a.reasons.map(li)}</ul>
    <p class="subhead">觸發條件</p>
    <ul class="list">${listOr(a.triggers.map(li), '—')}</ul>
    ${ai ? html`<div class="ai-box">
      <div class="ai-head">${aiBadge}${aiLabel()} ${tag(ai.action)}</div>
      ${ai.summary ? html`<p class="summary">${ai.summary}</p>` : ''}
      ${ai.reasons.length ? html`<ul class="list">${ai.reasons.map(li)}</ul>` : ''}
      ${ai.trigger ? html`<p class="subhead">觸發條件</p><p>${ai.trigger}</p>` : ''}
    </div>` : ''}`);
}

function blockStop(r, a, key) {
  const lv = a.levels;
  const user = state.stops[key];
  const auto = levels(r, state.records[key] ?? null, { stopPct: state.settings.stopPct }).stop;
  const why = lv.stopSource === 'user' ? '自訂'
    : lv.stopSource === 'cost' ? `成本 ${fmtNum(lv.cost, 2, 2)} 下跌 ${fmtNum(lv.stopPct * 100, 0, 1)}%`
      : lv.stopSource === 'support' ? `支撐 ${fmtNum(lv.support, 0, 2)} × ${RULES.supportStopFactor}` : '資料不足';
  const dist = isNum(lv.price) && isNum(lv.stop) && lv.price > 0 ? (lv.price - lv.stop) / lv.price : null;
  const id = `stop-${cardId(key)}`;
  return block('停損價', html`<p>目前停損價 <b>${fmtNum(lv.stop, 2, 2)}</b> <span class="muted">（${why}）</span>${isNum(dist) ? html`，距現價 <b class="${dist < 0 ? 'down' : ''}">${fmtFrac(dist, 1)}</b>` : ''}</p>
    <div class="stop-edit" style="margin-top:8px">
      <label class="sr-only" for="${id}">${r.code} 自訂停損價</label>
      <input id="${id}" type="number" inputmode="decimal" min="0" step="any" data-stop="${key}" value="${user ?? ''}" placeholder="${isNum(auto) ? `自動 ${fmtNum(auto, 2, 2)}` : '自訂停損價'}">
      <button type="button" class="btn btn-sm" data-stop-save="${key}">儲存</button>
      ${user ? html`<button type="button" class="btn btn-sm" data-stop-clear="${key}">改回自動</button>` : ''}
    </div>
    <p class="hint" style="margin-top:4px">留空＝自動：成本 × (1 − ${fmtNum(state.settings.stopPct * 100, 0, 1)}%) 與支撐 × 0.97 取較高者（可在「設定」改預設 %）。</p>
    ${lv.stopSource === 'support' ? html`<p class="hint warn" style="margin-top:4px">支撐停損價每天依前 20 個交易日的收盤低點重算，跌破後隔天會跟著往下移。想守住這個價位，請把它存成自訂停損價。
      <button type="button" class="btn btn-sm" data-stop-pin="${key}" data-value="${lv.stop}">固定為 ${fmtNum(lv.stop, 2, 2)}</button></p>` : ''}`);
}

function blockSources(r, rec) {
  const c = encodeURIComponent(r.code);
  const links = r.market === 'US'
    ? [['Yahoo Finance', `https://finance.yahoo.com/quote/${c}`],
      ['Nasdaq', `https://www.nasdaq.com/market-activity/${r.type === 'etf' ? 'etf' : 'stocks'}/${c.toLowerCase()}`]]
    : [
      ...(rec?.exchange === 'TPEx' ? [['證券櫃檯買賣中心', 'https://www.tpex.org.tw/']]
        : rec?.exchange === 'TWSE' ? [['臺灣證券交易所', 'https://www.twse.com.tw/']]
          : [['臺灣證券交易所', 'https://www.twse.com.tw/'], ['證券櫃檯買賣中心', 'https://www.tpex.org.tw/']]),
      ['Yahoo 股市', `https://tw.stock.yahoo.com/quote/${c}`],
      ['HiStock', `https://histock.tw/stock/${c}`],
      ['鉅亨', `https://www.cnyes.com/twstock/${c}`],
    ];
  return block('資料來源', html`<p class="links">${links.map(([t, u]) => extLink(u, t))}</p>`);
}

function blockNews(key) {
  const list = state.ai?.news?.[key];
  if (!list?.length) return '';
  return block('相關新聞', html`<ul class="news-list">${list.map((n) => html`<li>${extLink(n.link, n.title)}<span class="meta">${n.source}${n.pubDate ? ` ${n.pubDate.slice(0, 10)}` : ''}</span></li>`)}</ul>`,
    { note: `${state.ai.date} 分析時抓取（Google News）` });
}

function renderCards(model, rows) {
  const box = $('cards');
  if (!rows.length) {
    setHtml(box, html`<p class="empty card">新增交易後，這裡會顯示每檔股票的詳細分析。</p>`);
    return;
  }
  const desktop = window.matchMedia('(min-width: 900px)').matches;
  for (const r of rows) {
    const key = holdingKey(r.market, r.code);
    if (!state.knownCards.has(key)) {
      state.knownCards.add(key);
      if (desktop) state.openCards.add(key);
    }
  }
  setHtml(box, rows.map((r) => {
    const key = holdingKey(r.market, r.code);
    const rec = state.records[key] ?? null;
    const a = model.analyses[key];
    const ai = aiFor(key);
    const typeLabel = TYPE_LABEL[r.type] && r.type !== 'stock' ? TYPE_LABEL[r.type] : null;
    const indLabel = r.industry ? industryLabel(r.industry) : null;
    const sub = [indLabel && indLabel !== typeLabel ? indLabel : null, rec?.exchange === 'TPEx' ? '上櫃' : rec?.exchange === 'TWSE' ? '上市' : null,
      r.market === 'US' ? '美股' : null, typeLabel].filter(Boolean);
    return html`<details class="stock-card" id="${cardId(key)}" data-key="${key}"${state.openCards.has(key) ? html` open` : ''}>
      <summary>
        <span class="sc-title"><span class="code">${r.code}</span>${r.name !== r.code ? r.name : ''}${sub.length ? html`<span class="sc-sub">${sub.join('・')}</span>` : ''}</span>
        ${tag(a.action)}${ai?.action && ai.action !== a.action ? html` <span class="muted small">AI：</span>${tag(ai.action)}` : ''}
        <span class="sc-quick">
          <span>收盤 <b>${fmtPrice(r.price, r.market)}</b> <span class="${dir(r.dayChangePct)}">${fmtPct(r.dayChangePct)}</span></span>
          <span>淨損益 <b class="${dir(r.netPL)}">${fmtMoney(r.netPL, r.currency, { sign: true })}</b> <span class="${dir(r.netPLPct)}">${fmtPct(r.netPLPct)}</span></span>
        </span>
      </summary>
      <div class="sc-body">
        ${blockQuote(r, rec)}
        ${blockScale(r, a)}
        ${r.market === 'TW' ? blockChips(rec) : ''}
        ${blockFund(r, rec)}
        ${blockBullBear(a, ai)}
        ${blockWatch(a, ai)}
        ${blockReco(a, ai)}
        ${blockStop(r, a, key)}
        ${blockSources(r, rec)}
        ${blockNews(key)}
      </div>
    </details>`;
  }));
}

// 價位刻度：量每個標籤寬度，依序放進上 1／下 1／上 2／下 2…排，確保不重疊。
const LANE_H = 20;
function layoutScale(el) {
  const W = el.clientWidth;
  if (!W) return;
  el.querySelectorAll('.scale-lead').forEach((n) => n.remove());
  const labels = [...el.querySelectorAll('.scale-label')]
    .map((node) => ({ node, x: (parseFloat(node.dataset.x) / 100) * W, w: node.offsetWidth }))
    .sort((a, b) => a.x - b.x);
  const ends = [-Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity];
  for (const L of labels) {
    L.left = Math.min(Math.max(L.x - L.w / 2, 0), Math.max(W - L.w, 0));
    L.lane = ends.findIndex((end) => L.left >= end + 6);
    if (L.lane < 0) L.lane = ends.indexOf(Math.min(...ends));
    ends[L.lane] = L.left + L.w;
  }
  const above = Math.max(0, ...labels.filter((l) => l.lane % 2 === 0).map((l) => l.lane / 2 + 1));
  const below = Math.max(0, ...labels.filter((l) => l.lane % 2 === 1).map((l) => (l.lane - 1) / 2 + 1));
  const band = above * LANE_H + 4;     // 軌道帶（20px 高）的頂端
  el.style.height = `${band + LANE_H + below * LANE_H + 4}px`;
  el.querySelector('.scale-track').style.top = `${band + 8}px`;
  el.querySelectorAll('.scale-tick').forEach((t) => { t.style.top = `${band + (t.classList.contains('price') ? 4 : 2)}px`; });
  for (const L of labels) {
    const ring = Math.floor(L.lane / 2);
    const top = L.lane % 2 === 0 ? band - (ring + 1) * LANE_H : band + LANE_H + ring * LANE_H;
    L.node.style.left = `${L.left}px`;
    L.node.style.top = `${top}px`;
    if (ring > 0) {
      const lead = document.createElement('span');
      lead.className = 'scale-lead';
      const y1 = L.lane % 2 === 0 ? top + LANE_H - 2 : band + LANE_H - 2;
      const y2 = L.lane % 2 === 0 ? band + 2 : top + 2;
      Object.assign(lead.style, { left: `${L.x}px`, top: `${y1}px`, height: `${Math.max(y2 - y1, 0)}px` });
      el.append(lead);
    }
  }
}
const layoutScales = () => document.querySelectorAll('details[open] [data-scale]').forEach(layoutScale);

function gotoCard(key) {
  const el = document.getElementById(cardId(key));
  if (!el) return;
  el.open = true;
  state.openCards.add(key);
  el.querySelectorAll('[data-scale]').forEach(layoutScale);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  el.querySelector('summary')?.focus({ preventScroll: true });
}

// ---------- 整體組合建議 ----------

function renderAdvice(model) {
  const p = model.portfolio;
  const ai = state.ai && (state.ai.portfolio.risks.length || state.ai.portfolio.advice.length) ? state.ai.portfolio : null;
  setHtml($('adviceBody'), html`<div class="advice-grid">
      <div><h3>風險</h3><ul class="list">${listOr(p.risks.map(li), '目前沒有觸發組合風險規則')}</ul></div>
      <div><h3>建議 <span class="muted small">依規則的參考提示</span></h3><ul class="list">${listOr(p.advice.map(li), '—')}</ul></div>
    </div>
    ${ai ? html`<div class="ai-box" style="margin-top:14px">
      <div class="ai-head">${aiBadge}${aiLabel()}</div>
      <div class="advice-grid">
        <div><h3>風險</h3><ul class="list">${listOr(ai.risks.map(li), '—')}</ul></div>
        <div><h3>建議</h3><ul class="list">${listOr(ai.advice.map(li), '—')}</ul></div>
      </div>
    </div>` : ''}`);
}

// ---------- AI 分析 ----------

const currentModelId = () => (MODELS.some((m) => m.id === $('aiModel').value) ? $('aiModel').value : DEFAULT_MODEL);
const fxForCost = () => usdTwd() ?? 32;

function aiPayload(model, stockNews = null) {
  return buildPayload({
    meta: state.meta, summary: model.summary, records: state.records, analyses: model.analyses,
    portfolioRules: model.portfolio, stockNews, today: model.today,
  });
}

function renderAiPanel(model) {
  const m = modelInfo(currentModelId());
  $('aiPrice').textContent = `每百萬 tokens：輸入 US$${m.input}、輸出 US$${m.output}`;
  const rows = model.summary.rows;
  const running = Boolean(state.ai_running);
  $('aiRun').disabled = running || !rows.length;
  $('aiCancel').hidden = !running;
  $('aiClear').disabled = running || !state.ai;
  if (!rows.length) {
    $('aiEstimate').textContent = '新增持股後才能分析。';
  } else {
    const est = estimateCost(m.id, aiPayload(model));
    const fx = fxForCost();
    setHtml($('aiEstimate'), html`預估每次約 <b>NT$${ntd(est.low * fx)}～${ntd(est.high * fx)}</b>（US$${fmtNum(est.low, 3, 3)}～${fmtNum(est.high, 3, 3)}；輸入約 ${fmtNum(est.inputTokens, 0)} tokens、輸出約 ${fmtNum(est.outputTokens, 0)} tokens，含思考）。<span class="muted">這只是估計，實際依 AI 回答長度而定${usdTwd() ? '' : '；以 1 美元約 32 台幣估'}。</span>${est.overLimit ? html` <span class="holiday">持股檔數多，AI 的回答可能超過輸出上限而被截斷，可以先減少檔數。</span>` : ''}`);
  }
  const a = state.ai;
  if (!a) {
    $('aiResultMeta').textContent = '';
    return;
  }
  const nowKeys = rows.map((r) => holdingKey(r.market, r.code)).sort().join(',');
  const stale = a.keys.length && a.keys.slice().sort().join(',') !== nowKeys;
  const served = a.served && a.served !== a.model ? `（由 ${modelShort(a.served)} 代為回答）` : '';
  setHtml($('aiResultMeta'), html`<p>上次分析：${a.date || '—'}${a.at ? ` ${fmtDateTime(a.at).slice(11)}` : ''}・${modelShort(a.model)}${served}${a.cost ? html`・實際花費 <b>US$${fmtNum(a.cost.usd, 4, 4)}</b>（約 NT$${ntd(a.cost.usd * fxForCost())}）・輸入 ${fmtNum(a.cost.inputTokens, 0)}／輸出 ${fmtNum(a.cost.outputTokens, 0)} tokens` : ''}・個股新聞 ${a.newsOk} 檔有抓到</p>
    ${stale ? html`<p class="holiday">持股和分析時不同，AI 結果可能已過時，建議重新分析。</p>` : ''}`);
}

function aiStatus(content) { setHtml($('aiStatus'), content); }

async function runAi() {
  if (state.ai_running) return;
  const model = state.model;
  const rows = model?.summary.rows ?? [];
  const key = $('aiKey').value.trim();
  if (!rows.length) { aiStatus(html`<div class="err">還沒有持股，無法分析。</div>`); return; }
  if (!key) {
    aiStatus(html`<div class="err">請先貼上你的 Anthropic API 金鑰。</div>`);
    $('aiKey').focus();
    return;
  }
  const modelId = currentModelId();
  const ctrl = new AbortController();
  state.ai_running = ctrl;
  renderAiPanel(model);
  const started = Date.now();
  let phase = 'news';
  let newsLine = '抓個股新聞…';
  const paint = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    aiStatus(html`<div class="step${phase !== 'news' ? ' done' : ''}">${phase === 'news' ? html`<span class="spinner"></span>` : '✓'} ${newsLine}</div>
      ${phase !== 'news' ? html`<div class="step"><span class="spinner"></span> ${modelShort(modelId)} 分析中，通常要 30 秒到 2 分鐘…（已等 ${secs} 秒）</div>` : ''}`);
  };
  const timer = setInterval(paint, 1000);
  paint();
  try {
    const list = rows.map((r) => ({ key: holdingKey(r.market, r.code), market: r.market, code: r.code, name: r.name }));
    const { news, ok } = await fetchStockNews(list, {
      signal: ctrl.signal,
      onProgress: (done, total) => { newsLine = `抓個股新聞… ${done}/${total}`; paint(); },
    });
    if (ctrl.signal.aborted) throw Object.assign(new Error('aborted'), { kind: 'aborted', message: '已取消分析。' });
    newsLine = ok ? `個股新聞：${ok}/${list.length} 檔有抓到` : '個股新聞抓不到，略過（會告訴 AI 沒有個股新聞）';
    phase = 'ai';
    paint();
    const { result, cost, served } = await runAnalysis({ apiKey: key, model: modelId, payload: aiPayload(model, news), signal: ctrl.signal });
    const byCode = new Map(rows.map((r) => [r.code.toUpperCase(), holdingKey(r.market, r.code)]));
    const stocks = {};
    for (const s of result.stocks) {
      const k = byCode.get(s.code);
      if (k) stocks[k] = s;
    }
    state.ai = sanitizeAi({
      date: todayLocal(), at: new Date().toISOString(), model: modelId, served, stocks, portfolio: result.portfolio,
      cost, news, newsOk: ok, keys: list.map((x) => x.key),
    });
    save(KEYS.ai, state.ai);
    const missing = rows.length - Object.keys(stocks).length;
    aiStatus(html`<div class="okmsg">分析完成${cost ? html`，這次花費約 <b>US$${fmtNum(cost.usd, 4, 4)}</b>（NT$${ntd(cost.usd * fxForCost())}）` : ''}。結果已放進每檔的詳細卡與「整體組合建議」。${missing > 0 ? `（有 ${missing} 檔 AI 沒有回覆）` : ''}</div>`);
  } catch (err) {
    const msg = err?.kind === 'aborted' || err?.name === 'AbortError' ? '已取消分析。' : err?.message || '分析失敗，請稍後再試。';
    const cost = err?.cost ? html`<br><span class="muted">這次仍產生費用約 US$${fmtNum(err.cost.usd, 4, 4)}（NT$${ntd(err.cost.usd * fxForCost())}）。</span>` : '';
    aiStatus(html`<div class="err">${msg}${cost}</div>`);
  } finally {
    clearInterval(timer);
    state.ai_running = null;
    renderAll();
  }
}

// ---------- 交易紀錄 ----------

function nameOf(market, code) {
  const rec = state.records[holdingKey(market, code)];
  if (rec?.name) return rec.name;
  const row = findInIndex(state.index[market], code);
  return row ? row[1] : '';
}

function renderLog(model) {
  const errs = model.built.errors;
  setHtml($('logErrors'), errs.length ? html`<ul class="warn-list">${errs.map((e) => html`<li>⚠ ${e.message}</li>`)}</ul>` : '');
  if (!state.tx.length) {
    setHtml($('logBody'), html`<p class="empty">還沒有交易紀錄。</p>`);
    return;
  }
  const list = state.tx.map((t, i) => ({ t, i })).sort((a, b) => (a.t.date < b.t.date ? 1 : a.t.date > b.t.date ? -1 : b.i - a.i));
  setHtml($('logBody'), html`<div class="table-scroll" role="region" aria-label="交易紀錄（可左右捲動）" tabindex="0">
    <table class="data-table log-table">
      <thead><tr><th scope="col">日期</th><th class="c" scope="col">市場</th><th class="l" scope="col">代號</th><th class="l" scope="col">名稱</th><th class="c" scope="col">買賣</th><th scope="col">股數</th><th scope="col">價位</th><th scope="col">費用</th><th class="l" scope="col">券商</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead>
      <tbody>${list.map(({ t }) => {
        const cur = t.market === 'US' ? 'USD' : 'TWD';
        const fees = t.fee + t.tax + t.regFee;
        const detail = t.market === 'US' ? `佣金 ${fmtMoney(t.fee, cur)}、規費 ${fmtMoney(t.regFee, cur)}` : `手續費 ${fmtMoney(t.fee, cur)}、交易稅 ${fmtMoney(t.tax, cur)}`;
        return html`<tr>
          <td>${t.date}</td>
          <td class="c">${t.market === 'TW' ? '台股' : '美股'}</td>
          <td class="l">${t.code}</td>
          <td class="l nm-cell">${nameOf(t.market, t.code)}</td>
          <td class="c"><span class="${t.side === 'buy' ? 'side-buy' : 'side-sell'}">${t.side === 'buy' ? '買進' : '賣出'}</span></td>
          <td>${fmtShares(t.shares)}</td>
          <td>${fmtPrice(t.price, t.market)}</td>
          <td title="${t.feeIncluded ? '價位已含手續費' : detail}">${t.feeIncluded ? html`<span class="muted">已含</span>` : fmtMoney(fees, cur)}</td>
          <td class="l">${getBroker(t.broker, t.market).name}</td>
          <td class="act"><button type="button" class="btn" data-edit="${t.id}" aria-label="編輯 ${t.date} ${t.code}">編輯</button><button type="button" class="btn danger" data-del="${t.id}" aria-label="刪除 ${t.date} ${t.code}">刪除</button></td>
        </tr>`;
      })}</tbody>
    </table></div>`);
}

// ---------- 年度已實現損益 ----------

const MARKET_LABEL = { TW: '台股', US: '美股' };

function renderRealized(model) {
  const years = realizedByYear(model.built.realizedList);
  $('exportRealizedCsv').disabled = !years.length;
  if (!years.length) {
    setHtml($('realizedBody'), html`<p class="empty">還沒有賣出紀錄。</p>`);
    return;
  }
  const total = (m) => (m ? html`<b class="${dir(m.realized)}">${fmtMoney(m.realized, m.currency, { sign: true })}</b>` : html`<span class="muted">—</span>`);
  setHtml($('realizedBody'), years.map((y, i) => {
    const rows = ['TW', 'US'].flatMap((mk) => (y.markets[mk]?.stocks ?? []).map((s) => ({ mk, cur: y.markets[mk].currency, s })));
    return html`<details class="realized-year" data-year="${y.year}"${i === 0 ? html` open` : ''}>
      <summary><b>${y.year} 年</b><span>台股 ${total(y.markets.TW)}</span><span>美股 ${total(y.markets.US)}</span></summary>
      <div class="table-scroll" role="region" aria-label="${y.year} 年已實現損益明細（可左右捲動）" tabindex="0">
        <table class="data-table">
          <thead><tr><th class="c" scope="col">市場</th><th class="l" scope="col">代號</th><th class="l" scope="col">名稱</th><th scope="col">賣出筆數</th><th scope="col">股數</th><th scope="col">賣出淨收入</th><th scope="col">成本</th><th scope="col">賣出費用與稅</th><th scope="col">已實現損益</th></tr></thead>
          <tbody>${rows.map(({ mk, cur, s }) => html`<tr>
            <td class="c">${MARKET_LABEL[mk]}</td>
            <td class="l">${s.code}</td>
            <td class="l nm-cell">${nameOf(mk, s.code)}</td>
            <td>${s.count}</td>
            <td>${fmtShares(s.shares)}</td>
            <td>${fmtMoney(s.proceeds, cur)}</td>
            <td>${fmtMoney(s.costBasis, cur)}</td>
            <td>${fmtMoney(s.sellCosts, cur)}</td>
            <td class="${dir(s.realized)}">${fmtMoney(s.realized, cur, { sign: true })}</td>
          </tr>`)}</tbody>
        </table>
      </div>
    </details>`;
  }));
}

// ---------- 全部重畫 ----------

function renderAll() {
  const model = compute();
  state.model = model;
  const rows = sortedRows(model);
  renderOverview(model);
  renderAllocation(model);
  renderTable(model, rows);
  renderCards(model, rows);
  renderAdvice(model);
  renderAiPanel(model);
  renderRealized(model);
  renderLog(model);
  layoutScales();
}

// 手動價格只在沒有每日收盤價時使用；收盤價回來了就刪掉，免得之後資料又失敗時用到舊價。
function pruneManual() {
  const stale = Object.keys(state.manual).filter((k) => Number(state.records[k]?.close) > 0);
  for (const k of stale) delete state.manual[k];
  if (stale.length) save(KEYS.manual, state.manual);
}

function holdingItems() {
  const map = new Map();
  for (const t of state.tx) map.set(holdingKey(t.market, t.code), { market: t.market, code: t.code });
  return [...map.values()];
}

async function refreshRecords() {
  if (state.meta) {
    const recs = await loadRecords(holdingItems());
    Object.assign(state.records, recs);
    pruneManual();
  }
  renderBanner();
  renderAll();
}

async function loadData({ retry = false } = {}) {
  if (retry) {
    for (const m of ['TW', 'US']) {
      if (state.index[m] === null) {
        delete state.index[m];
        delete indexFailedAt[m];
      }
    }
  }
  try {
    state.meta = await loadMeta({ retry });
    state.metaError = null;
  } catch (err) {
    state.meta = null;
    state.metaError = err;
  }
  renderHeader();
  renderFooter();
  await refreshRecords();
}

// ---------- 新增交易表單 ----------

const form = { results: [], active: -1, row: null };
const marketNow = () => document.querySelector('input[name="market"]:checked')?.value === 'US' ? 'US' : 'TW';
const sideNow = () => (document.querySelector('input[name="side"]:checked')?.value === 'sell' ? 'sell' : 'buy');

// 代號清單：成功才快取；失敗記下時間，5 秒後（或按「重試」）再載。
const indexFailedAt = {};
async function ensureIndex(market) {
  if (state.index[market] == null && !(Date.now() - (indexFailedAt[market] ?? 0) < 5000)) {
    const rows = await loadIndex(market);
    if (rows) {
      state.index[market] = rows;
      delete indexFailedAt[market];
    } else if (!state.index[market]) {
      state.index[market] = null;
      indexFailedAt[market] = Date.now();
    }
  }
  return state.index[market] ?? null;
}

function brokerSummary(b) {
  if (b.market === 'TW') {
    const disc = Math.round(b.discount * 1000) / 100;
    return `手續費 0.1425% × ${disc === 10 ? '不打折' : `${disc} 折`}，整股最低 ${b.minFee} 元、零股最低 ${b.oddLotMinFee ?? b.minFee} 元；${b.rebate}${b.rebate === '月退' ? '（成本以折扣後計）' : ''}`;
  }
  if (b.model === 'zero') return '零佣金；賣出另收 SEC 規費';
  if (b.model === 'per_share') return `每股 US$${b.perShare}、每筆最低 US$${b.minFee}${b.maxPct != null ? `、最高成交金額 ${fmtNum(b.maxPct * 100, 0, 2)}%` : ''}；賣出另收規費`;
  return `成交金額 ${fmtNum(b.rate * 100, 2, 3)}%${b.minFee ? `、最低 US$${b.minFee}` : ''}${b.etfFlat != null ? `；ETF 每筆 US$${b.etfFlat}` : ''}；賣出另收規費`;
}

// 下拉選單的券商名稱：有自訂值時標出實際折數，避免和預設名稱矛盾。
function brokerLabel(b) {
  const o = state.settings.brokerOverrides[b.id];
  const custom = !o ? '' : b.market === 'TW' && isNum(o.discount) ? `・自訂 ${round6(o.discount * 10)} 折` : '・自訂費率';
  return `${b.name}${custom}${b.confidence === 'low' ? '（僅供參考）' : ''}`;
}

function fillBrokerSelect(select, market, selected) {
  setHtml(select, brokersFor(market).map((b) => html`<option value="${b.id}"${b.id === selected ? html` selected` : ''}>${brokerLabel(b)}</option>`));
}

function updateBrokerHint() {
  const b = getBroker($('fBroker').value, marketNow(), state.settings.brokerOverrides);
  const low = b.confidence === 'low' ? '預設值僅供參考，請到「設定」改成你的實際費率。' : '';
  $('brokerHint').textContent = `${brokerSummary(b)}${low ? `。${low}` : ''}`;
}

function setFormMarket(market, { keepCode = false } = {}) {
  document.querySelectorAll('input[name="market"]').forEach((i) => { i.checked = i.value === market; });
  fillBrokerSelect($('fBroker'), market, market === 'US' ? state.settings.usBroker : state.settings.twBroker);
  $('fShares').step = market === 'US' ? 'any' : '1';
  $('fShares').inputMode = market === 'US' ? 'decimal' : 'numeric';
  $('sharesHint').textContent = market === 'US' ? '美股以股計，可輸入小數股' : '1 張 = 1000 股，可輸入零股';
  $('fCode').placeholder = market === 'US' ? '例：AAPL 或 Apple' : '例：2330 或 台積電';
  if (!keepCode) {
    $('fCode').value = '';
    form.row = null;
    $('codeInfo').textContent = '';
    $('priceHint').textContent = '';
  }
  closeList();
  updateBrokerHint();
}

function typeFor(market, code) {
  const rec = state.records[holdingKey(market, code)];
  if (rec?.type) return rec.type;
  const row = findInIndex(state.index[market], code);
  if (row?.[2]) return row[2];
  return market === 'TW' ? inferTwType(code) : 'stock';
}

function codeFromText(text, market) {
  const rows = state.index[market];
  const t = String(text ?? '').trim();
  const exact = findInIndex(rows, t);
  if (exact) return exact[0];
  const byName = Array.isArray(rows) ? rows.find((r) => r[1] === t) : null;
  return byName ? byName[0] : normalizeCode(t);
}

function readForm() {
  const market = marketNow();
  const code = codeFromText($('fCode').value, market);
  const num = (el) => (el.value === '' ? NaN : Number(el.value));
  return {
    market, side: sideNow(), code,
    shares: num($('fShares')), price: num($('fPrice')),
    date: $('fDate').value, broker: $('fBroker').value, feeIncluded: $('fFeeIncluded').checked,
    type: code ? typeFor(market, code) : 'stock',
  };
}

function renderPreview() {
  const v = readForm();
  const box = $('feePreview');
  if (!(v.shares > 0) || !(v.price > 0)) {
    box.textContent = '';
    return;
  }
  const overrides = state.settings.brokerOverrides;
  const c = tradeCosts({ market: v.market, side: v.side, price: v.price, shares: v.shares, type: v.type, code: v.code, date: v.date, broker: v.broker, brokerOverrides: overrides });
  const cur = c.currency;
  const m = (n) => fmtMoney(n, cur);
  const b = getBroker(v.broker, v.market, overrides);
  const items = [['成交金額', m(c.amount)]];
  if (v.market === 'TW') {
    items.push(['手續費', m(c.fee)]);
    items.push(['交易稅', v.side === 'sell' ? m(c.tax) : '—']);
  } else {
    items.push(['佣金', m(c.fee)]);
    items.push(['規費', v.side === 'sell' ? `${m(c.regFee)}（SEC ${m(c.secFee)}、TAF ${m(c.taf)}）` : '—']);
  }
  items.push(['合計費用', m(c.total)]);
  items.push([v.side === 'buy' ? '買進總成本' : '賣出實收', v.feeIncluded ? m(c.amount) : m(c.net)]);
  const notes = [];
  if (v.feeIncluded) notes.push(html`<p class="note warn">價位已含手續費：成本直接以「價位 × 股數」計，不另加上面試算的費用。</p>`);
  if (v.market === 'TW' && b.rebate === '月退' && !v.feeIncluded) {
    const full = tradeCosts({ market: 'TW', side: v.side, price: v.price, shares: v.shares, type: v.type, code: v.code, date: v.date, broker: v.broker,
      brokerOverrides: { ...overrides, [b.id]: { ...(overrides[b.id] ?? {}), discount: 1 } } }).fee;
    if (full !== c.fee) notes.push(html`<p class="note">月退：下單時先收原價手續費 ${m(full)}，月底退回差額；成本以折扣後的 ${m(c.fee)} 計。</p>`);
  }
  if (v.market === 'TW' && v.side === 'sell' && v.type === 'bond_etf') {
    notes.push(html`<p class="note">債券 ETF 證交稅停徵到 ${BOND_ETF_EXEMPT_UNTIL}；之後的賣出先以 0.1% 估（延長案尚未三讀）。</p>`);
  }
  if (b.confidence === 'low') notes.push(html`<p class="note">這家券商的預設費率僅供參考，請到「設定」改成你的實際折數。</p>`);
  setHtml(box, html`<dl>${items.map(([k, val]) => html`<div><dt>${k}</dt><dd>${val}</dd></div>`)}</dl>${notes}`);
}

function closeList() {
  $('codeList').hidden = true;
  $('fCode').setAttribute('aria-expanded', 'false');
  $('fCode').removeAttribute('aria-activedescendant');
  form.results = [];
  form.active = -1;
}

function paintList() {
  const list = $('codeList');
  setHtml(list, form.results.length
    ? form.results.map((r, i) => html`<li role="option" id="codeOpt${i}" data-i="${i}" aria-selected="${String(i === form.active)}"><b>${r[0]}</b><span class="nm">${r[1]}</span><span class="ty">${TYPE_LABEL[r[2]] ?? ''}</span></li>`)
    : html`<li class="none" role="option" aria-disabled="true" aria-selected="false">找不到符合的代號</li>`);
  list.hidden = false;
  $('fCode').setAttribute('aria-expanded', 'true');
  if (form.active >= 0) $('fCode').setAttribute('aria-activedescendant', `codeOpt${form.active}`);
  else $('fCode').removeAttribute('aria-activedescendant');
}

async function updateSuggestions() {
  const market = marketNow();
  const text = $('fCode').value.trim();
  if (!text) { closeList(); return; }
  const rows = await ensureIndex(market);
  if ($('fCode').value.trim() !== text || marketNow() !== market || document.activeElement !== $('fCode')) return;
  if (!rows) {
    closeList();
    $('codeInfo').textContent = '代號清單載入失敗，無法自動完成；仍可直接輸入代號。';
    $('codeInfo').className = 'hint warn';
    return;
  }
  if ($('codeInfo').textContent.startsWith('代號清單載入失敗')) $('codeInfo').textContent = '';
  form.results = searchIndex(rows, text);
  form.active = form.results.length ? 0 : -1;
  paintList();
}

function pickSuggestion(i) {
  const r = form.results[i];
  if (!r) return;
  $('fCode').value = r[0];
  closeList();
  resolveCode();
}

async function resolveCode() {
  const market = marketNow();
  const input = $('fCode');
  const info = $('codeInfo');
  const rows = await ensureIndex(market);
  const text = input.value.trim();
  if (!text) {
    info.textContent = '';
    form.row = null;
    $('priceHint').textContent = '';
    renderPreview();
    return;
  }
  let row = findInIndex(rows, text) ?? (Array.isArray(rows) ? rows.find((r) => r[1] === text) : null);
  if (row && input.value !== row[0]) input.value = row[0];
  form.row = row ?? null;
  const code = row ? row[0] : normalizeCode(text);
  if (row) {
    info.textContent = `${row[1]}・${TYPE_LABEL[row[2]] ?? ''}`;
    info.className = 'hint ok';
  } else if (!rows) {
    info.textContent = '無法載入代號清單，無法確認代號是否正確。';
    info.className = 'hint warn';
  } else if (!CODE_PATTERN[market].test(code)) {
    info.textContent = market === 'TW' ? '台股代號是 4～6 碼數字，可加一個英文字母（例如 00679B）。' : '美股代號是英文字母（例如 AAPL、BRK.B）。';
    info.className = 'hint warn';
  } else {
    info.textContent = `每日資料裡找不到「${code}」：仍可加入，但沒有收盤價，之後要在持股明細手動輸入價格。`;
    info.className = 'hint warn';
  }
  $('priceHint').textContent = '';
  if (row && state.meta) {
    const recs = await loadRecords([{ market, code }]);
    Object.assign(state.records, recs);
    const rec = recs[holdingKey(market, code)];
    if (rec && isNum(rec.close) && codeFromText(input.value, marketNow()) === code) {
      setHtml($('priceHint'), html`最新收盤 ${fmtPrice(rec.close, market)}（${rec.date ?? (market === 'TW' ? state.meta.tw?.asOf : state.meta.us?.asOf) ?? ''}）<button type="button" class="btn fill-price" data-fill-price="${rec.close}">帶入</button>`);
    }
  }
  renderPreview();
}

function formError(el, msg) {
  if (el) {
    el.setAttribute('aria-invalid', 'true');
    el.focus();
  }
  const m = $('formMsg');
  m.textContent = msg;
  m.className = 'form-msg error';
}

// 某天（含當天先輸入的交易）持有的股數
function sharesOn(list, market, code, date) {
  const { holdings } = buildHoldings(list.filter((t) => t.market === market && t.code === code && t.date <= date));
  return holdings[0]?.shares ?? 0;
}

// 套用這次新增、修改或刪除後重算，回傳原本沒有的錯誤（例如後面的賣出變成持股不足）。
function newTradeErrors(candidate) {
  const left = buildHoldings(state.tx).errors.map((e) => e.message);
  return buildHoldings(candidate).errors.filter((e) => {
    if (/^第 \d+ 筆交易/.test(e.message)) return false;
    const i = left.indexOf(e.message);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}
const errText = (e) => e.message.replace(/，已(略過|以 .+ 股計算)$/, '');

async function submitTrade(e) {
  e.preventDefault();
  document.querySelectorAll('#tradeForm [aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  await ensureIndex(marketNow());
  const v = readForm();
  const today = todayLocal();
  if (!v.code) return formError($('fCode'), '請輸入代號。');
  if (!CODE_PATTERN[v.market].test(v.code)) {
    return formError($('fCode'), v.market === 'TW' ? '台股代號是 4～6 碼數字，可加一個英文字母（例如 00679B）。' : '美股代號是英文字母（例如 AAPL、BRK.B）。');
  }
  if ($('fShares').validity.badInput || !(v.shares > 0)) return formError($('fShares'), '股數要大於 0。');
  if (v.market === 'TW' && !Number.isInteger(v.shares)) return formError($('fShares'), '台股股數要是整數（1 張 = 1000 股）。');
  if (v.shares > 1e9) return formError($('fShares'), '股數太大，請確認。');
  if ($('fPrice').validity.badInput || !Number.isFinite(v.price) || v.price < 0) return formError($('fPrice'), '請輸入價位（0 以上的數字）。');
  if (!validDate(v.date)) return formError($('fDate'), '請選擇日期。');
  if (v.date > today) return formError($('fDate'), '日期不能晚於今天。');
  const editing = state.editingId;
  if (v.side === 'sell') {
    // 依賣出日期當時的持股判斷（交易依日期重算，賣在買進之前會被略過）
    const others = state.tx.filter((t) => t.id !== editing);
    const held = sharesOn(others, v.market, v.code, v.date);
    if (v.shares > held + 1e-9) {
      const when = v.date === today ? '目前' : `${v.date} 當時`;
      const later = sharesOn(others, v.market, v.code, today) >= v.shares;
      return formError(later ? $('fDate') : $('fShares'), held > 0
        ? `${when}只持有 ${fmtShares(held)} 股 ${v.code}，不能賣出 ${fmtShares(v.shares)} 股。${later ? '賣出日期要在買進之後。' : ''}`
        : `${when}沒有持有 ${v.code}，不能賣出。${later ? '賣出日期要在買進之後。' : ''}`);
    }
  }
  const c = tradeCosts({ market: v.market, side: v.side, price: v.price, shares: v.shares, type: v.type, code: v.code, date: v.date,
    broker: v.broker, brokerOverrides: state.settings.brokerOverrides });
  const tx = sanitizeTx({
    id: editing ?? newId(), market: v.market, code: v.code, side: v.side, shares: v.shares, price: v.price, date: v.date,
    feeIncluded: v.feeIncluded, fee: c.fee, tax: c.tax, regFee: c.regFee, broker: c.broker,
  });
  const i = editing ? state.tx.findIndex((t) => t.id === editing) : -1;
  const candidate = i >= 0 ? state.tx.map((t, j) => (j === i ? tx : t)) : [...state.tx, tx];
  const broken = newTradeErrors(candidate);
  if (broken.length) {
    return formError(null, `這筆${editing ? '修改' : '交易'}會讓其他交易對不上：${errText(broken[0])}。請確認日期與股數，或先修改那筆賣出。`);
  }
  state.tx = candidate;
  saveTx();
  const name = nameOf(v.market, v.code);
  const known = Boolean(form.row) || Boolean(state.records[holdingKey(v.market, v.code)]);
  const msg = `${editing ? '已修改' : '已加入'}：${v.side === 'buy' ? '買進' : '賣出'} ${v.code}${name ? ` ${name}` : ''} ${fmtShares(v.shares)} 股 @ ${fmtPrice(v.price, v.market)}${v.price === 0 ? '（價位 0，例如配股）' : ''}${known ? '' : '。這檔沒有每日資料，請在持股明細輸入手動價格'}`;
  if (editing) resetForm();
  else {
    $('fCode').value = '';
    $('fShares').value = '';
    $('fPrice').value = '';
    $('codeInfo').textContent = '';
    $('priceHint').textContent = '';
    form.row = null;
    renderPreview();
  }
  const m = $('formMsg');
  m.textContent = msg;
  m.className = 'form-msg ok';
  await refreshRecords();
}

function startEdit(id) {
  const t = state.tx.find((x) => x.id === id);
  if (!t) return;
  state.editingId = id;
  setFormMarket(t.market);
  $('fCode').value = t.code;
  document.querySelectorAll('input[name="side"]').forEach((i) => { i.checked = i.value === t.side; });
  $('fShares').value = String(t.shares);
  $('fPrice').value = String(t.price);
  $('fDate').value = t.date;
  if (brokersFor(t.market).some((b) => b.id === t.broker)) $('fBroker').value = t.broker;
  $('fFeeIncluded').checked = t.feeIncluded;
  $('submitBtn').textContent = '儲存修改';
  $('cancelEdit').hidden = false;
  $('editBadge').hidden = false;
  $('formMsg').textContent = `正在修改 ${t.date} ${t.code} 的交易；改完按「儲存修改」。`;
  $('formMsg').className = 'form-msg ok';
  updateBrokerHint();
  resolveCode();
  $('trade').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('fCode').focus({ preventScroll: true });
}

function stopEditing() {
  state.editingId = null;
  $('submitBtn').textContent = '加入';
  $('cancelEdit').hidden = true;
  $('editBadge').hidden = true;
}

// 離開修改模式時清空表單（日期回到今天、買進、預設券商），避免按「加入」又新增一筆一樣的交易。
function resetForm() {
  stopEditing();
  document.querySelectorAll('#tradeForm [aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  document.querySelectorAll('input[name="side"]').forEach((i) => { i.checked = i.value === 'buy'; });
  $('fShares').value = '';
  $('fPrice').value = '';
  $('fDate').value = todayLocal();
  $('fFeeIncluded').checked = false;
  setFormMarket(marketNow());
  renderPreview();
}

function deleteTx(id) {
  const t = state.tx.find((x) => x.id === id);
  if (!t) return;
  const rest = state.tx.filter((x) => x.id !== id);
  const broken = newTradeErrors(rest);
  const warn = broken.length
    ? `\n\n注意：刪除後其他交易會對不上：${errText(broken[0])}${broken.length > 1 ? `（共 ${broken.length} 筆）` : ''}。` : '';
  if (!window.confirm(`確定刪除 ${t.date} ${t.side === 'buy' ? '買進' : '賣出'} ${t.code} ${fmtShares(t.shares)} 股？${warn}`)) return;
  state.tx = rest;
  if (state.editingId === id) resetForm();
  saveTx();
  renderAll();
  toast('已刪除一筆交易');
}

// ---------- 匯出、匯入 ----------

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportJson() {
  const data = {
    app: '持倉分析', schema: 1, exportedAt: new Date().toISOString(),
    transactions: state.tx, cash: state.cash, settings: state.settings, stops: state.stops, manualPrices: state.manual,
  };
  download(`持倉分析備份-${todayLocal()}.json`, `${JSON.stringify(data, null, 2)}\n`, 'application/json');
  toast('已匯出備份（不含 API 金鑰）');
}

function csvField(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const head = ['日期', '市場', '代號', '名稱', '買賣', '股數', '價位', '手續費', '交易稅', '規費', '價位已含手續費', '券商', '幣別'];
  const lines = [...state.tx].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).map((t) => [
    t.date, t.market === 'TW' ? '台股' : '美股', t.code, nameOf(t.market, t.code), t.side === 'buy' ? '買進' : '賣出',
    t.shares, t.price, t.fee, t.tax, t.regFee, t.feeIncluded ? '是' : '否', getBroker(t.broker, t.market).name, t.market === 'US' ? 'USD' : 'TWD',
  ]);
  const csv = [head, ...lines].map((row) => row.map(csvField).join(',')).join('\r\n');
  download(`持倉分析交易紀錄-${todayLocal()}.csv`, `﻿${csv}\r\n`, 'text/csv;charset=utf-8');
}

function exportRealizedCsv() {
  const head = ['年度', '市場', '代號', '名稱', '賣出筆數', '股數', '賣出淨收入', '成本', '賣出費用與稅', '已實現損益', '幣別'];
  const lines = realizedByYear(buildHoldings(state.tx).realizedList).flatMap((y) => ['TW', 'US'].flatMap((mk) => {
    const m = y.markets[mk];
    return (m?.stocks ?? []).map((s) => [y.year, MARKET_LABEL[mk], s.code, nameOf(mk, s.code), s.count, s.shares,
      s.proceeds, s.costBasis, s.sellCosts, s.realized, m.currency]);
  }));
  const csv = [head, ...lines].map((row) => row.map(csvField).join(',')).join('\r\n');
  download(`持倉分析年度已實現損益-${todayLocal()}.csv`, `﻿${csv}\r\n`, 'text/csv;charset=utf-8');
}

async function importJson(file) {
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('檔案太大（超過 5 MB），不像是本站的備份檔。');
    let data;
    try {
      data = JSON.parse((await file.text()).replace(/^﻿/, ''));
    } catch {
      throw new Error('檔案不是有效的 JSON。');
    }
    const list = Array.isArray(data) ? data : data?.transactions;
    if (!Array.isArray(list)) throw new Error('檔案裡找不到交易紀錄（transactions）。');
    const { txs, bad } = sanitizeTxList(list, { strict: true });
    if (!txs.length && list.length) throw new Error(`${list.length} 筆交易都格式不正確，沒有匯入。`);
    const msg = `匯入 ${txs.length} 筆交易${bad.length ? `（略過 ${bad.length} 筆格式不正確或不合理，例如台股非整數股、未來日期：第 ${bad.slice(0, 5).join('、')}${bad.length > 5 ? '…' : ''} 筆）` : ''}，會取代目前的 ${state.tx.length} 筆交易與現金、設定。確定嗎？`;
    if (!window.confirm(msg)) return;
    state.tx = txs;
    if (!Array.isArray(data)) {
      if (data.cash) state.cash = sanitizeCash(data.cash);
      if (data.settings) state.settings = sanitizeSettings(data.settings);
      if (data.stops) state.stops = sanitizePriceMap(data.stops);
      if (data.manualPrices) state.manual = sanitizePriceMap(data.manualPrices);
    }
    save(KEYS.tx, state.tx);
    save(KEYS.cash, state.cash);
    save(KEYS.settings, state.settings);
    save(KEYS.stops, state.stops);
    save(KEYS.manual, state.manual);
    stopEditing();
    syncCashInputs();
    setFormMarket(marketNow());
    toast(`已匯入 ${txs.length} 筆交易`);
    await refreshRecords();
  } catch (err) {
    window.alert(`匯入失敗：${err.message}`);
  }
}

function syncCashInputs() {
  $('cashTWD').value = state.cash.twd ? String(state.cash.twd) : '';
  $('cashUSD').value = state.cash.usd ? String(state.cash.usd) : '';
}

// ---------- 設定 ----------

const presetOf = (id, market) => getBroker(id, market);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function noteHtml(b) {
  return html`${b.note}${b.confidence === 'low' ? '（預設值僅供參考）' : ''}${b.rebate === '月退' ? ' 月退：下單時先收原價手續費，月底退回差額，成本以折扣後計。' : ''} 查證日 ${b.asOf}${b.source ? html`・${extLink(b.source, '出處')}` : ''}`;
}

function fillTwFields(id, { preset = false } = {}) {
  const b = preset ? presetOf(id, 'TW') : getBroker(id, 'TW', state.settings.brokerOverrides);
  $('sTwDiscount').value = String(round6(b.discount * 10));
  $('sTwMin').value = String(b.minFee);
  $('sTwOdd').value = String(b.oddLotMinFee ?? b.minFee);
  setHtml($('sTwNote'), noteHtml(b));
}

function fillUsFields(id, { preset = false } = {}) {
  const b = preset ? presetOf(id, 'US') : getBroker(id, 'US', state.settings.brokerOverrides);
  const show = { rate: b.model === 'percent', perShare: b.model === 'per_share', minFee: b.model !== 'zero' };
  document.querySelectorAll('#sUsFields [data-us]').forEach((el) => { el.hidden = !show[el.dataset.us]; });
  $('sUsRate').value = String(round6((b.rate ?? 0) * 100));
  $('sUsPerShare').value = String(b.perShare ?? 0);
  $('sUsMin').value = String(b.minFee ?? 0);
  setHtml($('sUsNote'), html`${b.model === 'zero' ? '零佣金，不需要設定費率。' : ''}${noteHtml(b)}`);
}

function openSettings() {
  fillBrokerSelect($('sTwBroker'), 'TW', state.settings.twBroker);
  fillBrokerSelect($('sUsBroker'), 'US', state.settings.usBroker);
  fillTwFields(state.settings.twBroker);
  fillUsFields(state.settings.usBroker);
  $('sStopPct').value = String(round6(state.settings.stopPct * 100));
  $('settingsMsg').textContent = '';
  const dlg = $('settingsDialog');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function settingsError(el, msg) {
  $('settingsMsg').textContent = msg;
  $('settingsMsg').className = 'form-msg error';
  el?.focus();
  return false;
}

function saveSettings() {
  const num = (id) => ($(id).value === '' ? NaN : Number($(id).value));
  const twId = $('sTwBroker').value;
  const usId = $('sUsBroker').value;
  const disc = num('sTwDiscount');
  const min = num('sTwMin');
  const odd = num('sTwOdd');
  const stop = num('sStopPct');
  if (!(disc >= 0.1 && disc <= 10)) return settingsError($('sTwDiscount'), '折數要在 0.1 到 10 之間（6 = 6 折，不打折填 10）。');
  if (!(min >= 0 && min <= 1000)) return settingsError($('sTwMin'), '整股最低手續費要是 0 到 1000 元。');
  if (!(odd >= 0 && odd <= 1000)) return settingsError($('sTwOdd'), '零股最低手續費要是 0 到 1000 元。');
  if (!(stop >= 1 && stop <= 50)) return settingsError($('sStopPct'), '預設停損要在 1% 到 50% 之間。');
  const overrides = { ...state.settings.brokerOverrides };
  const twBase = presetOf(twId, 'TW');
  const tw = {};
  if (round6(disc / 10) !== round6(twBase.discount)) tw.discount = round6(disc / 10);
  if (min !== twBase.minFee) tw.minFee = min;
  if (odd !== (twBase.oddLotMinFee ?? twBase.minFee)) tw.oddLotMinFee = odd;
  if (Object.keys(tw).length) overrides[twId] = tw; else delete overrides[twId];

  const usBase = presetOf(usId, 'US');
  const us = {};
  if (usBase.model === 'percent') {
    const rate = num('sUsRate');
    if (!(rate >= 0 && rate <= 5)) return settingsError($('sUsRate'), '美股費率要在 0% 到 5% 之間。');
    if (round6(rate / 100) !== round6(usBase.rate)) us.rate = round6(rate / 100);
  }
  if (usBase.model === 'per_share') {
    const ps = num('sUsPerShare');
    if (!(ps >= 0 && ps <= 1)) return settingsError($('sUsPerShare'), '每股費用要在 0 到 1 美元之間。');
    if (ps !== usBase.perShare) us.perShare = ps;
  }
  if (usBase.model !== 'zero') {
    const m = num('sUsMin');
    if (!(m >= 0 && m <= 100)) return settingsError($('sUsMin'), '每筆最低要在 0 到 100 美元之間。');
    if (m !== usBase.minFee) us.minFee = m;
  }
  if (Object.keys(us).length) overrides[usId] = us; else delete overrides[usId];

  state.settings = sanitizeSettings({ twBroker: twId, usBroker: usId, stopPct: stop / 100, brokerOverrides: overrides });
  save(KEYS.settings, state.settings);
  if (!state.editingId) setFormMarket(marketNow(), { keepCode: true });
  updateBrokerHint();
  renderPreview();
  renderAll();
  toast('設定已儲存');
  return true;
}

// ---------- 主題 ----------

function applyTheme(t) {
  const v = t === 'light' || t === 'dark' ? t : 'auto';
  if (v === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === v)));
}

// ---------- 事件 ----------

function bind() {
  applyTheme(loadRaw(KEYS.theme));

  // AI 面板
  setHtml($('aiModel'), MODELS.map((m) => html`<option value="${m.id}">${m.label}${m.id === DEFAULT_MODEL ? '（預設）' : ''}</option>`));
  const savedModel = loadRaw(KEYS.aiModel);
  $('aiModel').value = MODELS.some((m) => m.id === savedModel) ? savedModel : DEFAULT_MODEL;
  $('aiKey').value = loadRaw(KEYS.aiKey) ?? '';
  $('aiModel').addEventListener('change', () => {
    saveRaw(KEYS.aiModel, currentModelId());
    if (state.model) renderAiPanel(state.model);
  });
  $('aiKey').addEventListener('input', debounce(() => saveRaw(KEYS.aiKey, $('aiKey').value.trim()), 300));
  $('aiKey').addEventListener('change', () => saveRaw(KEYS.aiKey, $('aiKey').value.trim()));
  $('aiKeyToggle').addEventListener('click', () => {
    const show = $('aiKey').type === 'password';
    $('aiKey').type = show ? 'text' : 'password';
    $('aiKeyToggle').textContent = show ? '隱藏' : '顯示';
    $('aiKeyToggle').setAttribute('aria-pressed', String(show));
  });
  $('aiKeyClear').addEventListener('click', () => {
    $('aiKey').value = '';
    saveRaw(KEYS.aiKey, null);
    toast('已清除這個瀏覽器裡的 API 金鑰');
  });
  $('aiRun').addEventListener('click', runAi);
  $('aiCancel').addEventListener('click', () => state.ai_running?.abort());
  $('aiClear').addEventListener('click', () => {
    if (!state.ai || !window.confirm('清除所有 AI 分析結果？')) return;
    state.ai = null;
    save(KEYS.ai, null);
    aiStatus('');
    renderAll();
  });

  // 新增交易
  $('fDate').value = todayLocal();
  $('fDate').max = todayLocal();
  setFormMarket('TW');
  document.querySelectorAll('input[name="market"]').forEach((i) => i.addEventListener('change', () => {
    setFormMarket(marketNow());
    renderPreview();
  }));
  document.querySelectorAll('input[name="side"]').forEach((i) => i.addEventListener('change', renderPreview));
  ['fShares', 'fPrice', 'fDate'].forEach((id) => $(id).addEventListener('input', () => {
    $(id).removeAttribute('aria-invalid');
    renderPreview();
  }));
  $('fFeeIncluded').addEventListener('change', renderPreview);
  $('fBroker').addEventListener('change', () => { updateBrokerHint(); renderPreview(); });
  const suggest = debounce(updateSuggestions, 80);
  $('fCode').addEventListener('input', () => {
    $('fCode').removeAttribute('aria-invalid');
    form.row = null;
    suggest();
    renderPreview();
  });
  $('fCode').addEventListener('focus', () => ensureIndex(marketNow()));
  $('fCode').addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 注音、拼音選字中的 Enter 不是選建議
    const open = !$('codeList').hidden && form.results.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) { updateSuggestions(); return; }
      e.preventDefault();
      const n = form.results.length;
      form.active = (form.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      paintList();
    } else if (e.key === 'Enter' && open && form.active >= 0) {
      e.preventDefault();
      pickSuggestion(form.active);
    } else if (e.key === 'Escape' && !$('codeList').hidden) {
      e.preventDefault();
      closeList();
    }
  });
  $('fCode').addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== $('fCode')) {
      closeList();
      resolveCode();
    }
  }, 150));
  // pointerdown 只用來保住輸入框焦點；等 click 才選，觸控滑動捲動清單時不會誤選。
  $('codeList').addEventListener('pointerdown', (e) => {
    if (e.target.closest('li[data-i]')) e.preventDefault();
  });
  $('codeList').addEventListener('click', (e) => {
    const item = e.target.closest('li[data-i]');
    if (item) pickSuggestion(Number(item.dataset.i));
  });
  $('tradeForm').addEventListener('submit', submitTrade);
  $('cancelEdit').addEventListener('click', () => {
    resetForm();
    $('formMsg').textContent = '已取消修改。';
    $('formMsg').className = 'form-msg ok';
  });

  // 現金
  syncCashInputs();
  const cashChanged = debounce(() => {
    state.cash = sanitizeCash({ twd: $('cashTWD').value, usd: $('cashUSD').value });
    save(KEYS.cash, state.cash);
    renderAll();
  }, 300);
  $('cashTWD').addEventListener('input', cashChanged);
  $('cashUSD').addEventListener('input', cashChanged);

  // 設定
  $('openSettings').addEventListener('click', openSettings);
  $('sTwBroker').addEventListener('change', () => fillTwFields($('sTwBroker').value));
  $('sUsBroker').addEventListener('change', () => fillUsFields($('sUsBroker').value));
  $('settingsReset').addEventListener('click', () => {
    fillTwFields($('sTwBroker').value, { preset: true });
    fillUsFields($('sUsBroker').value, { preset: true });
    $('settingsMsg').textContent = '已填回券商預設值，按「儲存」後生效。';
    $('settingsMsg').className = 'form-msg ok';
  });
  $('settingsCancel').addEventListener('click', () => $('settingsDialog').close());
  $('settingsForm').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'save' && !saveSettings()) e.preventDefault();
  });

  // 備份
  $('exportJson').addEventListener('click', exportJson);
  $('exportCsv').addEventListener('click', exportCsv);
  $('exportRealizedCsv').addEventListener('click', exportRealizedCsv);
  $('importFile').addEventListener('change', async (e) => {
    await importJson(e.target.files?.[0]);
    e.target.value = '';
  });

  // 委派：按鈕
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a, [data-goto]');
    const d = t?.dataset ?? {};
    if (d.themeSet) {
      saveRaw(KEYS.theme, d.themeSet === 'auto' ? null : d.themeSet);
      applyTheme(d.themeSet);
      requestAnimationFrame(layoutScales);
    } else if (d.alloc) {
      state.alloc = d.alloc === 'industry' ? 'industry' : 'stock';
      saveUi();
      renderAllocation(state.model);
    } else if (d.sort) {
      const col = COLS.find((c) => c.key === d.sort);
      if (state.sort.key === d.sort) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else state.sort = { key: d.sort, dir: col?.cls === 'l' || d.sort === 'action' ? 'asc' : 'desc' };
      saveUi();
      renderAll();
    } else if (d.goto) {
      gotoCard(d.goto);
    } else if (d.clearManual) {
      if (!window.confirm(`清除 ${d.clearManual.split(':')[1]} 的手動價格？`)) return;
      delete state.manual[d.clearManual];
      save(KEYS.manual, state.manual);
      renderAll();
    } else if (d.stopSave) {
      const input = document.querySelector(`input[data-stop="${CSS.escape(d.stopSave)}"]`);
      setStop(d.stopSave, input?.value ?? '');
    } else if (d.stopClear) {
      setStop(d.stopClear, '');
    } else if (d.stopPin) {
      setStop(d.stopPin, d.value ?? '');
    } else if (d.edit) {
      startEdit(d.edit);
    } else if (d.del) {
      deleteTx(d.del);
    } else if (d.fillPrice) {
      $('fPrice').value = d.fillPrice;
      renderPreview();
    } else if (d.action === 'retry-data') {
      loadData({ retry: true });
    } else if (!t || t.tagName === 'A') {
      // 點持股表的一列 → 跳到詳細卡
      const tr = e.target.closest('.holdings-table tbody tr[data-key]');
      if (tr && !e.target.closest('input, button, a')) gotoCard(tr.dataset.key);
    }
  });

  // 委派：手動價格、停損輸入
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset?.manual) {
      const v = Number(el.value);
      if (el.value !== '' && v > 0 && Number.isFinite(v)) {
        state.manual[el.dataset.manual] = v;
        save(KEYS.manual, state.manual);
        renderAll();
      } else if (el.value !== '') toast('手動價格要是大於 0 的數字');
    } else if (el.dataset?.stop) {
      setStop(el.dataset.stop, el.value);
    }
  });

  $('cards').addEventListener('toggle', (e) => {
    const card = e.target.closest?.('details.stock-card');
    if (!card || e.target !== card) return;
    if (card.open) {
      state.openCards.add(card.dataset.key);
      card.querySelectorAll('[data-scale]').forEach(layoutScale);
    } else state.openCards.delete(card.dataset.key);
  }, true);

  window.addEventListener('resize', debounce(layoutScales, 150));
  // 分頁可能開了一整天：回到前景時重算「幾小時前更新」與落後提示。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    renderHeader();
    renderBanner();
  });
  window.addEventListener('storage', (e) => {
    if (e.key === KEYS.tx) {
      state.tx = sanitizeTxList(load(KEYS.tx, [])).txs;
      refreshRecords();
    }
  });
}

function setStop(key, raw) {
  const v = Number(raw);
  if (raw === '' || raw == null) delete state.stops[key];
  else if (v > 0 && Number.isFinite(v)) state.stops[key] = v;
  else {
    toast('停損價要是大於 0 的數字');
    return;
  }
  save(KEYS.stops, state.stops);
  renderAll();
  toast(raw === '' ? '已改回自動停損價' : '已儲存停損價');
}

bind();
renderAll();
loadData();
