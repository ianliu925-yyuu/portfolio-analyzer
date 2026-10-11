import assert from 'node:assert/strict';
import test from 'node:test';
import { computeChips, computeHist, mergeBars, mergeChip } from '../lib/history.mjs';

const day = (i) => `2026-01-${String(i).padStart(2, '0')}`;
const series = (n, close = (i) => i, volume = (i) => i * 1000) =>
  Array.from({ length: n }, (_, k) => [`D${String(k + 1).padStart(3, '0')}`, close(k + 1), volume(k + 1)]);

test('mergeBars de-duplicates by date; the preferred side wins and its nulls are filled', () => {
  const existing = [
    [day(1), 10, 100],
    [day(2), 11, 110],
  ];
  const incoming = [
    [day(3), 12, 120],
    [day(2), 11.5, null],
    [day(4), null, 5],
  ];
  assert.deepEqual(mergeBars(existing, incoming), [
    [day(1), 10, 100],
    [day(2), 11.5, 110],
    [day(3), 12, 120],
  ]);
  assert.deepEqual(mergeBars(existing, incoming, { prefer: 'existing' })[1], [day(2), 11, 110]);
  assert.deepEqual(mergeBars(existing, incoming, { max: 2 }).map((b) => b[0]), [day(2), day(3)]);
  assert.deepEqual(mergeBars(undefined, [[day(5), 1, undefined]]), [[day(5), 1, null]]);
});

test('computeHist on 25 bars (closes 101..125, volumes 1000..25000)', () => {
  const bars = series(25, (i) => 100 + i);
  assert.deepEqual(computeHist(bars), {
    days: 25,
    d5Pct: 4.17, // 125 / 120 - 1
    d20Pct: 19.05, // 125 / 105 - 1
    hi52: 125,
    lo52: 101,
    ma20: 115.5, // mean(106..125)
    ma60: null,
    avgVol20: 14500, // mean(5000..24000): the 20 sessions before the latest
    low20: 105, // min(105..124)
    high20: 124,
  });
});

test('computeHist: a close below the prior 20-day low is not hidden by its own bar', () => {
  const bars = series(25, (i) => (i === 25 ? 90 : 100 + i), () => 1000);
  bars[24][2] = 5000;
  const h = computeHist(bars);
  assert.equal(h.low20, 105);
  assert.ok(90 < h.low20, 'the latest close sits below the support');
  assert.equal(h.avgVol20, 1000, 'the spike day is not in its own average');
});

test('computeHist on 65 bars (closes 1..65): 60-day average and 52-week range', () => {
  const h = computeHist(series(65));
  assert.equal(h.ma60, 35.5); // mean(6..65)
  assert.equal(h.ma20, 55.5); // mean(46..65)
  assert.equal(h.d5Pct, 8.33); // 65 / 60 - 1
  assert.equal(h.d20Pct, 44.44); // 65 / 45 - 1
  assert.equal(h.hi52, 65);
  assert.equal(h.lo52, 1);
  assert.equal(h.low20, 45); // 20 sessions before the latest: 45..64
  assert.equal(h.high20, 64);
});

test('computeHist: 52-week window is the last 250 bars; short or volume-poor histories give nulls', () => {
  const long = computeHist(series(260, (i) => (i <= 10 ? 1000 : i)));
  assert.equal(long.hi52, 260);
  assert.equal(long.lo52, 11, 'bars older than 250 sessions are outside the 52-week window');

  const short = computeHist(series(19));
  assert.equal(short.days, 19);
  assert.equal(short.d5Pct, round2((19 / 14 - 1) * 100));
  for (const k of ['d20Pct', 'hi52', 'lo52', 'ma20', 'ma60', 'avgVol20', 'low20', 'high20']) assert.equal(short[k], null, k);

  const at20 = computeHist(series(20));
  assert.equal(at20.ma20, 10.5);
  for (const k of ['avgVol20', 'low20', 'high20']) assert.equal(at20[k], null, `${k} needs 20 sessions before the latest`);

  const sparse = series(21, (i) => i, (i) => (i <= 11 ? null : 10)); // 9 volumes in the prior window
  assert.equal(computeHist(sparse).avgVol20, null);
  const enough = series(21, (i) => i, (i) => (i <= 10 ? null : i)); // 10 volumes: mean(11..20)
  assert.equal(computeHist(enough).avgVol20, 16);

  assert.deepEqual(computeHist([]), {
    days: 0, d5Pct: null, d20Pct: null, hi52: null, lo52: null, ma20: null, ma60: null, avgVol20: null, low20: null, high20: null,
  });
});

const round2 = (x) => Math.round(x * 100) / 100;

test('mergeChip merges sources for the same date and keeps the last 10 days', () => {
  let entries = mergeChip([], day(2), { foreign: 5, trust: 1, dealer: 0 });
  entries = mergeChip(entries, day(2), { margin: 100, marginChg: 3, short: 1 });
  entries = mergeChip(entries, day(1), { foreign: -1, trust: 0, dealer: 0 });
  assert.deepEqual(entries, [
    { date: day(1), foreign: -1, trust: 0, dealer: 0 },
    { date: day(2), foreign: 5, trust: 1, dealer: 0, margin: 100, marginChg: 3, short: 1 },
  ]);
  for (let i = 3; i <= 14; i++) entries = mergeChip(entries, day(i), { foreign: i, trust: 0, dealer: 0 });
  assert.equal(entries.length, 10);
  assert.equal(entries[0].date, day(5));
  assert.equal(mergeChip(entries, null, {}), entries);
});

test('computeChips: signed streaks, 5-day sums, latest margin', () => {
  const entries = [
    { date: day(1), foreign: -100, trust: 5, dealer: 1, margin: 1000, marginChg: 10, short: 5 },
    { date: day(2), foreign: 200, trust: 0, dealer: -2 },
    { date: day(3), foreign: 300, trust: -5, dealer: 3 },
    { date: day(4), foreign: 50, trust: -1, dealer: 0 },
    { date: day(5), foreign: 10, trust: -2, dealer: 4, margin: 1100, marginChg: 100, short: 7 },
    { date: day(6), foreign: 20, trust: 3, dealer: -1 },
  ];
  assert.deepEqual(computeChips(entries), {
    date: day(6),
    foreign: 20,
    trust: 3,
    dealer: -1,
    foreignStreak: 5,
    trustStreak: 1,
    foreign5: 580, // 200 + 300 + 50 + 10 + 20
    trust5: -5, // 0 - 5 - 1 - 2 + 3
    dealer5: 4, // -2 + 3 + 0 + 4 - 1
    margin: 1100,
    marginChg: 100,
    short: 7,
    marginDate: day(5),
  });
  const selling = computeChips(entries.slice(0, 1).concat([{ date: day(2), foreign: -3, trust: 0, dealer: 0 }]));
  assert.equal(selling.foreignStreak, -2);
  assert.equal(selling.trustStreak, 0);
  assert.equal(computeChips([]), null);
  assert.deepEqual(computeChips([{ date: day(1), margin: 5, marginChg: 1, short: 0 }]), {
    date: day(1), foreign: null, trust: null, dealer: null, foreignStreak: null, trustStreak: null,
    foreign5: null, trust5: null, dealer5: null, margin: 5, marginChg: 1, short: 0,
  });
});
