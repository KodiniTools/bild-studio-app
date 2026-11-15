import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectImageType, uploadFileName } from '../lib/upload.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

test('detectImageType: erkennt PNG, JPEG, WebP an den ersten Bytes', () => {
  assert.equal(detectImageType(PNG), 'image/png');
  assert.equal(detectImageType(JPEG), 'image/jpeg');
  assert.equal(detectImageType(WEBP), 'image/webp');
});

test('detectImageType: lehnt andere Inhalte ab', () => {
  assert.equal(detectImageType(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(detectImageType(Buffer.from('GIF89a......')), null);
  assert.equal(detectImageType(Buffer.alloc(0)), null);
  assert.equal(detectImageType(PNG.subarray(0, 5)), null);
  assert.equal(detectImageType('kein Buffer'), null);
  assert.equal(detectImageType(undefined), null);
});

test('uploadFileName: vereinfacht Namen, Endung aus dem Bildtyp', () => {
  assert.equal(uploadFileName('Möwe am Strand.JPG', 'image/jpeg'), 'Moewe_am_Strand.jpg');
  assert.equal(uploadFileName('Straße (1).jpeg', 'image/jpeg'), 'Strasse_1.jpg');
  assert.equal(uploadFileName('café.png', 'image/png'), 'cafe.png');
  // Falsche Endung: der echte Inhalt zählt
  assert.equal(uploadFileName('foto.png', 'image/jpeg'), 'foto.jpg');
  assert.equal(uploadFileName('ohne-endung', 'image/webp'), 'ohne-endung.webp');
});

test('uploadFileName: keine Pfadanteile, versteckten Dateien oder leeren Namen', () => {
  assert.equal(uploadFileName('../../etc/passwd.png', 'image/png'), 'passwd.png');
  assert.equal(uploadFileName('C:\\Users\\x\\Bild.png', 'image/png'), 'Bild.png');
  assert.equal(uploadFileName('.versteckt.png', 'image/png'), 'versteckt.png');
  assert.equal(uploadFileName('', 'image/png'), 'upload.png');
  assert.equal(uploadFileName(undefined, 'image/png'), 'upload.png');
  assert.equal(uploadFileName('日本.jpg', 'image/jpeg'), 'upload.jpg');
  const long = uploadFileName(`${'a'.repeat(300)}.jpg`, 'image/jpeg');
  assert.equal(long, `${'a'.repeat(80)}.jpg`);
  // Passt zum Dateinamen-Muster des Servers (IMAGE_FILE_RE)
  for (const name of ['x y.png', '-a.png', '___.png', 'ä.png']) {
    assert.match(uploadFileName(name, 'image/png'), /^[\w-][\w.-]*\.(png|jpe?g|webp)$/i);
  }
});

test('uploadFileName: hängt bei belegtem Namen _2, _3 ... an', () => {
  const taken = new Set(['foto.jpg', 'foto_2.jpg']);
  assert.equal(
    uploadFileName('foto.jpg', 'image/jpeg', (n) => taken.has(n)),
    'foto_3.jpg',
  );
  assert.equal(
    uploadFileName('foto.jpg', 'image/png', (n) => taken.has(n)),
    'foto.png',
  );
});

test('uploadFileName: unbekannter Typ wirft', () => {
  assert.throws(() => uploadFileName('x.gif', 'image/gif'));
});
