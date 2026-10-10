// TWSE (上市) endpoints and pure parsers. Field names follow docs/research/twse.json.
import { clean, compactDate, gregDate, isTwCode, normKey, num, pctChange, rocDate, round, twType } from './util.mjs';

const OPENAPI = 'https://openapi.twse.com.tw/v1';
const WWW = 'https://www.twse.com.tw';

export const TWSE = {
  quotes: `${OPENAPI}/exchangeReport/STOCK_DAY_ALL`,
  valuation: `${OPENAPI}/exchangeReport/BWIBBU_ALL`,
  revenue: `${OPENAPI}/opendata/t187ap05_L`,
  eps: `${OPENAPI}/opendata/t187ap14_L`,
  margin: `${OPENAPI}/exchangeReport/MI_MARGN`,
  index: `${OPENAPI}/exchangeReport/MI_INDEX`,
  holidays: `${OPENAPI}/holidaySchedule/holidaySchedule`,
  // rwd first, legacy path as fallback (rwd answered with a maintenance page during research)
  t86: (iso) => [
    `${WWW}/rwd/zh/fund/T86?date=${compactDate(iso)}&selectType=ALLBUT0999&response=json`,
    `${WWW}/fund/T86?response=json&date=${compactDate(iso)}&selectType=ALLBUT0999`,
  ],
  marginDated: (iso) => [
    `${WWW}/rwd/zh/marginTrading/MI_MARGN?date=${compactDate(iso)}&selectType=ALL&response=json`,
    `${WWW}/exchangeReport/MI_MARGN?response=json&date=${compactDate(iso)}&selectType=ALL`,
  ],
};

const positive = (x) => (x != null && x > 0 ? x : null);

function requireRows(rows, name) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${name}: empty or not an array`);
  return rows;
}

// Shared quote normaliser for both exchanges.
export function quoteRecord({ code, name, exchange, date, close, change, open, high, low, volume }) {
  close = positive(close);
  return {
    code,
    name,
    exchange,
    type: twType(code),
    date,
    close,
    change: close == null ? null : change,
    changePct: close == null ? null : pctChange(close, change),
    open: positive(open),
    high: positive(high),
    low: positive(low),
    volume: volume ?? (close == null ? 0 : null),
  };
}

export function parseTwseQuotes(rows) {
  requireRows(rows, 'STOCK_DAY_ALL');
  let date = null;
  const records = [];
  for (const r of rows) {
    const code = clean(r.Code);
    if (!isTwCode(code)) continue;
    const d = rocDate(r.Date);
    if (d && (!date || d > date)) date = d;
    records.push(
      quoteRecord({
        code,
        name: clean(r.Name),
        exchange: 'TWSE',
        date: d,
        close: num(r.ClosingPrice),
        change: num(r.Change),
        open: num(r.OpeningPrice),
        high: num(r.HighestPrice),
        low: num(r.LowestPrice),
        volume: num(r.TradeVolume),
      }),
    );
  }
  if (!date) throw new Error('STOCK_DAY_ALL: no Date');
  return { date, records };
}

// T86 三大法人 (rwd and legacy share the {stat, date, fields, data} shape); units: shares.
export function parseT86(json) {
  if (!json || json.stat !== 'OK') throw new Error(`T86 stat=${json?.stat ?? 'missing'}`);
  const fields = (json.fields ?? json.tables?.[0]?.fields ?? []).map(normKey);
  const data = json.data ?? json.tables?.[0]?.data ?? [];
  const col = (name, fallback) => {
    const i = fields.indexOf(normKey(name));
    return i >= 0 ? i : fallback;
  };
  const iForeign = col('外陸資買賣超股數(不含外資自營商)', 4);
  const iForeignDealer = col('外資自營商買賣超股數', 7);
  const iTrust = col('投信買賣超股數', 10);
  const iDealer = col('自營商買賣超股數', 11);
  const map = {};
  for (const row of data) {
    const code = clean(row[0]);
    if (!isTwCode(code)) continue;
    const f = num(row[iForeign]);
    const fd = num(row[iForeignDealer]);
    map[code] = {
      foreign: f == null && fd == null ? null : (f ?? 0) + (fd ?? 0),
      trust: num(row[iTrust]),
      dealer: num(row[iDealer]),
    };
  }
  if (!Object.keys(map).length) throw new Error('T86: no rows');
  return { date: gregDate(json.date), map };
}

// Dated MI_MARGN: tables[1] is the per-stock table; 融資 cols 2-7, 融券 cols 8-13 (units: 張).
export function parseMarginDated(json) {
  if (!json || json.stat !== 'OK') throw new Error(`MI_MARGN stat=${json?.stat ?? 'missing'}`);
  const tables = Array.isArray(json.tables) ? json.tables : [{ fields: json.fields, data: json.data }];
  const withRows = tables.filter((t) => Array.isArray(t?.data) && t.data.length);
  const table =
    withRows.find((t) => normKey(t.fields?.[0] ?? '') === normKey('代號')) ??
    withRows.sort((a, b) => b.data.length - a.data.length)[0];
  if (!table) throw new Error('MI_MARGN: no per-stock table');
  const map = {};
  for (const row of table.data) {
    const code = clean(row[0]);
    if (!isTwCode(code)) continue;
    const prev = num(row[5]) ?? 0;
    const bal = num(row[6]) ?? 0;
    map[code] = { margin: bal, marginChg: bal - prev, short: num(row[12]) ?? 0 };
  }
  if (!Object.keys(map).length) throw new Error('MI_MARGN: no rows');
  return { date: gregDate(json.date), map };
}

// openapi MI_MARGN has no date column; empty strings mean 0.
export function parseMarginOpenapi(rows) {
  requireRows(rows, 'MI_MARGN openapi');
  const map = {};
  for (const r of rows) {
    const code = clean(r['股票代號']);
    if (!isTwCode(code)) continue;
    const bal = num(r['融資今日餘額']) ?? 0;
    const prev = num(r['融資前日餘額']) ?? 0;
    map[code] = { margin: bal, marginChg: bal - prev, short: num(r['融券今日餘額']) ?? 0, marginPrev: prev };
  }
  return { date: null, map };
}

// Decide whether undated openapi margin rows are the day after `known` (code -> stored balance).
// Only codes whose balance moved can tell "next day" (前日餘額 == known) from "same day" (今日餘額 == known).
export function marginFollows(map, known) {
  let checked = 0;
  let follows = 0;
  for (const [code, m] of Object.entries(map)) {
    const k = known[code];
    if (k == null || m.marginPrev === m.margin) continue;
    checked++;
    if (m.marginPrev === k) follows++;
  }
  return checked >= 3 && follows / checked >= 0.8;
}

export function parseTaiex(rows) {
  requireRows(rows, 'MI_INDEX');
  const r = rows.find((x) => clean(x['指數']) === '發行量加權股價指數');
  if (!r) throw new Error('MI_INDEX: 發行量加權股價指數 not found');
  const close = num(r['收盤指數']);
  const points = num(r['漲跌點數']);
  const pct = num(r['漲跌百分比']);
  const signText = clean(r['漲跌']);
  const sign = signText.includes('-') ? -1 : signText.includes('+') ? 1 : pct != null && pct < 0 ? -1 : 1;
  const change = points == null ? null : round(sign * Math.abs(points), 2);
  return {
    date: rocDate(r['日期']),
    close,
    change,
    changePct: pct == null ? pctChange(close, change) : round(sign * Math.abs(pct), 2),
  };
}

export function parseHolidays(rows) {
  requireRows(rows, 'holidaySchedule');
  return rows.map((r) => ({ date: rocDate(r.Date), name: clean(r.Name) })).filter((h) => h.date && h.name);
}
