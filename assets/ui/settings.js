// 設定對話框（券商自訂費率、停損 %）與主題。
import { getBroker } from '../fees.js';
import { renderAll } from '../app.js';
import { $, extLink, html, setHtml, toast } from './dom.js';
import { fillBrokerSelect, marketNow, renderPreview, setFormMarket, updateBrokerHint } from './form.js';
import { state } from './state.js';
import { KEYS, sanitizeSettings, save } from './store.js';

// ---------- 設定 ----------

const presetOf = (id, market) => getBroker(id, market);
export const round6 = (x) => Math.round(x * 1e6) / 1e6;

function noteHtml(b) {
  return html`${b.note}${b.confidence === 'low' ? '（預設值僅供參考）' : ''}${b.rebate === '月退' ? ' 月退：下單時先收原價手續費，月底退回差額，成本以折扣後計。' : ''} 查證日 ${b.asOf}${b.source ? html`・${extLink(b.source, '出處')}` : ''}`;
}

export function fillTwFields(id, { preset = false } = {}) {
  const b = preset ? presetOf(id, 'TW') : getBroker(id, 'TW', state.settings.brokerOverrides);
  $('sTwDiscount').value = String(round6(b.discount * 10));
  $('sTwMin').value = String(b.minFee);
  $('sTwOdd').value = String(b.oddLotMinFee ?? b.minFee);
  setHtml($('sTwNote'), noteHtml(b));
}

export function fillUsFields(id, { preset = false } = {}) {
  const b = preset ? presetOf(id, 'US') : getBroker(id, 'US', state.settings.brokerOverrides);
  const show = { rate: b.model === 'percent', perShare: b.model === 'per_share', minFee: b.model !== 'zero' };
  document.querySelectorAll('#sUsFields [data-us]').forEach((el) => { el.hidden = !show[el.dataset.us]; });
  $('sUsRate').value = String(round6((b.rate ?? 0) * 100));
  $('sUsPerShare').value = String(b.perShare ?? 0);
  $('sUsMin').value = String(b.minFee ?? 0);
  setHtml($('sUsNote'), html`${b.model === 'zero' ? '零佣金，不需要設定費率。' : ''}${noteHtml(b)}`);
}

export function openSettings() {
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

export function saveSettings() {
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

export function applyTheme(t) {
  const v = t === 'light' || t === 'dark' ? t : 'auto';
  if (v === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === v)));
}
