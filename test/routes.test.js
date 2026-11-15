import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';

const FRONTEND_FILES = ['public/index.html', 'public/galerie.html', 'public/common.js'];

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');

// Pfad-Muster vereinheitlichen: Query weg, ${...} bzw. :param -> :p
const normalize = (p) =>
  p
    .split('?')[0]
    .replace(/\$\{[^}]*\}/g, ':p')
    .replace(/:\w+/g, ':p');

test('jede API-Route, die das Frontend aufruft, gibt es im Backend', () => {
  const serverRoutes = new Set(
    [...read('server.js').matchAll(/app\.(?:get|post|delete|put)\(\s*'(\/api\/[^']+)'/g)].map((m) =>
      normalize(m[1].slice(1)),
    ),
  );
  const frontend = FRONTEND_FILES.map(read).join('\n');
  const frontendPaths = new Set(
    [...frontend.matchAll(/["'`](api\/[^"'`\s]+)/g)].map((m) => normalize(m[1])),
  );

  assert.ok(frontendPaths.has('api/batch/status'), 'Frontend-Pfade wurden nicht gefunden');
  for (const p of frontendPaths) {
    assert.ok(serverRoutes.has(p), `Frontend ruft ${p} auf, im Backend fehlt die Route`);
  }
});

test('Nginx-Snippet: /bild-studio/ hat Vorrang vor Regex-Locations', () => {
  const conf = read('deploy/bild-studio.nginx.conf');
  // Ohne ^~ kann eine Regex-Location (z. B. für .../status) einzelne API-Pfade abfangen
  assert.match(conf, /^location \^~ \/bild-studio\/ \{$/m);
  assert.doesNotMatch(conf, /^location \/bild-studio\/ \{$/m);
  // Slash am Ende: /bild-studio/api/x -> http://127.0.0.1:3018/api/x
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:\d+\/;/);
});

test('Frontend: Seiten verlinken sich und Ressourcen nur relativ (läuft unter /bild-studio/)', () => {
  for (const file of ['public/index.html', 'public/galerie.html']) {
    const html = read(file);
    // Kein führender Slash in href/src: sonst landet der Aufruf außerhalb von /bild-studio/
    assert.doesNotMatch(html, /\s(?:href|src)="\//, `${file}: absoluter Pfad gefunden`);
    assert.match(html, /<script src="common\.js"><\/script>/, `${file}: common.js fehlt`);
    assert.match(html, /href="style\.css"/, `${file}: style.css fehlt`);
    assert.match(html, /href="galerie\.html"/, `${file}: Link zur Galerie fehlt`);
    assert.match(html, /href="\.\/"/, `${file}: Link zur Startseite fehlt`);
  }
  for (const asset of ['public/common.js', 'public/style.css']) {
    assert.ok(fs.existsSync(new URL(`../${asset}`, import.meta.url)), `${asset} fehlt`);
  }
});
