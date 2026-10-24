// 新增／修改交易表單：代號自動完成、手續費預覽、驗證、編輯與刪除。
import { findInIndex, loadIndex, loadRecords, searchIndex } from '../data.js';
import { BOND_ETF_EXEMPT_UNTIL, brokersFor, getBroker, inferTwType, tradeCosts } from '../fees.js';
import { buildHoldings, holdingKey, normalizeCode } from '../portfolio.js';
import { refreshRecords, renderAll } from '../app.js';
import { $, TYPE_LABEL, fmtMoney, fmtNum, fmtPrice, fmtShares, html, isNum, newId, setHtml, toast, todayLocal, validDate } from './dom.js';
import { round6 } from './settings.js';
import { nameOf, saveTx, state } from './state.js';
import { CODE_PATTERN, SIDES, SIDE_LABEL, sanitizeTx } from './store.js';

// ---------- 新增交易表單 ----------

export const form = { results: [], active: -1, row: null };
export const marketNow = () => document.querySelector('input[name="market"]:checked')?.value === 'US' ? 'US' : 'TW';
const sideNow = () => {
  const v = document.querySelector('input[name="side"]:checked')?.value;
  return SIDES.includes(v) ? v : 'buy';
};
// 表單依買賣別切換要填的欄位（CSS 看 data-side）
function setSide(side) {
  document.querySelectorAll('input[name="side"]').forEach((i) => { i.checked = i.value === side; });
  syncSide();
}
export function syncSide() {
  $('tradeForm').dataset.side = sideNow();
  renderPreview();
}

// 代號清單：成功才快取；失敗記下時間，5 秒後（或按「重試」）再載。
export const indexFailedAt = {};
export async function ensureIndex(market) {
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

export function fillBrokerSelect(select, market, selected) {
  setHtml(select, brokersFor(market).map((b) => html`<option value="${b.id}"${b.id === selected ? html` selected` : ''}>${brokerLabel(b)}</option>`));
}

export function updateBrokerHint() {
  const b = getBroker($('fBroker').value, marketNow(), state.settings.brokerOverrides);
  const low = b.confidence === 'low' ? '預設值僅供參考，請到「設定」改成你的實際費率。' : '';
  $('brokerHint').textContent = `${brokerSummary(b)}${low ? `。${low}` : ''}`;
}

export function setFormMarket(market, { keepCode = false } = {}) {
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
    shares: num($('fShares')), price: num($('fPrice')), amount: num($('fAmount')), ratio: num($('fRatio')),
    date: $('fDate').value, broker: $('fBroker').value, feeIncluded: $('fFeeIncluded').checked,
    type: code ? typeFor(market, code) : 'stock',
  };
}

export function renderPreview() {
  const v = readForm();
  const box = $('feePreview');
  if (v.side === 'split' && v.ratio > 0 && v.ratio !== 1 && v.code) {
    // 分割預覽：依分割日當時持股換算
    const held = sharesOn(state.tx.filter((t) => t.id !== state.editingId), v.market, v.code, v.date || todayLocal());
    setHtml(box, held > 0
      ? html`<p class="note">${v.code} 當時持有 ${fmtShares(held)} 股 → 分割後 ${fmtShares(held * v.ratio)} 股；總成本不變。</p>` : '');
    return;
  }
  if (v.side === 'dividend' || v.side === 'split' || !(v.shares > 0) || !(v.price > 0)) {
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

export function closeList() {
  $('codeList').hidden = true;
  $('fCode').setAttribute('aria-expanded', 'false');
  $('fCode').removeAttribute('aria-activedescendant');
  form.results = [];
  form.active = -1;
}

export function paintList() {
  const list = $('codeList');
  setHtml(list, form.results.length
    ? form.results.map((r, i) => html`<li role="option" id="codeOpt${i}" data-i="${i}" aria-selected="${String(i === form.active)}"><b>${r[0]}</b><span class="nm">${r[1]}</span><span class="ty">${TYPE_LABEL[r[2]] ?? ''}</span></li>`)
    : html`<li class="none" role="option" aria-disabled="true" aria-selected="false">找不到符合的代號</li>`);
  list.hidden = false;
  $('fCode').setAttribute('aria-expanded', 'true');
  if (form.active >= 0) $('fCode').setAttribute('aria-activedescendant', `codeOpt${form.active}`);
  else $('fCode').removeAttribute('aria-activedescendant');
}

export async function updateSuggestions() {
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

export function pickSuggestion(i) {
  const r = form.results[i];
  if (!r) return;
  $('fCode').value = r[0];
  closeList();
  resolveCode();
}

export async function resolveCode() {
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

export async function submitTrade(e) {
  e.preventDefault();
  document.querySelectorAll('#tradeForm [aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  await ensureIndex(marketNow());
  const v = readForm();
  const today = todayLocal();
  if (!v.code) return formError($('fCode'), '請輸入代號。');
  if (!CODE_PATTERN[v.market].test(v.code)) {
    return formError($('fCode'), v.market === 'TW' ? '台股代號是 4～6 碼數字，可加一個英文字母（例如 00679B）。' : '美股代號是英文字母（例如 AAPL、BRK.B）。');
  }
  const editing = state.editingId;
  const others = state.tx.filter((t) => t.id !== editing);
  const corporate = v.side === 'dividend' || v.side === 'split';
  if (v.side === 'dividend' && ($('fAmount').validity.badInput || !(v.amount > 0))) return formError($('fAmount'), '實收股利要大於 0。');
  if (v.side === 'split' && ($('fRatio').validity.badInput || !(v.ratio > 0) || v.ratio === 1)) {
    return formError($('fRatio'), '分割比例要大於 0 且不是 1（1 拆 4 填 4，10 股併 1 股填 0.1）。');
  }
  if (!corporate) {
    if ($('fShares').validity.badInput || !(v.shares > 0)) return formError($('fShares'), '股數要大於 0。');
    if (v.market === 'TW' && !Number.isInteger(v.shares)) return formError($('fShares'), '台股股數要是整數（1 張 = 1000 股）。');
    if (v.shares > 1e9) return formError($('fShares'), '股數太大，請確認。');
    if ($('fPrice').validity.badInput || !Number.isFinite(v.price) || v.price < 0) return formError($('fPrice'), '請輸入價位（0 以上的數字）。');
  }
  if (!validDate(v.date)) return formError($('fDate'), '請選擇日期。');
  if (v.date > today) return formError($('fDate'), '日期不能晚於今天。');
  if (v.side === 'dividend' && !others.some((t) => t.market === v.market && t.code === v.code && t.side === 'buy' && t.date <= v.date)) {
    return formError($('fDate'), `${v.date} 以前沒有買進 ${v.code}，不能記股利。`);
  }
  if (v.side === 'split' && !(sharesOn(others, v.market, v.code, v.date) > 0)) {
    return formError($('fDate'), `${v.date} 當時沒有持有 ${v.code}，不能記分割。`);
  }
  if (v.side === 'sell') {
    // 依賣出日期當時的持股判斷（交易依日期重算，賣在買進之前會被略過）
    const held = sharesOn(others, v.market, v.code, v.date);
    if (v.shares > held + 1e-9) {
      const when = v.date === today ? '目前' : `${v.date} 當時`;
      const later = sharesOn(others, v.market, v.code, today) >= v.shares;
      return formError(later ? $('fDate') : $('fShares'), held > 0
        ? `${when}只持有 ${fmtShares(held)} 股 ${v.code}，不能賣出 ${fmtShares(v.shares)} 股。${later ? '賣出日期要在買進之後。' : ''}`
        : `${when}沒有持有 ${v.code}，不能賣出。${later ? '賣出日期要在買進之後。' : ''}`);
    }
  }
  let tx;
  if (corporate) {
    tx = sanitizeTx({ id: editing ?? newId(), market: v.market, code: v.code, side: v.side, date: v.date, amount: v.amount, ratio: v.ratio });
  } else {
    const c = tradeCosts({ market: v.market, side: v.side, price: v.price, shares: v.shares, type: v.type, code: v.code, date: v.date,
      broker: v.broker, brokerOverrides: state.settings.brokerOverrides });
    tx = sanitizeTx({
      id: editing ?? newId(), market: v.market, code: v.code, side: v.side, shares: v.shares, price: v.price, date: v.date,
      feeIncluded: v.feeIncluded, fee: c.fee, tax: c.tax, regFee: c.regFee, broker: c.broker,
    });
  }
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
  const what = v.side === 'dividend' ? `${fmtMoney(v.amount, v.market === 'US' ? 'USD' : 'TWD')}`
    : v.side === 'split' ? `1 股變 ${fmtNum(v.ratio, 0, 6)} 股`
      : `${fmtShares(v.shares)} 股 @ ${fmtPrice(v.price, v.market)}${v.price === 0 ? '（價位 0，例如配股）' : ''}`;
  const msg = `${editing ? '已修改' : '已加入'}：${SIDE_LABEL[v.side]} ${v.code}${name ? ` ${name}` : ''} ${what}${known || corporate ? '' : '。這檔沒有每日資料，請在持股明細輸入手動價格'}`;
  if (editing) resetForm();
  else {
    $('fCode').value = '';
    $('fShares').value = '';
    $('fPrice').value = '';
    $('fAmount').value = '';
    $('fRatio').value = '';
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

export function startEdit(id) {
  const t = state.tx.find((x) => x.id === id);
  if (!t) return;
  state.editingId = id;
  setFormMarket(t.market);
  $('fCode').value = t.code;
  $('fShares').value = t.shares != null ? String(t.shares) : '';
  $('fPrice').value = t.price != null ? String(t.price) : '';
  $('fAmount').value = t.amount != null ? String(t.amount) : '';
  $('fRatio').value = t.ratio != null ? String(t.ratio) : '';
  $('fDate').value = t.date;
  if (brokersFor(t.market).some((b) => b.id === t.broker)) $('fBroker').value = t.broker;
  $('fFeeIncluded').checked = t.feeIncluded === true;
  setSide(t.side);
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

export function stopEditing() {
  state.editingId = null;
  $('submitBtn').textContent = '加入';
  $('cancelEdit').hidden = true;
  $('editBadge').hidden = true;
}

// 離開修改模式時清空表單（日期回到今天、買進、預設券商），避免按「加入」又新增一筆一樣的交易。
export function resetForm() {
  stopEditing();
  document.querySelectorAll('#tradeForm [aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  $('fShares').value = '';
  $('fPrice').value = '';
  $('fAmount').value = '';
  $('fRatio').value = '';
  $('fDate').value = todayLocal();
  $('fFeeIncluded').checked = false;
  setFormMarket(marketNow());
  setSide('buy');
}

export function deleteTx(id) {
  const t = state.tx.find((x) => x.id === id);
  if (!t) return;
  const rest = state.tx.filter((x) => x.id !== id);
  const broken = newTradeErrors(rest);
  const warn = broken.length
    ? `\n\n注意：刪除後其他交易會對不上：${errText(broken[0])}${broken.length > 1 ? `（共 ${broken.length} 筆）` : ''}。` : '';
  const what = t.side === 'dividend' ? fmtMoney(t.amount, t.market === 'US' ? 'USD' : 'TWD')
    : t.side === 'split' ? `1 股變 ${fmtNum(t.ratio, 0, 6)} 股` : `${fmtShares(t.shares)} 股`;
  if (!window.confirm(`確定刪除 ${t.date} ${SIDE_LABEL[t.side]} ${t.code} ${what}？${warn}`)) return;
  state.tx = rest;
  if (state.editingId === id) resetForm();
  saveTx();
  renderAll();
  toast('已刪除一筆交易');
}
