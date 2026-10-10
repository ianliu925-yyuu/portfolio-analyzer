# 計算模組 API（`assets/fees.js`、`assets/portfolio.js`、`assets/rules.js`）

三個檔案都是純函式 ES modules：沒有 DOM、沒有 localStorage、不讀系統時間。瀏覽器用 `import { … } from './fees.js'`，Node 測試用 `import { … } from '../../assets/fees.js'`。日期一律由呼叫端傳入。

## 共通慣例

| 項目 | 規則 |
|---|---|
| 日期 | 字串 `YYYY-MM-DD`（例 `2026-10-08`），用字串比較大小。 |
| 市場 | `'TW'` 或 `'US'`。 |
| 幣別 | 台股金額是新台幣（`'TWD'`），美股金額是美元（`'USD'`）。名稱結尾是 `TWD` 的欄位已換成台幣。 |
| 百分比 | 欄位名稱結尾是 `Pct` 的值是**百分數**（`12.5` 代表 12.5%），跟每日資料的 `changePct`、`yoy` 一樣。 |
| 比例 | `weight`、`assetWeight`、`cashRatio`、`pos52`、`stopPct`、`discount`、`rate`、`maxPct` 是 **0～1 的比例**（`0.4` 代表 40%）。 |
| 缺值 | 算不出來的值是 `null`，不是 0。介面要顯示「—」。 |
| 股數 | 台股、美股都以「股」為單位（台股 1 張 = 1000 股）。 |
| 證券類型 `type` | `'stock'`、`'etf'`、`'bond_etf'`（同 `index-*.json` 第三欄）。 |
| 浮點數 | 回傳值已清掉浮點雜訊（12 位有效數字），但**沒有**四捨五入到整數或分，格式化交給介面。手續費、稅、規費例外：已依規則捨入（見下）。 |

持股鍵：`holdingKey(market, code)` → `'TW:2330'`、`'US:AAPL'`。`summary.weights`、`ctx.analyses` 都用這個鍵。

---

## `assets/fees.js`

### 常數

| 名稱 | 值 / 形狀 |
|---|---|
| `FEES_AS_OF` | `'2026-10-10'`（券商表查證日期） |
| `TW_FEE_RATE` | `0.001425` |
| `TW_TAX_RATES` | `{ stock: 0.003, etf: 0.001, bond_etf: 0.001 }`（`bond_etf` 停徵期間另判斷） |
| `BOND_ETF_EXEMPT_UNTIL` | `'2026-12-31'`：賣出日 ≤ 這天的債券 ETF 證交稅 0；之後先以 0.1% 估（延長案尚未三讀，介面要註明） |
| `SEC_FEE_SCHEDULE` | `[{ from: '2026-04-02', rate: 0.0000206 }, { from: '2025-05-13', rate: 0 }, { from: '0000-01-01', rate: 0.0000278 }]`，依**交易日**取第一個 `from <= 交易日` 的列 |
| `TAF_SCHEDULE` | `[{ from: '2027-01-01', perShare: 0.000195, max: 9.79 }, { from: '2026-10-01', perShare: 0, max: 0 }, { from: '2026-01-01', perShare: 0.000195, max: 9.79 }, { from: '0000-01-01', perShare: 0.000166, max: 8.3 }]`（2026-10-01～2026-12-31 暫停收取；2025 年以前用舊費率） |
| `FEE_SOURCES` | `{ twTax, bondEtfTax, secFee, finraTaf }`：各規費的出處網址，給頁尾「資料來源」用 |
| `TW_BROKERS` / `US_BROKERS` | 券商預設陣列（見下） |
| `BROKERS` | `[...TW_BROKERS, ...US_BROKERS]` |
| `DEFAULT_BROKER_ID` | `{ TW: 'tw_generic_06', US: 'us_firstrade' }` |

### 券商物件 `Broker`

共同欄位：

```js
{
  id: 'tw_generic_06',          // 唯一
  name: '一般電子下單（6 折）',  // 顯示名稱
  market: 'TW' | 'US',
  model: 'discount' | 'zero' | 'per_share' | 'percent',
  minFee: number,               // 每筆最低手續費（TW：整股；US：美元）
  rebate: '即時' | '日退' | '月退', // 折讓時點；'月退' 介面要標示（成本仍以折扣後計）
  confidence: 'high' | 'medium' | 'low' | 'user', // 'low' 介面標「僅供參考」；'user' = 自訂
  note: string,                 // 繁中說明（折數出處、衝突、活動期限）
  source: string,               // 一個出處網址；自訂（confidence 'user'）是 ''
  asOf: '2026-10-10',
}
```

台股（`model: 'discount'`）另有：

```js
{ discount: 0.6,      // 折數：0.6 = 6 折
  oddLotMinFee: 1 }   // 零股每筆最低手續費
```

美股另有（沒用到的欄位是 0 或 null）：

```js
{ rate: 0.0008,     // model 'percent'：成交金額 × rate
  perShare: 0.005,  // model 'per_share'：每股美元
  minFee: 1,        // 每筆最低（美元）
  maxPct: 0.01,     // 每筆上限 = 成交金額 × maxPct；null = 無上限
  etfFlat: 3,       // ETF 每筆固定美元（覆蓋 rate）；null = 不適用
  oddLotMinFee: null }
```

預設清單（id）：

- 台股：`tw_generic_06`（預設）、`tw_yuanta`、`tw_fubon`、`tw_fubon_new`、`tw_kgi`、`tw_cathay`、`tw_sinopac_new`、`tw_capital`、`tw_masterlink`（原元富，現台新）、`tw_pscnet`、`tw_mega`、`tw_entrust`（華南永昌）、`tw_esun`、`tw_first`、`tw_taishin`、`tw_ctbc`、`tw_skis`、`tw_pocket`、`tw_custom`
- 美股：`us_firstrade`（預設，`zero`）、`us_ibkr_fixed`（`per_share` 0.005、min 1、max 1%）、`us_schwab`（`zero`）、`us_cathay`（`percent` 0.08%、ETF 3 美元）、`us_sinopac`（0.08%、min 0.01）、`us_esun`（0.08%）、`us_yuanta`（0.1%）、`us_fubon`（0.25%）、`us_kgi`（0.1%）、`us_custom`

**使用者自訂**：介面把使用者改過的值存在 localStorage，形狀建議 `brokerOverrides = { [brokerId]: { discount, minFee, oddLotMinFee, rate, perShare, maxPct, etfFlat } }`（只放有改的欄位，數字型別）。下面所有接受 `broker` 的函式都可以另外收 `brokerOverrides`，或直接傳 `getBroker(id, market, brokerOverrides)` 的結果。

### `brokersFor(market) → Broker[]`

回傳該市場的預設券商（含 `custom`），給下拉選單用。

### `getBroker(ref, market = 'TW', overrides = {}) → Broker`

- `ref`：券商 id 字串、券商物件，或 `undefined`。
- id 找不到、或 id 屬於另一個市場 → 回傳該市場預設券商。
- 傳物件 → 直接使用（複製一份）。
- `overrides[broker.id]` 有值時合併進去。永遠回傳新物件，不會改到預設表。

### `inferTwType(code) → 'stock' | 'etf' | 'bond_etf'`

代號沒在索引裡時的後備判斷：`00` 開頭且結尾 `B` → `bond_etf`；`00` 開頭（含 `00631L` 這類）或 `02` 開頭 6 碼（ETN）→ `etf`；其他 → `stock`。有每日資料時請以 `record.type` 為準。

### `twFee(amount, broker, { oddLot = false } = {}) → integer`

台股單一部分的手續費（新台幣整數）：`max(floor(amount × 0.001425 × discount), oddLot ? oddLotMinFee : minFee)`。`amount <= 0` → `0`。

### `twOrderFee(price, shares, broker) → integer`

一筆台股委託的手續費：股數拆成整股部分（1000 的倍數）和零股餘數，各自 `twFee`、各自套最低手續費；沒有的部分收 0。

```js
twOrderFee(580, 1000, 'tw_generic_06') // 495
twOrderFee(100, 1500, 'tw_generic_06') // 85 + 42 = 127
twOrderFee(10, 1050, 'tw_generic_06')  // 20（整股低消）+ 1（零股低消）= 21
```

### `twTaxRate(type, date) → number` / `twTax(amount, type, date) → integer`

證交稅（只在賣出時收；呼叫端決定要不要算）。`stock` 0.3%、`etf` 0.1%、`bond_etf`：`date <= BOND_ETF_EXEMPT_UNTIL` 為 0，否則 0.1%；**沒給 `date` 時債券 ETF 保守以 0.1% 計**。未知 `type` 當 `stock`。`twTax` 無條件捨去到整數。當沖減半稅率不處理。

### `usCommission(amount, shares, broker, { isEtf = false } = {}) → number`

美股佣金（美元，四捨五入到 0.01）。

- `zero` → 0
- `per_share` → `max(shares × perShare, minFee)`，再 `min(…, amount × maxPct)`（IBKR：10 股 × $0.20 → $0.02）
- `percent` → ETF 且有 `etfFlat` 時用 `etfFlat`；否則 `max(amount × rate, minFee)`；有 `maxPct` 時再取上限

### `secFeeRate(date) → number`

依交易日回傳 SEC 費率（`SEC_FEE_SCHEDULE`）。沒給日期 → 最新費率。

### `usRegFees(amount, shares, { side = 'sell', date } = {}) → { sec, taf, total }`

美股賣出規費（美元）。買進全部 0。

- `sec = ceil(amount × secFeeRate(date))` 到 0.01（賣 $1,000 → 0.03）
- `taf = ceil(min(shares × perShare, max))` 到 0.01；交易日 2026-10-01～2026-12-31 為 0
- `total = sec + taf`
- 沒給 `date` → 用排程第一列（2027 起的費率），所以**一定要傳日期**。

### `tradeCosts(input) → Costs`

```js
tradeCosts({
  market: 'TW' | 'US',          // 預設 'TW'
  side: 'buy' | 'sell',         // 預設 'buy'
  price: number, shares: number,
  type?: 'stock'|'etf'|'bond_etf', // TW 沒給時用 inferTwType(code)；US 沒給當 'stock'
  code?: string,
  date?: 'YYYY-MM-DD',          // 交易日：債券 ETF 稅、SEC、TAF 依此判斷
  broker?: string | Broker,     // 沒給 → 市場預設
  brokerOverrides?: object,
})
// →
{
  fee: number,      // 手續費／佣金（TW 整數；US 美元到分）
  tax: number,      // 台股證交稅（只有賣出），美股 0
  regFee: number,   // 美股 SEC + TAF（只有賣出），台股 0
  secFee: number, taf: number, // regFee 的明細
  total: number,    // fee + tax + regFee
  amount: number,   // price × shares
  net: number,      // 買進：amount + total（要付的錢）；賣出：amount − total（拿到的錢）
  currency: 'TWD' | 'USD',
  broker: string,   // 實際使用的券商 id
}
```

`price <= 0` 或 `shares <= 0` → 全部 0。新增交易表單「即時顯示手續費與稅」直接用這個，並把 `fee`、`tax`、`regFee` 存進交易紀錄。

### `estimateSellCosts({ market, code, type, shares, price, date, broker, brokerOverrides }) → Costs`

等於 `tradeCosts({ …, side: 'sell' })`，用來估「現在全部賣掉」的費用。`date` 傳今天（或資料日期）。

---

## `assets/portfolio.js`

### 交易紀錄 `Transaction`（存在 localStorage，由介面建立）

```js
{
  id: string,                 // 介面產生，唯一
  market: 'TW' | 'US',
  code: string,               // 會被 trim + 轉大寫
  side: 'buy' | 'sell',
  shares: number,             // > 0；美股可有小數
  price: number,              // >= 0
  date: 'YYYY-MM-DD',
  feeIncluded: boolean,       // 「價位已含手續費」
  fee: number,                // 手續費（feeIncluded 時存 0）
  tax: number,                // 證交稅（台股賣出）
  regFee: number,             // 美股規費（賣出）
  broker: string,             // 券商 id
}
```

- `feeIncluded: false`（預設）：買進成本 = `price × shares + fee + tax + regFee`；賣出淨收入 = `price × shares − fee − tax − regFee`。
- `feeIncluded: true`：使用者填的價位已含費用。買進成本 = `price × shares`，`fee/tax/regFee` 一律忽略；賣出淨收入 = `price × shares`。
- `fee`、`tax`、`regFee` 缺值當 0。**`buildHoldings` 不會自己估手續費**：新增交易時用 `tradeCosts` 算好再存。

### `buildHoldings(transactions) → Result`

平均成本法。交易先依 `date` 排序，同一天依輸入順序。

```js
{
  holdings: Holding[],      // 目前還有股數的（shares > 0），依市場（TW 先）再代號排序
  closed: Holding[],        // 曾經有、現在已全部賣掉的（shares 0、costTotal 0），保留已實現損益
  realizedTotal: { TW: number, US: number }, // 各自原幣（TWD / USD）
  realizedList: [{ id, market, code, date, shares, proceeds, costBasis, realized, currency }], // 每筆賣出
  errors: [{ id, index, market, code, date, message }], // message 是繁中句子，可直接顯示
}

// Holding
{
  market, code,
  currency: 'TWD' | 'USD',
  shares: number,
  costTotal: number,   // 持有成本（含買進手續費），原幣
  avgCost: number,     // costTotal / shares；shares 0 時為 0
  realized: number,    // 此代號累計已實現損益，原幣
  feesPaid: number,    // 累計手續費 + 稅 + 規費（feeIncluded 的交易不計）
  firstDate: string,   // 此代號第一筆交易日
  lastDate: string,    // 最後一筆交易日
  openedDate: string,  // 目前這段持有的起始日（股數從 0 變成 > 0 的那筆買進）
  txCount: number,     // 計入的交易筆數
  broker: string|null, // 最後一筆有填的券商 id（估賣出費用用）
}
```

- 賣出：`costBasis = avgCost × 賣出股數`，`costTotal -= costBasis`，`realized += 淨收入 − costBasis`。賣光後 `costTotal` 歸 0。
- 賣超過持股：加一筆 error（「…但當時只持有 N 股，已以 N 股計算」），以持有股數計算，費用按比例打折。
- 沒有持股就賣出、欄位不合法（股數 ≤ 0、日期格式錯、市場或買賣別錯、缺代號）：加一筆 error 並略過該筆。

### `valueHolding(holding, record, ctx) → Row`

```js
valueHolding(holding, record /* 每日資料 record，可為 null */, {
  fx?: number,                 // meta.fx.USDTWD；美股必填，否則 TWD 欄位為 null
  broker?: string | Broker,    // 估賣出費用的券商；沒給用 holding.broker，再沒有用市場預設
  brokerOverrides?: object,
  date?: 'YYYY-MM-DD',         // 估賣出費用的日期（今天或資料日期）
  manualPrice?: number,        // 使用者手動輸入的現價，優先於 record.close
})
```

回傳 `{ ...holding, ...下列欄位 }`：

| 欄位 | 說明 |
|---|---|
| `name` | `record.name`，沒有就用代號 |
| `type` | `record.type`；沒有時 TW 用 `inferTwType`、US 用 `'stock'` |
| `industry` | TW：`record.industry`；US：`record.sector`（沒有再用 `record.industry`）；ETF 沒產業時為 `'ETF'`；都沒有為 `null` |
| `currency` | `'TWD'` / `'USD'` |
| `price` | 現價（`manualPrice` 或 `record.close`），沒有為 `null` |
| `priceSource` | `'manual'` / `'data'` / `null` |
| `marketValue` | `price × shares`（原幣） |
| `grossPL`, `grossPLPct` | 帳面損益 = `marketValue − costTotal`；% 以 `costTotal` 為分母 |
| `sellCosts` | 預估賣出費用合計 = `sellFee + sellTax + sellRegFee` |
| `sellFee`, `sellTax`, `sellRegFee` | 明細（`estimateSellCosts`） |
| `netPL`, `netPLPct` | **未實現淨損益** = `marketValue − sellCosts − costTotal`；介面以這個為主 |
| `dayChange`, `dayChangePct` | `record.change`、`record.changePct`（只有 `priceSource === 'data'` 時有值） |
| `dayPL` | `dayChange × shares` |
| `fx` | 換算率：TW 為 1；US 為 `ctx.fx`（缺則 `null`） |
| `costTWD`, `valueTWD`, `grossPLTWD`, `sellCostsTWD`, `netPLTWD`, `dayPLTWD`, `realizedTWD` | 換成台幣的值 |
| `sellBroker` | 估賣出費用用的券商 id |
| `missing` | 缺的東西：`'price'`、`'fx'` |

沒有現價時，`marketValue/grossPL/sellCosts/netPL/…` 都是 `null`，但 `costTWD` 仍有值。

### `summarize(rows, ctx) → Summary`

```js
summarize(rows /* valueHolding 的結果陣列 */, {
  cashTWD?: number, cashUSD?: number,
  fx?: number,                  // meta.fx.USDTWD
  realizedTotal?: { TW, US },   // buildHoldings 的 realizedTotal；有傳才會含已全部賣掉的股票
})
```

回傳（金額全部是台幣）：

```js
{
  currency: 'TWD', fx,
  holdingCount,                 // rows.length
  marketValue,                  // Σ valueTWD（缺價或缺匯率的列不計）
  costTotal,                    // Σ costTWD（含沒有價格的列）
  pricedCost,                   // 有價格那些列的成本（報酬率的分母）
  grossPL, grossPLPct,
  sellCosts,
  netPL, netPLPct,              // netPLPct = netPL / pricedCost × 100
  dayPL, dayPLPct,              // dayPLPct = dayPL / (昨日市值) × 100
  realized,                     // 已實現損益（TW + US × fx）
  cashTWD, cashUSD, cashTotalTWD,
  totalAssets,                  // marketValue + cashTotalTWD
  cashRatio,                    // cashTotalTWD / totalAssets；兩者都 0 時為 null；沒輸入現金 → 0（全倉）
  rows: Row[],                  // 輸入的 rows 複本，多了 weight 與 assetWeight
  weights: { 'TW:2330': 0.6, … },      // 占股票市值（不含現金），明細表「占比」與圓環圖用
  assetWeights: { 'TW:2330': 0.54, … },// 占總資產（含現金），規則判斷用
  maxWeight: { key, label, weight, assetWeight } | null,
  topIndustry: { label, weight, assetWeight } | null,
  allocation: {
    byStock:    [{ key: 'TW:2330', label: '台積電（2330）', market, code, valueTWD, weight, assetWeight, codes }],
    byIndustry: [{ key, label, valueTWD, weight, assetWeight, codes: ['TW:2330', …] }], // 產業缺值歸「未分類」
  },                            // 兩者都依金額大到小；不含現金（圓環圖要顯示現金請自己加一塊）
  missingPrice: ['TW:9999', …], // 沒有價格的持股
  missingFx: boolean,           // 有美股或美元現金但沒有匯率
}
```

### 小工具

- `holdingKey(market, code) → 'TW:2330'`
- `normalizeCode(code) → string`（trim + 大寫）
- `currencyOf(market) → 'TWD' | 'USD'`

---

## `assets/rules.js`

### `RULES`（可調門檻；改這個物件就改規則）

```js
{
  stopPct: 0.10, supportStopFactor: 0.97, resistanceNearHigh: 0.01, stopWatch: 0.03,
  takeProfit: { minReturnPct: 20, peMultiple: 1.5, minPos52: 0.85 },
  reduce: { maxWeight: 0.40, foreignSellDays: 3, maxRevenueYoy: 0 },
  add: { minReturnPct: -5, maxReturnPct: 10, minRevenueYoy: 20, minForeign5: 0, peMultiple: 1 },
  signals: { max: 3, revenueYoyUp: 10, revenueYoyDown: 0, nearLow52: 0.05, streakDays: 3,
             marginJump: 0.05, peCheap: 0.8, peRich: 1.5, volumeSpike: 2 },
  watch: { nearStop: 0.05, nearResistance: 0.03, revenueDay: 10, reportDaysAhead: 30,
           eventDaysAhead: 14, holidayDaysAhead: 7 },
  portfolio: { minHoldings: 3, maxWeight: 0.40, maxIndustryWeight: 0.60, minCash: 0.10 },
}
```

其他常數：`ACTIONS = ['停損', '停損觀察', '分批停利', '減碼', '加碼', '續抱']`（優先順序）、`REPORT_DEADLINES = [{ md: '03-31', label: '年報' }, { md: '05-15', … }, { md: '08-14', … }, { md: '11-14', … }]`。

### `industryPeFor(industryPe, market, industry) → number | null`

`industryPe` 是 `meta.industryPe`（鍵 `'TW:半導體業'`），也接受直接傳數字。找不到為 `null`。

### `levels(holding, record, { stopPct = 0.10, userStop } = {}) → Levels`

`holding` 可以是 `Holding` 或 `Row`：現價取 `holding.price`（`Row` 才有，含手動價），沒有再用 `record.close`。

```js
{
  cost,         // holding.avgCost（到 0.01）
  price,
  support,      // hist.low20；若 ma60 < 現價 且 ma60 > low20，改用 ma60（low20 缺而 ma60 < 現價時用 ma60）
  resistance,   // hist.high20；現價距 high20 < 1%（或已超過）改用 hi52；high20 缺用 hi52
  stop,         // userStop 優先；否則 max(cost × (1 − stopPct), support × 0.97)（到 0.01）
  stopSource,   // 'user' | 'cost' | 'support' | null
  stopPct,      // 實際使用的停損%（0～1）
  hi52, lo52,
  pos52,        // (price − lo52) / (hi52 − lo52)，夾在 0～1；缺資料 null
  ma60,
}
```

### `analyzeHolding(row, record, ctx) → Analysis`

```js
analyzeHolding(row /* summarize().rows 的一列（或 valueHolding 結果）*/, record /* 每日資料，可為 null */, {
  market?: 'TW' | 'US',      // 預設 row.market；籌碼（chips）只在 TW 使用
  weight?: number,           // 單檔占「總資產（含現金）」比例 0～1；預設 row.assetWeight，再沒有用 row.weight
  industryPe?: object|number,// meta.industryPe
  today?: 'YYYY-MM-DD',      // 今天（月營收、財報期限、事件、休市提醒用；沒給就不出這些提醒）
  events?: [{ date, title }],// meta.events；顯示今天起 14 天內的；標題含「美股」的不給台股、含「台股」的不給美股
  holidayNote?: string,      // meta.tw.holidayNote 或 meta.us.holidayNote（依該股市場）
  upcomingHolidays?: [{ date, name }], // 沒有 holidayNote 時，顯示 7 天內的休市日
  stopPct?: number,          // 使用者設定的預設停損%（0～1）
  userStop?: number,         // 這檔的自訂停損價
})
```

回傳：

```js
{
  code, market,
  label: '台積電（2330）',
  action: '停損' | '停損觀察' | '分批停利' | '減碼' | '加碼' | '續抱',
  reasons: string[],   // [0] 是主要動作的理由；其後「同時符合「X」條件：…」；最後是缺資料說明
  triggers: string[],  // 具體價位，例：'收盤跌破 550 → 減碼'、'站穩 604 以上 → 續抱'、'賣出約 400 股，讓占比降到 40% 以下'
  bull: string[],      // 最多 3 點，依重要性
  bear: string[],      // 最多 3 點，依重要性
  watch: string[],     // 今天該注意
  levels: Levels,
  returnPct: number|null, // 判斷用的報酬率（%）：row.netPLPct，沒有時用 (price − cost) / cost
  weight: number|null,
  checks: { 停損, 停損觀察, 分批停利, 減碼, 加碼 }, // 每個條件 true / false / null（null = 缺資料無法判斷）
}
```

判斷順序（先符合者為主要動作）：

1. **停損**：`price < stop`
2. **停損觀察**：`0 ≤ (price − stop) / price ≤ 3%`
3. **分批停利**：報酬率 ≥ 20% 且（`fund.pe > 同業 × 1.5` 或 `pos52 ≥ 0.85`）
4. **減碼**：`weight > 0.40`，或（`chips.foreignStreak ≤ −3` 且 `chips.marginChg > 0` 且 `fund.yoy < 0`）
5. **加碼**：報酬率在 −5%～+10%、`price > hist.ma60`、`fund.yoy ≥ 20`、`chips.foreign5 > 0`、`fund.pe ≤ 同業`
6. 其他：**續抱**

缺資料的條件一律不算符合（三態 `null`），並在 `reasons` 加「缺少…資料，相關條件不算符合」。美股沒有營收、本益比、籌碼時改寫一句「美股沒有月營收、本益比與法人籌碼資料…」；台股 ETF 同理。沒有現價時動作是「續抱」、`reasons[0]` 要使用者手動輸入現價、`triggers` 為空。

多空訊號依序檢查：月營收年增 ≥ 10%（多）／< 0（空）→ 創 52 週新高（多）／距 52 週低點 5% 內（空）→ 外資、投信連買／連賣 ≥ 3 天 → 融資單日增加 ≥ 5%（空）→ 本益比 ≤ 同業 × 0.8（多）／≥ 同業 × 1.5（空）→ 成交量 ≥ 20 日均量 2 倍（依漲跌歸多或空）→ 站上／跌破季線。

今天該注意：成交量異常（去找新聞）、已跌破或距停損 5% 內、距壓力 3% 內、月營收公布（台股個股，每月 1～10 日且資料還沒有上個月營收）、下一個財報期限在 30 天內（台股個股）、`events`、休市。

### `analyzePortfolio(rows, summary, ctx) → { risks: string[], advice: string[] }`

```js
analyzePortfolio(summary.rows, summary, {
  analyses?: { 'TW:2330': Analysis, … }, // analyzeHolding 的結果；用來彙整停損／停損觀察／分批停利
})
```

- 優先用 `summary.rows`（有 `assetWeight`）；`summary` 必須是 `summarize()` 的結果。
- 規則：持股檔數 < 3；單檔占總資產 > 40%（建議會算出要賣幾股）；同產業占總資產 > 60%（「未分類」與「ETF」不算）；現金比例 0%（全倉警示）；現金比例 < 10%（算出還差多少台幣）；沒有收盤價的持股；缺匯率。
- 沒有觸發任何風險時，`advice` 是「組合目前沒有觸發集中度與現金規則，維持定期檢視即可」。沒有持股時 `risks` 為空、`advice` 只有一句提示。

---

## 典型用法（app.js）

```js
import { tradeCosts, getBroker, brokersFor } from './fees.js';
import { buildHoldings, valueHolding, summarize, holdingKey } from './portfolio.js';
import { analyzeHolding, analyzePortfolio } from './rules.js';

// 新增交易時即時試算
const c = tradeCosts({ market, side, price, shares, code, type, date, broker: brokerId, brokerOverrides });
// 存交易：{ …, fee: feeIncluded ? 0 : c.fee, tax: c.tax, regFee: c.regFee }

const { holdings, realizedTotal, errors } = buildHoldings(transactions);
const today = meta.tw.asOf; // 或使用者的今天
const rows = holdings.map((h) => valueHolding(h, recordOf(h), {
  fx: meta.fx.USDTWD, date: today, brokerOverrides, manualPrice: manualPrices[holdingKey(h.market, h.code)],
}));
const summary = summarize(rows, { cashTWD, cashUSD, fx: meta.fx.USDTWD, realizedTotal });
const analyses = {};
for (const r of summary.rows) {
  const m = r.market === 'TW' ? meta.tw : meta.us;
  analyses[holdingKey(r.market, r.code)] = analyzeHolding(r, recordOf(r), {
    industryPe: meta.industryPe, today, events: meta.events, holidayNote: m.holidayNote,
    upcomingHolidays: m.upcomingHolidays, stopPct: settings.stopPct, userStop: userStops[holdingKey(r.market, r.code)],
  });
}
const portfolio = analyzePortfolio(summary.rows, summary, { analyses });
```
