const express = require('express');
const cheerio = require('cheerio');
const axios = require('axios');
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
      t.includes('heimspiel') || t.includes('auswärts')) return 'Vorschau';
  if (t.includes('sieg') || t.includes('niederlage') || t.includes('remis') ||
      t.includes('tore') || t.includes('gewinnt') || t.includes('verliert') ||
      t.includes('overtime') || t.includes('siegt') || t.includes('schlägt')) return 'Spielberichte';
  if (t.includes('transfer') || t.includes('verpflicht') || t.includes('wechsel') ||
      t.includes('neuzugang') || t.includes('verlängert') || t.includes('vertrag')) return 'Team';
  if (t.includes('fan') || t.includes('dauerkar') || t.includes('ticket') ||
      t.includes('saisonabschluss') || t.includes('feier')) return 'Fans';
  return 'Allgemein';
}

// Scraper Funktion
async function scrapeNews() {
  console.log(`[${new Date().toISOString()}] Scraping news...`);
  try {
    const allItems = [];

    // Erste 10 Seiten scrapen
    for (let page = 1; page <= 10; page++) {
      const url = page === 1 ? NEWS_URL : `${NEWS_URL}?page=${page}`;
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'de-DE,de;q=0.9'
        },
        timeout: 10000
      });

      const $ = cheerio.load(response.data);

      // Artikel-Links finden
      $('a').each((i, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim();

        // Nur News-Artikel URLs
        if (href.includes('/saison/aktuelles/') && href.length > 20 && text.length > 10) {
          const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;

          // Datum aus Eltern-Element suchen
          const parent = $(el).closest('article, .teaser, .news-item, li, div');
          const datumText = parent.find('time, .date, .datum').first().text().trim() ||
                           parent.text().match(/\d{2}\.\d{2}\.\d{4}/)?.[0] || '';

          // Datum aus Titel extrahieren falls vorhanden (z.B. "10.05.2026 Titel...")
          const datumImTitel = text.match(/^(\d{2}\.\d{2}\.\d{4})\s+/);
          const sauberTitel = datumImTitel ? text.replace(datumImTitel[0], '').trim() : text;
          const finalDatum = datumImTitel ? datumImTitel[1] : datumText;

          // Kategorie-Seiten überspringen (z.B. "Vorschau (153)")
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
          }
        }
      });

      // Kurz warten zwischen Requests
      await new Promise(r => setTimeout(r, 500));
    }

    // Fallback: Wenn keine Links gefunden, Texte parsen
    if (allItems.length === 0) {
      console.log('Keine Links gefunden, parse Text-Inhalte...');
      const response = await axios.get(NEWS_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const $ = cheerio.load(response.data);
      const mainText = $('main, #content, .content').text();
      const lines = mainText.split('\n').map(l => l.trim()).filter(l => l.length > 15);

      const datumRegex = /^(\d{2}\.\d{2}\.\d{4})$/;
      let currentDatum = '';

      lines.forEach(line => {
        if (datumRegex.test(line)) {
          currentDatum = line;
        } else if (line.length > 20 && currentDatum && !line.match(/^\d/) && line !== currentDatum) {
          allItems.push({
            id: Buffer.from(line).toString('base64').slice(0, 16),
            titel: line,
            url: NEWS_URL,
            datum: currentDatum,
            kategorie: kategorisiere(line),
            quelle: 'Löwen Frankfurt'
          });
          currentDatum = '';
        }
      });
    }

    if (allItems.length > 0) {
      newsCache = allItems.slice(0, 500);
      lastUpdated = new Date().toISOString();
      console.log(`[OK] ${newsCache.length} Artikel gecacht.`);
    } else {
      console.log('[WARN] Keine Artikel gefunden.');
    }

  } catch (err) {
    console.error('[FEHLER] Scraping fehlgeschlagen:', err.message);
  }
}

// MARK: - API Routen

// GET /api/news - Alle News
app.get('/api/news', (req, res) => {
  const kategorie = req.query.kategorie;
  let items = newsCache;
  if (kategorie && kategorie !== 'Alle') {
    items = items.filter(n => n.kategorie === kategorie);
  }
  res.json({
    status: 'ok',
    lastUpdated,
    count: items.length,
    items
  });
});

// GET /api/article?url=... - Artikel-Inhalt scrapen
app.get('/api/article', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url parameter fehlt' });

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);

    // Header/Footer/Nav entfernen
    $('header, footer, nav, .cookie, [class*="cookie"], [class*="consent"], script, style, iframe').remove();

    // Titel
    const titel =
      $('h1').first().text().trim() ||
      $('article h1, .article h1, .content h1').first().text().trim() ||
      $('title').text().trim();

    // Datum
    const datum =
      $('time').first().attr('datetime') ||
      $('time').first().text().trim() ||
      $('[class*="date"], [class*="datum"]').first().text().trim() ||
      '';

    // Bild (erstes großes Bild im Artikel)
    let bild = '';
    $('article img, .article img, .content img, main img').each((i, el) => {
      if (bild) return;
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('avatar')) {
        bild = src.startsWith('http') ? src : `${BASE_URL}${src}`;
      }
    });

    // Text-Absätze aus dem Artikel
    const absaetze = [];
    $('article p, .article p, .content p, main p').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 30) absaetze.push(text);
    });

    // Fallback: alle p Tags
    if (absaetze.length === 0) {
      $('p').each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 30) absaetze.push(text);
      });
    }

    res.json({
      status: 'ok',
      titel,
      datum,
      bild,
      absaetze,
      url
    });

  } catch (err) {
    console.error('[FEHLER] Article scraping:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health - Status
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    lastUpdated,
    cachedItems: newsCache.length,
    uptime: process.uptime()
  });
});

// GET / - Root
app.get('/', (req, res) => {
  res.json({
    name: 'Löwen Frankfurt News Server',
    version: '1.0.0',
    endpoints: [
      'GET /api/news',
      'GET /api/news?kategorie=Spielberichte',
      'GET /api/health'
    ]
  });
});

// Cron: Alle 30 Minuten scrapen
cron.schedule('*/30 * * * *', scrapeNews);

// Beim Start sofort einmal scrapen
scrapeNews();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
