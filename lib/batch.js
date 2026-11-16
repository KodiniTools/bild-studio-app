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

/**
 * Teilt die Inline-Antworten eines Auftrags in gefundene Bilder und Fehlschläge.
 * Positionen in `skipIndexes` (dort liegt schon ein Bild) werden nicht angefasst.
 * @returns {{ found: {index:number, fileName:string, data:string}[], failures: {index:number, reason:string}[] }}
 */
export function extractBatchImages(jobName, inlinedResponses, skipIndexes = new Set()) {
  const found = [];
  const failures = [];
  (inlinedResponses || []).forEach((item, index) => {
    if (skipIndexes.has(index)) return;
    const part = findImagePart(item?.response);
    if (part?.inlineData?.data) {
      found.push({
        index,
        fileName: batchFileName(jobName, index, part.inlineData.mimeType),
        data: part.inlineData.data,
      });
    } else {
      failures.push({ index, reason: failureReason(item) });
    }
  });
  return { found, failures };
}
