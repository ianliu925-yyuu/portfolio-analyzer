// 全域狀態：localStorage 載入後的交易、設定、每日資料快取與畫面狀態。
import { findInIndex } from '../data.js';
import { holdingKey } from '../portfolio.js';
import { isNum } from './dom.js';
import { KEYS, load, sanitizeAi, sanitizeCash, sanitizePriceMap, sanitizeSettings, sanitizeTxList, save } from './store.js';

// ---------- 狀態 ----------

const ui = load(KEYS.ui, {}) ?? {};
export const state = {
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
  charts: {}, // 'TW:2330' → [[date, close], …]，null = 沒有走勢資料；未載入時沒有這個 key
  editingId: null,
  model: null,
  ai_running: null,          // AbortController
};
export const saveUi = () => save(KEYS.ui, { sortKey: state.sort.key, sortDir: state.sort.dir, alloc: state.alloc });
export const saveTx = () => save(KEYS.tx, state.tx);

export const usdTwd = () => (isNum(state.meta?.fx?.USDTWD) && state.meta.fx.USDTWD > 0 ? state.meta.fx.USDTWD : null);

export function nameOf(market, code) {
  const rec = state.records[holdingKey(market, code)];
  if (rec?.name) return rec.name;
  const row = findInIndex(state.index[market], code);
  return row ? row[1] : '';
}
