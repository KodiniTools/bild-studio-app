import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADOBE_CATEGORIES,
  buildAdobeCsv,
  categoryIdFor,
  categoryName,
  csvFileName,
  hasComplianceWarning,
  isExportExcluded,
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
      '"a.png","Ein ""Titel"", mit Komma","x, y","11",""',
      '"c.png","Alt","z","8",""',
      '"d.png","Neu","","3",""',
      '"e.png","Ohne","","",""',
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
  assert.match(csv, /"ok\.jpg"/);
  assert.match(csv, /"trotzdem\.jpg"/);
  assert.doesNotMatch(csv, /logo\.jpg|manuell\.jpg/);
  // Nur ausgeschlossene Bilder -> keine CSV
  assert.equal(buildAdobeCsv({ images: [job.images[1], job.images[3]] }), null);
});
