#!/usr/bin/env node
// Daily data job (DESIGN sections 2, 3, 10).
//   node scripts/fetch-data.mjs --store <data-branch checkout> --out <dir for latest/>
// Reads <store>/history and <out>/latest from the previous run, fetches every source, and writes
// a fresh <out>/latest plus updated <store>/history. A failed source keeps its previous values and is
// marked "stale" (or "error" when nothing is left to keep). Exits 1 only when every price source failed.
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildFund, indexRows, industryPe, twRecord, usRecord, worst } from './lib/build.mjs';
import {
  addDays,
  buildEvents,
  holidayNote,
  taipeiToday,
  twCalendar,
  upcomingHolidays,
  usAsOf,
  usCalendar,
} from './lib/calendar.mjs';
import { BOT_CSV, ER_API, parseBotCsv, parseErApi } from './lib/fx.mjs';
import { MIN_BARS, mergeBars, mergeChip } from './lib/history.mjs';
import { createLimiter, getJson, getText, sleep as realSleep } from './lib/http.mjs';
import { NEWS_QUERIES, newsUrl, parseRss } from './lib/news.mjs';
import { loadBuckets, readJson, saveBuckets, swapDir, writeJson } from './lib/store.mjs';
import { TPEX, parseTpexIndex, parseTpexInsti, parseTpexMargin, parseTpexQuotes } from './lib/tpex.mjs';
import { parseEps, parseRevenue, parseTpexValuation, parseTwseValuation } from './lib/twfund.mjs';
import {
  TWSE,
  marginFollows,
  parseHolidays,
  parseMarginDated,
  parseMarginOpenapi,
  parseT86,
  parseTaiex,
  parseTwseQuotes,
} from './lib/twse.mjs';
import { MIN_MARKET_CAP, NASDAQ, NASDAQ_HEADERS, isUsUniverseStock, parseNasdaqEtfs, parseNasdaqStocks } from './lib/us.mjs';
import { pctChange, roundPx, twBucket, usBucket } from './lib/util.mjs';
import { indexFromBars, parseYahooChart, yahooSymbol, yahooUrl } from './lib/yahoo.mjs';

const ETF_LIST = new URL('./us-etfs.json', import.meta.url);
const US_INDEXES = { spx: '^GSPC', ndx: '^NDX', sox: '^SOX' };
const STATUS_ORDER = ['twse_quotes', 'tpex_quotes', 't86', 'margin', 'revenue', 'eps', 'pe', 'us_quotes', 'index', 'history', 'fx', 'news'];
const PRUNE_DAYS = 30;

export async function run({
  store,
  out = store,
  fetch = globalThis.fetch,
  now = new Date(),
  env = process.env,
  log = console.log,
  sleep = realSleep,
} = {}) {
  if (!store) throw new Error('--store is required');
  const http = makeHttp({ fetch, sleep, log });
  const prev = await loadPrevious(out, log);
  const hist = await loadHistory(store, log);
  const hadPrevious = Boolean(prev.meta);
  const today = taipeiToday(now);
  const status = {};

  log('fetching sources');
  const S = await fetchSources(http, today);

  if (!S.twseQuotes.ok && !S.tpexQuotes.ok && !S.usStocks.ok && !S.usEtfs.ok) {
    log('every price source failed; keeping the previous data');
    return { exitCode: 1, status: {} };
  }

  // ---- Taiwan ----
  if (S.holidays.ok) hist.calendar.tw = mergeHolidays(hist.calendar.tw, S.holidays.value, today);
  const twCal = twCalendar(hist.calendar.tw);
  const twseDate = S.twseQuotes.ok ? S.twseQuotes.value.date : null;
  const tpexDate = S.tpexQuotes.ok ? S.tpexQuotes.value.date : null;
  const twAsOf = [twseDate, tpexDate].filter(Boolean).sort().at(-1) ?? prev.meta?.tw?.asOf ?? null;

  const tw = {};
  const fresh = new Set();
  for (const [key, exchange, statusKey] of [
    ['twseQuotes', 'TWSE', 'twse_quotes'],
    ['tpexQuotes', 'TPEx', 'tpex_quotes'],
  ]) {
    const r = S[key];
    if (r.ok) {
      for (const q of r.value.records) {
        tw[q.code] = q;
        fresh.add(q.code);
      }
      status[statusKey] = r.value.date === twAsOf ? 'ok' : 'stale';
    } else {
      const kept = Object.values(prev.tw).filter((p) => p.exchange === exchange);
      for (const p of kept) tw[p.code] = p;
      status[statusKey] = kept.length ? 'stale' : 'error';
    }
  }
  for (const code of fresh) appendTwBar(hist, tw[code]);

  const dated = await fetchDatedTwse(http, twseDate ?? twAsOf);
  let twseMargin = dated.margin;
  if (!twseMargin.ok && S.twseMarginOpen.ok && twseDate) {
    twseMargin = dateOpenapiMargin(S.twseMarginOpen.value, hist.chips, twseDate, twCal, log) ?? twseMargin;
  }
  const part = (r, expected) => (r.ok ? (!expected || r.value.date >= expected ? 'ok' : 'stale') : hadPrevious ? 'stale' : 'error');
  for (const r of [dated.t86, S.tpexInsti, twseMargin, S.tpexMargin]) {
    if (!r.ok || !r.value.date) continue;
    for (const [code, f] of Object.entries(r.value.map)) {
      if (!tw[code]) continue;
      const fields =
        'foreign' in f
          ? { foreign: f.foreign, trust: f.trust, dealer: f.dealer }
          : { margin: f.margin, marginChg: f.marginChg, short: f.short };
      hist.chips[code] = mergeChip(hist.chips[code], r.value.date, fields);
    }
  }
  status.t86 = worst(part(dated.t86, twseDate), part(S.tpexInsti, tpexDate));
  status.margin = worst(part(twseMargin, twseDate), part(S.tpexMargin, tpexDate));

  const pick = (...rs) => Object.assign({}, ...rs.filter((r) => r.ok).map((r) => r.value.map));
  const rev = pick(S.twseRev, S.tpexRev);
  const eps = pick(S.twseEps, S.tpexEps);
  const val = pick(S.twseVal, S.tpexVal);
  status.revenue = worst(part(S.twseRev), part(S.tpexRev));
  status.eps = worst(part(S.twseEps), part(S.tpexEps));
  status.pe = worst(part(S.twseVal, twseDate), part(S.tpexVal, tpexDate));

  // ---- United States ----
  const etfSymbols = JSON.parse(await readFile(ETF_LIST, 'utf8'));
  const usDate = usAsOf(now);
  const { us, usFresh } = buildUsQuotes(S, prev, etfSymbols, usDate);
  for (const code of usFresh) {
    const q = us[code];
    hist.us[code] = mergeBars(hist.us[code], [[q.date, q.close, q.volume]], { prefer: 'incoming' });
  }
  const usStatus = (r, type) => (r.ok ? 'ok' : Object.values(prev.us).some((p) => p.type === type) ? 'stale' : 'error');
  status.us_quotes = worst(usStatus(S.usStocks, 'stock'), usStatus(S.usEtfs, 'etf'));
  const usMetaAsOf = S.usStocks.ok || S.usEtfs.ok ? usDate : prev.meta?.us?.asOf ?? usDate;

  // ---- Yahoo: US index closes, ETF volume, history bootstrap ----
  log('yahoo charts');
  const y = await runYahoo({ http, hist, tw, us, twAsOf, usDate, today, env, log });
  status.history = y.aborted ? 'stale' : 'ok';

  // ---- Records ----
  const twOut = {};
  for (const q of Object.values(tw)) {
    if (fresh.has(q.code)) fillFromHistory(q, hist.tw[q.code]);
    const p = prev.tw[q.code];
    const industry = q.type === 'stock' ? rev[q.code]?.industry ?? eps[q.code]?.industry ?? p?.industry : null;
    const fund = buildFund(p?.fund, { rev: rev[q.code], eps: eps[q.code], val: val[q.code] }, q.close);
    twOut[q.code] = twRecord(q, { industry, bars: hist.tw[q.code], chips: hist.chips[q.code], fund });
  }
  const usOut = {};
  for (const q of Object.values(us)) {
    if (usFresh.has(q.code)) fillFromHistory(q, hist.us[q.code]);
    if (q.type === 'etf' && q.volume == null) {
      q.volume = (hist.us[q.code] ?? []).find((b) => b[0] === q.date)?.[2] ?? null;
    }
    usOut[q.code] = usRecord(q, { bars: hist.us[q.code] });
  }

  // ---- meta ----
  const taiex = S.taiex.ok ? S.taiex.value : prev.meta?.tw?.index?.taiex ?? null;
  const tpexIndex = S.tpexIndex.ok ? S.tpexIndex.value : prev.meta?.tw?.index?.tpex ?? null;
  const usIndex = {};
  for (const key of Object.keys(US_INDEXES)) usIndex[key] = y.usIndex[key] ?? prev.meta?.us?.index?.[key] ?? null;
  status.index = worst(
    part(S.taiex, twseDate),
    part(S.tpexIndex, tpexDate),
    ...Object.keys(US_INDEXES).map((k) => (y.usIndex[k] ? 'ok' : hadPrevious ? 'stale' : 'error')),
  );
  status.fx = S.fx.ok ? 'ok' : prev.meta?.fx ? 'stale' : 'error';
  status.news = worst(part(S.newsTw), part(S.newsUs));

  const twNext = twAsOf ? twCal.next(twAsOf) : null;
  const usNext = usMetaAsOf ? usCalendar.next(usMetaAsOf) : null;
  const twUpcoming = upcomingHolidays(twCal, twAsOf);
  const usUpcoming = upcomingHolidays(usCalendar, usMetaAsOf);
  const meta = {
    schema: 1,
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tw: {
      asOf: twAsOf,
      nextTradingDay: twNext,
      holidayNote: holidayNote(twCal, twAsOf, twNext),
      upcomingHolidays: twUpcoming,
      index: { taiex, tpex: tpexIndex },
    },
    us: {
      asOf: usMetaAsOf,
      nextTradingDay: usNext,
      holidayNote: holidayNote(usCalendar, usMetaAsOf, usNext),
      upcomingHolidays: usUpcoming,
      index: usIndex,
    },
    fx: S.fx.ok ? S.fx.value : prev.meta?.fx ?? null,
    news: {
      tw: S.newsTw.ok ? S.newsTw.value : prev.meta?.news?.tw ?? [],
      us: S.newsUs.ok ? S.newsUs.value : prev.meta?.news?.us ?? [],
    },
    industryPe: industryPe(Object.values(twOut)),
    events: buildEvents({ today, twHolidays: twUpcoming, usHolidays: usUpcoming }),
    status: Object.fromEntries(STATUS_ORDER.map((k) => [k, status[k]])),
  };

  pruneHistory(hist, tw, us, twAsOf, usDate);
  await saveHistory(store, hist);
  await writeLatest(out, meta, twOut, usOut);
  log(`done: ${Object.keys(twOut).length} TW, ${Object.keys(usOut).length} US; status ${JSON.stringify(meta.status)}`);
  return { exitCode: 0, status: meta.status, meta };
}

// ---------------------------------------------------------------------------

// www.twse.com.tw blocks clients that send more than a few requests every few seconds.
const HOST_LIMITS = { 'www.twse.com.tw': { concurrency: 1, minIntervalMs: 2_500 } };

function makeHttp({ fetch, sleep, log }) {
  const limits = new Map();
  const limited = (url, fn) => {
    const host = new URL(url).host;
    if (!limits.has(host)) limits.set(host, createLimiter({ concurrency: 3, ...HOST_LIMITS[host], sleep }));
    return limits.get(host)(fn);
  };
  const base = { fetch, sleep, log };
  return {
    base,
    json: (url, o = {}) => limited(url, () => getJson(url, { ...base, ...o })),
    text: (url, o = {}) => limited(url, () => getText(url, { ...base, ...o })),
  };
}

async function settle(tasks, log) {
  const entries = await Promise.all(
    Object.entries(tasks).map(async ([key, fn]) => {
      try {
        return [key, { ok: true, value: await fn() }];
      } catch (error) {
        log(`  FAIL ${key}: ${error.message}`);
        return [key, { ok: false, error }];
      }
    }),
  );
  return Object.fromEntries(entries);
}

async function firstOk(attempts) {
  const errors = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(errors.join(' | '));
}

function fetchSources(http, today) {
  const nasdaq = { headers: NASDAQ_HEADERS, timeoutMs: 60_000, retries: 2 };
  const news = async (locale) => {
    const items = parseRss(await http.text(newsUrl(NEWS_QUERIES[locale], locale)), 12);
    if (!items.length) throw new Error('RSS has no items');
    return items;
  };
  return settle(
    {
      twseQuotes: () => http.json(TWSE.quotes).then(parseTwseQuotes),
      tpexQuotes: () => http.json(TPEX.quotes).then(parseTpexQuotes),
      twseVal: () => http.json(TWSE.valuation).then(parseTwseValuation),
      tpexVal: () => http.json(TPEX.valuation).then(parseTpexValuation),
      twseRev: () => http.json(TWSE.revenue).then(parseRevenue),
      tpexRev: () => http.json(TPEX.revenue).then(parseRevenue),
      twseEps: () => http.json(TWSE.eps).then(parseEps),
      tpexEps: () => http.json(TPEX.eps).then(parseEps),
      tpexInsti: () => http.json(TPEX.insti).then(parseTpexInsti),
      tpexMargin: () => http.json(TPEX.margin).then(parseTpexMargin),
      twseMarginOpen: () => http.json(TWSE.margin).then(parseMarginOpenapi),
      taiex: () => http.json(TWSE.index).then(parseTaiex),
      tpexIndex: () => http.json(TPEX.index).then(parseTpexIndex),
      holidays: () => http.json(TWSE.holidays).then(parseHolidays),
      usStocks: () => http.json(NASDAQ.stocks, nasdaq).then(parseNasdaqStocks),
      usEtfs: () => http.json(NASDAQ.etfs, nasdaq).then(parseNasdaqEtfs),
      fx: async () => {
        try {
          const rates = parseBotCsv(await http.text(BOT_CSV));
          return { USDTWD: rates.USD.mid, date: today, source: '臺灣銀行即期買賣中價' };
        } catch (err) {
          http.base.log(`  BOT csv failed (${err.message}); trying open.er-api.com`);
          const r = parseErApi(await http.json(ER_API));
          return { USDTWD: r.rate, date: r.date, source: 'ExchangeRate-API（open.er-api.com）' };
        }
      },
      newsTw: () => news('tw'),
      newsUs: () => news('us'),
    },
    http.base.log,
  );
}

// T86 and dated MI_MARGN: rwd path first, legacy path second; both must say stat OK for `date`.
async function fetchDatedTwse(http, date) {
  if (!date) {
    const missing = { ok: false, error: new Error('no TWSE trading date') };
    return { t86: missing, margin: missing };
  }
  const tryAll = (urls, parse, name) =>
    firstOk(
      urls.map((url) => async () => {
        const r = parse(await http.json(url, { retries: 1 }));
        if (r.date && r.date !== date) throw new Error(`${name} date ${r.date} != ${date}`);
        return { ...r, date };
      }),
    );
  const r = await settle(
    {
      t86: () => tryAll(TWSE.t86(date), parseT86, 'T86'),
      margin: () => tryAll(TWSE.marginDated(date), parseMarginDated, 'MI_MARGN'),
    },
    http.base.log,
  );
  return r;
}

// openapi MI_MARGN has no date: accept it for `date` only if its 前日餘額 continue our stored balances.
function dateOpenapiMargin(parsed, chips, date, cal, log) {
  const prevDay = cal.prev(date);
  const known = {};
  for (const [code, entries] of Object.entries(chips)) {
    const e = entries.find((x) => x.date === prevDay && x.margin != null);
    if (e) known[code] = e.margin;
  }
  if (marginFollows(parsed.map, known)) {
    log(`  using openapi MI_MARGN as ${date}`);
    return { ok: true, value: { date, map: parsed.map } };
  }
  log('  openapi MI_MARGN could not be matched to a date; skipped');
  return null;
}

function appendTwBar(hist, q) {
  if (q.close != null && q.date) hist.tw[q.code] = mergeBars(hist.tw[q.code], [[q.date, q.close, q.volume]], { prefer: 'incoming' });
}

// No trade today -> last known close with zero change; "除息"/"UNCH"-style changes -> close minus the previous close.
function fillFromHistory(q, bars = []) {
  if (q.close == null) {
    const last = bars.filter((b) => !q.date || b[0] <= q.date).at(-1);
    if (last) Object.assign(q, { close: last[1], change: 0, changePct: 0 });
    return;
  }
  if (q.change == null) {
    const before = bars.filter((b) => b[0] < q.date).at(-1);
    if (before) q.change = roundPx(q.close - before[1]);
  }
  if (q.changePct == null) q.changePct = pctChange(q.close, q.change);
}

function buildUsQuotes(S, prev, etfSymbols, date) {
  const us = {};
  const usFresh = new Set();
  const etfSet = new Set(etfSymbols);
  const stockRows = S.usStocks.ok ? S.usStocks.value : [];
  const bySymbol = new Map(stockRows.map((r) => [r.code, r]));
  for (const row of stockRows) {
    if (etfSet.has(row.code)) continue;
    // hysteresis: a stock already in the universe stays until it drops below 80% of the threshold
    const keep = prev.us[row.code]?.type === 'stock' && row.marketCap >= MIN_MARKET_CAP * 0.8;
    if (!isUsUniverseStock(row) && !keep) continue;
    const { rawName, ...rest } = row;
    us[row.code] = { ...rest, type: 'stock', date };
    usFresh.add(row.code);
  }
  if (!S.usStocks.ok) for (const p of Object.values(prev.us)) if (p.type === 'stock') us[p.code] = p;

  for (const code of etfSymbols) {
    const e = (S.usEtfs.ok && S.usEtfs.value[code]) || bySymbol.get(code);
    if (e) {
      us[code] = {
        code,
        name: e.name || prev.us[code]?.name || code,
        type: 'etf',
        sector: null,
        industry: null,
        date,
        close: e.close,
        change: e.change,
        changePct: e.changePct,
        volume: null,
        marketCap: null,
      };
      usFresh.add(code);
    } else if (prev.us[code]) {
      us[code] = prev.us[code];
    }
  }
  return { us, usFresh };
}

async function yahooChart(http, symbol, range) {
  let last;
  for (const host of ['query1', 'query2']) {
    try {
      const json = await getJson(yahooUrl(symbol, range, host), {
        ...http.base,
        retries: host === 'query1' ? 3 : 1,
        baseDelayMs: 5_000,
        timeoutMs: 20_000,
      });
      return parseYahooChart(json);
    } catch (err) {
      last = err;
      if (err.status === 404) break;
    }
  }
  throw last;
}

// Concurrency 2, >= 350 ms between starts, backoff inside getJson; stops after repeated 429s,
// after MAX_BOOTSTRAP bootstraps, or when BOOTSTRAP_MINUTES runs out. Unfinished codes continue next run.
async function runYahoo({ http, hist, tw, us, twAsOf, usDate, today, env, log }) {
  const limit = createLimiter({ concurrency: 2, minIntervalMs: 350, sleep: http.base.sleep });
  const deadline = Date.now() + Number(env.BOOTSTRAP_MINUTES ?? 30) * 60_000;
  const maxBootstrap = Number.parseInt(env.MAX_BOOTSTRAP ?? '1500', 10);
  const state = (hist.state.yahoo ??= {});
  let throttled = 0;
  let aborted = false;
  const counts = { ok: 0, fail: 0, skipped: 0 };

  const task = (symbol, range, onOk, onFail) =>
    limit(async () => {
      if (aborted || Date.now() > deadline) {
        counts.skipped++;
        return;
      }
      try {
        const chart = await yahooChart(http, symbol, range);
        throttled = 0;
        counts.ok++;
        onOk(chart);
      } catch (err) {
        counts.fail++;
        if (err.status === 429 && ++throttled >= 3 && !aborted) {
          aborted = true;
          log('  yahoo keeps answering 429; stopping for this run');
        }
        onFail?.(err);
      }
    });

  const usIndex = {};
  const jobs = Object.entries(US_INDEXES).map(([key, symbol]) =>
    task(symbol, '5d', (c) => {
      usIndex[key] = indexFromBars(c.bars, usDate);
    }),
  );

  const toBars = (bars, asOf) => bars.filter((b) => !asOf || b.date <= asOf).map((b) => [b.date, b.close, b.volume]);

  // ETFs with enough history: refresh the last few bars for volume (the ETF screener has none).
  for (const q of Object.values(us)) {
    if (q.type !== 'etf' || (hist.us[q.code]?.length ?? 0) < MIN_BARS) continue;
    jobs.push(
      task(yahooSymbol('US', q.code), '5d', (c) => {
        hist.us[q.code] = mergeBars(hist.us[q.code], toBars(c.bars, usDate), { prefer: 'existing' });
      }),
    );
  }

  const due = (key) => {
    const s = state[key];
    if (!s) return true;
    const wait = s.ok ? 7 : 7 * Math.min(s.n ?? 1, 4);
    return addDays(s.at, wait) <= today;
  };
  const twQueue = Object.values(tw)
    .filter((q) => (hist.tw[q.code]?.length ?? 0) < MIN_BARS && due(`TW:${q.code}`))
    .sort((a, b) => (b.close ?? 0) * (b.volume ?? 0) - (a.close ?? 0) * (a.volume ?? 0));
  const usQueue = Object.values(us)
    .filter((q) => (hist.us[q.code]?.length ?? 0) < MIN_BARS && due(`US:${q.code}`))
    .sort((a, b) => (a.type === b.type ? (b.marketCap ?? 0) - (a.marketCap ?? 0) : a.type === 'etf' ? -1 : 1));
  const queue = [];
  for (let i = 0; i < Math.max(twQueue.length, usQueue.length); i++) {
    if (twQueue[i]) queue.push(['TW', twQueue[i]]);
    if (usQueue[i]) queue.push(['US', usQueue[i]]);
  }
  const pending = queue.length;
  const batch = queue.slice(0, Math.max(0, maxBootstrap));
  log(`  bootstrap ${batch.length} of ${pending} codes with < ${MIN_BARS} days`);

  for (const [market, q] of batch) {
    const key = `${market}:${q.code}`;
    const store = market === 'TW' ? hist.tw : hist.us;
    const asOf = market === 'TW' ? q.date ?? twAsOf : usDate;
    jobs.push(
      task(
        yahooSymbol(market, q.code, q.exchange),
        '1y',
        (c) => {
          store[q.code] = mergeBars(store[q.code], toBars(c.bars, asOf), { prefer: 'existing' });
          if (market === 'US' && q.type === 'etf' && (!q.name || q.name === q.code) && c.name) q.name = c.name;
          state[key] = { at: today, ok: true };
        },
        (err) => {
          // only definitive answers are remembered; throttling and network errors retry next run
          if (err.status === 404 || /yahoo:/.test(err.message)) state[key] = { at: today, ok: false, n: (state[key]?.n ?? 0) + 1 };
        },
      ),
    );
  }
  await Promise.all(jobs);
  log(`  yahoo ok ${counts.ok}, failed ${counts.fail}, skipped ${counts.skipped}`);
  return { usIndex, aborted: aborted || counts.skipped > 0 };
}

function mergeHolidays(stored = [], fresh = [], today) {
  const byDate = new Map(stored.map((h) => [h.date, h]));
  for (const h of fresh) byDate.set(h.date, h);
  const oldest = addDays(today, -400);
  return [...byDate.values()].filter((h) => h.date >= oldest).sort((a, b) => a.date.localeCompare(b.date));
}

// Forget codes that left the universe more than PRUNE_DAYS ago.
function pruneHistory(hist, tw, us, twAsOf, usDate) {
  const drop = (map, universe, asOf, lastDate) => {
    if (!asOf) return;
    const cutoff = addDays(asOf, -PRUNE_DAYS);
    for (const code of Object.keys(map)) if (!universe[code] && !(lastDate(map[code]) >= cutoff)) delete map[code];
  };
  drop(hist.tw, tw, twAsOf, (bars) => bars.at(-1)?.[0]);
  drop(hist.us, us, usDate, (bars) => bars.at(-1)?.[0]);
  drop(hist.chips, tw, twAsOf, (entries) => entries.at(-1)?.date);
  for (const key of Object.keys(hist.state.yahoo ?? {})) {
    const [market, code] = key.split(':');
    if (!(market === 'TW' ? tw : us)[code]) delete hist.state.yahoo[key];
  }
}

async function tolerant(log, label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    log(`  WARN ignoring unreadable ${label}: ${err.message}`);
    return fallback;
  }
}

async function loadPrevious(dir, log) {
  const base = join(dir, 'latest');
  return {
    meta: await tolerant(log, 'latest/meta.json', () => readJson(join(base, 'meta.json')), null),
    tw: await tolerant(log, 'latest/tw', () => loadBuckets(join(base, 'tw')), {}),
    us: await tolerant(log, 'latest/us', () => loadBuckets(join(base, 'us')), {}),
  };
}

async function loadHistory(store, log) {
  const base = join(store, 'history');
  return {
    tw: await tolerant(log, 'history/tw', () => loadBuckets(join(base, 'tw')), {}),
    us: await tolerant(log, 'history/us', () => loadBuckets(join(base, 'us')), {}),
    chips: await tolerant(log, 'history/chips', () => loadBuckets(join(base, 'chips')), {}),
    state: (await tolerant(log, 'history/state.json', () => readJson(join(base, 'state.json')), null)) ?? { yahoo: {} },
    calendar: (await tolerant(log, 'history/calendar.json', () => readJson(join(base, 'calendar.json')), null)) ?? { tw: [] },
  };
}

async function saveHistory(store, hist) {
  const base = join(store, 'history');
  await saveBuckets(join(base, 'tw'), hist.tw, twBucket);
  await saveBuckets(join(base, 'us'), hist.us, usBucket);
  await saveBuckets(join(base, 'chips'), hist.chips, twBucket);
  await writeJson(join(base, 'state.json'), hist.state);
  await writeJson(join(base, 'calendar.json'), hist.calendar);
}

async function writeLatest(out, meta, twOut, usOut) {
  const tmp = join(out, 'latest.tmp');
  await rm(tmp, { recursive: true, force: true });
  await writeJson(join(tmp, 'meta.json'), meta, { pretty: true });
  await writeJson(join(tmp, 'index-tw.json'), indexRows(Object.values(twOut)));
  await writeJson(join(tmp, 'index-us.json'), indexRows(Object.values(usOut)));
  await saveBuckets(join(tmp, 'tw'), twOut, twBucket);
  await saveBuckets(join(tmp, 'us'), usOut, usBucket);
  await swapDir(tmp, join(out, 'latest'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { store: { type: 'string' }, out: { type: 'string' } } });
  if (!values.store) {
    console.error('usage: node scripts/fetch-data.mjs --store <dir> [--out <dir>]');
    process.exit(2);
  }
  run({ store: resolve(values.store), out: resolve(values.out ?? values.store) })
    .then((r) => process.exit(r.exitCode))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
