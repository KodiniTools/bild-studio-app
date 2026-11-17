// Galerie: alle Bilder (Sofort + Batch) mit abgeleiteter Adobe-Kategorie.
// Die Kategorie-"Ordner" sind nur eine Gruppierung in der Oberfläche (die ZIP-Downloads
// sind flach). Auf der Platte bleiben alle Bilder unverändert in public/images/.

import {
  ADOBE_CATEGORIES,
  categoryIdFor,
  categoryName,
  hasComplianceWarning,
  isExportExcluded,
} from './adobe.js';

/** Ordner-Schlüssel für Bilder ohne Metadaten bzw. ohne zuordenbare Kategorie */
export const UNCATEGORIZED = 'none';
export const UNCATEGORIZED_LABEL = 'Ohne Kategorie';

/**
 * Ordner für Bilder, die manuell korrigiert werden müssen. Ein Bild darin erscheint nur
 * dort (und unter „Alle“), nicht mehr in seinem Kategorie-Ordner.
 */
export const CORRECTION = 'korrektur';
export const CORRECTION_LABEL = 'Korrektur nötig';

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
      // 'upload' = eigenes hochgeladenes Bild, 'single' = sofort erstellt
      source: img.source === 'upload' ? 'upload' : 'single',
      originalName: img.originalName ?? null,
      jobName: null,
      createdAt: toTime(img.createdAt),
      categoryId: imageCategoryId(img.metadata),
      exportExcluded: typeof img.exportExcluded === 'boolean' ? img.exportExcluded : null,
      excluded: isExportExcluded(img),
      needsCorrection: img.needsCorrection === true,
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
        exportExcluded: typeof img.exportExcluded === 'boolean' ? img.exportExcluded : null,
        excluded: isExportExcluded(img),
        needsCorrection: img.needsCorrection === true,
      });
    }
  }
  // Array.prototype.sort ist stabil: Reihenfolge innerhalb eines Auftrags bleibt erhalten
  return images.sort((a, b) => b.createdAt - a.createdAt);
};

/**
 * Prüft den Ordner-Parameter (?category=all|none|korrektur|1..21).
 * @returns {'all'|'none'|'korrektur'|number|null} null bei ungültigem Wert
 */
export const parseFolder = (value) => {
  if (value === undefined || value === 'all') return 'all';
  if (value === UNCATEGORIZED) return UNCATEGORIZED;
  if (value === CORRECTION) return CORRECTION;
  if (typeof value === 'string' && /^\d{1,2}$/.test(value)) {
    const id = Number(value);
    return id >= 1 && id <= ADOBE_CATEGORIES.length ? id : null;
  }
  return null;
};

export const inFolder = (image, folder) => {
  if (folder === 'all') return true;
  if (folder === CORRECTION) return image.needsCorrection === true;
  if (image.needsCorrection === true) return false;
  return folder === UNCATEGORIZED ? image.categoryId === null : image.categoryId === folder;
};

/** Ordnername im ZIP, z. B. „11_Landscapes“ bzw. „Ohne_Kategorie“ */
export const folderDirName = (categoryId) =>
  categoryId === null
    ? UNCATEGORIZED_LABEL.replace(/\W/g, '_')
    : `${String(categoryId).padStart(2, '0')}_${categoryName(categoryId).replace(/\W/g, '_')}`;

/** Kurzname für Datei-/ZIP-Namen eines Ordners */
export const folderSlug = (folder) =>
  folder === 'all'
    ? 'alle'
    : folder === UNCATEGORIZED
      ? 'ohne_kategorie'
      : folder === CORRECTION
        ? 'korrektur'
        : folderDirName(folder);

/**
 * Bilder mit Prüfhinweis, die noch nicht im Korrektur-Ordner liegen (Sammel-Verschieben).
 * @param {Array<{fileName: string, metadata?: object, needsCorrection?: boolean}>} images
 * @returns {string[]} Dateinamen ohne Doppelte
 */
export const correctionCandidates = (images) => [
  ...new Set(
    (Array.isArray(images) ? images : [])
      .filter(
        (img) =>
          img &&
          img.needsCorrection !== true &&
          hasComplianceWarning(img.metadata?.complianceWarning),
      )
      .map((img) => img.fileName),
  ),
];
