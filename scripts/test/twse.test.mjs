import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TWSE,
  marginFollows,
  parseHolidays,
  parseMarginDated,
  parseMarginOpenapi,
  parseT86,
  parseTaiex,
  parseTwseQuotes,
} from '../lib/twse.mjs';
import { fixture, fixtureJson } from './helpers/fake-market.mjs';

test('STOCK_DAY_ALL: ROC date, universe filter, no-trade rows', () => {
  const { date, records } = parseTwseQuotes(fixtureJson('twse/STOCK_DAY_ALL.json'));
  assert.equal(date, '2026-10-08');
  const codes = records.map((r) => r.code);
  assert.ok(!codes.includes('2881A') && !codes.includes('01001T'), 'preferred shares and REITs are skipped');
  const etf = records.find((r) => r.code === '0050');
  assert.deepEqual(etf, {
    code: '0050',
    name: '元大台灣50',
    exchange: 'TWSE',
    type: 'etf',
    date: '2026-10-08',
    close: 114.95,
    change: -1.1,
    changePct: -0.95,
    open: 115.35,
    high: 115.55,
    low: 114.9,
    volume: 99877876,
  });
  const noTrade = records.find((r) => r.code === '00625K');
  assert.equal(noTrade.close, null);
  assert.equal(noTrade.change, null);
  assert.equal(noTrade.volume, 0);
  assert.equal(records.find((r) => r.code === '00682U').volume, 81);
  assert.equal(records.find((r) => r.code === '2330').changePct, -1.01);
  assert.throws(() => parseTwseQuotes([]), /empty/);
});

test('T86 legacy array format: shares, foreign = 外陸資 + 外資自營商', () => {
  const { date, map } = parseT86(fixtureJson('twse/T86_20261008.json'));
  assert.equal(date, '2026-10-08');
  assert.deepEqual(map['2330'], { foreign: 3_456_789, trust: -120_000, dealer: 45_000 });
  // the verbatim research row: 30,088,917 + 0 foreign, dealer 9,081,338
  assert.deepEqual(map['00403A'], { foreign: 30_088_917, trust: 0, dealer: 9_081_338 });
  assert.equal(map['00632R'].foreign, 60_034_000);
});

test('T86 without field names falls back to fixed column indexes', () => {
  const json = fixtureJson('twse/T86_20261008.json');
  delete json.fields;
  assert.deepEqual(parseT86(json).map['2330'], { foreign: 3_456_789, trust: -120_000, dealer: 45_000 });
});

test('T86 rejects non-OK stat (rwd maintenance / no data)', () => {
  assert.throws(() => parseT86({ stat: '很抱歉，沒有符合條件的資料!' }), /stat/);
  assert.throws(() => parseT86(null), /stat/);
  assert.throws(() => JSON.parse(fixture('twse/rwd_maintenance.html')));
});

test('dated MI_MARGN: per-stock table by index, units 張', () => {
  const { date, map } = parseMarginDated(fixtureJson('twse/MI_MARGN_20261008.json'));
  assert.equal(date, '2026-10-08');
  assert.deepEqual(map['00400A'], { margin: 12383, marginChg: -51, short: 2 });
  assert.deepEqual(map['2330'], { margin: 23336, marginChg: -120, short: 456 });
  assert.equal(map['融資(交易單位)'], undefined, 'summary rows are not stocks');
});

test('openapi MI_MARGN matches the dated endpoint and is only dated by continuity', () => {
  const open = parseMarginOpenapi(fixtureJson('twse/MI_MARGN_openapi.json'));
  const dated = parseMarginDated(fixtureJson('twse/MI_MARGN_20261008.json'));
  for (const [code, m] of Object.entries(dated.map)) {
    assert.equal(open.map[code].margin, m.margin, code);
    assert.equal(open.map[code].short, m.short, code);
  }
  const yesterday = Object.fromEntries(Object.entries(open.map).map(([c, m]) => [c, m.marginPrev]));
  const sameDay = Object.fromEntries(Object.entries(open.map).map(([c, m]) => [c, m.margin]));
  assert.equal(marginFollows(open.map, yesterday), true, 'rows continue from stored balances');
  assert.equal(marginFollows(open.map, sameDay), false, 'rows repeat the stored day');
  assert.equal(marginFollows(open.map, {}), false, 'nothing to compare with');
});

test('MI_INDEX: TAIEX close with signed change', () => {
  assert.deepEqual(parseTaiex(fixtureJson('twse/MI_INDEX.json')), {
    date: '2026-10-08',
    close: 49313.44,
    change: -492.93,
    changePct: -0.99,
  });
  assert.throws(() => parseTaiex([{ 指數: '寶島股價指數' }]), /not found/);
});

test('holiday schedule rows', () => {
  const rows = parseHolidays(fixtureJson('twse/holidaySchedule.json'));
  assert.deepEqual(rows.find((h) => h.date === '2026-10-09'), { date: '2026-10-09', name: '國慶日' });
  assert.ok(rows.some((h) => h.name === '國曆新年開始交易日'));
});

test('dated URLs: rwd first, legacy second', () => {
  assert.deepEqual(TWSE.t86('2026-10-08'), [
    'https://www.twse.com.tw/rwd/zh/fund/T86?date=20261008&selectType=ALLBUT0999&response=json',
    'https://www.twse.com.tw/fund/T86?response=json&date=20261008&selectType=ALLBUT0999',
  ]);
  assert.match(TWSE.marginDated('2026-10-08')[1], /exchangeReport\/MI_MARGN\?response=json&date=20261008&selectType=ALL$/);
});
