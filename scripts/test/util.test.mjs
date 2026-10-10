import assert from 'node:assert/strict';
import test from 'node:test';
import {
  gregDate,
  isTwCode,
  keyed,
  median,
  normKey,
  num,
  pctChange,
  rocDate,
  rocYm,
  round,
  roundPx,
  twBucket,
  twType,
  usBucket,
} from '../lib/util.mjs';

test('num: comma numbers, signs, currency/percent and placeholders', () => {
  assert.equal(num('1,234,567'), 1234567);
  assert.equal(num('-1.1000'), -1.1);
  assert.equal(num('+0.12'), 0.12);
  assert.equal(num('-0.05 '), -0.05);
  assert.equal(num('$123.45'), 123.45);
  assert.equal(num('-3.471%'), -3.471);
  assert.equal(num('0.00'), 0);
  assert.equal(num(42), 42);
  for (const missing of ['', '--', '---', '----', 'N/A', '-', '除息', '除權息', ' ', null, undefined, 'abc', NaN]) {
    assert.equal(num(missing), null, `expected null for ${JSON.stringify(missing)}`);
  }
});

test('ROC and Gregorian dates', () => {
  assert.equal(rocDate('1151008'), '2026-10-08');
  assert.equal(rocDate('1150101'), '2026-01-01');
  assert.equal(rocDate('991231'), '2010-12-31');
  assert.equal(rocDate('115/10/08'), '2026-10-08');
  assert.equal(rocDate(''), null);
  assert.equal(rocDate('1151308'), null);
  assert.equal(rocYm('11508'), '2026-08');
  assert.equal(rocYm('11513'), null);
  assert.equal(gregDate('20261008'), '2026-10-08');
  assert.equal(gregDate('1151008'), null);
});

test('keyed lookup ignores irregular whitespace and bracket width', () => {
  const get = keyed({
    ' Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Total Sell': '2000',
    'ForeignInvestorsInclude MainlandAreaInvestors-Difference': '22145000',
    '基本每股盈餘（元）': '1.24',
  });
  assert.equal(get('Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Total Sell'), '2000');
  assert.equal(get('ForeignInvestorsIncludeMainlandAreaInvestors-Difference'), '22145000');
  assert.equal(get('missing', '基本每股盈餘(元)'), '1.24');
  assert.equal(get('nope'), undefined);
  assert.equal(normKey(' A b　C（x） '), 'abc(x)');
});

test('TW universe codes, types and buckets', () => {
  for (const code of ['2330', '0050', '006208', '00679B', '00400A', '00625K']) assert.ok(isTwCode(code), code);
  for (const code of ['2881A', '01001T', '70391P', '030001', '123', '']) assert.ok(!isTwCode(code), code);
  assert.equal(twType('2330'), 'stock');
  assert.equal(twType('0050'), 'etf');
  assert.equal(twType('00400A'), 'etf');
  assert.equal(twType('00679B'), 'bond_etf');
  assert.equal(twBucket('00679B'), '00');
  assert.equal(twBucket('2330'), '23');
  assert.equal(usBucket('brk.b'), 'B');
});

test('rounding, median and percent change', () => {
  assert.equal(round(1.005, 2), 1.01);
  assert.equal(round(-1.005, 2), -1.01);
  assert.equal(round(null), null);
  assert.equal(roundPx(1001.5333), 1001.53);
  assert.equal(roundPx(0.87894), 0.8789);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(pctChange(114.95, -1.1), -0.95);
  assert.equal(pctChange(null, 1), null);
});
