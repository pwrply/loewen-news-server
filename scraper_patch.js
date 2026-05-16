// SCHNELLER FIX: Löwen-Scraper mit Kategorie-URLs
// Ersetze die Zeilen 210-330 in server.js mit diesem Code

async function scrapeNewsKategorie(page, kategorie, url) {
  const items = [];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 800));
  const html = await page.content();
  const $ = cheerio.load(html);

  const textContent = $('body').text().trim();
  const lines = textContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const datumMatch = line.match(/^(\d{2}\.\d{2}\.\d{4})$/);
    if (!datumMatch) continue;
    
    const datum = datumMatch[1];
    const titel = lines[i + 1];
    
    if (titel.includes('Vorschau') || titel.includes('Spielberichte') || 
        titel.includes('Team') || titel.includes('Fans') || 
        titel === '1' || titel === '2') continue;
    
    if (titel.length < 10) continue;
    
    const slug = titel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    const fullUrl = BASE_URL + '/saison/aktuelles/details/' + slug;
    
    items.push({
      id:        Buffer.from(fullUrl).toString('base64').slice(-32),
      titel:     titel,
      url:       fullUrl,
      datum:     datum,
      kategorie: kategorie,
      quelle:    'Lö¬¬¬ hen Frankfurt',
      quelletyp: 'loewen',
      bildUrl:   ''
    });
  }
  return items;
}

async function scrapeNewsVollscanInternal() {
  console.log('[LOEWEN] Vollscan: alle 4 Kategorien...');
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0');
    let gesamtNeu = 0;
    
    for (const [kat, katUrl] of Object.entries(KATEGORIEN_URL)) {
      console.log('  ' + kat + ': ' + katUrl);
      const items = await scrapeNewsKategorie(page, kat, katUrl);
      const neu = await speichereNewsInDB(items);
      gesamtNeu += neu;
      const neuItems = items.filter(x => !newsCache.find(c => c.url === x.url));
      newsCache = [...neuItems, ...newsCache];
      console.log('    ' + items.length + ' Artikel, ' + neu + ' neu');
      await new Promise(r => setTimeout(r, 1000));
    }
    
    await page.close(); await b.close();
    lastUpdated = new Date().toISOString();
    console.log('[OK] Vollscan: ' + gesamtNeu + ' neue Artikel.');
  } catch(err) {
    console.error('[FEHLER] Vollscan:', err.message);
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
    }
  }
  
  console.log('[LOEWEN] Update...');
  let b;
  try {
    b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0');
    
    const items = await scrapeNewsKategorie(page, 'Allgemein', NEWS_URL);
    const neu = await speichereNewsInDB(items);
    const neuItems = items.filter(x => !newsCache.find(c => c.url === x.url));
    newsCache = [...neuItems, ...newsCache];
    
    await page.close(); await b.close();
    lastUpdated = new Date().toISOString();
    console.log('[OK] Update: ' + neu + ' neue Artikel.');
  } catch(err) {
    console.error('[FEHLER] Update:', err.message);
    if (b) try { await b.close(); } catch(_) {}
  }
}

// KATEGORIEN_URL muss oben definiert sein:
// const KATEGORIEN_URL = {
//   'Vorschau':      BASE_URL + '/saison/aktuelles/vorschau',
//   'Spielberichte': BASE_URL + '/saison/aktuelles/spielberichte',
//   'Team':          BASE_URL + '/saison/aktuelles/team',
//   'Fans':          BASE_URL + '/saison/aktuelles/fans'
// };
