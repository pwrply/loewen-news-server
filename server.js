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
  // bild_url-Spalte nachrüsten falls alte DB
  await pool.query(`ALTER TABLE news ADD COLUMN IF NOT EXISTS bild_url TEXT;`).catch(() => {});
  console.log('[DB] Tabellen bereit.');
}

// Alle News aus DB in den In-Memory-Cache laden
async function ladeNewsAusDB() {
  if (!DB_AKTIV) return;
  const result = await pool.query('SELECT * FROM news ORDER BY erstellt_am DESC LIMIT 500');
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

// Artikel in DB speichern (neue werden eingefügt, existierende ignoriert)
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

// Vollscan: nur wenn Cache/DB leer ist
async function scrapeNewsVollscan() {
  // Im In-Memory-Modus: Cache-Länge prüfen
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
  console.log(`[${new Date().toISOString()}] Löwen News: Vollscan (DB leer)...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    let nextUrl = NEWS_URL, p = 1, gesamtNeu = 0;
    while (nextUrl && p <= 30) {
      console.log(`  Seite ${p}: ${nextUrl}`);
      try {
        const { items, paginationMap } = await scrapeNewsSeite(page, nextUrl);
        const neu = await speichereNewsInDB(items);
        gesamtNeu += neu;
        const neuItems = items.filter(x => !newsCache.find(c => c.url === x.url));
        newsCache = [...neuItems, ...newsCache];
        nextUrl = null;
        const avail = Object.keys(paginationMap).map(Number).filter(n => n > p).sort((a,b)=>a-b);
        if (avail.length > 0) { nextUrl = paginationMap[avail[0]]; p = avail[0] - 1; }
      } catch(e) { console.error(`  Fehler Seite ${p}:`, e.message); break; }
      p++;
      await new Promise(r => setTimeout(r, 800));
    }
    await page.close(); await b.close();
    lastUpdated = new Date().toISOString();
    console.log(`[OK] Löwen Vollscan: ${gesamtNeu} Artikel in DB gespeichert.`);
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

// Filterregel: NUR Titeltext prüfen, NICHT href (DEL-Slugs enthalten keinen Teamnamen)
function istLoewen(text) {
  const t = text.toLowerCase();
  if (t.includes('eislöwen') || t.includes('eisloewen') || t.includes('dresden')) return false;
  return t.includes('frankfurt') || t.includes('loewen') || /(?<![a-z])löwen(?![a-z])/i.test(text);
}

async function scrapeDelSeite(page, url) {
  const items = [];
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  const html = await page.content();

  const $ = cheerio.load(html);

  const gesehenUrls = new Set();
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    // DEL-Artikel-Links: /news/detail/...
    if (!href.includes('/news/detail/')) return;
    const fullUrl = href.startsWith('http') ? href : `https://www.penny-del.org${href}`;
    if (gesehenUrls.has(fullUrl)) return;

    // Text: eigener Text ODER Überschrift im Container
    const eigenerText  = $(el).text().trim();
    const container    = $(el).closest('article, .news-item, .teaser, .card, li, div');
    const ueberschrift = container.find('h1,h2,h3,h4').first().text().trim();
    const text = ueberschrift.length > 10 ? ueberschrift : eigenerText;
    if (text.length <= 10) return;

    // Filter: nur Titeltext (href-Slug enthält keinen Teamnamen bei DEL)
    if (!istLoewen(text)) return;

    // Datum
    let datum = '';
    const datumEl  = container.find('time,[class*="date"],[class*="datum"]').first();
    const datumRaw = datumEl.attr('datetime') || datumEl.text().trim();
    const mIso = datumRaw.match(/(\d{4})-(\d{2})-(\d{2})/);
    const mDe  = datumRaw.match(/(\d{2}\.\d{2}\.\d{4})/);
    if (mIso) datum = `${mIso[3]}.${mIso[2]}.${mIso[1]}`;
    else if (mDe) datum = mDe[0];

    // Bild
    let bildUrl = '';
    const img = container.find('img').first();
    if (img.length) bildUrl = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';

    gesehenUrls.add(fullUrl);
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

  console.log(`  [DEL] ${items.length} Löwen-Artikel auf Seite gefunden.`);

  // Pagination
  const paginationMap = {};
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/[?&]page=(\d+)/) || href.match(/\/page\/(\d+)/) || href.match(/\/news\/(\d+)$/);
    if (m) {
      const num = parseInt(m[1]);
      if (num > 1) paginationMap[num] = href.startsWith('http') ? href : `https://www.penny-del.org${href}`;
    }
  });
  return { items, paginationMap };
}

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
  console.log(`[${new Date().toISOString()}] DEL News: Vollscan (DB leer)...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    // DEL-Seite hat keine Pagination — alle News stehen auf einer Seite
    console.log(`  DEL Seite 1: ${DEL_URL}`);
    const { items } = await scrapeDelSeite(page, DEL_URL);
    const gesamtNeu = await speichereNewsInDB(items);
    const neuItems = items.filter(x => !delNewsCache.find(c => c.url === x.url));
    delNewsCache = [...neuItems, ...delNewsCache];
    await page.close(); await b.close();
    delLastUpdated = new Date().toISOString();
    console.log(`[OK] DEL Vollscan: ${gesamtNeu} Artikel in DB gespeichert.`);
  } catch(err) {
    console.error('[FEHLER] DEL Vollscan:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

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
// MARK: - Presse-Scraper (eishockeynews.de)
// ─────────────────────────────────────────────

async function scrapePresseNews() {
  console.log(`[${new Date().toISOString()}] Presse News: Scraping hockeyweb.de...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(PRESSE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));
    const $ = cheerio.load(await page.content());
    await page.close(); await b.close();
    b = null;

    const artikel = [];
    const gesehenUrls = new Set();
    const BASE_HOCKEYWEB = 'https://www.hockeyweb.de';

    // hockeyweb.de: Artikel stehen in h2/h3 mit Links, oder in .entry-title / .post-title
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

        // Container für Datum + Bild
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
        if (img.length) {
          bildUrl = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';
        }

        artikel.push({
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
      if (artikel.length > 0) break; // erster passender Selektor reicht
    }

    // Fallback: alle Links die "/del/" oder "/eishockey/" enthalten
    if (artikel.length === 0) {
      $('a[href]').each((i, el) => {
        const href  = $(el).attr('href') || '';
        const titel = $(el).text().trim();
        if (titel.length < 10) return;
        if (!href.includes('hockeyweb') && !href.startsWith('/')) return;
        const vollUrl = href.startsWith('http') ? href : `${BASE_HOCKEYWEB}${href}`;
        if (gesehenUrls.has(vollUrl)) return;
        gesehenUrls.add(vollUrl);
        artikel.push({
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

    if (artikel.length > 0) {
      const neuItems = artikel.filter(x => !presseCache.find(c => c.url === x.url));
      presseCache = [...neuItems, ...presseCache].slice(0, 100);
      await speichereNewsInDB(artikel);
      presseLastUpdated = new Date().toISOString();
      console.log(`[OK] Presse: ${artikel.length} Artikel gescraped, ${neuItems.length} neu.`);
    } else {
      console.warn('[WARN] Presse: Keine Artikel gefunden — hockeyweb.de Struktur prüfen.');
    }
  } catch(err) {
    console.error('[FEHLER] Presse Scraper:', err.message);
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
      const punkte    = parseInt($(cols[3]).text().trim()) || 0;
      const siege     = parseInt($(cols[4]).text().trim()) || 0;
      const otSiege   = parseInt($(cols[5]).text().trim()) || 0;
      const otNied    = parseInt($(cols[6]).text().trim()) || 0;
      const nieder    = parseInt($(cols[7]).text().trim()) || 0;
      const toreParts = ($(cols[8]).text().trim() || '0:0').split(':');
      if (!team || team.length < 2) return;
      eintraege.push({
        rang, team, spiele, siege, otSiege,
        otNiederlagen: otNied, niederlagen: nieder,
        torePlus: parseInt(toreParts[0]) || 0,
        toreMinus: parseInt(toreParts[1]) || 0,
        punkte,
        istEigenesMannschaft: team.toLowerCase().includes('frankfurt')
      });
    });

    if (eintraege.length >= 10) {
      await speichereTabelleInDB(eintraege);
      tabelleCache = eintraege;
      tabelleLastUpdated = new Date().toISOString();
      console.log(`[OK] DEL Tabelle: ${eintraege.length} Teams gespeichert.`);
    } else {
      console.warn(`[WARN] Tabelle: nur ${eintraege.length} Einträge — nicht gespeichert.`);
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

app.post('/api/reset-cache', async (req, res) => {
  try {
    if (DB_AKTIV) {
      await pool.query('DELETE FROM news');
      await pool.query('DELETE FROM tabelle');
    }
    newsCache = []; delNewsCache = []; presseCache = [];
    tabelleCache = []; lastUpdated = null;
    delLastUpdated = null; presseLastUpdated = null; tabelleLastUpdated = null;
    res.json({ status: 'ok', message: 'DB geleert, Vollscan läuft neu...' });
    scrapeNewsVollscan();
    setTimeout(() => scrapeDelVollscan(), 90000);
    setTimeout(() => scrapePresseNews(), 120000);
    setTimeout(() => scrapeTabelle(), 180000);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', version: '5.0.0',
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
    version: '5.0.0',
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
// MARK: - Cron Jobs
// ─────────────────────────────────────────────

cron.schedule('*/5 * * * *',  scrapeNewsUpdate);
cron.schedule('*/5 * * * *',  scrapeDelUpdate);
cron.schedule('0 */2 * * *',  scrapePresseNews);   // alle 2 Stunden
cron.schedule('*/15 * * * *', scrapeTabelle);

// ─────────────────────────────────────────────
// MARK: - Startup
// ─────────────────────────────────────────────

async function startup() {
  // 1. DB initialisieren
  await initDB();
  dbBereit = true;

  // 2. Gespeicherte Daten sofort in Cache laden
  await ladeNewsAusDB();
  await ladeTabelleAusDB();
  lastUpdated = new Date().toISOString();

  // 3. Scraper starten
  setTimeout(() => scrapeNewsVollscan(),  5000);    // nach 5 Sek
  setTimeout(() => scrapeDelVollscan(),   90000);   // nach 1,5 Min
  setTimeout(() => scrapePresseNews(),    150000);  // nach 2,5 Min
  setTimeout(() => scrapeTabelle(),       180000);  // nach 3 Min
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server v5.0 läuft auf Port ${PORT}`);
  startup();
});
