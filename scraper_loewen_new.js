// Löwen News Scraper - komplett neu mit Kategorie-URLs
// Ersetzt die alten Funktionen scrapeNewsSeite, scrapeNewsVollscanInternal, scrapeNewsUpdate

async function scrapeNewsKategorie(page, kategorie, url) {
  const items = [];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 800));
  const html = await page.content();
  const $ = cheerio.load(html);

  // Textinhalte sammeln: Datum + Titel treten in Reihenfolge auf
  const textContent = $('body').text().trim();
  const lines = textContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const datumMatch = line.match(/^(\d{2}\.\d{2}\.\d{4})$/);
    if (!datumMatch) continue;
    
    const datum = datumMatch[1];
    const titel = lines[i + 1];
    
    // Überspringen wenn es eine Kategorie-Navigation ist
    if (titel.includes('Vorschau') || titel.includes('Spielberichte') || 
        titel.includes('Team') || titel.includes('Fans') || 
        titel === '1' || titel === '2' || titel === 'n채chste' || titel === 'nVchste') continue;
    
    // Title muss mindestens 10 Zeichen haben
    if (titel.length < 10) continue;
    
    // URL generieren (URL muss eindeutig sein)
    const slug = titel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    const fullUrl = `${BASE_URL}/saison/aktuelles/details/${slug}`;
    
    items.push({
      id:        Buffer.from(fullUrl).toString('base64').slice(-32),
      titel:     titel,
      url:       fullUrl,
      datum:     datum,
      kategorie: kategorie,
      quelle:    'Lчwen Frankfurt',
      quelletyp: 'loewen',
      bildUrl:   ''
    });
  }
  return items;
}

// Vollscan: alle 4 Kategorien beim ersten Start
async function scrapeNewsVollscanInternal() {
  console.log(`[${new Date().toISOString()}] Lчwen News: Vollscan (alle 4 Kategorien)...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    let gesamtNeu = 0;
    
    for (const [kat, katUrl] of Object.entries(KATEGORIEN_URL)) {
      console.log(`  Scrape Kategorie: ${kat}`);
      try {
        const items = await scrapeNewsKategorie(page, kat, katUrl);
        const neu = await speichereNewsInDB(items);
        gesamtNeu += neu;
        const neuItems = items.filter(x => !newsCache.find(c => c.url === x.url));
        newsCache = [...neuItems, ...newsCache];
        console.log(`    ✓ ${items.length} Artikel gefunden, ${neu} neu`);
      } catch(e) {
        console.error(`    [ERROR] ${kat}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    
    await page.close(); await b.close();
    lastUpdated = new Date().toISOString();
    console.log(`[OK] Lчwen Vollscan abgeschlossen: ${gesamtNeu} neue Artikel.`);
  } catch(err) {
    console.error('[FEHLER] Lчwen Vollscan:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

// Update: nur Seite 1 der "alle"-Kategorie
async function scrapeNewsUpdate() {
  // Beim ersten Start: Vollscan wenn DB leer
  if (!DB_AKTIV && newsCache.length === 0) {
    console.log(`[${new Date().toISOString()}] Lчwen News: Vollscan (alle 4 Kategorien) — DB leer beim ersten Start...`);
    await scrapeNewsVollscanInternal();
  } else if (DB_AKTIV) {
    const count = await pool.query("SELECT COUNT(*) FROM news WHERE quelletyp='loewen'");
    if (parseInt(count.rows[0].count) === 0) {
      console.log(`[${new Date().toISOString()}] Lчwen News: Vollscan (alle 4 Kategorien) — DB leer beim ersten Start...`);
      await scrapeNewsVollscanInternal();
    }
  }
  
  console.log(`[${new Date().toISOString()}] Lчwen News: Update (Seite 1)...`);
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    
    // Nur die "alle"-Kategorie updaten ( Actualités-Hauptseite)
    const items = await scrapeNewsKategorie(page, 'Allgemein', NEWS_URL);
    const neu = await speichereNewsInDB(items);
    const neuItems = items.filter(x => !newsCache.find(c => c.url === x.url));
    newsCache = [...neuItems, ...newsCache];
    
    await page.close(); await b.close();
    lastUpdated = new Date().toISOString();
    console.log(`[OK] Lчwen Update abgeschlossen: ${neu} neue Artikel.`);
  } catch(err) {
    console.error('[FEHLER] Lчwen Update:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}
