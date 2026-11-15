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
