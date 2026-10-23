# 持倉分析

免費的台股＋美股持股分析網頁：輸入自己的交易，網頁算出含手續費的損益、資產配置，並依規則給出參考提示（停損、停利、減碼、加碼、續抱）。想要文字分析的人可以填自己的 Claude API 金鑰，按「分析」才會呼叫 AI。

網址：<https://ianliu925-yyuu.github.io/portfolio-analyzer/>

**僅供參考，非投資建議。**

## 隱私

- 持股、設定、API 金鑰和分析結果只存在你自己的瀏覽器（localStorage），不會上傳到這個 repo 或任何伺服器，其他使用者看不到。
- 唯一的例外：你按「分析」時，持股摘要會從你的瀏覽器直接送到 Anthropic API（用你自己的金鑰）。
- 換裝置或清除瀏覽器資料前，請用「匯出」備份。

## 功能

- 台股、美股交易輸入（代號、股數、價位、日期），可選「價位已含手續費」。
- 依券商計算手續費與交易稅（台股各券商折扣、Firstrade、IBKR、Schwab、複委託等，可自訂）；總損益已扣手續費與預估賣出成本。
- 每日資料：收盤價、法人買賣超、融資融券、月營收、EPS、本益比、52 週高低、均線、市場新聞。
- 依「如何分析個股」八個步驟的規則分析，加上今天該注意的事件。
- AI 分析可選模型（Opus 5.5 預設、Sonnet 5.5、Haiku 5.5），不會自動執行。

## 每日資料

GitHub Actions（`.github/workflows/site.yml`）每天在開盤前抓公開市場資料：台股約 08:15（台灣時間），美股開盤前約 1 小時。GitHub 排程常延遲數小時，cron 已依實測延遲提前設定。資料存在 `data` 分支，跟網頁一起部署到 GitHub Pages。資料裡沒有任何人的持股。

## 開發

```bash
npm test                          # 單元測試（Node 20+，不需要安裝套件）
node scripts/test/ui-smoke.mjs    # 手機／電腦版面測試（需要全域安裝 playwright）
```

規格見 [docs/DESIGN.md](docs/DESIGN.md)，模組介面見 [docs/API.md](docs/API.md)。
