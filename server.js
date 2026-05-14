const express = require('express');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory Cache
let newsCache = [];
let lastUpdated = null;

const BASE_URL = 'https://www.loewen-frankfurt.de';
const NEWS_URL = `${BASE_URL}/saison/aktuelles`;

// Kategorie aus Titel ableiten
function kategorisiere(titel) {
  const t = titel.toLowerCase();
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

// Browser-Instanz wiederverwenden
let browser = null;
async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
  }
  return browser;
}

// Scraper mit Puppeteer
async function scrapeNews() {
  console.log(`[${new Date().toISOString()}] Scraping news mit Puppeteer...`);
  const allItems = [];
  let b;

  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    for (let p = 1; p <= 15; p++) {
      const url = p === 1 ? NEWS_URL : `${NEWS_URL}?page=${p}`;
      console.log(`  Seite ${p}: ${url}`);

      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
        // Kurz warten bis JS gerendert
        await new Promise(r => setTimeout(r, 1500));

        const html = await page.content();
        const $ = cheerio.load(html);

        let gefunden = 0;
        $('a').each((i, el) => {
          const href = $(el).attr('href') || '';
          const text = $(el).text().trim();

          if (href.includes('/saison/aktuelles/') && href.length > 20 && text.length > 10) {
            const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;

            const datumImTitel = text.match(/^(\d{2}\.\d{2}\.\d{4})\s+/);
            const sauberTitel = datumImTitel ? text.replace(datumImTitel[0], '').trim() : text;
            const finalDatum = datumImTitel ? datumImTitel[1] : '';

            if (sauberTitel.match(/^(Vorschau|Spielberichte|Team|Fans|Allgemein)\s*\(/)) return;

            if (!allItems.find(item => item.url === fullUrl)) {
              allItems.push({
                id: Buffer.from(fullUrl).toString('base64').slice(-32),
                titel: sauberTitel,
                url: fullUrl,
                datum: finalDatum,
                kategorie: kategorisiere(sauberTitel),
                quelle: 'Löwen Frankfurt'
              });
              gefunden++;
            }
          }
        });

        console.log(`  -> ${gefunden} neue Artikel auf Seite ${p}`);

        // Wenn keine neuen Artikel – aufhören
        if (gefunden === 0 && p > 1) {
          console.log('  Keine weiteren Artikel gefunden, stoppe.');
          break;
        }

      } catch (pageErr) {
        console.error(`  Fehler auf Seite ${p}:`, pageErr.message);
        break;
      }

      await new Promise(r => setTimeout(r, 800));
    }

    await page.close();

    if (allItems.length > 0) {
      newsCache = allItems.slice(0, 500);
      lastUpdated = new Date().toISOString();
      console.log(`[OK] ${newsCache.length} Artikel gecacht.`);
    } else {
      console.log('[WARN] Keine Artikel gefunden.');
    }

  } catch (err) {
    console.error('[FEHLER] Scraping fehlgeschlagen:', err.message);
    browser = null;
  }
}

// Artikel-Inhalt scrapen
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

    const $ = cheerio.load(html);
    $('header, footer, nav, .cookie, [class*="cookie"], [class*="consent"], script, style, iframe').remove();

    const titel = $('h1').first().text().trim();
    const datum = $('time').first().attr('datetime') || $('time').first().text().trim() || $('[class*="date"], [class*="datum"]').first().text().trim() || '';

    let bild = '';
    $('article img, .article img, .content img, main img').each((i, el) => {
      if (bild) return;
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('avatar')) {
        bild = src.startsWith('http') ? src : `${BASE_URL}${src}`;
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
    throw new Error(err.message);
  }
}

// MARK: - API Routen

// GET /api/news
app.get('/api/news', (req, res) => {
  const kategorie = req.query.kategorie;
  let items = newsCache;
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

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', lastUpdated, cachedItems: newsCache.length, uptime: process.uptime() });
});

// GET /
app.get('/', (req, res) => {
  res.json({
    name: 'Löwen Frankfurt News Server',
    version: '2.0.0',
    endpoints: ['GET /api/news', 'GET /api/article?url=...', 'GET /api/health']
  });
});

// Cron: Alle 30 Minuten
cron.schedule('*/30 * * * *', scrapeNews);

// Beim Start scrapen
scrapeNews();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
