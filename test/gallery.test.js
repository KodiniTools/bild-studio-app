import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNCATEGORIZED,
  buildGalleryImages,
  folderDirName,
  folderSlug,
  imageCategoryId,
  inFolder,
  parseFolder,
} from '../lib/gallery.js';

test('imageCategoryId: gespeicherte Nummer, offizieller Name, alter Alias, nichts', () => {
  assert.equal(imageCategoryId({ category: 'Landscapes', categoryId: 11 }), 11);
  assert.equal(imageCategoryId({ category: 'Lifestyle' }), 12);
  // Alter freier Name ohne Nummer: wie in der CSV über den Alias abgeleitet
  assert.equal(imageCategoryId({ category: 'Nature' }), 5);
  assert.equal(imageCategoryId({ category: 'Irgendwas' }), null);
  assert.equal(imageCategoryId(null), null);
  assert.equal(imageCategoryId(undefined), null);
});

test('buildGalleryImages: Sofort- und Batch-Bilder, neueste zuerst, Batch-Reihenfolge bleibt', () => {
  const singles = [
    { fileName: 'single_3.png', imageUrl: 'images/single_3.png', createdAt: 3000, prompt: 'p3' },
    {
      fileName: 'single_1.png',
      imageUrl: 'images/single_1.png',
      createdAt: 1000,
      metadata: { category: 'Food', categoryId: 7 },
    },
  ];
  const jobs = [
    {
      name: 'batches/a',
      createdAt: new Date(2000).toISOString(),
      images: [
        {
          fileName: 'batches_a_0.png',
          imageUrl: 'images/batches_a_0.png',
          prompt: 'x',
          metadata: null,
        },
        {
          fileName: 'batches_a_1.png',
          imageUrl: 'images/batches_a_1.png',
          metadata: { category: 'Nature' },
        },
      ],
    },
    { name: 'batches/leer', createdAt: 'kaputt' },
  ];

  const images = buildGalleryImages({ jobs, singles });
  assert.deepEqual(
    images.map((i) => i.fileName),
    ['single_3.png', 'batches_a_0.png', 'batches_a_1.png', 'single_1.png'],
  );
  const [s3, b0, b1, s1] = images;
  assert.equal(s3.source, 'single');
  assert.equal(s3.jobName, null);
  assert.equal(s3.categoryId, null);
  assert.equal(b0.source, 'batch');
  assert.equal(b0.jobName, 'batches/a');
  assert.equal(b1.categoryId, 5);
  assert.equal(s1.categoryId, 7);
  // Gespeicherte Daten werden nicht verändert (keine Kategorie nachgetragen)
  assert.equal(jobs[0].images[1].metadata.categoryId, undefined);
});

test('buildGalleryImages: leere Eingaben', () => {
  assert.deepEqual(buildGalleryImages({}), []);
  assert.deepEqual(buildGalleryImages({ jobs: [{ name: 'x' }], singles: [] }), []);
});

test('parseFolder / inFolder', () => {
  assert.equal(parseFolder(undefined), 'all');
  assert.equal(parseFolder('all'), 'all');
  assert.equal(parseFolder('none'), UNCATEGORIZED);
  assert.equal(parseFolder('11'), 11);
  assert.equal(parseFolder('0'), null);
  assert.equal(parseFolder('22'), null);
  assert.equal(parseFolder('abc'), null);
  assert.equal(parseFolder(['1', '2']), null);

  const cat = { categoryId: 11 };
  const none = { categoryId: null };
  assert.ok(inFolder(cat, 'all') && inFolder(none, 'all'));
  assert.ok(inFolder(cat, 11) && !inFolder(cat, 12) && !inFolder(cat, 'none'));
  assert.ok(inFolder(none, 'none') && !inFolder(none, 11));
});

test('Ordnernamen im ZIP', () => {
  assert.equal(folderDirName(11), '11_Landscapes');
  assert.equal(folderDirName(2), '02_Buildings_and_Architecture');
  assert.equal(folderDirName(null), 'Ohne_Kategorie');
  assert.equal(folderSlug('all'), 'alle');
  assert.equal(folderSlug('none'), 'ohne_kategorie');
  assert.equal(folderSlug(5), '05_The_Environment');
});
