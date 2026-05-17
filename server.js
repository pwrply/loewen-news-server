const express    = require('express');
const cheerio    = require('cheerio');
const puppeteer  = require('puppeteer-core');
const cors       = require('cors');
const { Pool }   = require('pg');

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';
const BASE_URL    = 'https://www.loewen-frankfurt.de';
const NEWS_URL    = 'https://www.loewen-frankfurt.de/saison/aktuelles';

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
      quelle      TEXT,
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
  console.log('[DB] Tabellen bereit.');
}

async function leereDatenbank() {
  if (!DB_AKTIV) return;
  await pool.query('DELETE FROM news');
  await pool.query('DELETE FROM tabelle');
  console.log('[DB] Datenbank komplett geleert.');
}

async function ladeNewsAusDB() {
  if (!DB_AKTIV) return;
  const result = await pool.query('SELECT * FROM news ORDER BY erstellt_am DESC LIMIT 1000');
  newsCache = result.rows.map(r => ({
    id:      r.id,
    titel:   r.titel,
    url:     r.url,
    datum:   r.datum,
    quelle:  r.quelle,
    bildUrl: r.bild_url || ''
  }));
  console.log(`[DB] ${newsCache.length} Artikel geladen.`);
}

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
    console.log(`[DB] ${tabelleCache.length} Tabelleneintraege geladen.`);
  }
}

async function speichereNewsInDB(items) {
  if (!DB_AKTIV) return items.length;
  let neu = 0;
  for (const item of items) {
    try {
      await pool.query(
        `INSERT INTO news (id, titel, url, datum, quelle, bild_url)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (url) DO NOTHING`,
        [item.id, item.titel, item.url, item.datum, item.quelle, item.bildUrl || '']
      );
      neu++;
    } catch (_) {}
  }
  return neu;
}

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

let newsCache          = [];
let tabelleCache       = [];
let lastUpdated        = null;
let tabelleLastUpdated = null;
let dbBereit           = false;
let letzterNewsCount   = 0;

// ─────────────────────────────────────────────
// MARK: - Browser
// ─────────────────────────────────────────────

function parseDate(str) {
  if (!str) return 0;
  const [d, m, y] = str.split('.');
  return new Date(`${y}-${m}-${d}`).getTime() || 0;
}

async function getBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
}

// ─────────────────────────────────────────────
// MARK: - News Scraper (eine Seite)
// ─────────────────────────────────────────────

async function scrapeNewsSeite(page, seite) {
  const url = seite === 1 ? NEWS_URL : `${NEWS_URL}?tx_news_pi1[currentPage]=${seite - 1}`;
  console.log(`    [news] Seite ${seite}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 2000));
  const $ = cheerio.load(await page.content());
  const items = [];

  $('a[href*="/saison/aktuelles/"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const katPfade = ['/saison/aktuelles', '/saison/aktuelles/vorschau', '/saison/aktuelles/spielberichte', '/saison/aktuelles/team', '/saison/aktuelles/fans'];
    const normHref = href.replace(/\/$/, '');
    if (katPfade.includes(normHref)) return;
    if (!href.includes('/saison/aktuelles/')) return;

    const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    if (items.find(x => x.url === fullUrl)) return;

    let titel = $(el).find('h2, h3, h4, .title, .headline, [class*="title"], [class*="headline"]').first().text().trim();
    if (!titel) titel = $(el).clone().children().remove().end().text().trim();
    if (!titel) titel = $(el).text().trim();
    titel = titel.replace(/\s+/g, ' ').trim();
    if (titel.length < 8) return;

    let datum = '';
    const container = $(el).closest('article, li, div');
    const datumMatch = container.text().match(/(\d{2}\.\d{2}\.\d{4})/);
    if (datumMatch) datum = datumMatch[1];

    items.push({
      id:      Buffer.from(fullUrl).toString('base64').slice(-32),
      titel:   titel,
      url:     fullUrl,
      datum:   datum,
      quelle:  'Loewen Frankfurt',
      bildUrl: ''
    });
  });

  console.log(`    [news] Seite ${seite}: ${items.length} Artikel gefunden`);
  return items;
}

// ─────────────────────────────────────────────
// MARK: - Vollscan (alle Seiten, beim Start)
// ─────────────────────────────────────────────

async function scrapeNewsVollscan() {
  console.log(`[${new Date().toISOString()}] Lowen News: Vollscan (alle Seiten)...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    let allItems = [];
    let seite = 1;
    const maxSeiten = 15;

    while (seite <= maxSeiten) {
      const seiteItems = await scrapeNewsSeite(page, seite);
      if (seiteItems.length === 0) break;
      allItems = allItems.concat(seiteItems);
      if (seiteItems.length < 10) break; // letzte Seite
      seite++;
    }

    // Duplikate entfernen
    const uniqueItems = allItems.filter((item, index, self) =>
      index === self.findIndex(x => x.url === item.url)
    );

    const neueArtikel = uniqueItems.filter(item => !newsCache.find(c => c.url === item.url));

    await speichereNewsInDB(uniqueItems);
    newsCache = uniqueItems;
    lastUpdated = new Date().toISOString();
    letzterNewsCount = uniqueItems.length;

    if (neueArtikel.length > 0) {
      console.log(`[PUSH] ${neueArtikel.length} neue Artikel!`);
      neueArtikel.forEach(n => console.log(`  - ${n.titel}`));
    }

    await page.close();
    await b.close();
    console.log(`[OK] Vollscan: ${uniqueItems.length} Artikel aus ${seite} Seiten.`);
  } catch (err) {
    console.error('[FEHLER] Vollscan:', err.message);
    if (b) try { await b.close(); } catch (_) {}
  }
}

// ─────────────────────────────────────────────
// MARK: - Schnell-Check (alle 5 Min, nur Seite 1)
// ─────────────────────────────────────────────

async function scrapeNewsSchnell() {
  console.log(`[${new Date().toISOString()}] Schnell-Check Seite 1...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    const items = await scrapeNewsSeite(page, 1);
    const neueArtikel = items.filter(item => !newsCache.find(c => c.url === item.url));

    if (neueArtikel.length > 0) {
      console.log(`[PUSH] ${neueArtikel.length} neue Artikel!`);
      neueArtikel.forEach(n => console.log(`  - ${n.titel}`));
      await speichereNewsInDB(neueArtikel);
      newsCache = [...neueArtikel, ...newsCache];
      lastUpdated = new Date().toISOString();
    } else {
      console.log('[OK] Keine neuen Artikel.');
    }

    await page.close();
    await b.close();
  } catch (err) {
    console.error('[FEHLER] Schnell-Check:', err.message);
    if (b) try { await b.close(); } catch (_) {}
  }
}

// ─────────────────────────────────────────────
// MARK: - Tabelle Scraper
// ─────────────────────────────────────────────

async function scrapeTabelle() {
  console.log(`[${new Date().toISOString()}] DEL Tabelle: Scraping...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto('https://www.eisbaerlin.de/del-tabelle', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));

    const $ = cheerio.load(await page.content());
    const eintraege = [];

    $('table tbody tr').each((i, tr) => {
      const cells = $(tr).find('td').toArray();
      if (cells.length < 8) return;
      const getText = idx => $(cells[idx]).text().trim();
      const toInt   = v  => parseInt(v.replace(/[^\d-]/g, '')) || 0;
      const rang    = i + 1;
      const team    = getText(1) || getText(0);
      const punkte  = toInt(getText(cells.length - 1));
      const spiele  = toInt(getText(2));
      if (!team || team.length < 2) return;
      eintraege.push({
        rang,
        team,
        spiele,
        siege:                toInt(getText(3)),
        otSiege:              toInt(getText(4)),
        otNiederlagen:        toInt(getText(5)),
        niederlagen:          toInt(getText(6)),
        torePlus:             0,
        toreMinus:            0,
        punkte,
        istEigenesMannschaft: team.toLowerCase().includes('frankfurt')
      });
    });

    await page.close();
    await b.close();

    if (eintraege.length >= 8) {
      tabelleCache       = eintraege;
      tabelleLastUpdated = new Date().toISOString();
      await speichereTabelleInDB(eintraege);
      console.log(`[OK] Tabelle: ${eintraege.length} Teams.`);
    }
  } catch (err) {
    console.error('[FEHLER] Tabelle:', err.message);
    if (b) try { await b.close(); } catch (_) {}
  }
}

// ─────────────────────────────────────────────
// MARK: - API Routen
// ─────────────────────────────────────────────

app.get('/api/news', (req, res) => {
  const sorted = [...newsCache].sort((a, b) => parseDate(b.datum) - parseDate(a.datum));
  res.json({ items: sorted, artikel: sorted, lastUpdated, count: sorted.length });
});

app.get('/api/article', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url fehlt' });
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 1500));
    const html = await page.content();
    await page.close();
    await b.close();

    const $ = cheerio.load(html);
    const titel = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
    let datum = '';
    const datumMatch = $('body').text().match(/(\d{2}\.\d{2}\.\d{4})/);
    if (datumMatch) datum = datumMatch[1];
    const bild = $('meta[property="og:image"]').attr('content') || $('article img, main img').first().attr('src') || '';
    const absaetze = [];
    $('article p, .article-content p, .news-content p, main p, .content p').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 40) absaetze.push(text);
    });
    if (absaetze.length === 0) {
      $('p').each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 40) absaetze.push(text);
      });
    }
    res.json({ titel, datum, bild, absaetze });
  } catch (err) {
    if (b) try { await b.close(); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tabelle', (req, res) => {
  res.json({ tabelle: tabelleCache, lastUpdated: tabelleLastUpdated });
});

app.get('/api/status', (req, res) => {
  res.json({
    dbAktiv: DB_AKTIV,
    dbBereit,
    loewen:  { count: newsCache.length, lastUpdated },
    tabelle: { count: tabelleCache.length, lastUpdated: tabelleLastUpdated }
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.post('/api/admin/reset', async (req, res) => {
  try {
    await leereDatenbank();
    newsCache    = [];
    tabelleCache = [];
    lastUpdated  = null;
    letzterNewsCount = 0;
    res.json({ ok: true, message: 'DB geleert. Vollscan startet...' });
    scrapeNewsVollscan();
    scrapeTabelle();
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    name:    'Loewen Frankfurt News API',
    version: '9.0.0',
    routes:  ['/api/news', '/api/article', '/api/tabelle', '/api/status', '/api/health']
  });
});

// ─────────────────────────────────────────────
// MARK: - Start
// ─────────────────────────────────────────────

async function startServer() {
  await initDB();
  await ladeNewsAusDB();
  await ladeTabelleAusDB();
  dbBereit = true;
  console.log('[START] DB bereit — starte Vollscan...');

  // Beim Start: alle Seiten scrapen
  scrapeNewsVollscan();
  scrapeTabelle();

  // Alle 5 Minuten: nur Seite 1 pruefen
  setInterval(() => { scrapeNewsSchnell(); }, 5 * 60 * 1000);

  // Tabelle alle 60 Minuten aktualisieren
  setInterval(() => { scrapeTabelle(); }, 60 * 60 * 1000);
}

startServer();

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[START] Server laeuft auf Port ${PORT}`);
});
