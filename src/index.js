// 頁面次序：第一行亞洲東部，第二行其餘；GB-SCT = 蘇格蘭（Google Trends 子地區）
const GEOS = ["HK", "TW", "MO", "JP", "KR", "SG", "TH", "IN", "GB", "GB-SCT", "NL", "US"];
// 結構上冇數據，唔使每個鐘去試：Apple 冇蘇格蘭商店；Wikimedia 唔公開港澳，亦冇蘇格蘭
const SKIP = { app_store: ["GB-SCT"], wikipedia: ["HK", "MO", "GB-SCT"] };
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
// 喺 Cloudflare 上面 itunes.apple.com 舊 RSS 次次 403，新版間中 504（每小時會再試）
async function appStore(geo, d) {
  const { feed } = await getJSON(
    `https://rss.marketingtools.apple.com/api/v2/${geo.toLowerCase()}/apps/top-free/20/apps.json`,
    { "user-agent": UA }
  );
  return feed.results.map((a) => ({ keyword: a.name, traffic: null, news_url: a.url, seen_at: stamp(d) }));
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
    if (!have.has(`app_store${g}`) && !SKIP.app_store.includes(g))
      jobs.push(["app_store", g, () => appStore(g, appDay)]);
    if (!have.has(`wikipedia${g}`) && !SKIP.wikipedia.includes(g))
      jobs.push(["wikipedia", g, () => wikipedia(g, wikiDay)]);
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

  // 每日一次（UTC 00 點）清走 60 日前嘅資料，表唔會無限變大
  if (new Date().getUTCHours() === 0) {
    const { meta } = await env.DB.prepare(
      `DELETE FROM trends WHERE seen_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 days')`
    ).run();
    console.log(`清走 60 日前資料：${meta.changes} 行`);
  }
}

const SHOW = 10; // 每個地區顯示幾多條
const NAMES = {
  HK: "香港", TW: "台灣", MO: "澳門", JP: "日本", KR: "南韓", SG: "新加坡",
  TH: "泰國", IN: "印度", GB: "英國", "GB-SCT": "蘇格蘭", NL: "荷蘭", US: "美國",
};
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

// 每個地區 + 來源揀最多 SHOW 條：
// Google 熱搜 = 過去 24 小時、按流量；App Store = 最新一日、按排名；維基 = 最新一日、按瀏覽量
function pick(rows, geo, source, n = SHOW) {
  const mine = rows.filter((r) => r.geo === geo && r.source === source);
  if (source === "google_trends") {
    const since = new Date(Date.now() - 864e5).toISOString();
    const best = new Map();
    for (const r of mine.filter((r) => r.seen_at >= since)) {
      const b = best.get(r.keyword);
      if (!b || r.traffic > b.traffic) best.set(r.keyword, { ...r, news_url: r.news_url || b?.news_url });
    }
    return [...best.values()].sort((a, b) => b.traffic - a.traffic).slice(0, n);
  }
  const latest = mine.reduce((m, r) => (r.seen_at > m ? r.seen_at : m), "");
  const list = mine.filter((r) => r.seen_at === latest);
  if (source === "wikipedia") list.sort((a, b) => b.traffic - a.traffic);
  return list.slice(0, n);
}

async function loadRows(env) {
  const { results } = await env.DB.prepare(
    `SELECT geo, source, keyword, traffic, news_url, seen_at FROM trends
     WHERE seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days') ORDER BY seen_at, id` // 咁先用到 idx_trends_seen；同一日內按 id = App Store 排名
  ).all();
  return results;
}

// 俾每日報告排程讀：每個地區每個來源最多 20 條
async function apiData(env) {
  const rows = await loadRows(env);
  return {
    generated_at: new Date().toISOString(),
    notes: {
      google_trends: "過去 24 小時，traffic = 大約搜尋量",
      app_store: "今日免費榜，按排名次序，冇 traffic",
      wikipedia: "前一日（UTC）按國家瀏覽量，traffic = 瀏覽量",
    },
    regions: GEOS.map((geo) => ({
      geo,
      name: NAMES[geo],
      ...Object.fromEntries(
        SOURCES.map(([src]) => [
          src,
          pick(rows, geo, src, 20).map((r) => ({ keyword: r.keyword, traffic: r.traffic, url: r.news_url })),
        ])
      ),
    })),
  };
}

async function page(env) {
  const results = await loadRows(env);
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
                `<li><a href="${esc(r.news_url || `https://www.google.com/search?q=${encodeURIComponent(r.keyword)}`)}" target="_blank" rel="noopener" title="${esc(r.keyword)}">${esc(r.keyword)}</a><small>${fmt(r.traffic)}</small></li>`
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
<title>BizIdea 商機雷達</title><meta name="description" content="港、台、澳、日、韓、新、泰、印、英、蘇格蘭、荷、美 12 個地區每日網上熱搜、熱門 App 同熱門話題，一版睇晒。">
<link rel="icon" href="${FAVICON}"><style>
:root{--bg:#f6f7f5;--card:#fff;--fg:#1c2421;--mute:#6b7570;--line:#e3e6e3;--acc:#0b7a55}
@media(prefers-color-scheme:dark){:root{--bg:#121614;--card:#1b201e;--fg:#e8ece9;--mute:#94a09a;--line:#2b322f;--acc:#3ddc97}}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 system-ui,"PingFang TC","Microsoft JhengHei",sans-serif;background:var(--bg);color:var(--fg);height:100dvh;display:flex;flex-direction:column}
header{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:12px 16px}h1{font-size:20px;margin:0}header span{color:var(--mute);font-size:13px}
nav{display:flex;gap:4px;margin-left:auto}nav label{padding:5px 12px;border:1px solid var(--line);border-radius:999px;cursor:pointer;font-size:13px;background:var(--card)}
nav input:checked+label{background:var(--acc);border-color:var(--acc);color:var(--bg)}input{display:none}
main{flex:1;min-height:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:8px;padding:0 16px 12px}main label{display:none}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px;overflow:hidden}
h2{font-size:14px;margin:0 0 4px;color:var(--acc)}ol{display:none;margin:0;padding:0;list-style:none;counter-reset:n}${showSrc}{display:block}
li{display:flex;align-items:baseline;gap:4px;font-size:13px;line-height:1.35;padding:2px 0;border-bottom:1px solid var(--line)}li:last-child{border:0}
li:not(.empty)::before{counter-increment:n;content:counter(n);color:var(--mute);font-size:11px;min-width:1.4em}
a{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit;text-decoration:none}a:hover{text-decoration:underline}
small{color:var(--mute);font-size:11px;white-space:nowrap}.empty{color:var(--mute)}
footer{padding:0 16px 8px;color:var(--mute);font-size:12px}
a.rep{flex:none;padding:4px 10px;border-radius:999px;background:var(--acc);color:var(--bg);font-size:13px}
@media(max-width:760px){nav{margin-left:0;width:100%}nav label{flex:1;text-align:center;padding:6px 4px}
main{grid-template-rows:auto auto minmax(0,1fr);align-content:start;gap:6px}
main label{display:block;text-align:center;padding:7px 0;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap}
main input:checked+label{background:var(--acc);color:var(--bg)}section{display:none;grid-row:3;grid-column:1/-1}main input:checked+label+section{display:block}h2{display:none}
li{font-size:15px;padding:6px 0}small{font-size:12px}}
</style></head><body><header><h1>BizIdea 商機雷達</h1><a class="rep" href="/report">📊 今日報告</a><span>今日 ${today}・每小時整點更新，下次 ${next}（港台時間）</span><nav>${srcTabs}</nav></header><main>${cols}</main>
<footer>資料來源：Google Trends（過去 24 小時，數字係大約搜尋量）・Apple App Store 免費榜（今日排名）・Wikimedia 維基百科（前一日瀏覽量）。澳門冇 Google 數據；港澳冇維基數據；蘇格蘭只有 Google 數據（App Store 同維基併入英國）。AI 商機篩選即將推出。</footer></body></html>`;
}

// 每日報告：雲端排程每朝寫 reports/YYYY-MM-DD.json 同 reports/index.json 入 GitHub，呢度直接讀
const REPORTS = "https://raw.githubusercontent.com/fiveathree/bizidea/main/reports/";
async function getReport(env, path) {
  const res = await fetch((env.REPORTS_URL ?? REPORTS) + path, { cf: { cacheTtl: 300 } }); // REPORTS_URL 只係本機測試用
  return res.ok ? res.json() : null;
}

const stars = (n) => "★".repeat(Math.max(0, Math.min(5, n | 0))) + "☆".repeat(5 - Math.max(0, Math.min(5, n | 0)));
const tags = (geos) => (geos ?? []).map((g) => `<i>${esc(NAMES[g] ?? g)}</i>`).join("");
const arr = (x) => (Array.isArray(x) ? x : []);

async function reportPage(env, day) {
  const days = arr(await getReport(env, "index.json").catch(() => null));
  day ??= days[0];
  const r = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? await getReport(env, `${day}.json`).catch(() => null) : null;
  const i = days.indexOf(day);
  const prev = days[i + 1], next = i > 0 ? days[i - 1] : null;
  const navLinks = `${prev ? `<a href="/report/${prev}">← ${prev}</a>` : ""}${next ? `<a href="/report/${next}">${next} →</a>` : ""}`;

  const body = !r
    ? `<p class="none">${day ? `${esc(day)} 冇報告。` : "未有報告。"}每日報告喺港台時間朝早 8:00 出。</p>`
    : `<p class="headline">${esc(r.headline)}</p>
<input type="radio" name="v" id="v1" checked><label for="v1">商機</label><input type="radio" name="v" id="v2"><label for="v2">趨勢</label><input type="radio" name="v" id="v3"><label for="v3">各地區</label>
<section class="opp"><h2>今日商機</h2>${arr(r.opportunities)
        .map(
          (o) => `<article><h3>${esc(o.title)}<b title="商機分 ${esc(o.score)}/5">${stars(o.score)}</b></h3><p>${esc(o.idea)}</p><p class="ev">📌 ${esc(o.evidence)}</p><div>${tags(o.regions)}</div></article>`
        )
        .join("")}</section>
<section class="trend"><h2>跨地區趨勢</h2>${arr(r.trends)
        .map((t) => `<article><h3>${esc(t.title)}</h3><p>${esc(t.detail)}</p><div>${tags(t.regions)}</div></article>`)
        .join("")}${arr(r.watch).length ? `<h2>同之前比較</h2><ul>${arr(r.watch).map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}</section>
<section class="geo"><h2>各地區一句</h2><dl>${GEOS.map(
        (g) => `<div><dt>${NAMES[g]}</dt><dd>${esc(r.regions?.[g] ?? "—")}</dd></div>`
      ).join("")}</dl></section>
<footer>${arr(r.caveats).map(esc).join("・")}${r.caveats?.length ? "・" : ""}AI 根據公開熱門資料寫成，只作參考，唔係投資建議。</footer>`;

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${day ? `${esc(day)} ` : ""}商業分析報告｜BizIdea 商機雷達</title><meta name="description" content="${esc(r?.headline ?? "BizIdea 每日商業分析報告")}">
<link rel="icon" href="${FAVICON}"><style>
:root{--bg:#f6f7f5;--card:#fff;--fg:#1c2421;--mute:#6b7570;--line:#e3e6e3;--acc:#0b7a55;--tag:#e6f2ec}
@media(prefers-color-scheme:dark){:root{--bg:#121614;--card:#1b201e;--fg:#e8ece9;--mute:#94a09a;--line:#2b322f;--acc:#3ddc97;--tag:#21302a}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,"PingFang TC","Microsoft JhengHei",sans-serif;background:var(--bg);color:var(--fg);height:100dvh;display:flex;flex-direction:column}
header{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:12px 16px 6px}h1{font-size:20px;margin:0}header a{color:var(--acc);text-decoration:none;font-size:13px}header nav{display:flex;gap:12px;margin-left:auto}
main{flex:1;min-height:0;display:grid;grid-template-columns:2fr 1fr;grid-template-rows:auto minmax(0,1fr) auto;gap:8px;padding:0 16px 8px}
.headline{grid-column:1/-1;margin:0;font-size:17px;font-weight:600}.none{grid-column:1/-1;color:var(--mute)}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;overflow:hidden;min-height:0}
h2{font-size:14px;margin:0 0 6px;color:var(--acc)}h3{font-size:14px;margin:0;display:flex;justify-content:space-between;gap:8px}h3 b{color:#e0a100;font-weight:400;white-space:nowrap}
article{padding:6px 0;border-bottom:1px solid var(--line)}article:last-child{border:0}article p{margin:2px 0}.ev{color:var(--mute);font-size:12.5px}
i{font-style:normal;font-size:11px;background:var(--tag);color:var(--acc);border-radius:4px;padding:0 5px;margin-right:4px}
.opp{display:grid;grid-template-columns:1fr 1fr;gap:0 16px;align-content:start}.opp h2{grid-column:1/-1}
ul{margin:0;padding-left:18px}li{margin:2px 0}
.geo{grid-column:1/-1}dl{margin:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:4px 12px}dl div{min-width:0}dt{font-weight:600;color:var(--acc);font-size:12px}dd{margin:0;font-size:12px;color:var(--fg)}
main footer{grid-column:1/-1;padding:0;color:var(--mute);font-size:12px}input,label{display:none}
@media(max-width:760px){main{grid-template-columns:repeat(3,1fr);grid-template-rows:auto auto minmax(0,1fr);align-content:start}
.headline{font-size:15px}label{display:block;text-align:center;padding:7px 0;border-radius:8px;cursor:pointer}input:checked+label{background:var(--acc);color:var(--bg)}
section{display:none;grid-column:1/-1;grid-row:3;overflow:auto}#v1:checked~.opp,#v2:checked~.trend,#v3:checked~.geo{display:block}
.opp{grid-template-columns:1fr}dl{grid-template-columns:1fr 1fr}}
</style></head><body><header><h1>商業分析報告</h1><span>${esc(day ?? "")}</span><a href="/">← 返雷達</a><nav>${navLinks}</nav></header><main>${body}</main></body></html>`;
}

const html = (s, maxAge = 60) =>
  new Response(s, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": `public, max-age=${maxAge}` } });

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect(env));
  },
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === "/") return html(await page(env));
    if (path === "/api/data")
      return new Response(JSON.stringify(await apiData(env)), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    const m = path.match(/^\/report(?:\/(\d{4}-\d{2}-\d{2}))?\/?$/);
    if (m) return html(await reportPage(env, m[1]), 300);
    return new Response("Not found", { status: 404 });
  },
};
