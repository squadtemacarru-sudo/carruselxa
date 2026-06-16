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
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '20mb' }));

const APP_USER     = process.env.APP_USER || 'squad';
const APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD) throw new Error('Falta la variable de entorno APP_PASSWORD');

const FOTOS_DIR = path.join(__dirname, 'fotos');
await mkdir(FOTOS_DIR, { recursive: true });

// ── AUTH: token en cookie (no Basic Auth del browser) ──
const SESSION_TOKEN = Buffer.from(`${APP_USER}:${APP_PASSWORD}`).toString('base64');

// Login page — sin auth
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Carrusel Generator</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@1,900&family=Inter:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#040404;color:#fff;font-family:'Inter',sans-serif;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}
.box{width:100%;max-width:360px;display:flex;flex-direction:column;gap:20px}
h1{font-family:'Barlow Condensed',sans-serif;font-style:italic;font-weight:900;font-size:42px;letter-spacing:0.02em}
h1 em{color:#e8ff00;font-style:normal}
p{font-size:14px;color:#9090a8}
input{width:100%;background:#16181c;border:1px solid #1f1f24;border-radius:10px;color:#fff;padding:13px 14px;font-family:'Inter',sans-serif;font-size:15px;outline:none}
input:focus{border-color:#e8ff00}
button{width:100%;background:#e8ff00;color:#000;border:none;border-radius:10px;padding:14px;font-family:'Inter',sans-serif;font-weight:700;font-size:15px;cursor:pointer}
.err{color:#ff3f3f;font-size:13px;display:none}
</style>
</head>
<body>
<div class="box">
  <div>
    <h1>CARRUSEL<em>GEN</em></h1>
    <p style="margin-top:6px">Generador de carruseles con IA</p>
  </div>
  <form id="f" style="display:flex;flex-direction:column;gap:12px">
    <input id="u" type="text" placeholder="Usuario" autocomplete="username">
    <input id="p" type="password" placeholder="Contraseña" autocomplete="current-password">
    <p class="err" id="err">Usuario o contraseña incorrectos</p>
    <button type="submit">Entrar</button>
  </form>
</div>
<script>
$('#f','form') // placeholder
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({user: document.getElementById('u').value, pass: document.getElementById('p').value})
  });
  if (res.ok) { location.href = '/'; }
  else { document.getElementById('err').style.display = 'block'; }
});
</script>
</body>
</html>`);
});

app.post('/api/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (user === APP_USER && pass === APP_PASSWORD) {
    res.setHeader('Set-Cookie', `cg_session=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Credenciales inválidas' });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'cg_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

function authMiddleware(req, res, next) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
  if (cookies.cg_session === SESSION_TOKEN) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autenticado' });
  res.redirect('/login');
}

app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/tandas', express.static(path.join(__dirname, 'tandas')));
app.use('/marcas', express.static(path.join(__dirname, 'marcas')));
app.use('/fotos',  express.static(FOTOS_DIR));

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
      const fotos = Array.isArray(req.body.fotos) ? req.body.fotos.filter(f => EXT_RE.test(f)) : [];
      const crearArgs = ['crear.mjs', tema, carpeta, marcaId];
      if (fotos.length) crearArgs.push(fotos.join(','));
      await runStep(crearArgs);
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

// ─────────────────────────────────────────────────────────────────────
// Fotos
// ─────────────────────────────────────────────────────────────────────
const EXT_RE = /\.(jpe?g|png|webp)$/i;

// Listar fotos disponibles
app.get('/api/fotos', async (req, res) => {
  try {
    const files = (await readdir(FOTOS_DIR)).filter(f => EXT_RE.test(f) && !f.startsWith('.'));
    res.json(files.map(nombre => ({ nombre, url: `/fotos/${encodeURIComponent(nombre)}` })));
  } catch {
    res.json([]);
  }
});

// Subir foto — multipart/form-data con campo "foto"
app.post('/api/fotos', async (req, res) => {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) return res.status(400).json({ error: 'Se esperaba multipart/form-data' });

  const boundary = ct.split('boundary=')[1];
  if (!boundary) return res.status(400).json({ error: 'Falta boundary' });

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buf = Buffer.concat(chunks);

  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buf.indexOf(sep, start);
    if (idx === -1) break;
    parts.push(buf.slice(start, idx));
    start = idx + sep.length;
  }

  for (const part of parts) {
    const str = part.toString('binary');
    const headerEnd = str.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = str.slice(0, headerEnd);
    if (!headers.includes('filename')) continue;
    const match = /filename="([^"]+)"/.exec(headers);
    if (!match) continue;
    const filename = path.basename(match[1]);
    if (!EXT_RE.test(filename)) continue;
    const body = part.slice(headerEnd + 4, part.length - 2);
    await writeFile(path.join(FOTOS_DIR, filename), body);
    return res.json({ ok: true, nombre: filename });
  }
  res.status(400).json({ error: 'No se encontró archivo en el body' });
});

// Eliminar foto
app.delete('/api/fotos/:nombre', async (req, res) => {
  const nombre = path.basename(req.params.nombre);
  if (!EXT_RE.test(nombre)) return res.status(400).json({ error: 'Nombre inválido' });
  try {
    await unlink(path.join(FOTOS_DIR, nombre));
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'No encontrada' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎬 Carrusel Generator UI → http://localhost:${PORT}`));
