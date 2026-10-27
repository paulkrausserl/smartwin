// Täglicher Datensammler für das Radar (läuft als GitHub Action, siehe .github/workflows/collect.yml).
// Sammelt serverseitig, was im Browser langsam oder gesperrt ist, und schreibt alles nach data/radar.json:
//   News (GDELT), Google Trends, Hashtags (Bluesky, Mastodon) und Kartenpreis-Indizes (Cardmarket).
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
const out = { updated: new Date().toISOString(), themes: {}, cards: {} };

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

/* --- News: GDELT, ein Abruf alle 5 Sekunden ----------------------------------- */
async function collectNews() {
  for (const t of THEMES) {
    try {
      const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
      Object.entries({ query: newsFor(t), mode: 'timelinevolraw', format: 'json', timespan: '1y' }).forEach(([k, v]) => url.searchParams.set(k, v));
      const body = await get(url, { text: true });
      const data = JSON.parse(body).timeline?.[0]?.data || [];
      if (!data.length) throw new Error('keine Treffer');
      const d = x => `${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`;
      // kompakt: Datum je Punkt, Artikel, Anteil an allen Artikeln in Promille
      slot(t.id).news = { d: data.map(d), v: data.map(x => x.value), p: data.map(x => (x.norm ? round((x.value / x.norm) * 1000, 4) : 0)) };
    } catch (e) { slot(t.id).news = keep(t.id, 'news', e.message.startsWith('Unexpected') ? 'GDELT lieferte keine Daten' : e.message); }
    await sleep(5500);
  }
  log('News fertig');
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

/* --- Bluesky: Rate aus der Zeitspanne der neuesten 100 Posts, heute und vor 1 und 3 Monaten ------ */
async function bskyRate(tag, at) {
  const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts');
  Object.entries({ q: `#${tag}`, sort: 'latest', limit: '100', until: new Date(at).toISOString(), since: new Date(at - 14 * DAY_MS).toISOString() }).forEach(([k, v]) => url.searchParams.set(k, v));
  const posts = (await get(url)).posts || [];
  if (posts.length < 100) return posts.length / 14;
  const oldest = Math.min(...posts.map(x => Date.parse(x.indexedAt || x.record?.createdAt)).filter(Number.isFinite));
  return 100 / Math.max((at - oldest) / DAY_MS, 1 / 24);
}
async function collectBsky() {
  let down = null;
  for (const t of THEMES) {
    if (down) { slot(t.id).bsky = keep(t.id, 'bsky', down); continue; }
    try {
      const now = Date.now();
      slot(t.id).bsky = { tag: tagFor(t), now: round(await bskyRate(tagFor(t), now), 2), m1: round(await bskyRate(tagFor(t), now - 30 * DAY_MS), 2), m3: round(await bskyRate(tagFor(t), now - 90 * DAY_MS), 2) };
    } catch (e) {
      if (/40[13]/.test(e.message)) down = 'Bluesky-Suche geht nur mit Anmeldung';
      slot(t.id).bsky = keep(t.id, 'bsky', down || e.message);
    }
    await sleep(300);
  }
  log('Bluesky fertig');
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
   Korb der wertvollsten Karten. Der Index wird verkettet: Jeden Tag zählt die mittlere Preisänderung
   der Karten, die gestern und heute im Korb sind. So stört es nicht, wenn neue Karten dazukommen. */
function chainIndex(key, label, prices, momentum = null) {
  const old = prev.cards?.[key];
  const series = (old?.series || []).filter(p => p[0] !== today);
  let level = 100;
  if (series.length && old?.prices) {
    const ratios = Object.entries(prices).filter(([id, p]) => old.prices[id] > 0.5 && p > 0.5).map(([id, p]) => p / old.prices[id]);
    level = series.at(-1)[1] * (ratios.length >= 10 ? median(ratios) : 1);
  }
  series.push([today, round(level, 2)]);
  const vals = Object.values(prices);
  out.cards[key] = { label, n: vals.length, typical: round(median(vals), 2), momentum, series: series.slice(-800), prices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, round(v, 2)])) };
  log(`Karten ${key}: ${vals.length} Karten, Index ${round(level, 2)}${momentum ? `, Trend ${round((momentum - 1) * 100, 1)} %` : ''}`);
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
    const prices = {}, mom = [];
    for (const c of body.data || []) {
      const p = c.cardmarket?.prices;
      const price = p?.trendPrice || p?.avg1;
      if (!(price > 0.5)) continue;
      prices[c.id] = price;
      // Gestern ggü. 30-Tage-Schnitt: zeigt sofort, ob die Preise gerade anziehen
      if (p.avg1 > 0.5 && p.avg30 > 0.5) mom.push(p.avg1 / p.avg30);
    }
    if (Object.keys(prices).length < 10) throw new Error('zu wenige Kartenpreise');
    chainIndex('pokemon', 'Pokémon (Special Illustration Rares)', prices, mom.length >= 10 ? round(median(mom), 4) : null);
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
await Promise.all([collectNews(), collectTrends(), collectBsky(), collectMasto(), (async () => { await collectPokemon(); await collectMtg(); await collectYugioh(); })()]);

const count = src => Object.values(out.themes).filter(x => x[src] && !x[src].error).length;
out.summary = Object.fromEntries(['news', 'trends', 'bsky', 'masto'].map(s => [s, count(s)]));
log('Ergebnis', JSON.stringify(out.summary), 'Karten:', Object.keys(out.cards).join(', ') || 'keine');
await mkdir('data', { recursive: true });
await writeFile(OUT, JSON.stringify(out));
