// 持倉分析：介面與狀態。計算交給 fees.js／portfolio.js／rules.js；這裡負責資料流、畫面與 localStorage。
// 各區塊在 assets/ui/：dom 小工具、store 儲存與清理、state 狀態、cards 詳細卡與走勢圖、form 交易表單、io 匯出入、settings 設定與主題。
import { DEFAULT_MODEL, MODELS, buildPayload, estimateCost, modelInfo, runAnalysis } from './ai.js';
import { hasFailedBuckets, loadMeta, loadRecords } from './data.js';
import { FEES_AS_OF, FEE_SOURCES, getBroker } from './fees.js';
import { dataFreshness } from './freshness.js';
import { fetchStockNews } from './news.js';
import { buildHoldings, holdingKey, realizedByYear, sessionPosition, summarize, valueHolding } from './portfolio.js';
import { ACTIONS, RULES, analyzeHolding, analyzePortfolio } from './rules.js';
import { aiLabel, drawChart, drawCharts, gotoCard, layoutScale, layoutScales, li, listOr, modelShort, renderCards } from './ui/cards.js';
import { $, MARKET_LABEL, aiBadge, dayLabel, debounce, dir, extLink, fmtDateTime, fmtFrac, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtShares, html, industryLabel, isNum, ntd, setHtml, shortTwd, tag, toast, todayLocal, twd, usd } from './ui/dom.js';
import { closeList, deleteTx, ensureIndex, form, indexFailedAt, marketNow, paintList, pickSuggestion, renderPreview, resetForm, resolveCode, setFormMarket, startEdit, submitTrade, syncSide, updateBrokerHint, updateSuggestions } from './ui/form.js';
import { exportCsv, exportJson, exportRealizedCsv, importJson, syncCashInputs } from './ui/io.js';
import { applyTheme, fillTwFields, fillUsFields, openSettings, saveSettings } from './ui/settings.js';
import { nameOf, saveUi, state, usdTwd } from './ui/state.js';
import { KEYS, SIDE_LABEL, load, loadRaw, sanitizeAi, sanitizeCash, sanitizeTxList, save, saveRaw, storageBroken } from './ui/store.js';

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
  const summary = summarize(rows, { cashTWD: state.cash.twd, cashUSD: state.cash.usd, fx, realizedTotal: built.realizedTotal,
    dividendTotal: built.dividendTotal });
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

export function renderBanner() {
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
  if (s.dividends) parts.push(html`<span data-stat="dividends">已領股利 <b class="${dir(s.dividends)}">${twd(s.dividends, { sign: true })}</b></span>`);
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
        const act = html`<td class="act"><button type="button" class="btn" data-edit="${t.id}" aria-label="編輯 ${t.date} ${t.code}">編輯</button><button type="button" class="btn danger" data-del="${t.id}" aria-label="刪除 ${t.date} ${t.code}">刪除</button></td>`;
        if (t.side === 'dividend' || t.side === 'split') {
          return html`<tr>
          <td>${t.date}</td>
          <td class="c">${t.market === 'TW' ? '台股' : '美股'}</td>
          <td class="l">${t.code}</td>
          <td class="l nm-cell">${nameOf(t.market, t.code)}</td>
          <td class="c"><span class="side-${t.side}">${SIDE_LABEL[t.side]}</span></td>
          ${t.side === 'dividend'
            ? html`<td class="muted">—</td><td title="實收股利">${fmtMoney(t.amount, cur)}</td>`
            : html`<td title="1 股變成 ${fmtNum(t.ratio, 0, 6)} 股">1 → ${fmtNum(t.ratio, 0, 6)}</td><td class="muted">—</td>`}
          <td class="muted">—</td>
          <td class="l muted">—</td>
          ${act}
        </tr>`;
        }
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
          ${act}
        </tr>`;
      })}</tbody>
    </table></div>`);
}

// ---------- 年度已實現損益 ----------

function renderRealized(model) {
  const years = realizedByYear(model.built.realizedList, model.built.dividendList);
  $('exportRealizedCsv').disabled = !years.length;
  if (!years.length) {
    setHtml($('realizedBody'), html`<p class="empty">還沒有賣出紀錄或股利。</p>`);
    return;
  }
  const total = (m) => (m ? html`<b class="${dir(m.realized)}">${fmtMoney(m.realized, m.currency, { sign: true })}</b>${m.dividends ? html`<span class="muted small">＋股利 ${fmtMoney(m.dividends, m.currency)}</span>` : ''}` : html`<span class="muted">—</span>`);
  const dash = (n, f) => (n ? f : html`<span class="muted">—</span>`);
  setHtml($('realizedBody'), years.map((y, i) => {
    const rows = ['TW', 'US'].flatMap((mk) => (y.markets[mk]?.stocks ?? []).map((s) => ({ mk, cur: y.markets[mk].currency, s })));
    return html`<details class="realized-year" data-year="${y.year}"${i === 0 ? html` open` : ''}>
      <summary><b>${y.year} 年</b><span>台股 ${total(y.markets.TW)}</span><span>美股 ${total(y.markets.US)}</span></summary>
      <div class="table-scroll" role="region" aria-label="${y.year} 年已實現損益明細（可左右捲動）" tabindex="0">
        <table class="data-table">
          <thead><tr><th class="c" scope="col">市場</th><th class="l" scope="col">代號</th><th class="l" scope="col">名稱</th><th scope="col">賣出筆數</th><th scope="col">股數</th><th scope="col">賣出淨收入</th><th scope="col">成本</th><th scope="col">賣出費用與稅</th><th scope="col">已實現損益</th><th scope="col">股利</th></tr></thead>
          <tbody>${rows.map(({ mk, cur, s }) => html`<tr>
            <td class="c">${MARKET_LABEL[mk]}</td>
            <td class="l">${s.code}</td>
            <td class="l nm-cell">${nameOf(mk, s.code)}</td>
            <td>${s.count}</td>
            <td>${dash(s.count, fmtShares(s.shares))}</td>
            <td>${dash(s.count, fmtMoney(s.proceeds, cur))}</td>
            <td>${dash(s.count, fmtMoney(s.costBasis, cur))}</td>
            <td>${dash(s.count, fmtMoney(s.sellCosts, cur))}</td>
            <td class="${dir(s.realized)}">${dash(s.count, fmtMoney(s.realized, cur, { sign: true }))}</td>
            <td class="${dir(s.dividends)}">${dash(s.dividends, fmtMoney(s.dividends, cur, { sign: true }))}</td>
          </tr>`)}</tbody>
        </table>
      </div>
    </details>`;
  }));
}

// ---------- 全部重畫 ----------

export function renderAll() {
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
  drawCharts();
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

export async function refreshRecords() {
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
  document.querySelectorAll('input[name="side"]').forEach((i) => i.addEventListener('change', syncSide));
  ['fShares', 'fPrice', 'fAmount', 'fRatio', 'fDate'].forEach((id) => $(id).addEventListener('input', () => {
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
      card.querySelectorAll('[data-chart]').forEach(drawChart);
    } else state.openCards.delete(card.dataset.key);
  }, true);

  window.addEventListener('resize', debounce(() => {
    layoutScales();
    drawCharts();
  }, 150));
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
