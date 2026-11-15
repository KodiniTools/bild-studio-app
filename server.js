import 'dotenv/config';
import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import yazl from 'yazl';
import {
  ADOBE_CATEGORIES,
  buildAdobeCsv,
  categoryIdFor,
  categoryName,
  csvFileName,
} from './lib/adobe.js';
import {
  UNCATEGORIZED,
  UNCATEGORIZED_LABEL,
  buildGalleryImages,
  folderDirName,
  folderSlug,
  inFolder,
  parseFolder,
} from './lib/gallery.js';
import { createSingleFlight, settlesWithin } from './lib/refresh.js';

const app = express();
// Muss zum Nginx-Block passen: proxy_pass http://127.0.0.1:3018/
const PORT = Number(process.env.PORT) || 3018;

app.use(express.json());
app.use(express.static('public'));

// Prüfen, ob der API-Key geladen wurde
if (!process.env.GEMINI_API_KEY) {
  console.error('FEHLER: GEMINI_API_KEY fehlt in der .env-Datei!');
  process.exit(1);
}

// Das SDK (ab 3.x) nutzt standardmäßig API-Version 'v1'; Preview-Modelle wie
// gemini-3-pro-image-preview gibt es nur unter 'v1beta'. Ist GOOGLE_GENAI_API_VERSION
// gesetzt, löst das SDK die Version selbst auf (inkl. Alias 'beta').
const client = new GoogleGenAI({
  apiVersion: process.env.GOOGLE_GENAI_API_VERSION ? undefined : 'v1beta',
});
const JOBS_FILE = './batch_jobs.json';
const IMAGES_DIR = './public/images';

// Endzustände eines Batch-Jobs: werden nicht erneut bei der API abgefragt
const TERMINAL_STATES = new Set([
  'JOB_STATE_SUCCEEDED',
  'JOB_STATE_FAILED',
  'JOB_STATE_CANCELLED',
  'JOB_STATE_EXPIRED',
]);

// Statusabfrage: so lange wartet eine Anfrage höchstens auf Gemini, bevor sie den
// gespeicherten Stand liefert (deutlich unter dem Nginx-Timeout von 180 s)
const STATUS_WAIT_MS = 20_000;
// Obergrenze für eine einzelne Abfrage bei Gemini (inkl. Download fertiger Bilder)
const BATCH_GET_TIMEOUT_MS = 5 * 60_000;

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const extForMime = (mimeType) => EXT_BY_MIME[mimeType] || 'png';

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
if (!fs.existsSync(JOBS_FILE)) fs.writeFileSync(JOBS_FILE, JSON.stringify([], null, 2));

const readJobs = () => JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
const saveJobs = (jobs) => fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));

// Angaben zu Einzelbildern: { [fileName]: { prompt, model, imageSize, aspectRatio, createdAt, metadata } }
const SINGLES_FILE = './single_images.json';
const readSingles = () => {
  try {
    return JSON.parse(fs.readFileSync(SINGLES_FILE, 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
};
const saveSingles = (singles) => fs.writeFileSync(SINGLES_FILE, JSON.stringify(singles, null, 2));

const findImagePart = (response) =>
  response?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);

// ---------------------------------------------------------------------------
// 1. Sofort-Generierung (Einzelbild)
// ---------------------------------------------------------------------------
app.post('/api/generate-single', async (req, res) => {
  try {
    const {
      prompt,
      model = 'gemini-3-pro-image-preview',
      imageSize = '2K',
      aspectRatio = '3:2',
    } = req.body;

    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt darf nicht leer sein.' });
    }

    const response = await client.models.generateContent({
      model,
      contents: prompt,
      config: {
        imageConfig: {
          imageSize,
          aspectRatio,
        },
      },
    });

    const part = findImagePart(response);
    if (!part) return res.status(500).json({ error: 'Kein Bild von der API erhalten.' });

    const fileName = `single_${Date.now()}.${extForMime(part.inlineData.mimeType)}`;
    fs.writeFileSync(path.join(IMAGES_DIR, fileName), Buffer.from(part.inlineData.data, 'base64'));

    const singles = readSingles();
    singles[fileName] = {
      prompt,
      model,
      imageSize,
      aspectRatio,
      createdAt: new Date().toISOString(),
      metadata: null,
    };
    saveSingles(singles);

    res.json({
      prompt,
      // Relativ (ohne führenden Slash), damit die App unter /bild-studio/ funktioniert
      imageUrl: `images/${fileName}`,
      fileName,
      model,
      imageSize,
      aspectRatio,
    });
  } catch (error) {
    console.error('Fehler bei Einzelbild:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 2. Batch-Warteschlange absenden (50 % Rabatt)
// ---------------------------------------------------------------------------
app.post('/api/batch/start', async (req, res) => {
  try {
    const {
      prompts,
      model = 'gemini-3-pro-image-preview',
      imageSize = '2K',
      aspectRatio = '3:2',
    } = req.body;

    const cleanPrompts = Array.isArray(prompts)
      ? prompts.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
      : [];

    if (cleanPrompts.length === 0) {
      return res.status(400).json({ error: 'Keine Prompts in der Warteschlange.' });
    }

    // Inline-Requests im JS-SDK sind einfache GenerateContent-Objekte
    // (contents + config) – kein { key, request }-Wrapper wie im JSONL-Format.
    const inlinedRequests = cleanPrompts.map((text) => ({
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          imageSize,
          aspectRatio,
        },
      },
    }));

    const batchJob = await client.batches.create({
      model,
      src: inlinedRequests,
      config: { displayName: `studio-batch-${Date.now()}` },
    });

    const jobs = readJobs();
    jobs.unshift({
      name: batchJob.name,
      model,
      imageSize,
      aspectRatio,
      count: cleanPrompts.length,
      // Reihenfolge entspricht den Inline-Antworten -> Zuordnung Bild <-> Prompt per Index
      prompts: cleanPrompts,
      state: batchJob.state || 'JOB_STATE_PENDING',
      createdAt: new Date().toISOString(),
      images: [],
    });
    saveJobs(jobs);

    res.json({ success: true, jobName: batchJob.name });
  } catch (error) {
    console.error('Fehler bei Batch-Start:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 3. Batch-Status prüfen & fertige Bilder herunterladen
// ---------------------------------------------------------------------------
// Die Abfrage bei Gemini läuft höchstens einmal gleichzeitig. Bei fertigen Aufträgen
// enthält die Antwort alle Bilder (bei 4K sehr groß): parallele Abfragen desselben
// Auftrags haben den Prozess sonst mit CPU-/Speicherlast blockiert und abstürzen lassen.
const refreshBatchJobs = createSingleFlight(async () => {
  for (const { name, state } of readJobs()) {
    if (TERMINAL_STATES.has(state)) continue;

    // Ein fehlerhafter Job darf die Statusabfrage der übrigen nicht blockieren
    let remoteJob;
    try {
      remoteJob = await client.batches.get({
        name,
        config: { httpOptions: { timeout: BATCH_GET_TIMEOUT_MS } },
      });
    } catch (error) {
      console.error(`Fehler bei Statusabfrage von ${name}:`, error);
      continue;
    }

    // Datei erst jetzt neu lesen: während der Abfrage können Metadaten gespeichert,
    // Bilder gelöscht oder neue Aufträge angelegt worden sein
    const jobs = readJobs();
    const job = jobs.find((j) => j.name === name);
    if (!job) continue;

    let updated = false;
    if (remoteJob.state !== job.state) {
      job.state = remoteJob.state;
      updated = true;
    }

    if (
      remoteJob.state === 'JOB_STATE_SUCCEEDED' &&
      remoteJob.dest?.inlinedResponses &&
      job.images.length === 0
    ) {
      // Inline-Antworten tragen keinen Key -> Dateiname aus Job-ID + Position
      const jobId = job.name.replace(/\W/g, '_');
      remoteJob.dest.inlinedResponses.forEach((item, index) => {
        const part = findImagePart(item.response);
        if (!part) {
          console.error(
            `Kein Bild für Anfrage ${index} in ${job.name}:`,
            item.error ?? 'leere Antwort',
          );
          return;
        }
        const fileName = `${jobId}_${index}.${extForMime(part.inlineData.mimeType)}`;
        fs.writeFileSync(
          path.join(IMAGES_DIR, fileName),
          Buffer.from(part.inlineData.data, 'base64'),
        );
        job.images.push({
          imageUrl: `images/${fileName}`,
          fileName,
          prompt: job.prompts?.[index] ?? null,
          metadata: null,
        });
      });
      updated = true;
    }

    // Nach jedem Auftrag speichern, damit ein späterer Fehler den Fortschritt nicht verwirft
    if (updated) saveJobs(jobs);
  }
});

app.get('/api/batch/status', async (req, res) => {
  try {
    // Dauert die Abfrage länger (großer Download), läuft sie im Hintergrund weiter und
    // die Antwort enthält den gespeicherten Stand; der nächste Aufruf zeigt das Ergebnis
    const finished = await settlesWithin(refreshBatchJobs(), STATUS_WAIT_MS);
    if (!finished) res.set('X-Batch-Refresh', 'pending');
    res.json(readJobs());
  } catch (error) {
    console.error('Fehler bei Batch-Status:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 4. Adobe Stock Titel & 25 Keywords generieren (Gemini 3.8 Flash)
// ---------------------------------------------------------------------------
app.post('/api/adobe-metadata', async (req, res) => {
  try {
    const { fileName, jobName } = req.body;
    if (typeof fileName !== 'string' || !fileName) {
      return res.status(400).json({ error: 'fileName fehlt.' });
    }

    const safeFileName = path.basename(fileName);
    const fullPath = path.join(IMAGES_DIR, safeFileName);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Bilddatei nicht gefunden.' });
    }

    const imageBase64 = fs.readFileSync(fullPath).toString('base64');
    const mimeType = MIME_BY_EXT[path.extname(safeFileName).toLowerCase()] || 'image/png';

    const prompt = `
      Analyze this AI-generated image for commercial submission to Adobe Stock.
      Rules:
      1. English only.
      2. Title: Descriptive, max 70 characters, no special characters, no "AI generated" buzzwords.
      3. Keywords: Exactly 25 keywords ordered strictly by relevance (most important first).
      4. Strict Compliance: NEVER include brand names, trademarks, artist names, or celebrity names.
      5. Category: Exactly one of the official Adobe Stock categories listed in the schema; choose the best match.
    `;

    const response = await client.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: prompt }],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
            // Feste Auswahl: nur offizielle Adobe-Kategorien (für die Nummer in der CSV)
            category: { type: Type.STRING, format: 'enum', enum: [...ADOBE_CATEGORIES] },
            complianceWarning: { type: Type.STRING },
          },
          required: ['title', 'keywords', 'category', 'complianceWarning'],
        },
      },
    });

    const metadata = JSON.parse(response.text);
    // Nummer für die Adobe-CSV; offizieller Name, falls das Modell abweichend schreibt
    metadata.categoryId = categoryIdFor(metadata.category);
    if (metadata.categoryId) metadata.category = categoryName(metadata.categoryId);

    // Metadaten dauerhaft speichern: im Batch-Job bzw. bei den Einzelbildern
    if (jobName) {
      const jobs = readJobs();
      const job = jobs.find((j) => j.name === jobName);
      const img = job?.images.find((i) => i.fileName === safeFileName);
      if (img) {
        img.metadata = metadata;
        saveJobs(jobs);
      }
    } else {
      const singles = readSingles();
      // Auch ältere Einzelbilder ohne Eintrag bekommen einen (ohne Prompt)
      singles[safeFileName] = { ...(singles[safeFileName] || { prompt: null }), metadata };
      saveSingles(singles);
    }

    res.json(metadata);
  } catch (error) {
    console.error('Fehler bei Metadaten-Generierung:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 5. Bilder auflisten & löschen
// ---------------------------------------------------------------------------
// Nur einfache Dateinamen ohne Pfadanteile (schützt vor Path Traversal) und ohne
// führenden Punkt (versteckte Dateien werden weder gelistet noch ausgeliefert)
const IMAGE_FILE_RE = /^[\w-][\w.-]*\.(png|jpe?g|webp)$/i;
const isSafeImageName = (name) =>
  typeof name === 'string' && IMAGE_FILE_RE.test(name) && name === path.basename(name);

// Einzelbilder = alle Bilddateien, die zu keinem Batch-Job gehören (neueste zuerst)
const listSingleImages = () => {
  const jobFiles = new Set(readJobs().flatMap((j) => (j.images || []).map((i) => i.fileName)));
  const singles = readSingles();
  return fs
    .readdirSync(IMAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && isSafeImageName(d.name) && !jobFiles.has(d.name))
    .map((d) => {
      const info = singles[d.name] || {};
      return {
        fileName: d.name,
        imageUrl: `images/${d.name}`,
        createdAt: fs.statSync(path.join(IMAGES_DIR, d.name)).mtimeMs,
        prompt: info.prompt ?? null,
        model: info.model ?? null,
        imageSize: info.imageSize ?? null,
        aspectRatio: info.aspectRatio ?? null,
        metadata: info.metadata ?? null,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
};

/**
 * Streamt die angegebenen Bilder als ZIP-Download. Die Dateien werden unverändert
 * (Originalgröße, ohne Neukomprimierung) und unkomprimiert abgelegt: PNG/JPEG/WebP
 * sind bereits komprimiert, so bleibt der Download schnell.
 */

// Batch-Job aus ?job=... laden; sendet bei Fehler selbst die Antwort und liefert null
const findJobFromQuery = (req, res) => {
  const jobName = req.query.job;
  if (typeof jobName !== 'string' || !jobName) {
    res.status(400).json({ error: 'Parameter job fehlt.' });
    return null;
  }
  const job = readJobs().find((j) => j.name === jobName);
  if (!job) {
    res.status(404).json({ error: 'Batch-Auftrag nicht gefunden.' });
    return null;
  }
  return job;
};

/**
 * @param extraFiles zusätzliche Dateien im ZIP, z. B. [{ name: 'x.csv', content: '...' }]
 * @param entryName  Pfad im ZIP je Datei (Standard: Dateiname ohne Ordner)
 */
const sendImagesZip = (res, fileNames, zipName, extraFiles = [], entryName = (name) => name) => {
  const files = [...new Set(fileNames)].filter(
    (name) => isSafeImageName(name) && fs.existsSync(path.join(IMAGES_DIR, name)),
  );
  if (files.length === 0) {
    return res.status(404).json({ error: 'Keine Bilder zum Herunterladen vorhanden.' });
  }

  const zip = new yazl.ZipFile();
  for (const name of files) {
    zip.addFile(path.join(IMAGES_DIR, name), entryName(name), { compress: false });
  }
  for (const { name, content } of extraFiles) {
    zip.addBuffer(Buffer.from(content, 'utf-8'), name);
  }
  zip.end();

  res.attachment(zipName);
  res.type('application/zip');
  zip.outputStream.on('error', (error) => {
    console.error('Fehler beim Erstellen des ZIP:', error);
    res.destroy(error);
  });
  // Abbruch durch den Client: ZIP-Erzeugung nicht weiterlaufen lassen
  res.on('close', () => {
    if (!res.writableFinished) zip.outputStream.destroy();
  });
  zip.outputStream.pipe(res);
};

app.get('/api/images', (req, res) => {
  try {
    res.json(listSingleImages());
  } catch (error) {
    console.error('Fehler beim Auflisten der Bilder:', error);
    res.status(500).json({ error: error.message });
  }
});

// Alle Einzelbilder als ZIP
app.get('/api/images/zip', (req, res) => {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    sendImagesZip(
      res,
      listSingleImages().map((i) => i.fileName),
      `bild-studio_einzelbilder_${stamp}.zip`,
    );
  } catch (error) {
    console.error('Fehler beim ZIP-Download:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 6. Galerie: alle Bilder mit Adobe-Kategorie (nur gespeicherter Stand, keine Gemini-Abfrage)
// ---------------------------------------------------------------------------
const readGalleryImages = () =>
  buildGalleryImages({ jobs: readJobs(), singles: listSingleImages() });

app.get('/api/gallery', (req, res) => {
  try {
    const jobs = readJobs();
    res.json({
      images: buildGalleryImages({ jobs, singles: listSingleImages() }),
      categories: ADOBE_CATEGORIES.map((name, i) => ({ id: i + 1, name })),
      uncategorized: { id: UNCATEGORIZED, name: UNCATEGORIZED_LABEL },
      jobs: jobs.map((j) => ({
        name: j.name,
        state: j.state,
        count: j.count,
        imageSize: j.imageSize,
        aspectRatio: j.aspectRatio,
        createdAt: j.createdAt,
        imageCount: (j.images || []).length,
        metadataCount: (j.images || []).filter((i) => i.metadata).length,
      })),
    });
  } catch (error) {
    console.error('Fehler beim Laden der Galerie:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bilder eines Kategorie-Ordners als ZIP (?category=all|none|1..21), inkl. Adobe-CSV.
// Bei „all“ liegen die Bilder im ZIP in Unterordnern je Kategorie.
app.get('/api/gallery/zip', (req, res) => {
  try {
    const folder = parseFolder(req.query.category);
    if (folder === null) return res.status(400).json({ error: 'Ungültige Kategorie.' });

    const images = readGalleryImages().filter(
      (img) =>
        inFolder(img, folder) &&
        isSafeImageName(img.fileName) &&
        fs.existsSync(path.join(IMAGES_DIR, img.fileName)),
    );
    const dirByFile = new Map(images.map((img) => [img.fileName, folderDirName(img.categoryId)]));
    const slug = folderSlug(folder);
    const csv = buildAdobeCsv({ images });
    sendImagesZip(
      res,
      images.map((i) => i.fileName),
      `bild-studio_galerie_${slug}_${new Date().toISOString().slice(0, 10)}.zip`,
      csv ? [{ name: `adobe_stock_${slug}.csv`, content: csv }] : [],
      folder === 'all' ? (name) => `${dirByFile.get(name)}/${name}` : undefined,
    );
  } catch (error) {
    console.error('Fehler beim Galerie-ZIP:', error);
    res.status(500).json({ error: error.message });
  }
});

// Alle Bilder eines Batch-Jobs als ZIP (?job=batches/...)
// Enthält zusätzlich die Adobe-Stock-CSV, sobald mindestens ein Bild Metadaten hat
app.get('/api/batch/zip', (req, res) => {
  try {
    const job = findJobFromQuery(req, res);
    if (!job) return;

    const csv = buildAdobeCsv(job);
    sendImagesZip(
      res,
      (job.images || []).map((i) => i.fileName),
      `bild-studio_${job.name.replace(/\W/g, '_')}.zip`,
      csv ? [{ name: csvFileName(job.name), content: csv }] : [],
    );
  } catch (error) {
    console.error('Fehler beim ZIP-Download:', error);
    res.status(500).json({ error: error.message });
  }
});

// Adobe-Stock-CSV eines Batch-Auftrags (?job=batches/...)
app.get('/api/batch/csv', (req, res) => {
  try {
    const job = findJobFromQuery(req, res);
    if (!job) return;

    const csv = buildAdobeCsv(job);
    if (!csv) {
      return res.status(404).json({
        error: 'Bitte zuerst für mindestens ein Bild in diesem Batch die Adobe-Metadaten erzeugen.',
      });
    }
    res.attachment(csvFileName(job.name));
    res.type('text/csv; charset=utf-8');
    res.send(csv);
  } catch (error) {
    console.error('Fehler beim CSV-Export:', error);
    res.status(500).json({ error: error.message });
  }
});

// Liefert die Originaldatei als Download (Content-Disposition: attachment)
app.get('/api/images/:fileName/download', (req, res) => {
  const { fileName } = req.params;
  if (!isSafeImageName(fileName)) {
    return res.status(400).json({ error: 'Ungültiger Dateiname.' });
  }
  res.download(
    fileName,
    fileName,
    { root: path.resolve(IMAGES_DIR), dotfiles: 'deny' },
    (error) => {
      if (!error) return;
      if (res.headersSent) {
        console.error('Download abgebrochen:', error.message);
        return;
      }
      if (error.code === 'ENOENT' || (error.status >= 400 && error.status < 500)) {
        return res.status(404).json({ error: 'Bild nicht gefunden.' });
      }
      console.error('Fehler beim Download:', error);
      res.status(500).json({ error: 'Download fehlgeschlagen.' });
    },
  );
});

// Löscht die Datei und entfernt den Eintrag aus zugehörigen Batch-Jobs
app.delete('/api/images/:fileName', (req, res) => {
  try {
    const { fileName } = req.params;
    if (!isSafeImageName(fileName)) {
      return res.status(400).json({ error: 'Ungültiger Dateiname.' });
    }

    const jobs = readJobs();
    let jobsChanged = false;
    for (const job of jobs) {
      const before = job.images?.length ?? 0;
      job.images = (job.images || []).filter((i) => i.fileName !== fileName);
      if (job.images.length !== before) jobsChanged = true;
    }

    const singles = readSingles();
    const singlesChanged = fileName in singles;
    if (singlesChanged) delete singles[fileName];

    let fileExisted = true;
    try {
      fs.unlinkSync(path.join(IMAGES_DIR, fileName));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fileExisted = false;
    }

    if (jobsChanged) saveJobs(jobs);
    if (singlesChanged) saveSingles(singles);
    if (!fileExisted && !jobsChanged && !singlesChanged) {
      return res.status(404).json({ error: 'Bild nicht gefunden.' });
    }
    res.json({ deleted: fileName });
  } catch (error) {
    console.error('Fehler beim Löschen:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Gemini Studio Server läuft auf http://127.0.0.1:${PORT}`);
});
