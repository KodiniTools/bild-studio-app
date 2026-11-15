// Galerie: alle Bilder (Sofort + Batch) mit abgeleiteter Adobe-Kategorie.
// Die Kategorie-"Ordner" sind nur eine Gruppierung in der Oberfläche und als Ordner im
// ZIP-Download. Auf der Platte bleiben alle Bilder unverändert in public/images/.

import { ADOBE_CATEGORIES, categoryIdFor, categoryName } from './adobe.js';

/** Ordner-Schlüssel für Bilder ohne Metadaten bzw. ohne zuordenbare Kategorie */
export const UNCATEGORIZED = 'none';
export const UNCATEGORIZED_LABEL = 'Ohne Kategorie';

/**
 * Adobe-Kategorie-Nummer eines Bildes. Wie im CSV-Export: erst die gespeicherte Nummer,
 * sonst aus dem Namen abgeleitet (auch alte freie Namen wie „Nature“ über Aliase).
 * @returns {number|null}
 */
export const imageCategoryId = (metadata) =>
  metadata ? (categoryIdFor(metadata.categoryId) ?? categoryIdFor(metadata.category)) : null;

const toTime = (value) => {
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : 0;
};

/**
 * Baut die Galerie-Liste (neueste zuerst; Batch-Bilder in Auftragsreihenfolge).
 * @param {{ jobs: object[], singles: object[] }} input  jobs = batch_jobs.json,
 *   singles = Ergebnis von listSingleImages() (createdAt in ms)
 */
export const buildGalleryImages = ({ jobs = [], singles = [] }) => {
  const images = [];
  for (const img of singles) {
    images.push({
      fileName: img.fileName,
      imageUrl: img.imageUrl,
      prompt: img.prompt ?? null,
      metadata: img.metadata ?? null,
      source: 'single',
      jobName: null,
      createdAt: toTime(img.createdAt),
      categoryId: imageCategoryId(img.metadata),
    });
  }
  for (const job of jobs) {
    const createdAt = toTime(job.createdAt);
    for (const img of job.images || []) {
      images.push({
        fileName: img.fileName,
        imageUrl: img.imageUrl,
        prompt: img.prompt ?? null,
        metadata: img.metadata ?? null,
        source: 'batch',
        jobName: job.name,
        createdAt,
        categoryId: imageCategoryId(img.metadata),
      });
    }
  }
  // Array.prototype.sort ist stabil: Reihenfolge innerhalb eines Auftrags bleibt erhalten
  return images.sort((a, b) => b.createdAt - a.createdAt);
};

/**
 * Prüft den Ordner-Parameter (?category=all|none|1..21).
 * @returns {'all'|'none'|number|null} null bei ungültigem Wert
 */
export const parseFolder = (value) => {
  if (value === undefined || value === 'all') return 'all';
  if (value === UNCATEGORIZED) return UNCATEGORIZED;
  if (typeof value === 'string' && /^\d{1,2}$/.test(value)) {
    const id = Number(value);
    return id >= 1 && id <= ADOBE_CATEGORIES.length ? id : null;
  }
  return null;
};

export const inFolder = (image, folder) =>
  folder === 'all' ||
  (folder === UNCATEGORIZED ? image.categoryId === null : image.categoryId === folder);

/** Ordnername im ZIP, z. B. „11_Landscapes“ bzw. „Ohne_Kategorie“ */
export const folderDirName = (categoryId) =>
  categoryId === null
    ? UNCATEGORIZED_LABEL.replace(/\W/g, '_')
    : `${String(categoryId).padStart(2, '0')}_${categoryName(categoryId).replace(/\W/g, '_')}`;

/** Kurzname für Datei-/ZIP-Namen eines Ordners */
export const folderSlug = (folder) =>
  folder === 'all' ? 'alle' : folder === UNCATEGORIZED ? 'ohne_kategorie' : folderDirName(folder);
