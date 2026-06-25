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
import { readFile, writeFile, readdir, mkdir, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';

// Clientes SSE que se desconectan emiten ECONNRESET — no debe crashear el proceso
process.on('uncaughtException', (err) => {
  if (err.code === 'ECONNRESET' || err.message === 'aborted') return;
  console.error('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  if (reason?.code === 'ECONNRESET' || reason?.message === 'aborted') return;
  console.error('Unhandled rejection:', reason);
});

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
app.use('/stories', express.static(path.join(__dirname, 'stories')));

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
  jobClients = jobClients.filter(res => {
    try { res.write(`data: ${JSON.stringify(line)}\n\n`); return true; }
    catch { return false; }
  });
}

function runStep(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', args, { cwd: __dirname, env: { ...process.env, ...extraEnv } });
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
  jobLog.forEach((line) => { try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch {} });
  jobClients.push(res);
  const remove = () => { jobClients = jobClients.filter((c) => c !== res); };
  req.on('close', remove);
  res.on('error', remove);
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

      // Pasar solo nombres de archivo a crear.mjs — FOTOS_MAP resuelve URLs después.
      // Pasar URLs completas causaba que la IA las copiara mal en el JSON generado.
      const fotosRaw = Array.isArray(req.body.fotos) ? req.body.fotos.filter(f => EXT_RE.test(f)) : [];
      const fotos = fotosRaw; // filenames only

      // Construir env extra desde las respuestas del usuario
      const respuestas = req.body.respuestas || {};
      const instrLibres = (req.body.instruccionesLibres || '').trim();
      const extraEnv = {};

      const instrLines = [];
      if (respuestas.cover_headline) instrLines.push(`El headline del slide 1 (cover) DEBE ser exactamente: "${respuestas.cover_headline}" — no lo cambies ni reescribas.`);
      if (respuestas.overlay !== undefined) instrLines.push(`El campo "overlay" del JSON DEBE ser exactamente ${respuestas.overlay}`);
      if (respuestas.texto_size === 'Compacto') instrLines.push('Texto compacto: podés incluir más detalle, frases de 6-10 palabras, párrafos cortos');
      else if (respuestas.texto_size === 'Grande') instrLines.push('Texto grande: headlines de máximo 4-5 palabras, evitá párrafos largos, priorizá impacto visual');
      if (respuestas.tono) instrLines.push(`Tono del copy: ${respuestas.tono}`);
      for (const [id, val] of Object.entries(respuestas)) {
        if (['cover_headline', 'overlay', 'texto_size', 'tono', 'rotaciones'].includes(id)) continue;
        if (typeof val === 'string') instrLines.push(`${id.replace(/_/g, ' ')}: ${val}`);
      }
      if (instrLibres) instrLines.push(`Instrucción directa del usuario: "${instrLibres}"`);
      if (instrLines.length) extraEnv.USER_INSTRUCCIONES = instrLines.join('\n');
      if (respuestas.overlay !== undefined) extraEnv.USER_OVERLAY = String(respuestas.overlay);
      if (req.body.model) extraEnv.USER_MODEL = req.body.model;
      if (req.body.estiloId) extraEnv.USER_ESTILO_ID = req.body.estiloId;
      if (req.body.fuenteId) extraEnv.USER_FUENTE_ID = req.body.fuenteId;
      if (req.body.paletaId) extraEnv.USER_PALETA_ID = req.body.paletaId;

      // Preferencias de diseño guardadas para la marca (fuente, etc.)
      try {
        const diseno = JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'diseno.json'), 'utf-8'));
        if (diseno.font_pair_id) extraEnv.USER_FONT_PAIR = diseno.font_pair_id;
      } catch {}

      // Handle de Instagram de la marca
      try {
        const mData = JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'marca.json'), 'utf-8'));
        if (mData.handle) extraEnv.USER_HANDLE = mData.handle;
      } catch {}

      // Rotaciones: resolver nombres a URLs reales (igual que fotos)
      const rotacionesResueltas = {};
      for (const [nombre, grados] of Object.entries(respuestas.rotaciones || {})) {
        const realKey = fotosCloud.get(nombre)?.url || nombre;
        rotacionesResueltas[realKey] = grados;
      }
      if (Object.keys(rotacionesResueltas).length) extraEnv.USER_ROTATIONS = JSON.stringify(rotacionesResueltas);

      // Mapa filename → URL para que los procesos hijo resuelvan fotos aunque no estén en disco
      if (fotosCloud.size > 0) {
        const mapObj = {};
        for (const [nombre, { url }] of fotosCloud.entries()) mapObj[nombre] = url;
        extraEnv.FOTOS_MAP = JSON.stringify(mapObj);
      }

      const crearArgs = ['crear.mjs', tema, carpeta, marcaId];
      if (fotos.length) crearArgs.push(fotos.join(','));
      await runStep(crearArgs, extraEnv);

      // Parchar fotos asignadas manualmente por slide (ignoramos lo que hizo la IA)
      const fotosPorSlide = respuestas.fotosPorSlide || {};
      if (Object.keys(fotosPorSlide).length) {
        const contenidoPath = path.join(__dirname, carpeta, 'contenido.json');
        const contenido = JSON.parse(await readFile(contenidoPath, 'utf-8'));
        for (const [posStr, nombre] of Object.entries(fotosPorSlide)) {
          const idx = parseInt(posStr) - 1;
          if (contenido.slides[idx]) {
            contenido.slides[idx].photo = fotosCloud.get(nombre)?.url || nombre;
            broadcast(`📌 Slide ${posStr} → ${nombre}\n`);
          }
        }
        await writeFile(contenidoPath, JSON.stringify(contenido, null, 2), 'utf-8');
      }

      // Preview del plan: emitir el contenido recién generado ANTES de
      // arrancar Puppeteer (analizar + generar), para que el usuario vea un
      // wireframe de los slides mientras se renderiza (o pueda cancelar).
      try {
        const contenidoPlan = JSON.parse(await readFile(path.join(__dirname, carpeta, 'contenido.json'), 'utf-8'));
        broadcast(`__PLAN__:${JSON.stringify(contenidoPlan)}`);
      } catch { /* preview es opcional — no bloquea el pipeline */ }

      await runStep(['analizar.mjs', `${carpeta}/contenido.json`], extraEnv);
      await runStep(['generar.mjs', `${carpeta}/contenido.analizado.json`], extraEnv);

      // Autocrítica visual: lee slide-01.png, detecta problemas y re-renderiza si hace falta
      try {
        await runStep(['criticar.mjs', `${carpeta}/contenido.analizado.json`], extraEnv);
        const critiqueFile = path.join(__dirname, carpeta, 'output', 'critique.json');
        const critiqueRaw = await readFile(critiqueFile, 'utf-8').catch(() => '{}');
        if (JSON.parse(critiqueRaw).changed) {
          broadcast('🔄 Re-renderizando con ajustes...\n');
          await runStep(['generar.mjs', `${carpeta}/contenido.analizado.json`], extraEnv);
        }
      } catch { /* autocrítica es opcional — no bloquea */ }

      broadcast(`\n✅ Listo: ${carpeta}\n`);
    } catch (e) {
      broadcast(`\n❌ Error: ${e.message}\n`);
    } finally {
      jobRunning = false;
    }
  })();
});

app.post('/api/generar-story', async (req, res) => {
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
      const carpeta = path.join('stories', `${Date.now()}_story_${slugify(tema)}`);
      broadcast(`\n=== Story: ${tema} (marca: ${marcaId}) ===\n`);

      const extraEnv = {};
      if (req.body.model) extraEnv.USER_MODEL = req.body.model;
      if (req.body.estiloId) extraEnv.USER_ESTILO_ID = req.body.estiloId;
      if (req.body.fuenteId) extraEnv.USER_FUENTE_ID = req.body.fuenteId;
      if (req.body.paletaId) extraEnv.USER_PALETA_ID = req.body.paletaId;
      if (req.body.instruccionesLibres) extraEnv.USER_INSTRUCCIONES = req.body.instruccionesLibres;
      if (fotosCloud.size > 0) {
        const mapObj = {};
        for (const [n, { url }] of fotosCloud.entries()) mapObj[n] = url;
        extraEnv.FOTOS_MAP = JSON.stringify(mapObj);
        extraEnv.USER_FOTOS = [...fotosCloud.keys()].join(',');
      }

      try {
        const mData = JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'marca.json'), 'utf-8'));
        if (mData.handle) extraEnv.USER_HANDLE = mData.handle;
      } catch {}

      await runStep(['crear-story.mjs', tema, carpeta, marcaId, extraEnv.USER_FOTOS || ''], extraEnv);
      await runStep(['analizar.mjs', `${carpeta}/contenido.json`], { ...extraEnv, STORY_FORMAT: '1' });
      await runStep(['generar-story.mjs', `${carpeta}/contenido.analizado.json`], extraEnv);

      broadcast(`\n✅ Story lista: ${carpeta}\n`);
    } catch (e) {
      broadcast(`\n❌ Error: ${e.message}\n`);
    } finally {
      jobRunning = false;
    }
  })();
});

app.get('/api/stories', async (req, res) => {
  const dir = path.join(__dirname, 'stories');
  let folders;
  try { folders = await readdir(dir); } catch { return res.json([]); }

  const items = [];
  for (const f of folders) {
    const outDir = path.join(dir, f, 'output');
    let slides;
    try {
      slides = (await readdir(outDir)).filter(x => x.endsWith('.png')).sort();
    } catch { continue; }
    if (!slides.length) continue;

    let tema = f;
    try {
      const c = JSON.parse(await readFile(path.join(dir, f, 'contenido.json'), 'utf-8'));
      const cover = c.slides?.find(s => s.type === 'cover');
      tema = (cover?.headline || tema).replace(/\n/g, ' ');
    } catch {}

    const ts = Number(f.split('_')[0]) || 0;
    const slideUrls = slides.map(s => `/stories/${f}/output/${s}`);
    items.push({ id: f, tema, ts, slides: slideUrls });
  }
  items.sort((a, b) => b.ts - a.ts);
  res.json(items);
});

// ─────────────────────────────────────────────────────────────────────
// Stories — paridad con carruseles: ZIP, editor de slides, re-render
// El id de una story tiene la forma <timestamp>_story_<slug>
// ─────────────────────────────────────────────────────────────────────
function isValidStoryId(id) {
  return typeof id === 'string' && /^\d+_story_[a-z0-9-]+$/.test(id);
}

// ZIP download — empaqueta todos los PNGs de una story
app.get('/api/stories/:id/zip', async (req, res) => {
  const { id } = req.params;
  if (!isValidStoryId(id)) return res.status(400).json({ error: 'id inválido' });

  const outDir = path.join(__dirname, 'stories', id, 'output');
  let files;
  try {
    files = (await readdir(outDir)).filter(f => f.endsWith('.png')).sort();
  } catch {
    return res.status(404).json({ error: 'Story no encontrada' });
  }
  if (!files.length) return res.status(404).json({ error: 'Sin slides' });

  const localHeaders = [];
  const centralDirs  = [];
  let offset = 0;

  for (const filename of files) {
    const raw  = await readFile(path.join(outDir, filename));
    const comp = deflateRawSync(raw, { level: 6 });
    const crc  = crc32(raw);
    const now  = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1));
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate());
    const nameBuf = Buffer.from(filename, 'utf8');

    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);

    localHeaders.push(Buffer.concat([lh, comp]));

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);

    centralDirs.push(cd);
    offset += lh.length + comp.length;
  }

  const cdBuf     = Buffer.concat(centralDirs);
  const eocd      = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const zip = Buffer.concat([...localHeaders, cdBuf, eocd]);
  const slug = id.split('_').slice(2).join('-') || id;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="story-${slug}.zip"`);
  res.send(zip);
});

// Leer / guardar el contenido analizado de una story (editor)
app.get('/api/stories/:id/contenido', async (req, res) => {
  const { id } = req.params;
  if (!isValidStoryId(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    res.json(JSON.parse(await readFile(path.join(__dirname, 'stories', id, 'contenido.analizado.json'), 'utf-8')));
  } catch {
    res.status(404).json({ error: 'Contenido no encontrado' });
  }
});

app.put('/api/stories/:id/contenido', async (req, res) => {
  const { id } = req.params;
  if (!isValidStoryId(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    await mkdir(path.join(__dirname, 'stories', id), { recursive: true });
    await writeFile(path.join(__dirname, 'stories', id, 'contenido.analizado.json'), JSON.stringify(req.body, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Editor visual — sirve template-story.html ensamblado con _editMode:true
app.get('/api/stories/:id/template-html', async (req, res) => {
  const { id } = req.params;
  if (!isValidStoryId(id)) return res.status(400).send('id inválido');

  const dir = path.join(__dirname, 'stories', id);
  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(dir, 'contenido.analizado.json'), 'utf-8'));
  } catch {
    return res.status(404).send('Story no encontrada o sin analizar');
  }

  const PHOTO_FIELDS = ['photo','photo_top','photo_bottom','photo_before','photo_after'];
  const resolve = (ref) => {
    if (!ref) return ref;
    if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
    const base = path.basename(ref);
    return fotosCloud.get(base)?.url || `/fotos/${encodeURIComponent(base)}`;
  };
  for (const s of raw.slides) {
    PHOTO_FIELDS.forEach(f => { if (s[f]) s[f] = resolve(s[f]); });
    if (Array.isArray(s.rows)) s.rows.forEach(r => { if (r.photo) r.photo = resolve(r.photo); });
  }

  try {
    const buf = await readFile(path.join(__dirname, 'marcas', raw._marca || 'squadteam', 'logo.png'));
    raw._logo = `data:image/png;base64,${buf.toString('base64')}`;
  } catch {}

  try {
    const ov = JSON.parse(await readFile(path.join(dir, 'overrides.json'), 'utf-8'));
    raw._userOverrides = ov;
  } catch {}

  raw._editMode = true;

  const template   = await readFile(path.join(__dirname, 'template-story.html'), 'utf-8');
  const renderCore = await readFile(path.join(__dirname, 'render-core.js'), 'utf-8');
  const html = template
    .replace('<script src="render-core.js"></script>', `<script>${renderCore}</script>`)
    .replace('__DATA__', JSON.stringify(raw));

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Guarda overrides del editor y dispara re-render de la story
app.post('/api/stories/:id/save-overrides', async (req, res) => {
  const { id } = req.params;
  if (!isValidStoryId(id)) return res.status(400).json({ error: 'id inválido' });
  if (jobRunning) return res.status(409).json({ error: 'Hay una generación en curso' });

  const { overrides, rerender } = req.body || {};
  if (!overrides) return res.status(400).json({ error: 'Faltan overrides' });

  const dir = path.join(__dirname, 'stories', id);
  await writeFile(path.join(dir, 'overrides.json'), JSON.stringify(overrides, null, 2), 'utf-8');

  if (!rerender) return res.json({ ok: true });

  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(dir, 'contenido.analizado.json'), 'utf-8'));
  } catch {
    return res.status(404).json({ error: 'contenido.analizado.json no encontrado' });
  }

  raw._userOverrides = overrides;
  await writeFile(path.join(dir, 'contenido.analizado.json'), JSON.stringify(raw, null, 2), 'utf-8');

  jobRunning = true;
  jobLog = [];
  res.json({ ok: true, rerendering: true });

  (async () => {
    try {
      const extraEnv = {};
      if (fotosCloud.size > 0) {
        const mapObj = {};
        for (const [n, { url }] of fotosCloud.entries()) mapObj[n] = url;
        extraEnv.FOTOS_MAP = JSON.stringify(mapObj);
      }
      await runStep(['generar-story.mjs', `${path.join('stories', id)}/contenido.analizado.json`], extraEnv);
      broadcast(`\n✅ Re-render con ediciones listo\n`);
    } catch (e) {
      broadcast(`\n❌ Error re-render: ${e.message}\n`);
    } finally {
      jobRunning = false;
    }
  })();
});

// ─────────────────────────────────────────────────────────────────────
// Highlights Covers — generar y listar por marca
// ─────────────────────────────────────────────────────────────────────
app.post('/api/highlights', async (req, res) => {
  if (jobRunning) return res.status(409).json({ error: 'Ya hay una generación en curso' });
  const marcaId = req.body.marca || 'squadteam';
  const items = req.body.items;
  if (!isValidMarcaId(marcaId)) return res.status(400).json({ error: 'Marca inválida' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Se esperaba un array items con { label, emoji, color }' });

  const highlightsDir = path.join(__dirname, 'marcas', marcaId, 'highlights');
  await mkdir(highlightsDir, { recursive: true });

  const hlJsonPath = path.join(highlightsDir, 'highlights.json');
  await writeFile(hlJsonPath, JSON.stringify(items, null, 2), 'utf-8');

  jobRunning = true;
  jobLog = [];
  res.json({ ok: true });

  (async () => {
    try {
      broadcast(`\n=== Generando Highlight Covers para ${marcaId} ===\n`);
      await runStep(['generar-highlights.mjs', `marcas/${marcaId}/highlights/highlights.json`, `marcas/${marcaId}/highlights`]);
      broadcast(`\n✅ Listo\n`);
    } catch (e) {
      broadcast(`\n❌ Error: ${e.message}\n`);
    } finally {
      jobRunning = false;
    }
  })();
});

app.get('/api/marcas/:id/highlights', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  const outDir = path.join(__dirname, 'marcas', id, 'highlights', 'output');
  let files = [];
  try {
    files = (await readdir(outDir)).filter(f => f.endsWith('.png')).sort();
  } catch {
    return res.json([]);
  }
  res.json(files.map(f => `/marcas/${id}/highlights/output/${f}`));
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

app.get('/api/marcas/:id/diseno', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  try {
    const data = JSON.parse(await readFile(path.join(__dirname, 'marcas', id, 'diseno.json'), 'utf-8'));
    res.json(data);
  } catch {
    res.json({});
  }
});

app.put('/api/marcas/:id/diseno', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  await writeFile(path.join(__dirname, 'marcas', id, 'diseno.json'), JSON.stringify(req.body, null, 2), 'utf-8');
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
// Helpers IA — texto y visión
// ─────────────────────────────────────────────────────────────────────

const BB_FALLBACK_MODELS = [
  'claude-sonnet-4-5-20250514',
  'claude-haiku-4-5-20251001',
  'blackboxai/anthropic/claude-sonnet-4.6',
];

async function bbFetch(body, attempt = 0) {
  const apiKey = process.env.BLACKBOX_API_KEY;
  if (!apiKey) throw new Error('Falta BLACKBOX_API_KEY');
  const model = process.env.BLACKBOX_MODEL || BB_FALLBACK_MODELS[Math.min(attempt, BB_FALLBACK_MODELS.length - 1)];

  let res;
  try {
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 90000);
    try {
      res = await fetch('https://api.blackbox.ai/chat/completions', {
        signal: ac.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ ...body, model })
      });
    } finally {
      clearTimeout(abortTimer);
    }
  } catch (netErr) {
    if (attempt < 3) {
      const delay = [5000, 12000, 25000][attempt];
      console.warn(`⏳ Error de red Blackbox servidor (intento ${attempt + 1}): ${netErr.message} — reintentando en ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return bbFetch(body, attempt + 1);
    }
    throw netErr;
  }

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    if (attempt < 3) {
      const delay = [5000, 12000, 25000][attempt];
      console.warn(`⏳ Respuesta no-JSON de Blackbox servidor (intento ${attempt + 1}, status ${res.status}) — reintentando en ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return bbFetch(body, attempt + 1);
    }
    throw new Error(`Blackbox devolvió no-JSON (status ${res.status}): ${rawText.slice(0, 200)}`);
  }

  if (!res.ok) {
    const bodyStr = JSON.stringify(data);
    const is429 = res.status === 429 || bodyStr.includes('RESOURCE_EXHAUSTED') || bodyStr.includes('429');
    if (is429 && attempt < 3) {
      const delay = [5000, 12000, 25000][attempt];
      console.warn(`⏳ Rate limit servidor (intento ${attempt + 1}) — reintentando en ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return bbFetch(body, attempt + 1);
    }
    throw new Error(`Blackbox: ${data.error?.message || bodyStr}`);
  }
  return data.choices?.[0]?.message?.content || '';
}

async function callBlackboxText(promptText, maxTokens = 600) {
  return bbFetch({ max_tokens: maxTokens, messages: [{ role: 'user', content: promptText }] });
}

async function callBlackboxVision(imageDataUrls, promptText) {
  const content = [
    ...imageDataUrls.map(url => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
    { type: 'text', text: promptText }
  ];
  return bbFetch({ max_tokens: 2000, messages: [{ role: 'user', content }] });
}

// ─── Referencias visuales (imágenes para clonador de diseño) ───────────
const VALID_IMG_EXT = /\.(jpe?g|png|webp)$/i;

app.get('/api/marcas/:id/referencias-img', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  const dir = path.join(__dirname, 'marcas', id, 'referencias');
  let files = [];
  try { files = (await readdir(dir)).filter(f => VALID_IMG_EXT.test(f)); } catch {}
  res.json({ files });
});

app.post('/api/marcas/:id/referencias-img', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  const { filename, data } = req.body;
  if (!filename || !data) return res.status(400).json({ error: 'Faltan filename o data' });
  if (!VALID_IMG_EXT.test(filename)) return res.status(400).json({ error: 'Tipo de archivo no soportado' });
  const match = data.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Formato de imagen inválido' });
  const dir = path.join(__dirname, 'marcas', id, 'referencias');
  await mkdir(dir, { recursive: true });
  const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  await writeFile(path.join(dir, safeName), Buffer.from(match[2], 'base64'));
  res.json({ ok: true, filename: safeName });
});

app.delete('/api/marcas/:id/referencias-img/:filename', async (req, res) => {
  const { id, filename } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  if (!VALID_IMG_EXT.test(filename)) return res.status(400).json({ error: 'Archivo inválido' });
  const safeName = path.basename(filename);
  try { await unlink(path.join(__dirname, 'marcas', id, 'referencias', safeName)); } catch {}
  res.json({ ok: true });
});

// GET — devuelve el contenido actual de referencias-ig.md
app.get('/api/marcas/:id/referencias', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  try {
    const texto = await readFile(path.join(__dirname, 'marcas', id, 'referencias-ig.md'), 'utf-8');
    res.json({ texto });
  } catch {
    res.json({ texto: '' });
  }
});

// PUT — guarda edición manual de referencias
app.put('/api/marcas/:id/referencias', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  const { texto } = req.body;
  await writeFile(path.join(__dirname, 'marcas', id, 'referencias-ig.md'), texto || '', 'utf-8');
  res.json({ ok: true });
});

// DELETE — borra las referencias
app.delete('/api/marcas/:id/referencias', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });
  try { await unlink(path.join(__dirname, 'marcas', id, 'referencias-ig.md')); } catch {}
  res.json({ ok: true });
});

// POST — recibe imágenes (base64 en JSON), analiza con IA y AGREGA al archivo de referencias
app.post('/api/marcas/:id/estudiar', async (req, res) => {
  const { id } = req.params;
  if (!isValidMarcaId(id)) return res.status(400).json({ error: 'Marca inválida' });

  const { imagenes } = req.body; // array de data URLs (data:image/...;base64,...)
  if (!Array.isArray(imagenes) || !imagenes.length) {
    return res.status(400).json({ error: 'Se esperaba un array de imagenes en base64' });
  }
  if (imagenes.length > 12) return res.status(400).json({ error: 'Máximo 12 slides por análisis' });

  const prompt = `Analizás estos slides de un carrusel de Instagram. Tu misión es extraer un análisis de estilo VISUAL Y COPY concreto y accionable para que pueda replicarse en carruseles futuros generados con IA.

Analizá cada uno de estos aspectos:

## ESTILO VISUAL
- Paleta de colores: fondo predominante, colores de texto, colores de acento. Describí los colores con exactitud (oscuro/claro, cálido/frío, hex si podés inferirlo).
- Tipografía: ¿El titular es grande y condensado o mediano? ¿Hay mezcla de tamaños? ¿Se usan mayúsculas sostenidas?
- Layout: ¿Texto centrado o alineado a la izquierda? ¿Cómo se distribuyen texto y foto?
- Uso de espacio: ¿Diseño minimalista con mucho aire o denso con mucha info?
- Elementos decorativos: líneas, formas, marcos, overlays, gradientes — describí si aparecen y cómo.
- Ratio de foto/texto: ¿Slides mayoritariamente tipográficas, foto de fondo con overlay, o foto y texto separados?

## COPY Y ESTRUCTURA
- Tono de voz: directo/conversacional/académico/provocador/educativo
- Longitud de los textos por slide: ¿Muy cortos (1-5 palabras), medios (1-2 frases), largos (párrafos)?
- Uso de mayúsculas, signos de exclamación, puntos suspensivos, listas
- Hook del slide 1: ¿Qué técnica usa para enganchar? (pregunta, dato, afirmación rotunda, promesa, provocación)
- Flujo entre slides: ¿Cada slide es independiente o hay continuidad narrativa?
- CTA final: texto exacto o parafraseo, estilo (directo/suave/con urgencia)

## PATRONES REPLICABLES
Lista de las 5-7 reglas concretas de este estilo que una IA debe seguir para imitarlo. Sé muy específico. Ejemplos:
- "Titular siempre en mayúsculas, máximo 4 palabras, centrado"
- "Fondo negro con texto blanco, acento amarillo solo en 1-2 palabras por slide"
- "Primer slide siempre es una pregunta que el público respondería 'sí'"

Devolvé el análisis en markdown limpio y estructurado. Sin intro ni conclusión genérica — solo los puntos de análisis. Esto se usa directamente como guía para generación de carruseles con IA.`;

  try {
    const analisis = await callBlackboxVision(imagenes, prompt);

    // Leer el archivo existente y agregar el nuevo análisis
    let actual = '';
    try { actual = await readFile(path.join(__dirname, 'marcas', id, 'referencias-ig.md'), 'utf-8'); } catch {}
    const separador = actual ? '\n\n---\n\n' : '';
    const nuevo = `${actual}${separador}## Análisis ${new Date().toLocaleDateString('es-UY')} (${imagenes.length} slides)\n\n${analisis}`;

    await writeFile(path.join(__dirname, 'marcas', id, 'referencias-ig.md'), nuevo, 'utf-8');
    res.json({ ok: true, analisis });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Preguntar — la IA genera preguntas personalizadas antes de generar
// ─────────────────────────────────────────────────────────────────────
app.post('/api/preguntar', async (req, res) => {
  const tema    = (req.body.tema || '').trim();
  const marcaId = req.body.marca || 'squadteam';
  const tieneFotos = Array.isArray(req.body.fotoUrls) && req.body.fotoUrls.length > 0;
  if (!tema) return res.status(400).json({ error: 'Falta el tema' });
  if (!isValidMarcaId(marcaId)) return res.status(400).json({ error: 'Marca inválida' });

  let marca = {};
  try { marca = JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'marca.json'), 'utf-8')); } catch {}

  const prompt = `Vas a generar un carrusel de Instagram de 6 slides para "${marca.nombre || marcaId}" sobre este tema: "${tema}"
Industria: ${marca.industria || 'no especificada'}. Audiencia: ${marca.audiencia || 'no especificada'}.
Voz de marca: ${marca.voz || 'no especificada'}.
${tieneFotos ? `Hay ${req.body.fotoUrls.length} foto(s) que se usarán como fondo en algunos slides.` : 'Es un carrusel 100% tipográfico (sin fotos de fondo).'}

Hacé exactamente 4 preguntas para personalizar el carrusel:

PREGUNTA 1 — OBLIGATORIA: Titulares del cover. Escribí 3 versiones reales del headline del slide 1, con ángulos distintos. Son titulares listos para usar, no descripciones. Usá saltos de línea con \\n para cortar líneas como en un carrusel real. Formato:
{"id":"cover_headline","pregunta":"¿Cómo arranca el carrusel?","tipo":"opciones","opciones":["headline 1\\ncon corte","headline 2\\ncon corte","headline 3\\ncon corte"],"default":"headline 1\\ncon corte"}

PREGUNTAS 2, 3 y 4 — elegí las más relevantes para este tema:
- Oscuridad del fondo de fotos (solo si hay fotos): tipo slider, min 0.2 max 0.8 default 0.45
- Tamaño del texto: tipo opciones, valores ["Compacto", "Normal", "Grande"], default "Normal"
- Tono del copy: tipo opciones, elige 3 de ["Directo y corto", "Educativo y detallado", "Provocador", "Motivacional", "Técnico y preciso", "Conversacional"]
- Ángulo de desarrollo: tipo opciones, 3 ángulos ESPECÍFICOS para este tema (no genéricos)
- Estructura interna: tipo opciones, relacionada a cómo presentar la info

Respondé SOLO con un JSON array de exactamente 4 objetos. Sin markdown, sin explicaciones.
Formato slider: {"id":"overlay","pregunta":"¿Qué tan oscuro?","tipo":"slider","min":0.2,"max":0.8,"step":0.05,"default":0.45,"label_min":"Claro","label_max":"Oscuro"}`;

  const FALLBACK = [
    { id: 'cover_headline', pregunta: '¿Cómo arranca el carrusel?', tipo: 'opciones', opciones: ['Opción A', 'Opción B', 'Opción C'], default: 'Opción A' },
    { id: 'tono', pregunta: '¿Qué tono querés para el copy?', tipo: 'opciones', opciones: ['Directo y corto', 'Educativo y detallado', 'Provocador'], default: 'Directo y corto' },
    { id: 'texto_size', pregunta: '¿Tamaño del texto en los titulares?', tipo: 'opciones', opciones: ['Compacto', 'Normal', 'Grande'], default: 'Normal' },
    ...(tieneFotos ? [{ id: 'overlay', pregunta: '¿Qué tan oscuro el fondo de las fotos?', tipo: 'slider', min: 0.2, max: 0.8, step: 0.05, default: 0.45, label_min: 'Claro (foto visible)', label_max: 'Oscuro (texto prioritario)' }] : [{ id: 'angulo', pregunta: '¿Desde qué ángulo encarás el tema?', tipo: 'opciones', opciones: ['Afirmación rotunda', 'Pregunta que enganche', 'Dato o estadística'], default: 'Afirmación rotunda' }])
  ];

  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000));
    const raw = await Promise.race([callBlackboxText(prompt, 700), timeout]);
    const preguntas = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (!Array.isArray(preguntas) || !preguntas.length) throw new Error('No es array');
    res.json({ preguntas });
  } catch {
    res.json({ preguntas: FALLBACK });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Editor — leer / guardar / re-renderizar una tanda existente
// ─────────────────────────────────────────────────────────────────────
function isValidTandaId(id) {
  return typeof id === 'string' && /^\d+_[a-z0-9-]+$/.test(id);
}

app.get('/api/tandas/:id/contenido', async (req, res) => {
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    res.json(JSON.parse(await readFile(path.join(__dirname, 'tandas', id, 'contenido.analizado.json'), 'utf-8')));
  } catch {
    res.status(404).json({ error: 'Contenido no encontrado' });
  }
});

app.put('/api/tandas/:id/contenido', async (req, res) => {
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    await mkdir(path.join(__dirname, 'tandas', id), { recursive: true });
    await writeFile(path.join(__dirname, 'tandas', id, 'contenido.analizado.json'), JSON.stringify(req.body, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Subir slides pre-renderizados (base64) al output de una tanda
// Body: { "slide-01.png": "<base64>", "slide-02.png": "<base64>", ... }
app.post('/api/tandas/:id/upload-output', async (req, res) => {
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).json({ error: 'id inválido' });
  const outDir = path.join(__dirname, 'tandas', id, 'output');
  await mkdir(outDir, { recursive: true });
  const files = req.body;
  for (const [filename, b64] of Object.entries(files)) {
    if (!/^slide-0\d\.png$/.test(filename)) continue;
    await writeFile(path.join(outDir, filename), Buffer.from(b64, 'base64'));
  }
  res.json({ ok: true, files: Object.keys(files).length });
});

// Subir fotos originales (base64) a /fotos para poder re-renderizar
// Body: { "IMG_7672.jpg": "<base64>", ... }
app.post('/api/upload-fotos', async (req, res) => {
  await mkdir(FOTOS_DIR, { recursive: true });
  const files = req.body;
  const saved = [];
  for (const [filename, b64] of Object.entries(files)) {
    if (!/\.(jpe?g|png|webp|heic)$/i.test(filename)) continue;
    await writeFile(path.join(FOTOS_DIR, filename), Buffer.from(b64, 'base64'));
    saved.push(filename);
  }
  res.json({ ok: true, saved });
});

app.post('/api/tandas/:id/duplicar', async (req, res) => {
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).json({ error: 'id inválido' });

  const slug   = id.split('_').slice(1).join('_');
  const newId  = `${Date.now()}_${slug}`;
  const srcDir = path.join(__dirname, 'tandas', id);
  const dstDir = path.join(__dirname, 'tandas', newId);

  await mkdir(path.join(dstDir, 'output'), { recursive: true });

  for (const f of ['contenido.json', 'contenido.analizado.json']) {
    try { await copyFile(path.join(srcDir, f), path.join(dstDir, f)); } catch {}
  }

  try {
    const slides = (await readdir(path.join(srcDir, 'output'))).filter(f => f.endsWith('.png'));
    for (const s of slides) {
      await copyFile(path.join(srcDir, 'output', s), path.join(dstDir, 'output', s));
    }
    await copyFile(path.join(srcDir, 'output', 'cloudinary.json'), path.join(dstDir, 'output', 'cloudinary.json'));
  } catch {}

  res.json({ id: newId });
});

// ZIP download — empaqueta todos los PNGs de una tanda
app.get('/api/tandas/:id/zip', async (req, res) => {
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).json({ error: 'id inválido' });

  const outDir = path.join(__dirname, 'tandas', id, 'output');
  let files;
  try {
    files = (await readdir(outDir)).filter(f => f.endsWith('.png')).sort();
  } catch {
    return res.status(404).json({ error: 'Tanda no encontrada' });
  }
  if (!files.length) return res.status(404).json({ error: 'Sin slides' });

  // Build ZIP in memory (PKZIP format, deflate)
  const localHeaders = [];
  const centralDirs  = [];
  let offset = 0;

  for (const filename of files) {
    const raw  = await readFile(path.join(outDir, filename));
    const comp = deflateRawSync(raw, { level: 6 });
    const crc  = crc32(raw);
    const now  = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1));
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate());
    const nameBuf = Buffer.from(filename, 'utf8');

    // Local file header
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);  // signature
    lh.writeUInt16LE(20, 4);           // version needed
    lh.writeUInt16LE(0, 6);            // flags
    lh.writeUInt16LE(8, 8);            // compression: deflate
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);            // extra field length
    nameBuf.copy(lh, 30);

    localHeaders.push(Buffer.concat([lh, comp]));

    // Central directory entry
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);           // extra
    cd.writeUInt16LE(0, 32);           // comment
    cd.writeUInt16LE(0, 34);           // disk start
    cd.writeUInt16LE(0, 36);           // internal attr
    cd.writeUInt32LE(0, 38);           // external attr
    cd.writeUInt32LE(offset, 42);      // local header offset
    nameBuf.copy(cd, 46);

    centralDirs.push(cd);
    offset += lh.length + comp.length;
  }

  const cdBuf     = Buffer.concat(centralDirs);
  const eocd      = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const zip = Buffer.concat([...localHeaders, cdBuf, eocd]);
  const slug = id.split('_').slice(1).join('-') || id;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="carrusel-${slug}.zip"`);
  res.send(zip);
});

app.post('/api/tandas/:id/caption', async (req, res) => {
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).json({ error: 'id inválido' });

  let contenido, marca = {};
  try {
    contenido = JSON.parse(await readFile(path.join(__dirname, 'tandas', id, 'contenido.analizado.json'), 'utf-8'));
  } catch {
    return res.status(404).json({ error: 'Contenido no encontrado' });
  }
  try { marca = JSON.parse(await readFile(path.join(__dirname, 'marcas', contenido._marca || 'squadteam', 'marca.json'), 'utf-8')); } catch {}

  const resumen = contenido.slides.map((s, i) => {
    const titulo = s.headline || s.title || s.stat || '';
    const sub    = s.subheadline || s.body || s.caption || '';
    return `Slide ${i + 1} (${s.type}): ${titulo}${sub ? ' — ' + sub : ''}`.trim();
  }).join('\n');

  const prompt = `Sos un experto en Instagram para la marca "${marca.nombre || id}".
Industria: ${marca.industria || 'no especificada'}. Audiencia: ${marca.audiencia || 'no especificada'}.
Voz: ${marca.voz || 'directa y cercana'}.

Este es el resumen del carrusel que acabás de crear:
${resumen}

Escribí 3 variantes de caption para Instagram que acompañen este carrusel. Cada variante tiene un estilo distinto:

1. hook_corto: Primera línea gancho (máx 10 palabras, que detenga el scroll) + 2 líneas de cuerpo con valor real + CTA directa + salto de línea + 20-25 hashtags relevantes en minúsculas.
2. storytelling: Narrativa en 3 párrafos cortos que desarrollan el tema del carrusel + CTA sutil al final + salto de línea + 20-25 hashtags relevantes en minúsculas.
3. lista_valor: Bullet points (con guión) con los puntos clave del carrusel + una pregunta de engagement al final + salto de línea + 20-25 hashtags relevantes en minúsculas.

Idioma: español rioplatense (vos, usás, etc).
Sin emojis a menos que sean muy naturales. Sin frases genéricas ni motivacionales vacías.

Devolvé ÚNICAMENTE un objeto JSON válido con esta estructura, sin explicaciones ni texto extra antes ni después:
{
  "variantes": [
    { "tipo": "hook_corto", "label": "Hook corto", "caption": "..." },
    { "tipo": "storytelling", "label": "Storytelling", "caption": "..." },
    { "tipo": "lista_valor", "label": "Lista de valor", "caption": "..." }
  ]
}`;

  try {
    const raw = await callBlackboxText(prompt, 1800);
    let variantes;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      variantes = parsed.variantes;
      if (!Array.isArray(variantes) || variantes.length === 0) throw new Error('variantes inválidas');
    } catch {
      // Fallback: usar el texto plano como única variante
      variantes = [{ tipo: 'hook_corto', label: 'Hook corto', caption: raw.trim() }];
    }
    res.json({ variantes, caption: variantes[0].caption });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/tandas/:id/estado', async (req, res) => {
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).json({ error: 'id inválido' });
  const { estado } = req.body;
  if (!['nuevo', 'guardado', 'descartado'].includes(estado)) return res.status(400).json({ error: 'estado inválido' });
  await writeFile(path.join(__dirname, 'tandas', id, 'estado.json'), JSON.stringify({ estado }, null, 2), 'utf-8');

  // Al aprobar: subir slides a Cloudinary si todavía no están subidos
  if (estado === 'guardado' && CLD_CLOUD && CLD_PRESET) {
    const outDir = path.join(__dirname, 'tandas', id, 'output');
    const cldFile = path.join(outDir, 'cloudinary.json');
    let alreadyUploaded = false;
    try {
      const existing = JSON.parse(await readFile(cldFile, 'utf-8'));
      alreadyUploaded = Array.isArray(existing) && existing.length > 0 && existing[0]?.startsWith('http');
    } catch {}

    if (!alreadyUploaded) {
      (async () => {
        try {
          let slides = [];
          try { slides = (await readdir(outDir)).filter(f => /^slide-0\d\.png$/.test(f)).sort(); } catch {}
          if (!slides.length) return;
          console.log(`☁️  Auto-subiendo ${slides.length} slides de ${id} a Cloudinary...`);
          const folder = `carrusel-generator/${id}`;
          const urls = [];
          for (const s of slides) {
            const buf = await readFile(path.join(outDir, s));
            const form = new FormData();
            form.append('file', new Blob([buf], { type: 'image/png' }), s);
            form.append('upload_preset', CLD_PRESET);
            form.append('folder', folder);
            const r = await fetch(`https://api.cloudinary.com/v1_1/${CLD_CLOUD}/image/upload`, { method: 'POST', body: form });
            const d = await r.json();
            const url = d.secure_url || null;
            urls.push(url);
            console.log(`  ↑ ${s} → ${url}`);
          }
          await writeFile(cldFile, JSON.stringify(urls.filter(Boolean), null, 2), 'utf-8');
          console.log(`✅ Cloudinary: ${id} guardado`);
        } catch (e) {
          console.error(`❌ Cloudinary auto-upload error (${id}):`, e.message);
        }
      })();
    }
  }

  res.json({ ok: true });
});

app.post('/api/tandas/:id/rerenderizar', (req, res) => {
  if (jobRunning) return res.status(409).json({ error: 'Hay una generación en curso' });
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).json({ error: 'id inválido' });
  jobRunning = true;
  jobLog = [];
  res.json({ ok: true });
  (async () => {
    try {
      broadcast(`\n=== Re-renderizando: ${id} ===\n`);
      await runStep(['generar.mjs', `tandas/${id}/contenido.analizado.json`]);
      broadcast(`\n✅ Listo\n`);
    } catch (e) {
      broadcast(`\n❌ ${e.message}\n`);
    } finally {
      jobRunning = false;
    }
  })();
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

    let estado = 'nuevo';
    try {
      const estadoData = JSON.parse(await readFile(path.join(dir, f, 'estado.json'), 'utf-8'));
      estado = estadoData.estado || 'nuevo';
    } catch {}

    const ts = Number(f.split('_')[0]) || 0;
    items.push({ id: f, tema, ts, slides: slideUrls, estado });
  }

  items.sort((a, b) => b.ts - a.ts);
  res.json(items);
});

// ─────────────────────────────────────────────────────────────────────
// Fotos — Cloudinary como storage persistente
// fotosCloud: filename → { url, publicId }
// Se reconstruye desde la API de Cloudinary en cada arranque del server.
// ─────────────────────────────────────────────────────────────────────
const EXT_RE     = /\.(jpe?g|png|webp)$/i;
const CLD_CLOUD  = process.env.CLOUDINARY_CLOUD_NAME;
const CLD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;
const CLD_KEY    = process.env.CLOUDINARY_API_KEY;
const CLD_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLD_FOLDER = 'carruselesgen/fotos';

const fotosCloud = new Map(); // filename → { url, publicId }

async function rebuildFotosCloud() {
  if (!CLD_CLOUD || !CLD_KEY || !CLD_SECRET) return;
  try {
    const auth = Buffer.from(`${CLD_KEY}:${CLD_SECRET}`).toString('base64');
    const apiUrl = `https://api.cloudinary.com/v1_1/${CLD_CLOUD}/resources/image?prefix=${CLD_FOLDER}&max_results=500&type=upload`;
    const res  = await fetch(apiUrl, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) return;
    const data = await res.json();
    for (const r of data.resources || []) {
      const filename = `${path.basename(r.public_id)}.${r.format}`;
      fotosCloud.set(filename, { url: r.secure_url, publicId: r.public_id });
    }
    console.log(`☁ Cloudinary: ${fotosCloud.size} fotos cargadas`);
  } catch (e) {
    console.error('Cloudinary rebuild error:', e.message);
  }
}

await rebuildFotosCloud();

async function uploadFotoBuffer(buf, filename) {
  if (!CLD_CLOUD || !CLD_PRESET) return null;
  const ext  = path.extname(filename).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'image/jpeg';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), filename);
  form.append('upload_preset', CLD_PRESET);
  form.append('folder', CLD_FOLDER);
  const res  = await fetch(`https://api.cloudinary.com/v1_1/${CLD_CLOUD}/image/upload`, { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok) { console.error('Cloudinary upload error:', data.error?.message); return null; }
  return { url: data.secure_url, publicId: data.public_id };
}

async function deleteFromCloudinary(publicId) {
  if (!CLD_CLOUD || !CLD_KEY || !CLD_SECRET) return;
  const { createHash } = await import('node:crypto');
  const ts  = Math.floor(Date.now() / 1000);
  const sig = createHash('sha256').update(`public_id=${publicId}&timestamp=${ts}${CLD_SECRET}`).digest('hex');
  const form = new FormData();
  form.append('public_id', publicId);
  form.append('api_key', CLD_KEY);
  form.append('timestamp', String(ts));
  form.append('signature', sig);
  await fetch(`https://api.cloudinary.com/v1_1/${CLD_CLOUD}/image/destroy`, { method: 'POST', body: form });
}

// Listar fotos
app.get('/api/fotos', (req, res) => {
  res.json([...fotosCloud.entries()].map(([nombre, { url }]) => ({ nombre, url })));
});

// Subir foto — multipart/form-data
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

    // Subir a Cloudinary (sincrónico — URL disponible antes de responder)
    const result = await uploadFotoBuffer(body, filename);
    if (result) {
      fotosCloud.set(filename, result);
      return res.json({ ok: true, nombre: filename, url: result.url });
    }
    // Fallback sin Cloudinary: guardar localmente
    await writeFile(path.join(FOTOS_DIR, filename), body);
    fotosCloud.set(filename, { url: `/fotos/${encodeURIComponent(filename)}`, publicId: null });
    return res.json({ ok: true, nombre: filename, url: `/fotos/${encodeURIComponent(filename)}` });
  }
  res.status(400).json({ error: 'No se encontró archivo en el body' });
});

// Eliminar foto
app.delete('/api/fotos/:nombre', async (req, res) => {
  const nombre = path.basename(req.params.nombre);
  if (!EXT_RE.test(nombre)) return res.status(400).json({ error: 'Nombre inválido' });
  const entry = fotosCloud.get(nombre);
  if (entry?.publicId) await deleteFromCloudinary(entry.publicId).catch(() => {});
  fotosCloud.delete(nombre);
  await unlink(path.join(FOTOS_DIR, nombre)).catch(() => {});
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// Editor visual — sirve el template ensamblado con _editMode:true
// ─────────────────────────────────────────────────────────────────────

app.get('/api/tandas/:id/template-html', async (req, res) => {
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).send('id inválido');

  const dir = path.join(__dirname, 'tandas', id);
  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(dir, 'contenido.analizado.json'), 'utf-8'));
  } catch {
    return res.status(404).send('Tanda no encontrada o sin analizar');
  }

  // Resolver refs de fotos a URLs accesibles desde el browser
  const PHOTO_FIELDS = ['photo','photo_top','photo_bottom','photo_before','photo_after'];
  const resolve = (ref) => {
    if (!ref) return ref;
    if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
    const base = path.basename(ref);
    return fotosCloud.get(base)?.url || `/fotos/${encodeURIComponent(base)}`;
  };
  for (const s of raw.slides) {
    PHOTO_FIELDS.forEach(f => { if (s[f]) s[f] = resolve(s[f]); });
    if (Array.isArray(s.rows)) s.rows.forEach(r => { if (r.photo) r.photo = resolve(r.photo); });
  }

  // Logo
  try {
    const buf = await readFile(path.join(__dirname, 'marcas', raw._marca || 'squadteam', 'logo.png'));
    raw._logo = `data:image/png;base64,${buf.toString('base64')}`;
  } catch {}

  // Overrides guardados previamente
  try {
    const ov = JSON.parse(await readFile(path.join(dir, 'overrides.json'), 'utf-8'));
    raw._userOverrides = ov;
  } catch {}

  raw._editMode = true;

  const template   = await readFile(path.join(__dirname, 'template.html'), 'utf-8');
  const renderCore = await readFile(path.join(__dirname, 'render-core.js'), 'utf-8');
  const dataPayload = req.query.live === '1' ? '{}' : JSON.stringify(raw);
  const html = template
    .replace('<script src="render-core.js"></script>', `<script>${renderCore}</script>`)
    .replace('__DATA__', dataPayload);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/api/tandas/:id/preview-sistemas', async (req, res) => {
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const raw = JSON.parse(await readFile(path.join(__dirname, 'tandas', id, 'contenido.analizado.json'), 'utf-8'));
    res.json({ a: raw._sistemaA || raw._sistema, b: raw._sistemaB || raw._sistema, current: raw._sistema });
  } catch {
    res.status(404).json({ error: 'Tanda no encontrada o sin analizar' });
  }
});

app.post('/api/tandas/:id/apply-sistema', async (req, res) => {
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).json({ error: 'id inválido' });
  const { sistema } = req.body || {};
  if (sistema !== 'a' && sistema !== 'b') return res.status(400).json({ error: 'sistema debe ser "a" o "b"' });
  try {
    const filePath = path.join(__dirname, 'tandas', id, 'contenido.analizado.json');
    const raw = JSON.parse(await readFile(filePath, 'utf-8'));
    raw._sistema = sistema === 'a' ? (raw._sistemaA || raw._sistema) : (raw._sistemaB || raw._sistema);
    await writeFile(filePath, JSON.stringify(raw, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Tanda no encontrada o sin analizar' });
  }
});

app.post('/api/tandas/:id/switch-design', async (req, res) => {
  if (!isValidTandaId(req.params.id)) return res.status(400).json({ error: 'id inválido' });
  const analFile = path.join(__dirname, 'tandas', req.params.id, 'contenido.analizado.json');
  try {
    const data = JSON.parse(await readFile(analFile, 'utf-8'));
    const alt = data._sistema?._sistemaAlt;
    if (!alt) return res.status(404).json({ error: 'No hay sistema alternativo' });
    // Swap: current becomes alt, alt becomes current
    const current = { ...data._sistema };
    delete current._sistemaAlt;
    alt._sistemaAlt = current;
    data._sistema = alt;
    await writeFile(analFile, JSON.stringify(data, null, 2), 'utf-8');
    res.json({ ok: true, nombre: alt.nombre_sistema, font: alt.tipografia?.display?.familia });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Guarda overrides del editor y dispara re-render de los slides modificados
app.post('/api/tandas/:id/save-overrides', async (req, res) => {
  const { id } = req.params;
  if (!isValidTandaId(id)) return res.status(400).json({ error: 'id inválido' });
  if (jobRunning) return res.status(409).json({ error: 'Hay una generación en curso' });

  const { overrides, rerender } = req.body || {};
  if (!overrides) return res.status(400).json({ error: 'Faltan overrides' });

  const dir = path.join(__dirname, 'tandas', id);
  await writeFile(path.join(dir, 'overrides.json'), JSON.stringify(overrides, null, 2), 'utf-8');

  if (!rerender) return res.json({ ok: true });

  // Re-render: aplicar overrides en contenido.analizado.json y lanzar generar.mjs
  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(dir, 'contenido.analizado.json'), 'utf-8'));
  } catch {
    return res.status(404).json({ error: 'contenido.analizado.json no encontrado' });
  }

  raw._userOverrides = overrides;
  await writeFile(path.join(dir, 'contenido.analizado.json'), JSON.stringify(raw, null, 2), 'utf-8');

  jobRunning = true;
  jobLog = [];
  res.json({ ok: true, rerendering: true });

  (async () => {
    try {
      const extraEnv = {};
      if (fotosCloud.size > 0) {
        const mapObj = {};
        for (const [n, { url }] of fotosCloud.entries()) mapObj[n] = url;
        extraEnv.FOTOS_MAP = JSON.stringify(mapObj);
      }
      await runStep(['generar.mjs', `${path.join('tandas', id)}/contenido.analizado.json`], extraEnv);
      broadcast(`\n✅ Re-render con ediciones listo\n`);
    } catch (e) {
      broadcast(`\n❌ Error re-render: ${e.message}\n`);
    } finally {
      jobRunning = false;
    }
  })();
});

// ─────────────────────────────────────────────────────────────────────
// Preview en vivo — integrado al server principal (antes era preview-server.mjs
// corriendo en el puerto 5390). analizar.mjs --preview hace POST a /preview/broadcast
// y los clientes se conectan a /preview/events via SSE.
// Uso: node analizar.mjs <contenido.json> --preview
//      Abrí http://localhost:<PORT>/preview en el browser mientras corre
// ─────────────────────────────────────────────────────────────────────
let previewHistory = [];
const previewClients = new Set();

app.get('/preview', async (req, res) => {
  try {
    const html = await readFile(path.join(__dirname, 'preview.html'), 'utf-8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch { res.status(404).send('preview.html no encontrado'); }
});

app.get('/preview/styles.css', async (req, res) => {
  try {
    const tpl = await readFile(path.join(__dirname, 'template.html'), 'utf-8');
    const match = tpl.match(/<style>([\s\S]*?)<\/style>/);
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.send(match ? match[1] : '');
  } catch { res.status(404).send(''); }
});

app.get('/preview/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('\n');
  previewClients.add(res);
  for (const ev of previewHistory) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  req.on('close', () => previewClients.delete(res));
});

app.post('/preview/broadcast', express.json(), (req, res) => {
  const event = req.body;
  if (event?.type === 'reset') previewHistory = [];
  previewHistory.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of previewClients) { try { client.write(payload); } catch {} }
  res.status(204).end();
});

// ─────────────────────────────────────────────────────────────────────
// Consola — comandos y chat en lenguaje natural
app.post('/api/consola', async (req, res) => {
  const input  = (req.body.input || '').trim();
  const marca  = req.body.marca || 'squadteam';
  if (!input) return res.json({ lines: [] });

  if (input.startsWith('/')) {
    const [cmd, ...args] = input.slice(1).trim().split(/\s+/);

    switch (cmd.toLowerCase()) {

      case 'help':
        return res.json({ lines: [
          '  /listar             — lista las últimas 10 tandas',
          '  /info <id>          — detalle de una tanda',
          '  /generar <tema>     — genera un carrusel nuevo',
          '  /analizar <id>      — re-analiza una tanda existente',
          '  /guardar <id>       — marca una tanda como guardada',
          '  /descartar <id>     — marca una tanda como descartada',
          '  /fotos              — lista las fotos disponibles',
          '  /help               — muestra este mensaje',
          '',
          '  También podés escribir en lenguaje natural y la IA interpreta.',
        ]});

      case 'listar': {
        const dir = path.join(__dirname, 'tandas');
        let folders = [];
        try { folders = await readdir(dir); } catch {}
        const items = [];
        for (const f of folders) {
          let tema = f;
          try {
            const c = JSON.parse(await readFile(path.join(dir, f, 'contenido.json'), 'utf-8'));
            const cover = c.slides?.find(s => s.type === 'cover');
            tema = (cover?.headline || tema).replace(/\n/g, ' ').slice(0, 60);
          } catch {}
          let estado = 'nuevo';
          try {
            const e = JSON.parse(await readFile(path.join(dir, f, 'estado.json'), 'utf-8'));
            estado = e.estado || 'nuevo';
          } catch {}
          const ts = Number(f.split('_')[0]) || 0;
          items.push({ id: f, tema, estado, ts });
        }
        items.sort((a, b) => b.ts - a.ts);
        const last10 = items.slice(0, 10);
        if (!last10.length) return res.json({ lines: ['  (no hay tandas todavía)'] });
        return res.json({ lines: last10.map(t => `  [${t.estado}] ${t.id}  —  ${t.tema}`) });
      }

      case 'info': {
        const id = args[0];
        if (!id || !isValidTandaId(id)) return res.json({ lines: ['  ✗ id inválido. Uso: /info <id>'] });
        try {
          const c = JSON.parse(await readFile(path.join(__dirname, 'tandas', id, 'contenido.analizado.json'), 'utf-8'));
          const estado = JSON.parse(await readFile(path.join(__dirname, 'tandas', id, 'estado.json'), 'utf-8')).estado || 'nuevo';
          const lines = [
            `  id:     ${id}`,
            `  estado: ${estado}`,
            `  marca:  ${c._marca || '—'}`,
            `  slides: ${c.slides?.length || 0}`,
            ...( c.slides || []).map((s, i) => `    slide ${i+1} [${s.type}]: ${(s.headline || s.title || s.stat || '').replace(/\n/g,' ').slice(0,50)}`),
          ];
          return res.json({ lines });
        } catch {
          return res.json({ lines: [`  ✗ Tanda no encontrada: ${id}`] });
        }
      }

      case 'generar': {
        const tema = args.join(' ');
        if (!tema) return res.json({ lines: ['  ✗ Uso: /generar <tema del carrusel>'] });
        if (jobRunning) return res.json({ lines: ['  ✗ Ya hay una generación en curso. Esperá a que termine.'] });
        jobRunning = true;
        jobLog = [];
        res.json({ lines: [`  ▶ Generando: "${tema}"...`, '  Conectando al log en vivo...'], streaming: true });
        (async () => {
          try {
            const carpeta = path.join('tandas', `${Date.now()}_${slugify(tema)}`);
            broadcast(`\n=== Consola: Generando "${tema}" (marca: ${marca}) ===\n`);
            await runStep(['crear.mjs', tema, carpeta, marca]);
            await runStep(['analizar.mjs', `${carpeta}/contenido.json`]);
            await runStep(['generar.mjs', `${carpeta}/contenido.analizado.json`]);
            broadcast(`\n✅ Listo: ${carpeta}\n`);
          } catch(e) {
            broadcast(`\n❌ Error: ${e.message}\n`);
          } finally {
            jobRunning = false;
          }
        })();
        return;
      }

      case 'analizar': {
        const id = args[0];
        if (!id || !isValidTandaId(id)) return res.json({ lines: ['  ✗ Uso: /analizar <id>'] });
        if (jobRunning) return res.json({ lines: ['  ✗ Hay una generación en curso.'] });
        const contenidoPath = `tandas/${id}/contenido.json`;
        try { await readFile(path.join(__dirname, contenidoPath)); } catch {
          return res.json({ lines: [`  ✗ Tanda no encontrada: ${id}`] });
        }
        jobRunning = true;
        jobLog = [];
        res.json({ lines: [`  ▶ Analizando ${id}...`], streaming: true });
        (async () => {
          try {
            broadcast(`\n=== Consola: Analizando ${id} ===\n`);
            await runStep(['analizar.mjs', contenidoPath]);
            broadcast(`\n✅ Análisis completo\n`);
          } catch(e) {
            broadcast(`\n❌ Error: ${e.message}\n`);
          } finally {
            jobRunning = false;
          }
        })();
        return;
      }

      case 'guardar':
      case 'descartar': {
        const id = args[0];
        if (!id || !isValidTandaId(id)) return res.json({ lines: [`  ✗ Uso: /${cmd} <id>`] });
        const estado = cmd === 'guardar' ? 'guardado' : 'descartado';
        try {
          await writeFile(path.join(__dirname, 'tandas', id, 'estado.json'), JSON.stringify({ estado }, null, 2));
          return res.json({ lines: [`  ✓ Tanda ${id} marcada como ${estado}.`] });
        } catch {
          return res.json({ lines: [`  ✗ No se pudo actualizar: tanda no encontrada`] });
        }
      }

      case 'fotos': {
        const lista = [...fotosCloud.entries()];
        if (!lista.length) return res.json({ lines: ['  (no hay fotos subidas)'] });
        return res.json({ lines: lista.map(([nombre]) => `  ${nombre}`) });
      }

      default:
        return res.json({ lines: [`  ✗ Comando desconocido: /${cmd}. Escribí /help para ver los comandos.`] });
    }
  }

  // Chat con IA (lenguaje natural)
  try {
    let tandaCtx = '';
    try {
      const dir = path.join(__dirname, 'tandas');
      const folders = await readdir(dir);
      const sorted = folders
        .map(f => ({ id: f, ts: Number(f.split('_')[0]) || 0 }))
        .sort((a,b) => b.ts - a.ts)
        .slice(0, 5);
      tandaCtx = sorted.map(t => `- ${t.id}`).join('\n');
    } catch {}

    const systemPrompt = `Sos el asistente de control de Carruselesgen — un generador de carruseles de Instagram.
El usuario puede pedirte cosas en lenguaje natural y vos respondés con una acción JSON.

Tandas recientes disponibles:
${tandaCtx || '(ninguna)'}

Comandos disponibles: /listar, /info <id>, /generar <tema>, /analizar <id>, /guardar <id>, /descartar <id>, /fotos

Respondé SOLO con un JSON así:
{ "mensaje": "texto para mostrarle al usuario", "comando": "/comando a ejecutar o null si no hay acción" }

Usuario: "hola"
{ "mensaje": "Hola. Podés escribir /help para ver qué puedo hacer, o pedirme algo en lenguaje natural.", "comando": null }`;

    const raw = await callBlackboxText(`${systemPrompt}\n\nUsuario: "${input}"`, 300);
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      return res.json({ lines: [`  IA: ${raw.slice(0, 200)}`] });
    }

    const mensaje = parsed.mensaje || '';
    const comando = parsed.comando || null;

    if (!comando) {
      return res.json({ lines: mensaje ? [`  IA: ${mensaje}`] : ['  (sin respuesta)'] });
    }

    const subRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/consola`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: req.headers.cookie || '' },
      body: JSON.stringify({ input: comando, marca })
    });
    const subData = await subRes.json();
    return res.json({
      lines: [
        ...(mensaje ? [`  IA: ${mensaje}`] : []),
        ...(subData.lines || [])
      ],
      streaming: subData.streaming,
    });
  } catch(e) {
    return res.json({ lines: [`  ✗ Error IA: ${e.message}`] });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Chat conversacional — asistente de IA para gestionar carruseles
app.post('/api/chat', async (req, res) => {
  const { message, history = [], marca: marcaId = 'squadteam' } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Falta message' });
  if (!isValidMarcaId(marcaId)) return res.status(400).json({ error: 'Marca inválida' });

  const dir = path.join(__dirname, 'tandas');
  let tandas = [];
  try {
    const folders = await readdir(dir);
    for (const f of folders) {
      const outDir = path.join(dir, f, 'output');
      let slides;
      try { slides = (await readdir(outDir)).filter(x => x.endsWith('.png')).sort(); } catch { continue; }
      if (!slides.length) continue;

      let tema = f;
      try {
        const c = JSON.parse(await readFile(path.join(dir, f, 'contenido.json'), 'utf-8'));
        const cover = c.slides?.find(s => s.type === 'cover');
        tema = (cover?.headline || tema).replace(/\n/g, ' ');
      } catch {}

      let estado = 'nuevo';
      try { estado = JSON.parse(await readFile(path.join(dir, f, 'estado.json'), 'utf-8')).estado || 'nuevo'; } catch {}

      const ts = Number(f.split('_')[0]) || 0;
      const fecha = ts ? new Date(ts).toLocaleDateString('es-UY') : '?';
      tandas.push({ id: f, tema, fecha, estado, slides: slides.length });
    }
    tandas.sort((a, b) => (Number(b.id.split('_')[0]) || 0) - (Number(a.id.split('_')[0]) || 0));
  } catch {}

  let marca = {};
  try { marca = JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'marca.json'), 'utf-8')); } catch {}

  const tandasResumen = tandas.length
    ? tandas.slice(0, 20).map((t, i) => `${i === 0 ? '[MAS RECIENTE] ' : ''}- ID: ${t.id} | Tema: "${t.tema}" | ${t.slides} slides | ${t.fecha} | Estado: ${t.estado}`).join('\n')
    : 'No hay carruseles generados todavia.';

  // Detectar carrusel mencionado en la conversacion reciente
  const allText = history.slice(-8).map(h => h.content).concat([message]).join(' ').toLowerCase();
  const refersToLast = /ultimo|reciente|ese|eso|ese carrusel|el carrusel/.test(allText);

  // Prioridad: ID explicito -> tema -> "ultimo" -> primero de la lista
  let contextTandaId = tandas.find(t => allText.includes(t.id.toLowerCase()))?.id
    || tandas.find(t => t.tema.length > 5 && allText.includes(t.tema.toLowerCase().slice(0, 15)))?.id
    || (refersToLast && tandas[0]?.id)
    || null;

  // Mirar si el asistente menciono un ID en mensajes recientes
  if (!contextTandaId) {
    const assistantTexts = history.slice(-6).filter(h => h.role === 'assistant').map(h => h.content).join(' ');
    contextTandaId = tandas.find(t => assistantTexts.includes(t.id))?.id || null;
  }

  // Si no se encontro ninguno, usar la mas reciente como contexto por defecto
  if (!contextTandaId && tandas.length) contextTandaId = tandas[0].id;

  let tandaContexto = '';
  if (contextTandaId) {
    try {
      const tc = JSON.parse(await readFile(path.join(__dirname, 'tandas', contextTandaId, 'contenido.analizado.json'), 'utf-8'));
      const slidesInfo = tc.slides.map((s, i) => {
        const titulo = s.headline || s.title || (Array.isArray(s.headline_lines) ? s.headline_lines.join(' ') : '') || s.stat || '';
        const sub = s.subheadline || s.body || s.caption || '';
        const handle = s.handle ? ` | handle="${s.handle}"` : '';
        return `  Slide ${i + 1} (${s.type}): headline="${titulo}"${sub ? ` | sub="${sub}"` : ''}${handle}${s.photo ? ' | [foto]' : ''}`;
      }).join('\n');
      tandaContexto = `\n\nCONTENIDO DEL CARRUSEL EN CONTEXTO (ID: ${contextTandaId}):\n${slidesInfo}`;
    } catch {}
  }

  const systemPrompt = `Sos el asistente de CarruselGen para la marca "${marca.nombre || marcaId}".
Ayudas al usuario a gestionar y crear carruseles e historias de Instagram generados con IA.
El handle de Instagram de la marca es: ${marca.handle || '@tumarca'}

CARRUSELES DISPONIBLES (mas recientes primero):
${tandasResumen}${tandaContexto}

ACCIONES QUE PODES TOMAR:
Cuando el usuario quiera realizar una accion concreta, inclui EXACTAMENTE este bloque al final de tu respuesta:
<action>{"type":"TIPO","params":{...}}</action>

Tipos de accion disponibles:
- show_tanda: { "id": "tanda_id" } — abre el carrusel en la galeria
- set_estado: { "id": "tanda_id", "estado": "guardado" } — marca como "guardado" o "descartado"
- go_tab: { "tab": "tab-galeria" } — navega a una pestana
- open_editor: { "id": "tanda_id", "slide": 1 } — abre el editor visual
- edit_slide: { "id": "tanda_id", "slide": 3, "fields": { "headline": "nuevo texto" } } — edita campos de texto de un slide y RE-RENDERIZA automaticamente. Campos: headline, subheadline, body, caption, kicker, eyebrow, stat, label, note, detail, sub, attr, footer_text, handle
- propose_plan: { "format": "carrusel"|"story", "tema": "resumen del tema acordado", "slides": [{"position":1,"type":"cover","title":"descripcion breve","notes":"que va aqui"},...] } — propone un plan de slides para que el usuario lo apruebe o modifique ANTES de generar
- confirm_generate: { "format": "carrusel"|"story", "tema": "tema completo con todo el contexto acordado", "plan": [{"position":1,"type":"cover","title":"...","notes":"..."},...] } — ejecuta la generacion con el plan acordado. Usar SOLO cuando el usuario confirme explicitamente ("si", "dale", "generá", "asi esta bien", "perfecto").

MODO PLANIFICADOR — REGLA PRINCIPAL:
Cuando el usuario quiera crear algo NUEVO (carrusel, story, infograma, transformacion, etc.), NO uses confirm_generate directamente.
Primero entendes el pedido, haces 1-2 preguntas clave si falta informacion, luego propones un plan con propose_plan.
El usuario puede modificar el plan conversacionalmente. Solo cuando confirme, uses confirm_generate.

Preguntas utiles segun el caso:
- ¿Es para el feed (carrusel 4:5) o para historias (story 9:16)?
- ¿Tiene fotos para usar o es tipografico?
- ¿Cual es el objetivo: educar, vender, mostrar un resultado, contar un proceso?
- Si es transformacion: ¿cuantas semanas, que cambio, hay testimonio del alumno?

Tipos de slide disponibles para el plan:
  cover, list, statement, quote, cta, split_v, before_after, big_number, timeline, grid, grid_stats, comparison, steps, icon_list

REGLAS CRITICAS:
- Usa SIEMPRE el ID exacto de la lista. NUNCA inventes o modifiques IDs.
- El servidor EJECUTA la accion. No describas si funciono o fallo — solo genera el bloque <action> correcto.
- NUNCA generes mensajes de error como "Tanda no encontrada" — eso es trabajo del servidor, no tuyo.
- Si el usuario dice "el ultimo carrusel" o "ese carrusel", usa el ID marcado como [MAS RECIENTE].
- El carrusel EN CONTEXTO es el que tenes detallado arriba. Refiere a ese por defecto salvo que el usuario pida otro.
- Si el usuario pide editar multiples slides, edita uno por respuesta y avisa que seguiras con el proximo.
- Responde en espanol rioplatense, amigable y conciso.
- Usa el historial del chat para mantener contexto.`;

  const messages = [
    ...history.slice(-14).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  try {
    const raw = await bbFetch({ max_tokens: 700, system: systemPrompt, messages });

    const actionMatch = raw.match(/<action>([\s\S]*?)<\/action>/);
    let action = null;
    let reply = raw.replace(/<action>[\s\S]*?<\/action>/g, '').trim();

    if (actionMatch) {
      try { action = JSON.parse(actionMatch[1]); } catch {}
    }

    // Ejecutar edit_slide server-side
    if (action?.type === 'edit_slide') {
      const { id: tandaId, slide: slideNum, fields } = action.params || {};
      if (isValidTandaId(tandaId) && slideNum && fields && typeof fields === 'object') {
        try {
          const contenidoPath = path.join(__dirname, 'tandas', tandaId, 'contenido.analizado.json');
          const contenido = JSON.parse(await readFile(contenidoPath, 'utf-8'));
          const idx = Number(slideNum) - 1;
          if (contenido.slides[idx]) {
            Object.assign(contenido.slides[idx], fields);
            await writeFile(contenidoPath, JSON.stringify(contenido, null, 2), 'utf-8');
            if (!jobRunning) {
              jobRunning = true;
              jobLog = [];
              const extraEnv = {};
              if (fotosCloud.size > 0) {
                const mapObj = {};
                for (const [n, { url }] of fotosCloud.entries()) mapObj[n] = url;
                extraEnv.FOTOS_MAP = JSON.stringify(mapObj);
              }
              runStep(['generar.mjs', `tandas/${tandaId}/contenido.analizado.json`], extraEnv)
                .catch(e => broadcast(`\n\u274c ${e.message}\n`))
                .finally(() => { jobRunning = false; });
            }
            action.executed = true;
          }
        } catch (e) {
          reply += `\n(No pude aplicar la edicion: ${e.message})`;
        }
      }
    }

    // Ejecutar confirm_generate server-side
    if (action?.type === 'confirm_generate') {
      const { format = 'carrusel', tema = '', plan = [] } = action.params || {};
      if (!jobRunning && tema) {
        jobRunning = true;
        jobLog = [];
        const extraEnv = {};
        if (fotosCloud.size > 0) {
          const mapObj = {};
          for (const [n, { url }] of fotosCloud.entries()) mapObj[n] = url;
          extraEnv.FOTOS_MAP = JSON.stringify(mapObj);
        }
        if (plan.length) extraEnv.USER_PLAN = JSON.stringify(plan);
        const carpeta = path.join(format === 'story' ? 'stories' : 'tandas', `${Date.now()}_${slugify(tema)}`);
        const scripts = format === 'story'
          ? [['crear-story.mjs', tema, carpeta, marcaId], ['analizar.mjs', `${carpeta}/contenido.json`], ['generar-story.mjs', `${carpeta}/contenido.analizado.json`]]
          : [['crear.mjs', tema, carpeta, marcaId], ['analizar.mjs', `${carpeta}/contenido.json`], ['generar.mjs', `${carpeta}/contenido.analizado.json`]];
        (async () => {
          try {
            broadcast(`\n=== Chat: Generando "${tema}" (${format}) ===\n`);
            for (const step of scripts) {
              // analizar.mjs necesita saber si es story (9:16) para adaptar el análisis de composición
              const stepEnv = (format === 'story' && step[0] === 'analizar.mjs')
                ? { ...extraEnv, STORY_FORMAT: '1' }
                : extraEnv;
              await runStep(step, stepEnv);
            }
            broadcast(`\n✅ Listo: ${carpeta}\n`);
          } catch (e) {
            broadcast(`\n❌ ${e.message}\n`);
          } finally { jobRunning = false; }
        })();
        action.executing = true;
        action.carpeta = carpeta;
      } else if (jobRunning) {
        reply += '\n(Hay una generación en curso, esperá a que termine.)';
        action = null;
      }
    }

    res.json({ reply, action });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎬 Carrusel Generator UI → http://localhost:${PORT}`));
