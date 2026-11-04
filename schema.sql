-- 每次收集到嘅原始熱搜
CREATE TABLE IF NOT EXISTS trends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  geo TEXT NOT NULL,            -- HK / TW / MO / JP / GB / NL
  source TEXT NOT NULL,         -- google_trends / app_store / wikipedia / x / reddit / ptt
  keyword TEXT NOT NULL,
  traffic INTEGER,              -- 由 "50K+" 轉成 50000；冇就 NULL
  news_url TEXT,
  seen_at TEXT NOT NULL,        -- ISO 時間（Google Trends 用 RSS 嘅 pubDate，咁每小時重讀都唔會重複）
  UNIQUE (geo, source, keyword, seen_at)
);

-- AI 每日分析結果（階段 2 先用）
CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,            -- YYYY-MM-DD（Asia/Taipei）
  geo TEXT NOT NULL,
  keyword TEXT NOT NULL,
  category TEXT NOT NULL,       -- opportunity / news / entertainment / sports / other
  idea TEXT,                    -- 一句講點做生意（只限 opportunity）
  score INTEGER,                -- 1–5 商機分
  UNIQUE (day, geo, keyword)
);
