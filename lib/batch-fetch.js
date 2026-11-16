// Abruf eines Batch-Auftrags direkt über die REST-API, ohne die Antwort als Ganzes in
// den Speicher zu laden: Die Bilder werden beim Lesen der Antwort stückweise in
// temporäre Dateien geschrieben. Das SDK (client.batches.get) liest die Antwort als
// einen String und scheitert ab ca. 512 MB („Cannot create a string longer than …“).
import * as fs from 'fs';
import * as path from 'path';
import { failureReason } from './batch.js';
import { createBase64Sink, createJsonStream } from './json-stream.js';

const JOB_STATES = {
  BATCH_STATE_UNSPECIFIED: 'JOB_STATE_UNSPECIFIED',
  BATCH_STATE_PENDING: 'JOB_STATE_PENDING',
  BATCH_STATE_RUNNING: 'JOB_STATE_RUNNING',
  BATCH_STATE_SUCCEEDED: 'JOB_STATE_SUCCEEDED',
  BATCH_STATE_FAILED: 'JOB_STATE_FAILED',
  BATCH_STATE_CANCELLED: 'JOB_STATE_CANCELLED',
  BATCH_STATE_EXPIRED: 'JOB_STATE_EXPIRED',
};
/** Status der REST-API (BATCH_STATE_…) in die Schreibweise des SDK (JOB_STATE_…). */
export const toJobState = (state) => JOB_STATES[state] || state;

// Pfad der Inline-Antworten in der REST-Antwort
const ITEMS = ['metadata', 'output', 'inlinedResponses', 'inlinedResponses'];
const startsWith = (p, prefix) => prefix.every((key, i) => p[i] === key);
const endsWith = (p, from, suffix) =>
  p.length === from + suffix.length && suffix.every((key, i) => p[from + i] === key);
const NULL_SINK = { write() {}, end() {} };

/**
 * Handler für createJsonStream, die aus der Antwort von `batches.get` den Status, die
 * Bilder und die Fehlschläge einsammeln.
 * @param {object} options
 * @param {Set<number>} [options.skipIndexes] Positionen, deren Bild schon vorhanden ist
 * @param {(index: number) => { write(data: Buffer): void, close(): void, discard(): void, path: string }} options.openImage
 *   Öffnet das Ziel für das Bild der Anfrage `index`
 */
export function createBatchCollector({ skipIndexes = new Set(), openImage }) {
  const result = {
    state: null,
    // Anzahl der Inline-Antworten; null = die Antwort enthielt keine
    responses: null,
    responsesFile: null,
    /** @type {{ index: number, path: string, mimeType: string|null }[]} */
    found: [],
    /** @type {{ index: number, reason: string }[]} */
    failures: [],
  };
  let count = 0;
  let item = null;
  const itemFor = (index) => {
    if (!item || item.index !== index) {
      item = { index, image: null, mimeByPart: {}, error: null, finishReason: null, block: null };
    }
    return item;
  };

  const finishItem = () => {
    const current = item;
    item = null;
    if (!current) return;
    count = Math.max(count, current.index + 1);
    if (skipIndexes.has(current.index)) return;
    if (current.image && current.image.sink.bytes > 0) {
      result.found.push({
        index: current.index,
        path: current.image.target.path,
        mimeType: current.mimeByPart[current.image.part] ?? null,
      });
      return;
    }
    current.image?.target.discard();
    result.failures.push({
      index: current.index,
      reason: failureReason({
        error: current.error,
        response: {
          promptFeedback: { blockReason: current.block },
          candidates: [{ finishReason: current.finishReason }],
        },
      }),
    });
  };

  const handlers = {
    openString(p) {
      if (!startsWith(p, ITEMS) || p[p.length - 1] !== 'data') return null;
      // …[i].response.candidates[0].content.parts[k].inlineData.data
      const isImage =
        p.length === ITEMS.length + 9 &&
        p[5] === 'response' &&
        p[6] === 'candidates' &&
        p[7] === 0 &&
        p[8] === 'content' &&
        p[9] === 'parts' &&
        p[11] === 'inlineData';
      const current = itemFor(p[4]);
      // Nur das erste Bild der ersten Antwort; alles andere wird überlesen statt gepuffert
      if (!isImage || current.image || skipIndexes.has(current.index)) return NULL_SINK;
      const target = openImage(current.index);
      const sink = createBase64Sink(
        (data) => target.write(data),
        () => target.close(),
      );
      current.image = { part: p[10], target, sink };
      return sink;
    },
    onValue(p, value) {
      if (endsWith(p, 0, ['metadata', 'state'])) result.state = toJobState(value);
      else if (endsWith(p, 0, ['metadata', 'output', 'responsesFile'])) {
        result.responsesFile = value;
      } else if (startsWith(p, ITEMS) && p.length > ITEMS.length + 1) {
        const current = itemFor(p[4]);
        if (endsWith(p, 5, ['error', 'message'])) current.error = { message: value };
        else if (endsWith(p, 5, ['error', 'status']) || endsWith(p, 5, ['error', 'code'])) {
          current.error = current.error || { message: String(value) };
        } else if (endsWith(p, 5, ['response', 'promptFeedback', 'blockReason'])) {
          current.block = value;
        } else if (endsWith(p, 5, ['response', 'candidates', 0, 'finishReason'])) {
          current.finishReason = value;
        } else if (
          p.length === ITEMS.length + 9 &&
          endsWith(p, 5, [
            'response',
            'candidates',
            0,
            'content',
            'parts',
            p[10],
            'inlineData',
            'mimeType',
          ])
        ) {
          current.mimeByPart[p[10]] = value;
        }
      }
    },
    onClose(p) {
      if (startsWith(p, ITEMS)) {
        if (p.length === ITEMS.length + 1) {
          itemFor(p[4]);
          finishItem();
        } else if (p.length === ITEMS.length) {
          result.responses = count;
        }
      }
    },
  };

  /** Bei einem Abbruch: angefangene und fertige temporäre Dateien entfernen. */
  const discardAll = () => {
    item?.image?.target.discard();
    for (const { path: file } of result.found) fs.rmSync(file, { force: true });
    result.found = [];
  };

  return { handlers, result, discardAll };
}

// Fehlermeldung der API aus einer Fehlerantwort lesen
const apiErrorMessage = (status, text) => {
  try {
    const message = JSON.parse(text)?.error?.message;
    if (message) return message;
  } catch {
    // keine JSON-Antwort
  }
  return `Gemini antwortete mit HTTP ${status}.`;
};

/**
 * Ruft einen Batch-Auftrag ab. Bilder fertiger Aufträge landen als temporäre Dateien
 * (`*.part`) in `tmpDir`; der Aufrufer benennt sie um oder löscht sie.
 * @returns {Promise<ReturnType<typeof createBatchCollector>['result']>}
 */
export async function fetchBatchJob({
  name,
  apiKey,
  baseUrl = 'https://generativelanguage.googleapis.com',
  apiVersion = 'v1beta',
  skipIndexes,
  tmpDir,
  timeoutMs,
  fetchImpl = fetch,
}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/${apiVersion}/${name}`;
  const res = await fetchImpl(url, {
    headers: { 'x-goog-api-key': apiKey },
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!res.ok) {
    throw new Error(apiErrorMessage(res.status, (await res.text()).slice(0, 4000)));
  }

  const prefix = `batchtmp_${String(name).replace(/\W/g, '_')}_${Date.now()}_`;
  const collector = createBatchCollector({
    skipIndexes,
    openImage(index) {
      const file = path.join(tmpDir, `${prefix}${index}.part`);
      let fd = fs.openSync(file, 'w');
      const close = () => {
        if (fd !== null) fs.closeSync(fd);
        fd = null;
      };
      return {
        path: file,
        write: (data) => fs.writeSync(fd, data),
        close,
        discard() {
          close();
          fs.rmSync(file, { force: true });
        },
      };
    },
  });

  try {
    const parser = createJsonStream(collector.handlers);
    const decoder = new TextDecoder();
    for await (const chunk of res.body) parser.write(decoder.decode(chunk, { stream: true }));
    parser.write(decoder.decode());
    parser.end();
  } catch (error) {
    collector.discardAll();
    throw error;
  }
  return collector.result;
}
