// Fundamentals for both exchanges: monthly revenue, YTD EPS, P/E-P/B-yield.
import { clean, isTwCode, keyed, num, rocDate, rocYm, round } from './util.mjs';

const positive = (x) => (x != null && x > 0 ? x : null);

function requireRows(rows, name) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${name}: empty or not an array`);
  return rows;
}

// t187ap05_L / mopsfin_t187ap05_O share keys. rev unit: 千元.
export function parseRevenue(rows) {
  requireRows(rows, 'revenue');
  let ym = null;
  const map = {};
  for (const row of rows) {
    const get = keyed(row);
    const code = clean(get('公司代號'));
    const revYm = rocYm(get('資料年月'));
    if (!isTwCode(code) || !revYm) continue;
    if (!ym || revYm > ym) ym = revYm;
    map[code] = {
      industry: clean(get('產業別')) || null,
      revYm,
      rev: num(get('營業收入-當月營收')),
      mom: round(num(get('營業收入-上月比較增減(%)')), 2),
      yoy: round(num(get('營業收入-去年同月增減(%)')), 2),
      ytdYoy: round(num(get('累計營業收入-前期比較增減(%)')), 2),
    };
  }
  return { ym, map };
}

// EPS is year-to-date cumulative. TWSE: 年度 + 基本每股盈餘(元); TPEx: Year + 基本每股盈餘.
export function parseEps(rows) {
  requireRows(rows, 'eps');
  let period = null;
  const map = {};
  for (const row of rows) {
    const get = keyed(row);
    const code = clean(get('公司代號', 'SecuritiesCompanyCode'));
    const year = num(get('年度', 'Year'));
    const q = num(get('季別', 'Season'));
    if (!isTwCode(code) || year == null || q == null) continue;
    const key = `${year + 1911}Q${q}`;
    if (!period || key > period) period = key;
    map[code] = {
      industry: clean(get('產業別')) || null,
      eps: num(get('基本每股盈餘(元)', '基本每股盈餘')),
      epsKey: key,
      epsPeriod: `${key}累計`,
    };
  }
  return { period, map };
}

export function parseTwseValuation(rows) {
  requireRows(rows, 'BWIBBU_ALL');
  let date = null;
  const map = {};
  for (const r of rows) {
    const code = clean(r.Code);
    if (!isTwCode(code)) continue;
    const d = rocDate(r.Date);
    if (d && (!date || d > date)) date = d;
    map[code] = { pe: positive(num(r.PEratio)), pb: positive(num(r.PBratio)), yield: num(r.DividendYield) };
  }
  return { date, map };
}

export function parseTpexValuation(rows) {
  requireRows(rows, 'tpex_mainboard_peratio_analysis');
  let date = null;
  const map = {};
  for (const row of rows) {
    const get = keyed(row);
    const code = clean(get('SecuritiesCompanyCode'));
    if (!isTwCode(code)) continue;
    const d = rocDate(get('Date'));
    if (d && (!date || d > date)) date = d;
    map[code] = {
      pe: positive(num(get('PriceEarningRatio'))),
      pb: positive(num(get('PriceBookRatio'))),
      yield: num(get('YieldRatio')),
    };
  }
  return { date, map };
}
