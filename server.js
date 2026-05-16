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
    id:        r.id,
    titel:     r.titel,
    url:       r.url,
    datum:     r.datum,
    kategorie: r.kategorie,
    quelle:    r.quelle,
    quelletyp: r.quelletyp,
    bildUrl:   r.bild_url || ''
  }));
  console.log(`[DB] ${newsCache.length} Löwen Artikel geladen.`);
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
    console.log(`[DB] ${tabelleCache.length} Tabelleneinträge geladen.`);
  }
}

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

// ─────────────────────────────────────────────
// MARK: - Hilfsfunktionen
// ─────────────────────────────────────────────

const BASE_URL = 'https://www.loewen-frankfurt.de';
const NEWS_URL = `${BASE_URL}/saison/aktuelles`;
const KATEGORIEN_URL = {
  'Vorschau':      `${BASE_URL}/saison/aktuelles/vorschau`,
  'Spielberichte': `${BASE_URL}/saison/aktuelles/spielberichte`,
  'Team':          `${BASE_URL}/saison/aktuelles/team`,
  'Fans':          `${BASE_URL}/saison/aktuelles/fans`
};

function kategorisiere(titel, katTag) {
  // 1. Priorität: Kategorie direkt von der Website (z.B. aus dem Tag-Element)
  if (katTag) {
    const k = katTag.trim().toLowerCase();
    if (k === 'team')          return 'Team';
    if (k === 'spielberichte') return 'Spielberichte';
    if (k === 'vorschau')      return 'Vorschau';
    if (k === 'fans')          return 'Fans';
  }
  // 2. Fallback: Titelbasierte Erkennung
  const t = titel.toLowerCase();
  if (t.includes('vorschau') || t.includes('heimspiel') || t.includes('auswärts')) return 'Vorschau';
  if (t.includes('sieg') || t.includes('niederlage') || t.includes('tore') ||
      t.includes('gewinnt') || t.includes('verliert') || t.includes('siegt') ||
      t.includes('0:') || t.includes('1:') || t.includes('2:') || t.includes('3:') ||
      t.includes('4:') || t.includes('5:') || t.includes('6:') || t.includes('7:')) return 'Spielberichte';
  if (t.includes('transfer') || t.includes('verpflicht') || t.includes('neuzugang') ||
      t.includes('verlängert') || t.includes('vertrag') || t.includes('löwe') ||
      t.includes('wechselt') || t.includes('wird ein') || t.includes('kehrt zurück') ||
      t.includes('unterschreibt') || t.includes('kapitän') || t.includes('coach') ||
      t.includes('trainer')) return 'Team';
  if (t.includes('fan') || t.includes('dauerkar') || t.includes('ticket') ||
      t.includes('merchandise') || t.includes('shop') || t.includes('gewinnspiel')) return 'Fans';
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

const parseDate = d => {
  if (!d) return 0;
  const [day, month, year] = d.split('.');
  return new Date(`${year}-${month}-${day}`).getTime() || 0;
};

// ─────────────────────────────────────────────
// MARK: - Löwen News Scraper
// ─────────────────────────────────────────────

async function scrapeNewsKategorie(page, kategorie, url) {
  const items = [];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 1500));
  const html = await page.content();
  const $ = cheerio.load(html);

  // Alle Links die auf /saison/aktuelles/details/ zeigen
  $('a[href*="/saison/aktuelles/"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('/saison/aktuelles/') || href === '/saison/aktuelles') return;
    // Nur Detail-Links, keine Kategorie-Links
    const skipPaths = ['/vorschau', '/spielberichte', '/team', '/fans', '/aktuelles'];
    if (skipPaths.some(p => href.endsWith(p) || href === '/saison/aktuelles' + p)) return;

    const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    if (items.find(x => x.url === fullUrl)) return; // Duplikat

    // Titel aus Link-Text oder Kind-Elementen holen
    let titel = $(el).find('h2, h3, h4, .title, .headline, [class*="title"], [class*="headline"]').first().text().trim();
    if (!titel) titel = $(el).clone().children().remove().end().text().trim();
    if (!titel) titel = $(el).text().trim();
    titel = titel.replace(/\s+/g, ' ').trim();
    if (titel.length < 8) return;

    // Datum aus Link oder Eltern-Container
    let datum = '';
    const container = $(el).closest('article, li, div');
    const containerText = container.text();
    const datumMatch = containerText.match(/(\d{2}\.\d{2}\.\d{4})/);
    if (datumMatch) datum = datumMatch[1];

    items.push({
      id:        Buffer.from(fullUrl).toString('base64').slice(-32),
      titel:     titel,
      url:       fullUrl,
      datum:     datum,
      kategorie: kategorie,
      quelle:    'L\u00f6wen Frankfurt',
      quelletyp: 'loewen',
      bildUrl:   ''
    });
  });

  console.log(`    [${kategorie}] ${items.length} Artikel auf ${url}`);
  return items;
}

async function scrapeNewsVollscanInternal() {
  console.log(`[${new Date().toISOString()}] Löwen News: Vollscan (alle 4 Kategorien)...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    let gesamtNeu = 0;
    for (const [kat, katUrl] of Object.entries(KATEGORIEN_URL)) {
      console.log(`  Kategorie: ${kat} → ${katUrl}`);
      try {
        const items = await scrapeNewsKategorie(page, kat, katUrl);
        const neu = await speichereNewsInDB(items);
        gesamtNeu += neu;
        const neuItems = items.filter(x => !newsCache.find(c => c.url === x.url));
        newsCache = [...neuItems, ...newsCache];
        console.log(`    ✓ ${items.length} gefunden, ${neu} neu`);
      } catch(e) {
        console.error(`  [FEHLER] ${kat}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    await page.close(); await b.close();
    lastUpdated = new Date().toISOString();
    console.log(`[OK] Löwen Vollscan: ${gesamtNeu} neue Artikel.`);
  } catch(err) {
    console.error('[FEHLER] Löwen Vollscan:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

async function scrapeNewsUpdate() {
  if (!DB_AKTIV && newsCache.length === 0) {
    await scrapeNewsVollscanInternal();
  } else if (DB_AKTIV) {
    const count = await pool.query("SELECT COUNT(*) FROM news WHERE quelletyp='loewen'");
    if (parseInt(count.rows[0].count) === 0) {
      await scrapeNewsVollscanInternal();
      return;
    }
  }
  console.log(`[${new Date().toISOString()}] Löwen News: Update (Seite 1)...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    const items = await scrapeNewsKategorie(page, 'Allgemein', NEWS_URL);
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
// MARK: - Tabellen-Scraper
// ─────────────────────────────────────────────

async function scrapeTabelle() {
  console.log(`[${new Date().toISOString()}] Scraping DEL Tabelle...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto('https://www.penny-del.org/tabelle/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    const $ = cheerio.load(await page.content());
    const eintraege = [];
    $('table tbody tr, .standings tbody tr, .table-wrapper tbody tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 6) return;
      const getText = idx => $(cells[idx]).text().trim().replace(/[\n\r\t]+/g, ' ');
      const toInt   = v  => parseInt(v.replace(/[^\d-]/g, '')) || 0;
      const rang    = i + 1;
      const team    = getText(1) || getText(0);
      const punkte  = toInt(getText(cells.length - 1));
      const spiele  = toInt(getText(2));
      if (!team || team.length < 2) return;
      eintraege.push({
        rang,
        team:                team,
        spiele:              spiele,
        siege:               toInt(getText(3)),
        otSiege:             toInt(getText(4)),
        otNiederlagen:       toInt(getText(5)),
        niederlagen:         toInt(getText(6)),
        torePlus:            0,
        toreMinus:           0,
        punkte:              punkte,
        istEigenesMannschaft: team.toLowerCase().includes('löwen frankfurt')
      });
    });
    await page.close(); await b.close();
    if (eintraege.length >= 8) {
      tabelleCache = eintraege;
      tabelleLastUpdated = new Date().toISOString();
      await speichereTabelleInDB(eintraege);
      console.log(`[OK] Tabelle: ${eintraege.length} Teams gespeichert.`);
    } else {
      console.log(`[WARN] Tabelle: Nur ${eintraege.length} Teams gefunden — verwerfe Ergebnis.`);
    }
  } catch(err) {
    console.error('[FEHLER] Tabelle:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

// ─────────────────────────────────────────────
// MARK: - Artikel-Detail Scraper
// ─────────────────────────────────────────────

async function scrapeArtikelDetail(url) {
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(r => setTimeout(r, 800));
    const $ = cheerio.load(await page.content());
    let bildUrl = '';
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) bildUrl = ogImage;
    else {
      const img = $('article img, .news-detail img, .content img').first();
      if (img.length) bildUrl = img.attr('src') || img.attr('data-src') || '';
    }
    let inhalt = '';
    const artikelEl = $('article .field--type-text-with-summary, article .field--name-body, .news-text, .article-body').first();
    if (artikelEl.length) inhalt = artikelEl.text().trim().replace(/\s+/g, ' ');
    await page.close(); await b.close();
    return { bildUrl, inhalt };
  } catch(err) {
    console.error('[FEHLER] Artikel-Detail:', err.message);
    if (b) try { await b.close(); } catch(_) {}
    return { bildUrl: '', inhalt: '' };
  }
}

// ─────────────────────────────────────────────
// MARK: - API Routen
// ─────────────────────────────────────────────

app.get('/api/news', (req, res) => {
  const sorted = [...newsCache].sort((a, b) => parseDate(b.datum) - parseDate(a.datum));
  // "items" UND "artikel" — beide Keys für Kompatibilität mit der App
  res.json({ items: sorted, artikel: sorted, lastUpdated, count: sorted.length });
});

app.get('/api/article', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url fehlt' });
  try {
    const detail = await scrapeArtikelDetail(url);
    res.json(detail);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tabelle', (req, res) => {
  res.json({ tabelle: tabelleCache, lastUpdated: tabelleLastUpdated });
});

app.get('/api/status', (req, res) => {
  res.json({
    dbAktiv:       DB_AKTIV,
    dbBereit,
    loewen:        { count: newsCache.length,   lastUpdated },
    tabelle:       { count: tabelleCache.length, lastUpdated: tabelleLastUpdated }
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.post('/api/admin/reset', async (req, res) => {
  try {
    await leereDatenbank();
    newsCache = [];
    tabelleCache = [];
    lastUpdated = null;
    res.json({ ok: true, message: 'DB geleert. Vollscan startet im Hintergrund...' });
    scrapeNewsUpdate();
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    name:    'Löwen Frankfurt News API',
    version: '7.0.0',
    routes:  ['/api/news', '/api/article?url=...', '/api/tabelle', '/api/status', '/api/health']
  });
});

// ─────────────────────────────────────────────
// MARK: - Cron Jobs
// ─────────────────────────────────────────────

cron.schedule('*/5 * * * *',  scrapeNewsUpdate);  // Löwen Seite 1 alle 5 Min
cron.schedule('*/15 * * * *', scrapeTabelle);     // Tabelle alle 15 Min

// ─────────────────────────────────────────────
// MARK: - Startup
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`[START] Server läuft auf Port ${PORT}`);
  try {
    await initDB();
    await ladeNewsAusDB();
    await ladeTabelleAusDB();
    dbBereit = true;
    console.log('[START] DB bereit — starte Scraper...');
  } catch(e) {
    console.error('[FEHLER] DB-Init:', e.message);
    dbBereit = true;
  }
  setTimeout(() => scrapeNewsUpdate(), 5000);   // Löwen: nach 5 Sek (Vollscan bei DB leer, sonst Seite-1)
  setTimeout(() => scrapeTabelle(),      30000);  // Tabelle: nach 30 Sek

  // Cron: Löwen Update alle 5 Minuten
  cron.schedule('*/5 * * * *', async () => {
    if (dbBereit) await scrapeNewsUpdate();
  });
});
