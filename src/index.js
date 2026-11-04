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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect(env));
  },
};
