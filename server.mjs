/**
 * server.mjs — UI web para la máquina de carruseles
 *
 * Uso:
 *   node server.mjs
 *
 * Variables de entorno:
 *   PORT             — puerto del server (default 3000)
 *   APP_USER         — usuario para HTTP Basic Auth (default "squad")
 *   APP_PASSWORD     — contraseña para HTTP Basic Auth (requerida)
 *   BLACKBOX_API_KEY — necesaria para que crear.mjs/analizar.mjs funcionen
 */

import express from 'express';
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '5mb' }));

const APP_USER = process.env.APP_USER || 'squad';
const APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD) {
  throw new Error('Falta la variable de entorno APP_PASSWORD');
}

app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Carrusel Generator"');
    return res.status(401).send('Autenticación requerida');
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user !== APP_USER || pass !== APP_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Carrusel Generator"');
    return res.status(401).send('Credenciales inválidas');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/tandas', express.static(path.join(__dirname, 'tandas')));
app.use('/marcas', express.static(path.join(__dirname, 'marcas')));

function isValidMarcaId(id) {
  return typeof id === 'string' && /^[a-z0-9_-]+$/i.test(id);
}

// ─────────────────────────────────────────────────────────────────────
// Job runner — una generación a la vez, log en vivo vía SSE
// ─────────────────────────────────────────────────────────────────────
let jobRunning = false;
let jobLog = [];
let jobClients = [];

function broadcast(line) {
  jobLog.push(line);
  if (jobLog.length > 2000) jobLog = jobLog.slice(-2000);
  jobClients.forEach((res) => res.write(`data: ${JSON.stringify(line)}\n\n`));
}

function runStep(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', args, { cwd: __dirname });
    proc.stdout.on('data', (d) => broadcast(d.toString()));
    proc.stderr.on('data', (d) => broadcast(d.toString()));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} → exit ${code}`))));
  });
}

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

app.get('/api/job/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  jobLog.forEach((line) => res.write(`data: ${JSON.stringify(line)}\n\n`));
  jobClients.push(res);
  req.on('close', () => { jobClients = jobClients.filter((c) => c !== res); });
});

app.get('/api/job/status', (req, res) => {
  res.json({ running: jobRunning });
});

app.post('/api/generar', async (req, res) => {
  if (jobRunning) return res.status(409).json({ error: 'Ya hay una generación en curso' });
  const tema = (req.body.tema || '').trim();
  const marcaId = req.body.marca || 'squadteam';
  if (!tema) return res.status(400).json({ error: 'Falta el tema' });
  if (!isValidMarcaId(marcaId)) return res.status(400).json({ error: 'Marca inválida' });

  jobRunning = true;
  jobLog = [];
  res.json({ ok: true });

  (async () => {
    try {
      const carpeta = path.join('tandas', `${Date.now()}_${slugify(tema)}`);
      broadcast(`\n=== Generando: ${tema} (marca: ${marcaId}) ===\n`);
      await runStep(['crear.mjs', tema, carpeta, marcaId]);
      await runStep(['analizar.mjs', `${carpeta}/contenido.json`]);
      await runStep(['generar.mjs', `${carpeta}/contenido.analizado.json`]);
      broadcast(`\n✅ Listo: ${carpeta}\n`);
    } catch (e) {
      broadcast(`\n❌ Error: ${e.message}\n`);
    } finally {
      jobRunning = false;
    }
  })();
});

app.post('/api/lote', async (req, res) => {
  if (jobRunning) return res.status(409).json({ error: 'Ya hay una generación en curso' });
  const minutos = Number(req.body.minutos) || 45;
  const marcaId = req.body.marca || 'squadteam';
  if (!isValidMarcaId(marcaId)) return res.status(400).json({ error: 'Marca inválida' });

  jobRunning = true;
  jobLog = [];
  res.json({ ok: true });

  (async () => {
    try {
      await runStep(['lote.mjs', marcaId, String(minutos)]);
    } catch (e) {
      broadcast(`\n❌ Error: ${e.message}\n`);
    } finally {
      jobRunning = false;
    }
  })();
});

// ─────────────────────────────────────────────────────────────────────
// Marcas — perfiles de marca, temas y logo por marca
// ─────────────────────────────────────────────────────────────────────
app.get('/api/marcas', async (req, res) => {
  const dir = path.join(__dirname, 'marcas');
  let folders;
  try {
    folders = await readdir(dir);
  } catch {
    return res.json([]);
  }

  const items = [];
  for (const id of folders) {
    let nombre = id;
    try {
      const marca = JSON.parse(await readFile(path.join(dir, id, 'marca.json'), 'utf-8'));
      nombre = marca.nombre || id;
    } catch {}
    let logo = null;
    try {
      await readFile(path.join(dir, id, 'logo.png'));
      logo = `/marcas/${id}/logo.png`;
    } catch {}
    items.push({ id, nombre, logo });
  }
  res.json(items);
});

app.post('/api/marcas', async (req, res) => {
  const { id, nombre } = req.body;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Id de marca inválido (solo letras, números, - y _)' });

  const dir = path.join(__dirname, 'marcas', id);
  try {
    await readFile(path.join(dir, 'marca.json'));
    return res.status(409).json({ error: 'Ya existe una marca con ese id' });
  } catch {}

  await mkdir(path.join(dir, 'referencias'), { recursive: true });
  await writeFile(path.join(dir, 'marca.json'), JSON.stringify({
    nombre: nombre || id,
    industria: '', producto: '', audiencia: '', nivel_consciencia: 'problem-aware',
    diferenciador: '', posicionamiento: '', voz: '', evitar: [],
    paleta_marca: { fondo: '#040404', acento: '#e8ff00', descripcion: '' }
  }, null, 2), 'utf-8');
  await writeFile(path.join(dir, 'temas.json'), '[]\n', 'utf-8');

  res.json({ ok: true });
});

app.get('/api/marcas/:id/marca', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  try {
    const marca = JSON.parse(await readFile(path.join(__dirname, 'marcas', id, 'marca.json'), 'utf-8'));
    res.json(marca);
  } catch {
    res.status(404).json({ error: 'Marca no encontrada' });
  }
});

app.put('/api/marcas/:id/marca', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  await writeFile(path.join(__dirname, 'marcas', id, 'marca.json'), JSON.stringify(req.body, null, 2), 'utf-8');
  res.json({ ok: true });
});

app.get('/api/marcas/:id/temas', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  try {
    const temas = JSON.parse(await readFile(path.join(__dirname, 'marcas', id, 'temas.json'), 'utf-8'));
    res.json(temas);
  } catch {
    res.json([]);
  }
});

app.put('/api/marcas/:id/temas', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  const temas = req.body;
  if (!Array.isArray(temas) || !temas.every((t) => typeof t === 'string' && t.trim())) {
    return res.status(400).json({ error: 'Debe ser un array de strings no vacíos' });
  }
  await writeFile(path.join(__dirname, 'marcas', id, 'temas.json'), JSON.stringify(temas, null, 2), 'utf-8');
  res.json({ ok: true });
});

// Logo: subida como data URL (base64) en JSON, se guarda como marcas/<id>/logo.png
app.post('/api/marcas/:id/logo', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  const { dataUrl } = req.body;
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return res.status(400).json({ error: 'dataUrl inválida (debe ser PNG/JPG/WEBP en base64)' });

  await writeFile(path.join(__dirname, 'marcas', id, 'logo.png'), Buffer.from(match[2], 'base64'));
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// Galería de carruseles generados
// ─────────────────────────────────────────────────────────────────────
app.get('/api/tandas', async (req, res) => {
  const dir = path.join(__dirname, 'tandas');
  let folders;
  try {
    folders = await readdir(dir);
  } catch {
    return res.json([]);
  }

  const items = [];
  for (const f of folders) {
    const outDir = path.join(dir, f, 'output');
    let slides;
    try {
      slides = (await readdir(outDir)).filter((x) => x.endsWith('.png')).sort();
    } catch {
      continue;
    }
    if (!slides.length) continue;

    let tema = f;
    try {
      const contenido = JSON.parse(await readFile(path.join(dir, f, 'contenido.json'), 'utf-8'));
      const cover = contenido.slides?.find((s) => s.type === 'cover');
      tema = (cover?.headline || tema).replace(/\n/g, ' ');
    } catch {}

    let slideUrls;
    try {
      slideUrls = JSON.parse(await readFile(path.join(outDir, 'cloudinary.json'), 'utf-8'));
    } catch {
      slideUrls = slides.map((s) => `/tandas/${f}/output/${s}`);
    }

    const ts = Number(f.split('_')[0]) || 0;
    items.push({ id: f, tema, ts, slides: slideUrls });
  }

  items.sort((a, b) => b.ts - a.ts);
  res.json(items);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎬 Carrusel Generator UI → http://localhost:${PORT}`));
