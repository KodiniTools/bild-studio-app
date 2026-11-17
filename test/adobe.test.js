import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADOBE_CATEGORIES,
  buildAdobeCsv,
  exportFileNames,
  categoryIdFor,
  categoryName,
  csvFileName,
  hasComplianceWarning,
  isExportExcluded,
  planBulkExport,
} from '../lib/adobe.js';

test('21 Kategorien mit stabilen Eckwerten', () => {
  assert.equal(ADOBE_CATEGORIES.length, 21);
  assert.equal(categoryName(1), 'Animals');
  assert.equal(categoryName(11), 'Landscapes');
  assert.equal(categoryName(21), 'Travel');
  assert.equal(categoryName(0), null);
  assert.equal(categoryName(22), null);
});

test('jeder offizielle Name ergibt seine eigene Nummer', () => {
  ADOBE_CATEGORIES.forEach((name, i) => assert.equal(categoryIdFor(name), i + 1, name));
});

test('Schreibweisen, Aliase und Zahlen', () => {
  assert.equal(categoryIdFor('landscapes'), 11);
  assert.equal(categoryIdFor('  LANDSCAPE '), 11);
  assert.equal(categoryIdFor('Environment'), 5);
  assert.equal(categoryIdFor('the environment'), 5);
  assert.equal(categoryIdFor('Plants & Flowers'), 14);
  assert.equal(categoryIdFor('Architecture'), 2);
  assert.equal(categoryIdFor('Abstract'), 8);
  assert.equal(categoryIdFor(19), 19);
  assert.equal(categoryIdFor('7'), 7);
});

test('unbekannte oder ungültige Werte ergeben null', () => {
  for (const v of [undefined, null, '', 'Unbekannt', 0, 22, -1, 1.5, '99', {}]) {
    assert.equal(categoryIdFor(v), null, String(v));
  }
});

test('CSV: Spalten, Nummern, Quoting, Bilder ohne Metadaten', () => {
  const job = {
    images: [
      {
        fileName: 'a.png',
        metadata: { title: 'Ein "Titel", mit Komma', keywords: ['x', 'y'], category: 'Landscapes' },
      },
      { fileName: 'b.png', metadata: null },
      { fileName: 'c.png', metadata: { title: 'Alt', keywords: ['z'], category: 'Abstract' } },
      {
        fileName: 'd.png',
        metadata: { title: 'Neu', keywords: [], category: 'Food', categoryId: 3 },
      },
      { fileName: 'e.png', metadata: { title: 'Ohne', keywords: 'kaputt', category: 'Unbekannt' } },
    ],
  };
  assert.equal(
    buildAdobeCsv(job),
    [
      'Filename,Title,Keywords,Category,Releases',
      '"Ein_Titel_mit_Komma.png","Ein ""Titel"", mit Komma","x, y","11",""',
      '"Alt.png","Alt","z","8",""',
      '"Neu.png","Neu","","3",""',
      '"Ohne.png","Ohne","","",""',
    ].join('\n'),
  );
});

test('CSV ohne Metadaten ergibt null', () => {
  assert.equal(buildAdobeCsv({ images: [{ fileName: 'a.png', metadata: null }] }), null);
  assert.equal(buildAdobeCsv({}), null);
  assert.equal(buildAdobeCsv(undefined), null);
});

test('CSV-Dateiname', () => {
  assert.equal(csvFileName('batches/abc-1'), 'adobe_stock_batches_abc_1.csv');
});

test('Prüfhinweis: Platzhalter zählen nicht', () => {
  for (const v of [undefined, null, '', '  ', 'None', 'n/a', 'N/A.', 'keine', 'Nein', '-', '---']) {
    assert.equal(hasComplianceWarning(v), false, String(v));
  }
  assert.equal(hasComplianceWarning('Logo on laptop'), true);
});

test('Export-Ausschluss: eigene Entscheidung vor Prüfhinweis', () => {
  const warn = { complianceWarning: 'Watermark visible' };
  const ok = { complianceWarning: 'None' };
  assert.equal(isExportExcluded({ metadata: warn }), true);
  assert.equal(isExportExcluded({ metadata: ok }), false);
  assert.equal(isExportExcluded({ metadata: null }), false);
  assert.equal(isExportExcluded({ metadata: warn, exportExcluded: false }), false);
  assert.equal(isExportExcluded({ metadata: ok, exportExcluded: true }), true);
  assert.equal(isExportExcluded(undefined), false);
});

test('CSV lässt ausgeschlossene Bilder weg', () => {
  const meta = (complianceWarning) => ({
    title: 'T',
    keywords: ['k'],
    category: 'Food',
    complianceWarning,
  });
  const job = {
    images: [
      { fileName: 'ok.jpg', metadata: meta('None') },
      { fileName: 'logo.jpg', metadata: meta('Apple logo visible') },
      { fileName: 'trotzdem.jpg', metadata: meta('Watermark'), exportExcluded: false },
      { fileName: 'manuell.jpg', metadata: meta(''), exportExcluded: true },
    ],
  };
  const csv = buildAdobeCsv(job);
  // Gleicher Titel "T": Nummerierung nur unter den Bildern in der CSV
  assert.match(csv, /^"T\.jpg",/m);
  assert.match(csv, /^"T_2\.jpg",/m);
  assert.equal(csv.split('\n').length, 3);
  // Nur ausgeschlossene Bilder -> keine CSV
  assert.equal(buildAdobeCsv({ images: [job.images[1], job.images[3]] }), null);
});

test('Export-Dateinamen: nach Titel, Endung bleibt, Duplikate nummeriert', () => {
  const meta = (title) => ({ title, keywords: ['k'], category: 'Food' });
  const images = [
    { fileName: 'batches_abc_6.jpg', metadata: meta('Grandfather and Child Gardening') },
    { fileName: 'x.PNG', metadata: meta('Möwe am Strand: Sonnenuntergang!') },
    { fileName: 'y.png', metadata: meta('Möwe am Strand – Sonnenuntergang') },
    { fileName: 'ohne_meta.jpg', metadata: null },
    { fileName: 'leer.webp', metadata: meta('  ') },
    { fileName: 'raus.jpg', metadata: meta('Raus'), exportExcluded: true },
    { fileName: 'kollision.jpg', metadata: meta('ohne meta') },
  ];
  const names = exportFileNames(images);
  assert.deepEqual(Object.fromEntries(names), {
    'batches_abc_6.jpg': 'Grandfather_and_Child_Gardening.jpg',
    'x.PNG': 'Moewe_am_Strand_Sonnenuntergang.png',
    'y.png': 'Moewe_am_Strand_Sonnenuntergang_2.png',
    'leer.webp': 'leer.webp',
    // „ohne_meta.jpg“ behält seinen Namen, daher keine Kollision im ZIP
    'kollision.jpg': 'ohne_meta_2.jpg',
  });
  assert.deepEqual(Object.fromEntries(exportFileNames(undefined)), {});
});

test('Export-Dateinamen: CSV nutzt dieselben Namen wie das ZIP', () => {
  const images = [
    { fileName: 'a.jpg', metadata: { title: 'Gleich', keywords: [] } },
    { fileName: 'b.jpg', metadata: { title: 'Gleich', keywords: [] } },
  ];
  const names = exportFileNames(images);
  const csvNames = buildAdobeCsv({ images })
    .split('\n')
    .slice(1)
    .map((row) => JSON.parse(row.split(',')[0]));
  assert.deepEqual(csvNames, [names.get('a.jpg'), names.get('b.jpg')]);
  assert.deepEqual(csvNames, ['Gleich.jpg', 'Gleich_2.jpg']);
});

test('Sammel-Markierung: Alle markieren lässt Bilder mit Prüfhinweis aus', () => {
  const warn = { complianceWarning: 'Logo visible' };
  const images = [
    { fileName: 'a.jpg', metadata: null, exportExcluded: true }, // manuell aus -> an
    { fileName: 'b.jpg', metadata: null }, // schon im Export -> keine Änderung
    { fileName: 'c.jpg', metadata: warn }, // automatisch aus -> bleibt aus
    { fileName: 'd.jpg', metadata: warn, exportExcluded: true }, // manuell aus + Hinweis -> bleibt aus
    { fileName: 'e.jpg', metadata: warn, exportExcluded: false }, // bewusst an -> keine Änderung
    { fileName: 'a.jpg', metadata: null, exportExcluded: true }, // doppelt -> nur einmal
  ];
  assert.deepEqual(planBulkExport(images, true), {
    change: ['a.jpg'],
    skippedWarning: ['c.jpg', 'd.jpg'],
  });
});

test('Sammel-Markierung: Markierung aufheben schließt alle aktuell aufgenommenen aus', () => {
  const warn = { complianceWarning: 'Logo visible' };
  const images = [
    { fileName: 'a.jpg', metadata: null, exportExcluded: true },
    { fileName: 'b.jpg', metadata: null },
    { fileName: 'c.jpg', metadata: warn },
    { fileName: 'e.jpg', metadata: warn, exportExcluded: false },
  ];
  assert.deepEqual(planBulkExport(images, false), {
    change: ['b.jpg', 'e.jpg'],
    skippedWarning: [],
  });
  assert.deepEqual(planBulkExport(undefined, true), { change: [], skippedWarning: [] });
});
