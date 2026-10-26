# 📈 單筆投入 vs 定期定額（Lump Sum vs DCA）

用真實歷史資料回測「一次全部買進」和「分批慢慢買進」的差別，附勝率分析、資產配置壓力測試、波動統計、看盤牆，以及一整頁的觀念教學。

🔗 網站：<https://zlo-25.github.io/Lump-Sum-v.s.-DCA/>

## 功能

| 分頁 | 回答的問題 |
|---|---|
| 📈 單筆 vs 定期定額 | 從某一天開始，一次買和分批買，誰的期末資產多？為什麼？ |
| 🎲 勝率分析 | 把過去每個月都當起點，單筆投入贏的機率有多高？ |
| 📚 觀念教室 | 公平比較的規則、平均成本迷思、怎麼選（可直接拿去教人） |
| 💼 資產配置 | 股債配置 + 再平衡 + 退休提領，資金撐得住嗎？ |
| ⚡ 波動與風險 | 大漲大跌頻率、最長連漲連跌、最大回撤、索提諾比率 |
| 🖥️ 看盤牆 | 多格 TradingView 圖表自動輪播 |

設定好的回測可以直接複製網址分享，對方打開就會看到同樣的結果。

## 架構：為什麼不需要伺服器

舊版是 Streamlit（Python 伺服器跑在 GCP Cloud Run），每次按按鈕都由伺服器即時呼叫 yfinance。GitHub Pages 只能放靜態檔案，所以改成「先把資料準備好，計算交給瀏覽器」：

```
舊版（GCP Cloud Run）
  瀏覽器 ──按鈕──▶ Streamlit 伺服器 ──▶ yfinance ──▶ Yahoo
         ◀──畫面──  (Python 計算)

新版（GitHub Pages）
  ┌─────────── 每個平日 06:30（台灣時間）───────────┐
  │ GitHub Actions                                  │
  │   1. npm test           確認計算邏輯沒壞         │
  │   2. fetch_data.py      yfinance → data/*.json  │
  │   3. 部署到 GitHub Pages                        │
  └─────────────────────────────────────────────────┘
                         │
  瀏覽器 ──▶ 下載 index.html + data/*.json
         └─▶ engine.js 在瀏覽器裡計算、Plotly 畫圖
```

| 檔案 | 用途 |
|---|---|
| `index.html`、`assets/css/style.css` | 頁面與樣式 |
| `assets/js/engine.js` | **所有計算邏輯**（純函式，可單獨測試） |
| `assets/js/app.js` | 畫面互動、圖表 |
| `scripts/tickers.json` | 要下載哪些標的 |
| `scripts/fetch_data.py` | 下載價格存成 JSON |
| `tests/engine.test.mjs` | 計算邏輯的單元測試 |
| `.github/workflows/deploy.yml` | 自動更新資料並部署 |
| `legacy-streamlit/` | 舊版程式碼（僅供參考，已不使用） |

### 搬家的取捨

| 項目 | 舊版 | 新版 | 影響 |
|---|---|---|---|
| 可查詢的標的 | 任何 Yahoo 代號 | `scripts/tickers.json` 清單（約 40 檔）+ 自行上傳 CSV | 想加標的要改清單再 push |
| 資料新鮮度 | 即時 | 每個平日更新一次 | 回測用途沒差 |
| 看盤牆群組 | 存在 GCS，所有裝置共用 | 存在瀏覽器 localStorage | 換電腦要用「匯出 / 匯入」 |
| 費用 / 維運 | Cloud Run 計費、冷啟動慢 | 免費、秒開 | 👍 |

## 新增標的

編輯 `scripts/tickers.json`，在任一群組加一行（代號用 Yahoo Finance 的寫法，例如台股 `2412.TW`）：

```json
{"symbol": "2412.TW", "name": "中華電", "note": "新台幣計價"}
```

push 到 main 後，GitHub Actions 會自動抓資料並重新部署（約 2 分鐘）。不想改程式的話，也可以在網站右上角「📂 上傳 CSV」（需要 `Date` 和 `Close` 或 `Adj Close` 欄位，例如從 Yahoo Finance 下載的歷史資料）。

## 計算方式（與舊版的差異）

```
DCA 每日總資產 = 未投入現金 × (1 + 現金利率)^(天數/365) + 累積股數 × 當日還原收盤價
單筆每日總資產 = (總金額 ÷ 第一天價格) × 當日還原收盤價
總報酬率 = 期末 ÷ 總金額 − 1          （兩種策略同一個分母）
CAGR     = (期末 ÷ 總金額)^(1/年數) − 1
```

這次改版修正 / 新增的地方：

1. **DCA 扣款間隔修正**：舊版用 `pd.date_range(開始, 開始+12個月, periods=12)`，最後一筆落在第 12 個月，間隔變成 12/11 ≈ 1.09 個月。新版第 k 筆在第 k × (月數/次數) 個月，「12 個月分 12 次」就是每月同一天扣款。
2. **資產配置的年度標的報酬**：舊版從「每年第一個交易日收盤」起算，漏掉了第一天的漲跌；新版改從「上一年最後收盤」起算。
3. **有提領時的年化報酬**：舊版用「期末餘額 ÷ 期初」，提領越多年化越低，誤把提領當虧損。新版改用時間加權報酬（TWR）。
4. **索提諾比率**：改用標準的下檔標準差（所有日子都算，正報酬視為 0）；年化時依資料自動判斷每年交易日數（股票約 252、加密貨幣約 365）。
5. **提醒實際起點**：選了 1929 年但標的 1993 年才上市時，舊版會默默從 1993 開始；新版會明確提示。
6. **新增**：現金利率選項、DCA 平均成本 vs 平均價格、平均持股比例、滾動勝率分析、提領通膨調整、混合幣別警告。

## 本機開發

```bash
# 1. 下載價格資料（需要網路）
pip install -r scripts/requirements.txt
python scripts/fetch_data.py

# 2. 啟動本機伺服器（直接雙擊 index.html 會因為瀏覽器安全限制讀不到 JSON）
python -m http.server 8000
# 打開 http://localhost:8000

# 3. 跑測試
npm test
```

## 部署設定（第一次）

Repository → **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。之後每次 push 到 main 或每個平日早上都會自動部署。

---

資料來源：Yahoo Finance（透過 yfinance）。僅供教育用途，不構成投資建議。
