# Bild-Studio (gemini-studio)

Bildgenerierung mit der Gemini API und Adobe-Stock-Metadaten (Titel, 25 Keywords, Kategorie, CSV-Export).
Läuft als Express-Backend hinter Nginx unter `https://kodinitools.com/bild-studio/`.

## Struktur

```
server.js                        Express-Backend (API + statische Dateien)
deploy.sh                        Update/Deployment auf dem Server
public/index.html                Frontend (relative Pfade, läuft unter jedem Unterpfad)
deploy/bild-studio.nginx.conf    Nginx-Snippet mit Passwortschutz
.env.example                     Vorlage für .env
```

Laufzeitdaten (`batch_jobs.json`, `public/images/`) und `.env` sind nicht im Repo.

## Entwicklung

```bash
npm install            # inkl. Dev-Abhängigkeiten (ESLint, Prettier)
npm run lint           # ESLint für server.js und das Script in public/index.html
npm run lint:fix       # automatisch behebbare Lint-Fehler korrigieren
npm run format         # alle Dateien mit Prettier formatieren
npm run format:check   # nur prüfen (z. B. vor einem Commit)
```

Konfiguration: `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`.
Auf dem Server installiert `deploy.sh` nur die Laufzeit-Abhängigkeiten (`npm ci --omit=dev`).

## Endpunkte

| Methode | Pfad                             | Zweck                                         |
| ------- | -------------------------------- | --------------------------------------------- |
| POST    | `/api/generate-single`           | Einzelbild sofort erzeugen                    |
| POST    | `/api/batch/start`               | Batch-Job absenden (50 % Rabatt)              |
| GET     | `/api/batch/status`              | Status prüfen, fertige Bilder herunterladen   |
| POST    | `/api/adobe-metadata`            | Titel, Keywords und Kategorie zu einem Bild   |
| GET     | `/api/images`                    | Einzelbilder (ohne Batch-Zuordnung) auflisten |
| GET     | `/api/images/zip`                | Alle Einzelbilder als ZIP                     |
| GET     | `/api/batch/zip?job=<name>`      | Alle Bilder eines Batch-Auftrags als ZIP      |
| GET     | `/api/images/:fileName/download` | Bild als Datei herunterladen                  |
| DELETE  | `/api/images/:fileName`          | Bild löschen (Datei + Eintrag im Batch-Job)   |

## Einrichtung auf dem Server

```bash
git clone https://github.com/KodiniTools/bild-studio-app.git ~/gemini-studio
cd ~/gemini-studio
npm ci
cp .env.example .env && chmod 600 .env    # danach GEMINI_API_KEY eintragen
pm2 start server.js --name bild-studio && pm2 save
```

Nginx:

```bash
sudo apt install -y apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd-bild-studio kodini
sudo cp deploy/bild-studio.nginx.conf /etc/nginx/snippets/bild-studio.conf
# im server { }-Block von kodinitools.com:  include /etc/nginx/snippets/bild-studio.conf;
sudo nginx -t && sudo systemctl reload nginx
```

## Update

```bash
cd ~/gemini-studio && ./deploy.sh
```

Das Skript prüft Voraussetzungen (Node >= 20, pm2, `.env` mit `GEMINI_API_KEY`), holt `origin/main` per Fast-Forward,
führt `npm ci --omit=dev` und den Syntaxcheck aus, startet den PM2-Prozess neu (bzw. legt ihn an) und prüft anschliessend
`http://127.0.0.1:$PORT/` (ohne API-Kosten). Optionen: `--nginx` (Snippet installieren, `nginx -t`, reload), `--no-pull`,
`--help`. Variablen: `BRANCH` (Standard `main`), `APP_NAME` (Standard `bild-studio`).

## Prüfen

```bash
curl -s http://127.0.0.1:3018/api/batch/status                                   # []
curl -s -o /dev/null -w '%{http_code}\n' https://kodinitools.com/bild-studio/    # 401
```

## Hinweise

- Bilder werden unverändert so gespeichert, wie die Gemini-API sie liefert. Einzel- und ZIP-Downloads enthalten immer die Originaldateien (volle Auflösung, keine Neukomprimierung).
- Der Server lauscht nur auf `127.0.0.1`; Zugriff von aussen ausschliesslich über Nginx mit Basic Auth.
- Jeder Aufruf von `generate-single`, `batch/start` und `adobe-metadata` verursacht API-Kosten.
- Der Port (`PORT`, Standard 3018) muss zum `proxy_pass` im Nginx-Snippet passen.
