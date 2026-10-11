# 持倉分析 — 設計規格

給所有人用的免費持股分析網頁。每個使用者輸入自己的交易，網頁在使用者自己的瀏覽器裡算出損益、配置、依規則的參考提示；想要文字分析的人可以填自己的 Claude API 金鑰，按「分析」才呼叫 AI。

## 0. 原則

- **純靜態網頁**（GitHub Pages），沒有後端、沒有登入。
- **持股只存在使用者的瀏覽器**（localStorage），永遠不會上傳到我們的 repo 或任何伺服器。唯一的例外：使用者自己按「分析」時，持股摘要會從他的瀏覽器直接送到 Anthropic API（用他自己的金鑰）。
- **共用每日資料**：GitHub Actions 每天抓公開市場資料，寫成 JSON，跟網頁一起部署。資料裡沒有任何人的持股。
- 繁體中文介面；台股慣例 **紅漲綠跌**（獲利紅、虧損綠）；數字等寬字體、千分位；手機優先；深色／淺色模式。
- 「建議」一律寫成「依規則的參考提示」，頁首與頁尾都有一行免責聲明：僅供參考，非投資建議。

## 1. Repo 結構

```
index.html               網頁（載入 assets/ 的 ES modules）
assets/style.css
assets/app.js            UI 與狀態
assets/portfolio.js      交易 → 持股（平均成本法）、已實現損益（純函式）
assets/fees.js           手續費與交易稅（純函式）＋券商預設表
assets/rules.js          規則分析（純函式）
assets/data.js           讀每日資料、代號搜尋
assets/ai.js             Claude API 分析（使用者自己的金鑰）
scripts/fetch-data.mjs   每日資料程式（Node 20，無外部套件）
scripts/lib/*.mjs        各資料來源的抓取與解析
scripts/test/*.test.mjs  node --test 單元測試（含 fixtures）
.github/workflows/site.yml  每日資料 + 部署 GitHub Pages
docs/DESIGN.md           本文件
```

## 2. 部署與每日資料流程

- 一個 workflow `.github/workflows/site.yml`，觸發：`push` 到 main、`schedule`、`workflow_dispatch`。
- **排程**（GitHub cron 用 UTC，且常延遲，故避開整點、提早一點）：
  - 台股開盤前：`17 23 * * 0-4`（台灣 07:17，週一到週五早上），抓前一交易日台股收盤資料＋前一晚美股收盤。
  - 美股開盤前 1 小時：`17 12 * * 1-5`（夏令 EDT：開盤 13:30 UTC）與 `17 13 * * 1-5`（冬令 EST：開盤 14:30 UTC）。這兩次主要更新新聞與匯率；程式會偵測現在是否為 DST，非對應季節的那次直接跳過。
- **資料存放**：`data` 孤兒分支（orphan branch），每次執行用單一 commit 強制推送（`git push --force`），所以 repo 不會越長越大。內容：
  - `history/` 每檔股票最近約 260 個交易日的收盤與成交量、最近 5 天的法人與融資資料（用來算 52 週高低、均線、連買連賣）。網頁不讀這裡。
  - `latest/` 網頁要讀的檔案（見第 3 節）。
- **部署**：同一個 workflow 把 main 的網頁檔案＋ `data` 分支的 `latest/` 複製到 `_site/data/latest/`，用 `actions/upload-pages-artifact` + `actions/deploy-pages` 部署。使用者只要在 Settings → Pages → Source 選「GitHub Actions」一次。
- `push` 觸發時不重抓資料（直接用 `data` 分支現有的 `latest/` 部署）；`data` 分支還不存在時才抓。
- 某個來源失敗不能讓整個工作失敗：保留上一次成功的資料，並在 `meta.json` 的 `status` 標記該來源 `stale` 或 `error`。全部來源都失敗才讓工作失敗。

## 3. 每日資料格式（`data/latest/`）

### 3.1 `meta.json`

```json
{
  "schema": 1,
  "generatedAt": "2026-10-10T23:17:05Z",
  "tw": {
    "asOf": "2026-10-08",
    "nextTradingDay": "2026-10-12",
    "holidayNote": "10/09–10/11 國慶連假休市",
    "upcomingHolidays": [{ "date": "2026-10-09", "name": "國慶日" }],
    "index": { "taiex": { "close": 0, "change": 0, "changePct": 0 }, "tpex": { "close": 0, "change": 0, "changePct": 0 } }
  },
  "us": {
    "asOf": "2026-10-09",
    "nextTradingDay": "2026-10-12",
    "holidayNote": "",
    "upcomingHolidays": [],
    "index": { "spx": {}, "ndx": {}, "sox": {} }
  },
  "fx": { "USDTWD": 32.15, "date": "2026-10-09", "source": "臺灣銀行即期賣出匯率" },
  "news": {
    "tw": [{ "title": "", "link": "", "source": "", "pubDate": "" }],
    "us": []
  },
  "industryPe": { "TW:半導體業": 22.4 },
  "events": [{ "date": "2026-11-10", "title": "10 月營收公布期限（台股）" }],
  "status": { "twse_quotes": "ok", "tpex_quotes": "ok", "t86": "ok", "margin": "ok", "revenue": "ok", "eps": "ok", "pe": "ok", "us_quotes": "ok", "history": "ok", "fx": "ok", "news": "ok" }
}
```

### 3.2 代號索引 `index-tw.json`、`index-us.json`

給輸入框自動完成用，陣列：`[["2330","台積電","stock"],["0050","元大台灣50","etf"], ...]`（第三欄：`stock` / `etf` / `bond_etf`）。

### 3.3 個股資料分桶 `tw/{bucket}.json`、`us/{bucket}.json`

- 台股 bucket = 代號前 2 碼（例：`23.json`）；美股 bucket = 代號第 1 個字母（例：`A.json`）。網頁只載入使用者持股需要的桶。
- 每個檔案是 `{ "代號": record }`。

台股 record：

```json
{
  "code": "2330", "name": "台積電", "market": "TW", "exchange": "TWSE", "type": "stock",
  "industry": "半導體業",
  "close": 1025, "change": 15, "changePct": 1.49, "open": 1010, "high": 1030, "low": 1005,
  "volume": 31234567,
  "hist": { "days": 250, "d5Pct": 2.1, "d20Pct": -3.4, "hi52": 1100, "lo52": 780, "ma20": 1001.5, "ma60": 980.2,
            "avgVol20": 28000000, "low20": 960, "high20": 1060 },
  "chips": { "date": "2026-10-08", "foreign": 1234000, "trust": -20000, "dealer": 5000,
             "foreignStreak": 3, "trustStreak": -1, "foreign5": 4500000, "trust5": 0, "dealer5": 0,
             "margin": 12345, "marginChg": -120, "short": 456 },
  "fund": { "revYm": "2026-09", "rev": 0, "mom": 1.97, "yoy": 11.37, "ytdYoy": 19.25,
            "eps": 12.5, "epsPeriod": "2026Q2", "eps4q": 45.2, "pe": 22.7, "pb": 6.1, "yield": 1.6 }
}
```

- 法人買賣超 `foreign/trust/dealer` 單位：**股**；`foreignStreak`：連續買超天數（正）或連續賣超天數（負）。
- 融資 `margin/marginChg/short` 單位：**張**。
- `volume` 單位：**股**。
- 缺資料的欄位直接省略或為 `null`，網頁要能處理。

美股 record：

```json
{
  "code": "AAPL", "name": "Apple Inc.", "market": "US", "type": "stock",
  "sector": "Technology", "industry": "Computer Manufacturing",
  "close": 0, "change": 0, "changePct": 0, "volume": 0, "marketCap": 0,
  "hist": { "days": 250, "d5Pct": 0, "d20Pct": 0, "hi52": 0, "lo52": 0, "ma20": 0, "ma60": 0, "avgVol20": 0, "low20": 0, "high20": 0 }
}
```

美股範圍：市值 ≥ 20 億美元的普通股（約涵蓋 S&P 500 與 Nasdaq-100）＋常見 ETF 清單。其他代號網頁讓使用者手動輸入現價。

## 4. 手續費與交易稅（`assets/fees.js`）

- 台股：手續費 = 成交金額 × 0.1425% × 折扣，**無條件捨去到整數**，不足最低手續費以最低計（整股、零股最低可不同，依券商設定）。交易稅只在賣出時收：一般股票 0.3%、ETF 0.1%、債券 ETF 依現行免徵規定（以 `fees.js` 內的日期判斷），無條件捨去。
- 若券商是「月退」制：下單當下仍以原價 0.1425% 收取，月底退回折扣差額。計算成本時以**折扣後**為準，並在介面標示「月退」。
- 美股：依券商設定（Firstrade 零佣金、IBKR 每股計價、複委託百分比＋最低美元）。賣出另計 SEC 規費與 FINRA TAF，四捨五入到 0.01 美元。
- 券商預設表放在 `fees.js` 的 `BROKERS` 常數，每筆都有 `source` 與 `asOf`。使用者可以改折扣與最低手續費，存在 localStorage。
- 新增交易時有「價位已含手續費」開關：
  - 關（預設）：成本 = 價位 × 股數 + 買進手續費。
  - 開：使用者填的是含費用的每股成本，直接當成本，不再加手續費。
- **總損益一定扣費用**：未實現淨損益 = 市值 − 預估賣出手續費 − 預估交易稅 − 持有成本（成本已含買進手續費）。介面以淨損益為主，帳面損益為輔。

## 5. 持股計算（`assets/portfolio.js`）

- 交易紀錄：`{ id, market, code, side: "buy"|"sell", shares, price, feeIncluded, fee, tax, date, broker }`。
- 平均成本法：買進時總成本增加（價金＋手續費），賣出時按平均成本減少持有成本，已實現損益 = 賣出淨收入（扣手續費、稅）− 對應平均成本。
- 美股以美元計，總覽用 `meta.fx.USDTWD` 換成台幣；明細表顯示原幣。
- 現金：使用者可分別輸入台幣與美元現金，算現金比例。

## 6. 規則分析（`assets/rules.js`）

依《如何分析個股：方法說明》的 8 個步驟，把能用數字判斷的部分寫成規則。每檔股票輸出：

```js
{ action: "加碼"|"續抱"|"分批停利"|"減碼"|"停損"|"停損觀察",
  reasons: ["..."], triggers: ["跌破 550 減碼"], bull: ["..."], bear: ["..."], watch: ["..."],
  levels: { cost, price, support, resistance, stop, hi52, lo52 } }
```

關鍵價位：
- 支撐 `support` = 近 20 日低點（`hist.low20`）；若季線 `ma60` 低於現價且高於近 20 日低點，取季線。`hist.low20`、`high20`、`avgVol20` 取資料日之前的 20 個交易日（不含當天），收盤才能跌破支撐、成交量才能跟前 20 日均量比。
- 壓力 `resistance` = 近 20 日高點；若現價已在近 20 日高點附近（差距 < 1%），改用 52 週高點。
- 停損 `stop` = 使用者自訂優先；否則取 max(成本 × (1 − 預設停損%)，支撐 × 0.97)。預設停損 % 可在設定修改（預設 10%）。

判斷順序（先符合者為主要動作，其他符合的條件放進 reasons）：
1. **停損**：現價 < 停損價。
2. **停損觀察**：現價距停損價 ≤ 3%。
3. **分批停利**：報酬率 ≥ 20% 且（本益比 > 同產業中位數 × 1.5，或 52 週位置 ≥ 85%）。
4. **減碼**：單檔占比 > 40%；或籌碼轉弱（外資連賣 ≥ 3 天且融資增加）且月營收年增 < 0。
5. **加碼**：報酬率在 −5%～+10%、現價 > 季線、月營收年增 ≥ 20%、外資 5 日買超、本益比 ≤ 同產業中位數（缺資料的條件不算符合）。
6. 其他：**續抱**。

多空訊號（bull / bear，各最多 3 點，依重要性排序）：營收年增或衰退、創 52 週新高或接近低點、法人連買／連賣、融資大增、本益比相對同業、成交量 ≥ 20 日均量 2 倍（「有事情發生，去找新聞」）、站上／跌破季線。

今天該注意（watch）：成交量異常、接近停損或壓力、月營收公布日（每月 10 日前）、季報期限（Q1 5/15、Q2 8/14、Q3 11/14、年報 3/31）、休市提醒。

組合層面：持股檔數 < 3、單檔占比 > 40%、同產業占比 > 60%、現金比例 0%（全倉警示）、現金比例 < 10%。

## 7. AI 分析（`assets/ai.js`）

- 只有使用者按「分析」才執行，沒有自動分析。
- 金鑰：使用者自己的 Anthropic API 金鑰，只存在他的瀏覽器（localStorage），可隨時清除；介面說明金鑰只會送到 api.anthropic.com。
- 模型下拉選單：Claude Opus 5.5（`claude-opus-5-5`，預設）、Claude Sonnet 5.5（`claude-sonnet-5-5`）、Claude Haiku 5.5（`claude-haiku-5-5`），旁邊顯示每百萬 token 價格與每次預估費用；分析完依實際 usage 顯示這次花了多少。
- 用官方 SDK：`import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.127.0/+esm"`，`new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`。
- 輸出用 structured outputs（`output_config.format` 的 `json_schema`），格式與第 6 節相同欄位：每檔 `action/summary/reasons/trigger/bull/bear/watch`，加上組合 `risks/advice`。
- Opus 5.5 與 Sonnet 5.5 開啟伺服器端 refusal fallback（`client.beta.messages.create`、`betas: ["server-side-fallback-2026-07-01"]`、`fallbacks: "default"`）；Haiku 不加。一律檢查 `stop_reason`（`refusal`、`max_tokens`）再讀內容。
- 給 AI 的資料：每檔持股的計算結果與每日資料、規則分析結果、大盤新聞；個股新聞由網頁抓 Google News RSS（透過公開 CORS proxy，失敗就略過並告知 AI 沒有個股新聞）。
- 結果存在 localStorage（含日期與模型），顯示在個股詳細卡與組合建議區，標示「AI 分析（日期、模型）」。

## 8. 網頁版面（依大綱）

1. 頁首：標題「持倉分析」、資料日期（以 YYYY-MM-DD 收盤計）、下一個交易日、休市提示、免責聲明、主題切換、設定。
2. 新增交易：台股／美股切換、代號（自動完成）、買進／賣出、股數、價位、日期、券商、「價位已含手續費」開關、即時顯示手續費與稅、加入。另有現金輸入。
3. 總覽卡片（一排 4 張）：總市值、總成本（含買進手續費）、未實現淨損益（金額＋%，下方小字帳面損益）、現金比例（0% 顯示全倉警示）。下方一行：今日損益、已實現損益。
4. 資產配置：圓環圖（個股／產業切換）＋集中度風險說明。
5. 持股明細表：代號、名稱、市場、股數、每股成本、收盤價、漲跌%、市值、未實現淨損益、報酬率、占比、建議標籤（彩色）。點一列跳到詳細卡。手機可橫向捲動。
6. 個股詳細卡：標頭、行情（52 週位置進度條）、價位刻度圖（成本、現價、支撐、壓力、停損、52 週高點）、籌碼（法人正負長條、融資融券、券資比）、基本面（月營收、EPS、本益比 vs 同業）、多空觀點兩欄、今天該注意、建議與理由＋觸發條件、資料來源連結。停損價可編輯。
7. 整體組合建議：風險摘要＋具體建議（規則＋AI）。
8. AI 分析區：金鑰、模型、預估費用、「分析」按鈕、結果。
9. 交易紀錄：可編輯、刪除；匯出／匯入 JSON（備份）、下載 CSV。
10. 頁尾：資料來源、免責聲明、資料更新時間。

## 9. 測試

- `node --test scripts/test/` 涵蓋：各資料來源解析（用 fixtures）、history 合併與指標計算、fees、portfolio、rules。
- 網頁用 Playwright 在 390px 與 1100px 寬度截圖，確認沒有橫向捲動、數字正確。

## 10. 查證結果帶來的決定（2026-10-10）

完整查證紀錄在 `docs/research/*.json`（twse、tpex、us_misc、tw_fees、us_fees）。寫程式時以那裡的欄位名稱為準。

### 資料來源
- **台股上市**（全部已實際抓到）：`STOCK_DAY_ALL`（含 ETF）、`BWIBBU_ALL`（本益比、殖利率、淨值比）、`t187ap05_L`（月營收，含中文產業別；約每月中旬才更新）、`t187ap14_L`（EPS，**今年累計**，不是單季）、`MI_MARGN`（openapi 沒有日期欄位）、`MI_INDEX`（加權指數）、`holidaySchedule`（要排除名稱含「交易日」的列）。三大法人只有 www.twse.com.tw：先試 `/rwd/zh/fund/T86?...`，失敗再試舊路徑 `/fund/T86?response=json&date=YYYYMMDD&selectType=ALLBUT0999`，檢查 `stat == "OK"`，單位是股、數字有千分位逗號。融資有日期的版本同理（`/exchangeReport/MI_MARGN?response=json&date=...&selectType=ALL`）。
- **台股上櫃**（這次無法直接抓，欄位來自別人存下的原始回應，第一次 Actions 執行要確認）：`tpex_mainboard_quotes`（含 ETF；沒成交時價格是 `"----"`）、`tpex_mainboard_peratio_analysis`（N/A、--、- 都當成缺值）、`mopsfin_t187ap05_O`、`mopsfin_t187ap14_O`（EPS 欄位 `基本每股盈餘`，年欄位叫 `Year`）、`tpex_mainboard_margin_balance`（單位張）、`tpex_3insti_daily_trading`（欄位名稱有前導空白和奇怪空格，要用「去掉所有空白」後的名稱比對；單位股）、`tpex_index`。
- 日期多為民國年 `YYYMMDD`（加 1911）。所有數值都是字串，空字串、`--`、`----`、`N/A`、`-` 一律當缺值，數字要去掉逗號。
- 產業別名稱直接用月營收或 EPS 資料裡的中文 `產業別`，用代號對應。
- **美股**：Nasdaq screener（`download=true` 時股票在 `data.rows`、ETF 在 `data.data.rows`，要帶瀏覽器 User-Agent、`Accept: application/json`、`Referer: https://www.nasdaq.com/`），值是 `"$123.45"`、`"-3.47%"` 這種字串。ETF 列沒有成交量和市值。
- **歷史資料**：Yahoo chart v8（`chart.result[0]`），台股上市 `2330.TW`、上櫃 `6488.TWO`，要帶瀏覽器 User-Agent。2025–2026 常被 429 擋，要限速（同時最多 2–3 個請求、間隔 ≥ 300ms、429 時指數退避），每次執行最多補 N 檔，沒補完下次繼續。
- **匯率**：臺灣銀行 CSV `https://rate.bot.com.tw/xrt/flcsv/0/day`（UTF-8 BOM、每行結尾多一個逗號；USD 列即期買入 `cols[3]`、即期賣出 `cols[13]`），失敗改用 `https://open.er-api.com/v6/latest/USD` 的 `rates.TWD`。
- **新聞**：Google News RSS。只顯示標題、來源、時間和連結，不轉載內文。
- **美股休市**（NYSE 官網）2026：1/1、1/19、2/16、4/3、5/25、6/19、7/3、9/7、11/26、12/25；提早 13:00 收盤：11/27、12/24。2027：1/1、1/18、2/15、3/26、5/31、6/18、7/5、9/6、11/25、12/24；提早收盤 11/26。2028 尚未公布。
- 夏令時間 2026：3/8–11/1；2027：3/14–11/7。

### 手續費預設
- 台股券商折數因人而異，預設表只是常見值，使用者一定要能自己改。整股最低多為 20 元、零股多為 1 元；元以下無條件捨去。下單股數不是 1000 的倍數時，拆成整股部分和零股部分各自計費、各自套用最低手續費。
- 預設券商清單與數值取自 `docs/research/tw_fees.json`（每家附 `confidence`，介面上低信心的標「僅供參考」）。玉山是累進級距（當月 0–100 萬 6 折、100–300 萬 5 折、300 萬以上 3.8 折），計算時用第一級距即可並註明。元富已於 2026-04-06 併入台新。
- 證交稅：股票 0.3%、ETF／ETN 0.1%、被動式債券 ETF（代號 `00` 開頭且結尾 `B`）現行法停徵到 2026-12-31（延長到 2036 的草案尚未三讀）；2027 年以後的賣出先以 0.1% 估，並在介面註明。
- 美股：Firstrade 零佣金；IBKR Pro Fixed 每股 0.005 美元、每筆最低 1 美元、最高成交金額 1%；Schwab International 零佣金；複委託：國泰 0.08%（個股、無最低）、ETF 每筆 3 美元，永豐 0.08%（最低 0.01 美元，當月 5 萬美元內），玉山 0.08%（免低收），元大 0.1%（無低消，另有每筆 3 美元系統服務費，適用範圍不明，預設不計並註明），富邦 0.25%（低信心）。
- 美股賣出規費：SEC fee 成交金額 × 0.0000206（交易日 2026-04-02 起；2025-05-13 到 2026-04-01 為 0；更早 0.0000278），無條件進位到 0.01 美元。FINRA TAF 每股 0.000195 美元、每筆上限 9.79 美元，**2026-10-01 到 2026-12-31 暫停收取**，2027 起恢復。
