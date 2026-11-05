# BizIdea 全球商機雷達

每日自動收集 **香港、台灣、澳門、日本、南韓、新加坡、泰國、印度、英國、蘇格蘭、荷蘭、美國**（12 個地區）嘅網上熱搜、熱門 App 同熱門話題，最終目標係用 AI 篩出「可以做生意」嘅關鍵字，一版睇晒。

- **網址**：https://bizidea.fiveathree.workers.dev （公開，冇登入）
- **開發規格同階段**：見 [PLAN.md](PLAN.md)
- **現況更新日期**：2026-11-05

---

## 1. 現況一覽

| 階段 | 內容 | 狀態 |
|---|---|---|
| 1 | 每小時收集 Google Trends | ✅ 完成（2026-11-05 驗收：原本 6 個地區，5 個有資料，澳門 Google 冇數據）；同日加到 12 個地區 |
| 2 | AI 篩選商機 + 完整頁面 | 🟡 頁面、每日報告、🔥 商機標記、連續上升榜已上線；**彈出小卡未做** |
| 2.5 | 優化（index、cache、og:image、🔥、連續上升、小修補） | ✅ 2026-11-05 做完（包括 Workers Builds 自動部署） |
| 3 | 加來源 | 🟡 App Store、維基百科已提早做好；X（Grok）、Reddit、PTT 未做 |

首頁顯示原始熱門資料，最新每日報告揀出嘅商機關鍵字前面有 🔥，撳「🔥 只睇商機」就只顯示嗰啲。

---

## 2. 架構

```
            每小時整點（Cron Trigger "0 * * * *"）
                          │
                          ▼
┌───────────────────────────────────────────────┐
│ Cloudflare Worker「bizidea」（src/index.js，1 個檔）│
│                                               │
│  scheduled() ── 同時讀 3 個來源 × 12 個地區 ───────┼──► Google Trends RSS（每小時）
│       │                                       ├──► Apple App Store RSS（每日 1 次）
│       │                                       └──► Wikimedia Pageviews API（每日 1 次）
│       ▼                                       │
│   D1 batch upsert（UTC 00 點順手清 60 日前資料） │
│       │                                       │
│  fetch("/") ── 讀 D1 + 最新報告 hot → 砌 HTML ──┼──► Cloudflare 邊緣 cache（到下個整點 + 2 分鐘）──► 用戶
└───────┼───────────────────────────────────────┘
        ▼                                 public/og.png（靜態檔案，唔經 Worker）
  Cloudflare D1「bizidea-db」（SQLite）

每朝 08:00 claude.ai 雲端排程 ── 讀 /api/data ── 寫 reports/YYYY-MM-DD.json ── push GitHub
                                                              │
                         Worker 由 raw.githubusercontent.com 讀 ◄┘（報告頁 + 首頁 🔥）
```

| 部分 | 用咩 | 備註 |
|---|---|---|
| 定時收集 | Cloudflare Worker + Cron Trigger | 每小時；免費方案 |
| 資料庫 | Cloudflare D1（SQLite） | 得一個表 `trends`，`seen_at` 有 index；只保留 60 日 |
| Cache | Workers Caching（`wrangler.toml` 嘅 `[cache]`） | 首頁同 `/api/data` 喺 Cloudflare 邊緣 cache 到下個整點 + 2 分鐘，命中就唔使行 Worker、唔讀 D1；報告頁 5 分鐘 |
| 靜態檔案 | Workers Static Assets（`public/`） | `og.png` 分享圖 |
| 前端 | 同一個 Worker 直接出 HTML + CSS | 冇 JavaScript、冇框架、冇 build step；分頁用純 CSS radio + `:has()` |
| 每日報告 + AI 篩選 | claude.ai 雲端排程（Claude Code routine，Sonnet 5.5） | 每朝 08:00（港台）讀 `/api/data`，寫 `reports/YYYY-MM-DD.json` commit 入 GitHub；報告嘅 `hot` 就係首頁 🔥。Worker 唔叫 AI，唔使 API key |
| Log | Workers Observability | Cloudflare dashboard 睇得到每次 cron 讀到幾多條、清走幾多行 |
| 部署 | Workers Builds：push `main` 自動跑 `npx wrangler deploy` | 排除 `reports/*`，每日報告 push 唔會觸發部署 |
| 依賴 | **零 npm package** | XML 用 regex 解析；成個項目 code 大約 400 行 |

成個專案遵守「減 Code」原則（見 PLAN.md 第 1 節）：先用平台原生功能，最後先自己寫，寫最少。

---

## 3. 收集緊咩資料

| 來源 | 地區 | 頻率 | 每次幾多 | 數字代表咩 | 官方途徑 |
|---|---|---|---|---|---|
| **Google Trends「Trending Now」** | 12 個入面 11 個，**蘇格蘭都有**（用子地區 `GB-SCT`，內容同英國唔同）；**澳門冇**（Google 回 HTTP 400） | 每小時 | 每地區大約 10 條 | 大約搜尋量（例如 `500+`、`10K+`） | 公開 RSS `trends.google.com/trending/rss?geo=XX` |
| **App Store 免費榜** | 11 個（**澳門都有**；蘇格蘭冇獨立商店，併入英國） | 每日 1 次（未攞到就每小時再試；新版網址間中 502/504） | 每地區 20 個 App | 排名（冇下載數字） | Apple 官方 RSS `rss.marketingtools.apple.com` |
| **維基百科熱門頁面** | 9 個：台、日、韓、新、泰、印、英、荷、美（**港、澳冇**：瀏覽量太少，Wikimedia 唔公開；**蘇格蘭冇**：只有國家級數據） | 每日 1 次，讀前一日 | 每地區 20 頁（已剔走首頁、Special: 頁） | 前一日瀏覽量 | Wikimedia 官方 Pageviews API |

**全部都係公開、官方、免費、唔使 API key** 嘅途徑；冇偽裝瀏覽器、冇用 proxy。Wikimedia 規定要表明身份，所以請求帶 `BizIdea/1.0 (https://github.com/fiveathree/bizidea)` User-Agent。

### 資料表 `trends`

```sql
CREATE TABLE trends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  geo TEXT NOT NULL,       -- HK TW MO JP KR SG TH IN GB GB-SCT NL US
  source TEXT NOT NULL,    -- google_trends / app_store / wikipedia
  keyword TEXT NOT NULL,   -- 熱搜字 / App 名 / 維基頁面標題
  traffic INTEGER,         -- Google：大約搜尋量；維基：瀏覽量；App Store：NULL
  news_url TEXT,           -- Google：相關新聞；App Store：App 頁；維基：維基頁
  seen_at TEXT NOT NULL,   -- Google：RSS pubDate；App Store / 維基：資料日期 T00:00:00Z
  UNIQUE (geo, source, keyword, seen_at)
);
CREATE INDEX idx_trends_seen ON trends(seen_at);
```

- **只保留 60 日**：每日 UTC 00 點嗰次 cron 刪走更舊嘅行，夠連續上升榜用。
- **唔會重複寫**：`seen_at` 用來源本身嘅時間（唔係收集時間），所以每小時重讀同一條熱搜只會 upsert 同一行（流量有變就更新）。
- **App Store 排名**：冇獨立欄位，靠寫入次序（`id`）保存排名。
- **壞資料**：單條 Google 熱搜 `pubDate` 讀唔到就跳過嗰條，唔會令成個地區冇數據。
- **數量**（2026-11-05 傍晚）：總共大約 1,400 行，由 2026-11-03 開始；每日寫入大約幾千行，遠低於免費額度。
- **每次 cron 對外請求**：最多 12 + 11 + 9 = 32 個（Worker 免費方案上限 50）。結構上冇數據嘅組合（蘇格蘭 App Store、港澳同蘇格蘭維基）直接跳過，唔會每個鐘白試。

---

## 4. 網站功能（而家有嘅）

- **一版睇晒**：桌面版 12 個地區分兩行（每行 6 個），每個地區顯示 10 條，唔使捲動；太長嘅字用「…」截斷，滑鼠指住顯示全名。
- **3 個來源分頁**：Google 熱搜／App Store 熱門／維基熱門，一撳 12 個地區一齊轉。
- **🔥 商機標記**：最新每日報告 `hot` 入面嘅關鍵字前面加 🔥；「🔥 只睇商機」純 CSS 切換，只顯示 🔥。未有報告就唔顯示呢個掣。首頁 cache 到下個整點，所以 08:00 報告出咗之後，大約 09:02 首頁先見到新 🔥。
- **📈 連續上升榜**：過去 7 日（台北時間分日）Google 熱搜出現 ≥ 2 日嘅關鍵字，最多 10 個，🔥 排前；顯示日數同地區簡稱（例如「利率 2日 港台」）。桌面版喺 footer 上面一行，手機版係地區分頁後面嘅「📈 連續上升」分頁。資料唔夠就顯示「資料累積中」。
- **手機版**：來源分頁 1 行 + 地區分頁 2 行（每行 6 個，位置固定）+「連續上升」1 行，一次睇一個地區。
- **鍵盤**：用 Tab 同方向鍵可以轉分頁，有外框提示。
- **排序**：Google 熱搜按過去 24 小時最高流量；App Store 按當日排名；維基按瀏覽量。
- **撳關鍵字**：Google 熱搜開相關新聞（冇新聞就開 Google 搜尋）；App Store 開 App 頁；維基開維基頁。外來連結唔係 `http(s)://` 開頭就改用 Google 搜尋。
- **冇數據**嘅地區顯示「暫無數據」，唔會報錯。
- 標題列顯示「每小時整點更新，下次 HH:00（港台時間）」。
- 深色／淺色跟系統；內嵌 SVG 雷達 favicon；繁體中文介面。
- **分享圖**：首頁同報告頁有 `og:title`、`og:description`、`og:image`（`/og.png`，1200×630 PNG）、`twitter:card`，FB／LINE／WhatsApp 分享會見到圖。
- **📊 每日商業分析報告**（`/report`，舊報告 `/report/YYYY-MM-DD`）：今日商機（最多 5 個，有商機分同證據）、跨地區趨勢、同之前比較、12 個地區各一句。桌面一版睇晒；手機分「商機／趨勢／各地區」3 個分頁；有上一日／下一日連結。
- **`/api/data`**：JSON，每個地區每個來源最多 20 條，俾報告排程讀。
- **Cache**：首頁同 `/api/data` 喺 Cloudflare 邊緣 cache 到下個整點 + 2 分鐘（瀏覽器 60 秒）；報告頁 5 分鐘。
- **唔收集任何用戶資料**：冇登入、冇 cookie、冇分析追蹤。

### 未有（PLAN 階段 2）

- 撳關鍵字彈出小卡（AI 點子、流量、連結）

---

## 5. 已知問題同限制

| 問題 | 影響 | 處理 |
|---|---|---|
| **D1 免費寫入額度係成個 Cloudflare 帳戶共用**（每日 10 萬行） | 2026-11-04 帳戶入面另一個項目一次過寫咗 13 萬行，令 bizidea 由 14:00 起寫唔到，直至 UTC 午夜 | bizidea 自己每日只寫大約一千幾行；收集失敗只會缺嗰個鐘，下個鐘照常再收集 |
| Google Trends 每地區只有大約 10 條 | 唔係完整長尾；數字只係大約 | 用 App Store、維基補充 |
| 澳門冇 Google Trends、港澳冇維基；蘇格蘭冇 App Store 同維基 | 澳門只有 App Store；蘇格蘭只有 Google 熱搜 | 頁面顯示「暫無數據」；footer 有寫明 |
| Apple 新版 RSS 間中 504 | 嗰個鐘冇 App Store 新資料 | 每日來源未攞到就每小時再試 |
| Apple 舊版 iTunes RSS 喺 Cloudflare 上次次 403 | 唔用得 | 本機 `wrangler dev` 測試結果同正式環境相反，要用 `wrangler dev --remote` 先測得準 |
| Google Trends 新版「探索」頁要登入先有內容 | 唔可以連去 Explore | 改為連去相關新聞 |
| 時區 | Cron 用 UTC；頁面顯示港台時間（UTC+8） | 每日來源用 UTC 日期分日 |

---

## 6. 檔案

```
bizidea/
├── src/index.js     # Worker：收集（scheduled）+ 網頁（fetch），大約 400 行
├── schema.sql       # D1 建表（trends + seen_at index）
├── public/og.png    # 分享圖 1200×630
├── reports/         # 每日報告 JSON（排程寫入，有 hot）+ index.json（日期清單，新到舊）
├── docs/            # report-prompt.md（排程提示）、report-example.json（報告範例）
├── wrangler.toml    # Worker 名、每小時 cron、D1 綁定、靜態檔案、cache、observability
├── PLAN.md          # 開發規格、階段、驗收標準
└── README.md        # 呢份：現況
```

---

## 7. 想請人 review 嘅問題

1. 揀嘅 3 個數據來源，對「搵商機」有冇用？有冇其他**免費、官方**、唔使繞過防爬蟲嘅來源，覆蓋港澳台日英荷？
2. `trends` 一個表裝晒所有來源（`traffic` 喺唔同來源意思唔同）、App Store 靠 `id` 保存排名，呢個設計夠唔夠用？
3. AI 篩選靠每日報告嘅 `hot`（要同 `/api/data` 嘅 `keyword` 一字不差），排程提示 `docs/report-prompt.md` 有冇更好寫法？
4. 純 CSS 分頁（radio + `:has()`）同零 JavaScript 嘅做法，喺手機同舊瀏覽器有冇風險？
5. 仲有冇地方可以再「減 Code」？
