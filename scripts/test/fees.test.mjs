import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TW_BROKERS, US_BROKERS, BROKERS, DEFAULT_BROKER_ID, BOND_ETF_EXEMPT_UNTIL, getBroker, brokersFor, inferTwType,
  twFee, twOrderFee, twTax, twTaxRate, usCommission, usRegFees, secFeeRate, tradeCosts, estimateSellCosts,
} from '../../assets/fees.js';

test('broker presets carry required fields', () => {
  const ids = new Set();
  for (const b of BROKERS) {
    assert.ok(!ids.has(b.id), `duplicate id ${b.id}`);
    ids.add(b.id);
    assert.ok(b.name);
    assert.ok(['TW', 'US'].includes(b.market));
    assert.ok(['即時', '日退', '月退'].includes(b.rebate), `${b.id} rebate`);
    assert.ok(['high', 'medium', 'low', 'user'].includes(b.confidence), `${b.id} confidence`);
    assert.equal(b.asOf, '2026-10-10');
    assert.equal(typeof b.note, 'string');
    if (b.confidence !== 'user') assert.match(b.source, /^https:\/\//, `${b.id} source`);
    assert.ok(Number.isFinite(b.minFee));
    if (b.market === 'TW') {
      assert.equal(b.model, 'discount');
      assert.ok(b.discount > 0 && b.discount <= 1);
      assert.ok(Number.isFinite(b.oddLotMinFee));
    } else {
      assert.ok(['zero', 'per_share', 'percent'].includes(b.model));
    }
  }
  assert.equal(BROKERS.length, TW_BROKERS.length + US_BROKERS.length);
  assert.ok(ids.has('tw_custom') && ids.has('us_custom'));
  assert.equal(DEFAULT_BROKER_ID.TW, 'tw_generic_06');
  assert.equal(DEFAULT_BROKER_ID.US, 'us_firstrade');
  const generic = getBroker('tw_generic_06', 'TW');
  assert.equal(generic.discount, 0.6);
  assert.equal(generic.minFee, 20);
  assert.equal(generic.oddLotMinFee, 1);
  assert.ok(brokersFor('US').every((b) => b.market === 'US'));
});

test('preset values from research', () => {
  const yuanta = getBroker('tw_yuanta', 'TW');
  assert.equal(yuanta.discount, 0.6);
  assert.equal(yuanta.minFee, 20);
  assert.equal(getBroker('tw_cathay', 'TW').discount, 0.28);
  assert.equal(getBroker('tw_ctbc', 'TW').confidence, 'low');
  assert.equal(getBroker('tw_ctbc', 'TW').oddLotMinFee, 20);
  assert.equal(getBroker('tw_pocket', 'TW').rebate, '即時');
  assert.equal(getBroker('tw_esun', 'TW').rebate, '月退');
  const ibkr = getBroker('us_ibkr_fixed', 'US');
  assert.deepEqual([ibkr.model, ibkr.perShare, ibkr.minFee, ibkr.maxPct], ['per_share', 0.005, 1, 0.01]);
  const cathay = getBroker('us_cathay', 'US');
  assert.deepEqual([cathay.model, cathay.rate, cathay.minFee, cathay.etfFlat], ['percent', 0.0008, 0, 3]);
  assert.equal(getBroker('us_fubon', 'US').confidence, 'low');
  assert.equal(getBroker('us_firstrade', 'US').model, 'zero');
});

test('getBroker falls back to market default and applies overrides without mutating presets', () => {
  assert.equal(getBroker('nope', 'TW').id, 'tw_generic_06');
  assert.equal(getBroker(undefined, 'US').id, 'us_firstrade');
  assert.equal(getBroker('us_cathay', 'TW').id, 'tw_generic_06');
  const custom = getBroker('tw_generic_06', 'TW', { tw_generic_06: { discount: 0.28, minFee: 1 } });
  assert.equal(custom.discount, 0.28);
  assert.equal(custom.minFee, 1);
  assert.equal(getBroker('tw_generic_06', 'TW').discount, 0.6);
  const obj = { id: 'mine', market: 'TW', discount: 0.5, minFee: 10, oddLotMinFee: 1 };
  assert.equal(getBroker(obj, 'TW').discount, 0.5);
});

test('TW fee: 1000 shares @ 580 at 6 折 → floor(580000 × 0.001425 × 0.6) = 495', () => {
  assert.equal(twFee(580000, 'tw_generic_06'), 495);
  assert.equal(twOrderFee(580, 1000, 'tw_generic_06'), 495);
});

test('TW fee floors exact integers correctly and applies minimums', () => {
  assert.equal(twFee(1000000, 'tw_generic_06'), 855); // 1,000,000 × 0.000855 = 855 exactly
  assert.equal(twFee(10000, 'tw_generic_06'), 20); // 8.55 → 8 → min 20
  assert.equal(twFee(10000, 'tw_generic_06', { oddLot: true }), 8);
  assert.equal(twFee(500, 'tw_generic_06', { oddLot: true }), 1); // 0.4275 → 0 → min 1
  assert.equal(twFee(0, 'tw_generic_06'), 0);
  assert.equal(twFee(580000, 'tw_cathay'), 231); // 580000 × 0.001425 × 0.28 = 231.42
});

test('TW order fee splits round lots and odd lots, each with its own minimum', () => {
  // 1000 股 @100：100000 × 0.000855 = 85.5 → 85；500 股：50000 × 0.000855 = 42.75 → 42
  assert.equal(twOrderFee(100, 1500, 'tw_generic_06'), 85 + 42);
  // 1000 股 @10：8.55 → 8 → 整股最低 20；50 股：0.4275 → 0 → 零股最低 1
  assert.equal(twOrderFee(10, 1050, 'tw_generic_06'), 20 + 1);
  // 只有零股：整股部分不收
  assert.equal(twOrderFee(50, 30, 'tw_generic_06'), 1);
  assert.equal(twOrderFee(50, 30, 'tw_ctbc'), 20);
  // 只有整股：零股部分不收
  assert.equal(twOrderFee(10, 2000, 'tw_generic_06'), 20);
  assert.equal(twOrderFee(0, 1000, 'tw_generic_06'), 0);
});

test('TW tax by security type and date', () => {
  assert.equal(twTax(580000, 'stock'), 1740);
  assert.equal(twTax(123457, 'stock'), 370); // 370.371 → 370
  assert.equal(twTax(580000, 'etf'), 580);
  assert.equal(BOND_ETF_EXEMPT_UNTIL, '2026-12-31');
  assert.equal(twTax(580000, 'bond_etf', '2026-10-08'), 0);
  assert.equal(twTax(580000, 'bond_etf', '2026-12-31'), 0);
  assert.equal(twTax(580000, 'bond_etf', '2027-01-04'), 580);
  assert.equal(twTaxRate('bond_etf'), 0.001); // 沒給日期：保守估 0.1%
  assert.equal(twTaxRate(undefined), 0.003);
});

test('inferTwType from code', () => {
  assert.equal(inferTwType('2330'), 'stock');
  assert.equal(inferTwType('0050'), 'etf');
  assert.equal(inferTwType('00878'), 'etf');
  assert.equal(inferTwType('00679B'), 'bond_etf');
  assert.equal(inferTwType('00937b'), 'bond_etf');
  assert.equal(inferTwType('00631L'), 'etf');
});

test('TW tradeCosts: buy has no tax, sell adds tax', () => {
  const buy = tradeCosts({ market: 'TW', side: 'buy', price: 580, shares: 1000, type: 'stock', date: '2026-10-08' });
  assert.deepEqual([buy.fee, buy.tax, buy.regFee, buy.total, buy.currency, buy.amount, buy.net], [495, 0, 0, 495, 'TWD', 580000, 580495]);
  const sell = tradeCosts({ market: 'TW', side: 'sell', price: 580, shares: 1000, type: 'stock', date: '2026-10-08' });
  assert.deepEqual([sell.fee, sell.tax, sell.total, sell.net], [495, 1740, 2235, 577765]);
  // ETF：300000 × 0.000855 = 256.5 → 256；稅 300
  const etf = tradeCosts({ market: 'TW', side: 'sell', price: 150, shares: 2000, code: '0050', date: '2026-10-08' });
  assert.deepEqual([etf.fee, etf.tax, etf.total], [256, 300, 556]);
  // 債券 ETF：30000 × 0.000855 = 25.65 → 25
  const bondNow = tradeCosts({ market: 'TW', side: 'sell', price: 30, shares: 1000, code: '00679B', date: '2026-10-08' });
  assert.deepEqual([bondNow.fee, bondNow.tax], [25, 0]);
  const bondLater = estimateSellCosts({ market: 'TW', price: 30, shares: 1000, type: 'bond_etf', date: '2027-01-05' });
  assert.deepEqual([bondLater.fee, bondLater.tax, bondLater.total], [25, 30, 55]);
  const zero = tradeCosts({ market: 'TW', side: 'buy', price: 0, shares: 1000 });
  assert.equal(zero.total, 0);
});

test('US commission models', () => {
  // IBKR Fixed：0.005/股、最低 1、最高 1%
  assert.equal(usCommission(5000, 100, 'us_ibkr_fixed'), 1); // 0.5 → 最低 1
  assert.equal(usCommission(100000, 1000, 'us_ibkr_fixed'), 5);
  assert.equal(usCommission(2, 10, 'us_ibkr_fixed'), 0.02); // 10 股 × $0.20：1% 上限
  assert.equal(usCommission(10000, 10, 'us_firstrade'), 0);
  assert.equal(usCommission(10000, 10, 'us_schwab'), 0);
  // 國泰複委託：個股 0.08%，ETF 每筆 3 美元
  assert.equal(usCommission(10000, 40, 'us_cathay'), 8);
  assert.equal(usCommission(1234.56, 5, 'us_cathay'), 0.99); // 0.987648 → 0.99
  assert.equal(usCommission(10000, 40, 'us_cathay', { isEtf: true }), 3);
  // 永豐：0.08%，最低 0.01
  assert.equal(usCommission(10, 1, 'us_sinopac'), 0.01);
  assert.equal(usCommission(0, 0, 'us_sinopac'), 0);
});

test('SEC fee by trade date, ceil to cent', () => {
  assert.equal(secFeeRate('2026-10-08'), 0.0000206);
  assert.equal(secFeeRate('2026-04-02'), 0.0000206);
  assert.equal(secFeeRate('2026-04-01'), 0);
  assert.equal(secFeeRate('2025-05-13'), 0);
  assert.equal(secFeeRate('2025-05-12'), 0.0000278);
  // 賣 $1,000：0.0206 → 0.03
  assert.deepEqual(usRegFees(1000, 10, { side: 'sell', date: '2026-10-08' }), { sec: 0.03, taf: 0, total: 0.03 });
  // 賣 $100,000：剛好 2.06，不可進位成 2.07
  assert.equal(usRegFees(100000, 100, { side: 'sell', date: '2026-10-08' }).sec, 2.06);
  assert.equal(usRegFees(1000, 10, { side: 'sell', date: '2026-01-15' }).sec, 0);
  assert.equal(usRegFees(1000, 10, { side: 'sell', date: '2025-03-03' }).sec, 0.03); // 0.0278
  assert.deepEqual(usRegFees(1000, 10, { side: 'buy', date: '2026-10-08' }), { sec: 0, taf: 0, total: 0 });
});

test('FINRA TAF: per share, max 9.79, holiday 2026-10-01..2026-12-31', () => {
  // 1000 股：0.195 → 0.20
  assert.deepEqual(usRegFees(1000, 1000, { side: 'sell', date: '2026-09-30' }), { sec: 0.03, taf: 0.2, total: 0.23 });
  assert.equal(usRegFees(1000, 1000, { side: 'sell', date: '2026-10-01' }).taf, 0);
  assert.equal(usRegFees(1000, 1000, { side: 'sell', date: '2026-12-31' }).taf, 0);
  assert.equal(usRegFees(1000, 1000, { side: 'sell', date: '2027-01-04' }).taf, 0.2);
  assert.equal(usRegFees(500000, 100000, { side: 'sell', date: '2026-09-30' }).taf, 9.79); // 19.5 → 上限
  assert.equal(usRegFees(10, 1, { side: 'sell', date: '2026-09-30' }).taf, 0.01); // 0.000195 → 0.01
  assert.equal(usRegFees(46000, 46000, { side: 'sell', date: '2026-09-30' }).taf, 8.97); // 浮點會算成 8.9700000001，不可進位成 8.98
});

test('US tradeCosts combine commission and sell-side regulatory fees', () => {
  const sell = tradeCosts({ market: 'US', side: 'sell', price: 100, shares: 10, date: '2026-10-08', broker: 'us_ibkr_fixed' });
  assert.deepEqual([sell.fee, sell.regFee, sell.secFee, sell.taf, sell.tax, sell.total, sell.currency, sell.net],
    [1, 0.03, 0.03, 0, 0, 1.03, 'USD', 998.97]);
  const buy = tradeCosts({ market: 'US', side: 'buy', price: 100, shares: 10, date: '2026-10-08', broker: 'us_cathay', type: 'etf' });
  assert.deepEqual([buy.fee, buy.regFee, buy.total, buy.net], [3, 0, 3, 1003]);
  const est = estimateSellCosts({ market: 'US', shares: 1000, price: 1, date: '2026-09-30' });
  assert.equal(est.broker, 'us_firstrade');
  assert.equal(est.total, 0.23);
});
