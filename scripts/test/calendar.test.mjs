import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDays,
  buildEvents,
  holidayNote,
  isUsDst,
  taipeiToday,
  twCalendar,
  upcomingHolidays,
  usAsOf,
  usCalendar,
  weekday,
} from '../lib/calendar.mjs';
import { parseHolidays } from '../lib/twse.mjs';
import { fixtureJson } from './helpers/fake-market.mjs';

const twCal = twCalendar(parseHolidays(fixtureJson('twse/holidaySchedule.json')));

test('date helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekday('2026-10-10'), 6);
  assert.equal(taipeiToday(new Date('2026-10-10T23:17:05Z')), '2026-10-11');
});

test('TW next trading day skips holidays; "交易日" rows are not closures', () => {
  assert.equal(twCal.next('2026-10-08'), '2026-10-12');
  assert.equal(twCal.prev('2026-10-12'), '2026-10-08');
  assert.equal(twCal.next('2026-10-23'), '2026-10-27');
  assert.equal(twCal.next('2026-02-11'), '2026-02-23');
  assert.ok(twCal.isTradingDay('2026-01-02'), '國曆新年開始交易日 is a trading day');
  assert.ok(twCal.isTradingDay('2026-02-11'), '農曆春節前最後交易日 is a trading day');
  assert.ok(!twCal.isTradingDay('2026-02-12'), '市場無交易 is closed');
});

test('TW 元旦 of a year TWSE has not published yet is still closed', () => {
  // the schedule covers 2026 only: 2027-01-01 (Fri) must not become the next trading day
  assert.equal(twCal.next('2026-12-31'), '2027-01-04');
  assert.equal(holidayNote(twCal, '2026-12-31', '2027-01-04'), '01/01–01/03 中華民國開國紀念日連假休市');
  assert.deepEqual(upcomingHolidays(twCal, '2026-12-20'), [
    { date: '2026-12-25', name: '行憲紀念日' },
    { date: '2027-01-01', name: '中華民國開國紀念日' },
  ]);
  assert.ok(twCal.isTradingDay('2027-01-05'), 'other days of an unpublished year are weekdays as usual');
  // 補假: 2023-01-01 was a Sunday (closed Mon 01-02); 2022-01-01 a Saturday (closed Fri 2021-12-31)
  const bare = twCalendar([]);
  assert.equal(bare.next('2022-12-30'), '2023-01-03');
  assert.equal(bare.prev('2022-01-03'), '2021-12-30');
  assert.ok(bare.isTradingDay('2026-01-02') && bare.isTradingDay('2026-12-31'));
  // once a year's rows arrive they decide on their own
  assert.ok(twCalendar([{ date: '2023-02-27', name: '和平紀念日補假' }]).isTradingDay('2023-01-02'), 'covered year: rows win');
});

test('TW holiday note and upcoming holidays', () => {
  assert.equal(holidayNote(twCal, '2026-10-08', '2026-10-12'), '10/09–10/11 國慶日連假休市');
  assert.equal(holidayNote(twCal, '2026-10-02', '2026-10-05'), '', 'plain weekend gives no note');
  assert.equal(holidayNote(twCal, '2026-04-30', '2026-05-04'), '05/01–05/03 勞動節連假休市');
  assert.equal(holidayNote(twCal, '2026-02-11', '2026-02-23'), '02/12–02/22 農曆春節連假休市');
  assert.deepEqual(upcomingHolidays(twCal, '2026-10-08'), [
    { date: '2026-10-09', name: '國慶日' },
    { date: '2026-10-26', name: '臺灣光復暨金門古寧頭大捷紀念日' },
  ]);
});

test('US next trading day around Thanksgiving and Christmas', () => {
  assert.equal(usCalendar.next('2026-11-25'), '2026-11-27');
  assert.equal(usCalendar.next('2026-12-24'), '2026-12-28');
  assert.equal(usCalendar.next('2026-07-02'), '2026-07-06');
  assert.equal(usCalendar.next('2027-12-23'), '2027-12-27');
  // 2028：元旦是週六不補假；7/3 提早收盤、7/4 休市
  assert.equal(usCalendar.next('2027-12-31'), '2028-01-03');
  assert.equal(usCalendar.next('2028-07-03'), '2028-07-05');
  assert.equal(usCalendar.earlyClose('2028-07-03'), '獨立紀念日前夕');
  assert.equal(holidayNote(usCalendar, '2026-11-25', '2026-11-27'), '11/26 感恩節休市；11/27 感恩節翌日提早收盤');
  assert.deepEqual(upcomingHolidays(usCalendar, '2026-11-20', 10), [
    { date: '2026-11-26', name: '感恩節' },
    { date: '2026-11-27', name: '感恩節翌日（提早收盤）', earlyClose: true },
  ]);
});

test('US asOf follows the New York close, early closes and DST', () => {
  // Sat 07:17 Taipei = Fri 19:17 EDT -> Friday's session is done
  assert.equal(usAsOf(new Date('2026-10-10T23:17:05Z')), '2026-10-09');
  // Mon 08:17 EDT, before the open -> previous Friday
  assert.equal(usAsOf(new Date('2026-10-12T12:17:00Z')), '2026-10-09');
  // Fri 2026-11-27 early close at 13:00 EST; 13:45 EST counts as closed
  assert.equal(usAsOf(new Date('2026-11-27T18:45:00Z')), '2026-11-27');
  assert.equal(usAsOf(new Date('2026-11-27T17:45:00Z')), '2026-11-25');
  assert.equal(usAsOf(new Date('2026-11-26T23:00:00Z')), '2026-11-25');
  assert.equal(isUsDst(new Date('2026-10-12T12:17:00Z')), true);
  assert.equal(isUsDst(new Date('2026-11-02T13:17:00Z')), false);
  assert.equal(isUsDst(new Date('2026-03-09T12:17:00Z')), true);
});

test('events: revenue deadline, next report deadline and holidays, sorted', () => {
  const events = buildEvents({
    today: '2026-10-11',
    twHolidays: [{ date: '2026-10-09', name: '國慶日' }, { date: '2026-10-26', name: '光復節' }],
    usHolidays: [{ date: '2026-11-27', name: '感恩節翌日（提早收盤）', earlyClose: true }],
  });
  assert.deepEqual(events, [
    { date: '2026-10-26', title: '光復節休市（台股）' },
    { date: '2026-11-10', title: '10 月營收公布期限（台股）' },
    { date: '2026-11-14', title: '第 3 季財報公布期限（台股）' },
    { date: '2026-11-27', title: '感恩節翌日（提早收盤）（美股）' },
  ]);
  const jan = buildEvents({ today: '2026-12-20' });
  assert.deepEqual(jan, [
    { date: '2027-01-10', title: '12 月營收公布期限（台股）' },
    { date: '2027-03-31', title: '2026 年度財報公布期限（台股）' },
  ]);
  assert.equal(buildEvents({ today: '2026-10-10' })[0].date, '2026-10-10', 'deadline day itself is still upcoming');
});
