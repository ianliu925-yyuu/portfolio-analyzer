// End-to-end runs of scripts/fetch-data.mjs against the fake market (fixtures, no network).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../fetch-data.mjs';
import { saveBuckets } from '../lib/store.mjs';
import { twBucket } from '../lib/util.mjs';
import { FIXTURES, createFakeMarket, noSleep, quiet } from './helpers/fake-market.mjs';
import { FIXTURE_NOW, buildSiteFixture } from './helpers/site-fixture.mjs';

const STATUS_KEYS = ['twse_quotes', 'tpex_quotes', 't86', 'margin', 'revenue', 'eps', 'pe', 'us_quotes', 'index', 'history', 'fx', 'news'];
const TW_KEYS = ['code', 'name', 'market', 'exchange', 'type', 'industry', 'date', 'close', 'change', 'changePct', 'open', 'high', 'low', 'volume', 'hist', 'chips', 'fund'];
const US_KEYS = ['code', 'name', 'market', 'type', 'sector', 'industry', 'date', 'close', 'change', 'changePct', 'volume', 'marketCap', 'hist'];
const HIST_KEYS = ['days', 'd5Pct', 'd20Pct', 'hi52', 'lo52', 'ma20', 'ma60', 'avgVol20', 'low20', 'high20'];
const CHIP_KEYS = ['date', 'foreign', 'trust', 'dealer', 'foreignStreak', 'trustStreak', 'foreign5', 'trust5', 'dealer5', 'margin', 'marginChg', 'short'];
const FUND_KEYS = ['revYm', 'rev', 'mom', 'yoy', 'ytdYoy', 'eps', 'epsPeriod', 'eps4q', 'pe', 'pb', 'yield'];

const readJson = async (...parts) => JSON.parse(await readFile(join(...parts), 'utf8'));
const exists = (p) => access(p).then(() => true, () => false);

async function tempStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fetch-data-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function runWith(store, { now = FIXTURE_NOW, env = {}, ...market } = {}) {
  const fake = createFakeMarket(market);
  return run({ store, out: store, fetch: fake.fetch, now, env, log: quiet, sleep: noSleep }).then((result) => ({ ...result, calls: fake.calls }));
}

const isNumOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));

test('first run from an empty store writes the DESIGN section 3 files', async (t) => {
  const store = await tempStore(t);
  const { exitCode, calls } = await runWith(store);
  assert.equal(exitCode, 0);
  const latest = join(store, 'latest');

  const meta = await readJson(latest, 'meta.json');
  assert.equal(meta.schema, 1);
  assert.equal(meta.generatedAt, '2026-10-10T23:17:05Z');
  assert.deepEqual(Object.keys(meta.status), STATUS_KEYS);
  assert.ok(Object.values(meta.status).every((s) => s === 'ok'), JSON.stringify(meta.status));
  assert.equal(meta.tw.asOf, '2026-10-08');
  assert.equal(meta.tw.nextTradingDay, '2026-10-12');
  assert.equal(meta.tw.holidayNote, '10/09–10/11 國慶日連假休市');
  assert.deepEqual(meta.tw.upcomingHolidays[0], { date: '2026-10-09', name: '國慶日' });
  assert.deepEqual(meta.tw.index.taiex, { date: '2026-10-08', close: 49313.44, change: -492.93, changePct: -0.99 });
  assert.equal(meta.tw.index.tpex.close, 412.37);
  assert.equal(meta.us.asOf, '2026-10-09');
  assert.equal(meta.us.nextTradingDay, '2026-10-12');
  assert.equal(meta.us.holidayNote, '');
  for (const key of ['spx', 'ndx', 'sox']) {
    assert.equal(meta.us.index[key].date, '2026-10-09');
    assert.ok(meta.us.index[key].close > 0 && isNumOrNull(meta.us.index[key].changePct));
  }
  assert.equal(meta.us.index.spx.close, 7180.52);
  assert.deepEqual(meta.fx, { USDTWD: 31.88, date: '2026-10-11', source: '臺灣銀行即期買賣中價' });
  for (const locale of ['tw', 'us']) {
    assert.equal(meta.news[locale].length, 12);
    for (const n of meta.news[locale]) assert.deepEqual(Object.keys(n), ['title', 'link', 'source', 'pubDate']);
  }
  assert.equal(meta.industryPe['TW:半導體業'], 24.1);
  assert.equal(meta.industryPe['TW:金融保險業'], 10.16);
  assert.ok(meta.events.some((e) => e.date === '2026-11-10' && e.title === '10 月營收公布期限（台股）'));

  const indexTw = await readJson(latest, 'index-tw.json');
  assert.ok(indexTw.every((row) => row.length === 3 && ['stock', 'etf', 'bond_etf'].includes(row[2])));
  assert.deepEqual(indexTw.find((r) => r[0] === '2330'), ['2330', '台積電', 'stock']);
  assert.deepEqual(indexTw.find((r) => r[0] === '00679B'), ['00679B', '元大美債20年', 'bond_etf']);
  assert.deepEqual(indexTw.map((r) => r[0]), indexTw.map((r) => r[0]).sort());
  const indexUs = await readJson(latest, 'index-us.json');
  assert.deepEqual(indexUs.find((r) => r[0] === 'VOO'), ['VOO', 'Vanguard S&P 500 ETF', 'etf']);
  assert.ok(!indexUs.some((r) => r[0] === 'AACG' || r[0] === 'NVTS' || r[0] === 'AIVI'), 'small caps and unlisted ETFs are left out');

  // every TW bucket holds full records keyed by code, in the bucket named by the first two characters
  for (const file of await readdir(join(latest, 'tw'))) {
    const bucket = await readJson(latest, 'tw', file);
    for (const [code, r] of Object.entries(bucket)) {
      assert.equal(file, `${code.slice(0, 2)}.json`);
      assert.deepEqual(Object.keys(r), TW_KEYS, code);
      assert.deepEqual(Object.keys(r.hist), HIST_KEYS, code);
      if (r.chips) assert.deepEqual(Object.keys(r.chips).filter((k) => k !== 'marginDate'), CHIP_KEYS, code);
      if (r.fund) assert.deepEqual(Object.keys(r.fund), FUND_KEYS, code);
      for (const k of ['close', 'change', 'changePct', 'volume']) assert.ok(isNumOrNull(r[k]), `${code}.${k}`);
    }
  }
  const tsmc = (await readJson(latest, 'tw', '23.json'))['2330'];
  assert.equal(tsmc.close, 2455);
  assert.equal(tsmc.exchange, 'TWSE');
  assert.equal(tsmc.industry, '半導體業');
  assert.equal(tsmc.hist.days, 250);
  assert.deepEqual(tsmc.chips, {
    date: '2026-10-08', foreign: 3456789, trust: -120000, dealer: 45000, foreignStreak: 1, trustStreak: -1,
    foreign5: 3456789, trust5: -120000, dealer5: 45000, margin: 23336, marginChg: -120, short: 456,
  });
  assert.deepEqual(tsmc.fund, {
    revYm: '2026-08', rev: 376512345, mom: 1.98, yoy: 12.13, ytdYoy: 19.24, eps: 41.72, epsPeriod: '2026Q2累計', eps4q: 83.05, pe: 29.56, pb: 10.28, yield: 0.86,
  });

  const etfs = await readJson(latest, 'tw', '00.json');
  assert.equal(etfs['00679B'].type, 'bond_etf');
  assert.equal(etfs['00679B'].exchange, 'TPEx');
  assert.equal(etfs['00679B'].fund, null);
  assert.deepEqual([etfs['00625K'].close, etfs['00625K'].change, etfs['00625K'].volume], [18.5, 0, 0], 'no trade: last close, zero change');
  const yuanTai = (await readJson(latest, 'tw', '80.json'))['8069'];
  assert.ok(Number.isFinite(yuanTai.change) && Number.isFinite(yuanTai.changePct), '除息 change is computed from the previous close');

  for (const file of await readdir(join(latest, 'us'))) {
    for (const [code, r] of Object.entries(await readJson(latest, 'us', file))) {
      assert.equal(file, `${code[0]}.json`);
      assert.deepEqual(Object.keys(r), US_KEYS, code);
      assert.deepEqual(Object.keys(r.hist), HIST_KEYS, code);
    }
  }
  const aapl = (await readJson(latest, 'us', 'A.json')).AAPL;
  assert.deepEqual([aapl.name, aapl.type, aapl.close, aapl.marketCap, aapl.hist.days], ['Apple Inc.', 'stock', 258.42, 3834563210000, 250]);
  const voo = (await readJson(latest, 'us', 'V.json')).VOO;
  assert.equal(voo.type, 'etf');
  assert.ok(voo.volume > 0, 'ETF volume comes from Yahoo');
  assert.ok((await readJson(latest, 'us', 'B.json'))['BRK.B']);
  assert.equal((await readJson(latest, 'us', 'Q.json')).QQQ.type, 'etf', 'curated ETF found in the stock screener');

  // history/
  const bars = (await readJson(store, 'history', 'tw', '23.json'))['2330'];
  assert.equal(bars.length, 250);
  assert.deepEqual(bars.at(-1), ['2026-10-08', 2455, 28512345]);
  assert.equal(new Set(bars.map((b) => b[0])).size, bars.length);
  const chips = (await readJson(store, 'history', 'chips', '23.json'))['2330'];
  assert.deepEqual(chips, [{ date: '2026-10-08', foreign: 3456789, trust: -120000, dealer: 45000, margin: 23336, marginChg: -120, short: 456 }]);
  assert.ok((await readJson(store, 'history', 'us', 'A.json')).AAPL.length >= 30);
  assert.ok((await readJson(store, 'history', 'calendar.json')).tw.some((h) => h.date === '2026-10-09'));

  // rwd answered with a maintenance page, so the legacy T86 / MI_MARGN paths were used
  const t86 = calls.filter((u) => u.includes('/fund/T86'));
  assert.ok(t86[0].includes('/rwd/zh/fund/T86') && t86[1].includes('www.twse.com.tw/fund/T86'));
  assert.ok(calls.filter((u) => u.includes('finance.yahoo.com')).every((u) => /range=(1y|5d)&interval=1d/.test(u)));
});

test('a second run keeps previous values for failed sources and marks them stale', async (t) => {
  const store = await tempStore(t);
  await runWith(store);
  const before = await readJson(store, 'latest', 'meta.json');
  const otcBefore = (await readJson(store, 'latest', 'tw', '49.json'))['4971'];

  const { exitCode, calls } = await runWith(store, {
    now: new Date('2026-10-12T12:17:00Z'),
    fail: ['tpexQuotes', 'newsTw', 'newsUs', 'bot', 'erApi', 't86', 'twseRev', 'tpexInsti'],
  });
  assert.equal(exitCode, 0);
  const meta = await readJson(store, 'latest', 'meta.json');
  assert.deepEqual(meta.status, {
    twse_quotes: 'ok', tpex_quotes: 'stale', t86: 'stale', margin: 'ok', revenue: 'stale', eps: 'ok', pe: 'ok',
    us_quotes: 'ok', index: 'ok', history: 'ok', fx: 'stale', news: 'stale',
  });
  assert.deepEqual(meta.news, before.news);
  assert.deepEqual(meta.fx, before.fx);
  const otc = (await readJson(store, 'latest', 'tw', '49.json'))['4971'];
  assert.equal(otc.close, otcBefore.close, 'TPEx quotes kept from the previous run');
  assert.deepEqual(otc.chips, otcBefore.chips, 'chips come from history');
  const tsmc = (await readJson(store, 'latest', 'tw', '23.json'))['2330'];
  assert.equal(tsmc.fund.revYm, '2026-08', 'revenue kept from the previous fund');
  assert.equal(tsmc.fund.rev, 376512345);

  const yahoo = calls.filter((u) => u.includes('finance.yahoo.com'));
  assert.ok(yahoo.length > 0 && yahoo.every((u) => u.includes('range=5d')), 'history is complete: no bootstrap, only refreshes');
  const bars = (await readJson(store, 'history', 'tw', '23.json'))['2330'];
  assert.equal(bars.length, 250, 'same-day bar de-duplicated');
});

test('the next trading day appends one bar and one chip entry per code', async (t) => {
  const store = await tempStore(t);
  await runWith(store);

  const json = (path) => JSON.parse(readFileSync(join(FIXTURES, path), 'utf8'));
  const quotes = json('twse/STOCK_DAY_ALL.json').map((r) => ({ ...r, Date: '1151012' }));
  Object.assign(quotes.find((r) => r.Code === '2330'), { ClosingPrice: '2470.00', Change: '15.0000', TradeVolume: '30000000' });
  const t86 = { ...json('twse/T86_20261008.json'), date: '20261012' };
  const margin = { ...json('twse/MI_MARGN_20261008.json'), date: '20261012' };
  const body = (v) => ({ body: JSON.stringify(v) });
  const dated = (v) => (url) => (url.includes('date=20261012') ? body(v) : body({ stat: 'NO DATA' }));

  const { exitCode, status } = await runWith(store, {
    now: new Date('2026-10-12T23:17:00Z'),
    overrides: { twseQuotes: body(quotes), t86: dated(t86), marginDated: dated(margin) },
    fail: ['tpexQuotes', 'tpexInsti', 'tpexMargin'],
  });
  assert.equal(exitCode, 0);
  assert.equal(status.twse_quotes, 'ok');
  const meta = await readJson(store, 'latest', 'meta.json');
  assert.deepEqual([meta.tw.asOf, meta.tw.nextTradingDay, meta.tw.holidayNote], ['2026-10-12', '2026-10-13', '']);
  assert.equal(meta.us.asOf, '2026-10-12');

  const bars = (await readJson(store, 'history', 'tw', '23.json'))['2330'];
  assert.equal(bars.length, 251);
  assert.deepEqual(bars.slice(-2), [['2026-10-08', 2455, 28512345], ['2026-10-12', 2470, 30000000]]);
  const tsmc = (await readJson(store, 'latest', 'tw', '23.json'))['2330'];
  assert.equal(tsmc.hist.days, 251);
  assert.equal(tsmc.hist.high20, 2470);
  assert.deepEqual(
    [tsmc.chips.date, tsmc.chips.foreignStreak, tsmc.chips.foreign5, tsmc.chips.trustStreak, tsmc.chips.margin],
    ['2026-10-12', 2, 6913578, -2, 23336],
  );
  const otc = (await readJson(store, 'latest', 'tw', '49.json'))['4971'];
  assert.equal(otc.date, '2026-10-08', 'TPEx failed: its records keep their own date');
  assert.equal(status.tpex_quotes, 'stale');
  assert.equal((await readJson(store, 'history', 'us', 'A.json')).AAPL.at(-1)[0], '2026-10-12');
});

test('undated openapi MI_MARGN is used only when it continues stored balances', async (t) => {
  const seeded = await tempStore(t);
  const prevDay = {};
  for (const r of JSON.parse(await readFile(join(FIXTURES, 'twse/MI_MARGN_openapi.json'), 'utf8'))) {
    prevDay[r['股票代號']] = [{ date: '2026-10-07', margin: Number(r['融資前日餘額'] || 0), marginChg: 0, short: 0 }];
  }
  await saveBuckets(join(seeded, 'history', 'chips'), prevDay, twBucket);
  const ok = await runWith(seeded, { fail: ['marginDated'] });
  assert.equal(ok.status.margin, 'ok');
  assert.equal((await readJson(seeded, 'latest', 'tw', '23.json'))['2330'].chips.margin, 23336);

  const empty = await tempStore(t);
  const skipped = await runWith(empty, { fail: ['marginDated'] });
  assert.equal(skipped.status.margin, 'stale', 'TPEx margin still ok, TWSE margin missing');
  assert.equal((await readJson(empty, 'latest', 'tw', '23.json'))['2330'].chips.margin, null);
});

test('exit code is non-zero only when every price source failed', async (t) => {
  const store = await tempStore(t);
  const all = await runWith(store, { fail: ['twseQuotes', 'tpexQuotes', 'usStocks', 'usEtfs'] });
  assert.equal(all.exitCode, 1);
  assert.equal(await exists(join(store, 'latest')), false, 'nothing is written');

  const twOnly = await runWith(store, { fail: ['twseQuotes', 'tpexQuotes'] });
  assert.equal(twOnly.exitCode, 0);
  assert.equal(twOnly.status.twse_quotes, 'error');
  assert.equal(twOnly.status.us_quotes, 'ok');
  assert.deepEqual(await readJson(store, 'latest', 'index-tw.json'), []);
});

test('Yahoo bootstrap honours MAX_BOOTSTRAP and continues on the next run', async (t) => {
  const store = await tempStore(t);
  const countReady = async (market) => {
    let n = 0;
    for (const f of await readdir(join(store, 'history', market))) {
      n += Object.values(await readJson(store, 'history', market, f)).filter((bars) => bars.length >= 30).length;
    }
    return n;
  };
  const first = await runWith(store, { env: { MAX_BOOTSTRAP: '5' } });
  assert.equal(first.status.history, 'ok');
  assert.equal((await countReady('tw')) + (await countReady('us')), 5);
  assert.ok((await countReady('tw')) >= 2 && (await countReady('us')) >= 2, 'TW and US are interleaved');
  const preview = (await readJson(store, 'latest', 'tw', '00.json'))['00682U'];
  assert.equal(preview.hist.days, 0, 'not bootstrapped yet');

  await runWith(store, { env: { MAX_BOOTSTRAP: '5' } });
  assert.equal((await countReady('tw')) + (await countReady('us')), 10);
});

test('repeated Yahoo 429s stop the run politely; 404s are remembered for a week', async (t) => {
  const throttled = await tempStore(t);
  const r = await runWith(throttled, { yahoo429: 10_000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.status.history, 'stale');
  assert.equal(r.status.index, 'stale');
  assert.ok(r.calls.filter((u) => u.includes('finance.yahoo.com')).length < 40, 'circuit breaker stops early');

  const missing = await tempStore(t);
  await runWith(missing, { yahoo404: ['1258.TWO'] });
  const state = await readJson(missing, 'history', 'state.json');
  assert.deepEqual(state.yahoo['TW:1258'], { at: '2026-10-11', ok: false, n: 1 });
  const again = await runWith(missing, { yahoo404: ['1258.TWO'] });
  assert.ok(!again.calls.some((u) => u.includes('1258.TWO')), 'not retried the same week');
});

test('CLI prints usage without --store', () => {
  const script = fileURLToPath(new URL('../fetch-data.mjs', import.meta.url));
  const res = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage: node scripts\/fetch-data\.mjs --store/);
});

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(relative(dir, join(entry.parentPath ?? entry.path, entry.name)));
  }
  return out.sort();
}

test('fixtures/site-latest is exactly what the pipeline produces (run build-site-fixture.mjs to refresh)', async (t) => {
  const store = await buildSiteFixture();
  t.after(() => rm(store, { recursive: true, force: true }));
  const committed = join(FIXTURES, 'site-latest');
  const fresh = join(store, 'latest');
  const files = await listFiles(committed);
  assert.deepEqual(await listFiles(fresh), files);
  for (const f of files) assert.equal(await readFile(join(fresh, f), 'utf8'), await readFile(join(committed, f), 'utf8'), f);

  const has = async (file, code) => assert.ok((await readJson(committed, file))[code], `${file} has ${code}`);
  await has('tw/23.json', '2330');
  await has('tw/49.json', '4971');
  await has('tw/53.json', '5351');
  await has('tw/00.json', '0050');
  await has('tw/00.json', '00679B');
  await has('us/A.json', 'AAPL');
  await has('us/N.json', 'NVDA');
  await has('us/V.json', 'VOO');
  const tsmc = (await readJson(committed, 'tw/23.json'))['2330'];
  assert.ok(tsmc.chips.foreignStreak > 1 && tsmc.chips.foreign5 !== tsmc.chips.foreign, 'seeded chip history gives streaks');
});
