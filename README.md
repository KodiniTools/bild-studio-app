# Bild-Studio (gemini-studio)

Bildgenerierung mit der Gemini API und Adobe-Stock-Metadaten (Titel, 25 Keywords, Kategorie, CSV-Export).
Läuft als Express-Backend hinter Nginx unter `https://kodinitools.com/bild-studio/`.

## Struktur

```
server.js                        Express-Backend (API + statische Dateien)
lib/adobe.js                     Adobe-Stock-Kategorien und CSV-Export
lib/gallery.js                   Galerie: Bilder mit abgeleiteter Adobe-Kategorie (Ordner)
lib/upload.js                    Eigene Bilder hochladen: Bildtyp prüfen, sicherer Dateiname
test/                            Unit-Tests (node --test)
deploy.sh                        Update/Deployment auf dem Server
public/index.html                Startseite „Studio“: Prompt, Optionen, Batch-Warteschlange, Auftragsstatus
public/galerie.html              Galerie: alle Bilder in Ordnern nach Adobe-Kategorie
public/common.js, style.css      Gemeinsame Hilfsfunktionen und Styles (alle Pfade relativ)
deploy/bild-studio.nginx.conf    Nginx-Snippet mit Passwortschutz
.env.example                     Vorlage für .env
```

Laufzeitdaten (`batch_jobs.json`, `single_images.json`, `public/images/`) und `.env` sind nicht im Repo.

## Entwicklung

```bash
npm install            # inkl. Dev-Abhängigkeiten (ESLint, Prettier)
npm run lint           # ESLint für server.js und das Script in public/index.html
npm run lint:fix       # automatisch behebbare Lint-Fehler korrigieren
npm run format         # alle Dateien mit Prettier formatieren
npm run format:check   # nur prüfen (z. B. vor einem Commit)
npm test               # Unit-Tests (node --test, z. B. Adobe-Kategorien und CSV)
```

Konfiguration: `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`.
Auf dem Server installiert `deploy.sh` nur die Laufzeit-Abhängigkeiten (`npm ci --omit=dev`).

## Endpunkte

| Methode | Pfad                             | Zweck                                                                                 |
| ------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| POST    | `/api/generate-single`           | Einzelbild sofort erzeugen                                                            |
| POST    | `/api/batch/start`               | Batch-Job absenden (50 % Rabatt)                                                      |
| GET     | `/api/batch/status`              | Status prüfen, fertige Bilder herunterladen                                           |
| POST    | `/api/batch/refetch`             | Fehlende Bilder eines fertigen Batch-Auftrags erneut bei Gemini abrufen (`{ job }`)   |
| POST    | `/api/adobe-metadata`            | Titel, Keywords und Kategorie zu einem Bild                                           |
| GET     | `/api/images`                    | Einzelbilder (ohne Batch-Zuordnung) auflisten                                         |
| GET     | `/api/images/zip`                | Alle Einzelbilder als ZIP                                                             |
| GET     | `/api/batch/zip?job=<name>`      | Alle Bilder eines Batch-Auftrags als ZIP (inkl. Adobe-CSV, falls Metadaten vorhanden) |
| GET     | `/api/batch/csv?job=<name>`      | Adobe-Stock-CSV eines Batch-Auftrags                                                  |
| GET     | `/api/images/:fileName/download` | Bild als Datei herunterladen                                                          |
| DELETE  | `/api/images/:fileName`          | Bild löschen (Datei + Eintrag im Batch-Job)                                           |
| POST    | `/api/images/:fileName/export`   | Bild in ZIP/CSV aufnehmen oder ausschließen (`{ "include": true\|false }`)            |
| GET     | `/api/gallery`                   | Alle Bilder (Sofort + Batch) mit Adobe-Kategorie; nur gespeicherter Stand             |
| GET     | `/api/gallery/zip?category=<x>`  | Ordner als ZIP inkl. CSV (`all`, `none`, `1`–`21`; flach, ohne Unterordner)           |
| POST    | `/api/uploads?name=<original>`   | Eigenes Bild hochladen (Body = Datei; JPEG/PNG/WebP, max. 50 MB)                      |
| GET     | `/api/uploads/zip`               | Hochgeladene Bilder als ZIP inkl. Adobe-CSV                                           |
| GET     | `/api/uploads/csv`               | Adobe-Stock-CSV der hochgeladenen Bilder                                              |

Hochgeladene Bilder liegen wie alle anderen in `public/images/` und stehen in `single_images.json`
mit `source: "upload"`. Metadaten, Ordner, Export-Ausschluss und Löschen funktionieren wie bei
erzeugten Bildern. Nginx braucht dafür `client_max_body_size 50m;` im `location`-Block der App
(Standard ist 1 MB, größere Dateien scheitern sonst mit HTTP 413).

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

## Galerie-Ordner

Die Ordner in der Galerie entstehen automatisch aus der Adobe-Kategorie der Metadaten (gleiche Ableitung wie im
CSV-Export, auch für alte Namen wie „Nature“). Bilder ohne Metadaten oder ohne zuordenbare Kategorie stehen unter
„Ohne Kategorie“. Auf der Platte bleiben alle Bilder in `public/images/`; Pfade, `batch_jobs.json` und
`single_images.json` ändern sich nicht. Auch die ZIP-Downloads sind flach (Bilder + CSV ohne Unterordner), passend zum Hochladen bei Adobe.

## Export-Ausschluss

Jede Karte in der Galerie hat den Schalter „In ZIP & CSV für Adobe aufnehmen“. Ohne eigene Entscheidung sind Bilder
mit Prüfhinweis (z. B. Logo, Wasserzeichen) ausgeschlossen. Ausgeschlossene Bilder fehlen in allen ZIP-Downloads und
in der CSV, bleiben aber in der Galerie und auf der Platte; die Knöpfe nennen die Anzahl. Gespeichert wird die
Entscheidung als `exportExcluded` im Bild-Eintrag (`batch_jobs.json` bzw. `single_images.json`).

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

- Die Batch-Warteschlange (noch nicht abgesendete Prompts) wird im Browser gespeichert (`localStorage`) und übersteht so Neuladen und Deploys. Sie gilt nur für den jeweiligen Browser bzw. das Gerät.
- Prompts werden gespeichert und auf jeder Bildkarte angezeigt: bei Einzelbildern in `single_images.json` (dort auch die Adobe-Metadaten), bei Batch-Aufträgen im Job (`prompts`, Zuordnung per Position). Bilder, die vor dieser Funktion erzeugt wurden, haben keinen gespeicherten Prompt.
- Adobe-Stock-Kategorien (Nummern 1–21) stehen in `lib/adobe.js`. Die CSV enthält die Spalten `Filename,Title,Keywords,Category,Releases`; `Category` ist die Nummer, `Releases` bleibt leer. Ältere Metadaten ohne zuordenbare Kategorie haben eine leere Nummer und sollten neu generiert werden.
- Bilder werden unverändert so gespeichert, wie die Gemini-API sie liefert. Einzel- und ZIP-Downloads enthalten immer die Originaldateien (volle Auflösung, keine Neukomprimierung).
- Der Server lauscht nur auf `127.0.0.1`; Zugriff von aussen ausschliesslich über Nginx mit Basic Auth.
- Jeder Aufruf von `generate-single`, `batch/start` und `adobe-metadata` verursacht API-Kosten.
- Der Port (`PORT`, Standard 3018) muss zum `proxy_pass` im Nginx-Snippet passen.
