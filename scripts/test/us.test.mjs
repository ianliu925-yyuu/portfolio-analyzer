import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanUsName, isUsUniverseStock, normalizeSymbol, parseNasdaqEtfs, parseNasdaqStocks } from '../lib/us.mjs';
import { yahooSymbol } from '../lib/yahoo.mjs';
import { fixtureJson } from './helpers/fake-market.mjs';

test('stock screener (download=true, data.rows): strings to numbers, BRK/B -> BRK.B', () => {
  const rows = parseNasdaqStocks(fixtureJson('us/nasdaq_stocks.json'));
  const by = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.equal(by['BAC^K'], undefined, 'preferred symbols are dropped');
  const { rawName, ...aapl } = by.AAPL;
  assert.equal(rawName, 'Apple Inc. Common Stock');
  assert.deepEqual(aapl, {
    code: 'AAPL',
    name: 'Apple Inc.',
    sector: 'Technology',
    industry: 'Computer Manufacturing',
    close: 258.42,
    change: 1.13,
    changePct: 0.44,
    volume: 41234567,
    marketCap: 3834563210000,
  });
  assert.equal(by['BRK.B'].close, 489.12);
  assert.equal(by.AACG.close, 0.8789);
  assert.throws(() => parseNasdaqStocks({ data: { table: {} } }), /no data.rows/);
});

test('universe: market cap >= $2B and common stock only', () => {
  const rows = parseNasdaqStocks(fixtureJson('us/nasdaq_stocks.json'));
  const kept = rows.filter((r) => isUsUniverseStock(r)).map((r) => r.code);
  assert.deepEqual(kept, ['AAPL', 'ABNB', 'AMD', 'BRK.B', 'MSFT', 'NVDA', 'TSM', 'V', 'VZ']);
});

test('universe keeps ADRs of ordinary shares and drops preferred depositary shares', () => {
  const kept = (rawName) => isUsUniverseStock({ marketCap: 1e11, rawName });
  assert.ok(kept('Alibaba Group Holding Limited American Depositary Shares each representing eight Ordinary share'));
  assert.ok(kept('Sea Limited American Depositary Shares, each representing one Class A Ordinary Share'));
  assert.ok(kept('NIO Inc. American depositary shares, each representing one Class A ordinary share'));
  assert.ok(kept('Taiwan Semiconductor Manufacturing Company Ltd.'));
  assert.ok(!kept('Wells Fargo & Company Depositary Shares, each representing a 1/1000th interest in a share of Non-Cumulative Perpetual Class A Preferred Stock, Series Z'));
  assert.ok(!kept('Capital One Financial Corporation Depositary Shares, Each Representing a 1/40th Interest in a Share of 4.800% Fixed Rate Non-Cumulative Perpetual'));
  assert.ok(!kept('Example Corp Warrants'));
  assert.equal(cleanUsName('Sea Limited American Depositary Shares, each representing one Class A Ordinary Share'), 'Sea Limited');
});

test('ETF screener (data.data.rows) and the flatter paged shape', () => {
  const map = parseNasdaqEtfs(fixtureJson('us/nasdaq_etf.json'));
  assert.deepEqual(map.VOO, { code: 'VOO', name: 'Vanguard S&P 500 ETF', close: 612.35, change: -1.2, changePct: -0.2 });
  assert.equal(map.AIVI.close, 56.8056);
  const paged = parseNasdaqEtfs({ data: { rows: [{ symbol: 'SPY', companyName: 'SPDR', lastSalePrice: '$1.00', netChange: '0', percentageChange: '0.00%' }] } });
  assert.equal(paged.SPY.close, 1);
});

test('names and symbols', () => {
  assert.equal(cleanUsName('Alphabet Inc. Class A Common Stock'), 'Alphabet Inc. Class A');
  assert.equal(cleanUsName('ATA Creativity Global American Depositary Shares'), 'ATA Creativity Global');
  assert.equal(cleanUsName('Visa Inc.'), 'Visa Inc.');
  assert.equal(normalizeSymbol(' brk/b '), 'BRK.B');
  assert.equal(yahooSymbol('US', 'BRK.B'), 'BRK-B');
  assert.equal(yahooSymbol('TW', '2330', 'TWSE'), '2330.TW');
  assert.equal(yahooSymbol('TW', '6488', 'TPEx'), '6488.TWO');
});
