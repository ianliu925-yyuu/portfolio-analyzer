import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBotCsv, parseErApi } from '../lib/fx.mjs';
import { decodeEntities, newsUrl, parseRss } from '../lib/news.mjs';
import { indexFromBars, parseYahooChart, yahooUrl } from '../lib/yahoo.mjs';
import { fixture, fixtureJson } from './helpers/fake-market.mjs';

test('Yahoo chart: dates in exchange time, null bars dropped, float noise rounded', () => {
  const chart = parseYahooChart(fixtureJson('yahoo/2330.TW_5d.json'));
  assert.equal(chart.symbol, '2330.TW');
  assert.equal(chart.currency, 'TWD');
  assert.equal(chart.name, 'Taiwan Semiconductor Manufacturing Company Limited');
  assert.deepEqual(chart.bars, [
    { date: '2026-07-07', close: 2440, volume: 28123456 },
    { date: '2026-07-08', close: 2465, volume: 31234567 },
    { date: '2026-07-09', close: 2450, volume: 25678901 },
    { date: '2026-07-13', close: 2440, volume: 34539893 },
  ]);
  assert.throws(() => parseYahooChart(fixtureJson('yahoo/not_found.json')), /Not Found/);
  assert.equal(yahooUrl('^GSPC', '5d'), 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=5d&interval=1d');
});

test('index summary from the last two bars on or before asOf', () => {
  const bars = [
    { date: '2026-10-08', close: 7132.28 },
    { date: '2026-10-09', close: 7180.52 },
    { date: '2026-10-12', close: 9999 },
  ];
  assert.deepEqual(indexFromBars(bars, '2026-10-09'), { date: '2026-10-09', close: 7180.52, change: 48.24, changePct: 0.68 });
  assert.equal(indexFromBars([], '2026-10-09'), null);
});

test('Bank of Taiwan CSV: BOM, trailing commas, parse by index, 0 = not quoted', () => {
  const rates = parseBotCsv(fixture('fx/bot_day.csv'));
  assert.deepEqual(rates.USD, { spotBuy: 31.805, spotSell: 31.955, mid: 31.88 });
  assert.deepEqual(rates.PHP, { spotBuy: null, spotSell: null, mid: null });
  assert.equal(Object.keys(rates).length, 19);
  assert.throws(() => parseBotCsv('﻿幣別,匯率,現金,即期,\n'), /USD/);
});

test('open.er-api.com fallback', () => {
  assert.deepEqual(parseErApi(fixtureJson('fx/er_api.json')), { rate: 31.9627, date: '2026-10-09' });
  assert.throws(() => parseErApi({ result: 'error' }), /TWD/);
});

test('Google News RSS: top 12, source suffix stripped, entities and CDATA decoded', () => {
  const tw = parseRss(fixture('news/google_tw.xml'));
  assert.equal(tw.length, 12);
  assert.deepEqual(tw[0], {
    title: '台股國慶連假前量縮整理 加權指數跌492點收49313點',
    link: 'https://news.google.com/rss/articles/CBMiUEFVX3lxTE1qNmZZcnpQWXkyYi1ydmZMb0pIZ3dQeUl3MTVFYktMdXVLUEN5UmhYMy1QTVJkVVZadU01WW1iSzdfdmtVV1U5TU1XTk1WVjJ40?oc=5',
    source: '經濟日報',
    pubDate: '2026-10-08T07:12:00Z',
  });
  assert.equal(tw[5].title, '「台股&美股」雙市場配置 投信：高股息ETF仍是主流');
  assert.equal(tw[6].title, '櫃買指數下跌3.55點 矽光子族群逆勢走強', 'CDATA title');
  const us = parseRss(fixture('news/google_us.xml'), 3);
  assert.deepEqual(
    us.map((n) => [n.title, n.source]),
    [
      ['Stocks slip as investors weigh Fed minutes & bond yields', 'Reuters'],
      ["S&P 500 ends week lower; Nvidia's slide weighs on tech", 'CNBC'],
      ['Stock market today: Dow, S&P 500, Nasdaq close mixed ahead of earnings season', 'Yahoo Finance'],
    ],
  );
  const noSource = parseRss('<rss><channel><item><title>Headline - Some Paper</title><link>https://x.test/a</link></item></channel></rss>');
  assert.deepEqual(noSource[0], { title: 'Headline', link: 'https://x.test/a', source: 'Some Paper', pubDate: '' });
  assert.deepEqual(parseRss('<html>consent page</html>'), []);
});

test('entity decoding is single-pass', () => {
  assert.equal(decodeEntities('A &amp; B &lt;i&gt; &#39;q&#39; &#x4E2D; &amp;lt;'), "A & B <i> 'q' 中 &lt;");
  assert.equal(
    newsUrl('台股 when:1d', 'tw'),
    'https://news.google.com/rss/search?q=%E5%8F%B0%E8%82%A1%20when%3A1d&hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
  );
  assert.equal(newsUrl('stock market when:1d', 'us'), 'https://news.google.com/rss/search?q=stock%20market%20when%3A1d&hl=en-US&gl=US&ceid=US:en');
});
