// Täglicher Datensammler für das Radar (läuft als GitHub Action, siehe .github/workflows/collect.yml).
// Sammelt serverseitig, was im Browser langsam oder gesperrt ist, und schreibt alles nach data/radar.json:
//   Wikipedia-Aufrufe (englisch und 7 weitere Sprachen), Google Trends, News (GDELT und Google News), Hacker News,
//   Mastodon-Hashtags, GitHub- und arXiv-Aktivität (Tech-Themen), IMF-Prognosen (Länder), CoinGecko-Trends
//   und Kartenpreis-Indizes (Cardmarket), dazu je Thema einen täglichen Aufmerksamkeits-Index für den Verlauf über Wochen.
//   Außerdem: Erwähnungen in US-Firmenberichten (SEC), Entwickler-Downloads (npm, PyPI), Rohstoffpreise (FRED/IMF),
//   Positionierung der Spekulanten (CFTC), Blockchain-Kennzahlen (DefiLlama), Fear & Greed, App-Store-Ränge
//   und „Neu aufgetaucht“ (Google-Trendsuchen, neue GitHub-Projekte, KI-Modelle im Trend).
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
const out = { updated: new Date().toISOString(), themes: {}, cards: {}, history: {}, macro: {}, trendingCoins: [],
  fred: {}, cot: {}, defi: {}, sentiment: {}, apps: {}, discover: {} };
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
  // „Steigende Suchanfragen“ kosten einen Abruf mehr: jeden Tag nur für die 20 Themen mit dem ältesten Stand
  const risingAge = t => Date.parse(prev.themes?.[t.id]?.trends?.risingAt || '2000-01-01');
  const risingToday = new Set([...THEMES].sort((a, b) => risingAge(a) - risingAge(b)).slice(0, 20).map(t => t.id));
  for (const t of THEMES) {
    if (blocked >= 3) { slot(t.id).trends = keep(t.id, 'trends', 'Google Trends hat den Sammler gesperrt'); continue; }
    try {
      const req = { comparisonItem: [{ keyword: trendsFor(t), geo: '', time: 'today 12-m' }], category: 0, property: '' };
      const ex = await g(`https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`);
      const w = ex.widgets.find(x => x.id === 'TIMESERIES');
      const data = await g(`https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(w.request))}&token=${w.token}`);
      const tl = data.default.timelineData || [];
      if (!tl.length) throw new Error('keine Daten');
      const old = prev.themes?.[t.id]?.trends;
      let rising = old?.rising || null, risingAt = old?.risingAt || null;
      const rq = ex.widgets.find(x => x.id === 'RELATED_QUERIES');
      if (rq && risingToday.has(t.id)) {
        try {
          await sleep(4000);
          const rel = await g(`https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(rq.request))}&token=${rq.token}`);
          rising = (rel.default?.rankedList?.[1]?.rankedKeyword || []).slice(0, 8).map(k => ({ q: k.query, v: k.formattedValue }));
          risingAt = today;
        } catch (e) { log(`  ${t.id}/steigende Suchen: ${e.message}`); }
      }
      slot(t.id).trends = { kw: trendsFor(t), d: tl.map(p => ymd(new Date(Number(p.time) * 1000))), v: tl.map(p => p.value[0]), rising, risingAt };
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
/* --- Erwähnungen in US-Firmenberichten (SEC EDGAR Volltextsuche): Wie viele Pflichtmitteilungen nennen das Thema?
   Firmen müssen dort vorsichtig formulieren; springen viele auf, ist das Narrativ in der Wirtschaft angekommen. --- */
const SEC_UA = 'SmartWin Radar research tool (github.com/paulkrausserl/smartwin)';
async function secCount(kw, from, to) {
  const q = `"${kw.replace(/"/g, '')}"`;
  const body = await get(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&dateRange=custom&startdt=${ymd(new Date(from))}&enddt=${ymd(new Date(to))}`, { headers: { 'User-Agent': SEC_UA } });
  return body.hits?.total?.value ?? 0;
}
async function collectSec() {
  let down = null;
  for (const t of THEMES.filter(x => x.group !== 'Länder')) {
    if (down) { slot(t.id).sec = keep(t.id, 'sec', down); continue; }
    try {
      const kw = trendsFor(t), now = Date.now();
      const recent = await secCount(kw, now - 30 * DAY_MS, now);
      await sleep(300);
      const before = await secCount(kw, now - 360 * DAY_MS, now - 31 * DAY_MS);
      slot(t.id).sec = { kw, now: recent, base: round(before / 11, 1) };
    } catch (e) {
      if (/40[13]/.test(e.message)) down = 'SEC lässt den Sammler gerade nicht zu';
      slot(t.id).sec = keep(t.id, 'sec', down || e.message);
    }
    await sleep(300);
  }
  log('SEC fertig');
}

/* --- Entwickler-Downloads (npm, PyPI) der wichtigsten Programmier-Pakete eines Tech-Themas: echte Nutzung --- */
async function devDaily(t) {
  const byDay = {};
  for (const pkg of t.dev.npm || []) {
    const body = await get(`https://api.npmjs.org/downloads/range/last-year/${pkg}`);
    for (const d of body.downloads || []) byDay[d.day] = (byDay[d.day] || 0) + d.downloads;
  }
  for (const pkg of t.dev.pypi || []) {
    const body = await get(`https://pypistats.org/api/packages/${encodeURIComponent(pkg)}/overall?mirrors=false`);
    for (const d of body.data || []) if (d.category === 'without_mirrors') byDay[d.date] = (byDay[d.date] || 0) + d.downloads;
    await sleep(1500); // pypistats ist klein, bitte schonend
  }
  return Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).filter(([d]) => d < today);
}
async function collectDev() {
  for (const t of THEMES.filter(x => x.dev)) {
    try {
      // PyPI liefert nur ~180 Tage: Vergleich daher über die letzten 6 Monate
      const days = (await devDaily(t)).slice(-180);
      if (days.length < 90) throw new Error('zu wenig Download-Daten');
      const v = days.map(([, x]) => x);
      const weeks = [];
      for (let e = v.length; e - 7 >= 0 && weeks.length < 26; e -= 7) weeks.unshift(v.slice(e - 7, e).reduce((a, b) => a + b, 0));
      slot(t.id).dev = { pkgs: [...(t.dev.npm || []), ...(t.dev.pypi || [])], now: Math.round(mean(v.slice(-30)) * 30), base: Math.round(mean(v.slice(0, -30)) * 30), w: weeks };
    } catch (e) { slot(t.id).dev = keep(t.id, 'dev', e.message); }
  }
  log('Downloads fertig');
}

/* --- Rohstoffpreise ohne Börsenkurs (Kakao, Kaffee, Olivenöl): Monatspreise des IMF über FRED, als CSV ohne Key --- */
async function collectFred() {
  for (const t of THEMES.filter(x => x.price?.fred)) {
    try {
      const csv = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${t.price.fred}`, { text: true, headers: { Accept: 'text/csv' } });
      const rows = csv.trim().split('\n').slice(1).map(l => l.split(',')).filter(([d, v]) => d && v && v !== '.').map(([d, v]) => [d, round(Number(v), 2)]);
      if (rows.length < 12) throw new Error('zu wenig Werte');
      out.fred[t.id] = { series: rows.slice(-120) };
    } catch (e) { log(`FRED ${t.price.fred}: ${e.message}`); if (prev.fred?.[t.id]) out.fred[t.id] = { ...prev.fred[t.id], stale: true }; }
  }
  log(`FRED fertig (${Object.keys(out.fred).length})`);
}

/* --- CFTC Commitments of Traders: Netto-Position der Spekulanten (Nicht-Kommerzielle) an den Terminbörsen.
   Eingeordnet als Perzentil der letzten 3 Jahre: ganz oben = so optimistisch wie selten (oft spätes Signal). --- */
async function collectCot() {
  const since = ymd(new Date(Date.now() - 3 * 365 * DAY_MS));
  for (const t of THEMES.filter(x => x.cot)) {
    try {
      const where = `(${t.cot.map(pat => `market_and_exchange_names like '${pat}'`).join(' OR ')}) AND report_date_as_yyyy_mm_dd > '${since}T00:00:00'`;
      const url = new URL('https://publicreporting.cftc.gov/resource/6dca-aqww.json');
      Object.entries({ $select: 'market_and_exchange_names,report_date_as_yyyy_mm_dd,open_interest_all,noncomm_positions_long_all,noncomm_positions_short_all', $where: where, $order: 'report_date_as_yyyy_mm_dd', $limit: '2000' }).forEach(([k, v]) => url.searchParams.set(k, v));
      const rows = await get(url);
      if (!rows.length) throw new Error('kein Markt gefunden');
      // bei mehreren Treffern den Markt mit dem größten offenen Interesse nehmen
      const oi = {};
      for (const r of rows) oi[r.market_and_exchange_names] = Math.max(oi[r.market_and_exchange_names] || 0, Number(r.open_interest_all) || 0);
      const market = Object.entries(oi).sort((a, b) => b[1] - a[1])[0][0];
      const m = rows.filter(r => r.market_and_exchange_names === market).map(r => ({ d: r.report_date_as_yyyy_mm_dd.slice(0, 10), net: Number(r.noncomm_positions_long_all) - Number(r.noncomm_positions_short_all), oi: Number(r.open_interest_all) }));
      const last = m.at(-1), ago = m.at(-5);
      out.cot[t.id] = {
        market, date: last.d, net: last.net, oi: last.oi,
        pct: Math.round((m.filter(x => x.net < last.net).length / m.length) * 100),
        change4w: ago ? round(((last.net - ago.net) / Math.max(1, last.oi)) * 100, 1) : null,
        series: m.map(x => [x.d, x.net]).slice(-156),
      };
    } catch (e) { log(`CFTC ${t.id}: ${e.message}`); if (prev.cot?.[t.id]) out.cot[t.id] = { ...prev.cot[t.id], stale: true }; }
    await sleep(500);
  }
  log(`CFTC fertig (${Object.keys(out.cot).length})`);
}

/* --- DefiLlama: Geld auf einer Blockchain (TVL) bzw. Gebühren eines Protokolls, täglich --- */
async function collectDefi() {
  for (const t of THEMES.filter(x => x.defi)) {
    try {
      let pts;
      if (t.defi.tvl) pts = (await get(`https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(t.defi.tvl)}`)).map(x => [ymd(new Date(x.date * 1000)), x.tvl]);
      else pts = ((await get(`https://api.llama.fi/summary/fees/${encodeURIComponent(t.defi.fees)}?dataType=dailyFees`)).totalDataChart || []).map(([ts, v]) => [ymd(new Date(ts * 1000)), v]);
      pts = pts.filter(([d]) => d < today).slice(-400);
      if (pts.length < 60) throw new Error('zu wenig Daten');
      out.defi[t.id] = { kind: t.defi.tvl ? 'tvl' : 'fees', name: t.defi.tvl || t.defi.fees, d: pts.map(p => p[0]), v: pts.map(p => Math.round(p[1])) };
    } catch (e) { log(`DefiLlama ${t.id}: ${e.message}`); if (prev.defi?.[t.id]) out.defi[t.id] = { ...prev.defi[t.id], stale: true }; }
  }
  log(`DefiLlama fertig (${Object.keys(out.defi).length})`);
}

/* --- Marktstimmung: Fear & Greed Index für Krypto (alternative.me) und Aktien (CNN) --- */
async function collectSentiment() {
  try {
    const body = await get('https://api.alternative.me/fng/?limit=365&format=json');
    const pts = (body.data || []).map(x => [ymd(new Date(Number(x.timestamp) * 1000)), Number(x.value), x.value_classification]).reverse();
    out.sentiment.crypto = { now: pts.at(-1)[1], label: pts.at(-1)[2], d: pts.map(p => p[0]), v: pts.map(p => p[1]) };
  } catch (e) { log(`Fear & Greed Krypto: ${e.message}`); if (prev.sentiment?.crypto) out.sentiment.crypto = { ...prev.sentiment.crypto, stale: true }; }
  try {
    const body = await get(`https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${ymd(new Date(Date.now() - 365 * DAY_MS))}`, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: 'https://edition.cnn.com/' } });
    const pts = (body.fear_and_greed_historical?.data || []).map(x => [ymd(new Date(x.x)), Math.round(x.y)]);
    out.sentiment.stocks = { now: Math.round(body.fear_and_greed.score), label: body.fear_and_greed.rating, d: pts.map(p => p[0]), v: pts.map(p => p[1]) };
  } catch (e) { log(`Fear & Greed Aktien: ${e.message}`); if (prev.sentiment?.stocks) out.sentiment.stocks = { ...prev.sentiment.stocks, stale: true }; }
  log('Stimmung fertig');
}

/* --- App-Store-Ränge (Apple, kostenlose Apps, USA und Deutschland): Springt die Coinbase-App nach oben,
   sind Privatanleger im Rausch. Bekannter, eher später Hype-Indikator. --- */
const APPS = [['coinbase', /^coinbase/i], ['cryptocom', /crypto\.com/i], ['binance', /binance/i], ['robinhood', /robinhood/i], ['traderepublic', /trade republic/i], ['pokemontcg', /pok[eé]mon tcg pocket/i]];
async function collectApps() {
  const feeds = { us: 'us/rss/topfreeapplications/limit=200', usFin: 'us/rss/topfreeapplications/limit=200/genre=6015', de: 'de/rss/topfreeapplications/limit=200', deFin: 'de/rss/topfreeapplications/limit=200/genre=6015' };
  const ranks = {};
  for (const [k, path] of Object.entries(feeds)) {
    try {
      const names = ((await get(`https://itunes.apple.com/${path}/json`)).feed?.entry || []).map(e => e['im:name']?.label || '');
      if (!names.length) throw new Error('leere Liste');
      for (const [app, re] of APPS) { const i = names.findIndex(n => re.test(n)); (ranks[app] ||= {})[k] = i >= 0 ? i + 1 : null; }
    } catch (e) { log(`App Store ${k}: ${e.message}`); }
  }
  for (const [app] of APPS) {
    const hist = (prev.apps?.[app] || []).filter(p => p[0] !== today);
    if (ranks[app]) hist.push([today, ranks[app]]);
    out.apps[app] = hist.slice(-180);
  }
  log(`App Store fertig: Coinbase ${JSON.stringify(ranks.coinbase || {})}`);
}

/* --- Neu aufgetaucht: Begriffe, die gerade hochschießen, auch außerhalb der Themenliste --- */
const decode = x => x.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
async function collectDiscover() {
  const d = { google: [], github: [], hf: [] };
  for (const geo of ['US', 'DE']) {
    try {
      const xml = await get(`https://trends.google.com/trending/rss?geo=${geo}`, { text: true, headers: { Accept: 'application/rss+xml', 'User-Agent': 'Mozilla/5.0' } });
      for (const item of xml.split('<item>').slice(1, 21)) {
        const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1];
        const traffic = item.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/)?.[1];
        const news = item.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/)?.[1];
        if (title) d.google.push({ geo, title: decode(title), traffic: traffic ? decode(traffic) : null, news: news ? decode(news) : null });
      }
    } catch (e) { log(`Google-Trendsuchen ${geo}: ${e.message}`); }
  }
  try {
    const since = ymd(new Date(Date.now() - 7 * DAY_MS));
    const body = await get(`https://api.github.com/search/repositories?q=${encodeURIComponent(`created:>${since}`)}&sort=stars&order=desc&per_page=12`, {
      headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
    });
    d.github = (body.items || []).map(r => ({ name: r.full_name, desc: (r.description || '').slice(0, 140), stars: r.stargazers_count }));
  } catch (e) { log(`GitHub neu: ${e.message}`); }
  try {
    const body = await get('https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=12');
    d.hf = (Array.isArray(body) ? body : []).map(m => ({ name: m.id, likes: m.likes ?? null, downloads: m.downloads ?? null }));
  } catch (e) { log(`Hugging Face: ${e.message}`); }
  // fehlt eine Liste heute, die von gestern behalten
  for (const k of ['google', 'github', 'hf']) if (!d[k].length && prev.discover?.[k]?.length) d[k] = prev.discover[k];
  // wann ein Begriff zum ersten Mal auftauchte: damit die Seite „neu“ markieren kann (60 Tage Gedächtnis)
  const seen = { ...(prev.discover?.seen || {}) };
  for (const x of [...d.google.map(g => g.title), ...d.github.map(g => g.name), ...d.hf.map(h => h.name)]) seen[x.toLowerCase()] ||= today;
  d.seen = Object.fromEntries(Object.entries(seen).filter(([, v]) => Date.parse(v) > Date.now() - 60 * DAY_MS));
  out.discover = d;
  log(`Neu aufgetaucht: ${d.google.length} Google, ${d.github.length} GitHub, ${d.hf.length} Hugging Face`);
}

await Promise.all([
  collectWiki(), collectNews(), collectTrends(), collectHn(), collectMasto(), collectGnews(), collectGithub(), collectArxiv(), collectSec(), collectDev(),
  (async () => { await collectPokemon(); await collectMtg(); await collectYugioh(); await collectMacro(); await collectTrendingCoins(); })(),
  (async () => { await collectFred(); await collectCot(); await collectDefi(); await collectSentiment(); await collectApps(); await collectDiscover(); })(),
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
  if (x.sec && !x.sec.error && x.sec.base >= 3) r.push((x.sec.now + 1) / (x.sec.base + 1));
  if (x.dev && !x.dev.error && x.dev.base > 0) r.push(x.dev.now / x.dev.base);
  return r;
};
for (const t of THEMES) {
  const r = ratios(out.themes[t.id] || {});
  const hist = (prev.history?.[t.id] || []).filter(p => p[0] !== today);
  if (r.length) hist.push([today, round(Math.exp(mean(r.map(Math.log))), 3), r.length]);
  out.history[t.id] = hist.slice(-180);
}

const count = src => Object.values(out.themes).filter(x => x[src] && !x[src].error).length;
out.summary = Object.fromEntries(['wiki', 'langs', 'news', 'gnews', 'trends', 'hn', 'masto', 'github', 'arxiv', 'sec', 'dev'].map(s => [s, count(s)]));
Object.assign(out.summary, { fred: Object.keys(out.fred).length, cot: Object.keys(out.cot).length, defi: Object.keys(out.defi).length,
  sentiment: Object.keys(out.sentiment).length, discover: (out.discover.google?.length || 0) + (out.discover.github?.length || 0) + (out.discover.hf?.length || 0) });
log('Ergebnis', JSON.stringify(out.summary), 'Karten:', Object.keys(out.cards).join(', ') || 'keine');
await mkdir('data', { recursive: true });
await writeFile(OUT, JSON.stringify(out));
