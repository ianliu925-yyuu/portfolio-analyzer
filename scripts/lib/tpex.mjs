// TPEx (上櫃) endpoints and pure parsers. Keys are looked up whitespace-insensitively
// because several TPEx keys carry stray/leading spaces (docs/research/tpex.json).
import { quoteRecord } from './twse.mjs';
import { clean, gregDate, isTwCode, keyed, num, pctChange, rocDate, round } from './util.mjs';

const BASE = 'https://www.tpex.org.tw/openapi/v1';

export const TPEX = {
  quotes: `${BASE}/tpex_mainboard_quotes`,
  valuation: `${BASE}/tpex_mainboard_peratio_analysis`,
  revenue: `${BASE}/mopsfin_t187ap05_O`,
  eps: `${BASE}/mopsfin_t187ap14_O`,
  margin: `${BASE}/tpex_mainboard_margin_balance`,
  insti: `${BASE}/tpex_3insti_daily_trading`,
  index: `${BASE}/tpex_index`,
};

function requireRows(rows, name) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${name}: empty or not an array`);
  return rows;
}

const maxDate = (a, b) => (!a || (b && b > a) ? b : a);

export function parseTpexQuotes(rows) {
  requireRows(rows, 'tpex_mainboard_quotes');
  let date = null;
  const records = [];
  for (const row of rows) {
    const get = keyed(row);
    const code = clean(get('SecuritiesCompanyCode'));
    if (!isTwCode(code)) continue;
    const d = rocDate(get('Date'));
    date = maxDate(date, d);
    records.push(
      quoteRecord({
        code,
        name: clean(get('CompanyName')),
        exchange: 'TPEx',
        date: d,
        close: num(get('Close')),
        change: num(get('Change')),
        open: num(get('Open')),
        high: num(get('High')),
        low: num(get('Low')),
        volume: num(get('TradingShares')),
      }),
    );
  }
  if (!date) throw new Error('tpex_mainboard_quotes: no Date');
  return { date, records };
}

// 三大法人 in shares. Foreign = 外資及陸資合計 (incl. foreign dealers), matching TWSE idx4+idx7.
export function parseTpexInsti(rows) {
  requireRows(rows, 'tpex_3insti_daily_trading');
  let date = null;
  const map = {};
  for (const row of rows) {
    const get = keyed(row);
    const code = clean(get('SecuritiesCompanyCode'));
    if (!isTwCode(code)) continue;
    date = maxDate(date, rocDate(get('Date')));
    let foreign = num(get('ForeignInvestorsIncludeMainlandAreaInvestors-Difference'));
    if (foreign == null) {
      const ex = num(get('Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference'));
      const fd = num(get('ForeignDealers-Difference'));
      foreign = ex == null && fd == null ? null : (ex ?? 0) + (fd ?? 0);
    }
    map[code] = {
      foreign,
      trust: num(get('SecuritiesInvestmentTrustCompanies-Difference')),
      dealer: num(get('Dealers-Difference')),
    };
  }
  return { date, map };
}

// 融資融券餘額 in 張.
export function parseTpexMargin(rows) {
  requireRows(rows, 'tpex_mainboard_margin_balance');
  let date = null;
  const map = {};
  for (const row of rows) {
    const get = keyed(row);
    const code = clean(get('SecuritiesCompanyCode'));
    if (!isTwCode(code)) continue;
    date = maxDate(date, rocDate(get('Date')));
    const bal = num(get('MarginPurchaseBalance')) ?? 0;
    const prev = num(get('MarginPurchaseBalancePreviousDay')) ?? 0;
    map[code] = { margin: bal, marginChg: bal - prev, short: num(get('ShortSaleBalance')) ?? 0 };
  }
  return { date, map };
}

// tpex_index: month-to-date rows with GREGORIAN dates; the last row is the latest close.
export function parseTpexIndex(rows) {
  requireRows(rows, 'tpex_index');
  const parsed = rows
    .map((row) => {
      const get = keyed(row);
      const raw = clean(get('Date'));
      return { date: gregDate(raw) ?? rocDate(raw), close: num(get('Close')), change: num(get('Change')) };
    })
    .filter((r) => r.date && r.close != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = parsed.at(-1);
  if (!last) throw new Error('tpex_index: no rows');
  return { date: last.date, close: last.close, change: round(last.change, 2), changePct: pctChange(last.close, last.change) };
}
