import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataFreshness } from '../../assets/freshness.js';

// 台灣時間 → Date（台灣固定 UTC+8）
const taipei = (s) => new Date(`${s}+08:00`);
const meta = (tw, us, generatedAt = '2026-10-23T01:34:27Z') => ({ generatedAt, tw, us });

test('dataFreshness: 交易日 N 的資料到台灣 N+1 日 10:30 還沒來才算落後', () => {
  // 週五 10/23 早上：台股停在 10/22，下一個交易日 10/23 還沒收盤
  const m = meta({ asOf: '2026-10-22', nextTradingDay: '2026-10-23' }, { asOf: '2026-10-22', nextTradingDay: '2026-10-23' });
  const fresh = dataFreshness(m, taipei('2026-10-23T10:34:27')); // generatedAt 是台灣 09:34:27
  assert.deepEqual(fresh.tw, { asOf: '2026-10-22', expected: '2026-10-23', stale: false });
  assert.equal(fresh.us.stale, false);
  assert.ok(Math.abs(fresh.ageHours - 1) < 0.01);

  assert.equal(dataFreshness(m, taipei('2026-10-24T10:29:00')).tw.stale, false);
  const late = dataFreshness(m, taipei('2026-10-24T10:30:00'));
  assert.equal(late.tw.stale, true);
  assert.equal(late.us.stale, true, '週六早上的排程應該已經補上週五美股收盤');
});

test('dataFreshness: 週末與休市不誤報', () => {
  // 週六排程後：美股到週五 10/23，下一個交易日是週一 10/26
  const weekend = meta({ asOf: '2026-10-23', nextTradingDay: '2026-10-27' }, { asOf: '2026-10-23', nextTradingDay: '2026-10-26' });
  assert.equal(dataFreshness(weekend, taipei('2026-10-25T20:00:00')).us.stale, false);
  // 10/26 台股休市：下一個交易日 10/27，到 10/28 10:30 才算落後
  assert.equal(dataFreshness(weekend, taipei('2026-10-27T18:00:00')).tw.stale, false);
  assert.equal(dataFreshness(weekend, taipei('2026-10-28T10:30:00')).tw.stale, true);
  assert.equal(dataFreshness(weekend, taipei('2026-10-27T10:30:00')).us.stale, true);
});

test('dataFreshness: 欄位缺漏時不判斷', () => {
  assert.equal(dataFreshness(null), null);
  const partial = dataFreshness({ tw: { asOf: '2026-10-22' }, us: null }, taipei('2026-10-30T12:00:00'));
  assert.deepEqual(partial, { ageHours: null, tw: null, us: null });
  // 有下一個交易日但沒有 asOf：過了期限仍算落後
  assert.equal(dataFreshness(meta({ nextTradingDay: '2026-10-23' }, null), taipei('2026-10-24T11:00:00')).tw.stale, true);
});
