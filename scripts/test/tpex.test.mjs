import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTpexIndex, parseTpexInsti, parseTpexMargin, parseTpexQuotes } from '../lib/tpex.mjs';
import { fixtureJson } from './helpers/fake-market.mjs';

test('quotes: "+" signs, trailing spaces, "----" no-trade, "除息", warrants skipped', () => {
  const { date, records } = parseTpexQuotes(fixtureJson('tpex/tpex_mainboard_quotes.json'));
  const by = Object.fromEntries(records.map((r) => [r.code, r]));
  assert.equal(date, '2026-10-08');
  assert.equal(by['70391P'], undefined);
  assert.deepEqual(by['00679B'], {
    code: '00679B',
    name: '元大美債20年',
    exchange: 'TPEx',
    type: 'bond_etf',
    date: '2026-10-08',
    close: 28.45,
    change: 0.12,
    changePct: 0.42,
    open: 28.36,
    high: 28.49,
    low: 28.33,
    volume: 18234000,
  });
  assert.equal(by['6026'].change, -0.05);
  assert.equal(by['1258'].close, null);
  assert.equal(by['1258'].volume, 0);
  assert.equal(by['8069'].close, 236.5);
  assert.equal(by['8069'].change, null, '除息 is missing, filled later from history');
  assert.equal(by['4971'].changePct, 2.8); // 8.5 / 304
});

test('3insti: keys with leading/odd spaces, shares', () => {
  const { date, map } = parseTpexInsti(fixtureJson('tpex/tpex_3insti_daily_trading.json'));
  assert.equal(date, '2026-10-08');
  // research sample arithmetic: 22145000 + 0 + 5753874 = 27898874
  assert.deepEqual(map['00679B'], { foreign: 22_145_000, trust: 0, dealer: 5_753_874 });
  assert.deepEqual(map['4971'], { foreign: 790_000, trust: 185_000, dealer: 22_000 });
});

test('3insti falls back to excluded + foreign dealers when the combined key is absent', () => {
  const rows = fixtureJson('tpex/tpex_3insti_daily_trading.json').map((r) => {
    const copy = { ...r };
    delete copy['ForeignInvestorsInclude MainlandAreaInvestors-Difference'];
    return copy;
  });
  assert.equal(parseTpexInsti(rows).map['4971'].foreign, 790_000);
});

test('margin balance in 張', () => {
  const { date, map } = parseTpexMargin(fixtureJson('tpex/tpex_mainboard_margin_balance.json'));
  assert.equal(date, '2026-10-08');
  assert.deepEqual(map['00679B'], { margin: 13382, marginChg: -120, short: 1 });
});

test('tpex_index: Gregorian dates, last row wins', () => {
  assert.deepEqual(parseTpexIndex(fixtureJson('tpex/tpex_index.json')), {
    date: '2026-10-08',
    close: 412.37,
    change: -3.55,
    changePct: -0.85,
  });
  const shuffled = fixtureJson('tpex/tpex_index.json').reverse();
  assert.equal(parseTpexIndex(shuffled).date, '2026-10-08');
});
