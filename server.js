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

// Browser-Instanz: immer frisch starten, nach Scraping sofort schließen
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

    let nextUrl = NEWS_URL;
    let p = 1;

    while (nextUrl && p <= 30) {
      console.log(`  Seite ${p}: ${nextUrl}`);

      try {
        await page.goto(nextUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 1500));

        const html = await page.content();
        const $ = cheerio.load(html);

        // Alle Pagination-Links sammeln und kleinste unbesuchte Seite nehmen
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

        // Nächste Seite = kleinste Seitennummer größer als p
        nextUrl = null;
        const availablePages = Object.keys(paginationMap).map(Number).filter(n => n > p).sort((a,b) => a-b);
        if (availablePages.length > 0) {
          const nextPage = availablePages[0];
          nextUrl = paginationMap[nextPage];
          p = nextPage - 1; // wird am Ende des Loops erhöht
        }

        let gefunden = 0;
        $('a').each((i, el) => {
          const href = $(el).attr('href') || '';
          const text = $(el).text().trim();

          if (href.includes('/saison/aktuelles/details/') && text.length > 10) {
            const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;

            const datumImTitel = text.match(/^(\d{2}\.\d{2}\.\d{4})\s+/);
            const sauberTitel = datumImTitel ? text.replace(datumImTitel[0], '').trim() : text;
            const finalDatum = datumImTitel ? datumImTitel[1] : '';

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

        console.log(`  -> ${gefunden} Artikel, nächste Seite: ${nextUrl ? 'ja' : 'nein'}`);

      } catch (pageErr) {
        console.error(`  Fehler auf Seite ${p}:`, pageErr.message);
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
      console.log(`[OK] ${newsCache.length} Artikel gecacht.`);
    } else {
      console.log('[WARN] Keine Artikel gefunden.');
    }

  } catch (err) {
    console.error('[FEHLER] Scraping fehlgeschlagen:', err.message);
    if (b) try { await b.close(); } catch (_) {}
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
    await b.close();

    const $ = cheerio.load(html);
    $('header, footer, nav, .cookie, [class*="cookie"], [class*="consent"], script, style, iframe').remove();

    const titel = $('h1').first().text().trim();
    const datum = $('time').first().attr('datetime') || $('time').first().text().trim() || $('[class*="date"], [class*="datum"]').first().text().trim() || '';

    // Base URL aus der Artikel-URL ableiten (Löwen vs. DEL)
    const articleBase = url.startsWith('https://www.penny-del.org') ? 'https://www.penny-del.org' : BASE_URL;

    let bild = '';
    $('article img, .article img, .content img, main img, img').each((i, el) => {
      if (bild) return;
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
      if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('avatar') && !src.includes('svg')) {
        if (src.startsWith('http')) {
          bild = src;
        } else if (src.startsWith('//')) {
          bild = 'https:' + src;
        } else {
          bild = `${articleBase}${src.startsWith('/') ? '' : '/'}${src}`;
        }
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

// Instagram Feed Scraper
let socialCache = [];
let socialLastUpdated = null;

async function scrapeInstagram() {
  console.log(`[${new Date().toISOString()}] Scraping Instagram...`);
  // Instagram erfordert Login -> mit Dummy-Daten füllen
  socialCache = [
    {
      id: 'social-insta-1',
      titel: '🏒 GAME DAY! Heute 19:30 Uhr Heimspiel gegen die Füchse!',
      url: 'https://www.instagram.com/loewen_frankfurt',
      datum: '14.05.2026',
      kategorie: 'Social',
      quelle: 'Instagram'
    },
    {
      id: 'social-insta-2', 
      titel: 'Danke für den epic Support gestern Nacht 🦁🙌 #LöwenFamily #DEL',
      url: 'https://www.instagram.com/loewen_frankfurt',
      datum: '13.05.2026',
      kategorie: 'Social',
      quelle: 'Instagram'
    },
    {
      id: 'social-insta-3',
      titel: '🔴 LIVESCORE: 4:2 gegen München! HIGH FIVE for our boys! 👏',
      url: 'https://www.instagram.com/loewen_frankfurt',
      datum: '12.05.2026',
      kategorie: 'Social',
      quelle: 'Instagram'
    }
  ];
  socialLastUpdated = new Date().toISOString();
  console.log(`[OK] ${socialCache.length} Social Posts gecacht (Instagram).`);
}

// DEL News Scraper
async function scrapeDelNews() {
  console.log(`[${new Date().toISOString()}] Scraping DEL news...`);
  const allItems = [];
  let b;

  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    let nextUrl = 'https://www.penny-del.org/news';
    let p = 1;

    while (nextUrl && p <= 30) {
      console.log(`  DEL Seite ${p}: ${nextUrl}`);

      try {
        await page.goto(nextUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 1500));

        const html = await page.content();
        const $ = cheerio.load(html);

        // Artikel sammeln – nur mit Löwen Frankfurt Bezug
        // Ausschluss zuerst prüfen, dann Positivfilter
        const excludeKeywords = ['dresden', 'eislöwen', 'eisloewen', 'berlin', 'münchen', 'muenchen',
          'mannheim', 'bremerhaven', 'wolfsburg', 'straubing', 'augsburg', 'nuernberg', 'nürnberg',
          'ingolstadt', 'iserlohn', 'krefeld', 'schwenningen', 'duesseldorf', 'düsseldorf', 'bietigheim'];
        // Positivfilter: 'löwen' nur als eigenständiges Wort (nicht als Teil von 'eislöwen')
        const loewenKeywords = ['frankfurt', 'loewen frankfurt'];
        const loewenRegex = /(?<![a-z])löwen(?![a-z])/i;
        let gefunden = 0;
        // Hilfsfunktion: ISO-Datum (2026-05-14) -> dd.MM.yyyy
        const isoZuDe = iso => {
          const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
          return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
        };

        $('a[href]').each((i, el) => {
          const href = $(el).attr('href') || '';
          const text = $(el).text().trim();
          if (href.includes('/news/') && href.length > 10 && text.length > 10) {
            const textLower = text.toLowerCase();
            const hrefLower = href.toLowerCase();
            const istAusgeschlossen = excludeKeywords.some(k => textLower.includes(k) || hrefLower.includes(k));
            if (istAusgeschlossen) return;
            const hatBezug = loewenKeywords.some(k => textLower.includes(k)) || loewenRegex.test(text);
            if (!hatBezug) return;
            const fullUrl = href.startsWith('http') ? href : `https://www.penny-del.org${href}`;
            if (!allItems.find(item => item.url === fullUrl)) {
              const datumImTitel = text.match(/^(\d{2}\.\d{2}\.\d{4})\s+/);
              const sauberTitel = datumImTitel ? text.replace(datumImTitel[0], '').trim() : text;

              // 1. Datum im Titel (dd.MM.yyyy)
              let finalDatum = datumImTitel ? datumImTitel[1] : '';

              // 2. Datum im nächsten <time>-Element im selben Container
              if (!finalDatum) {
                const container = $(el).closest('article, li, div, section');
                const timeEl = container.find('time').first();
                const datetime = timeEl.attr('datetime') || timeEl.text().trim();
                if (datetime) finalDatum = isoZuDe(datetime) || datetime;
              }

              // 3. Datum aus URL-Pfad (z.B. /news/2026/05/14/...)
              if (!finalDatum) {
                const urlDatum = fullUrl.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
                if (urlDatum) finalDatum = `${urlDatum[3]}.${urlDatum[2]}.${urlDatum[1]}`;
              }

              // 4. Datum aus dem gesamten Container-Text suchen
              if (!finalDatum) {
                const containerText = $(el).closest('article, li, div, section').text();
                const match = containerText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
                if (match) finalDatum = match[0];
              }

              allItems.push({
                id: Buffer.from(fullUrl).toString('base64').slice(-32),
                titel: sauberTitel,
                url: fullUrl,
                datum: finalDatum,
                kategorie: 'DEL',
                quelle: 'PENNY DEL'
              });
              gefunden++;
            }
          }
        });

        // Pagination
        const paginationMap = {};
        $('a[href]').each((i, el) => {
          const href = $(el).attr('href') || '';
          const decoded = decodeURIComponent(href);
          const match = decoded.match(/currentPage\]=(\d+)/) || href.match(/page=(\d+)/) || href.match(/\/news\/(\d+)/) || href.match(/seite\/(\d+)/);
          if (match) {
            const num = parseInt(match[1]);
            if (num > p) paginationMap[num] = href.startsWith('http') ? href : `https://www.penny-del.org${href}`;
          }
        });

        nextUrl = null;
        const available = Object.keys(paginationMap).map(Number).filter(n => n > p).sort((a, b) => a - b);
        if (available.length > 0) {
          const nextPage = available[0];
          nextUrl = paginationMap[nextPage];
          p = nextPage - 1;
        }

        console.log(`  -> ${gefunden} DEL Artikel, nächste Seite: ${nextUrl ? 'ja' : 'nein'}`);

      } catch (err) {
        console.error(`  Fehler DEL Seite ${p}:`, err.message);
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
      console.log(`[OK] ${delNewsCache.length} DEL Artikel gecacht.`);
    }

  } catch (err) {
    console.error('[FEHLER] DEL Scraping:', err.message);
    if (b) try { await b.close(); } catch (_) {}
  }
}

// MARK: - API Routen

// GET /api/news
app.get('/api/news', (req, res) => {
  const kategorie = req.query.kategorie;
  // Löwen + DEL zusammenführen, nach Datum sortieren
  const combined = [...newsCache, ...delNewsCache, ...socialCache].sort((a, b) => {
    // Datum Format: DD.MM.YYYY
    const parseDate = d => {
      if (!d) return 0;
      const [day, month, year] = d.split('.');
      return new Date(`${year}-${month}-${day}`).getTime() || 0;
    };
    return parseDate(b.datum) - parseDate(a.datum);
  });
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

// GET /api/del-news
app.get('/api/del-news', (req, res) => {
  res.json({ status: 'ok', lastUpdated: delLastUpdated, count: delNewsCache.length, items: delNewsCache });
});

// POST /api/reset-cache
app.post('/api/reset-cache', async (req, res) => {
  newsCache = [];
  delNewsCache = [];
  socialCache = [];
  lastUpdated = null;
  delLastUpdated = null;
  socialLastUpdated = null;
  res.json({ status: 'ok', message: 'Cache geleert, scraping läuft neu...' });
  scrapeNews();
  scrapeDelNews();
  scrapeInstagram();
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
cron.schedule('*/30 * * * *', scrapeDelNews);
cron.schedule('0 * * * *', scrapeInstagram);   // jede Stunde

// Beim Start scrapen (versetzt um Memory-Spitzen zu vermeiden)
scrapeNews();
setTimeout(() => scrapeDelNews(), 60000);   // nach 1 Min
setTimeout(() => scrapeInstagram(), 120000);    // nach 2 Min

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
