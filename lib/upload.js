// Eigene Bilder hochladen: Bildtyp prüfen und sicheren Dateinamen bilden.

/** Höchstgröße einer hochgeladenen Datei (Adobe Stock nimmt Fotos bis 45 MB an) */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const EXT_BY_TYPE = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
});

/**
 * Erkennt den Bildtyp an den ersten Bytes der Datei (nicht an Name oder Content-Type,
 * die der Browser beliebig setzen kann).
 * @param {Buffer} buffer
 * @returns {'image/png'|'image/jpeg'|'image/webp'|null}
 */
export const detectImageType = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
};

const MAX_BASE_LENGTH = 80;

/**
 * Dateinamen-Teil ohne Endung: nur Buchstaben, Ziffern, _ und -, Umlaute umschrieben
 * (ä -> ae), höchstens 80 Zeichen. Leerer String, wenn nichts übrig bleibt.
 */
export const safeFileBase = (text) =>
  String(text ?? '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/[_-]+$/, '');

/**
 * Dateiname auf dem Server aus dem Originalnamen: nur Buchstaben, Ziffern, _ und -,
 * Umlaute umschrieben (ä -> ae), Endung passend zum erkannten Bildtyp. Ist der Name
 * schon vergeben, wird _2, _3 ... angehängt. Im Adobe-Export (ZIP/CSV) erhält das Bild
 * stattdessen einen Namen nach seinem Titel (siehe exportFileNames in lib/adobe.js).
 * @param {string} originalName  Name der Datei beim Hochladen
 * @param {string} mimeType      Ergebnis von detectImageType
 * @param {(name: string) => boolean} isTaken  true, wenn der Name schon belegt ist
 */
export const uploadFileName = (originalName, mimeType, isTaken = () => false) => {
  const ext = EXT_BY_TYPE[mimeType];
  if (!ext) throw new Error(`Nicht unterstützter Bildtyp: ${mimeType}`);

  const raw = String(originalName ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]*$/, '');
  let base = safeFileBase(raw);
  if (!base) base = 'upload';

  let name = `${base}.${ext}`;
  for (let n = 2; isTaken(name); n++) name = `${base}_${n}.${ext}`;
  return name;
};
