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
// Zusatzlauf: nur Google Trends nachholen, alles andere bleibt wie im Hauptlauf
const TRENDS_ONLY = process.env.TRENDS_ONLY === 'true';
const out = TRENDS_ONLY ? { ...structuredClone(prev), themes: structuredClone(prev.themes || {}), trendsUpdated: new Date().toISOString() } : { updated: new Date().toISOString(), themes: {}, cards: {}, history: {}, macro: {}, trendingCoins: [],
  fred: {}, cot: {}, defi: {}, sentiment: {}, apps: {}, discover: {}, perps: {}, market: {}, fx: {}, poly: {}, so: {} };
// weitere Quellen je Thema landen wie gewohnt in out.themes[id]: edits, fedreg, trials, manifold
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
const decode = x => x.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

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

/* --- Google Trends: inoffizielle Schnittstelle, wöchentliche Werte 0–100 über 12 Monate ---------
   Google sperrt den Sammler nach rund 40 Abfragen. Darum:
   - bis zu 5 Themen pro Abfrage (Google erlaubt 5 Suchbegriffe). Google rechnet sie auf eine gemeinsame Skala,
     wir rechnen jede Kurve danach wieder auf ihr eigenes Maximum = 100 um, wie bei einer Einzelabfrage.
     Damit ein kleines Thema neben einem großen nicht zur flachen Linie wird, kommen Themen ähnlicher Größe zusammen
     (Größe aus früheren Läufen, anfangs aus den Wikipedia-Aufrufen). Bleibt eine Kurve trotzdem zu flach, wird sie einzeln abgefragt.
   - zuerst die Themen mit dem ältesten Stand
   - zusätzliche Läufe am Tag (TRENDS_ONLY) holen nach, was im Hauptlauf gesperrt war. --- */
const TRENDS_BATCH = 5, TRENDS_MIN_PEAK = 15, RISING_PER_RUN = 8;
async function collectTrends() {
  let cookie = '';
  try {
    const res = await fetch('https://trends.google.com/trends/explore?geo=US', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  } catch { /* ohne Cookie probieren */ }
  // Bei „zu viele Anfragen“ bis zu zweimal mit wachsender Pause neu versuchen
  const g = async url => {
    for (let n = 0; ; n++) {
      try {
        const body = await get(url, { text: true, headers: { 'User-Agent': 'Mozilla/5.0', Cookie: cookie } });
        return JSON.parse(body.slice(body.indexOf('{')));
      } catch (e) {
        if (!/429/.test(e.message) || n >= 2) throw e;
        await sleep((n + 1) * 45000);
      }
    }
  };
  let blocked = 0, requests = 0, risingLeft = RISING_PER_RUN;
  const pause = () => sleep(8000 + Math.random() * 4000);
  const fail = (t, e) => {
    slot(t.id).trends = keep(t.id, 'trends', /429/.test(e.message) ? 'Google Trends bremst' : e.message);
  };
  // Größe: Schätzung der Suchmenge auf einer gemeinsamen Skala (nur zum Gruppieren)
  const sizeOf = t => {
    const old = prev.themes?.[t.id];
    if (old?.trends?.size) return old.trends.size;
    const w = old?.wiki?.v;
    return w?.length ? Math.max(1, median(w.slice(-365))) : 100;
  };
  // Zusatzläufe: nur, was heute noch nicht frisch ist
  const todo = THEMES.filter(t => !(TRENDS_ONLY && prev.themes?.[t.id]?.trends?.at === today));
  // von groß nach klein, damit in einer Gruppe ähnlich große Themen landen
  todo.sort((a, b) => sizeOf(b) - sizeOf(a));
  // eine Abfrage für mehrere Themen; liefert je Thema die Rohwerte (gemeinsame Skala) und das Explore-Ergebnis
  const query = async group => {
    const req = { comparisonItem: group.map(t => ({ keyword: trendsFor(t), geo: '', time: 'today 12-m' })), category: 0, property: '' };
    const ex = await g(`https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`);
    requests++;
    const w = ex.widgets.find(x => x.id === 'TIMESERIES');
    await sleep(3000);
    const data = await g(`https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(w.request))}&token=${w.token}`);
    requests++;
    const tl = data.default.timelineData || [];
    if (!tl.length) throw new Error('keine Daten');
    // je Suchbegriff ein eigenes Widget „steigende Suchen“; über den Suchbegriff zuordnen, sonst nach Reihenfolge
    const rq = ex.widgets.filter(x => x.id.startsWith('RELATED_QUERIES'));
    const kwOf = x => x.request?.restriction?.complexKeywordsRestriction?.keyword?.[0]?.value?.toLowerCase();
    const related = group.map((t, i) => rq.find(x => kwOf(x) === trendsFor(t).toLowerCase()) || rq[i] || null);
    return { start: ymd(new Date(Number(tl[0].time) * 1000)), raw: group.map((_, i) => tl.map(p => p.value[i] ?? 0)), related };
  };
  const risingAge = t => Date.parse(prev.themes?.[t.id]?.trends?.risingAt || '2000-01-01');
  const save = async (t, start, raw, size, relWidget) => {
    const peak = Math.max(...raw);
    const v = peak > 0 ? raw.map(x => Math.round(x * 100 / peak)) : raw;
    const old = prev.themes?.[t.id]?.trends;
    let rising = old?.rising || null, risingAt = old?.risingAt || null;
    if (relWidget && risingLeft > 0 && blocked < 3 && risingAt !== today && Date.now() - risingAge(t) > 2 * DAY_MS) {
      risingLeft--;
      try {
        await sleep(4000);
        const rel = await g(`https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(relWidget.request))}&token=${relWidget.token}`);
        requests++;
        rising = (rel.default?.rankedList?.[1]?.rankedKeyword || []).slice(0, 8).map(k => ({ q: k.query, v: k.formattedValue }));
        risingAt = today;
      } catch (e) { if (/429/.test(e.message)) blocked++; log(`  ${t.id}/steigende Suchen: ${e.message}`); }
    }
    slot(t.id).trends = { kw: trendsFor(t), start, v, rising, risingAt, at: today, size: round(size, 2) };
  };
  // Jede Gruppe enthält als „Anker“ das kleinste brauchbare Thema der vorigen Gruppe. Über den Anker hängen alle Größen
  // an einer gemeinsamen Skala, so stimmt die Gruppierung ab dem nächsten Lauf.
  const single = [];
  let anchor = null, groups = 0; // { t, size }
  for (let k = 0; k < todo.length;) {
    const fresh = todo.slice(k, k + TRENDS_BATCH - (anchor ? 1 : 0));
    k += fresh.length;
    if (blocked >= 3) { for (const t of fresh) slot(t.id).trends = keep(t.id, 'trends', 'Google Trends hat den Sammler gesperrt'); continue; }
    const group = anchor ? [anchor.t, ...fresh] : fresh;
    try {
      const r = await query(group);
      groups++;
      blocked = 0;
      const peaks = r.raw.map(v => Math.max(...v));
      let unit; // Größe pro Punkt in dieser Abfrage
      if (anchor && peaks[0] > 0) unit = anchor.size / peaks[0];
      else {
        const ok = fresh.map((t, i) => [t, peaks[i + (anchor ? 1 : 0)]]).filter(x => x[1] > 0);
        unit = ok.length ? Math.exp(mean(ok.map(([t, p]) => Math.log(sizeOf(t) / p)))) : 1;
      }
      let next = null;
      for (const [i, t] of fresh.entries()) {
        const peak = peaks[i + (anchor ? 1 : 0)], size = unit * Math.max(peak, 0.5);
        if (peak >= TRENDS_MIN_PEAK && (!next || size < next.size)) next = { t, size };
        if (group.length > 1 && peak < TRENDS_MIN_PEAK) { single.push([t, size]); continue; } // zu flach: einzeln nachholen
        await save(t, r.start, r.raw[i + (anchor ? 1 : 0)], size, r.related[i + (anchor ? 1 : 0)]);
      }
      anchor = next || anchor;
    } catch (e) { if (/429/.test(e.message)) blocked++; for (const t of fresh) fail(t, e); }
    await pause();
  }
  for (const [t, size] of single) {
    try {
      if (blocked >= 3) throw new Error('Google Trends hat den Sammler gesperrt');
      const r = await query([t]);
      blocked = 0;
      await save(t, r.start, r.raw[0], size, r.related[0]);
      await pause();
    } catch (e) {
      if (/429/.test(e.message)) blocked++;
      fail(t, e);
      // die neue Größe trotzdem merken, damit das Thema beim nächsten Mal in eine passende Gruppe kommt
      if (!slot(t.id).trends.error) slot(t.id).trends.size = round(size, 2);
    }
  }
  log(`Trends fertig: ${THEMES.filter(t => out.themes[t.id]?.trends?.at === today).length} von ${THEMES.length} frisch, ${groups} Gruppen, ${single.length} einzeln, ${requests} Abrufe`);
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
  // je Sprache ein Abruf pro 50 Titel: liefert höchstens einen Link je Seite, keine Fortsetzungen nötig
  for (const lang of LANGS) {
    for (let i = 0; i < titles.length; i += 50) {
      try {
        const url = new URL('https://en.wikipedia.org/w/api.php');
        Object.entries({ action: 'query', titles: titles.slice(i, i + 50).join('|'), prop: 'langlinks', lllang: lang, lllimit: 'max', format: 'json', formatversion: '2' }).forEach(([k, v]) => url.searchParams.set(k, v));
        const body = await get(url);
        for (const pg of body.query?.pages || []) for (const l of pg.langlinks || []) (links[pg.title] ||= {})[lang] = l.title;
      } catch (e) { log(`Sprachversionen ${lang}: ${e.message}`); }
      await sleep(200);
    }
  }
  const end = new Date(Date.now() - DAY_MS), start = new Date(end - 420 * DAY_MS);
  const fmt = d => ymd(d).replace(/-/g, '');
  const jobs = [];
  for (const t of THEMES) for (const [lang, title] of Object.entries(links[resolved[t.wiki]] || {})) jobs.push({ t, lang, title });
  const errors = {};
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (jobs.length) {
      const { t, lang, title } = jobs.shift();
      try {
        let body;
        for (let i = 0; body === undefined; i++) {
          try { body = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia/all-access/user/${encodeURIComponent(title.replace(/ /g, '_'))}/daily/${fmt(start)}/${fmt(end)}`); }
          catch (e) { if (i === 2 || !/429/.test(e.message)) throw e; await sleep(5000 * (i + 1)); }
        }
        const v = (body.items || []).map(it => it.views);
        if (v.length < 90) continue;
        const now = mean(v.slice(-30)), base = median(v.slice(0, -30));
        const yearAgo = v.length >= 395 ? mean(v.slice(-395, -365)) : null;
        ((slot(t.id).langs ||= {}))[lang] = { title, now: round(now, 1), base: round(base, 1), yoy: yearAgo != null ? round(yearAgo, 1) : null };
      } catch (e) { const k = e.message.replace(/.*antwortet mit /, 'Status '); errors[k] = (errors[k] || 0) + 1; }
      await sleep(100);
    }
  }));
  // heute nichts bekommen: Werte vom Vortag behalten
  for (const t of THEMES) if (!out.themes[t.id]?.langs && prev.themes?.[t.id]?.langs) slot(t.id).langs = prev.themes[t.id].langs;
  log(`Wikipedia-Sprachen fertig: ${Object.values(links).reduce((a, x) => a + Object.keys(x).length, 0)} Sprachversionen, ${Object.values(out.themes).filter(x => x.langs).length} Themen${Object.keys(errors).length ? `, Fehler ${JSON.stringify(errors)}` : ''}`);
}

/* --- Google News (RSS, ohne Key): die aktuellen Schlagzeilen der letzten 7 Tage je Thema.
   Zum Zählen taugt der Feed nicht (höchstens 100 Meldungen, nach Relevanz sortiert), deshalb nur als Überblick. --- */
async function collectGnews() {
  for (const t of THEMES) {
    try {
      const xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(`${newsFor(t)} when:7d`)}&hl=en-US&gl=US&ceid=US:en`, { text: true, headers: { Accept: 'application/rss+xml' } });
      const items = xml.split('<item>').slice(1).map(it => ({
        t: decode(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ''),
        src: decode(it.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || ''),
        d: Date.parse(it.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] || '') || null,
        link: decode(it.match(/<link>([\s\S]*?)<\/link>/)?.[1] || ''),
      })).filter(x => x.t);
      // neueste zuerst, Quelle aus dem Titel entfernen („Titel - Quelle“)
      const headlines = items.sort((a, b) => (b.d || 0) - (a.d || 0)).slice(0, 3)
        .map(x => ({ t: x.src && x.t.endsWith(` - ${x.src}`) ? x.t.slice(0, -(x.src.length + 3)) : x.t, src: x.src, d: x.d ? ymd(new Date(x.d)) : null, link: x.link }));
      slot(t.id).gnews = { q: newsFor(t), count: items.length, headlines };
    } catch (e) { slot(t.id).gnews = keep(t.id, 'gnews', e.message); }
    await sleep(1200);
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
// OpenAlex (offener Katalog aller wissenschaftlichen Arbeiten, ohne Key): Arbeiten mit dem Begriff in Titel oder Zusammenfassung
async function researchCount(kw, from, to) {
  const url = new URL('https://api.openalex.org/works');
  Object.entries({ filter: `title_and_abstract.search:${kw.includes(' ') ? `"${kw}"` : kw},from_publication_date:${ymd(new Date(from))},to_publication_date:${ymd(new Date(to))}`, 'per-page': '1' }).forEach(([k, v]) => url.searchParams.set(k, v));
  return (await get(url)).meta?.count ?? NaN;
}
async function collectArxiv() {
  for (const t of THEMES.filter(x => x.group === 'Technologie')) {
    try {
      // Kataloge erfassen neue Arbeiten mit Monaten Verzug. Darum: ein Monat, der 2 Monate zurückliegt,
      // ggü. demselben Monat im Vorjahr (Wachstum der Forschung übers Jahr, ohne Verzerrung durch den Verzug)
      const kw = trendsFor(t), end = Date.now() - 60 * DAY_MS;
      const recent = await researchCount(kw, end - 30 * DAY_MS, end);
      await sleep(300);
      const yearAgo = await researchCount(kw, end - 395 * DAY_MS, end - 365 * DAY_MS);
      if (!Number.isFinite(recent) || !Number.isFinite(yearAgo)) throw new Error('OpenAlex lieferte keine Zahl');
      slot(t.id).arxiv = { kw, now: recent, base: yearAgo, src: 'OpenAlex', month: ymd(new Date(end)).slice(0, 7) };
    } catch (e) { slot(t.id).arxiv = keep(t.id, 'arxiv', e.message); }
    await sleep(300);
  }
  log('Forschung (OpenAlex) fertig');
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
  // Nur Preise derselben Quelle vergleichen: Quellen rechnen Preise unterschiedlich (bei Pokémon gibt es zwei)
  const oldSource = old?.source || (key === 'pokemon' ? 'pokemontcg.io' : null), sameSource = oldSource === (extra.source || oldSource);
  if (series.length && !sameSource) level = series.at(-1)[1];
  else if (series.length && old?.prices) {
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

// Quelle 1: pokemontcg.io (liefert auch 1-, 7- und 30-Tage-Schnitte). Quelle 2 als Ausweich: TCGdex (Cardmarket-Preise je Karte).
async function pokemonFromPtcg() {
  const q = encodeURIComponent('rarity:"Special Illustration Rare"');
  // in kleineren Seiten abrufen: große Abfragen beantwortet der Server oft mit 502
  const data = [];
  for (let page = 1; page <= 3; page++) {
    let part;
    for (let i = 0; i < 3 && !part; i++) {
      try { part = await get(`https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=100&page=${page}&orderBy=-set.releaseDate&select=id,cardmarket`, { timeout: 90000 }); }
      catch (e) { if (i === 2) throw e; await sleep(15000); }
    }
    data.push(...(part.data || []));
    if ((part.data || []).length < 100) break;
  }
  const prices = {}, mom = [], dates = [];
  for (const c of data) {
    const p = c.cardmarket?.prices;
    if (c.cardmarket?.updatedAt) dates.push(c.cardmarket.updatedAt.replace(/\//g, '-'));
    const price = p?.trendPrice || p?.avg1;
    if (!(price > 0.5)) continue;
    prices[c.id] = price;
    // Gestern ggü. 30-Tage-Schnitt: zeigt sofort, ob die Preise gerade anziehen
    if (p.avg1 > 0.5 && p.avg30 > 0.5) mom.push(p.avg1 / p.avg30);
  }
  return { prices, mom, priceDate: dates.sort().at(-1) || null, source: 'pokemontcg.io' };
}
async function pokemonFromTcgdex() {
  const list = await get(`https://api.tcgdex.net/v2/en/cards?rarity=${encodeURIComponent('Special illustration rare')}`);
  // neueste Karten zuerst (Set-Kürzel im Kartennamen sind nicht sortierbar, daher die letzten der Liste)
  const ids = (Array.isArray(list) ? list : []).map(c => c.id).slice(-150);
  const prices = {}, mom = [], dates = [];
  const queue = [...ids];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const cm = (await get(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(id)}`)).pricing?.cardmarket;
        const price = cm?.trend || cm?.avg1 || cm?.avg;
        if (!(price > 0.5)) continue;
        prices[id] = price;
        if (cm.updated) dates.push(String(cm.updated).slice(0, 10));
        if (cm.avg1 > 0.5 && cm.avg30 > 0.5) mom.push(cm.avg1 / cm.avg30);
      } catch { /* einzelne Karte fehlt: egal */ }
    }
  }));
  return { prices, mom, priceDate: dates.sort().at(-1) || null, source: 'TCGdex' };
}
async function collectPokemon() {
  let r = null;
  for (const [name, fn] of [['pokemontcg.io', pokemonFromPtcg], ['TCGdex', pokemonFromTcgdex]]) {
    try {
      r = await fn();
      if (Object.keys(r.prices).length >= 10) break;
      throw new Error('zu wenige Kartenpreise');
    } catch (e) { log(`Karten pokemon über ${name}: ${e.message}`); r = null; }
  }
  if (!r) return keepCards('pokemon', new Error('keine Quelle erreichbar'));
  chainIndex('pokemon', 'Pokémon (Special Illustration Rares)', r.prices, { momentum: r.mom.length >= 10 ? round(median(r.mom), 4) : null, priceDate: r.priceDate, source: r.source });
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

// Lorcana: „Enchanted“-Karten bei Lorcast (Preise in US-Dollar von TCGplayer)
async function collectLorcana() {
  try {
    const body = await get(`https://api.lorcast.com/v0/cards/search?q=${encodeURIComponent('rarity:enchanted')}`);
    const prices = {};
    for (const c of body.results || []) { const p = Number(c.prices?.usd ?? c.prices?.usd_foil); if (p > 0.5) prices[c.id] = p; }
    if (Object.keys(prices).length < 10) throw new Error('zu wenige Kartenpreise');
    chainIndex('lorcana', 'Lorcana (Enchanted-Karten, US-Dollar)', prices);
  } catch (e) { keepCards('lorcana', e); }
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
// Die SEC verlangt im Abruf eine Kontakt-E-Mail. Sie kommt aus dem GitHub-Secret SEC_CONTACT; ohne sie wird die SEC übersprungen.
const SEC_UA = process.env.SEC_CONTACT ? `SmartWin Radar ${process.env.SEC_CONTACT}` : null;
async function secCount(kw, from, to) {
  const q = `"${kw.replace(/"/g, '')}"`;
  const body = await get(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&dateRange=custom&startdt=${ymd(new Date(from))}&enddt=${ymd(new Date(to))}`, { headers: { 'User-Agent': SEC_UA } });
  return body.hits?.total?.value ?? 0;
}
async function collectSec() {
  let down = SEC_UA ? null : 'SEC verlangt eine Kontakt-E-Mail (GitHub-Secret SEC_CONTACT fehlt)';
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
      out.defi[t.id] = { kind: t.defi.tvl ? 'tvl' : 'fees', name: t.defi.tvl || t.defi.fees, start: pts[0][0], v: pts.map(p => Math.round(p[1])) };
    } catch (e) { log(`DefiLlama ${t.id}: ${e.message}`); if (prev.defi?.[t.id]) out.defi[t.id] = { ...prev.defi[t.id], stale: true }; }
  }
  log(`DefiLlama fertig (${Object.keys(out.defi).length})`);
}

/* --- Marktstimmung: Fear & Greed Index für Krypto (alternative.me). CNN (Aktien) sperrt automatische Abrufe, daher nicht dabei. --- */
async function collectSentiment() {
  try {
    const body = await get('https://api.alternative.me/fng/?limit=365&format=json');
    const pts = (body.data || []).map(x => [ymd(new Date(Number(x.timestamp) * 1000)), Number(x.value), x.value_classification]).reverse();
    out.sentiment.crypto = { now: pts.at(-1)[1], label: pts.at(-1)[2], d: pts.map(p => p[0]), v: pts.map(p => p[1]) };
  } catch (e) { log(`Fear & Greed Krypto: ${e.message}`); if (prev.sentiment?.crypto) out.sentiment.crypto = { ...prev.sentiment.crypto, stale: true }; }
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

/* --- Hebel und Spekulation bei Krypto (Hyperliquid, öffentliche Schnittstelle ohne Key):
   Funding-Rate (wie viel Long-Positionen den Shorts zahlen, aufs Jahr gerechnet) und offene Positionen in Dollar.
   Hohe positive Funding-Rate = viel Hebel auf steigende Kurse, oft überhitzt. Verlauf der offenen Positionen wird täglich gesammelt. --- */
async function collectPerps() {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Hyperliquid antwortet mit ${res.status}`);
    const [meta, ctxs] = await res.json();
    const byCoin = Object.fromEntries(meta.universe.map((u, i) => [u.name, ctxs[i]]));
    for (const t of THEMES.filter(x => x.perp)) {
      const c = byCoin[t.perp];
      if (!c) continue;
      const funding = round(Number(c.funding) * 24 * 365 * 100, 1), oiUsd = Math.round(Number(c.openInterest) * Number(c.markPx));
      const hist = (prev.perps?.[t.id]?.hist || []).filter(h => h[0] !== today);
      hist.push([today, oiUsd, funding]);
      out.perps[t.id] = { coin: t.perp, funding, oiUsd, vol24: Math.round(Number(c.dayNtlVlm)), hist: hist.slice(-180) };
    }
  } catch (e) { log(`Hyperliquid: ${e.message}`); out.perps = prev.perps || {}; }
  log(`Hebel (Hyperliquid) fertig (${Object.keys(out.perps).length})`);
}

/* --- Marktweite Kennzahlen: Stablecoin-Geldmenge (DefiLlama), Bitcoin-Transaktionen (blockchain.com),
   VIX und Kreditrisiko-Aufschlag für Hochzinsanleihen (FRED). Je eine Tagesreihe über gut ein Jahr. --- */
async function fredSeries(id) {
  const csv = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { text: true, headers: { Accept: 'text/csv' } });
  return csv.trim().split('\n').slice(1).map(l => l.split(',')).filter(([d, v]) => d && v && v !== '.').map(([d, v]) => [d, Number(v)]);
}
async function collectMarket() {
  const put = (key, pts) => { pts = pts.filter(([d]) => d < today).slice(-400); if (pts.length > 30) out.market[key] = { d: pts.map(p => p[0]), v: pts.map(p => round(p[1], 2)) }; };
  const jobs = {
    stablecoins: async () => (await get('https://stablecoins.llama.fi/stablecoincharts/all')).map(x => [ymd(new Date(Number(x.date) * 1000)), x.totalCirculatingUSD?.peggedUSD || 0]),
    btcTx: async () => ((await get('https://api.blockchain.info/charts/n-transactions?timespan=1year&format=json&sampled=false')).values || []).map(x => [ymd(new Date(x.x * 1000)), x.y]),
    vix: () => fredSeries('VIXCLS'),
    hy: () => fredSeries('BAMLH0A0HYM2'),
  };
  for (const [key, fn] of Object.entries(jobs)) {
    try { put(key, await fn()); } catch (e) { log(`Markt ${key}: ${e.message}`); }
    if (!out.market[key] && prev.market?.[key]) out.market[key] = { ...prev.market[key], stale: true };
  }
  log(`Markt fertig (${Object.keys(out.market).join(', ')})`);
}

/* --- Währungen der Länder gegen den Dollar (EZB-Kurse über Frankfurter, Taiwan-Dollar über FRED):
   Eine starke Währung zeigt, dass Geld ins Land fließt. Gespeichert: Einheiten der Landeswährung je Dollar. --- */
async function collectFx() {
  const countries = THEMES.filter(t => t.ccy);
  const ecb = countries.filter(t => t.ccy !== 'TWD').map(t => t.ccy);
  try {
    const body = await get(`https://api.frankfurter.app/${ymd(new Date(Date.now() - 400 * DAY_MS))}..?base=USD&symbols=${ecb.join(',')}`);
    const days = Object.keys(body.rates || {}).sort();
    for (const t of countries.filter(x => x.ccy !== 'TWD')) {
      const pts = days.map(d => [d, body.rates[d][t.ccy]]).filter(([, v]) => v);
      if (pts.length > 30) out.fx[t.id] = { ccy: t.ccy, d: pts.slice(-260).map(p => p[0]), v: pts.slice(-260).map(p => round(p[1], 4)) };
    }
  } catch (e) { log(`Frankfurter: ${e.message}`); }
  try {
    const t = countries.find(x => x.ccy === 'TWD');
    if (t) { const pts = (await fredSeries('DEXTAUS')).slice(-280); if (pts.length > 30) out.fx[t.id] = { ccy: 'TWD', d: pts.map(p => p[0]), v: pts.map(p => round(p[1], 4)) }; }
  } catch (e) { log(`FRED TWD: ${e.message}`); }
  for (const t of countries) if (!out.fx[t.id] && prev.fx?.[t.id]) out.fx[t.id] = { ...prev.fx[t.id], stale: true };
  log(`Währungen fertig (${Object.keys(out.fx).length})`);
}

/* --- Polymarket (Prognosemärkte, ohne Key): Wie viel Geld gerade auf Ereignisse rund um ein Thema gewettet wird.
   Ein Abruf für die 500 aktivsten Märkte, dann Zuordnung über Suchbegriffe. Volumen-Verlauf wird täglich gesammelt. --- */
async function collectPoly() {
  try {
    const events = await get('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=500&order=volume24hr&ascending=false');
    const list = (Array.isArray(events) ? events : []).map(e => ({ title: e.title || '', vol24: Number(e.volume24hr) || 0, vol: Number(e.volume) || 0, slug: e.slug }));
    out.discover.poly = list.slice(0, 10).map(e => ({ title: e.title, vol24: Math.round(e.vol24), slug: e.slug }));
    for (const t of THEMES) {
      const words = [...new Set([trendsFor(t), t.tag, t.wiki].filter(Boolean).map(w => w.toLowerCase()).filter(w => w.length >= 3))];
      const hits = list.filter(e => words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(e.title)));
      const hist = (prev.poly?.[t.id]?.hist || []).filter(h => h[0] !== today);
      if (hits.length) hist.push([today, Math.round(hits.reduce((a, e) => a + e.vol24, 0))]);
      if (hits.length || hist.length) out.poly[t.id] = { n: hits.length, vol24: Math.round(hits.reduce((a, e) => a + e.vol24, 0)), top: hits.slice(0, 3).map(e => ({ title: e.title, vol24: Math.round(e.vol24), slug: e.slug })), hist: hist.slice(-180) };
    }
  } catch (e) { log(`Polymarket: ${e.message}`); out.poly = prev.poly || {}; out.discover.poly = prev.discover?.poly || []; }
  log(`Polymarket fertig (${Object.keys(out.poly).length} Themen mit Wetten)`);
  // Kalshi (zweiter, US-regulierter Wettmarkt, öffentliche Marktdaten ohne Key): offene Ereignisse, Volumen in Kontrakten
  try {
    const events = [];
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const body = await get(`https://api.elections.kalshi.com/trade-api/v2/events?status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      events.push(...(body.events || []));
      cursor = body.cursor;
      if (!cursor) break;
      await sleep(500);
    }
    const list = events.map(e => ({ title: e.title || '', ticker: e.event_ticker, vol24: (e.markets || []).reduce((a, m) => a + (Number(m.volume_24h) || 0), 0) }));
    for (const t of THEMES) {
      const words = [...new Set([trendsFor(t), t.tag, t.wiki].filter(Boolean).map(w => w.toLowerCase()).filter(w => w.length >= 3))];
      const hits = list.filter(e => words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(e.title)));
      if (!hits.length) continue;
      (out.poly[t.id] ||= { n: 0, vol24: 0, top: [], hist: prev.poly?.[t.id]?.hist || [] }).kalshi = {
        n: hits.length, vol24: hits.reduce((a, e) => a + e.vol24, 0),
        top: hits.sort((a, b) => b.vol24 - a.vol24).slice(0, 2).map(e => ({ title: e.title, vol24: e.vol24, ticker: e.ticker })),
      };
    }
    log(`Kalshi fertig (${list.length} Ereignisse)`);
  } catch (e) { log(`Kalshi: ${e.message}`); }
}

/* --- Manifold (Prognosemarkt mit Spielgeld, ohne Key): Wie viele neue Wettfragen zu einem Thema gestellt werden.
   Neue Fragen in den letzten 30 Tagen ggü. dem Monatsschnitt der 5 Monate davor. Deckt auch Nischen ab. --- */
async function collectManifold() {
  for (const t of THEMES) {
    try {
      const body = await get(`https://api.manifold.markets/v0/search-markets?term=${encodeURIComponent(trendsFor(t))}&sort=newest&limit=100`);
      const now = Date.now(), times = (Array.isArray(body) ? body : []).map(m => m.createdTime).filter(Number.isFinite);
      const recent = times.filter(x => x > now - 30 * DAY_MS).length, before = times.filter(x => x <= now - 30 * DAY_MS && x > now - 180 * DAY_MS).length;
      const bettors = (Array.isArray(body) ? body : []).filter(m => m.createdTime > now - 30 * DAY_MS).reduce((a, m) => a + (m.uniqueBettorCount || 0), 0);
      // 100 Treffer in 30 Tagen: Abfrage ist gedeckelt, ein Vergleich wäre dann verzerrt
      slot(t.id).manifold = { kw: trendsFor(t), now: recent, base: round(before / 5, 1), bettors, capped: recent >= 100 };
    } catch (e) { slot(t.id).manifold = keep(t.id, 'manifold', e.message); }
    await sleep(250);
  }
  log('Manifold fertig');
}

/* --- Wikipedia-Bearbeitungen: Wie viele Änderungen ein Artikel bekommt (Schreiben statt Lesen).
   Letzte 30 Tage ggü. dem Median der 30-Tage-Summen im Jahr davor. --- */
async function collectEdits() {
  const titles = Object.fromEntries(THEMES.map(t => [t.id, out.themes[t.id]?.wiki?.title]).filter(([, x]) => x));
  const end = new Date(Date.now() - DAY_MS), start = new Date(end - 400 * DAY_MS);
  const fmt = d => ymd(d).replace(/-/g, '');
  for (const t of THEMES) {
    const title = titles[t.id];
    if (!title) continue;
    try {
      const body = await get(`https://wikimedia.org/api/rest_v1/metrics/edits/per-page/en.wikipedia/${encodeURIComponent(title.replace(/ /g, '_'))}/all-editor-types/daily/${fmt(start)}/${fmt(end)}`);
      const byDay = new Map((body.items?.[0]?.results || []).map(r => [r.timestamp.slice(0, 10), r.edits]));
      const v = [];
      for (let d = new Date(ymd(start)); d <= end; d = new Date(+d + DAY_MS)) v.push(byDay.get(ymd(d)) ?? 0);
      const sums = [];
      for (let e = v.length - 30; e - 30 >= 0; e -= 30) sums.push(v.slice(e - 30, e).reduce((a, b) => a + b, 0));
      slot(t.id).edits = { now: v.slice(-30).reduce((a, b) => a + b, 0), base: median(sums) ?? 0 };
    } catch (e) { slot(t.id).edits = keep(t.id, 'edits', e.message); }
    await sleep(150);
  }
  log('Wikipedia-Bearbeitungen fertig');
}

/* --- Federal Register (Amtsblatt der US-Regierung, ohne Key): Wie oft das Thema in Regierungsdokumenten vorkommt.
   Zeigt, ob Regulierung und Politik sich damit beschäftigen. Für Technologie, Rohstoffe und Krypto. --- */
async function fedregCount(kw, from, to) {
  const url = new URL('https://www.federalregister.gov/api/v1/documents.json');
  Object.entries({ per_page: '1', 'conditions[term]': `"${kw.replace(/"/g, '')}"`, 'conditions[publication_date][gte]': ymd(new Date(from)), 'conditions[publication_date][lte]': ymd(new Date(to)) }).forEach(([k, v]) => url.searchParams.set(k, v));
  return (await get(url)).count ?? NaN;
}
async function collectFedreg() {
  for (const t of THEMES.filter(x => ['Technologie', 'Rohstoffe', 'Krypto'].includes(x.group))) {
    try {
      const kw = trendsFor(t), now = Date.now();
      const recent = await fedregCount(kw, now - 30 * DAY_MS, now);
      await sleep(300);
      const before = await fedregCount(kw, now - 360 * DAY_MS, now - 31 * DAY_MS);
      if (!Number.isFinite(recent) || !Number.isFinite(before)) throw new Error('keine Zahl');
      slot(t.id).fedreg = { kw, now: recent, base: round(before / 11, 1) };
    } catch (e) { slot(t.id).fedreg = keep(t.id, 'fedreg', e.message); }
    await sleep(300);
  }
  log('Federal Register fertig');
}

/* --- ClinicalTrials.gov (ohne Key): neu registrierte klinische Studien, z. B. zu Abnehmspritzen --- */
async function trialsCount(q, from, to) {
  const url = new URL('https://clinicaltrials.gov/api/v2/studies');
  Object.entries({ 'query.intr': q, 'filter.advanced': `AREA[StudyFirstPostDate]RANGE[${ymd(new Date(from))},${ymd(new Date(to))}]`, countTotal: 'true', pageSize: '1' }).forEach(([k, v]) => url.searchParams.set(k, v));
  return (await get(url)).totalCount ?? NaN;
}
async function collectTrials() {
  for (const t of THEMES.filter(x => x.trials)) {
    try {
      const now = Date.now();
      const recent = await trialsCount(t.trials, now - 30 * DAY_MS, now);
      const before = await trialsCount(t.trials, now - 360 * DAY_MS, now - 31 * DAY_MS);
      if (!Number.isFinite(recent) || !Number.isFinite(before)) throw new Error('keine Zahl');
      slot(t.id).trials = { q: t.trials, now: recent, base: round(before / 11, 1) };
    } catch (e) { slot(t.id).trials = keep(t.id, 'trials', e.message); }
  }
  log('Klinische Studien fertig');
}

/* --- Stack Overflow (Stack Exchange API, ohne Key): Anteil der Fragen mit dem Tag eines Tech-Themas.
   Als Anteil an allen Fragen, weil Stack Overflow insgesamt schrumpft. --- */
async function soCount(tag, from, to) {
  const url = new URL('https://api.stackexchange.com/2.3/questions');
  Object.entries({ fromdate: Math.floor(from / 1000), todate: Math.floor(to / 1000), site: 'stackoverflow', filter: 'total', ...(tag ? { tagged: tag } : {}) }).forEach(([k, v]) => url.searchParams.set(k, v));
  return (await get(url)).total ?? NaN;
}
async function collectSo() {
  const now = Date.now(), r = [now - 30 * DAY_MS, now], b = [now - 210 * DAY_MS, now - 31 * DAY_MS];
  try {
    const allNow = await soCount(null, ...r), allBefore = await soCount(null, ...b);
    for (const t of THEMES.filter(x => x.so)) {
      try {
        const n = await soCount(t.so, ...r), m = await soCount(t.so, ...b);
        if (![n, m, allNow, allBefore].every(Number.isFinite)) throw new Error('keine Zahl');
        // Fragen pro Monat und Anteil an allen Fragen (in Promille)
        out.so[t.id] = { tag: t.so, now: n, base: round(m / 6, 1), shareNow: round((n / allNow) * 1000, 3), shareBase: round((m / allBefore) * 1000, 3) };
      } catch (e) { log(`Stack Overflow ${t.so}: ${e.message}`); }
      await sleep(500);
    }
  } catch (e) { log(`Stack Overflow: ${e.message}`); }
  for (const t of THEMES.filter(x => x.so)) if (!out.so[t.id] && prev.so?.[t.id]) out.so[t.id] = { ...prev.so[t.id], stale: true };
  log(`Stack Overflow fertig (${Object.keys(out.so).length})`);
}

/* --- Bluesky: öffentliche Trend-Themen (für „Neu aufgetaucht“; die Suche selbst braucht eine Anmeldung) --- */
async function collectBskyTrends() {
  try {
    const body = await get('https://public.api.bsky.app/xrpc/app.bsky.unspecced.getTrendingTopics?limit=15');
    out.discover.bsky = (body.topics || []).map(x => ({ title: x.displayName || x.topic })).filter(x => x.title).slice(0, 12);
  } catch (e) { log(`Bluesky-Trends: ${e.message}`); out.discover.bsky = prev.discover?.bsky || []; }
}

if (TRENDS_ONLY) await collectTrends();
else await Promise.all([
  (async () => { await collectWiki(); await collectEdits(); })(), collectNews(), collectTrends(), collectHn(), collectMasto(), collectGnews(), collectGithub(), collectArxiv(), collectSec(), collectDev(),
  (async () => { await collectPokemon(); await collectMtg(); await collectYugioh(); await collectLorcana(); await collectMacro(); await collectTrendingCoins(); })(),
  (async () => { await collectFred(); await collectCot(); await collectDefi(); await collectSentiment(); await collectApps(); await collectDiscover(); await collectPoly(); await collectBskyTrends(); })(),
  (async () => { await collectPerps(); await collectMarket(); await collectFx(); await collectSo(); await collectManifold(); await collectFedreg(); await collectTrials(); })(),
]);

/* --- Aufmerksamkeits-Index je Thema und Tag, aus den Quellen mit Tagesverlauf (Wikipedia, Google Trends, News).
   Wird jeden Tag für die letzten 120 Tage neu berechnet, darum gibt es den Verlauf sofort und er bleibt in sich stimmig.
   Je Tag: Verhältnis „letzte 30 Tage (bzw. 4 Wochen) ggü. Median der Zeit davor“, dann geometrisches Mittel der Quellen. --- */
const dayIdx = (start, date) => Math.round((Date.parse(date) - Date.parse(start)) / DAY_MS);
function seriesAt(x) {
  // liefert je Quelle eine Funktion: Verhältnis am Tag D (oder null)
  const fns = [];
  if (x.wiki?.v?.length > 120) {
    const v = x.wiki.v, st = x.wiki.start;
    fns.push(D => { const i = dayIdx(st, D); if (i < 120 || i >= v.length) return null; return (mean(v.slice(i - 29, i + 1)) + 1) / (median(v.slice(Math.max(0, i - 395), i - 29)) + 1); });
  }
  if (x.trends?.v?.length > 20) {
    const v = x.trends.v, st = x.trends.start || x.trends.d?.[0];
    fns.push(D => { const i = Math.floor(dayIdx(st, D) / 7); if (i < 16 || i >= v.length) return null; return (mean(v.slice(i - 3, i + 1)) + 1) / (median(v.slice(0, i - 3)) + 1); });
  }
  if (x.news?.p?.length > 120 && x.news.d) {
    const idx = new Map(x.news.d.map((d, i) => [d, i])), p = x.news.p;
    fns.push(D => { const i = idx.get(D); if (i == null || i < 90) return null; return (mean(p.slice(i - 29, i + 1)) + 1e-3) / (median(p.slice(0, i - 29)) + 1e-3); });
  }
  return fns;
}
const lastDay = ymd(new Date(Date.now() - 2 * DAY_MS)); // Wikipedia und News sind bis vorgestern vollständig
for (const t of THEMES) {
  const fns = seriesAt(out.themes[t.id] || {});
  const hist = [];
  for (let k = 119; k >= 0; k--) {
    const D = ymd(new Date(Date.parse(lastDay) - k * DAY_MS));
    const r = fns.map(f => f(D)).filter(v => v != null && v > 0);
    if (r.length) hist.push([D, round(Math.exp(mean(r.map(Math.log))), 3), r.length]);
  }
  out.history[t.id] = hist;
}

/* --- Momentum Map: Welcher Anteil der gesamten Aufmerksamkeit entfällt auf ein Thema, und wie verschiebt er sich?
   Je Quelle (Wikipedia-Aufrufe, Google-Suchen, Nachrichten, Wettgeld) der Anteil jedes Themas an der Summe aller Themen,
   dann gewichtet gemittelt. „Jetzt“ = letzte 7 Tage (Google: letzte volle Woche), „vorher“ = Schnitt der 4 Wochen davor.
   Die versteckte Gruppe Popkultur zählt nicht mit. --- */
const MOMENTUM_GROUP_SKIP = 'Popkultur';
function computeMomentum() {
  const list = THEMES.filter(t => t.group !== MOMENTUM_GROUP_SKIP);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const sources = {
    wiki: { w: 1, f: x => { const v = x.wiki?.v; if (!(v?.length > 40)) return null; return [sum(v.slice(-7)), sum(v.slice(-35, -7)) / 4]; } },
    google: { w: 1, f: x => { const tr = x.trends, v = tr?.v; if (!(v?.length > 8) || !tr.size) return null; const k = tr.size / 100;
      return [v.at(-2) * k, mean(v.slice(-6, -2)) * k]; } }, // letzte Woche ist bei Google noch unvollständig
    news: { w: 1, f: x => { const v = x.news?.v; if (!(v?.length > 40) || !(x.news.d?.at(-1) >= ymd(new Date(Date.now() - 5 * DAY_MS)))) return null; return [sum(v.slice(-7)), sum(v.slice(-35, -7)) / 4]; } },
    bets: { w: 0.5, f: (x, t) => { const p = out.poly?.[t.id]; if (!p?.vol24) return null; const h = (p.hist || []).filter(e => e[0] <= ymd(new Date(Date.now() - 7 * DAY_MS)));
      return [p.vol24, h.length >= 5 ? median(h.map(e => e[1])) : p.vol24]; } },
  };
  const lv = {};
  for (const [k, src] of Object.entries(sources)) {
    const vals = list.map(t => [t.id, src.f(out.themes[t.id] || {}, t)]).filter(([, v]) => v && v[0] >= 0 && v[1] >= 0);
    const tn = sum(vals.map(([, v]) => v[0])), tp = sum(vals.map(([, v]) => v[1]));
    if (!tn || !tp) continue;
    lv[k] = Object.fromEntries(vals.map(([id, v]) => [id, [v[0] / tn, v[1] / tp]]));
  }
  const W = sum(Object.keys(lv).map(k => sources[k].w));
  const themes = {};
  for (const t of list) {
    let s = 0, s0 = 0;
    for (const k of Object.keys(lv)) { const v = lv[k][t.id]; if (v) { s += sources[k].w * v[0]; s0 += sources[k].w * v[1]; } }
    if (!s && !s0) continue;
    s /= W; s0 /= W;
    // Was die Aufmerksamkeit zieht: neueste Schlagzeile, steigende Google-Suche, meistgehandelte Wette
    const x = out.themes[t.id] || {}, why = [];
    const head = x.gnews?.headlines?.[0];
    if (head?.t) why.push({ k: 'news', t: head.t.replace(/\s+-\s+[^-]+$/, ''), src: head.src || null });
    // nur steigende Suchen, die den Suchbegriff enthalten (sonst landet z. B. „lidl near me“ bei Gold)
    const kwWords = trendsFor(t).toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !['price', 'prices', 'stock', 'stocks', 'the', 'and', 'card', 'cards', 'game', 'news', 'index', 'exchange', 'collecting', 'markets', 'energy', 'fine', 'book', 'bag', 'records', 'set', 'oil'].includes(w));
    if (!kwWords.length) kwWords.push(...trendsFor(t).toLowerCase().split(/\s+/));
    // „Breakout“-Suchen sind oft Spam oder Musiktitel, darum nur solche mit Prozentangabe
    const rise = x.trends?.rising?.find(q => q.q && q.v !== 'Breakout' && !/casino|bet\b|porn|song|montagem/i.test(q.q) && kwWords.some(w => q.q.toLowerCase().includes(w)));
    if (rise) why.push({ k: 'search', t: rise.q, v: rise.v });
    const bet = out.poly?.[t.id]?.top?.[0];
    if (bet?.title) why.push({ k: 'bet', t: bet.title });
    themes[t.id] = { s: round(s * 100, 3), s0: round(s0 * 100, 3), r: round(s0 > 0 ? s / s0 : 1, 3), why };
  }
  out.momentum = { at: today, sources: Object.keys(lv), themes };
  // Verlauf des Anteils für die Kurve im Thema (90 Tage)
  const hist = prev.momentumHist || {};
  out.momentumHist = {};
  for (const [id, m] of Object.entries(themes)) {
    const h = (hist[id] || []).filter(e => e[0] !== today);
    h.push([today, m.s]);
    out.momentumHist[id] = h.slice(-90);
  }
  log(`Momentum: ${Object.keys(themes).length} Themen aus ${Object.keys(lv).join(', ')}`);
}
computeMomentum();

/* --- Signal-Logbuch und Rückblick (Trefferquote).
   Vereinfachtes Frühsignal, das sich rückwirkend berechnen lässt: Wikipedia-Aufrufe seit Wochen mindestens 1,5× über normal
   (in 3 der letzten 4 Wochen), kein sehr bekanntes Thema, Google Trends oder News bestätigen, und der Preis ist in den
   30 Tagen davor nicht schon über 10 % gestiegen. Danach: Was hat der Preis in 30 und 90 Tagen gemacht?
   Preise holt der Sammler selbst: Krypto (CoinGecko, 365 Tage), Kakao/Kaffee/Olivenöl (FRED, monatlich). --- */
async function collectPriceHistory() {
  out.priceHist = {};
  for (const t of THEMES.filter(x => x.price?.cg)) {
    try {
      const body = await get(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(t.price.cg)}/market_chart?vs_currency=eur&days=365&interval=daily`);
      const byDay = new Map((body.prices || []).map(([ts, v]) => [ymd(new Date(ts)), v]));
      if (byDay.size > 60) out.priceHist[t.id] = Object.fromEntries([...byDay].map(([d, v]) => [d, round(v, 6)]));
    } catch (e) { log(`Kurs ${t.id}: ${e.message}`); }
    await sleep(7000); // CoinGecko ohne Key: wenige Abrufe pro Minute
  }
  for (const t of THEMES.filter(x => x.price?.fred)) {
    // Monatswerte auf Tage verteilen: jeder Tag bekommt den Wert seines Monats
    const ser = out.fred[t.id]?.series;
    if (!ser) continue;
    const m = Object.fromEntries(ser.map(([d, v]) => [d.slice(0, 7), v]));
    const days = {};
    for (let k = 420; k >= 0; k--) { const D = ymd(new Date(Date.now() - k * DAY_MS)); if (m[D.slice(0, 7)] != null) days[D] = m[D.slice(0, 7)]; }
    if (Object.keys(days).length > 60) out.priceHist[t.id] = days;
  }
  log(`Kursverläufe für Rückblick: ${Object.keys(out.priceHist).length}`);
}
function backtest() {
  const signals = [];
  const priceAt = (id, D) => { const h = out.priceHist[id]; if (!h) return null; for (let k = 0; k < 5; k++) { const x = h[ymd(new Date(Date.parse(D) - k * DAY_MS))]; if (x != null) return x; } return null; };
  for (const t of THEMES) {
    const x = out.themes[t.id] || {};
    if (!(x.wiki?.v?.length > 150)) continue;
    const v = x.wiki.v, st = x.wiki.start;
    const others = seriesAt({ trends: x.trends, news: x.news });
    let lastSig = null;
    for (let k = 330; k >= 0; k--) {
      const D = ymd(new Date(Date.parse(lastDay) - k * DAY_MS)), i = dayIdx(st, D);
      if (i < 150 || i >= v.length) continue;
      const base = median(v.slice(Math.max(0, i - 395), i - 29));
      if (base >= 4000) continue; // sehr bekannte Themen: kein Frühsignal
      const ratio = (mean(v.slice(i - 29, i + 1)) + 1) / (base + 1);
      if (ratio < 1.5) continue;
      const weeks = [0, 1, 2, 3].map(w => mean(v.slice(i - 7 * w - 6, i - 7 * w + 1)));
      if (weeks.filter(w => (w + 1) / (base + 1) >= 1.3).length < 3) continue;
      const conf = others.map(f => f(D)).filter(r => r != null);
      if (conf.length && !conf.some(r => r >= 1.3)) continue;
      const p0 = priceAt(t.id, D), pPrev = priceAt(t.id, ymd(new Date(Date.parse(D) - 30 * DAY_MS)));
      if (p0 && pPrev && p0 / pPrev - 1 > 0.1) continue; // Preis lief schon: kein Frühsignal mehr
      if (lastSig && Date.parse(D) - Date.parse(lastSig) < 30 * DAY_MS) continue; // je Thema höchstens ein Signal pro Monat
      lastSig = D;
      const ret = days => { const D2 = ymd(new Date(Date.parse(D) + days * DAY_MS)); if (D2 > lastDay) return null; const p1 = priceAt(t.id, D2); return p0 && p1 ? round((p1 / p0 - 1) * 100, 1) : null; };
      signals.push({ id: t.id, d: D, ratio: round(ratio, 2), ret30: ret(30), ret90: ret(90) });
    }
  }
  // Vergleichsmaßstab: durchschnittliche 30-Tage-Rendite derselben Kurse an allen Tagen (zufälliger Einstieg)
  const baseRets = [];
  for (const id of Object.keys(out.priceHist)) for (let k = 360; k >= 30; k -= 7) {
    const D = ymd(new Date(Date.parse(lastDay) - k * DAY_MS)), D2 = ymd(new Date(Date.parse(D) + 30 * DAY_MS));
    const a = priceAt(id, D), b = priceAt(id, D2);
    if (a && b) baseRets.push((b / a - 1) * 100);
  }
  const stat = key => { const r = signals.map(x => x[key]).filter(x => x != null); return r.length ? { n: r.length, hit: round(r.filter(x => x > 0).length / r.length, 2), avg: round(mean(r), 1), median: round(median(r), 1) } : null; };
  out.backtest = { since: ymd(new Date(Date.parse(lastDay) - 330 * DAY_MS)), signals: signals.slice(-200), r30: stat('ret30'), r90: stat('ret90'),
    base30: baseRets.length ? { n: baseRets.length, hit: round(baseRets.filter(x => x > 0).length / baseRets.length, 2), avg: round(mean(baseRets), 1) } : null };
  log(`Rückblick: ${signals.length} Frühsignale, mit Kurs nach 30 Tagen: ${JSON.stringify(out.backtest.r30)}, Vergleich: ${JSON.stringify(out.backtest.base30)}`);
}
if (!TRENDS_ONLY) {
  await collectPriceHistory();
  backtest();
  delete out.priceHist; // nur zum Rechnen, nicht in die Datei
}

const count = src => Object.values(out.themes).filter(x => x[src] && !x[src].error).length;
out.summary = Object.fromEntries(['wiki', 'langs', 'edits', 'news', 'gnews', 'trends', 'hn', 'masto', 'github', 'arxiv', 'sec', 'dev', 'fedreg', 'trials', 'manifold'].map(s => [s, count(s)]));
Object.assign(out.summary, { fred: Object.keys(out.fred).length, cot: Object.keys(out.cot).length, defi: Object.keys(out.defi).length,
  sentiment: Object.keys(out.sentiment).length, perps: Object.keys(out.perps).length, market: Object.keys(out.market).length,
  fx: Object.keys(out.fx).length, poly: Object.keys(out.poly).length, so: Object.keys(out.so).length, discover: (out.discover.google?.length || 0) + (out.discover.github?.length || 0) + (out.discover.hf?.length || 0) });
log('Ergebnis', JSON.stringify(out.summary), 'Karten:', Object.keys(out.cards).join(', ') || 'keine');
await mkdir('data', { recursive: true });
await writeFile(OUT, JSON.stringify(out));
