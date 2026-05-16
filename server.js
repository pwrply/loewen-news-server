const express    = require('express');
const cheerio    = require('cheerio');
const puppeteer  = require('puppeteer-core');
const cron       = require('node-cron');
const cors       = require('cors');
const { Pool }   = require('pg');

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// MARK: - Datenbank
// ─────────────────────────────────────────────

const DB_AKTIV = !!process.env.DATABASE_URL;

const pool = DB_AKTIV ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

async function initDB() {
  if (!DB_AKTIV) { console.log('[DB] Kein DATABASE_URL — reiner In-Memory-Modus.'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news (
      id          TEXT PRIMARY KEY,
      titel       TEXT NOT NULL,
      url         TEXT NOT NULL UNIQUE,
      datum       TEXT,
      kategorie   TEXT,
      quelle      TEXT,
      quelletyp   TEXT,
      bild_url    TEXT,
      erstellt_am TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tabelle (
      rang                  INT PRIMARY KEY,
      team                  TEXT NOT NULL,
      spiele                INT,
      siege                 INT,
      ot_siege              INT,
      ot_niederlagen        INT,
      niederlagen           INT,
      tore_plus             INT,
      tore_minus            INT,
      punkte                INT,
      ist_eigene_mannschaft BOOLEAN,
      aktualisiert_am       TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE news ADD COLUMN IF NOT EXISTS bild_url TEXT;`).catch(() => {});
  console.log('[DB] Tabellen bereit.');
}

// DB komplett leeren (news + tabelle)
async function leereDatenbank() {
  if (!DB_AKTIV) return;
  await pool.query('DELETE FROM news');
  await pool.query('DELETE FROM tabelle');
  console.log('[DB] Datenbank komplett geleert.');
}

// Alle News aus DB in den In-Memory-Cache laden
async function ladeNewsAusDB() {
  if (!DB_AKTIV) return;
  const result = await pool.query('SELECT * FROM news ORDER BY erstellt_am DESC LIMIT 1000');
  const items = result.rows.map(r => ({
    id:        r.id,
    titel:     r.titel,
    url:       r.url,
    datum:     r.datum,
    kategorie: r.kategorie,
    quelle:    r.quelle,
    quelletyp: r.quelletyp,
    bildUrl:   r.bild_url || ''
  }));
  newsCache    = items.filter(x => x.quelletyp === 'loewen');
  delNewsCache = items.filter(x => x.quelletyp === 'del');
  presseCache  = items.filter(x => x.quelletyp === 'presse');
  console.log(`[DB] ${newsCache.length} Löwen + ${delNewsCache.length} DEL + ${presseCache.length} Presse Artikel geladen.`);
}

// Tabelle aus DB laden
async function ladeTabelleAusDB() {
  if (!DB_AKTIV) return;
  const result = await pool.query('SELECT * FROM tabelle ORDER BY rang ASC');
  if (result.rows.length >= 10) {
    tabelleCache = result.rows.map(r => ({
      rang:                 r.rang,
      team:                 r.team,
      spiele:               r.spiele,
      siege:                r.siege,
      otSiege:              r.ot_siege,
      otNiederlagen:        r.ot_niederlagen,
      niederlagen:          r.niederlagen,
      torePlus:             r.tore_plus,
      toreMinus:            r.tore_minus,
      punkte:               r.punkte,
      istEigenesMannschaft: r.ist_eigene_mannschaft
    }));
    tabelleLastUpdated = result.rows[0]?.aktualisiert_am?.toISOString() || null;
    console.log(`[DB] ${tabelleCache.length} Tabelleneinträge geladen.`);
  }
}

// Artikel in DB speichern — neue einfügen, existierende Bild-URL aktualisieren
async function speichereNewsInDB(items) {
  if (!DB_AKTIV) return items.length;
  let neu = 0;
  for (const item of items) {
    try {
      const r = await pool.query(
        `INSERT INTO news (id, titel, url, datum, kategorie, quelle, quelletyp, bild_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (url) DO UPDATE SET bild_url = EXCLUDED.bild_url`,
        [item.id, item.titel, item.url, item.datum, item.kategorie, item.quelle, item.quelletyp, item.bildUrl || '']
      );
      if (r.rowCount > 0) neu++;
    } catch (_) {}
  }
  return neu;
}

// Tabelle in DB speichern (vollständiges Upsert)
async function speichereTabelleInDB(eintraege) {
  if (!DB_AKTIV) return;
  for (const e of eintraege) {
    await pool.query(
      `INSERT INTO tabelle (rang, team, spiele, siege, ot_siege, ot_niederlagen, niederlagen, tore_plus, tore_minus, punkte, ist_eigene_mannschaft, aktualisiert_am)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (rang) DO UPDATE SET
         team                  = EXCLUDED.team,
         spiele                = EXCLUDED.spiele,
         siege                 = EXCLUDED.siege,
         ot_siege              = EXCLUDED.ot_siege,
         ot_niederlagen        = EXCLUDED.ot_niederlagen,
         niederlagen           = EXCLUDED.niederlagen,
         tore_plus             = EXCLUDED.tore_plus,
         tore_minus            = EXCLUDED.tore_minus,
         punkte                = EXCLUDED.punkte,
         ist_eigene_mannschaft = EXCLUDED.ist_eigene_mannschaft,
         aktualisiert_am       = NOW()`,
      [e.rang, e.team, e.spiele, e.siege, e.otSiege, e.otNiederlagen,
       e.niederlagen, e.torePlus, e.toreMinus, e.punkte, e.istEigenesMannschaft]
    );
  }
}

// ─────────────────────────────────────────────
// MARK: - In-Memory Cache
// ─────────────────────────────────────────────

let newsCache    = [];
let delNewsCache = [];
let presseCache  = [];
let tabelleCache = [];
let lastUpdated        = null;
let delLastUpdated     = null;
let presseLastUpdated  = null;
let tabelleLastUpdated = null;
let dbBereit           = false;

// ─────────────────────────────────────────────
// MARK: - Hilfsfunktionen
// ─────────────────────────────────────────────

const BASE_URL   = 'https://www.loewen-frankfurt.de';
const NEWS_URL   = `${BASE_URL}/saison/aktuelles`;
const DEL_URL    = 'https://www.penny-del.org/news';
const PRESSE_URL = 'https://www.hockeyweb.de/tag/loewen-frankfurt';

function kategorisiere(titel) {
  const t = titel.toLowerCase();
  if (t.includes('presse') || t.includes('bild') || t.includes('fn') || t.includes('faz')) return 'Presse';
  if (t.includes('vorschau') || t.includes('heimspiel') || t.includes('auswärts')) return 'Vorschau';
  if (t.includes('sieg') || t.includes('niederlage') || t.includes('tore') ||
      t.includes('gewinnt') || t.includes('verliert') || t.includes('siegt')) return 'Spielberichte';
  if (t.includes('transfer') || t.includes('verpflicht') || t.includes('neuzugang') ||
      t.includes('verlängert') || t.includes('vertrag')) return 'Team';
  if (t.includes('fan') || t.includes('dauerkar') || t.includes('ticket')) return 'Fans';
  return 'Allgemein';
}

async function getBrowser() {
  return await puppeteer.launch({
    executablePath: CHROME_PATH,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--single-process','--memory-pressure-off','--max_old_space_size=256'],
    headless: true
  });
}

const isoZuDe = iso => {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};

const parseDate = d => {
  if (!d) return 0;
  const [day, month, year] = d.split('.');
  return new Date(`${year}-${month}-${day}`).getTime() || 0;
};

// ─────────────────────────────────────────────
// MARK: - Löwen News Scraper
// ─────────────────────────────────────────────

async function scrapeNewsSeite(page, url) {
  const items = [];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 800));
  const $ = cheerio.load(await page.content());

  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!href.includes('/saison/aktuelles/details/') || text.length <= 10) return;
    const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    const datumMatch = text.match(/^(\d{2}\.\d{2}\.\d{4})\s+/);
    const sauberTitel = datumMatch ? text.replace(datumMatch[0], '').trim() : text;
    items.push({
      id:        Buffer.from(fullUrl).toString('base64').slice(-32),
      titel:     sauberTitel,
      url:       fullUrl,
      datum:     datumMatch ? datumMatch[1] : '',
      kategorie: kategorisiere(sauberTitel),
      quelle:    'Löwen Frankfurt',
      quelletyp: 'loewen',
      bildUrl:   ''
    });
  });

  const paginationMap = {};
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const match = decodeURIComponent(href).match(/currentPage\]=(\d+)/);
    if (match) {
      const num = parseInt(match[1]);
      paginationMap[num] = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    }
  });
  return { items, paginationMap };
}

// Vollscan über bis zu 30 Seiten (läuft nur wenn DB leer)
async function scrapeNewsVollscan() {
  if (!DB_AKTIV && newsCache.length > 0) {
    console.log(`[INFO] Löwen News: Cache hat bereits ${newsCache.length} Artikel — kein Vollscan nötig.`);
    return;
  }
  if (DB_AKTIV) {
    const count = await pool.query("SELECT COUNT(*) FROM news WHERE quelletyp='loewen'");
    if (parseInt(count.rows[0].count) > 0) {
      console.log(`[INFO] Löwen News: DB hat bereits ${count.rows[0].count} Artikel — kein Vollscan nötig.`);
      return;
    }
  }
  console.log(`[${new Date().toISOString()}] Löwen News: Vollscan (bis 30 Seiten)...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    let nextUrl = NEWS_URL, p = 1, gesamtNeu = 0;
    while (nextUrl && p <= 30) {
      console.log(`  Löwen Seite ${p}: ${nextUrl}`);
      try {
        const { items, paginationMap } = await scrapeNewsSeite(page, nextUrl);
        const neu = await speichereNewsInDB(items);
        gesamtNeu += neu;
        const neuItems = items.filter(x => !newsCache.find(c => c.url === x.url));
        newsCache = [...neuItems, ...newsCache];
        nextUrl = null;
        const avail = Object.keys(paginationMap).map(Number).filter(n => n > p).sort((a, b) => a - b);
        if (avail.length > 0) { nextUrl = paginationMap[avail[0]]; p = avail[0] - 1; }
      } catch(e) { console.error(`  Fehler Seite ${p}:`, e.message); break; }
      p++;
      await new Promise(r => setTimeout(r, 800));
    }
    await page.close(); await b.close();
    lastUpdated = new Date().toISOString();
    console.log(`[OK] Löwen Vollscan abgeschlossen: ${gesamtNeu} neue Artikel.`);
  } catch(err) {
    console.error('[FEHLER] Löwen Vollscan:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

// Seite-1-Update: läuft alle 5 Min
async function scrapeNewsUpdate() {
  console.log(`[${new Date().toISOString()}] Löwen News: Seite-1-Update...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    const { items } = await scrapeNewsSeite(page, NEWS_URL);
    await page.close(); await b.close();
    const neu = await speichereNewsInDB(items);
    if (neu > 0) {
      const neuItems = items.filter(x => !newsCache.find(c => c.url === x.url));
      newsCache = [...neuItems, ...newsCache];
      lastUpdated = new Date().toISOString();
    }
    console.log(`[OK] Löwen Update: ${neu} neue Artikel.`);
  } catch(err) {
    console.error('[FEHLER] Löwen Update:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

// ─────────────────────────────────────────────
// MARK: - DEL News Scraper
// ─────────────────────────────────────────────

// Filter: Artikel mit Löwen/Frankfurt-Bezug, ohne Dresden/Eislöwen
function istLoewen(text) {
  const t = text.toLowerCase();
  // Ausschlussliste zuerst prüfen
  if (t.includes('eislöwen') || t.includes('eisloewen') || t.includes('dresden')) return false;
  // Einschlussliste: Frankfurt, Löwen (in allen Schreibweisen), loewen
  if (t.includes('frankfurt')) return true;
  if (t.includes('loewen'))    return true;
  // "löwen" als eigenständiges Wort oder Teil eines Kompositums (z.B. "Löwen-Sieg", "Löwen-Spiel")
  if (t.includes('löwen'))     return true;
  return false;
}

async function scrapeDelSeite(page, url) {
  const items = [];
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  const $ = cheerio.load(await page.content());

  const gesehenUrls = new Set();
  let gesamtArtikelAufSeite = 0; // Zählt alle /news/detail/ Links (vor dem Löwen-Filter)

  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('/news/detail/')) return;
    const fullUrl = href.startsWith('http') ? href : `https://www.penny-del.org${href}`;
    if (gesehenUrls.has(fullUrl)) return;
    gesehenUrls.add(fullUrl);
    gesamtArtikelAufSeite++;

    const eigenerText  = $(el).text().trim();
    const container    = $(el).closest('article, .news-item, .teaser, .card, li, div');
    const ueberschrift = container.find('h1,h2,h3,h4').first().text().trim();
    const text = ueberschrift.length > 10 ? ueberschrift : eigenerText;
    if (text.length <= 10) return;
    if (!istLoewen(text)) return;

    let datum = '';
    const datumEl  = container.find('time,[class*="date"],[class*="datum"]').first();
    const datumRaw = datumEl.attr('datetime') || datumEl.text().trim();
    const mIso = datumRaw.match(/(\d{4})-(\d{2})-(\d{2})/);
    const mDe  = datumRaw.match(/(\d{2}\.\d{2}\.\d{4})/);
    if (mIso) datum = `${mIso[3]}.${mIso[2]}.${mIso[1]}`;
    else if (mDe) datum = mDe[0];

    let bildUrl = '';
    const img = container.find('img').first();
    if (img.length) bildUrl = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';

    items.push({
      id:        Buffer.from(fullUrl).toString('base64').slice(-32),
      titel:     text,
      url:       fullUrl,
      datum,
      kategorie: kategorisiere(text),
      quelle:    'PennyDEL',
      quelletyp: 'del',
      bildUrl
    });
  });

  console.log(`  [DEL] Seite: ${gesamtArtikelAufSeite} Artikel total, ${items.length} mit Löwen-Bezug.`);
  return { items, gesamtArtikelAufSeite };
}

// Vollscan über 30 Seiten (läuft nur wenn DB leer)
async function scrapeDelVollscan() {
  if (!DB_AKTIV && delNewsCache.length > 0) {
    console.log(`[INFO] DEL News: Cache hat bereits ${delNewsCache.length} Artikel — kein Vollscan nötig.`);
    return;
  }
  if (DB_AKTIV) {
    const count = await pool.query("SELECT COUNT(*) FROM news WHERE quelletyp='del'");
    if (parseInt(count.rows[0].count) > 0) {
      console.log(`[INFO] DEL News: DB hat bereits ${count.rows[0].count} Artikel — kein Vollscan nötig.`);
      return;
    }
  }
  console.log(`[${new Date().toISOString()}] DEL News: Vollscan (bis 30 Seiten)...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    let gesamtNeu = 0;
    for (let p = 1; p <= 30; p++) {
      const url = p === 1 ? DEL_URL : `${DEL_URL}?page=${p}`;
      console.log(`  DEL Seite ${p}/30: ${url}`);
      try {
        const { items, gesamtArtikelAufSeite } = await scrapeDelSeite(page, url);
        // Abbruch nur wenn die Seite überhaupt keine Artikel mehr hat (Ende der Pagination)
        if (gesamtArtikelAufSeite === 0 && p > 1) {
          console.log(`  [DEL] Seite ${p} leer — Ende der Pagination erreicht.`);
          break;
        }
        if (items.length > 0) {
          const neu = await speichereNewsInDB(items);
          gesamtNeu += neu;
          const neuItems = items.filter(x => !delNewsCache.find(c => c.url === x.url));
          delNewsCache = [...neuItems, ...delNewsCache];
        }
      } catch(e) {
        console.error(`  [DEL] Fehler Seite ${p}:`, e.message);
        break;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    await page.close(); await b.close();
    delLastUpdated = new Date().toISOString();
    console.log(`[OK] DEL Vollscan abgeschlossen: ${gesamtNeu} neue Löwen-Artikel.`);
  } catch(err) {
    console.error('[FEHLER] DEL Vollscan:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

// Seite-1-Update: läuft alle 5 Min
async function scrapeDelUpdate() {
  console.log(`[${new Date().toISOString()}] DEL News: Seite-1-Update...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    const { items } = await scrapeDelSeite(page, DEL_URL);
    await page.close(); await b.close();
    const neu = await speichereNewsInDB(items);
    if (neu > 0) {
      const neuItems = items.filter(x => !delNewsCache.find(c => c.url === x.url));
      delNewsCache = [...neuItems, ...delNewsCache];
      delLastUpdated = new Date().toISOString();
    }
    console.log(`[OK] DEL Update: ${neu} neue Artikel.`);
  } catch(err) {
    console.error('[FEHLER] DEL Update:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

// ─────────────────────────────────────────────
// MARK: - Presse-Scraper (hockeyweb.de)
// ─────────────────────────────────────────────

async function scrapePresseSeite(page, url) {
  const items = [];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 1500));
  const $ = cheerio.load(await page.content());

  const gesehenUrls = new Set();
  const BASE_HOCKEYWEB = 'https://www.hockeyweb.de';

  const selektoren = [
    'h2 a[href]', 'h3 a[href]', '.entry-title a', '.post-title a',
    'article a[href]', '.teaser a[href]', '.news-title a'
  ];

  for (const sel of selektoren) {
    $(sel).each((i, el) => {
      const href  = $(el).attr('href') || '';
      const titel = $(el).text().trim();
      if (!href || titel.length < 5) return;
      if (!href.includes('hockeyweb') && !href.startsWith('/')) return;
      const vollUrl = href.startsWith('http') ? href : `${BASE_HOCKEYWEB}${href}`;
      if (gesehenUrls.has(vollUrl)) return;
      gesehenUrls.add(vollUrl);

      const container = $(el).closest('article, .post, .teaser, .entry, li');
      let datum = '';
      const datumEl = container.find('time,[class*="date"],[class*="datum"],span').first();
      const datumRaw = datumEl.attr('datetime') || datumEl.text().trim();
      const mIso = datumRaw.match(/(\d{4})-(\d{2})-(\d{2})/);
      const mDe  = datumRaw.match(/(\d{2}\.\d{2}\.\d{4})/);
      if (mIso) datum = `${mIso[3]}.${mIso[2]}.${mIso[1]}`;
      else if (mDe) datum = mDe[0];

      let bildUrl = '';
      const img = container.find('img').first();
      if (img.length) bildUrl = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';

      items.push({
        id:        Buffer.from(vollUrl).toString('base64').slice(-32),
        titel,
        url:       vollUrl,
        datum,
        kategorie: 'Presse',
        quelle:    'Hockeyweb',
        quelletyp: 'presse',
        bildUrl:   bildUrl || ''
      });
    });
    if (items.length > 0) break;
  }

  // Fallback
  if (items.length === 0) {
    $('a[href]').each((i, el) => {
      const href  = $(el).attr('href') || '';
      const titel = $(el).text().trim();
      if (titel.length < 10) return;
      if (!href.includes('hockeyweb') && !href.startsWith('/')) return;
      const vollUrl = href.startsWith('http') ? href : `${BASE_HOCKEYWEB}${href}`;
      if (gesehenUrls.has(vollUrl)) return;
      gesehenUrls.add(vollUrl);
      items.push({
        id:        Buffer.from(vollUrl).toString('base64').slice(-32),
        titel,
        url:       vollUrl,
        datum:     '',
        kategorie: 'Presse',
        quelle:    'Hockeyweb',
        quelletyp: 'presse',
        bildUrl:   ''
      });
    });
  }

  console.log(`  [Presse] ${items.length} Artikel auf Seite gefunden.`);
  return { items, gesamtArtikelAufSeite: items.length };
}

// Vollscan über 30 Seiten (läuft nur wenn DB leer)
async function scrapePresseVollscan() {
  if (!DB_AKTIV && presseCache.length > 0) {
    console.log(`[INFO] Presse: Cache hat bereits ${presseCache.length} Artikel — kein Vollscan nötig.`);
    return;
  }
  if (DB_AKTIV) {
    const count = await pool.query("SELECT COUNT(*) FROM news WHERE quelletyp='presse'");
    if (parseInt(count.rows[0].count) > 0) {
      console.log(`[INFO] Presse: DB hat bereits ${count.rows[0].count} Artikel — kein Vollscan nötig.`);
      return;
    }
  }
  console.log(`[${new Date().toISOString()}] Presse: Vollscan (bis 30 Seiten)...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    let gesamtNeu = 0;
    for (let p = 1; p <= 30; p++) {
      // hockeyweb.de paginiert über /page/N/
      const url = p === 1 ? PRESSE_URL : `${PRESSE_URL}/page/${p}/`;
      console.log(`  Presse Seite ${p}/30: ${url}`);
      try {
        const { items, gesamtArtikelAufSeite } = await scrapePresseSeite(page, url);
        if (gesamtArtikelAufSeite === 0 && p > 1) {
          console.log(`  [Presse] Seite ${p} leer — Ende der Pagination erreicht.`);
          break;
        }
        if (items.length > 0) {
          const neu = await speichereNewsInDB(items);
          gesamtNeu += neu;
          const neuItems = items.filter(x => !presseCache.find(c => c.url === x.url));
          presseCache = [...neuItems, ...presseCache];
        }
      } catch(e) {
        console.error(`  [Presse] Fehler Seite ${p}:`, e.message);
        break;
      }
      await new Promise(r => setTimeout(r, 1200));
    }
    await page.close(); await b.close();
    presseLastUpdated = new Date().toISOString();
    console.log(`[OK] Presse Vollscan abgeschlossen: ${gesamtNeu} neue Artikel.`);
  } catch(err) {
    console.error('[FEHLER] Presse Vollscan:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

// Seite-1-Update: läuft alle 5 Min
async function scrapePresseUpdate() {
  console.log(`[${new Date().toISOString()}] Presse: Seite-1-Update...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    const { items } = await scrapePresseSeite(page, PRESSE_URL);
    await page.close(); await b.close();
    const neu = await speichereNewsInDB(items);
    if (neu > 0) {
      const neuItems = items.filter(x => !presseCache.find(c => c.url === x.url));
      presseCache = [...neuItems, ...presseCache].slice(0, 200);
      presseLastUpdated = new Date().toISOString();
    }
    console.log(`[OK] Presse Update: ${neu} neue Artikel.`);
  } catch(err) {
    console.error('[FEHLER] Presse Update:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

// ─────────────────────────────────────────────
// MARK: - Tabellen-Scraper
// ─────────────────────────────────────────────

async function scrapeTabelle() {
  console.log(`[${new Date().toISOString()}] Scraping DEL Tabelle...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto('https://www.penny-del.org/tabelle', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    const $ = cheerio.load(await page.content());
    await page.close(); await b.close();

    const eintraege = [];
    $('table tbody tr').each((i, row) => {
      const cols = $(row).find('td');
      if (cols.length < 6) return;
      const rang      = parseInt($(cols[0]).text().trim()) || (i + 1);
      const team      = $(cols[1]).text().trim().replace(/\s+/g, ' ');
      const spiele    = parseInt($(cols[2]).text().trim()) || 0;
      const siege     = parseInt($(cols[3]).text().trim()) || 0;
      const otSiege   = parseInt($(cols[4]).text().trim()) || 0;
      const otNieder  = parseInt($(cols[5]).text().trim()) || 0;
      const nieder    = parseInt($(cols[6]).text().trim()) || 0;
      const toreStr   = $(cols[7]).text().trim();
      const toreParts = toreStr.split(':');
      const torePlus  = parseInt(toreParts[0]) || 0;
      const toreMinus = parseInt(toreParts[1]) || 0;
      const punkte    = parseInt($(cols[8]).text().trim()) || 0;
      if (!team || team.length < 3) return;
      const istEigen  = team.toLowerCase().includes('frankfurt') || team.toLowerCase().includes('löwen');
      eintraege.push({ rang, team, spiele, siege, otSiege, otNiederlagen: otNieder,
                       niederlagen: nieder, torePlus, toreMinus, punkte, istEigenesMannschaft: istEigen });
    });

    if (eintraege.length >= 10) {
      tabelleCache = eintraege;
      tabelleLastUpdated = new Date().toISOString();
      await speichereTabelleInDB(eintraege);
      console.log(`[OK] Tabelle: ${eintraege.length} Teams gespeichert.`);
    } else {
      console.warn(`[WARN] Tabelle: Nur ${eintraege.length} Einträge — möglicherweise Ladefehler.`);
    }
  } catch(err) {
    console.error('[FEHLER] Tabelle:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

// ─────────────────────────────────────────────
// MARK: - Artikel-Detail Scraper
// ─────────────────────────────────────────────

async function scrapeArticle(url) {
  const articleBase = new URL(url).origin;
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1000));
    const $ = cheerio.load(await page.content());
    await page.close(); await b.close();
    b = null;
    const titel = $('h1').first().text().trim() || $('title').text().trim();
    const datumRaw = $('time').first().attr('datetime') || $('[class*="date"]').first().text().trim() || '';
    const datum = datumRaw.match(/\d{4}-\d{2}-\d{2}/) ? isoZuDe(datumRaw) : datumRaw;
    let bild = '';
    $('article img,.article img,.content img,main img,img').each((i, el) => {
      if (bild) return;
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('svg')) {
        bild = src.startsWith('http') ? src : src.startsWith('//') ? 'https:'+src : `${articleBase}/${src.replace(/^\//, '')}`;
      }
    });
    const absaetze = [];
    $('article p,.article p,.content p,main p,p').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 30) absaetze.push(text);
    });
    return { titel, datum, bild, absaetze, url };
  } catch(err) {
    if (b) try { await b.close(); } catch(_) {}
    throw new Error(err.message);
  }
}

// ─────────────────────────────────────────────
// MARK: - API Routen
// ─────────────────────────────────────────────

app.get('/api/news', (req, res) => {
  const kategorie = req.query.kategorie;
  let items = [...newsCache, ...delNewsCache, ...presseCache]
    .sort((a, b) => parseDate(b.datum) - parseDate(a.datum));
  if (kategorie && kategorie !== 'Alle') items = items.filter(n => n.kategorie === kategorie);
  res.json({ status: 'ok', lastUpdated, count: items.length, items });
});

app.get('/api/article', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url parameter fehlt' });
  try {
    res.json({ status: 'ok', ...await scrapeArticle(url) });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tabelle', (req, res) => {
  res.json({ status: 'ok', lastUpdated: tabelleLastUpdated, count: tabelleCache.length, tabelle: tabelleCache });
});

app.get('/api/del-news', (req, res) => {
  res.json({ status: 'ok', lastUpdated: delLastUpdated, count: delNewsCache.length, items: delNewsCache });
});

app.get('/api/presse-news', (req, res) => {
  res.json({ status: 'ok', lastUpdated: presseLastUpdated, count: presseCache.length, items: presseCache });
});

// Reset: DB leeren + Vollscans neu starten
app.post('/api/reset-cache', async (req, res) => {
  try {
    await leereDatenbank();
    newsCache = []; delNewsCache = []; presseCache = [];
    tabelleCache = []; lastUpdated = null;
    delLastUpdated = null; presseLastUpdated = null; tabelleLastUpdated = null;
    res.json({ status: 'ok', message: 'DB geleert — Vollscans starten...' });
    scrapeNewsVollscan();
    setTimeout(() => scrapeDelVollscan(),    20000);
    setTimeout(() => scrapePresseVollscan(), 40000);
    setTimeout(() => scrapeTabelle(),        60000);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', version: '6.0.0',
    dbBereit, lastUpdated, delLastUpdated, presseLastUpdated, tabelleLastUpdated,
    loewenArtikel: newsCache.length,
    delArtikel:    delNewsCache.length,
    presseArtikel: presseCache.length,
    tabelleTeams:  tabelleCache.length,
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Löwen Frankfurt News Server',
    version: '6.0.0',
    endpoints: [
      'GET /api/news',
      'GET /api/article?url=...',
      'GET /api/tabelle',
      'GET /api/del-news',
      'GET /api/presse-news',
      'GET /api/health',
      'POST /api/reset-cache'
    ]
  });
});

// ─────────────────────────────────────────────
// MARK: - Cron Jobs (alle 5 Min: nur Seite 1)
// ─────────────────────────────────────────────

cron.schedule('*/5 * * * *',  scrapeNewsUpdate);    // Löwen Seite 1
cron.schedule('*/5 * * * *',  scrapeDelUpdate);     // DEL Seite 1
cron.schedule('*/5 * * * *',  scrapePresseUpdate);  // Presse Seite 1
cron.schedule('*/15 * * * *', scrapeTabelle);       // Tabelle alle 15 Min

// ─────────────────────────────────────────────
// MARK: - Startup
// ─────────────────────────────────────────────

async function startup() {
  // 1. DB initialisieren & komplett leeren
  await initDB();
  await leereDatenbank();
  dbBereit = true;

  // 2. Vollscans gestaffelt starten (Browser-Ressourcen schonen)
  console.log('[STARTUP] Starte Vollscans für alle Quellen...');
  setTimeout(() => scrapeNewsVollscan(),    5000);    // Löwen: nach 5 Sek
  setTimeout(() => scrapeDelVollscan(),    20000);    // DEL:   nach 20 Sek
  setTimeout(() => scrapePresseVollscan(), 40000);    // Presse: nach 40 Sek
  setTimeout(() => scrapeTabelle(),        60000);    // Tabelle: nach 60 Sek
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server v6.0 läuft auf Port ${PORT}`);
  startup();
});
