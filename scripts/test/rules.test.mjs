import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, levels, analyzeHolding, analyzePortfolio, industryPeFor } from '../../assets/rules.js';
import { valueHolding, summarize } from '../../assets/portfolio.js';

const IND_PE = { 'TW:半導體業': 22.4 };
const TODAY = '2026-10-10';

// 中性的台股資料：預設什麼條件都不符合 → 續抱
function rec({ hist = {}, chips = {}, fund = {}, ...rest } = {}) {
  return {
    code: '2330', name: '台積電', market: 'TW', type: 'stock', industry: '半導體業',
    close: 580, change: 2, changePct: 0.35, volume: 20000000,
    hist: { low20: 550, high20: 604, ma60: 530, hi52: 700, lo52: 450, avgVol20: 20000000, ...hist },
    chips: { foreignStreak: 1, trustStreak: 0, foreign5: 100000, margin: 10000, marginChg: -10, ...chips },
    fund: { revYm: '2026-09', yoy: 5, pe: 15, ...fund },
    ...rest,
  };
}
const row = (o = {}) => ({ market: 'TW', code: '2330', name: '台積電', shares: 2000, avgCost: 520, price: 580,
  netPLPct: 11.5, valueTWD: 1160000, fx: 1, ...o });
const ctx = (o = {}) => ({ industryPe: IND_PE, weight: 0.2, today: TODAY, ...o });

test('RULES exposes the DESIGN thresholds', () => {
  assert.equal(RULES.stopPct, 0.10);
  assert.equal(RULES.stopWatch, 0.03);
  assert.deepEqual(RULES.takeProfit, { minReturnPct: 20, peMultiple: 1.5, minPos52: 0.85 });
  assert.equal(RULES.reduce.maxWeight, 0.40);
  assert.equal(RULES.reduce.foreignSellDays, 3);
  assert.deepEqual([RULES.add.minReturnPct, RULES.add.maxReturnPct, RULES.add.minRevenueYoy], [-5, 10, 20]);
  assert.deepEqual(RULES.portfolio, { minHoldings: 3, maxWeight: 0.40, maxIndustryWeight: 0.60, minCash: 0.10 });
});

test('levels: support, resistance, stop, 52-week position', () => {
  // 季線 550 低於現價 560 且高於 20 日低點 540 → 支撐取季線
  const a = levels({ avgCost: 500 }, { close: 560, hist: { low20: 540, high20: 600, ma60: 550, hi52: 650, lo52: 400 } });
  assert.deepEqual(a, { cost: 500, price: 560, support: 550, resistance: 600, stop: 533.5, stopSource: 'support',
    stopPct: 0.1, hi52: 650, lo52: 400, pos52: 0.64, ma60: 550, supportBroken: false });
  // 現價距 20 日高點 < 1% → 壓力改用 52 週高點
  const b = levels({ avgCost: 500 }, { close: 597, hist: { low20: 540, high20: 600, ma60: 550, hi52: 650, lo52: 400 } });
  assert.equal(b.resistance, 650);
  // 季線高於現價 → 支撐用 20 日低點；成本停損較高 → 取成本
  const c = levels({ avgCost: 640, price: 560 }, { close: 999, hist: { low20: 540, high20: 600, ma60: 580 } });
  assert.equal(c.price, 560);
  assert.equal(c.support, 540);
  assert.equal(c.stop, 576);
  assert.equal(c.stopSource, 'cost');
  assert.equal(c.pos52, null);
  // 自訂停損優先；可調停損%
  assert.equal(levels({ avgCost: 500 }, { close: 560, hist: { low20: 540 } }, { userStop: 520 }).stop, 520);
  assert.equal(levels({ avgCost: 500 }, { close: 560, hist: {} }, { stopPct: 0.2 }).stop, 400);
  // 完全沒有歷史資料
  const d = levels({ avgCost: 100 }, null);
  assert.deepEqual([d.price, d.support, d.resistance, d.stop], [null, null, null, 90]);
});

test('industryPeFor looks up market:industry keys', () => {
  assert.equal(industryPeFor(IND_PE, 'TW', '半導體業'), 22.4);
  assert.equal(industryPeFor(IND_PE, 'TW', '航運業'), null);
  assert.equal(industryPeFor(18, 'TW', 'x'), 18);
  assert.equal(industryPeFor(undefined, 'TW', '半導體業'), null);
});

test('續抱 with concrete triggers', () => {
  const r = analyzeHolding(row(), rec(), ctx());
  assert.equal(r.action, '續抱');
  assert.deepEqual(r.triggers, ['收盤跌破 550 → 減碼', '收盤跌破 533.5 → 停損', '站穩 604 以上 → 續抱']);
  assert.match(r.reasons[0], /沒有觸發/);
  assert.deepEqual([r.levels.support, r.levels.resistance, r.levels.stop], [550, 604, 533.5]);
});

test('停損: price below stop, other met conditions listed in reasons', () => {
  const r = analyzeHolding(row({ avgCost: 600, price: 530, netPLPct: -11.7 }),
    rec({ close: 530, hist: { low20: 500, high20: 560, ma60: 590, lo52: 480 } }), ctx({ weight: 0.5 }));
  assert.equal(r.action, '停損');
  assert.equal(r.levels.stop, 540);
  assert.equal(r.reasons[0], '收盤 530 已跌破停損價 540（成本 600 下跌 10%）');
  assert.ok(r.reasons.some((s) => s.startsWith('同時符合「減碼」條件：單檔占總資產 50%')));
  assert.equal(r.triggers[0], '收盤仍在 540 以下 → 停損出場');
  assert.ok(r.watch.includes('已跌破停損價 540'));
});

test('停損觀察: within 3% above the stop', () => {
  const r = analyzeHolding(row({ avgCost: 600, price: 555, netPLPct: -7.5 }),
    rec({ close: 555, hist: { low20: 520, high20: 600, ma60: 580 } }), ctx());
  assert.equal(r.action, '停損觀察');
  assert.equal(r.reasons[0], '收盤 555 距停損價 540 只剩 2.7%（成本 600 下跌 10%）');
  assert.deepEqual(r.triggers, ['收盤跌破 540 → 停損', '站穩 600 以上 → 續抱']);
  assert.ok(r.watch.includes('距停損價 540 只剩 2.7%'));
  // 用自訂停損
  const u = analyzeHolding(row({ price: 580 }), rec(), ctx({ userStop: 570 }));
  assert.equal(u.action, '停損觀察');
  assert.match(u.reasons[0], /自訂停損/);
});

test('分批停利: return ≥ 20% and 52-week position ≥ 85%', () => {
  const r = analyzeHolding(row({ avgCost: 400, price: 500, netPLPct: 25, shares: 1000 }),
    rec({ close: 500, hist: { low20: 470, high20: 510, ma60: 450, hi52: 520, lo52: 300 }, fund: { pe: 18 } }), ctx());
  assert.equal(r.action, '分批停利');
  assert.equal(r.reasons[0], '報酬率 25% 已達 20% 以上，且股價在 52 週區間的 91% 高檔');
  assert.deepEqual(r.triggers, ['先賣出約三分之一（約 333 股）鎖住獲利', '收盤跌破 470 → 再賣一批',
    '站穩 510 以上 → 剩餘部位續抱', '收盤跌破 455.9 → 剩餘部位停損']);
});

test('分批停利: return ≥ 20% and P/E above 1.5× industry median', () => {
  const r = analyzeHolding(row({ avgCost: 400, price: 500, netPLPct: 25 }),
    rec({ close: 500, hist: { low20: 470, high20: 530, ma60: 450, hi52: 700, lo52: 300 }, fund: { pe: 40 } }), ctx());
  assert.equal(r.action, '分批停利');
  assert.match(r.reasons[0], /本益比 40 高於同業中位數 22.4 的 1.5 倍/);
});

test('missing data never counts as meeting a condition', () => {
  // 報酬 25% 但沒有本益比、也沒有 52 週高低點 → 不能判定分批停利
  const r = analyzeHolding(row({ avgCost: 400, price: 500, netPLPct: 25 }),
    rec({ close: 500, hist: { low20: 480, high20: 520, ma60: 450, hi52: null, lo52: null }, fund: { pe: null } }), ctx());
  assert.equal(r.action, '續抱');
  assert.equal(r.checks['分批停利'], null);
  assert.ok(r.reasons.some((s) => s.includes('缺少') && s.includes('52 週高低點') && s.includes('本益比')));
  // 籌碼轉弱但沒有營收資料 → 不減碼
  const c = analyzeHolding(row(), rec({ chips: { foreignStreak: -4, marginChg: 300 }, fund: { yoy: null } }), ctx());
  assert.equal(c.action, '續抱');
  assert.ok(c.reasons.some((s) => s.includes('月營收年增率')));
  // 沒有現價
  const p = analyzeHolding(row({ price: null, netPLPct: null }), rec({ close: null }), ctx());
  assert.equal(p.action, '續抱');
  assert.match(p.reasons[0], /沒有收盤價/);
  assert.deepEqual(p.triggers, []);
});

test('減碼: single holding weight above 40%', () => {
  const r = analyzeHolding(row(), rec(), ctx({ weight: 0.5 }));
  assert.equal(r.action, '減碼');
  assert.equal(r.reasons[0], '單檔占總資產 50%，超過 40%');
  // 總資產 1160000 / 0.5 = 2320000；需賣 1160000 − 928000 = 232000 → 400 股
  assert.equal(r.triggers[0], '賣出約 400 股，讓占比降到 40% 以下');
  assert.ok(r.triggers.includes('收盤跌破 550 → 再減碼'));
  assert.ok(r.triggers.includes('站穩 604 以上 → 續抱'));
});

test('減碼: foreign selling streak + margin up + revenue YoY negative', () => {
  const r = analyzeHolding(row(), rec({ chips: { foreignStreak: -3, marginChg: 200 }, fund: { yoy: -5 } }), ctx());
  assert.equal(r.action, '減碼');
  assert.equal(r.reasons[0], '籌碼轉弱：外資連賣 3 天、融資增加 200 張，且月營收年減 5%');
});

test('加碼: all five conditions met', () => {
  const good = { hist: { ma60: 560 }, chips: { foreign5: 1000000 }, fund: { yoy: 25, pe: 15 } };
  const r = analyzeHolding(row({ avgCost: 560, netPLPct: 3.5 }), rec(good), ctx());
  assert.equal(r.action, '加碼');
  assert.equal(r.reasons[0],
    '報酬率 3.5% 在 -5%～+10% 之間、站上季線 560、月營收年增 25%、外資 5 日買超 1,000 張、本益比 15 不高於同業中位數 22.4');
  assert.deepEqual(r.triggers, ['回測 560 不破 → 分批加碼', '收盤跌破 543.2 → 停損', '帶量站上 604 → 可再加碼']);
  // 少一個條件（本益比缺）→ 續抱
  const noPe = analyzeHolding(row({ avgCost: 560, netPLPct: 3.5 }), rec({ ...good, fund: { yoy: 25, pe: null } }), ctx());
  assert.equal(noPe.action, '續抱');
  // 同業本益比缺 → 續抱
  const noInd = analyzeHolding(row({ avgCost: 560, netPLPct: 3.5 }), rec(good), ctx({ industryPe: {} }));
  assert.equal(noInd.action, '續抱');
  assert.ok(noInd.reasons.some((s) => s.includes('同業本益比')));
  // 報酬率超出 −5%～+10% → 續抱
  assert.equal(analyzeHolding(row({ avgCost: 500, netPLPct: 16 }), rec(good), ctx()).action, '續抱');
});

test('US holdings: chips ignored, missing TW-only data explained', () => {
  const usRec = { code: 'AAPL', name: 'Apple Inc.', market: 'US', type: 'stock', sector: 'Technology', close: 580,
    hist: { low20: 550, high20: 604, ma60: 560, hi52: 700, lo52: 450 }, chips: { foreign5: 1e9, foreignStreak: -9, marginChg: 9 } };
  const r = analyzeHolding(row({ market: 'US', code: 'AAPL', name: 'Apple Inc.', avgCost: 560, netPLPct: 3.5 }), usRec, ctx({ market: 'US' }));
  assert.equal(r.action, '續抱');
  assert.ok(r.reasons.some((s) => s.startsWith('美股沒有月營收')));
  assert.ok(!r.bear.some((s) => s.includes('外資')));
});

test('TW ETF: no revenue/PE is explained once, no revenue or report reminders', () => {
  const etf = rec({ code: '0050', name: '元大台灣50', type: 'etf', industry: undefined, fund: { revYm: null, yoy: null, pe: null } });
  const r = analyzeHolding(row({ code: '0050', name: '元大台灣50' }), etf, ctx({ today: '2026-11-05' }));
  assert.ok(r.reasons.includes('ETF 沒有月營收與本益比資料，加碼與籌碼轉弱條件不列入判斷'));
  assert.ok(!r.reasons.some((s) => s.includes('月營收年增率')));
  assert.ok(!r.watch.some((s) => s.includes('營收') || s.includes('財報')));
});

test('收盤跌破前 20 日低點：支撐停損價照常觸發', () => {
  // low20 不含當天：上一盤顯示「收盤跌破 2,311.95 → 停損」，今天收 2290 就該停損
  const base = { close: 2455, hist: { low20: 2383.45, high20: 2455, ma60: 2333.71, hi52: 2904.32, lo52: 2169.84 } };
  const before = analyzeHolding(row({ avgCost: 2002.85, price: 2455, netPLPct: 22 }), rec(base), ctx());
  assert.ok(before.triggers.includes('收盤跌破 2,311.95 → 停損'));
  assert.equal(before.levels.supportBroken, false);
  const broke = { close: 2290, hist: { ...base.hist } };
  const r = analyzeHolding(row({ avgCost: 2002.85, price: 2290, netPLPct: 14 }), rec(broke), ctx());
  assert.equal(r.levels.supportBroken, true);
  assert.equal(r.levels.stop, 2311.95);
  assert.equal(r.action, '停損');
  assert.ok(r.bear.includes('收盤 2,290 跌破近 20 日低點 2,383.45'));
  assert.equal(r.watch[0], '已跌破停損價 2,311.95');
  // 跌破支撐但還在停損價之上 → 停損觀察
  const near = analyzeHolding(row({ avgCost: 2002.85, price: 2350, netPLPct: 17 }),
    rec({ close: 2350, hist: { ...base.hist } }), ctx());
  assert.equal(near.levels.supportBroken, true);
  assert.equal(near.action, '停損觀察');
  assert.ok(near.triggers.includes('收盤跌破 2,311.95 → 停損'));
  // 收盤剛好等於前 20 日低點不算跌破
  const touch = analyzeHolding(row({ avgCost: 2002.85, price: 2383.45, netPLPct: 19 }),
    rec({ close: 2383.45, hist: { ...base.hist } }), ctx());
  assert.equal(touch.levels.supportBroken, false);
});

test('priority order: 停損 beats 分批停利 / 減碼', () => {
  const r = analyzeHolding(row({ avgCost: 400, price: 500, netPLPct: 25 }),
    rec({ close: 500, hist: { hi52: 520, lo52: 300 } }), ctx({ userStop: 510, weight: 0.6 }));
  assert.equal(r.action, '停損');
  assert.ok(r.reasons.some((s) => s.startsWith('同時符合「分批停利」')));
  assert.ok(r.reasons.some((s) => s.startsWith('同時符合「減碼」')));
});

test('bull / bear signals: max 3 each, in importance order', () => {
  const strong = analyzeHolding(row({ price: 700 }), rec({
    close: 700, changePct: 3, volume: 60000000,
    hist: { hi52: 700, ma60: 600 }, chips: { foreignStreak: 4, trustStreak: 3, margin: 2200, marginChg: 200 }, fund: { yoy: 25, pe: 15 },
  }), ctx());
  assert.deepEqual(strong.bull, ['9 月營收年增 25%', '收盤 700 創 52 週新高', '外資連買 4 天']);
  assert.deepEqual(strong.bear, ['融資大增 200 張（+10%），籌碼變亂']);

  const weak = analyzeHolding(row({ price: 410 }), rec({
    close: 410, hist: { lo52: 400, ma60: 500, low20: 405 }, chips: { foreignStreak: -5, trustStreak: -3 }, fund: { yoy: -12 },
  }), ctx());
  assert.deepEqual(weak.bear, ['9 月營收年減 12%', '收盤 410 接近 52 週低點 400', '外資連賣 5 天']);
  assert.ok(weak.bull.length <= 3);

  const pe = analyzeHolding(row(), rec({ fund: { pe: 40 } }), ctx());
  assert.ok(pe.bear.includes('本益比 40 是同業中位數 22.4 的 1.8 倍'));
});

test('watch: volume spike, revenue date, report deadline, events, holidays', () => {
  const r = analyzeHolding(row(), rec({ volume: 60000000 }), ctx({
    today: '2026-11-05',
    events: [
      { date: '2026-11-12', title: '台積電法說會' },
      { date: '2026-11-20', title: '聯準會利率決議（美股）' },
      { date: '2026-12-31', title: '太遠的事件' },
    ],
    holidayNote: '11/11 測試休市',
  }));
  assert.deepEqual(r.watch, [
    '成交量是 20 日均量的 3 倍，有事情發生，去找新聞',
    '10 月營收在 11/10 前公布',
    '第三季財報公布期限 11/14（還有 9 天）',
    '11/12 台積電法說會',
    '11/11 測試休市',
  ]);
  // 營收已公布、或事件已經提到營收 → 不重複提醒
  const done = analyzeHolding(row(), rec({ fund: { revYm: '2026-10' } }), ctx({ today: '2026-11-05' }));
  assert.ok(!done.watch.some((s) => s.includes('月營收')));
  const ev = analyzeHolding(row(), rec(), ctx({ today: '2026-11-05', events: [{ date: '2026-11-10', title: '10 月營收公布期限（台股）' }] }));
  assert.deepEqual(ev.watch.filter((s) => s.includes('營收')), ['11/10 10 月營收公布期限（台股）']);
  // 休市清單
  const hol = analyzeHolding(row(), rec(), ctx({ today: '2026-10-05', upcomingHolidays: [{ date: '2026-10-09', name: '國慶日' }] }));
  assert.ok(hol.watch.includes('10/9（國慶日）休市'));
  // 接近壓力
  const res = analyzeHolding(row({ price: 595 }), rec({ close: 595, hist: { high20: 610 } }), ctx());
  assert.ok(res.watch.includes('距壓力 610 只剩 2.5%，看能不能帶量突破'));
});

test('watch: no duplicates between meta.events, built-in deadlines and holidays; early close is not 休市', () => {
  // meta.events 已有財報期限 → 不再加內建的那一句
  const tw = analyzeHolding(row(), rec(), ctx({ today: '2026-11-05', events: [
    { date: '2026-11-10', title: '10 月營收公布期限（台股）' },
    { date: '2026-11-14', title: '第 3 季財報公布期限（台股）' },
  ] }));
  assert.deepEqual(tw.watch, ['11/10 10 月營收公布期限（台股）', '11/14 第 3 季財報公布期限（台股）']);
  // 美股：events 已列的休市日不再從 upcomingHolidays 重複；提早收盤不寫成休市
  const usRec = { code: 'AAPL', name: 'Apple Inc.', market: 'US', type: 'stock', close: 245, hist: { low20: 230, high20: 260 } };
  const usRow = row({ market: 'US', code: 'AAPL', name: 'Apple Inc.', price: 245, avgCost: 200 });
  const holidays = [{ date: '2026-11-26', name: '感恩節' }, { date: '2026-11-27', name: '感恩節翌日（提早收盤）', earlyClose: true }];
  const events = [{ date: '2026-11-26', title: '感恩節休市（美股）' }, { date: '2026-11-27', title: '感恩節翌日（提早收盤）（美股）' }];
  const us = analyzeHolding(usRow, usRec, ctx({ market: 'US', today: '2026-11-21', events, upcomingHolidays: holidays, holidayNote: '' }));
  assert.deepEqual(us.watch, ['11/26 感恩節休市（美股）', '11/27 感恩節翌日（提早收盤）（美股）']);
  const noEv = analyzeHolding(usRow, usRec, ctx({ market: 'US', today: '2026-11-21', upcomingHolidays: holidays }));
  assert.deepEqual(noEv.watch, ['11/26（感恩節）休市', '11/27 感恩節翌日（提早收盤）']);
  assert.ok(!noEv.watch.some((s) => s.includes('提早收盤）休市')));
  // holidayNote 已涵蓋的休市事件不重複
  const note = analyzeHolding(row(), rec({ fund: { revYm: '2026-09' } }), ctx({ today: '2026-10-08', holidayNote: '10/09–10/11 國慶連假休市',
    events: [{ date: '2026-10-09', title: '國慶日補假休市（台股）' }, { date: '2026-10-20', title: '某公司法說會' }] }));
  assert.deepEqual(note.watch, ['10/20 某公司法說會', '10/09–10/11 國慶連假休市']);
  // holidayNote 同時有休市與提早收盤（以「；」分開）：兩者都不重複列
  const both = analyzeHolding(usRow, usRec, ctx({ market: 'US', today: '2026-11-25', events, upcomingHolidays: holidays,
    holidayNote: '11/26 感恩節休市；11/27 感恩節翌日提早收盤' }));
  assert.deepEqual(both.watch, ['11/26 感恩節休市；11/27 感恩節翌日提早收盤']);
});

function twoHoldingPortfolio(cashTWD = 0) {
  const a = valueHolding({ market: 'TW', code: '2330', shares: 1000, costTotal: 500000, avgCost: 500, realized: 0 },
    { code: '2330', name: '台積電', industry: '半導體業', type: 'stock', close: 600 }, { date: TODAY });
  const b = valueHolding({ market: 'TW', code: '2303', shares: 8000, costTotal: 400000, avgCost: 50, realized: 0 },
    { code: '2303', name: '聯電', industry: '半導體業', type: 'stock', close: 50 }, { date: TODAY });
  const summary = summarize([a, b], { cashTWD });
  return { rows: summary.rows, summary };
}

test('portfolio risks: 2 holdings, 100% invested, one industry', () => {
  const { rows, summary } = twoHoldingPortfolio(0);
  const { risks, advice } = analyzePortfolio(rows, summary, {});
  assert.deepEqual(risks, [
    '只持有 2 檔股票，少於 3 檔，單一公司出事對整體影響很大',
    '台積電（2330）占總資產 60%，超過 40%',
    '半導體業占總資產 100%，超過 60%，同產業的股票常常一起漲跌',
    '現金比例 0%（全倉），遇到急跌沒有資金可以應變或加碼',
  ]);
  assert.ok(advice.includes('把台積電（2330）降到 40% 以下：約需賣出 334 股（以現價 600 計），或之後的新資金先買其他標的'));
  assert.ok(advice.includes('保留至少 10% 現金：以目前總資產 NT$1,000,000 計，約 NT$100,000'));
  assert.ok(advice.includes('新資金優先放在半導體業以外的產業，降低產業集中度'));
});

test('portfolio: low cash, stop-loss summary, and no-risk case', () => {
  const { rows, summary } = twoHoldingPortfolio(52632); // 52632 / 1052632 ≈ 5%
  const analyses = { 'TW:2330': { action: '停損' }, 'TW:2303': { action: '分批停利' } };
  const { risks, advice } = analyzePortfolio(rows, summary, { analyses });
  assert.ok(risks.includes('現金比例 5%，低於 10%'));
  assert.ok(advice.includes('把現金提高到 10%：還差約 NT$52,632'));
  assert.ok(advice.includes('台積電（2330）已跌破停損價，依紀律處理'));
  assert.ok(advice.includes('聯電（2303）符合分批停利條件，可先賣出一部分鎖住獲利'));

  // 有現金時，占股票市值高但占總資產不高 → 不觸發（規則以總資產計，和明細表、圓環圖一致）
  const probe = summarize([
    valueHolding({ market: 'TW', code: '2330', shares: 1000, costTotal: 500000, avgCost: 500, realized: 0 },
      { code: '2330', name: '台積電', industry: '半導體業', type: 'stock', close: 500 }, { date: TODAY }),
    valueHolding({ market: 'TW', code: '2317', shares: 1000, costTotal: 200000, avgCost: 200, realized: 0 },
      { code: '2317', name: '鴻海', industry: '其他電子業', type: 'stock', close: 200 }, { date: TODAY }),
    valueHolding({ market: 'TW', code: '2454', shares: 100, costTotal: 100000, avgCost: 1000, realized: 0 },
      { code: '2454', name: '聯發科', industry: '半導體業', type: 'stock', close: 1000 }, { date: TODAY }),
  ], { cashTWD: 500000 });
  assert.equal(probe.weights['TW:2330'], 0.625);
  assert.ok(Math.abs(probe.assetWeights['TW:2330'] - 500000 / 1300000) < 1e-9);
  assert.deepEqual(analyzePortfolio(probe.rows, probe, {}).risks, []);

  const inds = ['半導體業', '金融保險業', '航運業', '食品工業'];
  const rows4 = inds.map((industry, i) => valueHolding(
    { market: 'TW', code: String(1101 + i), shares: 1000, costTotal: 100000, avgCost: 100, realized: 0 },
    { code: String(1101 + i), name: `股票${i}`, industry, type: 'stock', close: 100 }, { date: TODAY }));
  const s4 = summarize(rows4, { cashTWD: 100000 });
  const ok = analyzePortfolio(s4.rows, s4, {});
  assert.deepEqual(ok.risks, []);
  assert.deepEqual(ok.advice, ['組合目前沒有觸發集中度與現金規則（單檔與產業占比以含現金的總資產計），維持定期檢視即可']);

  assert.deepEqual(analyzePortfolio([], {}, {}).risks, []);
});

test('portfolio: missing price and fx are reported', () => {
  const a = valueHolding({ market: 'TW', code: '9999', shares: 1000, costTotal: 1000, avgCost: 1, realized: 0 }, null, { date: TODAY });
  const u = valueHolding({ market: 'US', code: 'AAPL', shares: 1, costTotal: 200, avgCost: 200, realized: 0 }, { close: 250 }, { date: TODAY });
  const s = summarize([a, u], { cashTWD: 1000 });
  const { risks } = analyzePortfolio(s.rows, s, {});
  assert.ok(risks.some((x) => x.startsWith('1 檔沒有收盤價（9999）')));
  assert.ok(risks.includes('沒有美元匯率，美股與美元現金沒有計入總覽'));
});
