import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchFileName, batchImageIndex, failureReason } from '../lib/batch.js';
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
