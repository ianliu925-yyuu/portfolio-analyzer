// Pure assembly of the latest/ records (DESIGN section 3) from parsed sources + history.
import { computeChips, computeHist } from './history.mjs';
import { median, round } from './util.mjs';

export const FUND_KEYS = ['revYm', 'rev', 'mom', 'yoy', 'ytdYoy', 'eps', 'epsPeriod', 'eps4q', 'pe', 'pb', 'yield'];

// Start from the previous fund (so a failed or lagging source keeps its last values) and overlay fresh data.
export function buildFund(prevFund, { rev, eps, val } = {}, close) {
  const f = Object.fromEntries(FUND_KEYS.map((k) => [k, prevFund?.[k] ?? null]));
  if (rev && (!f.revYm || rev.revYm >= f.revYm)) {
    Object.assign(f, { revYm: rev.revYm, rev: rev.rev, mom: rev.mom, yoy: rev.yoy, ytdYoy: rev.ytdYoy });
  }
  if (eps && (!f.epsPeriod || eps.epsPeriod >= f.epsPeriod)) Object.assign(f, { eps: eps.eps, epsPeriod: eps.epsPeriod });
  if (val) Object.assign(f, { pe: val.pe, pb: val.pb, yield: val.yield });
  // TWSE/TPEx P/E = close / trailing four-quarter EPS, so this recovers 近四季 EPS.
  f.eps4q = f.pe > 0 && close > 0 ? round(close / f.pe, 2) : null;
  return Object.values(f).some((v) => v != null) ? f : null;
}

export function twRecord(q, { industry, bars, chips, fund }) {
  return {
    code: q.code,
    name: q.name,
    market: 'TW',
    exchange: q.exchange,
    type: q.type,
    industry: industry ?? null,
    date: q.date ?? null,
    close: q.close ?? null,
    change: q.change ?? null,
    changePct: q.changePct ?? null,
    open: q.open ?? null,
    high: q.high ?? null,
    low: q.low ?? null,
    volume: q.volume ?? null,
    hist: computeHist(bars),
    chips: computeChips(chips),
    fund: fund ?? null,
  };
}

export function usRecord(q, { bars }) {
  return {
    code: q.code,
    name: q.name,
    market: 'US',
    type: q.type,
    sector: q.sector ?? null,
    industry: q.industry ?? null,
    date: q.date ?? null,
    close: q.close ?? null,
    change: q.change ?? null,
    changePct: q.changePct ?? null,
    volume: q.volume ?? null,
    marketCap: q.marketCap ?? null,
    hist: computeHist(bars),
  };
}

// { "TW:半導體業": median P/E } over stocks with a positive P/E.
export function industryPe(records) {
  const groups = {};
  for (const r of records) {
    if (r.market !== 'TW' || r.type !== 'stock' || !r.industry || !(r.fund?.pe > 0)) continue;
    (groups[`TW:${r.industry}`] ??= []).push(r.fund.pe);
  }
  return Object.fromEntries(
    Object.keys(groups)
      .sort()
      .map((k) => [k, round(median(groups[k]), 2)]),
  );
}

export const indexRows = (records) =>
  records
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((r) => [r.code, r.name, r.type]);

// Worst of several part statuses: error > stale > ok.
export function worst(...parts) {
  const list = parts.filter(Boolean);
  if (list.includes('error')) return list.every((p) => p === 'error') ? 'error' : 'stale';
  return list.includes('stale') ? 'stale' : 'ok';
}
