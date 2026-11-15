// Adobe-Stock-spezifische Hilfsfunktionen: Kategorien und CSV-Export.

/**
 * Offizielle Adobe-Stock-Kategorien; der Index + 1 ist die Kategorie-Nummer für die CSV.
 *
 * Stand: November 2026. Die Liste wurde aus mehreren Quellen abgeleitet und nicht direkt
 * gegen Adobes Hilfeseite geprüft. Bei Abweichungen nur hier korrigieren:
 * https://helpx.adobe.com/stock/contributor/help/categories.html
 */
export const ADOBE_CATEGORIES = Object.freeze([
  'Animals', // 1
  'Buildings and Architecture', // 2
  'Business', // 3
  'Drinks', // 4
  'The Environment', // 5
  'States of Mind', // 6
  'Food', // 7
  'Graphic Resources', // 8
  'Hobbies and Leisure', // 9
  'Industry', // 10
  'Landscapes', // 11
  'Lifestyle', // 12
  'People', // 13
  'Plants and Flowers', // 14
  'Culture and Religion', // 15
  'Science', // 16
  'Social Issues', // 17
  'Sports', // 18
  'Technology', // 19
  'Transport', // 20
  'Travel', // 21
]);

// Freie Namen aus älteren Metadaten (vor Einführung der festen Liste)
const CATEGORY_ALIASES = Object.freeze({
  architecture: 2,
  buildings: 2,
  environment: 5,
  nature: 5,
  drink: 4,
  abstract: 8,
  graphics: 8,
  backgrounds: 8,
  hobbies: 9,
  leisure: 9,
  landscape: 11,
  plants: 14,
  flowers: 14,
  culture: 15,
  religion: 15,
  sport: 18,
  transportation: 20,
});

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');

const CATEGORY_IDS = new Map(ADOBE_CATEGORIES.map((name, i) => [normalize(name), i + 1]));

/**
 * Ermittelt die Adobe-Kategorie-Nummer (1–21) zu einem Kategorienamen.
 * Akzeptiert offizielle Namen (Groß-/Kleinschreibung egal), bekannte Alias-Namen
 * und bereits numerische Werte.
 * @returns {number|null} null, wenn keine eindeutige Zuordnung möglich ist
 */
export const categoryIdFor = (category) => {
  if (Number.isInteger(category)) {
    return category >= 1 && category <= ADOBE_CATEGORIES.length ? category : null;
  }
  const key = normalize(category);
  if (!key) return null;
  if (/^\d+$/.test(key)) return categoryIdFor(Number(key));
  return CATEGORY_IDS.get(key) ?? CATEGORY_ALIASES[key] ?? null;
};

/** Offizieller Name zur Nummer, z. B. 11 -> 'Landscapes' */
export const categoryName = (id) => ADOBE_CATEGORIES[id - 1] ?? null;

/**
 * Adobe-Stock-CSV eines Batch-Jobs (nur Bilder mit Metadaten).
 * Spalten wie in Adobes CSV-Vorlage: Filename,Title,Keywords,Category,Releases.
 * Category ist die Nummer (leer, wenn nicht zuordenbar), Releases bleibt leer.
 * @returns {string|null} CSV-Text oder null, wenn kein Bild Metadaten hat
 */
export const buildAdobeCsv = (job) => {
  const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = ['Filename,Title,Keywords,Category,Releases'];
  for (const img of job?.images || []) {
    const m = img.metadata;
    if (!m) continue;
    const keywords = Array.isArray(m.keywords) ? m.keywords : [];
    const categoryId = categoryIdFor(m.categoryId) ?? categoryIdFor(m.category);
    rows.push(
      [img.fileName, m.title, keywords.join(', '), categoryId ?? '', ''].map(quote).join(','),
    );
  }
  return rows.length > 1 ? rows.join('\n') : null;
};

export const csvFileName = (jobName) => `adobe_stock_${String(jobName).replace(/\W/g, '_')}.csv`;
