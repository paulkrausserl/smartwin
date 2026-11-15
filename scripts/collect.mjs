// Täglicher Datensammler für das Radar (läuft als GitHub Action, siehe .github/workflows/collect.yml).
// Sammelt serverseitig, was im Browser langsam oder gesperrt ist, und schreibt alles nach data/radar.json:
//   Wikipedia-Aufrufe (englisch und 7 weitere Sprachen), Google Trends, News (GDELT und Google News), Hacker News,
//   Mastodon-Hashtags, GitHub- und arXiv-Aktivität (Tech-Themen), IMF-Prognosen (Länder), CoinGecko-Trends
//   und Kartenpreis-Indizes (Cardmarket), dazu je Thema einen täglichen Aufmerksamkeits-Index für den Verlauf über Wochen.
// Fällt eine Quelle aus, bleiben die Daten vom Vortag stehen.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const OUT = 'data/radar.json';
const DAY_MS = 864e5;
const UA = 'SmartWinRadar/1.0 (+https://github.com/paulkrausserl/smartwin)';
const ymd = d => d.toISOString().slice(0, 10);
const today = ymd(new Date());
const sleep = ms => new Promise(r => setTimeout(r, process.env.FAST ? 0 : ms)); // FAST=1 nur zum lokalen Testen
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Themen direkt aus radar.html lesen, damit es nur eine Liste gibt
const html = await readFile('radar.html', 'utf8');
const THEMES = Function(`return ${html.match(/const THEMES = (\[[\s\S]*?\n\]);/)[1]}`)();
const prev = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => ({}));
const out = { updated: new Date().toISOString(), themes: {}, cards: {}, history: {}, macro: {}, trendingCoins: [] };
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// wie in radar.html
const tagFor = t => t.tag || t.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const newsFor = t => t.news || `"${(t.wiki || t.name).replace(/["()]/g, '')}"`;
const trendsFor = t => t.trends || newsFor(t).replace(/[()"]/g, '').split(' OR ')[0].trim();

async function get(url, { headers = {}, timeout = 60000, text = false } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${new URL(url).host} antwortet mit ${res.status}`);
  return text ? res.text() : res.json();
}
const keep = (id, src, error) => {
  const old = prev.themes?.[id]?.[src];
  log(`  ${id}/${src}: ${error}${old && !old.error ? ' (Vortag bleibt)' : ''}`);
  return old && !old.error ? { ...old, stale: true } : { error };
};
const slot = id => (out.themes[id] ||= {});

/* --- News: GDELT. Offiziell ein Abruf alle 5 Sekunden, GitHub-Server teilen sich aber IP-Adressen,
   deshalb großzügiger Abstand und bei „zu viele Anfragen“ oder Abbruch bis zu zweimal neu versuchen. --- */
// GDELT sperrt GitHub-Server nach rund zehn schnellen Abrufen. Deshalb nur wenige Themen pro Lauf, im Wechsel:
// zuerst die ohne Daten, dann die mit den ältesten. Ein Jahresverlauf veraltet in ein paar Tagen kaum.
const NEWS_PER_RUN = 12;
async function collectNews() {
  const yesterday = ymd(new Date(Date.now() - DAY_MS));
  const deadline = Date.now() + 18 * 60000;
  let refused = 0, tried = 0;
  const age = t => { const n = prev.themes?.[t.id]?.news; return !n || n.error ? 0 : Date.parse(n.at || '2000-01-01'); };
  for (const t of [...THEMES].sort((a, b) => age(a) - age(b))) {
    const old = prev.themes?.[t.id]?.news;
    if (tried >= NEWS_PER_RUN || Date.now() > deadline || refused >= 3) {
      // diesmal nicht dran: alte Daten unverändert übernehmen
      slot(t.id).news = old && !old.error ? old : keep(t.id, 'news', refused >= 3 ? 'GDELT sperrt den Sammler gerade' : 'kommt in einem der nächsten Läufe');
      continue;
    }
    tried++;
    try {
      const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
      Object.entries({ query: newsFor(t), mode: 'timelinevolraw', format: 'json', timespan: '1y' }).forEach(([k, v]) => url.searchParams.set(k, v));
      let body;
      for (let i = 0; body === undefined; i++) {
        try { body = await get(url, { text: true }); }
        catch (e) { if (i === 1 || !/429|fetch failed|aborted|timeout/i.test(e.message)) throw e; await sleep(30000); }
      }
      // gestern und heute sind bei GDELT noch unvollständig
      const data = (JSON.parse(body).timeline?.[0]?.data || []).filter(x => `${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}` < yesterday);
      if (!data.length) throw new Error('keine Treffer');
      const d = x => `${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`;
      // kompakt: Datum je Punkt, Artikel, Anteil an allen Artikeln in Promille
      slot(t.id).news = { at: today, d: data.map(d), v: data.map(x => x.value), p: data.map(x => (x.norm ? round((x.value / x.norm) * 1000, 4) : 0)) };
      refused = 0;
    } catch (e) {
      if (/429|fetch failed|aborted|timeout/i.test(e.message)) refused++;
      slot(t.id).news = keep(t.id, 'news', e.message.startsWith('Unexpected') ? 'GDELT lieferte keine Daten' : /429/.test(e.message) ? 'GDELT bremst den Sammler' : e.message);
    }
    await sleep(25000);
  }
  log(`News fertig (${tried} abgefragt)`);
}

/* --- Google Trends: inoffizielle Schnittstelle, wöchentliche Werte 0–100 über 12 Monate --------- */
async function collectTrends() {
  let cookie = '';
  try {
    const res = await fetch('https://trends.google.com/trends/explore?geo=US', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  } catch { /* ohne Cookie probieren */ }
  const g = async url => {
    const body = await get(url, { text: true, headers: { 'User-Agent': 'Mozilla/5.0', Cookie: cookie } });
    return JSON.parse(body.slice(body.indexOf('{')));
  };
  let blocked = 0;
  for (const t of THEMES) {
    if (blocked >= 3) { slot(t.id).trends = keep(t.id, 'trends', 'Google Trends hat den Sammler gesperrt'); continue; }
    try {
      const req = { comparisonItem: [{ keyword: trendsFor(t), geo: '', time: 'today 12-m' }], category: 0, property: '' };
      const ex = await g(`https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`);
      const w = ex.widgets.find(x => x.id === 'TIMESERIES');
      const data = await g(`https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(w.request))}&token=${w.token}`);
      const tl = data.default.timelineData || [];
      if (!tl.length) throw new Error('keine Daten');
      slot(t.id).trends = { kw: trendsFor(t), d: tl.map(p => ymd(new Date(Number(p.time) * 1000))), v: tl.map(p => p.value[0]) };
      blocked = 0;
    } catch (e) {
      if (/429/.test(e.message)) blocked++;
      slot(t.id).trends = keep(t.id, 'trends', /429/.test(e.message) ? 'Google Trends bremst' : e.message);
    }
    await sleep(9000 + Math.random() * 4000);
  }
  log('Trends fertig');
}

/* --- Hacker News (Algolia-Suche, ohne Key): Erwähnungen in Beiträgen und Kommentaren.
   Letzte 30 Tage im Vergleich zum Monatsschnitt der 11 Monate davor. Vor allem für Tech- und Krypto-Themen aussagekräftig. --- */
async function hnCount(q, from, to) {
  const url = new URL('https://hn.algolia.com/api/v1/search_by_date');
  // ohne Tippfehler-Toleranz, sonst zählt „matcha“ auch jedes „match“
  Object.entries({ query: q, advancedSyntax: 'true', typoTolerance: 'false', hitsPerPage: '0', numericFilters: `created_at_i>${Math.floor(from / 1000)},created_at_i<${Math.floor(to / 1000)}` }).forEach(([k, v]) => url.searchParams.set(k, v));
  return (await get(url)).nbHits ?? 0;
}
async function collectHn() {
  for (const t of THEMES) {
    try {
      const kw = trendsFor(t), q = kw.includes(' ') ? `"${kw}"` : kw, now = Date.now();
      const recent = await hnCount(q, now - 30 * DAY_MS, now);
      const before = await hnCount(q, now - 360 * DAY_MS, now - 30 * DAY_MS);
      slot(t.id).hn = { kw, now: recent, base: round(before / 11, 1) };
    } catch (e) { slot(t.id).hn = keep(t.id, 'hn', e.message); }
    await sleep(250);
  }
  log('Hacker News fertig');
}

/* --- Wikipedia: tägliche Aufrufe der englischen Seite über gut ein Jahr (für den Vorjahresvergleich) --- */
async function collectWiki() {
  const titles = [...new Set(THEMES.map(t => t.wiki))];
  const resolved = {};
  for (let i = 0; i < titles.length; i += 50) {
    try {
      const url = new URL('https://en.wikipedia.org/w/api.php');
      Object.entries({ action: 'query', titles: titles.slice(i, i + 50).join('|'), redirects: '1', format: 'json', formatversion: '2' }).forEach(([k, v]) => url.searchParams.set(k, v));
      const body = await get(url);
      const map = x => { for (const n of body.query?.normalized || []) if (n.from === x) x = n.to; for (const r of body.query?.redirects || []) if (r.from === x) x = r.to; return x; };
      const missing = new Set((body.query?.pages || []).filter(p => p.missing || p.invalid).map(p => p.title));
      for (const x of titles.slice(i, i + 50)) { const m = map(x); resolved[x] = missing.has(m) ? null : m; }
    } catch (e) { log(`Wikipedia-Titel: ${e.message}`); }
  }
  const end = new Date(Date.now() - DAY_MS), start = new Date(end - 420 * DAY_MS);
  const fmt = d => ymd(d).replace(/-/g, '');
  const queue = [...THEMES];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const t = queue.shift(), title = resolved[t.wiki];
      if (title === null) { slot(t.id).wiki = { error: 'Kein passender Wikipedia-Artikel gefunden' }; continue; }
      if (!title) { slot(t.id).wiki = keep(t.id, 'wiki', 'Titel nicht aufgelöst'); continue; }
      try {
        const body = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(title.replace(/ /g, '_'))}/daily/${fmt(start)}/${fmt(end)}`);
        const byDay = new Map((body.items || []).map(it => [`${it.timestamp.slice(0, 4)}-${it.timestamp.slice(4, 6)}-${it.timestamp.slice(6, 8)}`, it.views]));
        const v = [];
        for (let d = new Date(ymd(start)); d <= end; d = new Date(+d + DAY_MS)) v.push(byDay.get(ymd(d)) ?? 0);
        const first = v.findIndex(x => x > 0);
        if (first < 0) throw new Error('keine Aufrufe');
        // kompakt: erster Tag und die Tageswerte ab dort
        slot(t.id).wiki = { title, start: ymd(new Date(+new Date(ymd(start)) + first * DAY_MS)), v: v.slice(first) };
      } catch (e) { slot(t.id).wiki = keep(t.id, 'wiki', e.message); }
    }
  }));
  log('Wikipedia fertig');
  await collectWikiLangs(resolved);
}

/* --- Wikipedia in weiteren Sprachen: zeigt Interesse außerhalb der englischsprachigen Welt.
   Gespeichert wird je Sprache nur die Zusammenfassung (sonst würde die Datei zu groß). --- */
const LANGS = ['de', 'fr', 'es', 'ja', 'ko', 'zh', 'pt'];
async function collectWikiLangs(resolved) {
  const titles = [...new Set(Object.values(resolved).filter(Boolean))];
  const links = {}; // englischer Titel -> { sprache: titel }
  for (let i = 0; i < titles.length; i += 50) {
    try {
      let cont = {};
      do {
        const url = new URL('https://en.wikipedia.org/w/api.php');
        Object.entries({ action: 'query', titles: titles.slice(i, i + 50).join('|'), prop: 'langlinks', lllimit: 'max', format: 'json', formatversion: '2', ...cont }).forEach(([k, v]) => url.searchParams.set(k, v));
        const body = await get(url);
        for (const pg of body.query?.pages || []) for (const l of pg.langlinks || []) if (LANGS.includes(l.lang)) (links[pg.title] ||= {})[l.lang] = l.title;
        cont = body.continue || null;
      } while (cont);
    } catch (e) { log(`Sprachversionen: ${e.message}`); }
  }
  const end = new Date(Date.now() - DAY_MS), start = new Date(end - 420 * DAY_MS);
  const fmt = d => ymd(d).replace(/-/g, '');
  const jobs = [];
  for (const t of THEMES) for (const [lang, title] of Object.entries(links[resolved[t.wiki]] || {})) jobs.push({ t, lang, title });
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (jobs.length) {
      const { t, lang, title } = jobs.shift();
      try {
        const body = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia/all-access/user/${encodeURIComponent(title.replace(/ /g, '_'))}/daily/${fmt(start)}/${fmt(end)}`);
        const v = (body.items || []).map(it => it.views);
        if (v.length < 90) continue;
        const now = mean(v.slice(-30)), base = median(v.slice(0, -30));
        const yearAgo = v.length >= 395 ? mean(v.slice(-395, -365)) : null;
        ((slot(t.id).langs ||= {}))[lang] = { title, now: round(now, 1), base: round(base, 1), yoy: yearAgo != null ? round(yearAgo, 1) : null };
      } catch { /* einzelne Sprache fehlt: egal */ }
    }
  }));
  log(`Wikipedia-Sprachen fertig (${Object.values(out.themes).filter(x => x.langs).length} Themen)`);
}

/* --- Google News (RSS, ohne Key): News-Menge pro Tag, letzte 7 Tage ggü. einer Woche vor 2 und vor 4 Monaten.
   Der Feed liefert höchstens 100 Meldungen; ist er voll, wird die Rate aus der abgedeckten Zeitspanne geschätzt. --- */
async function gnewsRate(q, from, to) {
  const query = `${q} after:${ymd(new Date(from))} before:${ymd(new Date(to))}`;
  const xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`, { text: true, headers: { Accept: 'application/rss+xml' } });
  const dates = [...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map(m => Date.parse(m[1])).filter(Number.isFinite).filter(d => d >= from - DAY_MS && d <= to + DAY_MS);
  const days = (to - from) / DAY_MS;
  if (dates.length < 100) return dates.length / days;
  return 100 / Math.max((to - Math.min(...dates)) / DAY_MS, 1 / 24);
}
async function collectGnews() {
  for (const t of THEMES) {
    try {
      const q = newsFor(t), now = Date.now();
      const recent = await gnewsRate(q, now - 7 * DAY_MS, now);
      await sleep(1500);
      const b1 = await gnewsRate(q, now - 67 * DAY_MS, now - 60 * DAY_MS);
      await sleep(1500);
      const b2 = await gnewsRate(q, now - 127 * DAY_MS, now - 120 * DAY_MS);
      slot(t.id).gnews = { q, now: round(recent, 2), base: round((b1 + b2) / 2, 2) };
    } catch (e) { slot(t.id).gnews = keep(t.id, 'gnews', e.message); }
    await sleep(1500);
  }
  log('Google News fertig');
}

/* --- GitHub (neue Projekte, deren Name oder Beschreibung das Thema nennt) und arXiv (neue Forschungsarbeiten):
   Entwickler- und Forscher-Interesse. Nur für Technologie und Krypto, dort ist das aussagekräftig. --- */
const TECH = t => t.group === 'Technologie' || t.group === 'Krypto';
async function ghCount(kw, range) {
  const q = `${kw.includes(' ') ? `"${kw}"` : kw} in:name,description,topics created:${range}`;
  const body = await get(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=1`, {
    headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
  });
  return body.total_count ?? 0;
}
async function collectGithub() {
  const d = n => ymd(new Date(Date.now() - n * DAY_MS));
  for (const t of THEMES.filter(TECH)) {
    try {
      const kw = trendsFor(t);
      const recent = await ghCount(kw, `${d(30)}..${d(0)}`);
      await sleep(2500); // Suche erlaubt 30 Abrufe pro Minute
      const before = await ghCount(kw, `${d(360)}..${d(31)}`);
      slot(t.id).github = { kw, now: recent, base: round(before / 11, 1) };
    } catch (e) { slot(t.id).github = keep(t.id, 'github', e.message); }
    await sleep(2500);
  }
  log('GitHub fertig');
}
async function arxivCount(kw, from, to) {
  const f = x => ymd(new Date(x)).replace(/-/g, '');
  const q = `all:"${kw}" AND submittedDate:[${f(from)}0000 TO ${f(to)}2359]`;
  const xml = await get(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&max_results=0`, { text: true, headers: { Accept: 'application/atom+xml' } });
  return Number(xml.match(/<opensearch:totalResults[^>]*>(\d+)</)?.[1] ?? NaN);
}
async function collectArxiv() {
  for (const t of THEMES.filter(x => x.group === 'Technologie')) {
    try {
      const kw = trendsFor(t), now = Date.now();
      const recent = await arxivCount(kw, now - 30 * DAY_MS, now);
      await sleep(3500); // arXiv bittet um 3 Sekunden Abstand
      const before = await arxivCount(kw, now - 360 * DAY_MS, now - 31 * DAY_MS);
      if (!Number.isFinite(recent) || !Number.isFinite(before)) throw new Error('arXiv lieferte keine Zahl');
      slot(t.id).arxiv = { kw, now: recent, base: round(before / 11, 1) };
    } catch (e) { slot(t.id).arxiv = keep(t.id, 'arxiv', e.message); }
    await sleep(3500);
  }
  log('arXiv fertig');
}

/* --- IMF-Prognosen für die Länder: BIP-Wachstum und Inflation, je Jahr (ein Abruf je Kennzahl für alle Länder) --- */
async function collectMacro() {
  const countries = THEMES.filter(t => t.iso);
  for (const [key, ind] of [['gdp', 'NGDP_RPCH'], ['cpi', 'PCPIPCH']]) {
    try {
      const body = await get(`https://www.imf.org/external/datamapper/api/v1/${ind}/${countries.map(t => t.iso).join('/')}`);
      const vals = body.values?.[ind] || {};
      const y = new Date().getUTCFullYear();
      for (const t of countries) {
        const row = vals[t.iso];
        if (row) (out.macro[t.id] ||= {})[key] = Object.fromEntries([y - 1, y, y + 1].filter(yr => row[yr] != null).map(yr => [yr, round(row[yr], 1)]));
      }
    } catch (e) {
      log(`IMF ${ind}: ${e.message}`);
      for (const t of countries) if (prev.macro?.[t.id]?.[key]) (out.macro[t.id] ||= {})[key] = prev.macro[t.id][key];
    }
  }
  log(`IMF fertig (${Object.keys(out.macro).length} Länder)`);
}

/* --- CoinGecko: die meistgesuchten Coins der letzten 24 Stunden --- */
async function collectTrendingCoins() {
  try {
    const body = await get('https://api.coingecko.com/api/v3/search/trending');
    out.trendingCoins = (body.coins || []).map(c => c.item?.id).filter(Boolean);
    log(`CoinGecko-Trends: ${out.trendingCoins.join(', ')}`);
  } catch (e) { log(`CoinGecko-Trends: ${e.message}`); out.trendingCoins = prev.trendingCoins || []; }
}

/* --- Mastodon: liefert 7 Tage, der Verlauf wächst hier jeden Tag weiter ---------------------- */
async function collectMasto() {
  for (const t of THEMES) {
    const hist = { ...(prev.themes?.[t.id]?.masto?.hist || {}) };
    try {
      const res = await fetch(`https://mastodon.social/api/v1/tags/${encodeURIComponent(tagFor(t))}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (res.ok) for (const h of (await res.json()).history || []) hist[ymd(new Date(Number(h.day) * 1000))] = Number(h.uses) || 0;
      else if (res.status !== 404) throw new Error(`mastodon.social antwortet mit ${res.status}`);
      const days = Object.keys(hist).sort().slice(-400);
      slot(t.id).masto = { tag: tagFor(t), hist: Object.fromEntries(days.map(k => [k, hist[k]])) };
    } catch (e) {
      slot(t.id).masto = Object.keys(hist).length ? { tag: tagFor(t), hist, stale: true } : { error: e.message };
    }
    await sleep(400);
  }
  log('Mastodon fertig');
}

/* --- Kartenpreise (Cardmarket, Euro) ---------------------------------------------------------
   Korb der wertvollsten Karten. Der Index wird verkettet: Jeden Tag zählt die durchschnittliche Preisänderung
   der Karten, die gestern und heute im Korb sind. So stört es nicht, wenn neue Karten dazukommen.
   Durchschnitt = geometrisches Mittel ohne die extremsten 10 % je Seite. (Vorher Median: Weil sich an einem Tag
   meist nur ein Teil der Karten bewegt, lag der Median fast immer bei genau 1 und der Index blieb auf 100 stehen.) */
function trimmedGeoMean(ratios) {
  const s = ratios.map(Math.log).sort((a, b) => a - b), cut = Math.floor(s.length * 0.1);
  return Math.exp(mean(s.slice(cut, s.length - cut)));
}
function chainIndex(key, label, prices, extra = {}) {
  const old = prev.cards?.[key];
  const series = (old?.series || []).filter(p => p[0] !== today);
  let level = 100, moved = null;
  if (series.length && old?.prices) {
    const ratios = Object.entries(prices).filter(([id, p]) => old.prices[id] > 0.5 && p > 0.5).map(([id, p]) => p / old.prices[id]);
    level = series.at(-1)[1] * (ratios.length >= 10 ? trimmedGeoMean(ratios) : 1);
    moved = ratios.length ? round(ratios.filter(r => Math.abs(r - 1) > 0.001).length / ratios.length, 2) : null;
  }
  series.push([today, round(level, 2)]);
  const vals = Object.values(prices);
  out.cards[key] = { label, n: vals.length, typical: round(median(vals), 2), moved, ...extra, series: series.slice(-800), prices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, round(v, 2)])) };
  log(`Karten ${key}: ${vals.length} Karten, Index ${round(level, 2)}, ${moved == null ? '–' : `${Math.round(moved * 100)} % bewegt`}${extra.momentum ? `, Trend ${round((extra.momentum - 1) * 100, 1)} %` : ''}${extra.priceDate ? `, Preise vom ${extra.priceDate}` : ''}`);
}
const keepCards = (key, e) => { log(`Karten ${key}: ${e.message}`); if (prev.cards?.[key]) out.cards[key] = { ...prev.cards[key], stale: true }; };

async function collectPokemon() {
  try {
    const q = encodeURIComponent('rarity:"Special Illustration Rare"');
    let body;
    for (let i = 0; i < 3 && !body; i++) {
      try { body = await get(`https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=250&orderBy=-set.releaseDate&select=id,cardmarket`, { timeout: 90000 }); }
      catch (e) { if (i === 2) throw e; await sleep(20000); }
    }
    const prices = {}, mom = [], dates = [];
    for (const c of body.data || []) {
      const p = c.cardmarket?.prices;
      if (c.cardmarket?.updatedAt) dates.push(c.cardmarket.updatedAt.replace(/\//g, '-'));
      const price = p?.trendPrice || p?.avg1;
      if (!(price > 0.5)) continue;
      prices[c.id] = price;
      // Gestern ggü. 30-Tage-Schnitt: zeigt sofort, ob die Preise gerade anziehen
      if (p.avg1 > 0.5 && p.avg30 > 0.5) mom.push(p.avg1 / p.avg30);
    }
    if (Object.keys(prices).length < 10) throw new Error('zu wenige Kartenpreise');
    // Stand der Preise bei der Quelle: pokemontcg.io aktualisiert nicht immer täglich
    const priceDate = dates.sort().at(-1) || null;
    chainIndex('pokemon', 'Pokémon (Special Illustration Rares)', prices, { momentum: mom.length >= 10 ? round(median(mom), 4) : null, priceDate });
  } catch (e) { keepCards('pokemon', e); }
}

async function collectMtg() {
  try {
    const body = await get(`https://api.scryfall.com/cards/search?q=${encodeURIComponent('eur>=20 -is:digital')}&order=eur&dir=desc&unique=cards`);
    const prices = {};
    for (const c of body.data || []) { const p = Number(c.prices?.eur); if (p > 0.5) prices[c.id] = p; }
    if (Object.keys(prices).length < 10) throw new Error('zu wenige Kartenpreise');
    chainIndex('mtg', 'Magic (175 teuerste Karten)', prices);
  } catch (e) { keepCards('mtg', e); }
}

async function collectYugioh() {
  try {
    const body = await get('https://db.ygoprodeck.com/api/v7/cardinfo.php', { timeout: 120000 });
    const all = (body.data || []).map(c => [String(c.id), Number(c.card_prices?.[0]?.cardmarket_price)]).filter(([, p]) => p > 0.5);
    all.sort((a, b) => b[1] - a[1]);
    const prices = Object.fromEntries(all.slice(0, 200));
    if (Object.keys(prices).length < 10) throw new Error('zu wenige Kartenpreise');
    chainIndex('yugioh', 'Yu-Gi-Oh! (200 teuerste Karten)', prices);
  } catch (e) { keepCards('yugioh', e); }
}

log(`${THEMES.length} Themen`);
await Promise.all([
  collectWiki(), collectNews(), collectTrends(), collectHn(), collectMasto(), collectGnews(), collectGithub(), collectArxiv(),
  (async () => { await collectPokemon(); await collectMtg(); await collectYugioh(); await collectMacro(); await collectTrendingCoins(); })(),
]);

/* --- Aufmerksamkeits-Index je Thema und Tag: geometrisches Mittel aller verfügbaren Quellen-Verhältnisse
   („wie viel mehr Aufmerksamkeit als normal“). Daraus zeigt die Seite die Bewegung über Tage und Wochen. --- */
const ratios = x => {
  const r = [];
  if (x.wiki?.v?.length > 60) { const v = x.wiki.v; r.push((mean(v.slice(-30)) + 1) / (median(v.slice(0, -30)) + 1)); }
  if (x.trends?.v?.length > 12) { const v = x.trends.v; r.push((mean(v.slice(-4)) + 1) / (median(v.slice(0, -4)) + 1)); }
  if (x.news?.p?.length > 60) { const v = x.news.p; r.push((mean(v.slice(-30)) + 1e-3) / (median(v.slice(0, -30)) + 1e-3)); }
  if (x.hn && !x.hn.error && x.hn.base >= 3) r.push((x.hn.now + 1) / (x.hn.base + 1));
  if (x.gnews && !x.gnews.error && x.gnews.base >= 0.3) r.push((x.gnews.now + 0.1) / (x.gnews.base + 0.1));
  const langs = Object.values(x.langs || {});
  if (langs.length) { const n = langs.reduce((a, l) => a + l.now, 0), b = langs.reduce((a, l) => a + l.base, 0); if (b >= 20) r.push((n + 1) / (b + 1)); }
  if (x.github && !x.github.error && x.github.base >= 3) r.push((x.github.now + 1) / (x.github.base + 1));
  if (x.arxiv && !x.arxiv.error && x.arxiv.base >= 3) r.push((x.arxiv.now + 1) / (x.arxiv.base + 1));
  return r;
};
for (const t of THEMES) {
  const r = ratios(out.themes[t.id] || {});
  const hist = (prev.history?.[t.id] || []).filter(p => p[0] !== today);
  if (r.length) hist.push([today, round(Math.exp(mean(r.map(Math.log))), 3), r.length]);
  out.history[t.id] = hist.slice(-180);
}

const count = src => Object.values(out.themes).filter(x => x[src] && !x[src].error).length;
out.summary = Object.fromEntries(['wiki', 'langs', 'news', 'gnews', 'trends', 'hn', 'masto', 'github', 'arxiv'].map(s => [s, count(s)]));
log('Ergebnis', JSON.stringify(out.summary), 'Karten:', Object.keys(out.cards).join(', ') || 'keine');
await mkdir('data', { recursive: true });
await writeFile(OUT, JSON.stringify(out));
