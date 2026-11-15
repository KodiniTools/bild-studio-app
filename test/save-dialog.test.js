import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import vm from 'node:vm';

// public/common.js ist ein klassisches Browser-Script: in einer Sandbox mit
// nachgebautem window/fetch ausführen und die globalen Funktionen testen.
const source = fs.readFileSync(new URL('../public/common.js', import.meta.url), 'utf-8');

function load({ picker, fetchImpl } = {}) {
  const window = picker ? { showSaveFilePicker: picker } : {};
  const ctx = { window, fetch: fetchImpl ?? (() => assert.fail('fetch unerwartet')) };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx;
}

const domError = (name) => Object.assign(new Error(name), { name });

function fakeHandle(name) {
  const written = [];
  const state = { closed: false, aborted: false, written };
  const handle = {
    name,
    state,
    createWritable: async () =>
      new WritableStream({
        write: (chunk) => written.push(Buffer.from(chunk).toString()),
        close: () => (state.closed = true),
        abort: () => (state.aborted = true),
      }),
  };
  return handle;
}

test('ohne showSaveFilePicker: Rückfall auf bisherigen Download, kein fetch', async () => {
  const ctx = load();
  let called = 0;
  const result = await ctx.saveWithDialog('api/images/zip', 'a.zip', () => called++);
  assert.equal(result, null);
  assert.equal(called, 1);
});

test('Dialog abgebrochen: nichts laden, kein Fehler', async () => {
  const ctx = load({ picker: async () => Promise.reject(domError('AbortError')) });
  assert.equal(await ctx.saveWithDialog('api/images/zip', 'a.zip', () => assert.fail()), null);
});

test('SecurityError (z. B. iframe): Rückfall auf bisherigen Download', async () => {
  const ctx = load({ picker: async () => Promise.reject(domError('SecurityError')) });
  let called = 0;
  await ctx.saveWithDialog('api/images/zip', 'a.zip', () => called++);
  assert.equal(called, 1);
});

test('Erfolg: Dateiname und Typ vorgeschlagen, Inhalt in gewählte Datei geschrieben', async () => {
  const handle = fakeHandle('mein_name.zip');
  let options;
  const ctx = load({
    picker: async (o) => ((options = o), handle),
    fetchImpl: async (url) => {
      assert.equal(url, 'api/gallery/zip?category=all');
      return new Response('ZIPDATEN');
    },
  });
  const saved = await ctx.saveWithDialog('api/gallery/zip?category=all', 'x.zip');
  assert.equal(saved, 'mein_name.zip');
  assert.equal(options.suggestedName, 'x.zip');
  assert.deepEqual(JSON.parse(JSON.stringify(options.types)), [
    { description: 'ZIP-Archiv', accept: { 'application/zip': ['.zip'] } },
  ]);
  assert.equal(handle.state.written.join(''), 'ZIPDATEN');
  assert.equal(handle.state.closed, true);
});

test('unbekannte Endung: Dialog ohne Typfilter', async () => {
  let options;
  const ctx = load({
    picker: async (o) => ((options = o), fakeHandle('x')),
    fetchImpl: async () => new Response('x'),
  });
  await ctx.saveWithDialog('u', 'datei');
  assert.equal(options.types, undefined);
});

test('Serverfehler: Meldung aus JSON, gewählte Datei wird nicht angelegt', async () => {
  let created = false;
  const handle = { name: 'a.csv', createWritable: async () => ((created = true), null) };
  const ctx = load({
    picker: async () => handle,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: 'Keine Bilder für die CSV' }), { status: 404 }),
  });
  await assert.rejects(ctx.saveWithDialog('api/uploads/csv', 'a.csv'), /Keine Bilder für die CSV/);
  assert.equal(created, false);
});

test('Doppelklick: zweiter Aufruf öffnet keinen zweiten Dialog', async () => {
  let opened = 0;
  let resolvePicker;
  const ctx = load({
    picker: () => (opened++, new Promise((r) => (resolvePicker = r))),
    fetchImpl: async () => new Response('x'),
  });
  const first = ctx.saveWithDialog('u', 'a.zip');
  assert.equal(await ctx.saveWithDialog('u', 'a.zip'), null);
  resolvePicker(fakeHandle('a.zip'));
  assert.equal(await first, 'a.zip');
  assert.equal(opened, 1);
});
