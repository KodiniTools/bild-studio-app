import 'dotenv/config';
import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';

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

const client = new GoogleGenAI({});
const JOBS_FILE = './batch_jobs.json';
const IMAGES_DIR = './public/images';

// Endzustände eines Batch-Jobs: werden nicht erneut bei der API abgefragt
const TERMINAL_STATES = new Set([
  'JOB_STATE_SUCCEEDED',
  'JOB_STATE_FAILED',
  'JOB_STATE_CANCELLED',
  'JOB_STATE_EXPIRED',
]);

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const extForMime = (mimeType) => EXT_BY_MIME[mimeType] || 'png';

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
if (!fs.existsSync(JOBS_FILE)) fs.writeFileSync(JOBS_FILE, JSON.stringify([], null, 2));

const readJobs = () => JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
const saveJobs = (jobs) => fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));

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

    res.json({
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
app.get('/api/batch/status', async (req, res) => {
  try {
    const jobs = readJobs();
    let updated = false;

    for (const job of jobs) {
      if (TERMINAL_STATES.has(job.state)) continue;

      // Ein fehlerhafter Job darf die Statusabfrage der übrigen nicht blockieren
      let remoteJob;
      try {
        remoteJob = await client.batches.get({ name: job.name });
      } catch (error) {
        console.error(`Fehler bei Statusabfrage von ${job.name}:`, error);
        continue;
      }

      if (remoteJob.state !== job.state) {
        job.state = remoteJob.state;
        updated = true;
      }

      if (remoteJob.state === 'JOB_STATE_SUCCEEDED' && remoteJob.dest?.inlinedResponses && job.images.length === 0) {
        // Inline-Antworten tragen keinen Key -> Dateiname aus Job-ID + Position
        const jobId = job.name.replace(/\W/g, '_');
        remoteJob.dest.inlinedResponses.forEach((item, index) => {
          const part = findImagePart(item.response);
          if (!part) {
            console.error(`Kein Bild für Anfrage ${index} in ${job.name}:`, item.error ?? 'leere Antwort');
            return;
          }
          const fileName = `${jobId}_${index}.${extForMime(part.inlineData.mimeType)}`;
          fs.writeFileSync(
            path.join(IMAGES_DIR, fileName),
            Buffer.from(part.inlineData.data, 'base64')
          );
          job.images.push({
            imageUrl: `images/${fileName}`,
            fileName,
            metadata: null,
          });
        });
        updated = true;
      }
    }

    if (updated) saveJobs(jobs);
    res.json(jobs);
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
      5. Category: Best matching Adobe Stock category (e.g., Landscapes, Business, Technology, Abstract, Food, Lifestyle, Architecture).
    `;

    const response = await client.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
            category: { type: Type.STRING },
            complianceWarning: { type: Type.STRING },
          },
          required: ['title', 'keywords', 'category', 'complianceWarning'],
        },
      },
    });

    const metadata = JSON.parse(response.text);

    // Metadaten dauerhaft im Batch-Job speichern, falls zugehörig
    if (jobName) {
      const jobs = readJobs();
      const job = jobs.find((j) => j.name === jobName);
      const img = job?.images.find((i) => i.fileName === safeFileName);
      if (img) {
        img.metadata = metadata;
        saveJobs(jobs);
      }
    }

    res.json(metadata);
  } catch (error) {
    console.error('Fehler bei Metadaten-Generierung:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Gemini Studio Server läuft auf http://127.0.0.1:${PORT}`);
});
