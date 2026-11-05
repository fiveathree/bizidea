-- 每次收集到嘅原始熱搜
CREATE TABLE IF NOT EXISTS trends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  geo TEXT NOT NULL,            -- HK TW MO JP KR SG TH IN GB GB-SCT NL US
  source TEXT NOT NULL,         -- google_trends / app_store / wikipedia
  keyword TEXT NOT NULL,
  traffic INTEGER,              -- 由 "50K+" 轉成 50000；冇就 NULL
  news_url TEXT,
  seen_at TEXT NOT NULL,        -- ISO 時間（Google Trends 用 RSS 嘅 pubDate，咁每小時重讀都唔會重複）
  UNIQUE (geo, source, keyword, seen_at)
);
-- 頁面只讀最近幾日：冇呢個 index 就要全表掃描（D1 按掃過嘅行數計額度）
CREATE INDEX IF NOT EXISTS idx_trends_seen ON trends(seen_at);
-- AI 結果唔入 D1：每日報告 JSON 放喺 GitHub reports/，首頁用報告嘅 hot 加 🔥（舊 insights 表已刪）
