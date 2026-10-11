// USD/TWD: Bank of Taiwan CSV (the pipeline uses 即期賣出) with open.er-api.com as fallback.
import { num, round } from './util.mjs';

export const BOT_CSV = 'https://rate.bot.com.tw/xrt/flcsv/0/day';
export const ER_API = 'https://open.er-api.com/v6/latest/USD';

// UTF-8 BOM, trailing comma on every line, header names repeat -> parse by index.
// cols[3] = 即期買入, cols[13] = 即期賣出; 0 means "not quoted".
export function parseBotCsv(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const rates = {};
  for (const line of lines) {
    const cols = line.split(',').map((c) => c.trim());
    const code = cols[0];
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const buy = num(cols[3]) || null;
    const sell = num(cols[13]) || null;
    rates[code] = { spotBuy: buy, spotSell: sell, mid: buy && sell ? round((buy + sell) / 2, 4) : null };
  }
  if (!rates.USD?.spotSell) throw new Error('BOT csv: USD spot rate missing');
  return rates;
}

export function parseErApi(json) {
  const rate = num(json?.rates?.TWD);
  if (json?.result !== 'success' || !(rate > 0)) throw new Error('er-api: TWD rate missing');
  const t = Number(json.time_last_update_unix);
  return { rate: round(rate, 4), date: t ? new Date(t * 1000).toISOString().slice(0, 10) : null };
}
