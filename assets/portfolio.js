// 交易 → 持股（平均成本法）、已實現損益、股利、市值與總覽（純函式）。
// side：buy／sell；dividend＝現金股利（amount 實收金額，原幣）；split＝分割（ratio 1 股變幾股，反分割小於 1）。
import { estimateSellCosts, getBroker, inferTwType } from './fees.js';

const clean = (x) => Number(x.toPrecision(12));
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

export const holdingKey = (market, code) => `${market}:${code}`;
export const normalizeCode = (code) => String(code ?? '').trim().toUpperCase();
export const currencyOf = (market) => (market === 'US' ? 'USD' : 'TWD');

function checkTx(tx) {
  if (!tx || typeof tx !== 'object') return '格式錯誤';
  if (tx.market !== 'TW' && tx.market !== 'US') return '市場必須是 TW 或 US';
  if (!normalizeCode(tx.code)) return '缺少代號';
  if (!['buy', 'sell', 'dividend', 'split'].includes(tx.side)) return '買賣別必須是 buy、sell、dividend 或 split';
  if (!DATE_RE.test(String(tx.date ?? ''))) return '日期格式必須是 YYYY-MM-DD';
  if (tx.side === 'dividend') return num(tx.amount) > 0 ? null : '股利金額必須大於 0';
  if (tx.side === 'split') return num(tx.ratio) > 0 && num(tx.ratio) !== 1 ? null : '分割比例必須大於 0 且不是 1';
  if (!(num(tx.shares) > 0)) return '股數必須大於 0';
  if (num(tx.price) == null || num(tx.price) < 0) return '價位不正確';
  return null;
}

export function buildHoldings(transactions = []) {
  const errors = [];
  const valid = [];
  (transactions ?? []).forEach((tx, index) => {
    const problem = checkTx(tx);
    if (problem) {
      const code = normalizeCode(tx?.code);
      errors.push({ id: tx?.id ?? null, index, market: tx?.market ?? null, code, date: tx?.date ?? null,
        message: `第 ${index + 1} 筆交易${code ? `（${code}）` : ''}${problem}，已略過` });
    } else valid.push({ tx, index });
  });
  valid.sort((a, b) => (a.tx.date < b.tx.date ? -1 : a.tx.date > b.tx.date ? 1 : a.index - b.index));

  const positions = new Map();
  const realizedList = [];
  const dividendList = [];
  for (const { tx, index } of valid) {
    const market = tx.market;
    const code = normalizeCode(tx.code);
    const key = holdingKey(market, code);
    let pos = positions.get(key);
    if (!pos) {
      pos = { market, code, currency: currencyOf(market), shares: 0, costTotal: 0, realized: 0, dividends: 0, feesPaid: 0,
        firstDate: tx.date, lastDate: tx.date, openedDate: null, txCount: 0, broker: null };
      positions.set(key, pos);
    }
    const shares = num(tx.shares);
    const price = num(tx.price);
    const costs = tx.feeIncluded ? 0 : (num(tx.fee) ?? 0) + (num(tx.tax) ?? 0) + (num(tx.regFee) ?? 0);

    if (tx.side === 'dividend') {
      // 賣光後才入帳的股利也算，所以只要之前有過交易就收
      if (!pos.txCount) {
        errors.push({ id: tx.id ?? null, index, market, code, date: tx.date,
          message: `${code} 在 ${tx.date} 領股利，但之前沒有持股，已略過` });
        continue;
      }
      const amount = num(tx.amount);
      pos.dividends = clean(pos.dividends + amount);
      dividendList.push({ id: tx.id ?? null, market, code, date: tx.date, amount, currency: pos.currency });
    } else if (tx.side === 'split') {
      if (!(pos.shares > 0)) {
        errors.push({ id: tx.id ?? null, index, market, code, date: tx.date,
          message: `${code} 在 ${tx.date} 分割，但當時沒有持股，已略過` });
        continue;
      }
      // 總成本不變，股數乘上比例，平均成本跟著變
      pos.shares = clean(pos.shares * num(tx.ratio));
    } else if (tx.side === 'buy') {
      if (pos.shares === 0) pos.openedDate = tx.date;
      pos.shares = clean(pos.shares + shares);
      pos.costTotal = clean(pos.costTotal + price * shares + costs);
      pos.feesPaid = clean(pos.feesPaid + costs);
    } else {
      if (!(pos.shares > 0)) {
        errors.push({ id: tx.id ?? null, index, market, code, date: tx.date,
          message: `${code} 在 ${tx.date} 賣出 ${shares} 股，但當時沒有持股，已略過` });
        continue;
      }
      let sold = shares;
      if (shares > pos.shares) {
        sold = pos.shares;
        errors.push({ id: tx.id ?? null, index, market, code, date: tx.date,
          message: `${code} 在 ${tx.date} 賣出 ${shares} 股，但當時只持有 ${pos.shares} 股，已以 ${pos.shares} 股計算` });
      }
      const sellCosts = costs * (sold / shares);
      const proceeds = clean(price * sold - sellCosts);
      const costBasis = clean((pos.costTotal / pos.shares) * sold);
      const realized = clean(proceeds - costBasis);
      pos.realized = clean(pos.realized + realized);
      pos.feesPaid = clean(pos.feesPaid + sellCosts);
      pos.shares = clean(pos.shares - sold);
      pos.costTotal = pos.shares > 0 ? clean(pos.costTotal - costBasis) : 0;
      realizedList.push({ id: tx.id ?? null, market, code, date: tx.date, shares: sold, proceeds, costBasis, realized,
        sellCosts: clean(sellCosts), currency: pos.currency });
    }
    pos.lastDate = tx.date;
    pos.txCount += 1;
    if (tx.broker) pos.broker = tx.broker;
  }

  const all = [...positions.values()]
    .sort((a, b) => (a.market === b.market ? (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) : a.market === 'TW' ? -1 : 1))
    .map((p) => ({ ...p, avgCost: p.shares > 0 ? clean(p.costTotal / p.shares) : 0 }));
  const realizedTotal = { TW: 0, US: 0 };
  const dividendTotal = { TW: 0, US: 0 };
  for (const p of all) {
    realizedTotal[p.market] = clean(realizedTotal[p.market] + p.realized);
    dividendTotal[p.market] = clean(dividendTotal[p.market] + p.dividends);
  }

  return {
    holdings: all.filter((p) => p.shares > 0),
    closed: all.filter((p) => !(p.shares > 0)),
    realizedTotal,
    realizedList,
    dividendTotal,
    dividendList,
    errors,
  };
}

// 已實現損益與現金股利依年度 → 市場 → 代號加總（賣出日、股利入帳日的年度）。
// 台股 TWD、美股 USD 各自原幣，不換算、不合計。年度由新到舊。count 是賣出筆數。
export function realizedByYear(realizedList = [], dividendList = []) {
  const blank = () => ({ count: 0, shares: 0, proceeds: 0, costBasis: 0, sellCosts: 0, realized: 0, dividends: 0 });
  const add = (into, r) => {
    into.count += 1;
    for (const f of ['shares', 'proceeds', 'costBasis', 'sellCosts', 'realized']) into[f] = clean(into[f] + (r[f] ?? 0));
  };
  const addDividend = (into, d) => { into.dividends = clean(into.dividends + d.amount); };
  const years = new Map();
  const slot = (r) => {
    const year = Number(String(r.date).slice(0, 4));
    let y = years.get(year);
    if (!y) {
      y = { year, markets: {} };
      years.set(year, y);
    }
    const m = (y.markets[r.market] ??= { currency: currencyOf(r.market), ...blank(), stocks: new Map() });
    if (!m.stocks.has(r.code)) m.stocks.set(r.code, { code: r.code, ...blank() });
    return [m, m.stocks.get(r.code)];
  };
  for (const r of realizedList ?? []) slot(r).forEach((into) => add(into, r));
  for (const d of dividendList ?? []) slot(d).forEach((into) => addDividend(into, d));
  return [...years.values()]
    .sort((a, b) => b.year - a.year)
    .map((y) => ({
      year: y.year,
      markets: Object.fromEntries(Object.entries(y.markets).map(([k, m]) =>
        [k, { ...m, stocks: [...m.stocks.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)) }])),
    }));
}

// 資料日（record.date）那一盤開盤前已持有的股數，與當天的買進（股數、金額）。今日損益只算這些股數。
export function sessionPosition(transactions, market, code, date) {
  if (!DATE_RE.test(String(date ?? ''))) return null;
  const c = normalizeCode(code);
  const mine = (transactions ?? []).filter((t) => t && t.market === market && normalizeCode(t.code) === c);
  // 資料日當天的分割算在開盤前（收盤價與漲跌已是分割後）
  const before = buildHoldings(mine.filter((t) => String(t.date ?? '') < date || (t.date === date && t.side === 'split'))).holdings[0];
  let dayBuyShares = 0, dayBuyAmount = 0;
  for (const t of mine) {
    if (t.date !== date || t.side !== 'buy' || checkTx(t)) continue;
    dayBuyShares += num(t.shares);
    dayBuyAmount += num(t.price) * num(t.shares);
  }
  return { date, prevShares: before?.shares ?? 0, dayBuyShares: clean(dayBuyShares), dayBuyAmount: clean(dayBuyAmount) };
}

export function valueHolding(holding, record, { fx, broker, brokerOverrides, date, manualPrice, session } = {}) {
  const market = holding.market;
  const currency = currencyOf(market);
  // 手動價格只是後備：每日資料有收盤價時一律用收盤價。
  const close = positive(record?.close);
  const manual = close == null ? positive(manualPrice) : null;
  const price = close ?? manual;
  const priceSource = close != null ? 'data' : manual != null ? 'manual' : null;
  const type = record?.type ?? (market === 'TW' ? inferTwType(holding.code) : 'stock');
  const industry = (market === 'US' ? record?.sector || record?.industry : record?.industry) ||
    (type === 'etf' || type === 'bond_etf' ? 'ETF' : null);
  const rate = market === 'US' ? positive(fx) : 1;
  const toTWD = (v) => (v == null || rate == null ? null : clean(v * rate));
  const brokerObj = getBroker(broker ?? holding.broker, market, brokerOverrides);

  const missing = [];
  if (price == null) missing.push('price');
  if (rate == null) missing.push('fx');

  let marketValue = null, grossPL = null, grossPLPct = null, sellCosts = null, sellFee = null,
    sellTax = null, sellRegFee = null, netPL = null, netPLPct = null;
  if (price != null) {
    marketValue = clean(price * holding.shares);
    grossPL = clean(marketValue - holding.costTotal);
    const est = estimateSellCosts({ market, code: holding.code, type, shares: holding.shares, price, date, broker: brokerObj });
    sellCosts = est.total;
    sellFee = est.fee;
    sellTax = est.tax;
    sellRegFee = est.regFee;
    netPL = clean(marketValue - sellCosts - holding.costTotal);
    if (holding.costTotal > 0) {
      grossPLPct = clean((grossPL / holding.costTotal) * 100);
      netPLPct = clean((netPL / holding.costTotal) * 100);
    }
  }

  const change = num(record?.change);
  const fromData = priceSource === 'data';
  const dayChange = fromData ? change : null;
  const dayChangePct = fromData ? num(record?.changePct) : null;
  // dayBase：今日損益的分母（前一日收盤市值＋資料日當天買進的金額）
  let dayPL = null, dayBase = null;
  if (dayChange != null && session) {
    // 前一天收盤就持有的股數賺漲跌；資料日當天買的賺（收盤 − 買價）；資料日之後才買的不算。
    const held = Math.min(Math.max(num(session.prevShares) ?? 0, 0), holding.shares);
    const bought = num(session.dayBuyShares) ?? 0;
    const fresh = Math.min(holding.shares - held, bought);
    const buyPrice = fresh > 0 ? (num(session.dayBuyAmount) ?? 0) / bought : 0;
    dayPL = clean(dayChange * held + (price - buyPrice) * fresh);
    dayBase = clean((price - dayChange) * held + buyPrice * fresh);
  } else if (dayChange != null) {
    dayPL = clean(dayChange * holding.shares);
    dayBase = clean((price - dayChange) * holding.shares);
  }

  return {
    ...holding,
    name: record?.name || holding.code,
    type,
    industry,
    currency,
    price,
    priceSource,
    marketValue,
    grossPL,
    grossPLPct,
    sellCosts,
    sellFee,
    sellTax,
    sellRegFee,
    netPL,
    netPLPct,
    dayChange,
    dayChangePct,
    dayPL,
    fx: rate,
    costTWD: toTWD(holding.costTotal),
    valueTWD: toTWD(marketValue),
    grossPLTWD: toTWD(grossPL),
    sellCostsTWD: toTWD(sellCosts),
    netPLTWD: toTWD(netPL),
    dayPLTWD: toTWD(dayPL),
    dayBaseTWD: toTWD(dayBase),
    realizedTWD: toTWD(holding.realized),
    dividendsTWD: toTWD(holding.dividends ?? 0),
    sellBroker: brokerObj.id,
    missing,
  };
}

function group(rows, labelOf, total, assets) {
  const map = new Map();
  for (const r of rows) {
    if (r.valueTWD == null) continue;
    const label = labelOf(r);
    const g = map.get(label) ?? { key: label, label, valueTWD: 0, codes: [] };
    g.valueTWD = clean(g.valueTWD + r.valueTWD);
    g.codes.push(holdingKey(r.market, r.code));
    map.set(label, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, weight: total > 0 ? clean(g.valueTWD / total) : 0,
      assetWeight: assets > 0 ? clean(g.valueTWD / assets) : 0 }))
    .sort((a, b) => b.valueTWD - a.valueTWD);
}

export function summarize(rows = [], { cashTWD = 0, cashUSD = 0, fx, realizedTotal, dividendTotal } = {}) {
  const rate = positive(fx);
  const cashT = Math.max(num(cashTWD) ?? 0, 0);
  const cashU = Math.max(num(cashUSD) ?? 0, 0);
  const missingFx = rate == null && (cashU > 0 || rows.some((r) => r.market === 'US'));
  const cashTotalTWD = clean(cashT + (rate != null ? cashU * rate : 0));

  let marketValue = 0, costTotal = 0, pricedCost = 0, netPL = 0, grossPL = 0, sellCosts = 0, dayPL = 0, prevValue = 0;
  let priced = 0, costRows = 0, dayRows = 0;
  const missingPrice = [];
  for (const r of rows) {
    if (r.costTWD != null) {
      costTotal += r.costTWD;
      costRows += 1;
    }
    if (r.price == null) missingPrice.push(holdingKey(r.market, r.code));
    if (r.valueTWD == null) continue;
    priced += 1;
    marketValue += r.valueTWD;
    pricedCost += r.costTWD;
    netPL += r.netPLTWD;
    grossPL += r.grossPLTWD;
    sellCosts += r.sellCostsTWD;
    if (r.dayPLTWD != null) {
      dayRows += 1;
      dayPL += r.dayPLTWD;
      prevValue += r.dayBaseTWD ?? r.valueTWD - r.dayPLTWD;
    }
  }
  marketValue = clean(marketValue);
  const assets = clean(marketValue + cashTotalTWD);
  // 有持股但一檔都沒有台幣市值（缺價或缺匯率）時，總市值與損益算不出來 → null，不是 0。
  const none = rows.length > 0 && priced === 0;
  const orNull = (v) => (none ? null : clean(v));
  let cashRatio;
  if (rows.length && cashT === 0 && cashU === 0) cashRatio = 0;                       // 沒有現金：全倉
  else if (priced < rows.length || (cashU > 0 && rate == null)) cashRatio = null;  // 有持股沒計價：算不出來
  else cashRatio = assets > 0 ? clean(cashTotalTWD / assets) : null;

  let realized;
  if (realizedTotal) realized = clean((num(realizedTotal.TW) ?? 0) + (rate != null ? (num(realizedTotal.US) ?? 0) * rate : 0));
  else realized = clean(rows.reduce((s, r) => s + (r.realizedTWD ?? 0), 0));
  let dividends;
  if (dividendTotal) dividends = clean((num(dividendTotal.TW) ?? 0) + (rate != null ? (num(dividendTotal.US) ?? 0) * rate : 0));
  else dividends = clean(rows.reduce((s, r) => s + (r.dividendsTWD ?? 0), 0));

  const weighted = rows.map((r) => ({
    ...r,
    weight: r.valueTWD != null && marketValue > 0 ? clean(r.valueTWD / marketValue) : null,
    assetWeight: r.valueTWD != null && assets > 0 ? clean(r.valueTWD / assets) : null,
  }));
  const weights = {};
  const assetWeights = {};
  for (const r of weighted) {
    weights[holdingKey(r.market, r.code)] = r.weight;
    assetWeights[holdingKey(r.market, r.code)] = r.assetWeight;
  }

  const byStock = group(weighted, (r) => holdingKey(r.market, r.code), marketValue, assets)
    .map((g) => {
      const r = weighted.find((x) => holdingKey(x.market, x.code) === g.key);
      return { ...g, label: r.name && r.name !== r.code ? `${r.name}（${r.code}）` : r.code, market: r.market, code: r.code };
    });
  const byIndustry = group(weighted, (r) => r.industry || '未分類', marketValue, assets);

  return {
    currency: 'TWD',
    fx: rate,
    holdingCount: rows.length,
    pricedCount: priced,
    marketValue: orNull(marketValue),
    costTotal: rows.length && !costRows ? null : clean(costTotal),
    pricedCost: clean(pricedCost),
    grossPL: orNull(grossPL),
    grossPLPct: pricedCost > 0 ? clean((grossPL / pricedCost) * 100) : null,
    sellCosts: orNull(sellCosts),
    netPL: orNull(netPL),
    netPLPct: pricedCost > 0 ? clean((netPL / pricedCost) * 100) : null,
    dayPL: rows.length && !dayRows ? null : clean(dayPL),
    dayPLPct: prevValue > 0 ? clean((dayPL / prevValue) * 100) : null,
    realized,
    dividends,
    cashTWD: cashT,
    cashUSD: cashU,
    cashTotalTWD,
    totalAssets: assets,
    cashRatio,
    rows: weighted,
    weights,
    assetWeights,
    maxWeight: byStock[0] ? { key: byStock[0].key, label: byStock[0].label, weight: byStock[0].weight, assetWeight: byStock[0].assetWeight } : null,
    topIndustry: byIndustry[0] ? { label: byIndustry[0].label, weight: byIndustry[0].weight, assetWeight: byIndustry[0].assetWeight } : null,
    allocation: { byStock, byIndustry },
    missingPrice,
    missingFx,
  };
}
