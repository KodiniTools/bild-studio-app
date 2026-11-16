import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBase64Sink, createJsonStream } from '../lib/json-stream.js';
import { fetchBatchJob, toJobState } from '../lib/batch-fetch.js';

// Alle gemeldeten Werte und Enden einsammeln; Text in Stücken der Größe `size` einspeisen
const parseInChunks = (text, size) => {
  const events = [];
  const parser = createJsonStream({
    onValue: (p, v) => events.push(`${p.join('/')}=${JSON.stringify(v)}`),
    onClose: (p) => events.push(`ende ${p.join('/')}`),
  });
  for (let i = 0; i < text.length; i += size) parser.write(text.slice(i, i + size));
  parser.end();
  return events;
};

test('createJsonStream: gleiche Werte bei jeder Stückelung', () => {
  const value = {
    a: [1, 2.5, -3e2, true, null, 'x"y\\z\n😀', { b: [], c: {} }],
    'k:,}': 'v,]:{',
    leer: '',
    n: 0,
  };
  const text = JSON.stringify(value, null, 1).replace('z', 'z\\u00e4\\/');
  const whole = parseInChunks(text, text.length);
  assert.deepEqual(whole, [
    'a/0=1',
    'a/1=2.5',
    'a/2=-300',
    'a/3=true',
    'a/4=null',
    'a/5="x\\"y\\\\zä/\\n😀"',
    'ende a/6/b',
    'ende a/6/c',
    'ende a/6',
    'ende a',
    'k:,}="v,]:{"',
    'leer=""',
    'n=0',
    'ende ',
  ]);
  for (const size of [1, 2, 3, 5, 7, 64]) assert.deepEqual(parseInChunks(text, size), whole);
});

test('createJsonStream: gestreamter String geht an die Senke, nicht an onValue', () => {
  const chunks = [];
  const values = [];
  const parser = createJsonStream({
    openString: (p) =>
      p.join('/') === 'big' ? { write: (t) => chunks.push(t), end: () => chunks.push('|') } : null,
    onValue: (p, v) => values.push([p.join('/'), v]),
  });
  for (const part of ['{"big":"AB', 'CD\\u0045F', '","small":"x"}']) parser.write(part);
  parser.end();
  assert.equal(chunks.join(''), 'ABCDEF|');
  assert.deepEqual(values, [['small', 'x']]);
});

test('createJsonStream: unvollständige Antwort wird gemeldet', () => {
  const parser = createJsonStream();
  parser.write('{"a":[1,2');
  assert.throws(() => parser.end(), /unvollständig/);
});

test('createBase64Sink: dekodiert unabhängig von der Stückelung', () => {
  const original = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7) % 256));
  const text = original.toString('base64');
  for (const size of [1, 3, 4, 5, 333]) {
    const parts = [];
    let total = null;
    const sink = createBase64Sink(
      (data) => parts.push(data),
      (bytes) => (total = bytes),
    );
    for (let i = 0; i < text.length; i += size) sink.write(text.slice(i, i + size));
    sink.end();
    assert.ok(Buffer.concat(parts).equals(original), `Stückgröße ${size}`);
    assert.equal(total, original.length);
  }
});

test('toJobState: REST-Status in SDK-Schreibweise', () => {
  assert.equal(toJobState('BATCH_STATE_SUCCEEDED'), 'JOB_STATE_SUCCEEDED');
  assert.equal(toJobState('BATCH_STATE_RUNNING'), 'JOB_STATE_RUNNING');
  assert.equal(toJobState('ETWAS_NEUES'), 'ETWAS_NEUES');
});

// --- fetchBatchJob gegen eine nachgestellte Antwort ---------------------------------

const IMAGE_A = Buffer.from('erstes bild mit etwas inhalt');
const IMAGE_B = Buffer.from('zweites bild');
const imageItem = (data, mimeType = 'image/jpeg') => ({
  response: {
    candidates: [
      {
        content: {
          parts: [{ text: 'ok' }, { inlineData: { mimeType, data: data.toString('base64') } }],
        },
        finishReason: 'STOP',
      },
    ],
  },
});
const batchBody = (state, items) =>
  JSON.stringify({
    name: 'batches/abc',
    metadata: {
      state,
      ...(items ? { output: { inlinedResponses: { inlinedResponses: items } } } : {}),
    },
    done: true,
  });

// fetch-Ersatz: liefert `body` in Stücken von `size` Bytes
const fakeFetch = (body, { status = 200, size = 11 } = {}) => {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, headers: options.headers });
    const bytes = Buffer.from(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      body: (async function* () {
        for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
      })(),
    };
  };
  return { impl, calls };
};

const withTmpDir = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-fetch-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('fetchBatchJob: Bilder als Dateien, Fehlschläge mit Grund', () =>
  withTmpDir(async (tmpDir) => {
    const { impl, calls } = fakeFetch(
      batchBody('BATCH_STATE_SUCCEEDED', [
        imageItem(IMAGE_A),
        { error: { code: 13, message: 'Internal error' } },
        { response: { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] } },
        imageItem(IMAGE_B, 'image/png'),
      ]),
    );
    const result = await fetchBatchJob({
      name: 'batches/abc',
      apiKey: 'geheim',
      baseUrl: 'http://fake/',
      tmpDir,
      fetchImpl: impl,
    });

    assert.deepEqual(calls, [
      { url: 'http://fake/v1beta/batches/abc', headers: { 'x-goog-api-key': 'geheim' } },
    ]);
    assert.equal(result.state, 'JOB_STATE_SUCCEEDED');
    assert.equal(result.responses, 4);
    assert.deepEqual(
      result.found.map((f) => [f.index, f.mimeType, fs.readFileSync(f.path).toString()]),
      [
        [0, 'image/jpeg', IMAGE_A.toString()],
        [3, 'image/png', IMAGE_B.toString()],
      ],
    );
    assert.deepEqual(result.failures, [
      { index: 1, reason: 'Internal error' },
      { index: 2, reason: 'kein Bild (IMAGE_SAFETY)' },
    ]);
    // nur die gefundenen Bilder liegen im Verzeichnis, als *.part
    assert.equal(fs.readdirSync(tmpDir).length, 2);
    assert.ok(fs.readdirSync(tmpDir).every((name) => name.endsWith('.part')));
  }));

test('fetchBatchJob: vorhandene Positionen werden übersprungen', () =>
  withTmpDir(async (tmpDir) => {
    const { impl } = fakeFetch(
      batchBody('BATCH_STATE_SUCCEEDED', [imageItem(IMAGE_A), imageItem(IMAGE_B), { error: {} }]),
    );
    const result = await fetchBatchJob({
      name: 'batches/abc',
      apiKey: 'k',
      tmpDir,
      skipIndexes: new Set([0, 2]),
      fetchImpl: impl,
    });
    assert.deepEqual(
      result.found.map((f) => f.index),
      [1],
    );
    assert.deepEqual(result.failures, []);
    assert.equal(result.responses, 3);
    assert.equal(fs.readdirSync(tmpDir).length, 1);
  }));

test('fetchBatchJob: laufender Auftrag ohne Ergebnisse', () =>
  withTmpDir(async (tmpDir) => {
    const { impl } = fakeFetch(batchBody('BATCH_STATE_RUNNING'));
    const result = await fetchBatchJob({
      name: 'batches/abc',
      apiKey: 'k',
      tmpDir,
      fetchImpl: impl,
    });
    assert.equal(result.state, 'JOB_STATE_RUNNING');
    assert.equal(result.responses, null);
    assert.deepEqual(result.found, []);
  }));

test('fetchBatchJob: Fehlerantwort der API wird als Meldung weitergereicht', () =>
  withTmpDir(async (tmpDir) => {
    const { impl } = fakeFetch(
      JSON.stringify({ error: { code: 404, message: 'Batch not found', status: 'NOT_FOUND' } }),
      { status: 404 },
    );
    await assert.rejects(
      fetchBatchJob({ name: 'batches/abc', apiKey: 'k', tmpDir, fetchImpl: impl }),
      /Batch not found/,
    );
  }));

test('fetchBatchJob: abgebrochene Antwort hinterlässt keine Dateien', () =>
  withTmpDir(async (tmpDir) => {
    const body = batchBody('BATCH_STATE_SUCCEEDED', [imageItem(IMAGE_A), imageItem(IMAGE_B)]);
    const { impl } = fakeFetch(body.slice(0, body.length - 60));
    await assert.rejects(
      fetchBatchJob({ name: 'batches/abc', apiKey: 'k', tmpDir, fetchImpl: impl }),
      /unvollständig/,
    );
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  }));
