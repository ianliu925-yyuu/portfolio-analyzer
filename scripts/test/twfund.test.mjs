import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFund, industryPe, worst } from '../lib/build.mjs';
import { parseEps, parseRevenue, parseTpexValuation, parseTwseValuation } from '../lib/twfund.mjs';
import { fixtureJson } from './helpers/fake-market.mjs';

test('monthly revenue (TWSE and TPEx share keys): 千元, rounded percentages, YYYY-MM', () => {
  const twse = parseRevenue(fixtureJson('twse/t187ap05_L.json'));
  assert.equal(twse.ym, '2026-08');
  assert.deepEqual(twse.map['1101'], {
    industry: '水泥工業',
    revYm: '2026-08',
    rev: 13515534,
    mom: -1.66,
    yoy: 10.65,
    ytdYoy: 2.7,
  });
  assert.equal(twse.map['2330'].ytdYoy, 19.24);
  const tpex = parseRevenue(fixtureJson('tpex/mopsfin_t187ap05_O.json'));
  assert.deepEqual(tpex.map['6023'], { industry: '金融業', revYm: '2026-08', rev: 344450, mom: -32.93, yoy: 22.66, ytdYoy: 42.43 });
});

test('EPS is year-to-date: TWSE 年度/基本每股盈餘(元), TPEx Year/基本每股盈餘', () => {
  const twse = parseEps(fixtureJson('twse/t187ap14_L.json'));
  assert.equal(twse.period, '2026Q2');
  assert.deepEqual(twse.map['1101'], { industry: '水泥工業', eps: 0.38, epsKey: '2026Q2', epsPeriod: '2026Q2累計' });
  assert.equal(twse.map['2002'].eps, -0.03);
  const tpex = parseEps(fixtureJson('tpex/mopsfin_t187ap14_O.json'));
  assert.deepEqual(tpex.map['5351'], { industry: '半導體業', eps: -1.05, epsKey: '2026Q2', epsPeriod: '2026Q2累計' });
  // full-width bracket variant from t187ap06_L_*
  const fw = parseEps([{ 年度: '115', 季別: '3', 公司代號: '2880', 產業別: '金融保險業', '基本每股盈餘（元）': '1.24' }]);
  assert.equal(fw.map['2880'].epsPeriod, '2026Q3累計');
});

test('valuation: "" and N/A are missing, yield 0 stays 0', () => {
  const twse = parseTwseValuation(fixtureJson('twse/BWIBBU_ALL.json'));
  assert.equal(twse.date, '2026-10-08');
  assert.deepEqual(twse.map['2330'], { pe: 29.56, pb: 10.28, yield: 0.86 });
  assert.deepEqual(twse.map['1101'], { pe: null, pb: 0.83, yield: 3.11 });
  const tpex = parseTpexValuation(fixtureJson('tpex/tpex_mainboard_peratio_analysis.json'));
  assert.deepEqual(tpex.map['5351'], { pe: null, pb: 3.21, yield: 0 });
  assert.deepEqual(tpex.map['6026'], { pe: 5.72, pb: 0.99, yield: 8.63 });
});

test('buildFund overlays fresh data on the previous fund and derives eps4q from P/E', () => {
  const prev = { revYm: '2026-08', rev: 1, mom: 1, yoy: 1, ytdYoy: 1, eps: 20, epsPeriod: '2026Q1累計', eps4q: 70, pe: 30, pb: 9, yield: 1 };
  const val = { pe: 29.56, pb: 10.28, yield: 0.86, date: '2026-10-08' };
  const f = buildFund(prev, { eps: { eps: 41.72, epsPeriod: '2026Q2累計' }, val }, 2455, '2026-10-08');
  assert.deepEqual(f, { revYm: '2026-08', rev: 1, mom: 1, yoy: 1, ytdYoy: 1, eps: 41.72, epsPeriod: '2026Q2累計', eps4q: 83.05, pe: 29.56, pb: 10.28, yield: 0.86 });
  // an older revenue month never replaces a newer one; a failed source keeps everything, eps4q included
  const kept = buildFund(f, { rev: { revYm: '2026-07', rev: 9, mom: 9, yoy: 9, ytdYoy: 9 } }, 2600, '2026-10-12');
  assert.equal(kept.revYm, '2026-08');
  assert.equal(kept.rev, 1);
  assert.deepEqual([kept.pe, kept.eps4q], [29.56, 83.05], 'no P/E today: eps4q is not re-derived from yesterday\'s P/E');
  assert.equal(buildFund(null, {}, 100), null);
});

test('buildFund ignores P/E-P/B-yield older than the close', () => {
  const prev = { pe: 12.34, pb: 1.5, yield: 3, eps4q: 4.36 };
  const frozen = buildFund(prev, { val: { pe: 99, pb: 9, yield: 9, date: '2025-01-13' } }, 53.8, '2026-10-08');
  assert.deepEqual([frozen.pe, frozen.pb, frozen.yield, frozen.eps4q], [12.34, 1.5, 3, 4.36]);
  const undated = buildFund(prev, { val: { pe: 99, pb: 9, yield: 9, date: '' } }, 53.8, '2026-10-08');
  assert.equal(undated.pe, 12.34, 'a dataset without a date cannot be checked, so it is not used');
  // P/E newer than a kept (stale) close: take the ratios, but close / P/E would mix two days
  const newer = buildFund(prev, { val: { pe: 13, pb: 1.6, yield: 2.9, date: '2026-10-12' } }, 53.8, '2026-10-08');
  assert.deepEqual([newer.pe, newer.pb, newer.yield, newer.eps4q], [13, 1.6, 2.9, 4.36]);
  const loss = buildFund(prev, { val: { pe: null, pb: 1.4, yield: 0, date: '2026-10-08' } }, 53.8, '2026-10-08');
  assert.deepEqual([loss.pe, loss.eps4q], [null, null], 'P/E N/A on the same day clears eps4q');
});

test('industryPe: median of positive P/E per TW:<industry>', () => {
  const rec = (industry, pe, type = 'stock') => ({ market: 'TW', type, industry, fund: pe == null ? null : { pe } });
  assert.deepEqual(
    industryPe([rec('半導體業', 20), rec('半導體業', 30), rec('半導體業', 25), rec('半導體業', null), rec('金融保險業', 9.87), rec('金融保險業', 10.45), rec('ETF', 50, 'etf')]),
    { 'TW:半導體業': 25, 'TW:金融保險業': 10.16 },
  );
});

test('worst() merges part statuses', () => {
  assert.equal(worst('ok', 'ok'), 'ok');
  assert.equal(worst('ok', 'stale'), 'stale');
  assert.equal(worst('ok', 'error'), 'stale');
  assert.equal(worst('error', 'error'), 'error');
});
