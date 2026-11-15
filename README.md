# Bild-Studio (gemini-studio)

Bildgenerierung mit der Gemini API und Adobe-Stock-Metadaten (Titel, 25 Keywords, Kategorie, CSV-Export).
Läuft als Express-Backend hinter Nginx unter `https://kodinitools.com/bild-studio/`.

## Struktur

```
server.js                        Express-Backend (API + statische Dateien)
public/index.html                Frontend (relative Pfade, läuft unter jedem Unterpfad)
deploy/bild-studio.nginx.conf    Nginx-Snippet mit Passwortschutz
.env.example                     Vorlage für .env
```

Laufzeitdaten (`batch_jobs.json`, `public/images/`) und `.env` sind nicht im Repo.

## Endpunkte

| Methode | Pfad                   | Zweck                                         |
| ------- | ---------------------- | --------------------------------------------- |
| POST    | `/api/generate-single` | Einzelbild sofort erzeugen                    |
| POST    | `/api/batch/start`     | Batch-Job absenden (50 % Rabatt)              |
| GET     | `/api/batch/status`    | Status prüfen, fertige Bilder herunterladen   |
| POST    | `/api/adobe-metadata`  | Titel, Keywords und Kategorie zu einem Bild   |

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
cd ~/gemini-studio && git pull && npm ci && pm2 restart bild-studio
```

## Prüfen

```bash
curl -s http://127.0.0.1:3018/api/batch/status                                   # []
curl -s -o /dev/null -w '%{http_code}\n' https://kodinitools.com/bild-studio/    # 401
```

## Hinweise

- Der Server lauscht nur auf `127.0.0.1`; Zugriff von aussen ausschliesslich über Nginx mit Basic Auth.
- Jeder Aufruf von `generate-single`, `batch/start` und `adobe-metadata` verursacht API-Kosten.
- Der Port (`PORT`, Standard 3018) muss zum `proxy_pass` im Nginx-Snippet passen.
