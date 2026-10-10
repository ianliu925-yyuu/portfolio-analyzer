// 手續費與交易稅（純函式）＋券商預設表。
// 台股金額以新台幣計，美股金額以美元計。資料來源：docs/research/tw_fees.json、us_fees.json。

export const FEES_AS_OF = '2026-10-10';

export const TW_FEE_RATE = 0.001425;
export const TW_TAX_RATES = { stock: 0.003, etf: 0.001, bond_etf: 0.001 };
// 被動式債券 ETF 證交稅停徵到這天（含）；延長到 2036 的草案尚未三讀，之後先以 0.1% 估。
export const BOND_ETF_EXEMPT_UNTIL = '2026-12-31';

// 依交易日（YYYY-MM-DD）由新到舊排列，取第一個 from <= 交易日 的費率。
export const SEC_FEE_SCHEDULE = [
  { from: '2026-04-02', rate: 0.0000206 },
  { from: '2025-05-13', rate: 0 },
  { from: '0000-01-01', rate: 0.0000278 },
];

export const TAF_SCHEDULE = [
  { from: '2027-01-01', perShare: 0.000195, max: 9.79 },
  { from: '2026-10-01', perShare: 0, max: 0 }, // FINRA 暫停收取（2026-10-01～2026-12-31）
  { from: '2026-01-01', perShare: 0.000195, max: 9.79 },
  { from: '0000-01-01', perShare: 0.000166, max: 8.3 },
];

export const FEE_SOURCES = {
  twTax: 'https://6laws.net/6law/laws/證券交易稅條例.html',
  bondEtfTax: 'https://www.ey.gov.tw/Page/9277F759E41CCD91/4d7b8a90-f834-4035-ab54-7728b91f243b',
  secFee: 'https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2',
  finraTaf: 'https://www.finra.org/rules-guidance/rule-filings/sr-finra-2026-021',
};

const MONEY101 = 'https://www.money101.com.tw/blog/%E6%96%B0%E6%89%8B%E9%96%8B%E6%88%B6%E9%81%B8%E5%93%AA%E5%AE%B6%E5%93%AA%E5%AE%B6%E5%88%B8%E5%95%86%E6%89%8B%E7%BA%8C%E8%B2%BB%E6%9C%80%E4%BE%BF%E5%AE%9C%E3%80%81%E4%B8%8B%E5%96%AE%E8%BB%9F%E9%AB%94';

const tw = (id, name, discount, minFee, oddLotMinFee, rebate, confidence, note, source) => ({
  id, name, market: 'TW', model: 'discount', discount, minFee, oddLotMinFee,
  rebate, confidence, note, source, asOf: FEES_AS_OF,
});

export const TW_BROKERS = [
  tw('tw_generic_06', '一般電子下單（6 折）', 0.6, 20, 1, '月退', 'medium',
    '多數券商電子下單常見 6 折、整股每筆最低 20 元、零股最低 1 元；實際折數依個人議定，請改成自己的折數。',
    'https://grenade.tw/blog/taiwan-stock-broker-comparison/'),
  tw('tw_yuanta', '元大證券', 0.6, 20, 1, '日退', 'medium',
    '電子下單 6 折、整股最低 20 元、盤中零股最低 1 元（官方）；盤後零股低消官方未載；退費時點各來源不一（日退或月退），折數依分公司議定。',
    'https://www.yuanta.com.tw/file-repository/content/d9ad191c-1eaa-4b51-b59b-c652997d6d24/note.html'),
  tw('tw_fubon', '富邦證券', 0.6, 20, 1, '月退', 'medium',
    '一般舊戶 6 折、整股最低 20 元為二手資料；零股最低 1 元（官方）；退費時點官方未載。',
    'https://www.money101.com.tw/blog/%e7%86%b1%e9%96%80%e5%88%b8%e5%95%86%e6%af%94%e4%b8%80%e6%af%94'),
  tw('tw_fubon_new', '富邦證券（2026 新戶方案）', 0.18, 20, 1, '月退', 'medium',
    '2026/1/1–2026/12/31 新戶每月電子成交 100 萬元內享優惠，1.8 折來自二手資料；先收全額、次月 5 日退回（官方）；超過 100 萬元依約定手續費。',
    'https://www.fubon.com/securities/open-now/index.html'),
  tw('tw_kgi', '凱基證券', 0.6, 20, 1, '月退', 'medium',
    '整股最低 20 元、零股最低 1 元（官方）；6 折與月退為二手資料。',
    'https://www.kgi.com.tw/zh-tw/support-index/trading-regulations'),
  tw('tw_cathay', '國泰證券', 0.28, 1, 1, '日退', 'medium',
    '網路下單 2.8 折（官方）；每筆最低 1 元與日退為二手資料，官方未載。',
    'https://www.cathaysec.com.tw/cathaysec/Products/TradeFee/TWS.aspx'),
  tw('tw_sinopac_new', '永豐金證券（線上新戶）', 0.2, 1, 1, '月退', 'high',
    '線上新開戶每月電子成交 100 萬元內 2 折、低收 1 元（官方 2026 限時優惠）；超過或不適用時依牌告 1.425‰、最低 20 元；次月 15 日退回。',
    'https://www.sinotrade.com.tw/newweb/Fee_Rate/?market=S'),
  tw('tw_capital', '群益金鼎證券', 0.6, 20, 1, '月退', 'low',
    '零股電子交易最低 1 元（官方）；6～6.5 折與整股最低 20 元為二手資料；退費時點說法不一。',
    'https://www.capital.com.tw/event/stock/oddLot/default.asp'),
  tw('tw_masterlink', '原元富證券（現台新）', 0.65, 20, 1, '月退', 'low',
    '元富證券已於 2026-04-06 併入台新證券；原元富與富果帳戶常見 6.5 折（二手資料）；整股最低 20 元、零股 1 元，次月 15 日退。',
    'https://support.fugle.tw/?p=169'),
  tw('tw_pscnet', '統一證券', 0.6, 20, 1, '月退', 'low',
    '零股最低 1 元（官方）；一般電子 6 折與整股最低 20 元為舊的二手資料；e起發、UMONEY 帳戶折數與低消不同。',
    'https://eservices.pscnet.com.tw/dm/ODD/index.html'),
  tw('tw_mega', '兆豐證券', 0.5, 20, 1, '月退', 'low',
    '5～6 折與最低手續費都是二手資料，未經官方確認。',
    'https://uptogo.com.tw/?p=1910575'),
  tw('tw_entrust', '華南永昌證券', 0.65, 20, 1, '月退', 'low',
    '6.5 折、整股最低 20 元為二手資料，未經官方確認。',
    MONEY101),
  tw('tw_esun', '玉山證券', 0.6, 20, 1, '月退', 'high',
    '當月成交金額累進：100 萬內 6 折、100–300 萬 5 折、300 萬以上 3.8 折，這裡只用第一級距 6 折估算；次月 13 日退回（官方）。',
    'https://www.esunsec.com.tw/campaign/trade-fee'),
  tw('tw_first', '第一金證券', 0.6, 20, 1, '月退', 'low',
    '6 折為二手資料（各來源一致），官網無法查證。',
    'https://uptogo.com.tw/?p=1910575'),
  tw('tw_taishin', '台新證券', 0.3, 20, 1, '月退', 'low',
    '3 折為二手資料（以台新銀行交割）；整股最低 20 元；零股最低 1 元與官方試算器的 20 元互相衝突。',
    'https://www.tssco.com.tw/FeeCalculator/'),
  tw('tw_ctbc', '中國信託證券', 0.6, 20, 20, '月退', 'low',
    '6 折與每筆最低 20 元為二手資料，另有 3.8 折的說法；零股最低 20 元未經官方確認。',
    'https://roo.cash/blog/?p=81671'),
  tw('tw_skis', '新光證券', 0.28, 20, 1, '日退', 'low',
    '標準 2.8 折為二手資料；新戶每月 100 萬內另有優惠（說法不一）；退費時點說法不一。',
    'https://grenade.tw/blog/skis-tutorial/'),
  tw('tw_pocket', '口袋證券', 0.28, 1, 1, '即時', 'low',
    '每筆最低 1 元（官方）；2.8 折與直接以折扣後金額收取為二手資料（新戶 2026 下半年 2.2 折）。',
    'https://www.pocket.tw/'),
  tw('tw_custom', '自訂', 0.6, 20, 1, '月退', 'user',
    '自訂折數與最低手續費。', ''),
];

const us = (id, name, model, fields, confidence, note, source) => ({
  id, name, market: 'US', model,
  rate: 0, perShare: 0, minFee: 0, maxPct: null, etfFlat: null, oddLotMinFee: null,
  ...fields, rebate: '即時', confidence, note, source, asOf: FEES_AS_OF,
});

export const US_BROKERS = [
  us('us_firstrade', 'Firstrade 第一證券', 'zero', {}, 'high',
    '線上下單美股、ETF 零佣金（官方）；賣出另收 SEC 規費。',
    'https://www.firstrade.com/content/zh-tw/pricing'),
  us('us_ibkr_fixed', 'IBKR Pro 固定費率', 'per_share', { perShare: 0.005, minFee: 1, maxPct: 0.01 }, 'high',
    '每股 0.005 美元、每筆最低 1 美元、最高為成交金額 1%（官方）；交易所與 CAT 小額規費未計。IBKR Lite 只限美國居民。',
    'https://www.interactivebrokers.com/en/pricing/commissions-stocks.php'),
  us('us_schwab', '嘉信 Schwab International', 'zero', {}, 'high',
    '線上下單美股、ETF 零佣金（官方）；換匯最高 3% 另計。',
    'https://international.schwab.com/pricing'),
  us('us_cathay', '國泰證券（複委託）', 'percent', { rate: 0.0008, etfFlat: 3 }, 'high',
    '網路下單個股 0.08%、無最低（優惠至 2026/12/31）；ETF 每筆 3 美元（官方）。',
    'https://www.cathaysec.com.tw/cathaysec/Products/TradeFee/USS.aspx'),
  us('us_sinopac', '永豐金證券（複委託）', 'percent', { rate: 0.0008, minFee: 0.01 }, 'medium',
    '網路下單 0.08%、最低 0.01 美元，限當月累計 5 萬美元內（2026 限時優惠，官方）；超過依原費率。',
    'https://www.sinotrade.com.tw/OVS/OVS_6_2'),
  us('us_esun', '玉山證券（複委託）', 'percent', { rate: 0.0008 }, 'medium',
    '牌告 0.08%、免低收（官方）。',
    'https://www.esunsec.com.tw/campaign/trade-fee-foreign'),
  us('us_yuanta', '元大證券（複委託）', 'percent', { rate: 0.001 }, 'low',
    '電子下單常見 0.1%、無低消；官方另列每筆 3 美元系統服務費，適用範圍不明，這裡不計。',
    'https://www.yuanta.com.tw/eyuanta/webfile/resourcesFile/3c103956-6ef4-49e2-b2b6-6ef507420344.pdf'),
  us('us_fubon', '富邦證券（複委託）', 'percent', { rate: 0.0025 }, 'low',
    '網路下單 0.25%、無最低為二手資料；2026 新戶當月 5 萬美元內 0.06%（二手資料）。',
    'https://www.money101.com.tw/blog/證券開戶-富邦證券-股票'),
  us('us_kgi', '凱基證券（複委託）', 'percent', { rate: 0.001 }, 'low',
    '官方費率表電子單 0.1%～1%；這裡假設 0.1%、無低消（2026/10/1–12/31 電子單無低消活動），請改成自己的費率。',
    'https://www.kgi.com.tw/zh-tw/-/media/files/kgis/3_2_2_foreign-stocks/charge_20260309.pdf'),
  us('us_custom', '自訂', 'percent', { rate: 0.001 }, 'user',
    '自訂費率。', ''),
];

export const BROKERS = [...TW_BROKERS, ...US_BROKERS];
export const DEFAULT_BROKER_ID = { TW: 'tw_generic_06', US: 'us_firstrade' };

// 浮點誤差清理：580000 × 0.001425 × 0.6 這類乘積先修成 12 位有效數字再捨入。
const clean = (x) => Number(x.toPrecision(12));
const floorInt = (x) => Math.floor(clean(x));
const ceilCents = (x) => Math.ceil(clean(x * 100)) / 100;
const roundCents = (x) => Math.round(clean(x * 100)) / 100;
const pickRate = (schedule, date) =>
  (date ? schedule.find((r) => date >= r.from) : null) ?? schedule[0];

export function brokersFor(market) {
  return BROKERS.filter((b) => b.market === market);
}

export function getBroker(ref, market = 'TW', overrides = {}) {
  let base = null;
  if (ref && typeof ref === 'object') base = ref;
  else if (ref) base = BROKERS.find((b) => b.id === ref && b.market === market) ?? null;
  if (!base) base = BROKERS.find((b) => b.id === DEFAULT_BROKER_ID[market]) ?? TW_BROKERS[0];
  const extra = overrides?.[base.id];
  return extra ? { ...base, ...extra } : { ...base };
}

export function inferTwType(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (/^00\d{2,4}B$/.test(c)) return 'bond_etf';
  if (/^00\d{2,4}[A-Z]?$/.test(c) || /^02\d{4}$/.test(c)) return 'etf';
  return 'stock';
}

export function twFee(amount, broker, { oddLot = false } = {}) {
  if (!(amount > 0)) return 0;
  const b = getBroker(broker, 'TW');
  const discount = Number.isFinite(b.discount) ? b.discount : 1;
  const min = oddLot ? (b.oddLotMinFee ?? b.minFee ?? 0) : (b.minFee ?? 0);
  return Math.max(floorInt(amount * TW_FEE_RATE * discount), min);
}

export function twOrderFee(price, shares, broker) {
  if (!(price > 0) || !(shares > 0)) return 0;
  const roundLot = Math.floor(shares / 1000) * 1000;
  const oddLot = clean(shares - roundLot);
  return (roundLot > 0 ? twFee(price * roundLot, broker) : 0) +
    (oddLot > 0 ? twFee(price * oddLot, broker, { oddLot: true }) : 0);
}

export function twTaxRate(type, date) {
  if (type === 'bond_etf') return date && date <= BOND_ETF_EXEMPT_UNTIL ? 0 : TW_TAX_RATES.bond_etf;
  return TW_TAX_RATES[type] ?? TW_TAX_RATES.stock;
}

export function twTax(amount, type, date) {
  if (!(amount > 0)) return 0;
  return floorInt(amount * twTaxRate(type, date));
}

export function usCommission(amount, shares, broker, { isEtf = false } = {}) {
  if (!(amount > 0) || !(shares > 0)) return 0;
  const b = getBroker(broker, 'US');
  let fee = 0;
  if (b.model === 'per_share') fee = Math.max(shares * (b.perShare ?? 0), b.minFee ?? 0);
  else if (b.model === 'percent') {
    fee = isEtf && b.etfFlat != null ? b.etfFlat : Math.max(amount * (b.rate ?? 0), b.minFee ?? 0);
  }
  if (b.maxPct != null) fee = Math.min(fee, amount * b.maxPct);
  return roundCents(fee);
}

export function secFeeRate(date) {
  return pickRate(SEC_FEE_SCHEDULE, date).rate;
}

export function usRegFees(amount, shares, { side = 'sell', date } = {}) {
  if (side !== 'sell' || !(amount > 0) || !(shares > 0)) return { sec: 0, taf: 0, total: 0 };
  const sec = ceilCents(amount * secFeeRate(date));
  const t = pickRate(TAF_SCHEDULE, date);
  const taf = ceilCents(Math.min(shares * t.perShare, t.max));
  return { sec, taf, total: roundCents(sec + taf) };
}

export function tradeCosts({ market = 'TW', side = 'buy', price, shares, type, code, date, broker, brokerOverrides } = {}) {
  const p = Number(price);
  const n = Number(shares);
  const currency = market === 'US' ? 'USD' : 'TWD';
  const b = getBroker(broker, market, brokerOverrides);
  if (!(p > 0) || !(n > 0)) {
    return { fee: 0, tax: 0, regFee: 0, secFee: 0, taf: 0, total: 0, amount: 0, net: 0, currency, broker: b.id };
  }
  const amount = clean(p * n);
  let fee, tax = 0, reg = { sec: 0, taf: 0, total: 0 };
  if (market === 'US') {
    const t = type ?? 'stock';
    fee = usCommission(amount, n, b, { isEtf: t === 'etf' || t === 'bond_etf' });
    reg = usRegFees(amount, n, { side, date });
  } else {
    fee = twOrderFee(p, n, b);
    if (side === 'sell') tax = twTax(amount, type ?? inferTwType(code), date);
  }
  const total = market === 'US' ? roundCents(fee + reg.total) : fee + tax;
  const net = side === 'sell' ? clean(amount - total) : clean(amount + total);
  return { fee, tax, regFee: reg.total, secFee: reg.sec, taf: reg.taf, total, amount, net, currency, broker: b.id };
}

export function estimateSellCosts({ market = 'TW', code, type, shares, price, date, broker, brokerOverrides } = {}) {
  return tradeCosts({ market, side: 'sell', code, type, shares, price, date, broker, brokerOverrides });
}
