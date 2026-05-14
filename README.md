# Löwen Frankfurt News Server

Scraper-Backend für die ClubApp. Läuft auf Railway und liefert News von loewen-frankfurt.de als JSON.

## API

- `GET /api/news` — Alle News
- `GET /api/news?kategorie=Spielberichte` — Gefiltert
- `GET /api/health` — Status

## Deployment auf Railway

1. GitHub Repo erstellen und diesen Ordner pushen
2. Auf [railway.app](https://railway.app) einloggen
3. **New Project** → **Deploy from GitHub Repo**
4. Repo auswählen → Railway erkennt Node.js automatisch
5. Deploy abwarten (~2 Min)
6. Unter **Settings → Domains** eine öffentliche URL generieren
7. Diese URL in der ClubApp als `apiURL` eintragen

## Lokal testen

```bash
cd LoewenNewsServer
npm install
npm start
# öffne http://localhost:3000/api/news
```
