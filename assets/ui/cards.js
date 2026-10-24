// 個股詳細卡與走勢圖。
import { MODELS } from '../ai.js';
import { loadChart } from '../data.js';
import { holdingKey } from '../portfolio.js';
import { RULES, industryPeFor, levels } from '../rules.js';
import { $, TYPE_LABEL, aiBadge, cardId, dayLabel, dir, extLink, fmtFrac, fmtLots, fmtMoney, fmtNum, fmtPct, fmtPrice, html, industryLabel, isNum, setHtml, tag } from './dom.js';
import { state } from './state.js';

// ---------- 個股詳細卡 ----------

const block = (title, body, { wide = false, note = '' } = {}) =>
  html`<section class="sc-block${wide ? ' wide' : ''}"><h4>${title}${note ? html` <span class="muted">${note}</span>` : ''}</h4>${body}</section>`;
export const li = (t) => html`<li>${t}</li>`;
export const listOr = (items, empty) => (items.length ? items : html`<li class="empty-li">${empty}</li>`);
export const aiLabel = () => (state.ai ? `AI 分析・${state.ai.date || '—'}・${modelShort(state.ai.served || state.ai.model)}` : '');
export const modelShort = (id) => MODELS.find((m) => m.id === id)?.short ?? id;
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

export function renderCards(model, rows) {
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
        ${blockChart(key)}
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
export function layoutScale(el) {
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
export const layoutScales = () => document.querySelectorAll('details[open] [data-scale]').forEach(layoutScale);

// ---------- 走勢圖（近一年收盤＋價位刻度虛線） ----------

const CHART_LINES = [['cost', '成本', 'cost'], ['support', '支撐', 'support'], ['resist', '壓力', 'resistance'], ['stop', '停損', 'stop']];
const CHART_H = 240;
const CHART_PAD = { top: 32, right: 96, bottom: 22, left: 46 }; // 上方 32px 留給滑過時的提示框

function blockChart(key) {
  return block('走勢', html`<div class="pchart" data-chart="${key}"><p class="muted">載入中…</p></div>`,
    { wide: true, note: '近一年收盤・虛線為價位刻度' });
}

// 1、2、5 × 10^k 的刻度；少於 3 條就把步距減半再算一次。
function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out.length < 3 && count < 16 ? niceTicks(lo, hi, count * 2) : out;
}

// 參考線標籤依 y 由上往下排，間距至少 gap；超出底部就整排往上推。
function spreadLabels(items, gap, min, max) {
  const s = [...items].sort((a, b) => a.ly - b.ly);
  for (let i = 0; i < s.length; i++) s[i].ly = Math.max(s[i].ly, i ? s[i - 1].ly + gap : min);
  for (let i = s.length - 1; i >= 0; i--) s[i].ly = Math.min(s[i].ly, i < s.length - 1 ? s[i + 1].ly - gap : max);
  return s;
}

export const drawCharts = () => document.querySelectorAll('details[open] [data-chart]').forEach(drawChart);

export async function drawChart(el) {
  const key = el.dataset.chart;
  const [market, code] = key.split(':');
  if (!(key in state.charts)) {
    const series = await loadChart(market, code);
    state.charts[key] = series;
    if (!el.isConnected) return; // 等待時畫面重畫過，新的元素會自己畫
  }
  const series = state.charts[key];
  if (!series) {
    setHtml(el, html`<p class="muted">沒有走勢資料（每日資料還沒有這檔的歷史收盤價）。</p>`);
    return;
  }
  const W = el.clientWidth;
  if (!W) return;
  const lv = state.model?.analyses[key]?.levels ?? {};
  const lines = CHART_LINES.map(([k, name, f]) => ({ k, name, v: lv[f] })).filter((m) => isNum(m.v) && m.v > 0);
  const closes = series.map((s) => s[1]);
  const vals = [...closes, ...lines.map((m) => m.v)];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = (hi - lo) * 0.06 || hi * 0.05;
  lo -= pad;
  hi += pad;
  const P = CHART_PAD;
  const iw = Math.max(W - P.left - P.right, 40);
  const ih = CHART_H - P.top - P.bottom;
  const n = series.length;
  const x = (i) => P.left + (i / (n - 1)) * iw;
  const y = (v) => P.top + (1 - (v - lo) / (hi - lo)) * ih;
  const path = series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s[1]).toFixed(1)}`).join('');
  const ticks = niceTicks(lo, hi, 4);
  const xLabels = [0, Math.floor((n - 1) / 2), n - 1].map((i) => ({ i, t: series[i][0].replaceAll('-', '/') }));
  const labels = spreadLabels(lines.map((m) => ({ ...m, ly: y(m.v) })), 14, P.top + 4, P.top + ih);
  const hiI = closes.indexOf(Math.max(...closes));
  const loI = closes.indexOf(Math.min(...closes));
  const desc = `${series[0][0]} 到 ${series[n - 1][0]} 收盤由 ${fmtNum(closes[0], 0, 2)} 到 ${fmtNum(closes[n - 1], 0, 2)}，`
    + `最高 ${fmtNum(closes[hiI], 0, 2)}（${series[hiI][0]}），最低 ${fmtNum(closes[loI], 0, 2)}（${series[loI][0]}）`
    + `${lines.length ? `；${lines.map((m) => `${m.name} ${fmtNum(m.v, 0, 2)}`).join('、')}` : ''}`;

  setHtml(el, html`<svg class="pchart-svg" width="${W}" height="${CHART_H}" viewBox="0 0 ${W} ${CHART_H}" tabindex="0" role="img" aria-label="${code} 走勢：${desc}。可用左右鍵逐日查看。">
      ${ticks.map((t) => html`<line class="pchart-grid" x1="${P.left}" x2="${P.left + iw}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"></line>
        <text class="pchart-axis" x="${P.left - 6}" y="${y(t).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${fmtNum(t, 0, 2)}</text>`)}
      ${xLabels.map((l, k) => html`<text class="pchart-axis" x="${x(l.i).toFixed(1)}" y="${CHART_H - 6}" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}">${l.t}</text>`)}
      ${lines.map((m) => html`<line class="pchart-ref mk-${m.k}" x1="${P.left}" x2="${P.left + iw}" y1="${y(m.v).toFixed(1)}" y2="${y(m.v).toFixed(1)}"></line>`)}
      <path class="pchart-line" d="${path}"></path>
      ${labels.map((m) => html`<g class="pchart-label"><rect class="mk-${m.k}" x="${P.left + iw + 6}" y="${(m.ly - 4).toFixed(1)}" width="8" height="8" rx="2"></rect>
        <text x="${P.left + iw + 18}" y="${m.ly.toFixed(1)}" dominant-baseline="middle">${m.name} <tspan class="v">${fmtNum(m.v, 0, 2)}</tspan></text></g>`)}
      <line class="pchart-cross" y1="${P.top}" y2="${P.top + ih}" visibility="hidden"></line>
      <circle class="pchart-dot" r="4" visibility="hidden"></circle>
    </svg>
    <div class="pchart-tip" hidden></div>`);

  const svg = el.querySelector('svg');
  const tip = el.querySelector('.pchart-tip');
  const cross = svg.querySelector('.pchart-cross');
  const dot = svg.querySelector('.pchart-dot');
  const cost = lv.cost;
  let cur = null;
  const show = (i) => {
    cur = Math.min(Math.max(i, 0), n - 1);
    const [d, c] = series[cur];
    const cx = x(cur).toFixed(1);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', y(c).toFixed(1));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    const vsCost = isNum(cost) && cost > 0 ? (c / cost - 1) * 100 : null;
    setHtml(tip, html`<span>${dayLabel(d)}</span><b>${fmtPrice(c, market)}</b>${isNum(vsCost) ? html`<span class="${dir(vsCost)}">比成本 ${fmtPct(vsCost)}</span>` : ''}`);
    tip.hidden = false;
    const left = Math.min(Math.max(x(cur) - tip.offsetWidth / 2, 0), W - tip.offsetWidth);
    tip.style.left = `${left}px`;
  };
  const hide = () => {
    cur = null;
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (W / rect.width);
    show(Math.round(((px - P.left) / iw) * (n - 1)));
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('focus', () => show(n - 1));
  svg.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    show((cur ?? n - 1) + (Number.isFinite(step) ? step : step < 0 ? -n : n));
  });
}

export function gotoCard(key) {
  const el = document.getElementById(cardId(key));
  if (!el) return;
  el.open = true;
  state.openCards.add(key);
  el.querySelectorAll('[data-scale]').forEach(layoutScale);
  el.querySelectorAll('[data-chart]').forEach(drawChart);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  el.querySelector('summary')?.focus({ preventScroll: true });
}
