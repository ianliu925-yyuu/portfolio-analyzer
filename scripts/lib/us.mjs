// Nasdaq screener (stocks + ETFs). Values are strings like "$123.45", "-0.0316", "-3.471%".
import { num, round } from './util.mjs';

export const NASDAQ = {
  stocks: 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&download=true',
  etfs: 'https://api.nasdaq.com/api/screener/etf?download=true',
};

export const NASDAQ_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.nasdaq.com/',
  Origin: 'https://www.nasdaq.com',
  'Accept-Encoding': 'identity',
};

export const MIN_MARKET_CAP = 2e9;

// "BRK/B" -> "BRK.B"
export const normalizeSymbol = (s) => String(s ?? '').trim().toUpperCase().replace('/', '.');

// "Apple Inc. Common Stock" -> "Apple Inc."; keeps share classes ("Alphabet Inc. Class A").
export function cleanUsName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+(Common Stock|Ordinary Shares|Common Shares)$/i, '')
    .replace(/\s+(American Depositary Shares?|ADS|Depositary Shares?)\b.*$/i, '')
    .trim();
}

// ADRs of ordinary shares ("American Depositary Shares, each representing ...") are common stock;
// preferred depositary shares name the preferred stock or a coupon, and their symbols carry "^".
const NOT_COMMON = /\b(warrants?|rights|units|notes? due|debentures?|subordinated)\b|preferred|\d%/i;

export function parseNasdaqStocks(json) {
  const rows = json?.data?.rows ?? json?.data?.table?.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('nasdaq stocks: no data.rows');
  const out = [];
  for (const r of rows) {
    const code = normalizeSymbol(r.symbol);
    const close = num(r.lastsale);
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(code) || !(close > 0)) continue;
    out.push({
      code,
      name: cleanUsName(r.name) || code,
      rawName: String(r.name ?? ''),
      sector: String(r.sector ?? '').trim() || null,
      industry: String(r.industry ?? '').trim() || null,
      close,
      change: num(r.netchange),
      changePct: round(num(r.pctchange), 2),
      volume: num(r.volume),
      marketCap: num(r.marketCap),
    });
  }
  return out;
}

// Universe rule: common stock with market cap >= $2B.
export const isUsUniverseStock = (row, minCap = MIN_MARKET_CAP) =>
  row.marketCap >= minCap && !NOT_COMMON.test(row.rawName);

export function parseNasdaqEtfs(json) {
  const rows = json?.data?.data?.rows ?? json?.data?.rows ?? json?.data?.records?.data?.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('nasdaq etf: no data.data.rows');
  const map = {};
  for (const r of rows) {
    const code = normalizeSymbol(r.symbol);
    const close = num(r.lastSalePrice);
    if (!code || !(close > 0)) continue;
    map[code] = {
      code,
      name: String(r.companyName ?? '').trim() || null,
      close,
      change: num(r.netChange),
      changePct: round(num(r.percentageChange), 2),
    };
  }
  return map;
}
