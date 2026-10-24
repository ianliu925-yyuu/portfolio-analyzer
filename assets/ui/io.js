// 匯出、匯入（JSON 備份、CSV）。
import { getBroker } from '../fees.js';
import { buildHoldings, realizedByYear } from '../portfolio.js';
import { refreshRecords } from '../app.js';
import { $, MARKET_LABEL, toast, todayLocal } from './dom.js';
import { marketNow, setFormMarket, stopEditing } from './form.js';
import { nameOf, state } from './state.js';
import { KEYS, SIDE_LABEL, sanitizeCash, sanitizePriceMap, sanitizeSettings, sanitizeTxList, save } from './store.js';

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

export function exportJson() {
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

export function exportCsv() {
  const head = ['日期', '市場', '代號', '名稱', '買賣', '股數', '價位', '手續費', '交易稅', '規費', '價位已含手續費', '券商', '股利實收', '分割比例', '幣別'];
  const lines = [...state.tx].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).map((t) => {
    const trade = t.side === 'buy' || t.side === 'sell';
    return [
      t.date, t.market === 'TW' ? '台股' : '美股', t.code, nameOf(t.market, t.code), SIDE_LABEL[t.side],
      ...(trade ? [t.shares, t.price, t.fee, t.tax, t.regFee, t.feeIncluded ? '是' : '否', getBroker(t.broker, t.market).name]
        : ['', '', '', '', '', '', '']),
      t.amount ?? '', t.ratio ?? '', t.market === 'US' ? 'USD' : 'TWD',
    ];
  });
  const csv = [head, ...lines].map((row) => row.map(csvField).join(',')).join('\r\n');
  download(`持倉分析交易紀錄-${todayLocal()}.csv`, `﻿${csv}\r\n`, 'text/csv;charset=utf-8');
}

export function exportRealizedCsv() {
  const head = ['年度', '市場', '代號', '名稱', '賣出筆數', '股數', '賣出淨收入', '成本', '賣出費用與稅', '已實現損益', '股利', '幣別'];
  const built = buildHoldings(state.tx);
  const lines = realizedByYear(built.realizedList, built.dividendList).flatMap((y) => ['TW', 'US'].flatMap((mk) => {
    const m = y.markets[mk];
    return (m?.stocks ?? []).map((s) => [y.year, MARKET_LABEL[mk], s.code, nameOf(mk, s.code), s.count, s.shares,
      s.proceeds, s.costBasis, s.sellCosts, s.realized, s.dividends, m.currency]);
  }));
  const csv = [head, ...lines].map((row) => row.map(csvField).join(',')).join('\r\n');
  download(`持倉分析年度已實現損益-${todayLocal()}.csv`, `﻿${csv}\r\n`, 'text/csv;charset=utf-8');
}

export async function importJson(file) {
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

export function syncCashInputs() {
  $('cashTWD').value = state.cash.twd ? String(state.cash.twd) : '';
  $('cashUSD').value = state.cash.usd ? String(state.cash.usd) : '';
}
