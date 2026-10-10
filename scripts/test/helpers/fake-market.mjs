// Fake fetch that serves the recorded fixtures (and deterministic Yahoo charts) for pipeline tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addDays, isUsDst, twCalendar, usCalendar } from '../../lib/calendar.mjs';
import { parseHolidays } from '../../lib/twse.mjs';

export const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const fixture = (path) => readFileSync(FIXTURES + path, 'utf8');
export const fixtureJson = (path) => JSON.parse(fixture(path));

const MAINTENANCE = () => ({ body: fixture('twse/rwd_maintenance.html'), type: 'text/html; charset=utf-8' });
const json = (path) => () => ({ body: fixture(path), type: 'application/json' });
const NO_DATA = { stat: '很抱歉，沒有符合條件的資料!' };

// [source key, url test, responder]
const ROUTES = [
  ['twseQuotes', (u) => u.endsWith('/v1/exchangeReport/STOCK_DAY_ALL'), json('twse/STOCK_DAY_ALL.json')],
  ['twseVal', (u) => u.endsWith('/v1/exchangeReport/BWIBBU_ALL'), json('twse/BWIBBU_ALL.json')],
  ['twseRev', (u) => u.endsWith('/v1/opendata/t187ap05_L'), json('twse/t187ap05_L.json')],
  ['twseEps', (u) => u.endsWith('/v1/opendata/t187ap14_L'), json('twse/t187ap14_L.json')],
  ['twseMarginOpen', (u) => u.endsWith('/v1/exchangeReport/MI_MARGN'), json('twse/MI_MARGN_openapi.json')],
  ['taiex', (u) => u.endsWith('/v1/exchangeReport/MI_INDEX'), json('twse/MI_INDEX.json')],
  ['holidays', (u) => u.endsWith('/v1/holidaySchedule/holidaySchedule'), json('twse/holidaySchedule.json')],
  ['t86Rwd', (u) => u.includes('www.twse.com.tw/rwd/zh/fund/T86'), MAINTENANCE],
  ['t86', (u) => u.includes('www.twse.com.tw/fund/T86'), (u) =>
    u.includes('date=20261008') ? json('twse/T86_20261008.json')() : { body: JSON.stringify(NO_DATA), type: 'application/json' }],
  ['marginRwd', (u) => u.includes('www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN'), MAINTENANCE],
  ['marginDated', (u) => u.includes('www.twse.com.tw/exchangeReport/MI_MARGN'), (u) =>
    u.includes('date=20261008') ? json('twse/MI_MARGN_20261008.json')() : { body: JSON.stringify(NO_DATA), type: 'application/json' }],
  ['tpexQuotes', (u) => u.endsWith('/tpex_mainboard_quotes'), json('tpex/tpex_mainboard_quotes.json')],
  ['tpexVal', (u) => u.endsWith('/tpex_mainboard_peratio_analysis'), json('tpex/tpex_mainboard_peratio_analysis.json')],
  ['tpexRev', (u) => u.endsWith('/mopsfin_t187ap05_O'), json('tpex/mopsfin_t187ap05_O.json')],
  ['tpexEps', (u) => u.endsWith('/mopsfin_t187ap14_O'), json('tpex/mopsfin_t187ap14_O.json')],
  ['tpexMargin', (u) => u.endsWith('/tpex_mainboard_margin_balance'), json('tpex/tpex_mainboard_margin_balance.json')],
  ['tpexInsti', (u) => u.endsWith('/tpex_3insti_daily_trading'), json('tpex/tpex_3insti_daily_trading.json')],
  ['tpexIndex', (u) => u.endsWith('/tpex_index'), json('tpex/tpex_index.json')],
  ['usStocks', (u) => u.startsWith('https://api.nasdaq.com/api/screener/stocks'), json('us/nasdaq_stocks.json')],
  ['usEtfs', (u) => u.startsWith('https://api.nasdaq.com/api/screener/etf'), json('us/nasdaq_etf.json')],
  ['bot', (u) => u.startsWith('https://rate.bot.com.tw/'), () => ({ body: fixture('fx/bot_day.csv'), type: 'text/csv' })],
  ['erApi', (u) => u.startsWith('https://open.er-api.com/'), json('fx/er_api.json')],
  ['newsTw', (u) => u.startsWith('https://news.google.com/rss/search') && u.includes('hl=zh-TW'), () => ({ body: fixture('news/google_tw.xml'), type: 'application/xml' })],
  ['newsUs', (u) => u.startsWith('https://news.google.com/rss/search') && u.includes('hl=en-US'), () => ({ body: fixture('news/google_us.xml'), type: 'application/xml' })],
];

// Closes that the generated Yahoo history ends on (so the official bar and history agree).
function finalCloses() {
  const closes = { '00625K': 18.5, '00682U': 30.2, 1258: 31.5, '^GSPC': 7180.52, '^NDX': 26543.21, '^SOX': 7412.88 };
  const volumes = {};
  for (const r of fixtureJson('twse/STOCK_DAY_ALL.json')) {
    if (Number(r.ClosingPrice) > 0) closes[r.Code] = Number(r.ClosingPrice);
    volumes[r.Code] = Number(r.TradeVolume) || 0;
  }
  for (const r of fixtureJson('tpex/tpex_mainboard_quotes.json')) {
    if (Number(r.Close) > 0) closes[r.SecuritiesCompanyCode] = Number(r.Close);
    volumes[r.SecuritiesCompanyCode] = Number(r.TradingShares) || 0;
  }
  for (const r of fixtureJson('us/nasdaq_stocks.json').data.rows) {
    const code = r.symbol.replace('/', '.');
    closes[code] = Number(r.lastsale.replace('$', ''));
    volumes[code] = Number(r.volume) || 0;
  }
  for (const r of fixtureJson('us/nasdaq_etf.json').data.data.rows) closes[r.symbol] = Number(r.lastSalePrice.replace('$', ''));
  return { closes, volumes };
}

export function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

export function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic chart: the same symbol always yields the same bars, and range=5d is the tail of range=1y.
export function makeChart(symbol, range, { twAsOf, usAsOf, closes, volumes, twCal }) {
  const tw = /\.(TW|TWO)$/.test(symbol);
  const code = symbol.replace(/\.(TW|TWO)$/, '').replace('-', '.');
  const cal = tw ? twCal : usCalendar;
  const n = range === '5d' ? 5 : 250;
  const dates = [];
  for (let d = tw ? twAsOf : usAsOf; dates.length < n; d = addDays(d, -1)) if (cal.isTradingDay(d)) dates.unshift(d);
  const rand = rng(hash(symbol));
  const close = new Array(n);
  const volume = new Array(n);
  const baseVol = volumes[code] || 1_000_000;
  let c = closes[code] ?? 50;
  for (let i = n - 1; i >= 0; i--) {
    close[i] = Math.round(c * 100) / 100;
    volume[i] = Math.round(baseVol * (0.6 + 0.8 * rand()));
    c = c / (1 + 0.0006 + (rand() - 0.5) * 0.04);
  }
  const timestamp = dates.map((d) => {
    const midnight = Date.parse(`${d}T00:00:00Z`) / 1000;
    if (tw) return midnight - 8 * 3600 + 9 * 3600;
    return midnight + (isUsDst(new Date(`${d}T16:00:00Z`)) ? 13.5 : 14.5) * 3600;
  });
  const gmtoffset = tw ? 28800 : -14400;
  return {
    chart: {
      result: [
        {
          meta: {
            currency: tw ? 'TWD' : 'USD',
            symbol,
            exchangeName: tw ? (symbol.endsWith('.TWO') ? 'TWO' : 'TAI') : 'NMS',
            instrumentType: /^\^/.test(symbol) ? 'INDEX' : 'EQUITY',
            gmtoffset,
            timezone: tw ? 'CST' : 'EDT',
            exchangeTimezoneName: tw ? 'Asia/Taipei' : 'America/New_York',
            regularMarketPrice: close[n - 1],
            longName: `${code} Fixture Fund`,
            dataGranularity: '1d',
            range,
          },
          timestamp,
          indicators: { quote: [{ open: close.slice(), high: close.slice(), low: close.slice(), close, volume }], adjclose: [{ adjclose: close.slice() }] },
        },
      ],
      error: null,
    },
  };
}

export function createFakeMarket({
  twAsOf = '2026-10-08',
  usAsOf = '2026-10-09',
  fail = [],
  overrides = {},
  yahoo404 = [],
  yahoo429 = 0,
} = {}) {
  const calls = [];
  const failing = new Set(fail);
  const { closes, volumes } = finalCloses();
  const twCal = twCalendar(parseHolidays(fixtureJson('twse/holidaySchedule.json')));
  let throttle = yahoo429;

  const fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const respond = (body, status = 200, type = 'application/json') =>
      new Response(body, { status, headers: { 'content-type': type } });

    const y = url.match(/finance\.yahoo\.com\/v8\/finance\/chart\/([^?]+)\?range=(\w+)/);
    if (y) {
      const symbol = decodeURIComponent(y[1]);
      if (failing.has('yahoo')) return respond('{}', 503);
      if (throttle > 0) {
        throttle--;
        return respond('Too Many Requests', 429, 'text/plain');
      }
      if (yahoo404.includes(symbol)) return respond(fixture('yahoo/not_found.json'), 404);
      return respond(JSON.stringify(makeChart(symbol, y[2], { twAsOf, usAsOf, closes, volumes, twCal })));
    }

    const route = ROUTES.find(([, test]) => test(url));
    if (!route) return respond('not found', 404, 'text/plain');
    const [key, , responder] = route;
    if (failing.has(key)) return respond('Service Unavailable', 503, 'text/plain');
    if (overrides[key]) {
      const o = typeof overrides[key] === 'function' ? overrides[key](url) : overrides[key];
      return respond(o.body, o.status ?? 200, o.type ?? 'application/json');
    }
    const { body, type } = responder(url);
    return respond(body, 200, type);
  };
  return { fetch, calls };
}

export const noSleep = async () => {};
export const quiet = () => {};
