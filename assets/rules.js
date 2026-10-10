// 規則分析（純函式）：關鍵價位、個股動作、多空訊號、今天該注意、組合風險。
// 所有門檻都在 RULES；百分比欄位（*Pct、yoy）是百分數（12.5 代表 12.5%），weight／pos52／stopPct 是 0～1 的比例。

export const RULES = {
  stopPct: 0.10,               // 預設停損：成本 × (1 − 10%)
  supportStopFactor: 0.97,     // 或支撐 × 0.97，取較高者
  resistanceNearHigh: 0.01,    // 現價距近 20 日高點 < 1% 時，壓力改用 52 週高點
  stopWatch: 0.03,             // 現價距停損價 ≤ 3% → 停損觀察
  takeProfit: { minReturnPct: 20, peMultiple: 1.5, minPos52: 0.85 },
  reduce: { maxWeight: 0.40, foreignSellDays: 3, maxRevenueYoy: 0 },
  add: { minReturnPct: -5, maxReturnPct: 10, minRevenueYoy: 20, minForeign5: 0, peMultiple: 1 },
  signals: {
    max: 3,
    revenueYoyUp: 10,          // 月營收年增 ≥ 10% 列多方
    revenueYoyDown: 0,         // 月營收年增 < 0 列空方
    nearLow52: 0.05,           // 現價在 52 週低點 5% 以內
    streakDays: 3,             // 法人連買／連賣天數
    marginJump: 0.05,          // 融資單日增加 ≥ 5%
    peCheap: 0.8,              // 本益比 ≤ 同業 × 0.8 列多方
    peRich: 1.5,               // 本益比 ≥ 同業 × 1.5 列空方
    volumeSpike: 2,            // 成交量 ≥ 20 日均量 × 2
  },
  watch: { nearStop: 0.05, nearResistance: 0.03, revenueDay: 10, reportDaysAhead: 30, eventDaysAhead: 14, holidayDaysAhead: 7 },
  portfolio: { minHoldings: 3, maxWeight: 0.40, maxIndustryWeight: 0.60, minCash: 0.10 },
};

export const ACTIONS = ['停損', '停損觀察', '分批停利', '減碼', '加碼', '續抱'];

export const REPORT_DEADLINES = [
  { md: '03-31', label: '年報' },
  { md: '05-15', label: '第一季財報' },
  { md: '08-14', label: '第二季財報' },
  { md: '11-14', label: '第三季財報' },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const positive = (v) => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};
const round = (x, d = 2) => (x == null ? null : Math.round(Number((x * 10 ** d).toPrecision(12))) / 10 ** d);
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const fp = (n) => fmt(n, 2);                       // 價格
const fpct = (n, d = 1) => `${fmt(n, d)}%`;        // n 已是百分數
const frac = (f, d = 1) => fpct(f * 100, d);       // f 是 0～1 比例
const lots = (sharesCount) => fmt(Math.round(sharesCount / 1000), 0); // 股 → 張

// 三態判斷：資料缺 → null；null 永遠不算符合。
const cmp = (a, b, fn) => (a == null || b == null ? null : fn(a, b));
const all = (...xs) => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const any = (...xs) => (xs.includes(true) ? true : xs.includes(null) ? null : false);

const dayNum = (s) => (DATE_RE.test(s ?? '') ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000 : null);
const daysFrom = (from, to) => (dayNum(from) == null || dayNum(to) == null ? null : dayNum(to) - dayNum(from));
const md = (s) => `${+s.slice(5, 7)}/${+s.slice(8, 10)}`;
// 中文與英數字之間補空白（「把AAPL降到」→「把 AAPL 降到」），全形括號旁不加。
const spacing = (s) => s
  .replace(/([\u3400-\u9fff])([A-Za-z0-9])/g, '$1 $2')
  .replace(/([A-Za-z0-9%])([\u3400-\u9fff])/g, '$1 $2');

const labelOf = (row, record) => {
  const code = row?.code ?? record?.code ?? '';
  const name = row?.name && row.name !== code ? row.name : record?.name;
  return name && name !== code ? `${name}（${code}）` : code;
};

export function industryPeFor(industryPe, market, industry) {
  if (typeof industryPe === 'number') return positive(industryPe);
  if (!industryPe || !industry) return null;
  return positive(industryPe[`${market}:${industry}`] ?? industryPe[industry]);
}

export function levels(holding, record, { stopPct = RULES.stopPct, userStop } = {}) {
  const hist = record?.hist ?? {};
  const cost = positive(holding?.avgCost);
  const price = positive(holding?.price) ?? positive(record?.close);
  const low20 = positive(hist.low20);
  const high20 = positive(hist.high20);
  const ma60 = positive(hist.ma60);
  const hi52 = positive(hist.hi52);
  const lo52 = positive(hist.lo52);

  let support = low20;
  if (ma60 != null && price != null && ma60 < price && (low20 == null || ma60 > low20)) support = ma60;

  let resistance = high20;
  if (high20 != null && price != null && (high20 - price) / high20 < RULES.resistanceNearHigh) resistance = hi52 ?? high20;
  if (resistance == null) resistance = hi52;

  const pct = Number.isFinite(stopPct) && stopPct >= 0 && stopPct < 1 ? stopPct : RULES.stopPct;
  let stop = null;
  let stopSource = null;
  if (positive(userStop) != null) {
    stop = positive(userStop);
    stopSource = 'user';
  } else {
    const byCost = cost != null ? cost * (1 - pct) : null;
    const bySupport = support != null ? support * RULES.supportStopFactor : null;
    if (byCost != null && (bySupport == null || byCost >= bySupport)) [stop, stopSource] = [byCost, 'cost'];
    else if (bySupport != null) [stop, stopSource] = [bySupport, 'support'];
  }

  const pos52 = price != null && hi52 != null && lo52 != null && hi52 > lo52
    ? round(Math.min(Math.max((price - lo52) / (hi52 - lo52), 0), 1), 4) : null;

  return {
    cost: round(cost), price, support: round(support), resistance: round(resistance),
    stop: round(stop), stopSource, stopPct: pct, hi52, lo52, pos52, ma60,
  };
}

function returnPctOf(row, lv) {
  const net = num(row?.netPLPct);
  if (net != null) return net;
  return lv.cost != null && lv.price != null ? ((lv.price - lv.cost) / lv.cost) * 100 : null;
}

function sharesToTarget(row, weight, target) {
  const value = num(row?.valueTWD);
  const price = positive(row?.price);
  const rate = positive(row?.fx) ?? 1;
  if (!(value > 0) || !(weight > 0) || price == null) return null;
  const sellValue = value - target * (value / weight);
  if (!(sellValue > 0)) return null;
  const n = Math.ceil(Number((sellValue / (price * rate)).toPrecision(12)));
  return row?.shares > 0 ? Math.min(n, row.shares) : n;
}

export function analyzeHolding(row, record, ctx = {}) {
  const market = ctx.market ?? row?.market ?? record?.market ?? 'TW';
  const lv = levels(row, record, { stopPct: ctx.stopPct ?? RULES.stopPct, userStop: ctx.userStop });
  const { price, stop, support, resistance, cost, pos52, hi52, lo52, ma60 } = lv;
  const hist = record?.hist ?? {};
  const chips = market === 'TW' ? record?.chips ?? null : null;
  const fund = record?.fund ?? null;
  const industry = record?.industry ?? row?.industry ?? null;
  const isEtf = ['etf', 'bond_etf'].includes(record?.type ?? row?.type);

  const ret = returnPctOf(row, lv);
  const weight = num(ctx.weight ?? row?.assetWeight ?? row?.weight);
  const pe = positive(fund?.pe);
  const indPe = market === 'TW' ? industryPeFor(ctx.industryPe, market, industry) : industryPeFor(ctx.industryPe, market, record?.industry);
  const yoy = num(fund?.yoy);
  const fStreak = num(chips?.foreignStreak);
  const tStreak = num(chips?.trustStreak);
  const foreign5 = num(chips?.foreign5);
  const marginChg = num(chips?.marginChg);
  const margin = num(chips?.margin);
  const volume = positive(record?.volume);
  const avgVol = positive(hist.avgVol20);
  const changePct = num(record?.changePct);
  const low20 = positive(hist.low20);
  const high20 = positive(hist.high20);
  const T = RULES.takeProfit, R = RULES.reduce, A = RULES.add, S = RULES.signals, W = RULES.watch;
  const label = labelOf(row, record);
  const distStop = price != null && stop != null ? (price - stop) / price : null;
  const volRatio = volume != null && avgVol != null ? volume / avgVol : null;

  // 判斷條件（三態）
  const peRich = cmp(pe, indPe, (a, b) => a > b * T.peMultiple);
  const posHigh = cmp(pos52, T.minPos52, (a, b) => a >= b);
  const weightHigh = cmp(weight, R.maxWeight, (a, b) => a > b);
  const chipsWeak = all(
    cmp(fStreak, -R.foreignSellDays, (a, b) => a <= b),
    cmp(marginChg, 0, (a, b) => a > b),
    cmp(yoy, R.maxRevenueYoy, (a, b) => a < b),
  );
  const checks = {
    停損: cmp(price, stop, (a, b) => a < b),
    停損觀察: cmp(distStop, RULES.stopWatch, (d, lim) => d >= 0 && d <= lim),
    分批停利: all(cmp(ret, T.minReturnPct, (a, b) => a >= b), any(peRich, posHigh)),
    減碼: any(weightHigh, chipsWeak),
    加碼: all(
      cmp(ret, A.minReturnPct, (a, b) => a >= b),
      cmp(ret, A.maxReturnPct, (a, b) => a <= b),
      cmp(price, ma60, (a, b) => a > b),
      cmp(yoy, A.minRevenueYoy, (a, b) => a >= b),
      cmp(foreign5, A.minForeign5, (a, b) => a > b),
      cmp(pe, indPe, (a, b) => a <= b * A.peMultiple),
    ),
  };

  const stopWhy = lv.stopSource === 'user' ? '自訂停損'
    : lv.stopSource === 'cost' ? `成本 ${fp(cost)} 下跌 ${frac(lv.stopPct, 0)}`
      : lv.stopSource === 'support' ? `支撐 ${fp(support)} × ${RULES.supportStopFactor}` : '';
  const why = {
    停損: () => `收盤 ${fp(price)} 已跌破停損價 ${fp(stop)}（${stopWhy}）`,
    停損觀察: () => `收盤 ${fp(price)} 距停損價 ${fp(stop)} 只剩 ${frac(distStop)}（${stopWhy}）`,
    分批停利: () => {
      const parts = [];
      if (peRich === true) parts.push(`本益比 ${fmt(pe, 1)} 高於同業中位數 ${fmt(indPe, 1)} 的 ${T.peMultiple} 倍`);
      if (posHigh === true) parts.push(`股價在 52 週區間的 ${frac(pos52, 0)} 高檔`);
      return `報酬率 ${fpct(ret)} 已達 ${T.minReturnPct}% 以上，且${parts.join('、')}`;
    },
    減碼: () => {
      const parts = [];
      if (weightHigh === true) parts.push(`單檔占總資產 ${frac(weight)}，超過 ${frac(R.maxWeight, 0)}`);
      if (chipsWeak === true) {
        parts.push(`籌碼轉弱：外資連賣 ${-fStreak} 天、融資增加 ${fmt(marginChg, 0)} 張，且月營收年減 ${fpct(-yoy)}`);
      }
      return parts.join('；');
    },
    加碼: () => `報酬率 ${fpct(ret)} 在 ${A.minReturnPct}%～+${A.maxReturnPct}% 之間、站上季線 ${fp(ma60)}、` +
      `月營收年增 ${fpct(yoy)}、外資 5 日買超 ${lots(foreign5)} 張、本益比 ${fmt(pe, 1)} 不高於同業中位數 ${fmt(indPe, 1)}`,
  };

  const met = ACTIONS.slice(0, 5).filter((a) => checks[a] === true);
  const action = met[0] ?? '續抱';
  const reasons = [];
  if (price == null) reasons.push('沒有收盤價，無法判斷停損與其他條件；請手動輸入現價');
  else if (action === '續抱') reasons.push('沒有觸發停損、停利、減碼或加碼條件，依關鍵價位續抱追蹤');
  else reasons.push(why[action]());
  for (const a of met.slice(1)) {
    if (a === '停損觀察' && action === '停損') continue;
    reasons.push(`同時符合「${a}」條件：${why[a]()}`);
  }

  // 缺資料說明
  const missing = [];
  if (price != null) {
    if (cost == null) missing.push('成本');
    if (hi52 == null || lo52 == null) missing.push('52 週高低點');
    if (ma60 == null) missing.push('季線');
    if (low20 == null || high20 == null) missing.push('近 20 日高低點');
    if (weight == null) missing.push('持股占比');
  }
  if (market === 'TW') {
    if (isEtf && yoy == null && pe == null) reasons.push('ETF 沒有月營收與本益比資料，加碼與籌碼轉弱條件不列入判斷');
    else {
      if (yoy == null) missing.push('月營收年增率');
      if (pe == null) missing.push('本益比');
      if (indPe == null) missing.push('同業本益比');
    }
    if (fStreak == null || foreign5 == null) missing.push('外資買賣超');
    if (marginChg == null) missing.push('融資增減');
  } else if (yoy == null && pe == null) {
    reasons.push('美股沒有月營收、本益比與法人籌碼資料，加碼與籌碼轉弱條件不列入判斷');
  }
  if (missing.length) reasons.push(`缺少${missing.join('、')}資料，相關條件不算符合`);

  // 觸發條件
  const triggers = [];
  const supportAboveStop = support != null && (stop == null || support > stop);
  if (price != null) {
    if (action === '停損') {
      if (stop != null) triggers.push(`收盤仍在 ${fp(stop)} 以下 → 停損出場`);
      if (stop != null) triggers.push(`收盤站回 ${fp(stop)} 以上 → 改列停損觀察`);
    } else if (action === '停損觀察') {
      if (stop != null) triggers.push(`收盤跌破 ${fp(stop)} → 停損`);
      if (resistance != null && resistance > price) triggers.push(`站穩 ${fp(resistance)} 以上 → 續抱`);
    } else if (action === '分批停利') {
      const third = Math.floor((row?.shares ?? 0) / 3);
      triggers.push(third >= 1 ? `先賣出約三分之一（約 ${fmt(third, 0)} 股）鎖住獲利` : '先賣出一部分鎖住獲利');
      if (supportAboveStop) triggers.push(`收盤跌破 ${fp(support)} → 再賣一批`);
      if (resistance != null && resistance > price) triggers.push(`站穩 ${fp(resistance)} 以上 → 剩餘部位續抱`);
      if (stop != null) triggers.push(`收盤跌破 ${fp(stop)} → 剩餘部位停損`);
    } else if (action === '減碼') {
      if (weightHigh === true) {
        const n = sharesToTarget(row, weight, R.maxWeight);
        if (n != null) triggers.push(`賣出約 ${fmt(n, 0)} 股，讓占比降到 ${frac(R.maxWeight, 0)} 以下`);
      }
      if (supportAboveStop) triggers.push(`收盤跌破 ${fp(support)} → 再減碼`);
      if (stop != null) triggers.push(`收盤跌破 ${fp(stop)} → 停損`);
      if (resistance != null && resistance > price) triggers.push(`站穩 ${fp(resistance)} 以上 → 續抱`);
    } else if (action === '加碼') {
      if (support != null) triggers.push(`回測 ${fp(support)} 不破 → 分批加碼`);
      if (stop != null) triggers.push(`收盤跌破 ${fp(stop)} → 停損`);
      if (resistance != null && resistance > price) triggers.push(`帶量站上 ${fp(resistance)} → 可再加碼`);
    } else {
      if (supportAboveStop) triggers.push(`收盤跌破 ${fp(support)} → 減碼`);
      if (stop != null) triggers.push(`收盤跌破 ${fp(stop)} → 停損`);
      if (resistance != null && resistance > price) triggers.push(`站穩 ${fp(resistance)} 以上 → 續抱`);
    }
  }

  // 多空訊號（依重要性排列，各取前 3 點）
  const bull = [];
  const bear = [];
  if (yoy != null) {
    const ym = /^\d{4}-\d{2}$/.test(fund?.revYm ?? '') ? `${+fund.revYm.slice(5)} 月營收` : '月營收';
    if (yoy >= S.revenueYoyUp) bull.push(`${ym}年增 ${fpct(yoy)}`);
    else if (yoy < S.revenueYoyDown) bear.push(`${ym}年減 ${fpct(-yoy)}`);
  }
  if (price != null && hi52 != null && price >= hi52) bull.push(`收盤 ${fp(price)} 創 52 週新高`);
  else if (price != null && lo52 != null && price <= lo52 * (1 + S.nearLow52)) bear.push(`收盤 ${fp(price)} 接近 52 週低點 ${fp(lo52)}`);
  if (fStreak != null && fStreak >= S.streakDays) bull.push(`外資連買 ${fStreak} 天`);
  if (fStreak != null && fStreak <= -S.streakDays) bear.push(`外資連賣 ${-fStreak} 天`);
  if (tStreak != null && tStreak >= S.streakDays) bull.push(`投信連買 ${tStreak} 天`);
  if (tStreak != null && tStreak <= -S.streakDays) bear.push(`投信連賣 ${-tStreak} 天`);
  if (marginChg != null && margin != null && marginChg > 0 && margin - marginChg > 0 &&
    marginChg / (margin - marginChg) >= S.marginJump) {
    bear.push(`融資大增 ${fmt(marginChg, 0)} 張（+${frac(marginChg / (margin - marginChg))}），籌碼變亂`);
  }
  if (pe != null && indPe != null) {
    if (pe <= indPe * S.peCheap) bull.push(`本益比 ${fmt(pe, 1)} 低於同業中位數 ${fmt(indPe, 1)}`);
    else if (pe >= indPe * S.peRich) bear.push(`本益比 ${fmt(pe, 1)} 是同業中位數 ${fmt(indPe, 1)} 的 ${fmt(pe / indPe, 1)} 倍`);
  }
  if (volRatio != null && volRatio >= S.volumeSpike && changePct != null && changePct !== 0) {
    (changePct > 0 ? bull : bear).push(`放量${changePct > 0 ? '上漲' : '下跌'}：成交量是 20 日均量的 ${fmt(volRatio, 1)} 倍`);
  }
  if (price != null && ma60 != null) {
    if (price > ma60) bull.push(`站上季線 ${fp(ma60)}`);
    else if (price < ma60) bear.push(`跌破季線 ${fp(ma60)}`);
  }

  // 今天該注意
  const watch = [];
  const today = DATE_RE.test(ctx.today ?? '') ? ctx.today : null;
  if (volRatio != null && volRatio >= S.volumeSpike) watch.push(`成交量是 20 日均量的 ${fmt(volRatio, 1)} 倍，有事情發生，去找新聞`);
  if (distStop != null && distStop < 0) watch.push(`已跌破停損價 ${fp(stop)}`);
  else if (distStop != null && distStop <= W.nearStop) watch.push(`距停損價 ${fp(stop)} 只剩 ${frac(distStop)}`);
  if (price != null && resistance != null && resistance >= price && (resistance - price) / price <= W.nearResistance) {
    watch.push(`距壓力 ${fp(resistance)} 只剩 ${frac((resistance - price) / price)}，看能不能帶量突破`);
  }
  const events = (Array.isArray(ctx.events) ? ctx.events : []).filter((e) => {
    const d = daysFrom(today, e?.date);
    if (d == null || d < 0 || d > W.eventDaysAhead || !e.title) return false;
    if (market === 'TW' && /美股/.test(e.title)) return false;
    if (market === 'US' && /台股/.test(e.title)) return false;
    return true;
  });
  if (today && market === 'TW' && !isEtf) {
    const day = +today.slice(8, 10);
    const y = +today.slice(0, 4);
    const m = +today.slice(5, 7);
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const published = /^\d{4}-\d{2}$/.test(fund?.revYm ?? '') && fund.revYm >= prev;
    if (day <= W.revenueDay && !published && !events.some((e) => /營收/.test(e.title))) {
      watch.push(`${+prev.slice(5)} 月營收在 ${m}/${W.revenueDay} 前公布`);
    }
    for (const r of REPORT_DEADLINES) {
      const due = `${y}-${r.md}`;
      if (due < today) continue;
      const d = daysFrom(today, due);
      if (d <= W.reportDaysAhead) watch.push(`${r.label}公布期限 ${md(due)}（還有 ${d} 天）`);
      break;
    }
  }
  for (const e of events) watch.push(`${md(e.date)} ${e.title}`);
  if (ctx.holidayNote) watch.push(ctx.holidayNote);
  else if (today && Array.isArray(ctx.upcomingHolidays)) {
    for (const h of ctx.upcomingHolidays) {
      const d = daysFrom(today, h?.date);
      if (d != null && d >= 0 && d <= W.holidayDaysAhead) watch.push(`${md(h.date)}${h.name ? `（${h.name}）` : ''}休市`);
    }
  }

  return {
    code: row?.code ?? record?.code ?? null,
    market,
    label,
    action,
    reasons,
    triggers,
    bull: bull.slice(0, S.max),
    bear: bear.slice(0, S.max),
    watch,
    levels: lv,
    returnPct: ret == null ? null : round(ret, 2),
    weight,
    checks,
  };
}

export function analyzePortfolio(rows = [], summary = {}, ctx = {}) {
  const P = RULES.portfolio;
  const risks = [];
  const advice = [];
  const list = Array.isArray(summary?.rows) && summary.rows.length ? summary.rows : rows ?? [];
  if (!list.length) return { risks, advice: ['還沒有持股，新增交易後才會有組合建議。'] };

  const label = (r) => labelOf(r, null);
  const assets = num(summary?.totalAssets);
  const count = summary?.holdingCount ?? list.length;

  if (count < P.minHoldings) {
    risks.push(`只持有 ${count} 檔股票，少於 ${P.minHoldings} 檔，單一公司出事對整體影響很大`);
    advice.push(`分散到至少 ${P.minHoldings} 檔、不同產業的股票，或搭配大盤型 ETF 分散個股風險`);
  }

  const heavy = list
    .filter((r) => num(r.assetWeight ?? r.weight) > P.maxWeight)
    .sort((a, b) => (b.assetWeight ?? b.weight) - (a.assetWeight ?? a.weight));
  for (const r of heavy) {
    const w = num(r.assetWeight ?? r.weight);
    risks.push(`${label(r)}占總資產 ${frac(w)}，超過 ${frac(P.maxWeight, 0)}`);
    const n = sharesToTarget(r, w, P.maxWeight);
    advice.push(n != null
      ? `把${label(r)}降到 ${frac(P.maxWeight, 0)} 以下：約需賣出 ${fmt(n, 0)} 股（以現價 ${fp(r.price)} 計），或之後的新資金先買其他標的`
      : `把${label(r)}的占比降到 ${frac(P.maxWeight, 0)} 以下，或之後的新資金先買其他標的`);
  }

  const industries = summary?.allocation?.byIndustry ?? [];
  for (const g of industries) {
    if (g.label === '未分類' || g.label === 'ETF') continue;
    const w = num(g.assetWeight ?? g.weight);
    if (w > P.maxIndustryWeight) {
      risks.push(`${g.label}占總資產 ${frac(w)}，超過 ${frac(P.maxIndustryWeight, 0)}，同產業的股票常常一起漲跌`);
      advice.push(`新資金優先放在${g.label}以外的產業，降低產業集中度`);
    }
  }

  const cashRatio = num(summary?.cashRatio);
  const cash = num(summary?.cashTotalTWD) ?? 0;
  if (cashRatio === 0) {
    risks.push('現金比例 0%（全倉），遇到急跌沒有資金可以應變或加碼');
    advice.push(assets > 0
      ? `保留至少 ${frac(P.minCash, 0)} 現金：以目前總資產 NT$${fmt(assets, 0)} 計，約 NT$${fmt(Math.ceil(assets * P.minCash), 0)}`
      : `保留至少 ${frac(P.minCash, 0)} 現金`);
  } else if (cashRatio != null && cashRatio < P.minCash) {
    risks.push(`現金比例 ${frac(cashRatio)}，低於 ${frac(P.minCash, 0)}`);
    advice.push(assets > 0
      ? `把現金提高到 ${frac(P.minCash, 0)}：還差約 NT$${fmt(Math.ceil(assets * P.minCash - cash), 0)}`
      : `把現金提高到 ${frac(P.minCash, 0)} 以上`);
  }

  const noPrice = list.filter((r) => r.price == null);
  if (noPrice.length) {
    risks.push(`${noPrice.length} 檔沒有收盤價（${noPrice.map(label).join('、')}），總市值與占比可能失真，請手動輸入現價`);
  }
  if (summary?.missingFx) risks.push('沒有美元匯率，美股與美元現金沒有計入總覽');

  const analyses = ctx?.analyses ?? {};
  const byAction = (a) => list.filter((r) => analyses[`${r.market}:${r.code}`]?.action === a).map(label);
  const stops = byAction('停損');
  const watches = byAction('停損觀察');
  const profits = byAction('分批停利');
  if (stops.length) advice.push(`${stops.join('、')}已跌破停損價，依紀律處理`);
  if (watches.length) advice.push(`${watches.join('、')}接近停損價，盯緊收盤價`);
  if (profits.length) advice.push(`${profits.join('、')}符合分批停利條件，可先賣出一部分鎖住獲利`);

  if (!risks.length) advice.push('組合目前沒有觸發集中度與現金規則，維持定期檢視即可');
  return { risks: risks.map(spacing), advice: advice.map(spacing) };
}
