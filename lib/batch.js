// Auswertung der Ergebnisse eines Batch-Auftrags (reine Funktionen, ohne Dateizugriff).

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const extForMime = (mimeType) => EXT_BY_MIME[mimeType] || 'png';

export const findImagePart = (response) =>
  response?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);

// Dateiname aus Job-ID + Position (Inline-Antworten tragen keinen Key)
const jobFilePrefix = (jobName) => `${String(jobName).replace(/\W/g, '_')}_`;
export const batchFileName = (jobName, index, mimeType) =>
  `${jobFilePrefix(jobName)}${index}.${extForMime(mimeType)}`;

/** Position eines Batch-Bildes innerhalb seines Auftrags (aus dem Dateinamen), sonst -1. */
export function batchImageIndex(jobName, fileName) {
  const prefix = jobFilePrefix(jobName);
  const match = String(fileName).startsWith(prefix)
    ? /^(\d+)\.\w+$/.exec(String(fileName).slice(prefix.length))
    : null;
  return match ? Number(match[1]) : -1;
}

/** Lesbarer Grund, warum eine Batch-Anfrage kein Bild geliefert hat. */
export function failureReason(item) {
  const error = item?.error;
  if (error) return String(error.message || error.status || error.code || 'Fehler von Gemini');
  const response = item?.response;
  const blockReason = response?.promptFeedback?.blockReason;
  if (blockReason) return `Prompt abgelehnt (${blockReason})`;
  const finishReason = response?.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP') return `kein Bild (${finishReason})`;
  return 'Antwort ohne Bild';
}

/** Endzustände eines Batch-Auftrags (Gemini fragt dann nichts mehr ab) */
export const TERMINAL_JOB_STATES = new Set([
  'JOB_STATE_SUCCEEDED',
  'JOB_STATE_FAILED',
  'JOB_STATE_CANCELLED',
  'JOB_STATE_EXPIRED',
]);

/** Auftrag in der Statusliste anzeigen? (entfernte Aufträge sind nur noch für ihre Bilder da) */
export const isListedJob = (job) => Boolean(job) && job.removed !== true;

/**
 * Plant das Entfernen von Batch-Aufträgen aus der Statusliste (reine Funktion).
 * - Nur Aufträge in einem Endzustand; laufende werden übersprungen.
 * - deleteImages=false: Aufträge mit Bildern bleiben gespeichert, aber mit
 *   removed=true (Bilder samt Metadaten, Export-Entscheidung usw. bleiben in der
 *   Galerie). Aufträge ohne Bilder werden ganz gelöscht.
 * - deleteImages=true: Aufträge werden ganz gelöscht, ihre Bilddateien stehen in
 *   filesToDelete.
 * @param {object[]} jobs Inhalt von batch_jobs.json (wird nicht verändert)
 * @param {string[]} names zu entfernende Auftragsnamen
 * @param {{ deleteImages?: boolean, now?: string }} [options]
 * @returns {{ jobs: object[], removed: string[], skipped: {name: string, reason: string}[], filesToDelete: string[] }}
 */
export function planJobRemoval(
  jobs,
  names,
  { deleteImages = false, now = new Date().toISOString() } = {},
) {
  const wanted = new Set(Array.isArray(names) ? names.filter((n) => typeof n === 'string') : []);
  const removed = [];
  const skipped = [];
  const filesToDelete = [];
  const result = [];

  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!wanted.has(job?.name) || !isListedJob(job)) {
      result.push(job);
      continue;
    }
    wanted.delete(job.name);
    if (!TERMINAL_JOB_STATES.has(job.state)) {
      skipped.push({ name: job.name, reason: 'läuft noch' });
      result.push(job);
      continue;
    }
    removed.push(job.name);
    const images = job.images || [];
    if (deleteImages) {
      filesToDelete.push(...images.map((i) => i.fileName));
    } else if (images.length) {
      result.push({ ...job, removed: true, removedAt: now });
    }
    // Ohne Bilder bzw. mit gelöschten Bildern: Auftrag fällt ganz weg
  }
  for (const name of wanted) skipped.push({ name, reason: 'nicht gefunden' });

  // Dateien, die noch ein verbleibender Auftrag nutzt, nicht löschen
  const stillUsed = new Set(result.flatMap((j) => (j?.images || []).map((i) => i.fileName)));
  return {
    jobs: result,
    removed,
    skipped,
    filesToDelete: [...new Set(filesToDelete)].filter((f) => !stillUsed.has(f)),
  };
}
