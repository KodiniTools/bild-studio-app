import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlight, settlesWithin } from '../lib/refresh.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('createSingleFlight: parallele Aufrufe teilen sich einen Durchgang', async () => {
  let runs = 0;
  const run = createSingleFlight(async () => {
    runs += 1;
    await sleep(20);
  });
  const first = run();
  assert.equal(run(), first);
  await Promise.all([first, run(), run()]);
  assert.equal(runs, 1);

  // Nach Abschluss startet ein neuer Durchgang
  await run();
  assert.equal(runs, 2);
});

test('createSingleFlight: nach einem Fehler ist ein neuer Durchgang möglich', async () => {
  let runs = 0;
  const run = createSingleFlight(async () => {
    runs += 1;
    if (runs === 1) throw new Error('kaputt');
  });
  await assert.rejects(run(), /kaputt/);
  await run();
  assert.equal(runs, 2);
});

test('settlesWithin: true bei rechtzeitigem Ende, false bei Überschreitung', async () => {
  assert.equal(await settlesWithin(sleep(5), 200), true);
  assert.equal(await settlesWithin(sleep(200), 5), false);
});

test('settlesWithin: Fehler innerhalb der Frist wird weitergereicht', async () => {
  await assert.rejects(settlesWithin(Promise.reject(new Error('x')), 50), /x/);
});

test('settlesWithin: später Fehler nach Fristablauf bleibt ohne unhandledRejection', async () => {
  let unhandled = 0;
  const onUnhandled = () => (unhandled += 1);
  process.on('unhandledRejection', onUnhandled);
  const late = sleep(20).then(() => {
    throw new Error('spät');
  });
  assert.equal(await settlesWithin(late, 5), false);
  await sleep(50);
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, 0);
});
