// Yahoo Finance chart v8: daily bars for history bootstrap, ETF volume and US index closes.
import { pctChange, round, roundPx } from './util.mjs';

export const yahooUrl = (symbol, range = '1y', host = 'query1') =>
  `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;

// 2330 (TWSE) -> 2330.TW, 6488 (TPEx) -> 6488.TWO, BRK.B -> BRK-B
export function yahooSymbol(market, code, exchange) {
  if (market === 'TW') return `${code}.${exchange === 'TPEx' ? 'TWO' : 'TW'}`;
  return code.replace('.', '-');
}

// -> { symbol, name, currency, bars: [{date, close, volume}] } with bar dates in the exchange's zone
export function parseYahooChart(json) {
  const error = json?.chart?.error;
  if (error) throw new Error(`yahoo: ${error.code ?? ''} ${error.description ?? ''}`.trim());
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('yahoo: no chart.result');
  const meta = result.meta ?? {};
  const offset = Number(meta.gmtoffset) || 0;
  const quote = result.indicators?.quote?.[0] ?? {};
  const byDate = new Map();
  (result.timestamp ?? []).forEach((t, i) => {
    const close = quote.close?.[i];
    if (!(Number.isFinite(close) && close > 0)) return;
    const volume = quote.volume?.[i];
    const date = new Date((t + offset) * 1000).toISOString().slice(0, 10);
    byDate.set(date, { date, close: roundPx(close), volume: Number.isFinite(volume) ? volume : null });
  });
  return {
    symbol: meta.symbol ?? null,
    name: meta.longName ?? meta.shortName ?? null,
    currency: meta.currency ?? null,
    bars: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// Index summary from the last two bars on or before asOf.
export function indexFromBars(bars, asOf) {
  const usable = asOf ? bars.filter((b) => b.date <= asOf) : bars;
  const last = usable.at(-1);
  if (!last) return null;
  const prev = usable.at(-2);
  const change = prev ? round(last.close - prev.close, 2) : null;
  return { date: last.date, close: round(last.close, 2), change, changePct: pctChange(last.close, change) };
}
