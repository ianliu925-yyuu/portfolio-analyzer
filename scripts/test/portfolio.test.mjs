import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHoldings, valueHolding, summarize, holdingKey, sessionPosition, realizedByYear } from '../../assets/portfolio.js';

const near = (actual, expected, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

const tx = (o) => ({ market: 'TW', code: '2330', side: 'buy', feeIncluded: false, fee: 0, tax: 0, regFee: 0, ...o });

// 買 1000 @580（手續費 495）、買 1000 @600（513）、賣 500 @650（手續費 277、稅 975）
const BUY_BUY_SELL = [
  tx({ id: 't1', shares: 1000, price: 580, date: '2026-01-05', fee: 495, broker: 'tw_generic_06' }),
  tx({ id: 't2', shares: 1000, price: 600, date: '2026-02-05', fee: 513 }),
  tx({ id: 't3', side: 'sell', shares: 500, price: 650, date: '2026-03-05', fee: 277, tax: 975 }),
];

test('average cost through buy / buy / sell', () => {
  const { holdings, realizedTotal, realizedList, errors } = buildHoldings(BUY_BUY_SELL);
  assert.deepEqual(errors, []);
  assert.equal(holdings.length, 1);
  const h = holdings[0];
  // 成本 580495 + 600513 = 1181008，平均 590.504；賣 500 股成本 295252
  assert.equal(h.shares, 1500);
  assert.equal(h.costTotal, 885756);
  assert.equal(h.avgCost, 590.504);
  // 淨收入 325000 − 277 − 975 = 323748；已實現 323748 − 295252 = 28496
  assert.equal(h.realized, 28496);
  assert.deepEqual(realizedTotal, { TW: 28496, US: 0 });
  assert.deepEqual(realizedList.map((r) => [r.id, r.shares, r.proceeds, r.costBasis, r.realized]),
    [['t3', 500, 323748, 295252, 28496]]);
  assert.equal(h.feesPaid, 495 + 513 + 277 + 975);
  assert.deepEqual([h.firstDate, h.lastDate, h.openedDate, h.txCount, h.broker, h.currency],
    ['2026-01-05', '2026-03-05', '2026-01-05', 3, 'tw_generic_06', 'TWD']);
});

test('realizedByYear: 依年度、市場、代號加總，台美股各自原幣', () => {
  const us = (o) => tx({ market: 'US', code: 'AAPL', ...o });
  const { realizedList } = buildHoldings([
    ...BUY_BUY_SELL,
    tx({ code: '2317', shares: 1000, price: 100, date: '2025-05-01' }),
    tx({ code: '2317', side: 'sell', shares: 1000, price: 110, date: '2025-06-01', fee: 10, tax: 330 }),
    us({ shares: 10, price: 200, date: '2025-01-02' }),
    us({ side: 'sell', shares: 4, price: 250, date: '2025-12-31', fee: 1, regFee: 0.03 }),
    us({ side: 'sell', shares: 6, price: 150, date: '2026-01-10' }),
  ]);
  assert.equal(realizedList.find((r) => r.id === 't3').sellCosts, 277 + 975);

  const years = realizedByYear(realizedList);
  assert.deepEqual(years.map((y) => y.year), [2026, 2025]);
  const pick = (m) => [m.currency, m.count, m.shares, m.proceeds, m.costBasis, m.sellCosts, m.realized];
  const [y2026, y2025] = years;
  assert.deepEqual(pick(y2026.markets.TW), ['TWD', 1, 500, 323748, 295252, 1252, 28496]);
  assert.deepEqual(pick(y2026.markets.US), ['USD', 1, 6, 900, 1200, 0, -300]);
  assert.deepEqual(pick(y2025.markets.TW), ['TWD', 1, 1000, 109660, 100000, 340, 9660]);
  assert.deepEqual(pick(y2025.markets.US), ['USD', 1, 4, 998.97, 800, 1.03, 198.97]);
  assert.deepEqual(y2026.markets.TW.stocks.map((s) => [s.code, s.realized]), [['2330', 28496]]);
  assert.deepEqual(realizedByYear([]), []);
});

test('feeIncluded: price already includes buy costs, fee is ignored', () => {
  const { holdings } = buildHoldings([tx({ shares: 1000, price: 580.5, date: '2026-01-05', feeIncluded: true, fee: 495 })]);
  assert.equal(holdings[0].costTotal, 580500);
  assert.equal(holdings[0].avgCost, 580.5);
  assert.equal(holdings[0].feesPaid, 0);
  const off = buildHoldings([tx({ shares: 1000, price: 580, date: '2026-01-05', fee: 495 })]);
  assert.equal(off.holdings[0].costTotal, 580495);
});

test('transactions sorted by date, then input order', () => {
  const list = [
    tx({ id: 's', side: 'sell', shares: 1000, price: 120, date: '2026-03-01' }),
    tx({ id: 'b2', shares: 1000, price: 110, date: '2026-02-01' }),
    tx({ id: 'b1', shares: 1000, price: 100, date: '2026-01-01' }),
  ];
  const { holdings, realizedList, errors } = buildHoldings(list);
  assert.deepEqual(errors, []);
  assert.equal(holdings[0].shares, 1000);
  assert.equal(realizedList[0].realized, 120000 - 105000); // 平均成本 105
  // 同一天：先買後賣（依輸入順序）
  const sameDay = buildHoldings([
    tx({ shares: 1000, price: 100, date: '2026-01-01' }),
    tx({ side: 'sell', shares: 1000, price: 101, date: '2026-01-01' }),
  ]);
  assert.deepEqual(sameDay.errors, []);
  assert.equal(sameDay.closed[0].realized, 1000);
  // 同一天但輸入順序是先賣：賣出時沒有持股
  const reversed = buildHoldings([
    tx({ side: 'sell', shares: 1000, price: 101, date: '2026-01-01' }),
    tx({ shares: 1000, price: 100, date: '2026-01-01' }),
  ]);
  assert.equal(reversed.errors.length, 1);
  assert.equal(reversed.holdings[0].shares, 1000);
});

test('overselling is reported and clamped, fees prorated', () => {
  const { holdings, closed, errors, realizedTotal } = buildHoldings([
    tx({ id: 'b', shares: 1000, price: 100, date: '2026-01-02', fee: 85 }),
    tx({ id: 's', side: 'sell', shares: 1500, price: 110, date: '2026-02-02', fee: 141, tax: 495 }),
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 's');
  assert.match(errors[0].message, /只持有 1000 股/);
  assert.equal(holdings.length, 0);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].shares, 0);
  assert.equal(closed[0].costTotal, 0);
  // 費用按 1000/1500 比例：(141 + 495) × 2/3 = 424；110000 − 424 − 100085 = 9491
  assert.equal(realizedTotal.TW, 9491);
});

test('invalid transactions and sells without holdings are skipped with errors', () => {
  const { holdings, errors } = buildHoldings([
    tx({ id: 'x1', shares: 0, price: 100, date: '2026-01-01' }),
    tx({ id: 'x2', shares: 10, price: 100, date: '2026/01/01' }),
    tx({ id: 'x3', side: 'hold', shares: 10, price: 100, date: '2026-01-01' }),
    tx({ id: 'x4', market: 'JP', shares: 10, price: 100, date: '2026-01-01' }),
    tx({ id: 'x5', code: '2317', side: 'sell', shares: 10, price: 100, date: '2026-01-01' }),
    null,
  ]);
  assert.equal(holdings.length, 0);
  assert.deepEqual(errors.map((e) => e.id), ['x1', 'x2', 'x3', 'x4', null, 'x5']);
  assert.ok(errors.every((e) => typeof e.message === 'string' && e.message.length > 0));
});

test('US realized and code normalisation', () => {
  const { holdings, realizedTotal } = buildHoldings([
    { id: 'u1', market: 'US', code: 'aapl ', side: 'buy', shares: 10, price: 200, date: '2026-03-05', feeIncluded: false, fee: 0 },
    { id: 'u2', market: 'US', code: 'AAPL', side: 'sell', shares: 4, price: 250, date: '2026-10-08', feeIncluded: false, fee: 0, regFee: 0.03 },
  ]);
  assert.equal(holdings[0].code, 'AAPL');
  assert.equal(holdings[0].currency, 'USD');
  assert.equal(holdings[0].shares, 6);
  assert.equal(holdings[0].costTotal, 1200);
  assert.equal(realizedTotal.US, 199.97); // 1000 − 0.03 − 800
});

const TW_REC = { code: '2330', name: '台積電', market: 'TW', type: 'stock', industry: '半導體業', close: 600, change: 5, changePct: 0.84 };
const US_REC = { code: 'AAPL', name: 'Apple Inc.', market: 'US', type: 'stock', sector: 'Technology', close: 250, change: -2, changePct: -0.79 };
const twHolding = () => buildHoldings(BUY_BUY_SELL).holdings[0];
const usHolding = () => ({ market: 'US', code: 'AAPL', currency: 'USD', shares: 10, costTotal: 2000, avgCost: 200, realized: 0, broker: null });

test('valueHolding TW: net P/L deducts estimated sell fee and tax', () => {
  const row = valueHolding(twHolding(), TW_REC, { date: '2026-10-10', broker: 'tw_generic_06' });
  assert.equal(row.price, 600);
  assert.equal(row.priceSource, 'data');
  assert.equal(row.marketValue, 900000);
  assert.equal(row.grossPL, 900000 - 885756);
  // 賣出 1500 股：整股 600000 × 0.000855 = 513；零股 300000 × 0.000855 = 256.5 → 256；稅 2700
  assert.equal(row.sellFee, 769);
  assert.equal(row.sellTax, 2700);
  assert.equal(row.sellCosts, 3469);
  assert.equal(row.netPL, 10775);
  near(row.netPLPct, (10775 / 885756) * 100);
  assert.equal(row.dayChange, 5);
  assert.equal(row.dayPL, 7500);
  assert.equal(row.currency, 'TWD');
  assert.equal(row.valueTWD, 900000);
  assert.equal(row.netPLTWD, 10775);
  assert.equal(row.industry, '半導體業');
  assert.equal(row.name, '台積電');
  assert.deepEqual(row.missing, []);
});

test('valueHolding US: converts to TWD with fx and includes SEC fee', () => {
  const row = valueHolding(usHolding(), US_REC, { fx: 32, date: '2026-10-10' });
  assert.equal(row.marketValue, 2500);
  assert.equal(row.sellCosts, 0.06); // SEC 2500 × 0.0000206 = 0.0515 → 0.06；TAF 暫停
  assert.equal(row.netPL, 499.94);
  assert.equal(row.netPLPct, 24.997);
  assert.equal(row.valueTWD, 80000);
  assert.equal(row.costTWD, 64000);
  near(row.netPLTWD, 15998.08);
  assert.equal(row.dayPLTWD, -640);
  assert.equal(row.industry, 'Technology');
  assert.equal(row.sellBroker, 'us_firstrade');
});

test('valueHolding: manual price, missing record, missing fx', () => {
  // 手動價格只是後備：有每日收盤價時用收盤價
  const withClose = valueHolding(twHolding(), TW_REC, { date: '2026-10-10', manualPrice: 610 });
  assert.equal(withClose.price, 600);
  assert.equal(withClose.priceSource, 'data');
  assert.equal(withClose.dayPL, 7500);
  const manual = valueHolding(twHolding(), { ...TW_REC, close: null }, { date: '2026-10-10', manualPrice: 610 });
  assert.equal(manual.price, 610);
  assert.equal(manual.priceSource, 'manual');
  assert.equal(manual.marketValue, 915000);
  assert.equal(manual.dayPL, null);
  assert.equal(valueHolding(twHolding(), null, { manualPrice: 610 }).priceSource, 'manual');
  const none = valueHolding(twHolding(), undefined, { date: '2026-10-10' });
  assert.equal(none.price, null);
  assert.equal(none.marketValue, null);
  assert.equal(none.netPL, null);
  assert.deepEqual(none.missing, ['price']);
  assert.equal(none.name, '2330');
  assert.equal(none.costTWD, 885756);
  const noFx = valueHolding(usHolding(), US_REC, { date: '2026-10-10' });
  assert.equal(noFx.marketValue, 2500);
  assert.equal(noFx.valueTWD, null);
  assert.deepEqual(noFx.missing, ['fx']);
  const etf = valueHolding({ market: 'TW', code: '00679B', shares: 1000, costTotal: 30000, avgCost: 30, realized: 0 },
    { code: '00679B', close: 31, type: 'bond_etf' }, { date: '2026-10-10' });
  assert.equal(etf.sellTax, 0);
  assert.equal(etf.industry, 'ETF');
});

test('sessionPosition + valueHolding: 今日損益只算資料日開盤前就持有的股數', () => {
  const rec = { close: 1025, change: 15, changePct: 1.49, date: '2026-10-08' };
  // 資料日之後才買：不算漲跌
  const late = [tx({ id: 'a', shares: 1000, price: 1000, date: '2026-10-10' })];
  const s1 = sessionPosition(late, 'TW', '2330', rec.date);
  assert.deepEqual(s1, { date: '2026-10-08', prevShares: 0, dayBuyShares: 0, dayBuyAmount: 0 });
  assert.equal(valueHolding(buildHoldings(late).holdings[0], rec, { session: s1 }).dayPL, 0);
  // 前一天就有 1000 股；資料日當天買 500 @1020（賺 1025 − 1020）；之後又買 200（不算）
  const mixed = [
    tx({ id: 'a', shares: 1000, price: 1000, date: '2026-10-01' }),
    tx({ id: 'b', shares: 500, price: 1020, date: '2026-10-08' }),
    tx({ id: 'c', shares: 200, price: 1030, date: '2026-10-09' }),
    tx({ id: 'x', code: '2317', shares: 9000, price: 100, date: '2026-10-01' }),
  ];
  const s2 = sessionPosition(mixed, 'TW', '2330', rec.date);
  assert.deepEqual([s2.prevShares, s2.dayBuyShares, s2.dayBuyAmount], [1000, 500, 510000]);
  const h = buildHoldings(mixed).holdings.find((x) => x.code === '2330');
  const v2 = valueHolding(h, rec, { session: s2 });
  assert.equal(v2.dayPL, 15 * 1000 + 5 * 500);
  // 今日損益% 的分母：前一日收盤市值 1000 × 1010 + 當天買進 510000（之後買的 200 股不算）
  assert.equal(v2.dayBaseTWD, 1010000 + 510000);
  assert.ok(Math.abs(summarize([v2]).dayPLPct - (17500 / 1520000) * 100) < 1e-9);
  // 資料日當天賣掉一部分：只算還留著的股數
  const sold = [
    tx({ id: 'a', shares: 1000, price: 1000, date: '2026-10-01' }),
    tx({ id: 's', side: 'sell', shares: 400, price: 1020, date: '2026-10-08' }),
  ];
  const h2 = buildHoldings(sold).holdings[0];
  assert.equal(valueHolding(h2, rec, { session: sessionPosition(sold, 'TW', '2330', rec.date) }).dayPL, 15 * 600);
  // 沒有 session（不知道資料日）→ 沿用 漲跌 × 股數
  assert.equal(valueHolding(h2, rec, {}).dayPL, 15 * 600);
  assert.equal(sessionPosition(sold, 'TW', '2330', null), null);
});

test('summarize: totals in TWD, weights, cash ratio, allocation', () => {
  const tw = valueHolding(twHolding(), TW_REC, { date: '2026-10-10' });
  const tw2 = valueHolding({ market: 'TW', code: '2303', shares: 2000, costTotal: 90000, avgCost: 45, realized: 0 },
    { code: '2303', name: '聯電', industry: '半導體業', close: 50, change: 0, changePct: 0, type: 'stock' }, { date: '2026-10-10' });
  const us = valueHolding(usHolding(), US_REC, { fx: 32, date: '2026-10-10' });
  const s = summarize([tw, tw2, us], { cashTWD: 100000, cashUSD: 1000, fx: 32, realizedTotal: { TW: 28496, US: 199.97 } });
  // 市值 900000 + 100000 + 80000；現金 100000 + 32000
  assert.equal(s.marketValue, 1080000);
  assert.equal(s.costTotal, 885756 + 90000 + 64000);
  assert.equal(s.cashTotalTWD, 132000);
  assert.equal(s.totalAssets, 1212000);
  near(s.cashRatio, 132000 / 1212000);
  // tw2 賣出：100000 × 0.000855 = 85.5 → 85；稅 300 → 淨損益 100000 − 385 − 90000 = 9615
  near(s.netPL, 10775 + 9615 + 15998.08);
  near(s.netPLPct, (s.netPL / s.costTotal) * 100);
  near(s.grossPL, 14244 + 10000 + 16000);
  // 今日損益 7500 + 0 − 640
  assert.equal(s.dayPL, 6860);
  near(s.dayPLPct, (6860 / (1080000 - 6860)) * 100);
  near(s.realized, 28496 + 199.97 * 32);
  near(s.weights[holdingKey('TW', '2330')], 900000 / 1080000);
  near(s.assetWeights[holdingKey('TW', '2330')], 900000 / 1212000);
  near(s.rows[2].weight, 80000 / 1080000);
  assert.equal(s.holdingCount, 3);
  assert.equal(s.allocation.byStock[0].label, '台積電（2330）');
  assert.deepEqual(s.allocation.byIndustry.map((g) => [g.label, g.valueTWD]), [['半導體業', 1000000], ['Technology', 80000]]);
  near(s.allocation.byIndustry[0].weight, 1000000 / 1080000);
  assert.equal(s.topIndustry.label, '半導體業');
  assert.equal(s.maxWeight.key, 'TW:2330');
  assert.deepEqual(s.missingPrice, []);
  assert.equal(s.missingFx, false);
});

test('summarize: no cash → cashRatio 0; missing price and fx flagged', () => {
  const tw = valueHolding(twHolding(), TW_REC, { date: '2026-10-10' });
  const s = summarize([tw], {});
  assert.equal(s.cashRatio, 0);
  assert.equal(s.realized, 28496);
  const noPrice = valueHolding(twHolding(), null, { date: '2026-10-10' });
  const us = valueHolding(usHolding(), US_REC, { date: '2026-10-10' });
  const s2 = summarize([tw, noPrice, us], { cashUSD: 100 });
  assert.deepEqual(s2.missingPrice, ['TW:2330']);
  assert.equal(s2.missingFx, true);
  assert.equal(s2.marketValue, 900000);
  assert.equal(s2.costTotal, 885756 * 2);
  near(s2.netPLPct, (10775 / 885756) * 100); // 只用有價格的成本計算報酬率
  const empty = summarize([], {});
  assert.equal(empty.marketValue, 0);
  assert.equal(empty.cashRatio, null);
  assert.equal(empty.netPLPct, null);
  // 只有現金
  assert.equal(summarize([], { cashTWD: 1000 }).cashRatio, 1);
});

test('summarize: nothing priced → totals are null, not 0; cash ratio needs every holding priced', () => {
  const noPrice = valueHolding(twHolding(), null, { date: '2026-10-10' });
  const none = summarize([noPrice], { cashTWD: 100000 });
  assert.equal(none.pricedCount, 0);
  for (const k of ['marketValue', 'grossPL', 'netPL', 'sellCosts', 'dayPL', 'cashRatio']) assert.equal(none[k], null, k);
  assert.equal(none.costTotal, 885756);
  // 沒有現金時仍可判斷全倉
  assert.equal(summarize([noPrice], {}).cashRatio, 0);
  // 美股缺匯率：成本、市值都算不出台幣
  const us = valueHolding(usHolding(), US_REC, { date: '2026-10-10' });
  const usOnly = summarize([us], { cashTWD: 1000 });
  assert.deepEqual([usOnly.marketValue, usOnly.costTotal, usOnly.netPL, usOnly.cashRatio], [null, null, null, null]);
  // 部分有價格：市值是有價格的部分，現金比例算不出來
  const tw = valueHolding(twHolding(), TW_REC, { date: '2026-10-10' });
  const part = summarize([tw, noPrice], { cashTWD: 100000 });
  assert.equal(part.marketValue, 900000);
  assert.equal(part.pricedCount, 1);
  assert.equal(part.cashRatio, null);
});

test('cash dividends: 不動股數成本，累計到 dividends、dividendTotal、dividendList', () => {
  const div = (o) => ({ market: 'TW', code: '2330', side: 'dividend', ...o });
  const { holdings, closed, dividendTotal, dividendList, errors } = buildHoldings([
    tx({ id: 'b', shares: 1000, price: 580, date: '2025-01-05', fee: 495 }),
    div({ id: 'd1', amount: 4500, date: '2025-07-10' }),
    div({ id: 'd2', amount: 5000, date: '2026-01-10' }),
    tx({ code: '2317', shares: 1000, price: 100, date: '2025-01-05' }),
    tx({ code: '2317', side: 'sell', shares: 1000, price: 110, date: '2025-06-01' }),
    div({ id: 'd3', code: '2317', amount: 5300, date: '2025-08-01' }), // 賣光後才入帳
    div({ id: 'd4', code: '2454', amount: 100, date: '2025-08-01' }),  // 從來沒有持股
    div({ id: 'd5', amount: 0, date: '2025-08-01' }),
  ]);
  assert.deepEqual(errors.map((e) => e.id), ['d5', 'd4']);
  const h = holdings.find((x) => x.code === '2330');
  assert.deepEqual([h.shares, h.costTotal, h.dividends], [1000, 580495, 9500]);
  assert.equal(closed.find((x) => x.code === '2317').dividends, 5300);
  assert.deepEqual(dividendTotal, { TW: 14800, US: 0 });
  assert.deepEqual(dividendList.map((d) => [d.id, d.amount, d.currency]), [['d1', 4500, 'TWD'], ['d3', 5300, 'TWD'], ['d2', 5000, 'TWD']]);

  const years = realizedByYear(buildHoldings([
    tx({ shares: 1000, price: 580, date: '2025-01-05' }),
    div({ amount: 4500, date: '2025-07-10' }),
    tx({ side: 'sell', shares: 500, price: 600, date: '2025-09-01' }),
    div({ amount: 2500, date: '2026-01-10' }),
  ]).realizedList, buildHoldings([
    tx({ shares: 1000, price: 580, date: '2025-01-05' }),
    div({ amount: 4500, date: '2025-07-10' }),
    div({ amount: 2500, date: '2026-01-10' }),
  ]).dividendList);
  assert.deepEqual(years.map((y) => [y.year, y.markets.TW.count, y.markets.TW.realized, y.markets.TW.dividends]),
    [[2026, 0, 0, 2500], [2025, 1, 10000, 4500]]);

  const row = valueHolding(h, { close: 600 }, { date: '2026-10-08' });
  assert.equal(row.dividendsTWD, 9500);
  const s = summarize([row], { dividendTotal: { TW: 9500, US: 10 }, fx: 32 });
  assert.equal(s.dividends, 9820);
});

test('splits: 股數乘比例、總成本不變；反分割；沒有持股報錯', () => {
  const split = (o) => ({ market: 'US', code: 'NVDA', side: 'split', ...o });
  const us = (o) => tx({ market: 'US', code: 'NVDA', ...o });
  const { holdings, realizedList, errors } = buildHoldings([
    us({ shares: 10, price: 1000, date: '2024-05-01', fee: 1 }),
    split({ id: 's1', ratio: 10, date: '2024-06-10' }),
    us({ side: 'sell', shares: 50, price: 120, date: '2024-07-01' }), // 分割後才有 100 股可賣
    split({ id: 's2', code: 'AAPL', ratio: 4, date: '2024-06-10' }),
    split({ id: 's3', ratio: 1, date: '2024-06-11' }),
  ]);
  assert.deepEqual(errors.map((e) => e.id), ['s3', 's2']);
  const h = holdings[0];
  assert.equal(h.shares, 50);
  assert.equal(h.avgCost, 100.01);
  assert.equal(realizedList[0].realized, 50 * 120 - 50 * 100.01);

  const rev = buildHoldings([us({ shares: 100, price: 2, date: '2025-01-01' }), split({ ratio: 0.1, date: '2025-02-01' })]).holdings[0];
  assert.deepEqual([rev.shares, rev.costTotal, rev.avgCost], [10, 200, 20]);

  // 資料日當天的分割算在開盤前：前一日持股用分割後股數
  const s = sessionPosition([us({ shares: 10, price: 1000, date: '2024-05-01' }), split({ ratio: 10, date: '2024-06-10' })],
    'US', 'NVDA', '2024-06-10');
  assert.equal(s.prevShares, 100);
});
