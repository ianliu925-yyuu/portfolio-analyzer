// 交易 → 持股（平均成本法）、已實現損益、市值與總覽（純函式）。
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
  if (tx.side !== 'buy' && tx.side !== 'sell') return '買賣別必須是 buy 或 sell';
  if (!(num(tx.shares) > 0)) return '股數必須大於 0';
  if (num(tx.price) == null || num(tx.price) < 0) return '價位不正確';
  if (!DATE_RE.test(String(tx.date ?? ''))) return '日期格式必須是 YYYY-MM-DD';
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
  for (const { tx, index } of valid) {
    const market = tx.market;
    const code = normalizeCode(tx.code);
    const key = holdingKey(market, code);
    let pos = positions.get(key);
    if (!pos) {
      pos = { market, code, currency: currencyOf(market), shares: 0, costTotal: 0, realized: 0, feesPaid: 0,
        firstDate: tx.date, lastDate: tx.date, openedDate: null, txCount: 0, broker: null };
      positions.set(key, pos);
    }
    const shares = num(tx.shares);
    const price = num(tx.price);
    const costs = tx.feeIncluded ? 0 : (num(tx.fee) ?? 0) + (num(tx.tax) ?? 0) + (num(tx.regFee) ?? 0);

    if (tx.side === 'buy') {
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
        currency: pos.currency });
    }
    pos.lastDate = tx.date;
    pos.txCount += 1;
    if (tx.broker) pos.broker = tx.broker;
  }

  const all = [...positions.values()]
    .sort((a, b) => (a.market === b.market ? (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) : a.market === 'TW' ? -1 : 1))
    .map((p) => ({ ...p, avgCost: p.shares > 0 ? clean(p.costTotal / p.shares) : 0 }));
  const realizedTotal = { TW: 0, US: 0 };
  for (const p of all) realizedTotal[p.market] = clean(realizedTotal[p.market] + p.realized);

  return {
    holdings: all.filter((p) => p.shares > 0),
    closed: all.filter((p) => !(p.shares > 0)),
    realizedTotal,
    realizedList,
    errors,
  };
}

export function valueHolding(holding, record, { fx, broker, brokerOverrides, date, manualPrice } = {}) {
  const market = holding.market;
  const currency = currencyOf(market);
  const manual = positive(manualPrice);
  const close = positive(record?.close);
  const price = manual ?? close;
  const priceSource = manual != null ? 'manual' : close != null ? 'data' : null;
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
  const dayPL = dayChange != null ? clean(dayChange * holding.shares) : null;

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
    realizedTWD: toTWD(holding.realized),
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

export function summarize(rows = [], { cashTWD = 0, cashUSD = 0, fx, realizedTotal } = {}) {
  const rate = positive(fx);
  const cashT = Math.max(num(cashTWD) ?? 0, 0);
  const cashU = Math.max(num(cashUSD) ?? 0, 0);
  const missingFx = rate == null && (cashU > 0 || rows.some((r) => r.market === 'US'));
  const cashTotalTWD = clean(cashT + (rate != null ? cashU * rate : 0));

  let marketValue = 0, costTotal = 0, pricedCost = 0, netPL = 0, grossPL = 0, sellCosts = 0, dayPL = 0, prevValue = 0;
  const missingPrice = [];
  for (const r of rows) {
    if (r.costTWD != null) costTotal += r.costTWD;
    if (r.price == null) missingPrice.push(holdingKey(r.market, r.code));
    if (r.valueTWD == null) continue;
    marketValue += r.valueTWD;
    pricedCost += r.costTWD;
    netPL += r.netPLTWD;
    grossPL += r.grossPLTWD;
    sellCosts += r.sellCostsTWD;
    if (r.dayPLTWD != null) {
      dayPL += r.dayPLTWD;
      prevValue += r.valueTWD - r.dayPLTWD;
    }
  }
  marketValue = clean(marketValue);
  const assets = clean(marketValue + cashTotalTWD);

  let realized;
  if (realizedTotal) realized = clean((num(realizedTotal.TW) ?? 0) + (rate != null ? (num(realizedTotal.US) ?? 0) * rate : 0));
  else realized = clean(rows.reduce((s, r) => s + (r.realizedTWD ?? 0), 0));

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
    marketValue,
    costTotal: clean(costTotal),
    pricedCost: clean(pricedCost),
    grossPL: clean(grossPL),
    grossPLPct: pricedCost > 0 ? clean((grossPL / pricedCost) * 100) : null,
    sellCosts: clean(sellCosts),
    netPL: clean(netPL),
    netPLPct: pricedCost > 0 ? clean((netPL / pricedCost) * 100) : null,
    dayPL: clean(dayPL),
    dayPLPct: prevValue > 0 ? clean((dayPL / prevValue) * 100) : null,
    realized,
    cashTWD: cashT,
    cashUSD: cashU,
    cashTotalTWD,
    totalAssets: assets,
    cashRatio: assets > 0 ? clean(cashTotalTWD / assets) : null,
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
