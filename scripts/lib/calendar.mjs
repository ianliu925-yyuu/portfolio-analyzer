// Trading calendars (TW from the TWSE holiday schedule, US from the NYSE list), notes and events.

// NYSE full closures and 13:00 ET early closes (nyse.com, fetched 2026-10-10). 2028 is not published yet.
export const NYSE_CLOSED = {
  '2026-01-01': '元旦',
  '2026-01-19': '馬丁路德金恩紀念日',
  '2026-02-16': '總統日',
  '2026-04-03': '耶穌受難日',
  '2026-05-25': '陣亡將士紀念日',
  '2026-06-19': '六月節',
  '2026-07-03': '獨立紀念日（補假）',
  '2026-09-07': '勞動節',
  '2026-11-26': '感恩節',
  '2026-12-25': '聖誕節',
  '2027-01-01': '元旦',
  '2027-01-18': '馬丁路德金恩紀念日',
  '2027-02-15': '總統日',
  '2027-03-26': '耶穌受難日',
  '2027-05-31': '陣亡將士紀念日',
  '2027-06-18': '六月節（補假）',
  '2027-07-05': '獨立紀念日（補假）',
  '2027-09-06': '勞動節',
  '2027-11-25': '感恩節',
  '2027-12-24': '聖誕節（補假）',
};
export const NYSE_EARLY_CLOSE = {
  '2026-11-27': '感恩節翌日',
  '2026-12-24': '聖誕夜',
  '2027-11-26': '感恩節翌日',
};
export const NYSE_KNOWN_YEARS = [2026, 2027];

const pad = (n) => String(n).padStart(2, '0');

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function weekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const isWeekend = (iso) => weekday(iso) === 0 || weekday(iso) === 6;

// { date: 'YYYY-MM-DD', minutes: minutes since local midnight, tzName } in an IANA zone
export function zoned(now, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    tzName: parts.timeZoneName,
  };
}

export const taipeiToday = (now) => zoned(now, 'Asia/Taipei').date;
export const isUsDst = (now) => zoned(now, 'America/New_York').tzName === 'EDT';

// closed: { 'YYYY-MM-DD': name }, then fallback(iso) for dates the table does not know; weekends are always closed.
export function createCalendar(closed = {}, early = {}, fallback = () => null) {
  const closedName = (iso) => closed[iso] ?? fallback(iso);
  const isTradingDay = (iso) => !isWeekend(iso) && !closedName(iso);
  const step = (iso, dir) => {
    let d = iso;
    for (let i = 0; i < 40; i++) {
      d = addDays(d, dir);
      if (isTradingDay(d)) return d;
    }
    return null;
  };
  return {
    closedName,
    isTradingDay,
    earlyClose: (iso) => early[iso] ?? null,
    next: (iso) => step(iso, 1),
    prev: (iso) => step(iso, -1),
  };
}

export const usCalendar = createCalendar(NYSE_CLOSED, NYSE_EARLY_CLOSE);

// Holidays from the TWSE schedule rows ({date, name}); rows named "...交易日" are trading-day markers.
// TWSE publishes the current year only, so for a year with no rows yet assume 元旦 is closed, with its
// 補假 (Saturday -> the Friday before, Sunday -> the Monday after); the year's own rows replace this.
export function twCalendar(holidays = []) {
  const closed = {};
  const years = new Set();
  for (const h of holidays) {
    if (!h.date) continue;
    years.add(h.date.slice(0, 4));
    if (!String(h.name).includes('交易日')) closed[h.date] ??= h.name;
  }
  return createCalendar(closed, {}, (iso) => (years.has(iso.slice(0, 4)) ? null : newYearClosure(iso)));
}

function newYearClosure(iso) {
  const md = iso.slice(5);
  if (md === '01-01') return '中華民國開國紀念日';
  if ((md === '01-02' && weekday(iso) === 1) || (md === '12-31' && weekday(iso) === 5)) return '中華民國開國紀念日補假';
  return null;
}

// Latest US session whose close (+30 min settle time) has passed, in America/New_York.
export function usAsOf(now, cal = usCalendar) {
  const { date, minutes } = zoned(now, 'America/New_York');
  const closeAt = (cal.earlyClose(date) ? 13 * 60 : 16 * 60) + 30;
  if (cal.isTradingDay(date) && minutes >= closeAt) return date;
  return cal.prev(date);
}

const md = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;

// "10/09–10/11 國慶日連假休市" when the gap between asOf and the next session contains a holiday.
export function holidayNote(cal, asOf, next) {
  if (!asOf || !next) return '';
  const gap = [];
  for (let d = addDays(asOf, 1); d < next && gap.length < 40; d = addDays(d, 1)) gap.push(d);
  const names = gap.filter((d) => !isWeekend(d) && cal.closedName(d)).map(cal.closedName);
  const notes = [];
  if (names.length) {
    const name = names.find((n) => !n.includes('無交易')) ?? names[0];
    const range = gap.length > 1 ? `${md(gap[0])}–${md(gap.at(-1))}` : md(gap[0]);
    const suffix = gap.length > 1 && !/[假期]$/.test(name) ? '連假休市' : '休市';
    notes.push(`${range} ${name}${suffix}`);
  }
  if (cal.earlyClose(next)) notes.push(`${md(next)} ${cal.earlyClose(next)}提早收盤`);
  return notes.join('；');
}

// Weekday closures (and early closes) in the `days` calendar days after `after`.
export function upcomingHolidays(cal, after, days = 30) {
  const out = [];
  if (!after) return out;
  for (let i = 1; i <= days; i++) {
    const d = addDays(after, i);
    if (isWeekend(d)) continue;
    if (cal.closedName(d)) out.push({ date: d, name: cal.closedName(d) });
    else if (cal.earlyClose(d)) out.push({ date: d, name: `${cal.earlyClose(d)}（提早收盤）`, earlyClose: true });
  }
  return out;
}

// Filing deadlines (月營收 10th, 季報 5/15 8/14 11/14, 年報 3/31) plus upcoming holidays, sorted.
export function buildEvents({ today, twHolidays = [], usHolidays = [] }) {
  const [y, m, d] = today.split('-').map(Number);
  const events = [];

  const revDeadline = d <= 10 ? `${y}-${pad(m)}-10` : m === 12 ? `${y + 1}-01-10` : `${y}-${pad(m + 1)}-10`;
  const dueMonth = Number(revDeadline.slice(5, 7));
  events.push({ date: revDeadline, title: `${dueMonth === 1 ? 12 : dueMonth - 1} 月營收公布期限（台股）` });

  const reports = [];
  for (const yy of [y, y + 1]) {
    reports.push({ date: `${yy}-03-31`, title: `${yy - 1} 年度財報公布期限（台股）` });
    reports.push({ date: `${yy}-05-15`, title: `第 1 季財報公布期限（台股）` });
    reports.push({ date: `${yy}-08-14`, title: `第 2 季財報公布期限（台股）` });
    reports.push({ date: `${yy}-11-14`, title: `第 3 季財報公布期限（台股）` });
  }
  const nextReport = reports.find((r) => r.date >= today);
  if (nextReport) events.push(nextReport);

  for (const h of twHolidays) if (h.date >= today) events.push({ date: h.date, title: `${h.name}休市（台股）` });
  for (const h of usHolidays) {
    if (h.date < today) continue;
    events.push({ date: h.date, title: h.earlyClose ? `${h.name}（美股）` : `${h.name}休市（美股）` });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}
