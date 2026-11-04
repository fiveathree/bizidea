# BizIdea 全球商機雷達 — 開發計劃 (PLAN.md)

> 俾 Claude Code 用嘅開發規格。由上至下按「階段」做，每個階段做完要通過「驗收標準」先做下一階段。

## 0. 一句講晒

每日自動收集 **香港、台灣、澳門、日本、英國、荷蘭** 嘅網上熱搜同熱話，用 AI 篩走純新聞 / 娛樂，淨低「可以變成生意」嘅關鍵字，喺**一版睇晒**嘅網頁顯示。

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
| AI 篩選 | Claude API（每日 1 次批量） | 將熱搜分類為「商機 / 新聞 / 娛樂 / 體育 / 其他」 |
| 前端 | 同一個 Worker 出一版靜態 HTML（無框架） | 唔使 build step |
| X (Twitter) 熱話 | Grok API `x_search`（階段 3 先加） | 比 X 官方 API 平好多 |

唔要：React/Vue、伺服器、用戶系統、付款。

## 3. 數據來源

### 階段 1（必做）
**Google Trends「Trending Now」RSS**（公開、免費）
- 網址格式：`https://trends.google.com/trending/rss?geo={GEO}`
- GEO：`HK`、`TW`、`MO`、`JP`、`GB`、`NL`
- **澳門 `MO` 未確認有冇數據**：第一次跑要測試，冇數據就喺頁面標「暫無數據」，唔好報錯。
- 每個地區大約 10–20 條，有「大約流量」（例如 `200+`、`50K+`）同相關新聞連結。
- 要用 XML 解析（Worker 內建冇 DOMParser，就用輕量 package 或簡單 regex 讀 `<item>`；按減 Code 原則揀最少 code 嗰個）。

### 階段 3（之後加）
頭兩個免費、唔使 key，**2026-11-04 已經提早做好**（每小時 cron 入面檢查，當日已攞到嘅地區就唔再讀；頁面上面用「Google 熱搜 / App Store 熱門 / 維基熱門」分頁分開）。

| 來源 | 地區 | 做法 | 備註 |
|---|---|---|---|
| App Store 熱門 App | 全部 6 個（**澳門都有**） | Apple 官方 iTunes RSS：`https://itunes.apple.com/{hk,tw,mo,jp,gb,nl}/rss/topfreeapplications/limit=20/json`，每日 1 次。**唔好用**新版 `rss.marketingtools.apple.com`：佢會拒絕所有帶 `Cf-Worker` 標頭嘅請求（Cloudflare 一定會加，403） | `source = app_store`；`keyword` 放 App 名，`traffic` 放 NULL（只有排名），`news_url` 放 App 連結。只睇免費榜。補返澳門冇 Google Trends 嘅缺口 |
| 維基百科熱門頁面 | 台、日、英、荷（**港、澳冇**：瀏覽量太少，Wikimedia 唔公開） | Wikimedia 官方 API：`https://wikimedia.org/api/rest_v1/metrics/pageviews/top-per-country/{GEO}/all-access/{YYYY/MM/DD}`，每日 1 次讀前一日 | `source = wikipedia`；`traffic` 放 `views_ceil`。要剔走首頁（Main_Page、メインページ、Hoofdpagina…）同所有標題有 `:` 嘅頁（Special:Search、Wikipedia:首页…）。Wikimedia 規定要帶有聯絡方式嘅 User-Agent（例如 repo 網址），咁樣係正常表明身份，唔係偽裝 |
| X 熱話 | 全部，日本最有用 | Grok API `x_search`，每地區每日 1–2 次 | 每 1,000 次大約 US$5；一次大約 45 秒，要放後台 |
| Reddit | 英、荷、日、港、台 | 各版公開 RSS，例如 `/r/unitedkingdom/top/.rss?t=day` | 先測 Worker 會唔會俾 Reddit 擋 |
| PTT | 台灣 | 網頁版公開板（例如 Lifeismoney、e-shopping） | 先測；八卦版要 18 歲確認 cookie，唔做 |

### 明確唔做（v1）
連登 LIHKG、Dcard、Threads、IG、TikTok：冇公開 API、防爬蟲嚴，要灰色手法。

## 4. 資料庫設計（D1）

```sql
-- 每次收集到嘅原始熱搜
CREATE TABLE trends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  geo TEXT NOT NULL,            -- HK / TW / MO / JP / GB / NL
  source TEXT NOT NULL,         -- google_trends / app_store / wikipedia / x / reddit / ptt
  keyword TEXT NOT NULL,
  traffic INTEGER,              -- 由 "50K+" 轉成 50000；冇就 NULL
  news_url TEXT,
  seen_at TEXT NOT NULL,        -- ISO 時間
  UNIQUE (geo, source, keyword, seen_at)
);

-- AI 每日分析結果
CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,            -- YYYY-MM-DD（Asia/Taipei）
  geo TEXT NOT NULL,
  keyword TEXT NOT NULL,
  category TEXT NOT NULL,       -- opportunity / news / entertainment / sports / other
  idea TEXT,                    -- 一句講點做生意（只限 opportunity）
  score INTEGER,                -- 1–5 商機分
  UNIQUE (day, geo, keyword)
);
```

「連續上升」直接用 SQL 計（同一關鍵字喺過去 N 日出現嘅日數），唔另外寫邏輯。

## 5. AI 篩選規則（Claude API）

- 每日一次（台灣時間早上 8:00），將當日所有地區熱搜一次過送去。
- 要求 AI 回 **JSON**，每個關鍵字：`category`、`score`、`idea`。
- 「商機」嘅定義：有人想**買**、**學**、**訂**、**搵服務**嘅需求，例如新產品、季節用品、旅遊目的地、新興服務。純新聞事件、明星、比賽結果唔算。
- `idea` 要具體，一句，例如「日本熱搜某款保溫杯 → 可以代購到台灣」。
- 用最平又夠用嘅 Claude 模型；Model 名放 config，唔好寫死。

## 6. 頁面設計（一版睇晒）

```
┌──────────────────────────────────────────────┐
│ BizIdea 商機雷達   今日 2026-11-04   [篩選：🔥商機 / 全部] │
├───────┬───────┬───────┬───────┬───────┬───────┤
│ 香港   │ 台灣   │ 澳門   │ 日本   │ 英國   │ 荷蘭   │
│ 🔥… 5 │ 🔥… 4 │ 暫無   │ 🔥… 5 │ …     │ …     │
│ 📰…   │ …     │       │ …     │       │       │
├──────────────────────────────────────────────┤
│ 連續上升榜（過去 7 日出現最多日數嘅商機關鍵字） │
└──────────────────────────────────────────────┘
```

- 每格最多顯示 8 條，預設只顯示 🔥 商機。
- 撳關鍵字：彈出小卡，顯示 AI 嘅 `idea`、流量、新聞連結、Google Trends Explore 連結。
- 手機版：上面 6 個地區變成 tab。
- 繁體中文介面。
- favicon：簡單雷達圖示（SVG）。og:image：1200×630，寫「BizIdea 商機雷達」。

## 7. 開發階段同驗收標準

### 階段 1：收集 Google Trends
- [ ] Worker 每小時讀 6 個地區 RSS，寫入 `trends`
- [ ] 重複嘅唔會重複寫
- [ ] `MO` 冇數據唔會令成個 job 失敗
- **驗收**：D1 入面見到 6 個地區（或 5 個 + 澳門暫無）嘅資料

### 階段 2：AI 篩選 + 頁面
- [ ] 每日 8:00 跑 AI 分析，寫入 `insights`
- [ ] 一版睇晒頁面，有篩選、彈出小卡、連續上升榜
- [ ] favicon + og:image
- **驗收**：打開網址，一個畫面見到 6 地區今日商機

### 階段 3：加來源
- [x] App Store 免費榜（6 地區，每日 1 次）
- [x] 維基百科按國家熱門頁面（台、日、英、荷，每日 1 次，剔走首頁同 `:` 頁）
- [ ] Grok `x_search`（每地區每日 1–2 次）
- [ ] Reddit RSS（先測試能否讀取）
- [ ] PTT 指定板（先測試）
- **驗收**：新來源喺頁面有標籤分得出；澳門至少有 App Store 資料

### 之後先考慮（未承諾）
- 每日 email / LINE 推送當日 Top 5 商機
- 電商熱賣榜（要先確認對方條款容許）

## 8. 用戶需要自己做嘅設定（Claude Code 要逐步教）

用戶唔係技術人員，每一步都要由頭教，按鈕名稱要用**現時正確**嘅名稱。

1. Cloudflare 帳戶（用 fiveathree@gmail.com）建立 Worker 同 D1 database
2. 喺 Worker 加 Secret：`ANTHROPIC_API_KEY`
3. 階段 3 先加：`XAI_API_KEY`（Grok）
4. 設定 Cron Trigger

## 9. 預計成本（每月）

| 項目 | 預計 |
|---|---|
| Cloudflare Worker + D1 | 免費額度內 |
| Claude API（每日 1 次，大約 100 個關鍵字） | 幾蚊美金 |
| Grok `x_search`（階段 3） | 工具費大約 US$2 + token |

## 10. 已知限制

- Google Trends RSS 只有頭大約 10–20 條，唔係完整長尾，流量只係大約數字。
- Google 官方 Trends API 仍然係限量 alpha，暫時唔用。
- 歷史數據要自己儲，開頭幾日「連續上升榜」會好少嘢。
- 「熱搜」≠「一定賺錢」，AI 建議只作參考。
