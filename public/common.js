// Gemeinsame Hilfsfunktionen für Startseite (index.html) und Galerie (galerie.html).
// Klassisches Script (kein Modul): die Funktionen sind global verfügbar.

// Text sicher in HTML einsetzen (Prompts/Metadaten können <, >, " enthalten)
function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// Alle API-Pfade sind RELATIV (ohne führenden Slash), damit die App unter
// /bild-studio/ läuft. Liefert geparstes JSON oder wirft einen lesbaren Fehler
// (z. B. wenn Nginx bei 401/502/504 eine HTML-Seite statt JSON zurückgibt).
async function api(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Anfang der Antwort mit ausgeben: zeigt, wer geantwortet hat (Nginx, Express, ...)
    const hint = text
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    throw new Error(
      `Server antwortete mit HTTP ${res.status} (kein JSON).` +
        (hint ? ` Antwort: „${hint}“` : ' Antwort war leer.'),
    );
  }
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function postJson(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Speichern-Dialog („Speichern unter“) für Downloads
// ---------------------------------------------------------------------------
// Chrome/Edge (über HTTPS) bieten window.showSaveFilePicker: Speicherort und
// Dateiname sind dort wählbar. Firefox/Safari kennen das nicht; dort bleibt der
// bisherige Download (Speicherort bestimmt die Browser-Einstellung).

const SAVE_FILE_TYPES = {
  zip: { description: 'ZIP-Archiv', mime: 'application/zip' },
  csv: { description: 'CSV-Datei', mime: 'text/csv' },
  png: { description: 'PNG-Bild', mime: 'image/png' },
  jpg: { description: 'JPEG-Bild', mime: 'image/jpeg' },
  jpeg: { description: 'JPEG-Bild', mime: 'image/jpeg' },
  webp: { description: 'WebP-Bild', mime: 'image/webp' },
};

function canPickSaveLocation() {
  return typeof window.showSaveFilePicker === 'function';
}

// Lesbare Fehlermeldung aus einer fehlgeschlagenen Antwort (JSON oder HTML von Nginx)
async function responseErrorText(res) {
  try {
    return (await res.json()).error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// Bisheriger Download über einen Link (Dateiname kommt notfalls vom Server)
function downloadViaLink(url, fileName) {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName || '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function savePickerOptions(fileName) {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  const type = ext && SAVE_FILE_TYPES[ext];
  return {
    suggestedName: fileName,
    // gleiche id: der Browser merkt sich den zuletzt gewählten Ordner
    id: 'bild-studio-download',
    startIn: 'downloads',
    ...(type
      ? { types: [{ description: type.description, accept: { [type.mime]: [`.${ext}`] } }] }
      : {}),
  };
}

let savePickerOpen = false;

/**
 * Lädt `url` und speichert die Antwort über den Speichern-Dialog.
 * Muss direkt aus einem Klick heraus aufgerufen werden (der Browser verlangt
 * eine Nutzeraktion für den Dialog), deshalb kommt der Dialog VOR dem Laden.
 * Ohne Dialog-Unterstützung wird `fallback()` aufgerufen (Standard: Link-Download).
 *
 * @returns {Promise<string|null>} gespeicherter Dateiname, null bei Abbruch/ohne Dialog
 * @throws Error bei Server- oder Schreibfehler (Text für die Statuszeile)
 */
async function saveWithDialog(url, fileName, fallback = () => downloadViaLink(url, fileName)) {
  if (!canPickSaveLocation()) {
    await fallback();
    return null;
  }
  if (savePickerOpen) return null; // Doppelklick: Dialog ist schon offen

  let handle;
  savePickerOpen = true;
  try {
    handle = await window.showSaveFilePicker(savePickerOptions(fileName));
  } catch (err) {
    if (err.name === 'AbortError') return null; // Nutzer hat abgebrochen
    // z. B. SecurityError (Seite in fremdem iframe): normaler Download
    if (err.name === 'SecurityError') {
      await fallback();
      return null;
    }
    throw err;
  } finally {
    savePickerOpen = false;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(await responseErrorText(res));
  // Der Browser schreibt in eine temporäre Datei und ersetzt erst beim Schließen;
  // bei Abbruch bleibt eine bereits vorhandene Datei unverändert.
  const writable = await handle.createWritable();
  try {
    if (res.body) {
      await res.body.pipeTo(writable); // streamt, auch große ZIPs ohne Puffer im Speicher
    } else {
      await writable.write(await res.blob());
      await writable.close();
    }
  } catch (err) {
    try {
      await writable.abort();
    } catch {
      // bereits durch pipeTo abgebrochen
    }
    throw err;
  }
  return handle.name;
}
