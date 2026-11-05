# BizIdea 全球商機雷達 — 開發計劃 (PLAN.md)

> 俾 Claude Code 用嘅開發規格。由上至下按「階段」做，每個階段做完要通過「驗收標準」先做下一階段。

## 0. 一句講晒

每日自動收集 **香港、台灣、澳門、日本、南韓、新加坡、泰國、印度、英國、蘇格蘭、荷蘭、美國**（12 個地區；2026-11-05 由 6 個加到 12 個）嘅網上熱搜同熱話，用 AI 篩走純新聞 / 娛樂，淨低「可以變成生意」嘅關鍵字，喺**一版睇晒**嘅網頁顯示。

## 1. 必須遵守嘅開發原則（「減 Code」，按次序）

1. 先確認功能真係需要，唔需要就唔做。
2. 先確認項目入面未有。
3. 優先用標準庫。
4. 優先用瀏覽器、資料庫、平台原生功能（例如 Cloudflare Cron、D1 SQL）。
5. 優先用現成 package。
6. 最後先自己寫，而且寫最少、正確可用嘅 code。

其他硬性要求：
- 網頁要**一個畫面睇晒**，盡量唔使上下或左右捲動（手機版可以分 tab，唔好長捲）。
- 一定要有 **favicon** 同 **分享圖（og:image）**。
- **唔收集任何用戶個人資料**，v1 冇登入、冇付款。
- 所有 API key 用 Cloudflare Secrets，**唔可以寫入 code 或 commit 入 repo**。
- 只用**公開 / 官方**數據途徑，唔做繞過防爬蟲嘅手法（唔用 unblocker proxy、唔偽裝瀏覽器）。

## 2. 技術架構（最簡單版本）

| 部分 | 用咩 | 原因 |
|---|---|---|
| 定時收集 | Cloudflare Worker + Cron Trigger（每小時） | 免費額度夠用，原生定時 |
| 資料庫 | Cloudflare D1 | 原生 SQL，存歷史先計到「連續上升」 |
| AI 篩選 | claude.ai 雲端排程（每日 1 次，寫每日報告） | 報告入面嘅 `hot` 揀出商機關鍵字，首頁加 🔥；Worker 唔叫 AI，唔使 API key |
| 前端 | 同一個 Worker 出一版靜態 HTML（無框架） | 唔使 build step |
| X (Twitter) 熱話 | Grok API `x_search`（階段 3 先加） | 比 X 官方 API 平好多 |

唔要：React/Vue、伺服器、用戶系統、付款。

## 3. 數據來源

### 階段 1（必做）
**Google Trends「Trending Now」RSS**（公開、免費）
- 網址格式：`https://trends.google.com/trending/rss?geo={GEO}`
- GEO：`HK`、`TW`、`MO`、`JP`、`KR`、`SG`、`TH`、`IN`、`GB`、`GB-SCT`（蘇格蘭，子地區）、`NL`、`US`
- **澳門 `MO` 未確認有冇數據**：第一次跑要測試，冇數據就喺頁面標「暫無數據」，唔好報錯。
- 每個地區大約 10–20 條，有「大約流量」（例如 `200+`、`50K+`）同相關新聞連結。
- 要用 XML 解析（Worker 內建冇 DOMParser，就用輕量 package 或簡單 regex 讀 `<item>`；按減 Code 原則揀最少 code 嗰個）。

### 階段 3（之後加）
頭兩個免費、唔使 key，**2026-11-04 已經提早做好**（每小時 cron 入面檢查，當日已攞到嘅地區就唔再讀；頁面上面用「Google 熱搜 / App Store 熱門 / 維基熱門」分頁分開）。

| 來源 | 地區 | 做法 | 備註 |
|---|---|---|---|
| App Store 熱門 App | 11 個（**澳門都有**；蘇格蘭冇獨立商店，跳過） | Apple 官方 RSS：`https://rss.marketingtools.apple.com/api/v2/{國家碼細楷}/apps/top-free/20/apps.json`，每日 1 次。喺 Cloudflare 上面實測（2026-11-04）：呢個網址大多 200、間中 504（每小時會再試）；舊 `itunes.apple.com/.../rss/topfreeapplications` 次次 403，**唔好用**。注意本機 `wrangler dev` 結果相反，要用 `wrangler dev --remote` 先測得準 | `source = app_store`；`keyword` 放 App 名，`traffic` 放 NULL（只有排名），`news_url` 放 App 連結。只睇免費榜。補返澳門冇 Google Trends 嘅缺口 |
| 維基百科熱門頁面 | 9 個：台、日、韓、新、泰、印、英、荷、美（**港、澳冇**：Wikimedia 唔公開；**蘇格蘭冇**：只有國家級，跳過） | Wikimedia 官方 API：`https://wikimedia.org/api/rest_v1/metrics/pageviews/top-per-country/{GEO}/all-access/{YYYY/MM/DD}`，每日 1 次讀前一日 | `source = wikipedia`；`traffic` 放 `views_ceil`。要剔走首頁（Main_Page、メインページ、Hoofdpagina…）同所有標題有 `:` 嘅頁（Special:Search、Wikipedia:首页…）。Wikimedia 規定要帶有聯絡方式嘅 User-Agent（例如 repo 網址），咁樣係正常表明身份，唔係偽裝 |
| X 熱話 | 全部，日本最有用 | Grok API `x_search`，每地區每日 1–2 次 | 每 1,000 次大約 US$5；一次大約 45 秒，要放後台 |
| Reddit | 英、蘇格蘭、荷、美、印、新、日、港、台 | 各版公開 RSS，例如 `/r/unitedkingdom/top/.rss?t=day` | 先測 Worker 會唔會俾 Reddit 擋 |
| PTT | 台灣 | 網頁版公開板（例如 Lifeismoney、e-shopping） | 先測；八卦版要 18 歲確認 cookie，唔做 |

### 明確唔做（v1）
連登 LIHKG、Dcard、Threads、IG、TikTok：冇公開 API、防爬蟲嚴，要灰色手法。

## 4. 資料庫設計（D1）

```sql
-- 每次收集到嘅原始熱搜
CREATE TABLE trends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  geo TEXT NOT NULL,            -- HK TW MO JP KR SG TH IN GB GB-SCT NL US
  source TEXT NOT NULL,         -- google_trends / app_store / wikipedia / x / reddit / ptt
  keyword TEXT NOT NULL,
  traffic INTEGER,              -- 由 "50K+" 轉成 50000；冇就 NULL
  news_url TEXT,
  seen_at TEXT NOT NULL,        -- ISO 時間：Google 用 RSS pubDate；每日來源用資料日期 T00:00:00Z
  UNIQUE (geo, source, keyword, seen_at)
);
CREATE INDEX idx_trends_seen ON trends(seen_at);  -- 頁面只讀最近幾日，唔使全表掃描
```

- 只保留 60 日：每日 UTC 00 點嗰次 cron 刪走更舊嘅行。
- 原本計劃嘅 `insights` 表已經刪走（階段 2.5 B1）：AI 結果放喺每日報告 JSON（`reports/`），唔入 D1。

「連續上升」直接用 SQL 計（同一關鍵字喺過去 N 日出現嘅日數），唔另外寫邏輯。

## 5. AI 篩選規則（每日報告排程）

- 每日一次（台灣時間早上 8:00），claude.ai 雲端排程讀 `/api/data`，按 `docs/report-prompt.md` 寫報告，push 去 `reports/`。Worker 本身唔叫 AI，所以唔使 API key。
- 報告嘅 `hot` 欄位：每個地區有商機價值嘅關鍵字，要同 `/api/data` 嘅 `keyword` 一字不差，首頁就喺呢啲關鍵字前面加 🔥。
- 「商機」嘅定義：有人想**買**、**學**、**訂**、**搵服務**嘅需求，例如新產品、季節用品、旅遊目的地、新興服務。純新聞事件、明星、比賽結果唔算。
- `idea` 要具體，一句，例如「日本熱搜某款保溫杯 → 可以代購到台灣」。
- 改寫法就改 `docs/report-prompt.md`，唔使改排程。

## 6. 頁面設計（一版睇晒）

```
┌──────────────────────────────────────────────┐
│ BizIdea 商機雷達   今日 2026-11-04   [篩選：🔥商機 / 全部] │
├───────┬───────┬───────┬───────┬───────┬───────┤
│ 香港   │ 台灣   │ 澳門   │ 日本   │ 南韓   │ 新加坡 │
├───────┼───────┼───────┼───────┼───────┼───────┤
│ 泰國   │ 印度   │ 英國   │ 蘇格蘭 │ 荷蘭   │ 美國   │
│ 🔥… 5 │ 🔥… 4 │ 暫無   │ 🔥… 5 │ …     │ …     │
│ 📰…   │ …     │       │ …     │       │       │
├──────────────────────────────────────────────┤
│ 連續上升榜（過去 7 日出現最多日數嘅商機關鍵字） │
└──────────────────────────────────────────────┘
```

- 12 個地區分兩行，每格最多顯示 10 條（單行、太長用「…」截斷），預設只顯示 🔥 商機。
- 撳關鍵字：彈出小卡，顯示 AI 嘅 `idea`、流量、新聞連結。**唔好連 Google Trends Explore**：新版探索頁冇登入就乜都唔顯示（2026-11-04 實測），舊版就快停用。
- 手機版：12 個地區變成 2 行 tab（每行 6 個，位置固定）。
- 繁體中文介面。
- favicon：簡單雷達圖示（SVG）。og:image：1200×630，寫「BizIdea 商機雷達」。

## 7. 開發階段同驗收標準

### 階段 1：收集 Google Trends
- [x] Worker 每小時讀 6 個地區 RSS，寫入 `trends`
- [x] 重複嘅唔會重複寫（`seen_at` 用 RSS 嘅 pubDate，重讀只會 upsert 同一行）
- [x] `MO` 冇數據唔會令成個 job 失敗（Google 回 HTTP 400，只記 log）
- **驗收**：D1 入面見到 6 個地區（或 5 個 + 澳門暫無）嘅資料 — ✅ 2026-11-05 通過（5 個 + 澳門暫無）

### 階段 2：AI 篩選 + 頁面
- [ ] ~~每日 8:00 跑 AI 分析，寫入 `insights`~~ → 改為重用每日報告，見階段 2.5 B1
- [ ] 一版睇晒頁面，有篩選、彈出小卡、連續上升榜
  - 已提早做：基本一版睇晒頁面（12 地區分兩行、每地區 10 條、3 個來源分頁、手機分頁、冇數據顯示「暫無數據」）
  - 未做：🔥 商機篩選、彈出小卡、連續上升榜
- [ ] favicon + og:image（favicon 已做；og:image 未做，要用完整 `https://` 網址）
- **驗收**：打開網址，一個畫面見到 6 地區今日商機

### 階段 3：加來源
- [x] App Store 免費榜（6 地區，每日 1 次）
- [x] 維基百科按國家熱門頁面（台、日、英、荷，每日 1 次，剔走首頁同 `:` 頁）
- [ ] Grok `x_search`（每地區每日 1–2 次）
- [ ] Reddit RSS（先測試能否讀取）
- [ ] PTT 指定板（先測試）
- **驗收**：新來源喺頁面有標籤分得出；澳門至少有 App Store 資料

### 每日商業分析報告（2026-11-05 加，用戶要求，做法參考 ANL）
- [x] Worker `/api/data`：12 地區 × 3 來源，每個最多 20 條
- [x] 報告頁 `/report`、`/report/YYYY-MM-DD`：讀 GitHub `reports/*.json`，一版睇晒，手機 3 個分頁
- [ ] claude.ai 雲端排程：每日 08:00 港台（cron `0 0 * * *` UTC），Sonnet 5.5，寫 JSON → commit → push main
- 報告 JSON 欄位：`date`、`generated_at`、`headline`、`opportunities[]`（`title`、`idea`、`evidence`、`regions`、`score` 1–5）、`trends[]`（`title`、`detail`、`regions`）、`watch[]`、`regions{12 地區代碼: 一句}`、`caveats[]`
- 只用 `/api/data` 嘅數字，唔可以作數；唔係投資建議

### 階段 2.5：優化（2026-11-05 code review，用戶要求）

> 按以下次序做，每項一個 commit。全部遵守第 1 節「減 Code」：優先用 D1 / Cloudflare 原生功能。做完要 `npx wrangler deploy`，並更新 README。
> 第 4 項取代原本階段 2 嘅「Worker 叫 Claude API + `insights` 表」做法。

#### 🔴 A. 穩定同成本（先做）

**A1. D1 加 index + 清舊資料**
- 原因：`loadRows()` 每次讀過去 3 日，`seen_at` 冇 index → 全表掃描；D1 按「掃過嘅行數」計額度，而且帳戶額度同其他項目共用（見第 10 節）。表亦只會一直變大。
- 做法：
  - `schema.sql` 加 `CREATE INDEX IF NOT EXISTS idx_trends_seen ON trends(seen_at);`，並用 `wrangler d1 execute bizidea-db --remote` 喺正式 DB 執行。
  - `collect()` 每日一次（例如 UTC 00 點嗰次 cron）`DELETE FROM trends WHERE seen_at < 60 日前`。保留 60 日，夠「連續上升榜」用。
- **驗收**：`EXPLAIN QUERY PLAN` 顯示用到 `idx_trends_seen`；log 見到每日刪除行數。

**A2. 用 Cache API cache 頁面到下個整點**
- 原因：而家 `cache-control: max-age=60` 只係瀏覽器 cache，Worker 每次請求都照讀 D1。
- 做法：`/`、`/api/data` 用 `caches.default`（Cloudflare 原生）cache，有效期到下一個整點 + 2 分鐘（等 cron 寫完）。報告頁維持而家 5 分鐘。唔好加 KV 或其他服務。
- **驗收**：連續開首頁兩次，第二次 response 有 `cf-cache-status: HIT` 或 log 顯示冇讀 D1。

**A3. og:image 分享圖**（用戶硬性要求，見第 1 節）
- 做法：用 Workers 原生靜態檔案：`wrangler.toml` 加 `[assets] directory = "public"`，放 `public/og.png`（1200×630，PNG，唔好用 SVG，FB／LINE 唔支援）。圖上寫「BizIdea 商機雷達」+ 雷達圖示，同 favicon 同色系（`#0b3d2e`、`#3ddc97`）。
- 首頁同報告頁 `<head>` 加：`og:title`、`og:description`、`og:image`（完整 `https://bizidea.fiveathree.workers.dev/og.png`）、`og:url`、`twitter:card=summary_large_image`。
- **驗收**：用 Facebook Sharing Debugger 或 LINE 分享首頁，見到圖。

#### 🟡 B. 商機功能（減 code 做法）

**B1. 首頁 🔥 商機標記：重用每日報告，唔喺 Worker 叫 Claude API**
- 原因：每日報告排程已經用 AI 分析同一份 `/api/data`，再喺 Worker 叫一次 Claude 係重複，仲要喺 Cloudflare 放 API key。
- 做法：
  - `docs/report-prompt.md` 第 4 步加欄位 `hot`：物件，key = 地區代碼，value = 該地區有商機價值嘅**原文關鍵字**陣列（必須同 `/api/data` 入面嘅 `keyword` 一字不差，每地區最多 10 個）；第 5 步檢查加埋 `hot` 嘅 key 只用 12 個代碼。`docs/report-example.json` 同步加範例。
  - 首頁讀最新報告（`getReport()` 已有）嘅 `hot`，命中嘅關鍵字前面加 🔥；header 加「🔥 只睇商機 / 全部」純 CSS 切換（同而家分頁一樣用 radio + `:has()`，唔加 JavaScript）。
  - 冇報告或冇 `hot` 時，首頁照常顯示，唔顯示切換掣。
  - 刪走 `schema.sql` 嘅 `insights` 表同相關註解（`DROP TABLE` 前先確認冇資料）；第 4、5、8 節同步改：唔再需要 `ANTHROPIC_API_KEY`。
- **驗收**：排程跑完之後，首頁見到 🔥；撳「只睇商機」只剩 🔥 嘅關鍵字。

**B2. 連續上升榜**
- 做法：一句 SQL，過去 7 日（台北時間分日）每個關鍵字出現喺幾多日、幾多個地區，只計 `google_trends`，出現 ≥ 2 日先上榜，取頭 10 個。顯示喺首頁 footer 上面一行（橫向，太長用「…」），**唔可以令首頁要捲動**；手機版放喺地區分頁之後做一個「連續上升」分頁。
- 每個關鍵字顯示：名、出現日數、地區（例如「無印良品 4日 🇯🇵🇹🇼」，國旗或地區簡稱都得）。
- 如果 B1 已做，`hot` 命中嘅關鍵字排前。
- **驗收**：首頁桌面版一版睇晒，見到連續上升榜；開頭幾日資料少，顯示「資料累積中」。

**B3. 接 Workers Builds（push 自動部署）**
- Cloudflare 原生功能，唔使寫 code。Claude Code 要**由頭逐步教用戶**喺 Cloudflare dashboard 接 GitHub `fiveathree/bizidea` 嘅 `main`（按鈕名用現時正確名稱，唔肯定就叫用戶截圖）。
- 注意：每日報告排程會 push `reports/`，會觸發重新部署，可以接受；如果 dashboard 有「build watch paths」設定，就只監察 `src/`、`public/`、`wrangler.toml`。
- **驗收**：push 一個小改動，唔使跑 `wrangler deploy` 網站都更新；README「已知問題」刪走呢條。

#### 🟢 C. 小修補（可以一個 commit 做晒）

- **C1. 鍵盤可用**：分頁嘅 radio 由 `display:none` 改為視覺隱藏（`position:absolute;opacity:0;pointer-events:none`），並加 `input:focus-visible+label{outline:2px solid var(--acc)}`。首頁同報告頁都要改。
- **C2. 連結安全**：輸出 `href` 前，只接受 `https://` 或 `http://` 開頭，否則改用 Google 搜尋連結。1 個小 function，首頁同報告頁共用。
- **C3. 單條壞資料唔拖累成個地區**：`googleTrends()` 入面 `new Date(pubDate)` 無效時跳過嗰一條（或者用收集時間），唔好令 `toISOString()` 拋錯令成個地區冇數據。
- **驗收**：用 Tab 鍵可以轉分頁；手機同桌面版外觀冇變。

#### 明確唔做
- 唔加前端框架、唔加 JavaScript（純 CSS 分頁係優點）。
- 唔再加地區（12 個已經塞滿一版）。
- 唔加 KV、R2、Queue 等新服務，以上全部用現有 Worker + D1 + 靜態檔案做到。

### 之後先考慮（未承諾）
- 每日 email / LINE 推送當日 Top 5 商機
- 電商熱賣榜（要先確認對方條款容許）

## 8. 用戶需要自己做嘅設定（Claude Code 要逐步教）

用戶唔係技術人員，每一步都要由頭教，按鈕名稱要用**現時正確**嘅名稱。

1. Cloudflare 帳戶（用 fiveathree@gmail.com）建立 Worker 同 D1 database
2. ~~喺 Worker 加 Secret：`ANTHROPIC_API_KEY`~~：唔再需要，AI 分析由 claude.ai 雲端排程做
3. 階段 3 先加：`XAI_API_KEY`（Grok）
4. 設定 Cron Trigger

## 9. 預計成本（每月）

| 項目 | 預計 |
|---|---|
| Cloudflare Worker + D1 | 免費額度內 |
| 每日報告（claude.ai 雲端排程） | 用緊嘅 Claude 訂閱，唔使另外俾 API 錢 |
| Grok `x_search`（階段 3） | 工具費大約 US$2 + token |

## 10. 已知限制

- Google Trends RSS 只有頭大約 10–20 條，唔係完整長尾，流量只係大約數字。
- Google 官方 Trends API 仍然係限量 alpha，暫時唔用。
- 歷史數據要自己儲，開頭幾日「連續上升榜」會好少嘢。
- 「熱搜」≠「一定賺錢」，AI 建議只作參考。
- **D1 免費寫入額度（每日 10 萬行）係成個 Cloudflare 帳戶共用**。2026-11-04 另一個項目一次過匯入 13 萬行，令 bizidea 由 14:00 起寫唔到，要等 UTC 午夜。bizidea 自己每日只寫幾千行。
- 本機 `wrangler dev` 嘅對外請求結果可能同正式環境唔同（例如 Apple RSS），測外部來源要用 `wrangler dev --remote`。
- 未接 GitHub 自動部署：push 之後要另外跑 `npx wrangler deploy`。

現況總覽（架構、資料、功能、已知問題）見 [README.md](README.md)。
