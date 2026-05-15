const express = require('express');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');
const cron = require('node-cron');
const cors = require('cors');

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

const app = express();
app.use(cors());
app.use(express.json());

// In-memory Cache
let newsCache = [];
let lastUpdated = null;
let delNewsCache = [];
let delLastUpdated = null;
let presseCache = [];
let presseLastUpdated = null;
let tabelleCache = [];
let tabelleLastUpdated = null;

// Flags: wurde der initiale Vollscan schon gemacht?
let newsVollständigGeladen = false;
let delVollständigGeladen = false;

const BASE_URL = 'https://www.loewen-frankfurt.de';
const NEWS_URL = `${BASE_URL}/saison/aktuelles`;

// Kategorie aus Titel ableiten
function kategorisiere(titel) {
  const t = titel.toLowerCase();
  if (t.includes('presse') || t.includes('bild') || t.includes('fn') || t.includes('faz') || t.includes('aktuel')) return 'Presse';
  if (t.includes('vorschau') || t.includes('blick') || t.includes('zu gast') ||
      t.includes('heimspiel') || t.includes('auswaerts') || t.includes('auswärts')) return 'Vorschau';
  if (t.includes('sieg') || t.includes('niederlage') || t.includes('remis') ||
      t.includes('tore') || t.includes('gewinnt') || t.includes('verliert') ||
      t.includes('overtime') || t.includes('siegt') || t.includes('schlägt')) return 'Spielberichte';
  if (t.includes('transfer') || t.includes('verpflicht') || t.includes('wechsel') ||
      t.includes('neuzugang') || t.includes('verlängert') || t.includes('vertrag')) return 'Team';
  if (t.includes('fan') || t.includes('dauerkar') || t.includes('ticket') ||
      t.includes('saisonabschluss') || t.includes('feier')) return 'Fans';
  return 'Allgemein';
}

// Browser-Instanz
async function getBrowser() {
  return await puppeteer.launch({
    executablePath: CHROME_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--memory-pressure-off',
      '--max_old_space_size=256'
    ],
    headless: true
  });
}

// ─────────────────────────────────────────────
// MARK: - Löwen News Scraper
// ─────────────────────────────────────────────

// Hilfsfunktion: eine einzelne Seite scrapen und Artikel zurückgeben
async function scrapeNewsSeite(page, url) {
  const items = [];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 800));
  const html = await page.content();
  const $ = cheerio.load(html);

  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (href.includes('/saison/aktuelles/details/') && text.length > 10) {
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      const datumImTitel = text.match(/^(\d{2}\.\d{2}\.\d{4})\s+/);
      const sauberTitel = datumImTitel ? text.replace(datumImTitel[0], '').trim() : text;
      const finalDatum = datumImTitel ? datumImTitel[1] : '';
      items.push({
        id: Buffer.from(fullUrl).toString('base64').slice(-32),
        titel: sauberTitel,
        url: fullUrl,
        datum: finalDatum,
        kategorie: kategorisiere(sauberTitel),
        quelle: 'Löwen Frankfurt',
        quelletyp: 'loewen'
      });
    }
  });

  // Nächste Seite ermitteln
  const paginationMap = {};
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const decoded = decodeURIComponent(href);
    const match = decoded.match(/currentPage\]=(\d+)/);
    if (match) {
      const num = parseInt(match[1]);
      paginationMap[num] = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    }
  });

  return { items, paginationMap };
}

// Vollständiger Scan: alle Seiten (nur beim ersten Start)
async function scrapeNewsVollständig() {
  console.log(`[${new Date().toISOString()}] Löwen News: Vollscan startet...`);
  const allItems = [];
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    let nextUrl = NEWS_URL;
    let p = 1;

    while (nextUrl && p <= 30) {
      console.log(`  Seite ${p}: ${nextUrl}`);
      try {
        const { items, paginationMap } = await scrapeNewsSeite(page, nextUrl);
        for (const item of items) {
          if (!allItems.find(x => x.url === item.url)) allItems.push(item);
        }
        console.log(`  -> ${items.length} Artikel`);

        nextUrl = null;
        const available = Object.keys(paginationMap).map(Number).filter(n => n > p).sort((a, b) => a - b);
        if (available.length > 0) {
          nextUrl = paginationMap[available[0]];
          p = available[0] - 1;
        }
      } catch (e) {
        console.error(`  Fehler Seite ${p}:`, e.message);
        break;
      }
      p++;
      await new Promise(r => setTimeout(r, 800));
    }

    await page.close();
    await b.close();

    if (allItems.length > 0) {
      newsCache = allItems.slice(0, 500);
      lastUpdated = new Date().toISOString();
      newsVollständigGeladen = true;
      console.log(`[OK] Löwen News Vollscan: ${newsCache.length} Artikel gecacht.`);
    }
  } catch (err) {
    console.error('[FEHLER] Löwen News Vollscan:', err.message);
    if (b) try { await b.close(); } catch (_) {}
  }
}

// Schnell-Update: nur Seite 1, neue Artikel vorne einfügen
async function scrapeNewsUpdate() {
  if (!newsVollständigGeladen) {
    console.log('[INFO] Löwen News: Vollscan noch nicht fertig, überspringe Update.');
    return;
  }
  console.log(`[${new Date().toISOString()}] Löwen News: Seite-1-Update...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    const { items } = await scrapeNewsSeite(page, NEWS_URL);
    await page.close();
    await b.close();

    let neu = 0;
    for (const item of items) {
      if (!newsCache.find(x => x.url === item.url)) {
        newsCache.unshift(item);
        neu++;
      }
    }
    lastUpdated = new Date().toISOString();
    console.log(`[OK] Löwen News Update: ${neu} neue Artikel.`);
  } catch (err) {
    console.error('[FEHLER] Löwen News Update:', err.message);
    if (b) try { await b.close(); } catch (_) {}
  }
}

// ─────────────────────────────────────────────
// MARK: - DEL News Scraper
// ─────────────────────────────────────────────

const DEL_NEWS_URL = 'https://www.penny-del.org/news';
const excludeKeywords = ['dresden', 'eislöwen', 'eisloewen', 'berlin', 'münchen', 'muenchen',
  'mannheim', 'bremerhaven', 'wolfsburg', 'straubing', 'augsburg', 'nuernberg', 'nürnberg',
  'ingolstadt', 'iserlohn', 'krefeld', 'schwenningen', 'duesseldorf', 'düsseldorf', 'bietigheim'];
const loewenKeywords = ['frankfurt', 'loewen frankfurt'];
const loewenRegex = /(?<![a-z])löwen(?![a-z])/i;

const isoZuDe = iso => {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};

async function scrapeDelSeite(page, url) {
  const items = [];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 800));
  const html = await page.content();
  const $ = cheerio.load(html);

  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (href.includes('/news/') && href.length > 10 && text.length > 10) {
      const textLower = text.toLowerCase();
      const hrefLower = href.toLowerCase();
      if (excludeKeywords.some(k => textLower.includes(k) || hrefLower.includes(k))) return;
      if (!loewenKeywords.some(k => textLower.includes(k)) && !loewenRegex.test(text)) return;
      const fullUrl = href.startsWith('http') ? href : `https://www.penny-del.org${href}`;
      const datumImTitel = text.match(/^(\d{2}\.\d{2}\.\d{4})\s+/);
      const sauberTitel = datumImTitel ? text.replace(datumImTitel[0], '').trim() : text;
      let finalDatum = datumImTitel ? datumImTitel[1] : '';
      if (!finalDatum) {
        const container = $(el).closest('article, li, div, section');
        const timeEl = container.find('time').first();
        const datetime = timeEl.attr('datetime') || timeEl.text().trim();
        if (datetime) finalDatum = isoZuDe(datetime) || datetime;
      }
      if (!finalDatum) {
        const urlDatum = fullUrl.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
        if (urlDatum) finalDatum = `${urlDatum[3]}.${urlDatum[2]}.${urlDatum[1]}`;
      }
      items.push({
        id: Buffer.from(fullUrl).toString('base64').slice(-32),
        titel: sauberTitel,
        url: fullUrl,
        datum: finalDatum,
        kategorie: 'DEL',
        quelle: 'PENNY DEL',
        quelletyp: 'del'
      });
    }
  });

  const paginationMap = {};
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const decoded = decodeURIComponent(href);
    const match = decoded.match(/currentPage\]=(\d+)/) || href.match(/page=(\d+)/) || href.match(/\/news\/(\d+)/) || href.match(/seite\/(\d+)/);
    if (match) {
      const num = parseInt(match[1]);
      paginationMap[num] = href.startsWith('http') ? href : `https://www.penny-del.org${href}`;
    }
  });

  return { items, paginationMap };
}

async function scrapeDelVollständig() {
  console.log(`[${new Date().toISOString()}] DEL News: Vollscan startet...`);
  const allItems = [];
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    let nextUrl = DEL_NEWS_URL;
    let p = 1;

    while (nextUrl && p <= 30) {
      console.log(`  DEL Seite ${p}: ${nextUrl}`);
      try {
        const { items, paginationMap } = await scrapeDelSeite(page, nextUrl);
        for (const item of items) {
          if (!allItems.find(x => x.url === item.url)) allItems.push(item);
        }
        console.log(`  -> ${items.length} DEL Artikel`);

        nextUrl = null;
        const available = Object.keys(paginationMap).map(Number).filter(n => n > p).sort((a, b) => a - b);
        if (available.length > 0) {
          nextUrl = paginationMap[available[0]];
          p = available[0] - 1;
        }
      } catch (e) {
        console.error(`  Fehler DEL Seite ${p}:`, e.message);
        break;
      }
      p++;
      await new Promise(r => setTimeout(r, 800));
    }

    await page.close();
    await b.close();

    if (allItems.length > 0) {
      delNewsCache = allItems.slice(0, 500);
      delLastUpdated = new Date().toISOString();
      delVollständigGeladen = true;
      console.log(`[OK] DEL News Vollscan: ${delNewsCache.length} Artikel gecacht.`);
    }
  } catch (err) {
    console.error('[FEHLER] DEL News Vollscan:', err.message);
    if (b) try { await b.close(); } catch (_) {}
  }
}

async function scrapeDelUpdate() {
  if (!delVollständigGeladen) {
    console.log('[INFO] DEL News: Vollscan noch nicht fertig, überspringe Update.');
    return;
  }
  console.log(`[${new Date().toISOString()}] DEL News: Seite-1-Update...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    const { items } = await scrapeDelSeite(page, DEL_NEWS_URL);
    await page.close();
    await b.close();

    let neu = 0;
    for (const item of items) {
      if (!delNewsCache.find(x => x.url === item.url)) {
        delNewsCache.unshift(item);
        neu++;
      }
    }
    delLastUpdated = new Date().toISOString();
    console.log(`[OK] DEL News Update: ${neu} neue Artikel.`);
  } catch (err) {
    console.error('[FEHLER] DEL News Update:', err.message);
    if (b) try { await b.close(); } catch (_) {}
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
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    await page.goto('https://www.penny-del.org/tabelle', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const html = await page.content();
    const $ = cheerio.load(html);

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
      const tore      = $(cols[8]).text().trim() || '0:0';
      const toreParts = tore.split(':');
      const torePlus  = parseInt(toreParts[0]) || 0;
      const toreMinus = parseInt(toreParts[1]) || 0;
      if (!team || team.length < 2) return;
      eintraege.push({
        rang, team, spiele, siege, otSiege,
        otNiederlagen: otNied, niederlagen: nieder,
        torePlus, toreMinus, punkte,
        istEigenesMannschaft: team.toLowerCase().includes('frankfurt')
      });
    });

    if (eintraege.length >= 10) {
      tabelleCache = eintraege;
      tabelleLastUpdated = new Date().toISOString();
      console.log(`[OK] DEL Tabelle: ${eintraege.length} Teams gecacht.`);
    } else {
      console.warn(`[WARN] Tabelle: nur ${eintraege.length} Einträge — Cache nicht aktualisiert.`);
    }
  } catch (err) {
    console.error('[FEHLER] Tabelle Scraping:', err.message);
  } finally {
    if (b) try { await b.close(); } catch (_) {}
  }
}

// ─────────────────────────────────────────────
// MARK: - Artikel-Inhalt Scraper
// ─────────────────────────────────────────────

async function scrapeArticle(url) {
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1000));
    const html = await page.content();
    await page.close();
    await b.close();
    const $ = cheerio.load(html);
    $('header, footer, nav, .cookie, [class*="cookie"], [class*="consent"], script, style, iframe').remove();
    const titel = $('h1').first().text().trim();
    const datum = $('time').first().attr('datetime') || $('time').first().text().trim() || $('[class*="date"], [class*="datum"]').first().text().trim() || '';
    const articleBase = url.startsWith('https://www.penny-del.org') ? 'https://www.penny-del.org' : BASE_URL;
    let bild = '';
    $('article img, .article img, .content img, main img, img').each((i, el) => {
      if (bild) return;
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
      if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('avatar') && !src.includes('svg')) {
        bild = src.startsWith('http') ? src : src.startsWith('//') ? 'https:' + src : `${articleBase}${src.startsWith('/') ? '' : '/'}${src}`;
      }
    });
    const absaetze = [];
    $('article p, .article p, .content p, main p').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 30) absaetze.push(text);
    });
    if (absaetze.length === 0) {
      $('p').each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 30) absaetze.push(text);
      });
    }
    return { titel, datum, bild, absaetze, url };
  } catch (err) {
    if (b) try { await b.close(); } catch (_) {}
    throw new Error(err.message);
  }
}

// ─────────────────────────────────────────────
// MARK: - Presse (Platzhalter)
// ─────────────────────────────────────────────

async function scrapePresse() {
  presseCache = [];
  presseLastUpdated = new Date().toISOString();
  console.log('[INFO] Presse: bald verfügbar.');
}

// ─────────────────────────────────────────────
// MARK: - API Routen
// ─────────────────────────────────────────────

const parseDate = d => {
  if (!d) return 0;
  const [day, month, year] = d.split('.');
  return new Date(`${year}-${month}-${day}`).getTime() || 0;
};

// GET /api/news
app.get('/api/news', (req, res) => {
  const kategorie = req.query.kategorie;
  const combined = [...newsCache, ...delNewsCache, ...presseCache]
    .sort((a, b) => parseDate(b.datum) - parseDate(a.datum));
  let items = combined;
  if (kategorie && kategorie !== 'Alle') {
    items = items.filter(n => n.kategorie === kategorie);
  }
  res.json({ status: 'ok', lastUpdated, count: items.length, items });
});

// GET /api/article?url=...
app.get('/api/article', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url parameter fehlt' });
  try {
    const article = await scrapeArticle(url);
    res.json({ status: 'ok', ...article });
  } catch (err) {
    console.error('[FEHLER] Article scraping:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tabelle
app.get('/api/tabelle', (req, res) => {
  res.json({ status: 'ok', lastUpdated: tabelleLastUpdated, count: tabelleCache.length, tabelle: tabelleCache });
});

// GET /api/del-news
app.get('/api/del-news', (req, res) => {
  res.json({ status: 'ok', lastUpdated: delLastUpdated, count: delNewsCache.length, items: delNewsCache });
});

// POST /api/reset-cache
app.post('/api/reset-cache', async (req, res) => {
  newsCache = [];
  delNewsCache = [];
  presseCache = [];
  lastUpdated = null;
  delLastUpdated = null;
  presseLastUpdated = null;
  newsVollständigGeladen = false;
  delVollständigGeladen = false;
  res.json({ status: 'ok', message: 'Cache geleert, Vollscan läuft neu...' });
  scrapeNewsVollständig();
  setTimeout(() => scrapeDelVollständig(), 60000);
  setTimeout(() => scrapePresse(), 120000);
  setTimeout(() => scrapeTabelle(), 180000);
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    lastUpdated,
    cachedItems: newsCache.length,
    delItems: delNewsCache.length,
    tabelleItems: tabelleCache.length,
    newsVollständigGeladen,
    delVollständigGeladen,
    uptime: process.uptime()
  });
});

// GET /
app.get('/', (req, res) => {
  res.json({
    name: 'Löwen Frankfurt News Server',
    version: '3.0.0',
    endpoints: [
      'GET /api/news',
      'GET /api/article?url=...',
      'GET /api/tabelle',
      'GET /api/del-news',
      'GET /api/health',
      'POST /api/reset-cache'
    ]
  });
});

// ─────────────────────────────────────────────
// MARK: - Cron Jobs
// ─────────────────────────────────────────────

// Alle 5 Minuten: nur Seite 1 aktualisieren
cron.schedule('*/5 * * * *', scrapeNewsUpdate);
cron.schedule('*/5 * * * *', scrapeDelUpdate);

// Alle 15 Minuten: Tabelle aktualisieren
cron.schedule('*/15 * * * *', scrapeTabelle);

// ─────────────────────────────────────────────
// MARK: - Startup (versetzt, um Memory-Spitzen zu vermeiden)
// ─────────────────────────────────────────────

// Vollscan beim ersten Start
scrapeNewsVollständig();
setTimeout(() => scrapeDelVollständig(), 90000);  // nach 1,5 Min
setTimeout(() => scrapePresse(), 180000);          // nach 3 Min
setTimeout(() => scrapeTabelle(), 240000);         // nach 4 Min

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server v3.0 läuft auf Port ${PORT}`);
  console.log('Strategie: Vollscan beim Start, dann Seite-1-Updates alle 5 Min.');
});
