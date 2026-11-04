const GEOS = ["HK", "TW", "MO", "JP", "GB", "NL"];
const UA = "BizIdea/1.0 (https://github.com/fiveathree/bizidea)"; // Wikimedia 規定要表明身份

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) =>
  s
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) =>
      e[0] === "#"
        ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1))
        : ENTITIES[e] ?? m
    )
    .trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : null;
};

// "50K+" → 50000，"2M+" → 2000000，"1,000+" → 1000
const parseTraffic = (s) => {
  const m = s?.replace(/,/g, "").match(/([\d.]+)\s*([KM])?/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6 }[m[2]?.toUpperCase()] ?? 1;
  return Math.round(parseFloat(m[1]) * mult);
};

// UTC 日期，0 = 今日，1 = 尋日
const day = (ago) => new Date(Date.now() - ago * 864e5).toISOString().slice(0, 10);
const stamp = (d) => `${d}T00:00:00.000Z`;

async function getJSON(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function googleTrends(geo) {
  const res = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, item]) => ({
      keyword: tag(item, "title"),
      traffic: parseTraffic(tag(item, "ht:approx_traffic")),
      news_url: tag(item, "ht:news_item_url"),
      seen_at: new Date(tag(item, "pubDate")).toISOString(),
    }))
    .filter((t) => t.keyword);
}

// 每日一次：App Store 免費榜（按排名次序寫入，頁面用 id 排序）
// 用 Apple 官方 iTunes RSS；新版 rss.marketingtools.apple.com 會拒絕所有 Cloudflare Worker 請求（403）
async function appStore(geo, d) {
  const { feed } = await getJSON(
    `https://itunes.apple.com/${geo.toLowerCase()}/rss/topfreeapplications/limit=20/json`
  );
  return [].concat(feed.entry ?? []).map((a) => ({
    keyword: a["im:name"].label,
    traffic: null,
    news_url: a.id.label,
    seen_at: stamp(d),
  }));
}

// 每日一次：維基百科按國家熱門頁面（讀尋日，剔走首頁同 Special: 呢類頁）
const MAIN_PAGES = new Set([
  "-", "Wiki", "Wikipedia", "Main_Page", "メインページ", "Hoofdpagina", "Заглавная_страница",
  "Hauptseite", "Wikipédia:Accueil_principal", "Pagina_principale", "Página_principal",
]);
async function wikipedia(geo, d) {
  const { items } = await getJSON(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/top-per-country/${geo}/all-access/${d.replaceAll("-", "/")}`,
    { "user-agent": UA }
  );
  return items[0].articles
    .filter((a) => !a.article.includes(":") && !MAIN_PAGES.has(a.article))
    .slice(0, 20)
    .map((a) => ({
      keyword: a.article.replaceAll("_", " "),
      traffic: a.views_ceil,
      news_url: `https://${a.project}.org/wiki/${encodeURIComponent(a.article)}`,
      seen_at: stamp(d),
    }));
}

async function collect(env) {
  const appDay = day(0);
  const wikiDay = day(1);
  // 每日來源：今日已經攞到嘅地區就唔再讀
  const { results: done } = await env.DB.prepare(
    `SELECT DISTINCT source || geo k FROM trends
     WHERE (source = 'app_store' AND seen_at = ?) OR (source = 'wikipedia' AND seen_at = ?)`
  )
    .bind(stamp(appDay), stamp(wikiDay))
    .all();
  const have = new Set(done.map((r) => r.k));

  const jobs = [];
  for (const g of GEOS) {
    jobs.push(["google_trends", g, () => googleTrends(g)]);
    if (!have.has(`app_store${g}`)) jobs.push(["app_store", g, () => appStore(g, appDay)]);
    if (!have.has(`wikipedia${g}`)) jobs.push(["wikipedia", g, () => wikipedia(g, wikiDay)]);
  }
  const results = await Promise.allSettled(jobs.map(([, , run]) => run()));

  const stmt = env.DB.prepare(
    `INSERT INTO trends (geo, source, keyword, traffic, news_url, seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (geo, source, keyword, seen_at) DO UPDATE SET traffic = excluded.traffic`
  );
  const rows = [];
  results.forEach((r, i) => {
    const [source, geo] = jobs[i];
    if (r.status === "rejected") return console.log(`${geo} ${source}: 暫無數據 (${r.reason.message})`);
    console.log(`${geo} ${source}: ${r.value.length} 條`);
    for (const t of r.value) rows.push(stmt.bind(geo, source, t.keyword, t.traffic, t.news_url, t.seen_at));
  });
  if (rows.length) await env.DB.batch(rows);
}

const NAMES = { HK: "香港", TW: "台灣", MO: "澳門", JP: "日本", GB: "英國", NL: "荷蘭" };
const SOURCES = [
  ["google_trends", "Google 熱搜"],
  ["app_store", "App Store 熱門"],
  ["wikipedia", "維基熱門"],
];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) =>
  n == null ? "" : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : `${n}`;
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#0b3d2e"/><circle cx="16" cy="16" r="9" fill="none" stroke="#3ddc97" stroke-width="2"/><path d="M16 16L26 9" stroke="#3ddc97" stroke-width="2.5"/><circle cx="21" cy="19" r="2" fill="#ffd166"/></svg>`
  );

// 每個地區 + 來源揀最多 8 條：
// Google 熱搜 = 過去 24 小時、按流量；App Store = 最新一日、按排名；維基 = 最新一日、按瀏覽量
function pick(rows, geo, source) {
  const mine = rows.filter((r) => r.geo === geo && r.source === source);
  if (source === "google_trends") {
    const since = new Date(Date.now() - 864e5).toISOString();
    const best = new Map();
    for (const r of mine.filter((r) => r.seen_at >= since)) {
      const b = best.get(r.keyword);
      if (!b || r.traffic > b.traffic) best.set(r.keyword, { ...r, news_url: r.news_url || b?.news_url });
    }
    return [...best.values()].sort((a, b) => b.traffic - a.traffic).slice(0, 8);
  }
  const latest = mine.reduce((m, r) => (r.seen_at > m ? r.seen_at : m), "");
  const list = mine.filter((r) => r.seen_at === latest);
  if (source === "wikipedia") list.sort((a, b) => b.traffic - a.traffic);
  return list.slice(0, 8);
}

async function page(env) {
  const { results } = await env.DB.prepare(
    `SELECT geo, source, keyword, traffic, news_url, seen_at FROM trends
     WHERE seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days') ORDER BY id`
  ).all();
  const today = new Date().toLocaleDateString("sv", { timeZone: "Asia/Taipei" });
  const next = new Date(Math.ceil(Date.now() / 3.6e6) * 3.6e6).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit",
  });
  const cols = GEOS.map((g, i) => {
    const lists = SOURCES.map(([src]) => {
      const items = pick(results, g, src);
      const li = items.length
        ? items
            .map(
              (r) =>
                `<li><a href="${esc(r.news_url || `https://www.google.com/search?q=${encodeURIComponent(r.keyword)}`)}" target="_blank" rel="noopener">${esc(r.keyword)}</a><small>${fmt(r.traffic)}</small></li>`
            )
            .join("")
        : `<li class="empty">暫無數據</li>`;
      return `<ol class="${src}">${li}</ol>`;
    }).join("");
    return `<input type="radio" name="t" id="t${g}"${i ? "" : " checked"}><label for="t${g}">${NAMES[g]}</label><section><h2>${NAMES[g]}</h2>${lists}</section>`;
  }).join("");
  const srcTabs = SOURCES.map(
    ([src, name], i) => `<input type="radio" name="s" id="s_${src}"${i ? "" : " checked"}><label for="s_${src}">${name}</label>`
  ).join("");
  const showSrc = SOURCES.map(([src]) => `body:has(#s_${src}:checked) ol.${src}`).join(",");
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BizIdea 商機雷達</title><meta name="description" content="香港、台灣、澳門、日本、英國、荷蘭每日網上熱搜、熱門 App 同熱門話題，一版睇晒。">
<link rel="icon" href="${FAVICON}"><style>
:root{--bg:#f6f7f5;--card:#fff;--fg:#1c2421;--mute:#6b7570;--line:#e3e6e3;--acc:#0b7a55}
@media(prefers-color-scheme:dark){:root{--bg:#121614;--card:#1b201e;--fg:#e8ece9;--mute:#94a09a;--line:#2b322f;--acc:#3ddc97}}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 system-ui,"PingFang TC","Microsoft JhengHei",sans-serif;background:var(--bg);color:var(--fg);height:100dvh;display:flex;flex-direction:column}
header{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:12px 16px}h1{font-size:20px;margin:0}header span{color:var(--mute);font-size:13px}
nav{display:flex;gap:4px;margin-left:auto}nav label{padding:5px 12px;border:1px solid var(--line);border-radius:999px;cursor:pointer;font-size:13px;background:var(--card)}
nav input:checked+label{background:var(--acc);border-color:var(--acc);color:var(--bg)}input{display:none}
main{flex:1;min-height:0;display:grid;grid-template-columns:repeat(6,1fr);gap:8px;padding:0 16px 16px}main label{display:none}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow:hidden}
h2{font-size:15px;margin:0 0 6px;color:var(--acc)}ol{display:none;margin:0;padding-left:20px}${showSrc}{display:block}
li{overflow-wrap:anywhere;padding:4px 0;border-bottom:1px solid var(--line)}li:last-child{border:0}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}small{color:var(--mute);margin-left:6px;font-size:12px}.empty{list-style:none;margin-left:-20px;color:var(--mute)}
footer{padding:0 16px 10px;color:var(--mute);font-size:12px}
@media(max-width:760px){nav{margin-left:0;width:100%}nav label{flex:1;text-align:center;padding:6px 4px}
main{grid-template-rows:auto 1fr;align-content:start}
main label{display:block;grid-row:1;text-align:center;padding:8px 0;border-radius:8px;cursor:pointer;font-size:14px}
main input:checked+label{background:var(--acc);color:var(--bg)}section{display:none;grid-row:2;grid-column:1/-1}main input:checked+label+section{display:block}h2{display:none}}
</style></head><body><header><h1>BizIdea 商機雷達</h1><span>今日 ${today}・每小時整點更新，下次 ${next}（港台時間）</span><nav>${srcTabs}</nav></header><main>${cols}</main>
<footer>資料來源：Google Trends（過去 24 小時，數字係大約搜尋量）・Apple App Store 免費榜（今日排名）・Wikimedia 維基百科（前一日瀏覽量，港澳冇公開數據）。AI 商機篩選即將推出。</footer></body></html>`;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect(env));
  },
  async fetch(req, env) {
    if (new URL(req.url).pathname !== "/") return new Response("Not found", { status: 404 });
    return new Response(await page(env), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
    });
  },
};
