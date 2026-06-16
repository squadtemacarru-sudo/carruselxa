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

      // Resuelve nombres de archivo a URLs de Cloudinary si están disponibles
      const fotosRaw = Array.isArray(req.body.fotos) ? req.body.fotos.filter(f => EXT_RE.test(f)) : [];
      const fotos = fotosRaw.map(f => fotosCloud.get(f) || f);

      // Construir env extra desde las respuestas del usuario
      const respuestas = req.body.respuestas || {};
      const instrLibres = (req.body.instruccionesLibres || '').trim();
      const extraEnv = {};

      const instrLines = [];
      if (respuestas.overlay !== undefined) instrLines.push(`El campo "overlay" del JSON DEBE ser exactamente ${respuestas.overlay}`);
      if (respuestas.texto_size === 'Compacto') instrLines.push('Texto compacto: podés incluir más detalle, frases de 6-10 palabras, párrafos cortos');
      else if (respuestas.texto_size === 'Grande') instrLines.push('Texto grande: headlines de máximo 4-5 palabras, evitá párrafos largos, priorizá impacto visual');
      if (respuestas.tono) instrLines.push(`Tono del copy: ${respuestas.tono}`);
      for (const [id, val] of Object.entries(respuestas)) {
        if (['overlay', 'texto_size', 'tono', 'rotaciones'].includes(id)) continue;
        if (typeof val === 'string') instrLines.push(`${id.replace(/_/g, ' ')}: ${val}`);
      }
      if (instrLibres) instrLines.push(`Instrucción directa del usuario: "${instrLibres}"`);
      if (instrLines.length) extraEnv.USER_INSTRUCCIONES = instrLines.join('\n');
      if (respuestas.overlay !== undefined) extraEnv.USER_OVERLAY = String(respuestas.overlay);
      if (req.body.model) extraEnv.USER_MODEL = req.body.model;

      // Rotaciones: resolver nombres a URLs reales (igual que fotos)
      const rotacionesResueltas = {};
      for (const [nombre, grados] of Object.entries(respuestas.rotaciones || {})) {
        const realKey = fotosCloud.get(nombre) || nombre;
        rotacionesResueltas[realKey] = grados;
      }
      if (Object.keys(rotacionesResueltas).length) extraEnv.USER_ROTATIONS = JSON.stringify(rotacionesResueltas);

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
            contenido.slides[idx].photo = fotosCloud.get(nombre) || nombre;
            broadcast(`📌 Slide ${posStr} → ${nombre}\n`);
          }
        }
        await writeFile(contenidoPath, JSON.stringify(contenido, null, 2), 'utf-8');
      }

      await runStep(['analizar.mjs', `${carpeta}/contenido.json`], extraEnv);
      await runStep(['generar.mjs', `${carpeta}/contenido.analizado.json`], extraEnv);
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
// Helpers IA — texto y visión
// ─────────────────────────────────────────────────────────────────────

const BB_FALLBACK_MODELS = [
  'blackboxai/anthropic/claude-sonnet-4.6',
  'blackboxai/anthropic/claude-sonnet-4.5',
  'claude-3-5-sonnet-20241022',
];

async function bbFetch(body, attempt = 0) {
  const apiKey = process.env.BLACKBOX_API_KEY;
  if (!apiKey) throw new Error('Falta BLACKBOX_API_KEY');
  const model = process.env.BLACKBOX_MODEL || BB_FALLBACK_MODELS[Math.min(attempt, BB_FALLBACK_MODELS.length - 1)];
  const res  = await fetch('https://api.blackbox.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ ...body, model })
  });
  const data = await res.json();
  if (!res.ok) {
    const is429 = res.status === 429 || JSON.stringify(data).includes('RESOURCE_EXHAUSTED') || JSON.stringify(data).includes('429');
    if (is429 && attempt < 3) {
      const delay = [8000, 20000, 40000][attempt];
      console.warn(`⏳ Rate limit servidor (intento ${attempt + 1}) — reintentando en ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return bbFetch(body, attempt + 1);
    }
    throw new Error(`Blackbox: ${data.error?.message || JSON.stringify(data)}`);
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
${tieneFotos ? `Hay ${req.body.fotoUrls.length} foto(s) que se usarán como fondo en algunos slides.` : 'Es un carrusel 100% tipográfico (sin fotos de fondo).'}

Hacé exactamente 3 preguntas muy específicas para personalizar el carrusel. Cada pregunta debe impactar directamente en el resultado.

Tipos disponibles:
- "opciones": el usuario elige entre 3-4 alternativas concretas
- "slider": para valores numéricos — SOLO para overlay (oscuridad de la foto, min 0.2 max 0.8, default 0.45)

Preguntas sugeridas (elegí las 3 más relevantes para ESTE tema):
- Oscuridad del fondo de fotos (solo si hay fotos): tipo slider
- Tamaño del texto en los titulares: tipo opciones, valores ["Compacto", "Normal", "Grande"], default "Normal"
- Tono del copy: tipo opciones, elige 3 de ["Directo y corto", "Educativo y detallado", "Provocador", "Motivacional", "Técnico y preciso", "Conversacional"]
- Ángulo del tema: tipo opciones, inventá 3 ángulos ESPECÍFICOS para este tema exacto (ej. para "errores en dieta" podría ser "Por qué los comete la gente", "Cómo identificarlos", "Cómo corregirlos")
- Foco del primer slide: tipo opciones, valores concretos relacionados al tema
- Estructura interna: tipo opciones, relacionada a cómo presentar la info de este tema

Respondé SOLO con un JSON array de exactamente 3 objetos. Sin markdown, sin explicaciones.
Formato opciones: {"id":"tono","pregunta":"¿Qué tono?","tipo":"opciones","opciones":["A","B","C"],"default":"A"}
Formato slider: {"id":"overlay","pregunta":"¿Qué tan oscuro?","tipo":"slider","min":0.2,"max":0.8,"step":0.05,"default":0.45,"label_min":"Claro","label_max":"Oscuro"}`;

  const FALLBACK = [
    { id: 'tono', pregunta: '¿Qué tono querés para el copy?', tipo: 'opciones', opciones: ['Directo y corto', 'Educativo y detallado', 'Provocador'], default: 'Directo y corto' },
    { id: 'texto_size', pregunta: '¿Tamaño del texto en los titulares?', tipo: 'opciones', opciones: ['Compacto', 'Normal', 'Grande'], default: 'Normal' },
    ...(tieneFotos ? [{ id: 'overlay', pregunta: '¿Qué tan oscuro el fondo de las fotos?', tipo: 'slider', min: 0.2, max: 0.8, step: 0.05, default: 0.45, label_min: 'Claro (foto visible)', label_max: 'Oscuro (texto prioritario)' }] : [{ id: 'foco_cover', pregunta: '¿Cómo arrancás el primer slide?', tipo: 'opciones', opciones: ['Afirmación rotunda', 'Pregunta que enganche', 'Dato o estadística'], default: 'Afirmación rotunda' }])
  ];

  try {
    const raw = await callBlackboxText(prompt, 700);
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
  await writeFile(path.join(__dirname, 'tandas', id, 'contenido.analizado.json'), JSON.stringify(req.body, null, 2), 'utf-8');
  res.json({ ok: true });
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

Escribí un caption para Instagram que acompañe este carrusel. Tiene que tener:
1. Una primera línea GANCHO (máximo 10 palabras, que detenga el scroll)
2. 2-4 líneas de cuerpo que desarrollen el tema con valor real
3. Una línea de CTA clara y directa
4. Un salto de línea y luego 20-25 hashtags relevantes (en minúsculas, sin espacios entre #)

Idioma: español rioplatense (vos, usás, etc).
Sin emojis a menos que sean muy naturales. Sin frases genéricas ni motivacionales vacías.
Devolvé SOLO el caption, sin explicaciones ni comillas.`;

  try {
    const caption = await callBlackboxText(prompt, 800);
    res.json({ caption: caption.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// Mapa en memoria: filename → cloudinary URL (se pierde en restart pero las fotos quedan en Cloudinary)
const fotosCloud = new Map();

async function uploadFotoToCloudinary(filePath, filename) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const preset    = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloudName || !preset) return null;

  const ext  = path.extname(filename).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'image/jpeg';
  const buf  = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), filename);
  form.append('upload_preset', preset);
  form.append('folder', 'carruselesgen/fotos');

  const res  = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok) {
    console.error('Cloudinary fotos error:', data.error?.message);
    return null;
  }
  return data.secure_url;
}

// Listar fotos disponibles
app.get('/api/fotos', async (req, res) => {
  try {
    const files = (await readdir(FOTOS_DIR)).filter(f => EXT_RE.test(f) && !f.startsWith('.'));
    res.json(files.map(nombre => ({
      nombre,
      url: fotosCloud.get(nombre) || `/fotos/${encodeURIComponent(nombre)}`
    })));
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
    const localPath = path.join(FOTOS_DIR, filename);
    await writeFile(localPath, body);

    // Subir a Cloudinary en background (no bloquea la respuesta)
    uploadFotoToCloudinary(localPath, filename)
      .then(url => { if (url) fotosCloud.set(filename, url); })
      .catch(() => {});

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
    fotosCloud.delete(nombre);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'No encontrada' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎬 Carrusel Generator UI → http://localhost:${PORT}`));
