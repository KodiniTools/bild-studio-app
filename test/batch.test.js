import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  batchFileName,
  batchImageIndex,
  failureReason,
  isListedJob,
  planJobRemoval,
} from '../lib/batch.js';
import { createMutex } from '../lib/refresh.js';

const JOB = 'batches/abc-1';
test('Dateiname und Position gehören zusammen', () => {
  assert.equal(batchFileName(JOB, 3, 'image/jpeg'), 'batches_abc_1_3.jpg');
  assert.equal(batchFileName(JOB, 0, 'application/x'), 'batches_abc_1_0.png');
  assert.equal(batchImageIndex(JOB, 'batches_abc_1_3.jpg'), 3);
  assert.equal(batchImageIndex(JOB, 'batches_abc_1_12.webp'), 12);
  // fremde Dateien und Aufträge mit gleichem Namensanfang zählen nicht
  assert.equal(batchImageIndex(JOB, 'single_123.jpg'), -1);
  assert.equal(batchImageIndex(JOB, 'batches_abc_1_x_3.jpg'), -1);
  assert.equal(batchImageIndex('batches/abc', 'batches_abc_1_3.jpg'), -1);
});

test('failureReason: Grund aus Fehler, Ablehnung oder Abbruchgrund', () => {
  assert.equal(
    failureReason({ error: { code: 429, message: 'Quota exceeded' } }),
    'Quota exceeded',
  );
  assert.equal(
    failureReason({ response: { candidates: [{ finishReason: 'IMAGE_SAFETY' }] } }),
    'kein Bild (IMAGE_SAFETY)',
  );
  assert.equal(
    failureReason({ response: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } }),
    'Prompt abgelehnt (PROHIBITED_CONTENT)',
  );
  assert.equal(
    failureReason({ response: { candidates: [{ finishReason: 'STOP' }] } }),
    'Antwort ohne Bild',
  );
  assert.equal(failureReason(undefined), 'Antwort ohne Bild');
});

test('createMutex: Aufgaben laufen nacheinander, auch nach einem Fehler', async () => {
  const run = createMutex();
  const order = [];
  const task = (id, ms, fail) => async () => {
    order.push(`start ${id}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`ende ${id}`);
    if (fail) throw new Error(id);
    return id;
  };
  const a = run(task('a', 20));
  const b = run(task('b', 5, true));
  const c = run(task('c', 1));
  assert.equal(await a, 'a');
  await assert.rejects(b, /b/);
  assert.equal(await c, 'c');
  assert.deepEqual(order, ['start a', 'ende a', 'start b', 'ende b', 'start c', 'ende c']);
});

const removalJobs = () => [
  {
    name: 'batches/ok',
    state: 'JOB_STATE_SUCCEEDED',
    images: [{ fileName: 'ok_0.png' }, { fileName: 'ok_1.png' }],
  },
  { name: 'batches/leer', state: 'JOB_STATE_FAILED', images: [] },
  { name: 'batches/laeuft', state: 'JOB_STATE_RUNNING', images: [] },
  {
    name: 'batches/weg',
    state: 'JOB_STATE_SUCCEEDED',
    removed: true,
    images: [{ fileName: 'weg_0.png' }],
  },
];

test('planJobRemoval: Bilder behalten -> Auftrag versteckt, leere Aufträge ganz weg, laufende bleiben', () => {
  const input = removalJobs();
  const plan = planJobRemoval(
    input,
    ['batches/ok', 'batches/leer', 'batches/laeuft', 'batches/unbekannt'],
    { now: '2026-11-27T19:00:00.000Z' },
  );
  assert.deepEqual(plan.removed, ['batches/ok', 'batches/leer']);
  assert.deepEqual(plan.skipped, [
    { name: 'batches/laeuft', reason: 'läuft noch' },
    { name: 'batches/unbekannt', reason: 'nicht gefunden' },
  ]);
  assert.deepEqual(plan.filesToDelete, []);
  assert.deepEqual(
    plan.jobs.map((j) => [j.name, j.removed === true]),
    [
      ['batches/ok', true],
      ['batches/laeuft', false],
      ['batches/weg', true],
    ],
  );
  // Bilder (inkl. Metadaten) bleiben am Auftrag, Eingabe wird nicht verändert
  assert.equal(plan.jobs[0].images.length, 2);
  assert.equal(plan.jobs[0].removedAt, '2026-11-27T19:00:00.000Z');
  assert.equal(input[0].removed, undefined);
  assert.deepEqual(
    plan.jobs.filter(isListedJob).map((j) => j.name),
    ['batches/laeuft'],
  );
});

test('planJobRemoval: mit Bildern löschen -> Auftrag weg, Dateien zum Löschen', () => {
  const jobs = removalJobs();
  // Gleiche Datei in einem anderen, verbleibenden Auftrag: nicht löschen
  jobs[2].images = [{ fileName: 'ok_1.png' }];
  const plan = planJobRemoval(jobs, ['batches/ok', 'batches/weg'], { deleteImages: true });
  assert.deepEqual(plan.removed, ['batches/ok']);
  assert.deepEqual(plan.skipped, [{ name: 'batches/weg', reason: 'nicht gefunden' }]);
  assert.deepEqual(plan.filesToDelete, ['ok_0.png']);
  assert.deepEqual(
    plan.jobs.map((j) => j.name),
    ['batches/leer', 'batches/laeuft', 'batches/weg'],
  );
  assert.deepEqual(planJobRemoval(undefined, undefined), {
    jobs: [],
    removed: [],
    skipped: [],
    filesToDelete: [],
  });
});
