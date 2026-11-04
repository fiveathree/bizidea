const GEOS = ["HK", "TW", "MO", "JP", "GB", "NL"];

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

async function fetchGeo(geo) {
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

async function collect(env) {
  const results = await Promise.allSettled(GEOS.map(fetchGeo));
  const stmt = env.DB.prepare(
    `INSERT INTO trends (geo, source, keyword, traffic, news_url, seen_at)
     VALUES (?, 'google_trends', ?, ?, ?, ?)
     ON CONFLICT (geo, source, keyword, seen_at) DO UPDATE SET traffic = excluded.traffic`
  );
  const rows = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") return console.log(`${GEOS[i]}: 暫無數據 (${r.reason.message})`);
    console.log(`${GEOS[i]}: ${r.value.length} 條`);
    for (const t of r.value) rows.push(stmt.bind(GEOS[i], t.keyword, t.traffic, t.news_url, t.seen_at));
  });
  if (rows.length) await env.DB.batch(rows);
}

const NAMES = { HK: "香港", TW: "台灣", MO: "澳門", JP: "日本", GB: "英國", NL: "荷蘭" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => (n == null ? "" : n >= 1e6 ? `${n / 1e6}M+` : n >= 1e3 ? `${n / 1e3}K+` : `${n}+`);
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#0b3d2e"/><circle cx="16" cy="16" r="9" fill="none" stroke="#3ddc97" stroke-width="2"/><path d="M16 16L26 9" stroke="#3ddc97" stroke-width="2.5"/><circle cx="21" cy="19" r="2" fill="#ffd166"/></svg>`
  );

async function page(env) {
  const { results } = await env.DB.prepare(
    `SELECT geo, keyword, MAX(traffic) traffic, MAX(news_url) news_url
     FROM trends WHERE seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
     GROUP BY geo, keyword ORDER BY traffic DESC`
  ).all();
  const today = new Date().toLocaleDateString("sv", { timeZone: "Asia/Taipei" });
  const next = new Date(Math.ceil(Date.now() / 3.6e6) * 3.6e6).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit",
  });
  const cols = GEOS.map((g, i) => {
    const items = results.filter((r) => r.geo === g).slice(0, 8);
    const list = items.length
      ? items
          .map(
            (r) =>
              `<li><a href="${esc(r.news_url || `https://www.google.com/search?q=${encodeURIComponent(r.keyword)}`)}" target="_blank" rel="noopener">${esc(r.keyword)}</a><small>${fmt(r.traffic)}</small></li>`
          )
          .join("")
      : `<li class="empty">暫無數據</li>`;
    return `<input type="radio" name="t" id="t${g}"${i ? "" : " checked"}><label for="t${g}">${NAMES[g]}</label><section><h2>${NAMES[g]}</h2><ol>${list}</ol></section>`;
  }).join("");
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BizIdea 商機雷達</title><meta name="description" content="香港、台灣、澳門、日本、英國、荷蘭每日網上熱搜，一版睇晒。">
<link rel="icon" href="${FAVICON}"><style>
:root{--bg:#f6f7f5;--card:#fff;--fg:#1c2421;--mute:#6b7570;--line:#e3e6e3;--acc:#0b7a55}
@media(prefers-color-scheme:dark){:root{--bg:#121614;--card:#1b201e;--fg:#e8ece9;--mute:#94a09a;--line:#2b322f;--acc:#3ddc97}}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 system-ui,"PingFang TC","Microsoft JhengHei",sans-serif;background:var(--bg);color:var(--fg);height:100dvh;display:flex;flex-direction:column}
header{display:flex;align-items:baseline;gap:12px;padding:12px 16px}h1{font-size:20px;margin:0}header span{color:var(--mute);font-size:13px}
main{flex:1;min-height:0;display:grid;grid-template-columns:repeat(6,1fr);gap:8px;padding:0 16px 16px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow:hidden}
h2{font-size:15px;margin:0 0 6px;color:var(--acc)}ol{margin:0;padding-left:20px}li{overflow-wrap:anywhere;padding:4px 0;border-bottom:1px solid var(--line)}li:last-child{border:0}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}small{color:var(--mute);margin-left:6px;font-size:12px}.empty{list-style:none;margin-left:-20px;color:var(--mute)}
input,label{display:none}footer{padding:0 16px 10px;color:var(--mute);font-size:12px}
@media(max-width:760px){main{grid-template-columns:repeat(6,1fr);grid-template-rows:auto 1fr;align-content:start}
label{display:block;grid-row:1;text-align:center;padding:8px 0;border-radius:8px;cursor:pointer;font-size:14px}
input:checked+label{background:var(--acc);color:var(--bg)}section{display:none;grid-row:2;grid-column:1/-1}input:checked+label+section{display:block}h2{display:none}}
</style></head><body><header><h1>BizIdea 商機雷達</h1><span>今日 ${today}・過去 24 小時熱搜・每小時整點更新，下次 ${next}（港台時間）</span></header><main>${cols}</main>
<footer>資料來源：Google Trends。每小時更新；AI 商機篩選即將推出。</footer></body></html>`;
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
