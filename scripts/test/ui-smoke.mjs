// 網頁冒煙測試：本機靜態伺服器 + Playwright（390×844 與 1280×900）。
//   node scripts/test/ui-smoke.mjs [--data <latest 目錄>] [--shots <截圖目錄>]
// 不連外網：cdn.jsdelivr.net 換成假的 Anthropic SDK，新聞 proxy 回傳假的 RSS，其他外部請求一律擋掉。
import http from 'node:http';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const DATA = path.resolve(opt('--data', path.join(ROOT, 'scripts/test/fixtures/ui-latest')));
const SHOTS = path.resolve(opt('--shots', '/tmp/ui-shots'));
const TZ = 'Asia/Taipei';

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));

const { tradeCosts } = await import(pathToFileURL(path.join(ROOT, 'assets/fees.js')));
const { buildHoldings, valueHolding, summarize, holdingKey } = await import(pathToFileURL(path.join(ROOT, 'assets/portfolio.js')));

// ---------- 靜態伺服器 ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      const [base, rel] = p.startsWith('/data/latest/') ? [DATA, p.slice('/data/latest/'.length)] : [ROOT, p.slice(1)];
      const file = path.resolve(base, rel);
      if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) throw Object.assign(new Error('nf'), { code: 'ENOENT' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- 假的外部服務 ----------

const XSS = '<img src=x onerror="window.__xss=1">';
const CANNED = {
  stocks: [
    { code: '2330', action: '分批停利', summary: `報酬率超過 70% 且占總資產過半，${XSS} 建議先分批停利。`,
      reasons: ['收盤 1,025 比平均成本 580.50 高 76%', '外資連買 3 天、5 日買超 4,500 張'],
      trigger: '收盤跌破 960 → 再賣一批；站穩 1,060 → 剩餘續抱', bull: ['9 月營收年增 11.37%'], bear: ['單檔占總資產超過 40%'],
      watch: ['10/12 開盤能否守住 1,000'] },
    { code: '0050', action: '續抱', summary: '成本 150 附近、站上季線 147.9，續抱。', reasons: ['收盤 152.35 高於季線 147.9'],
      trigger: '收盤跌破 146.1 → 減碼', bull: ['外資買超 2,100 張'], bear: [], watch: ['留意 158.4 壓力'] },
    { code: 'AAPL', action: '分批停利', summary: '報酬率 22%、52 週位置 94%，可先賣一部分。', reasons: ['收盤 245.3、52 週高 250'],
      trigger: '收盤跌破 228.4 → 再減碼', bull: ['站上季線 229.1'], bear: ['接近 52 週高點 250'], watch: ['250 壓力'] },
  ],
  portfolio: { risks: ['台積電占總資產超過 40%'], advice: ['新資金優先買半導體以外的產業'] },
};

const STUB_SDK = `
const canned = ${JSON.stringify(CANNED)};
export default class Anthropic {
  constructor(opts) {
    const create = async (body) => {
      (globalThis.__aiCalls ||= []).push({ body: JSON.parse(JSON.stringify(body)), apiKey: opts.apiKey, browser: opts.dangerouslyAllowBrowser });
      await new Promise((r) => setTimeout(r, 300));
      return { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(canned) }], usage: { input_tokens: 5234, output_tokens: 4321 } };
    };
    this.messages = { create };
    this.beta = { messages: { create } };
  }
}
`;

const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Google News</title>
<item><title>法說會前夕 外資連三買 - 範例新聞</title><link>https://news.example.com/a1</link><pubDate>Fri, 09 Oct 2026 08:00:00 GMT</pubDate><source url="https://news.example.com">範例新聞</source></item>
<item><title>&lt;img src=x onerror="window.__xss=2"&gt; 測試標題 - 惡意來源</title><link>https://news.example.com/a2</link><pubDate>Thu, 08 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>壞連結不應出現 - 惡意來源</title><link>javascript:alert(1)</link><pubDate>Thu, 08 Oct 2026 07:00:00 GMT</pubDate></item>
</channel></rss>`;

async function installRoutes(context, blocked) {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
    blocked.push(route.request().url());
    return route.abort();
  });
  const cors = { 'access-control-allow-origin': '*' };
  await context.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', headers: cors, body: STUB_SDK }));
  await context.route('https://corsproxy.io/**', (route) => route.fulfill({ status: 200, contentType: 'application/rss+xml; charset=utf-8', headers: cors, body: RSS }));
}

// ---------- 期望值（用同一套計算模組） ----------

const todayTaipei = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function readRecord(market, code) {
  const bucket = market === 'US' ? code[0] : code.slice(0, 2);
  try {
    const data = JSON.parse(await readFile(path.join(DATA, market === 'US' ? 'us' : 'tw', `${bucket}.json`), 'utf8'));
    return data[code] ?? null;
  } catch {
    return null;
  }
}

const TRADES = [
  { market: 'TW', code: '2330', shares: 1000, price: 580, type: 'stock' },
  { market: 'TW', code: '0050', shares: 2000, price: 150, type: 'etf' },
  { market: 'US', code: 'AAPL', shares: 10, price: 200, type: 'stock' },
];

async function expectedSummary({ cashTWD = 0 } = {}) {
  const meta = JSON.parse(await readFile(path.join(DATA, 'meta.json'), 'utf8'));
  const date = todayTaipei();
  const txs = TRADES.map((t, i) => {
    const broker = t.market === 'TW' ? 'tw_generic_06' : 'us_firstrade';
    const c = tradeCosts({ ...t, side: 'buy', date, broker });
    return { id: String(i), ...t, side: 'buy', date, feeIncluded: false, fee: c.fee, tax: c.tax, regFee: c.regFee, broker };
  });
  const built = buildHoldings(txs);
  const rows = [];
  for (const h of built.holdings) rows.push(valueHolding(h, await readRecord(h.market, h.code), { fx: meta.fx?.USDTWD, date }));
  return summarize(rows, { cashTWD, fx: meta.fx?.USDTWD, realizedTotal: built.realizedTotal });
}

const parseMoney = (s) => {
  const t = String(s).replace(/\s/g, '');
  const n = Number(t.replace(/[^0-9.]/g, ''));
  return /^[−-]/.test(t) ? -n : n;
};

// ---------- 共用檢查 ----------

async function noHScroll(page, label) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(sw <= iw, `${label}: 頁面出現橫向捲動（scrollWidth ${sw} > innerWidth ${iw}）`);
}

async function scaleLabelsDontOverlap(page, label) {
  const overlaps = await page.evaluate(() => {
    const bad = [];
    for (const scale of document.querySelectorAll('details[open] [data-scale]')) {
      const rects = [...scale.querySelectorAll('.scale-label')].map((n) => ({ t: n.textContent, r: n.getBoundingClientRect() }));
      const box = scale.getBoundingClientRect();
      for (const { t, r } of rects) if (r.left < box.left - 0.5 || r.right > box.right + 0.5) bad.push(`超出邊界：${t}`);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i].r, b = rects[j].r;
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) bad.push(`${rects[i].t} ↔ ${rects[j].t}`);
        }
      }
    }
    return bad;
  });
  assert.deepEqual(overlaps, [], `${label}: 價位刻度標籤重疊`);
}

function watchConsole(page, { allow = [] } = {}) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !allow.some((re) => re.test(m.text()))) errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function newPage(browser, viewport, opts = {}) {
  const context = await browser.newContext({ viewport, locale: 'zh-TW', timezoneId: TZ, acceptDownloads: true, ...opts.context });
  const blocked = [];
  await installRoutes(context, blocked);
  if (opts.routes) await opts.routes(context);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  const errors = watchConsole(page, opts);
  return { context, page, errors, blocked };
}

async function addTrade(page, { market, code, pick, shares, price, viaKeyboard = false }) {
  await page.check(`input[name="market"][value="${market}"]`);
  await page.click('#fCode');
  await page.fill('#fCode', pick ?? code);
  if (pick) {
    await page.waitForSelector('#codeList li[data-i]');
    if (viaKeyboard) await page.keyboard.press('Enter');
    else await page.locator('#codeList li[data-i]', { hasText: code }).first().click();
    await page.waitForFunction((c) => document.getElementById('fCode').value === c, code);
  }
  await page.fill('#fShares', String(shares));
  await page.fill('#fPrice', String(price));
  await page.click('#submitBtn');
  await page.waitForSelector(`#holdingsWrap tr[data-key="${market}:${code}"]`);
}

// ---------- 情境 ----------

async function mainFlow(browser, baseURL, name, viewport) {
  const { context, page, errors, blocked } = await newPage(browser, viewport);
  await page.goto(baseURL);
  await page.waitForSelector('#dataDates b');
  const meta = JSON.parse(await readFile(path.join(DATA, 'meta.json'), 'utf8'));
  const header = await page.textContent('#dataDates');
  assert.ok(header.includes(`台股以 ${meta.tw.asOf} 收盤計`) && header.includes(`美股以 ${meta.us.asOf} 收盤計`), `資料日期：${header}`);
  assert.match(await page.textContent('#nextDay'), /下一個交易日：台股 \d{4}-\d{2}-\d{2}/);
  assert.equal(await page.title(), '持倉分析');
  await noHScroll(page, `${name} 空白頁`);
  await page.screenshot({ path: path.join(SHOTS, `${name}-1-empty.png`), fullPage: true });

  // 自動完成 + 手續費試算
  await page.check('input[name="market"][value="TW"]');
  await page.fill('#fCode', '台積');
  await page.waitForSelector('#codeList li[data-i]');
  assert.ok((await page.textContent('#codeList')).includes('2330'), '名稱搜尋找得到 2330');
  await page.locator('#codeList li[data-i]', { hasText: '2330' }).first().click();
  await page.waitForFunction(() => document.getElementById('codeInfo').textContent.includes('台積電'));
  await page.fill('#fShares', '1000');
  await page.fill('#fPrice', '580');
  const preview = await page.textContent('#feePreview');
  assert.ok(preview.includes('手續費NT$495') && preview.includes('買進總成本NT$580,495'), `手續費試算：${preview}`);
  await page.click('#submitBtn');
  await page.waitForSelector('#holdingsWrap tr[data-key="TW:2330"]');

  await addTrade(page, { market: 'TW', code: '0050', pick: '0050', shares: 2000, price: 150 });
  await addTrade(page, { market: 'US', code: 'AAPL', pick: 'AAP', shares: 10, price: 200, viaKeyboard: true });
  assert.equal(await page.locator('#holdingsWrap tbody tr').count(), 3);

  // 總覽數字和計算模組一致
  const exp = await expectedSummary();
  const statText = (id, sel = '.stat-value') => page.textContent(`[data-stat="${id}"] ${sel}`);
  assert.equal(parseMoney(await statText('marketValue')), Math.round(exp.marketValue), '總市值');
  assert.equal(parseMoney(await statText('cost')), Math.round(exp.costTotal), '總成本');
  assert.equal(parseMoney(await statText('netPL', '.stat-value span')), Math.round(exp.netPL), '未實現淨損益');
  assert.ok((await statText('cashRatio', '')).includes('全倉'), '沒有現金時顯示全倉警示');
  assert.ok((await page.textContent('#statsLine')).includes('今日損益'));
  assert.ok((await page.textContent('#statsLine')).includes(String(meta.fx.USDTWD)), '顯示使用的匯率');

  // 現金
  await page.fill('#cashTWD', '100000');
  await page.waitForFunction(() => !document.querySelector('[data-stat="cashRatio"]').textContent.includes('全倉'));
  const expCash = await expectedSummary({ cashTWD: 100000 });
  const ratio = await statText('cashRatio');
  assert.equal(ratio.trim(), `${(expCash.cashRatio * 100).toFixed(1)}%`, '現金比例');

  // 配置圖、建議標籤、詳細卡
  assert.equal(await page.locator('#allocBody svg.donut circle.seg-arc').count(), 3);
  await page.click('[data-alloc="industry"]');
  assert.ok((await page.textContent('#allocBody .legend')).includes('半導體業'));
  assert.equal(await page.locator('#holdingsWrap .tag').count(), 3);
  await page.click('#holdingsWrap tr[data-key="TW:2330"] td:nth-child(4)');
  await page.waitForFunction(() => document.getElementById('card-TW-2330').open);
  const card = await page.textContent('#card-TW-2330');
  for (const s of ['行情', '價位刻度', '籌碼', '基本面', '多空觀點', '今天該注意', '建議與理由', '觸發條件', '停損價', '資料來源', '20 日均量']) {
    assert.ok(card.includes(s), `詳細卡缺「${s}」`);
  }
  assert.ok(await page.locator('#card-TW-2330 a[href="https://tw.stock.yahoo.com/quote/2330"][rel="noopener noreferrer"][target="_blank"]').count());

  await page.evaluate(() => document.querySelectorAll('details.stock-card').forEach((d) => { d.open = true; }));
  await page.waitForTimeout(150);
  await noHScroll(page, `${name} 三筆交易、詳細卡全開`);
  await scaleLabelsDontOverlap(page, name);
  await page.screenshot({ path: path.join(SHOTS, `${name}-2-holdings.png`), fullPage: true });

  // AI 分析（假 SDK）
  assert.match(await page.textContent('#aiEstimate'), /預估每次約 NT\$/);
  await page.fill('#aiKey', 'sk-ant-test-0000');
  await page.click('#aiRun');
  await page.waitForSelector('#card-TW-2330 .ai-box', { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('aiStatus').textContent.includes('分析完成'));
  const calls = await page.evaluate(() => globalThis.__aiCalls);
  assert.equal(calls.length, 1, '只呼叫一次 API');
  const { body, apiKey, browser: allowBrowser } = calls[0];
  assert.equal(apiKey, 'sk-ant-test-0000');
  assert.equal(allowBrowser, true);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, 16000);
  assert.deepEqual(body.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  for (const k of ['thinking', 'temperature', 'budget_tokens']) assert.ok(!(k in body), `不應送出 ${k}`);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  const sent = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf('{')));
  assert.equal(sent.holdings.length, 3);
  assert.equal(sent.newsAvailable, true);
  assert.ok(sent.holdings[0].news.some((n) => n.title.includes('法說會前夕')), '個股新聞有送給 AI');
  assert.ok(!JSON.stringify(sent).includes('javascript:'), '非 http 連結的新聞要丟掉');

  const aiHead = await page.textContent('#card-TW-2330 .ai-box .ai-head');
  assert.ok(aiHead.includes(`AI 分析・${todayTaipei()}・Opus 5.5`), `AI 標題：${aiHead}`);
  assert.ok((await page.textContent('#card-TW-2330 .bb-bull')).includes('9 月營收年增 11.37%'));
  assert.ok((await page.textContent('#adviceBody')).includes('新資金優先買半導體以外的產業'));
  assert.ok((await page.textContent('#aiResultMeta')).includes('實際花費'));
  assert.ok((await page.textContent('#card-TW-2330')).includes('<img src=x'), 'AI 文字原樣顯示');
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'AI／新聞內容不能被當成 HTML 執行');
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  assert.equal(await page.locator('#card-TW-2330 .news-list a').count(), 2, '只顯示 http(s) 新聞連結');

  await page.evaluate(() => document.querySelectorAll('details.stock-card').forEach((d) => { d.open = true; }));
  await page.waitForTimeout(150);
  await noHScroll(page, `${name} AI 結果`);
  await scaleLabelsDontOverlap(page, `${name} AI 結果`);
  await page.screenshot({ path: path.join(SHOTS, `${name}-3-ai.png`), fullPage: true });

  // 深色模式
  await page.click('[data-theme-set="dark"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.notEqual(bg, 'rgb(244, 245, 247)', '深色模式背景要換');
  await page.screenshot({ path: path.join(SHOTS, `${name}-4-dark.png`), fullPage: true });

  return { context, page, errors, blocked };
}

async function desktopExtras(page) {
  // 主題記住
  await page.reload();
  await page.waitForSelector('#holdingsWrap tr[data-key="US:AAPL"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark', '主題要記住');
  assert.equal(await page.locator('#holdingsWrap tbody tr').count(), 3, '重新整理後交易還在');
  assert.ok(await page.locator('#card-TW-2330 .ai-box').count(), '重新整理後 AI 結果還在');
  await page.click('[data-theme-set="light"]');

  // 排序
  await page.click('[data-sort="code"]');
  const codes = await page.$$eval('#holdingsWrap tbody tr', (trs) => trs.map((t) => t.dataset.key));
  assert.deepEqual(codes, ['TW:0050', 'TW:2330', 'US:AAPL']);

  // Haiku：不加 betas／fallbacks
  await page.selectOption('#aiModel', 'claude-haiku-5-5');
  await page.click('#aiRun');
  await page.waitForFunction(() => (globalThis.__aiCalls ?? []).length === 1 && document.getElementById('aiStatus').textContent.includes('分析完成'));
  const haiku = (await page.evaluate(() => globalThis.__aiCalls))[0].body;
  assert.equal(haiku.model, 'claude-haiku-5-5');
  assert.ok(!('betas' in haiku) && !('fallbacks' in haiku), 'Haiku 不送 betas／fallbacks');
  assert.ok((await page.textContent('#card-TW-2330 .ai-head')).includes('Haiku 5.5'));

  // 設定：改折數
  await page.click('#openSettings');
  await page.fill('#sTwDiscount', '2.8');
  await page.fill('#sStopPct', '8');
  await page.click('#settingsSave');
  await page.waitForFunction(() => !document.getElementById('settingsDialog').open);
  assert.ok((await page.textContent('#brokerHint')).includes('2.8 折'));
  await page.check('input[name="market"][value="TW"]');
  await page.fill('#fShares', '1000');
  await page.fill('#fPrice', '580');
  assert.ok((await page.textContent('#feePreview')).includes('手續費NT$231'), '2.8 折：580,000 × 0.1425% × 0.28 = 231');
  assert.ok((await page.textContent('#card-TW-2330')).includes('成本 × (1 − 8%)'), '預設停損 % 套用到詳細卡');

  // 賣超過持股 → 擋下
  await page.fill('#fCode', '2330');
  await page.check('input[name="side"][value="sell"]');
  await page.fill('#fShares', '5000');
  await page.click('#submitBtn');
  assert.ok((await page.textContent('#formMsg')).includes('目前只持有'));
  await page.check('input[name="side"][value="buy"]');

  // 未知代號（分桶存在但沒有這檔）→ 警告 → 手動價格
  await page.fill('#fCode', '2399');
  await page.press('#fCode', 'Tab');
  await page.waitForFunction(() => document.getElementById('codeInfo').textContent.includes('找不到'));
  await page.fill('#fShares', '100');
  await page.fill('#fPrice', '50');
  await page.click('#submitBtn');
  await page.waitForSelector('#holdingsWrap input[data-manual="TW:2399"]');
  await page.fill('#holdingsWrap input[data-manual="TW:2399"]', '55');
  await page.press('#holdingsWrap input[data-manual="TW:2399"]', 'Enter');
  await page.waitForSelector('#holdingsWrap button[data-clear-manual="TW:2399"]');

  // 自訂停損價
  const stopInput = '#card-TW-2330 input[data-stop="TW:2330"]';
  await page.fill(stopInput, '900');
  await page.click('#card-TW-2330 [data-stop-save="TW:2330"]');
  await page.waitForFunction(() => document.getElementById('card-TW-2330').textContent.includes('（自訂）'));

  // CSV
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsv')]);
  const csv = await readFile(await csvDl.path(), 'utf8');
  assert.ok(csv.startsWith('﻿日期,市場,代號'), 'CSV 要有 UTF-8 BOM 與表頭');
  assert.equal(csv.trim().split('\r\n').length, 5, 'CSV：表頭 + 4 筆');

  // 匯出 → 刪除 → 匯入
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
  const backupPath = await jsonDl.path();
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(backup.transactions.length, 4);
  assert.ok(!JSON.stringify(backup).includes('sk-ant-'), '備份不含金鑰');
  await page.click('[data-del]');
  await page.waitForFunction(() => document.querySelectorAll('.log-table tbody tr').length === 3);
  await page.setInputFiles('#importFile', backupPath);
  await page.waitForFunction(() => document.querySelectorAll('.log-table tbody tr').length === 4);

  // 匯入格式錯誤的檔案 → 拒絕
  const alerts = [];
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.setInputFiles('#importFile', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"transactions":[{"market":"XX"}]}') });
  await page.waitForFunction(() => true);
  await page.waitForTimeout(200);
  assert.ok(alerts.some((m) => m.includes('匯入失敗')), `錯誤檔案要被拒絕：${alerts}`);
  assert.equal(await page.locator('.log-table tbody tr').count(), 4);

  // 清除金鑰
  await page.click('#aiKeyClear');
  assert.equal(await page.inputValue('#aiKey'), '');
  assert.equal(await page.evaluate(() => localStorage.getItem('pa:v1:aiKey')), null);
}

async function dataFailureFlow(browser, baseURL) {
  const { context, page, errors, blocked } = await newPage(browser, { width: 390, height: 844 }, {
    allow: [/Failed to load resource/],
    routes: (ctx) => ctx.route('**/data/latest/**', (route) => route.fulfill({ status: 404, body: 'missing' })),
  });
  await page.goto(baseURL);
  await page.waitForFunction(() => document.getElementById('banner').textContent.includes('無法載入每日行情資料'));
  await page.fill('#fCode', '2330');
  await page.fill('#fShares', '1000');
  await page.fill('#fPrice', '580');
  await page.click('#submitBtn');
  await page.waitForSelector('#holdingsWrap input[data-manual="TW:2330"]');
  await page.fill('#holdingsWrap input[data-manual="TW:2330"]', '600');
  await page.press('#holdingsWrap input[data-manual="TW:2330"]', 'Enter');
  await page.waitForFunction(() => document.querySelector('[data-stat="marketValue"] .stat-value').textContent.includes('600,000'));
  await noHScroll(page, '資料載入失敗');
  await page.screenshot({ path: path.join(SHOTS, 'phone-5-data-failure.png'), fullPage: true });
  await context.close();
  return { errors, blocked };
}

// ---------- 執行 ----------

await mkdir(SHOTS, { recursive: true });
const server = await startServer();
const baseURL = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const problems = [];
const shots = [];
try {
  console.log(`資料：${path.relative(ROOT, DATA) || DATA}`);
  for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
    const run = await mainFlow(browser, baseURL, name, viewport);
    if (name === 'desktop') {
      await run.page.evaluate(() => { globalThis.__aiCalls = []; });
      await desktopExtras(run.page);
      await noHScroll(run.page, 'desktop 額外流程');
      await run.page.screenshot({ path: path.join(SHOTS, 'desktop-5-extras.png'), fullPage: true });
    } else {
      await run.page.click('#openSettings');
      await run.page.screenshot({ path: path.join(SHOTS, 'phone-5-settings.png') });
    }
    problems.push(...run.errors.map((e) => `${name}: ${e}`));
    const unexpected = run.blocked.filter((u) => !/^https:\/\/(api\.codetabs\.com|api\.allorigins\.win|api\.rss2json\.com)\//.test(u));
    problems.push(...unexpected.map((u) => `${name}: 未預期的外部請求 ${u}`));
    await run.context.close();
    console.log(`✓ ${name}（${viewport.width}×${viewport.height}）`);
  }
  const fail = await dataFailureFlow(browser, baseURL);
  problems.push(...fail.errors.map((e) => `資料失敗情境: ${e}`));
  console.log('✓ 資料載入失敗情境');
  assert.deepEqual(problems, [], `主控台錯誤或外部請求：\n${problems.join('\n')}`);
  for (const f of ['phone-1-empty', 'phone-2-holdings', 'phone-3-ai', 'phone-4-dark', 'phone-5-settings', 'phone-5-data-failure',
    'desktop-1-empty', 'desktop-2-holdings', 'desktop-3-ai', 'desktop-4-dark', 'desktop-5-extras']) shots.push(path.join(SHOTS, `${f}.png`));
  console.log(`全部通過。截圖：\n${shots.join('\n')}`);
} catch (err) {
  console.error('✗ 失敗：', err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
