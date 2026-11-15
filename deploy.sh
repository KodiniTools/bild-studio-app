#!/usr/bin/env bash
# Deployment/Update des Bild-Studios auf dem Server (läuft im Repo-Verzeichnis, z. B. ~/gemini-studio).
#
#   ./deploy.sh              Update: git pull, npm ci, pm2 (re)start, Health-Check
#   ./deploy.sh --nginx      zusätzlich Nginx-Snippet installieren, testen und neu laden (sudo)
#   ./deploy.sh --no-pull    ohne git pull (z. B. nach manuellem Checkout)
#   ./deploy.sh --help
#
# Umgebungsvariablen (optional):
#   BRANCH    Git-Branch (Standard: main)
#   APP_NAME  PM2-Prozessname (Standard: bild-studio)
set -Eeuo pipefail

BRANCH="${BRANCH:-main}"
APP_NAME="${APP_NAME:-bild-studio}"
NGINX_SNIPPET="/etc/nginx/snippets/bild-studio.conf"
HTPASSWD_FILE="/etc/nginx/.htpasswd-bild-studio"

DO_PULL=1
DO_NGINX=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mFEHLER:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "Abbruch in Zeile $LINENO (Befehl: $BASH_COMMAND)"' ERR

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --nginx)   DO_NGINX=1 ;;
    --no-pull) DO_PULL=0 ;;
    -h|--help) usage; exit 0 ;;
    *)         usage; die "Unbekannte Option: $arg" ;;
  esac
done

# Immer im Verzeichnis des Skripts (= Repo-Root) arbeiten
cd "$(dirname "$(readlink -f "$0")")"

# --- Voraussetzungen ---------------------------------------------------------
for cmd in git node npm pm2 curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' ist nicht installiert."
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node >= 20 erforderlich (gefunden: $(node -v))."

[[ -f .env ]] || die ".env fehlt. Anlegen mit: cp .env.example .env && chmod 600 .env (GEMINI_API_KEY eintragen)."
if [[ "$(stat -c '%a' .env)" != "600" ]]; then
  warn ".env hat Rechte $(stat -c '%a' .env) – setze auf 600."
  chmod 600 .env
fi

# --- Code aktualisieren ------------------------------------------------------
if (( DO_PULL )); then
  # Laufzeitdaten (batch_jobs.json, public/images/, .env) sind in .gitignore und bleiben unberührt
  if ! git diff --quiet || ! git diff --cached --quiet; then
    die "Lokale Änderungen an versionierten Dateien vorhanden – bitte prüfen (git status)."
  fi
  log "Hole Änderungen von origin/$BRANCH"
  OLD_REV="$(git rev-parse HEAD)"
  git fetch --prune origin "$BRANCH"
  git checkout -q "$BRANCH"
  git merge --ff-only "origin/$BRANCH"
  NEW_REV="$(git rev-parse HEAD)"
  if [[ "$OLD_REV" == "$NEW_REV" ]]; then
    log "Bereits aktuell ($(git rev-parse --short HEAD))."
  else
    log "Aktualisiert: $(git rev-parse --short "$OLD_REV") -> $(git rev-parse --short "$NEW_REV")"
    git --no-pager log --oneline "$OLD_REV..$NEW_REV"
  fi
fi

# --- Abhängigkeiten + Syntaxcheck -------------------------------------------
log "Installiere Abhängigkeiten (npm ci --omit=dev)"
npm ci --omit=dev --no-audit --no-fund

# --- .env prüfen --------------------------------------------------------------
# Mit dotenv selbst parsen, damit exakt dieselben Regeln gelten wie in server.js
# (export-Präfix, Leerzeichen um '=', Anführungszeichen, CRLF, BOM).
# Wie bei dotenv/config hat eine bereits gesetzte Umgebungsvariable Vorrang.
log "Prüfe .env"
ENV_INFO="$(node --input-type=module -e '
  import fs from "node:fs";
  import dotenv from "dotenv";
  const e = dotenv.parse(fs.readFileSync(".env"));
  const key = (process.env.GEMINI_API_KEY ?? e.GEMINI_API_KEY ?? "").trim();
  const port = (process.env.PORT ?? e.PORT ?? "").trim();
  console.log(key ? "1" : "0");
  console.log(port);
  console.log(Object.keys(e).join(","));
')" || die ".env konnte nicht gelesen werden."
{ read -r HAS_KEY; read -r PORT; read -r ENV_KEYS; } <<<"$ENV_INFO"

if [[ "$HAS_KEY" != "1" ]]; then
  # Nur Variablennamen ausgeben, niemals Werte
  die "GEMINI_API_KEY ist leer oder fehlt. Gefundene Variablen in .env: ${ENV_KEYS:-(keine)}"
fi

# Port muss zum proxy_pass im Nginx-Snippet passen
PORT="${PORT:-3018}"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT ist ungültig: '$PORT'."
grep -q "127.0.0.1:${PORT}/" deploy/bild-studio.nginx.conf \
  || warn "PORT=$PORT passt nicht zum proxy_pass in deploy/bild-studio.nginx.conf."

log "Syntaxcheck"
npm run --silent check

# --- PM2 ---------------------------------------------------------------------
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  log "Starte PM2-Prozess '$APP_NAME' neu"
  pm2 restart "$APP_NAME" --update-env
else
  log "Lege PM2-Prozess '$APP_NAME' an"
  pm2 start server.js --name "$APP_NAME"
fi
pm2 save >/dev/null

# --- Nginx (optional) --------------------------------------------------------
if (( DO_NGINX )); then
  command -v nginx >/dev/null 2>&1 || die "nginx ist nicht installiert."
  sudo test -f "$HTPASSWD_FILE" \
    || warn "$HTPASSWD_FILE fehlt – anlegen mit: sudo htpasswd -c $HTPASSWD_FILE <benutzer>"
  log "Installiere Nginx-Snippet nach $NGINX_SNIPPET"
  sudo install -m 644 deploy/bild-studio.nginx.conf "$NGINX_SNIPPET"
  sudo nginx -t
  sudo systemctl reload nginx
fi

# --- Health-Check ------------------------------------------------------------
# Prüft nur die statische Startseite: verursacht keine Gemini-API-Aufrufe/Kosten.
log "Health-Check auf http://127.0.0.1:${PORT}/"
for i in {1..15}; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PORT}/" || true)"
  if [[ "$code" == "200" ]]; then
    log "OK – Bild-Studio läuft (Commit $(git rev-parse --short HEAD))."
    exit 0
  fi
  sleep 1
done

pm2 logs "$APP_NAME" --lines 30 --nostream || true
die "Server antwortet nicht mit 200 (letzter Status: ${code:-keiner})."
