/**
 * analizar.mjs v3 — Sistema de diseño completo con IA
 *
 * Uso:
 *   node analizar.mjs [contenido.json]
 *
 * Fases:
 *   1. Lee el contenido y detecta tema/tono
 *   2. Investiga tendencias + fuentes + iconos + paletas en la web
 *   3. Define el sistema de diseño completo para este carrusel
 *   4. Analiza cada foto individualmente con ese sistema como guía
 *   5. Genera contenido.analizado.json listo para renderizar
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 5 * 1024 * 1024; // límite de la API para imágenes en base64

// ─────────────────────────────────────────────────────────────────────
// PREVIEW EN VIVO — si se pasa --preview, cada fase emite eventos al server
// principal vía HTTP POST. El preview está integrado en server.mjs en /preview.
// Si el servidor no está levantado, los POST fallan en silencio.
// ─────────────────────────────────────────────────────────────────────
const PREVIEW = process.argv.includes('--preview');
// PREVIEW_PORT sigue funcionando para el preview-server.mjs standalone (legacy).
// PORT apunta al server principal cuando está corriendo.
const PREVIEW_PORT = process.env.PORT || process.env.PREVIEW_PORT || 3000;
const USER_FONT_PAIR = process.env.USER_FONT_PAIR || '';

function broadcast(type, payload) {
  if (!PREVIEW) return;
  fetch(`http://localhost:${PREVIEW_PORT}/preview/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, payload }),
  }).catch(() => {});
}

// Carga el perfil de marca (marca.json) si existe — define voz, audiencia,
// palabras a evitar y paleta de referencia para mantener coherencia entre carruseles
async function loadMarca(marcaId) {
  try {
    return JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'marca.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function marcaContext(marca) {
  if (!marca) return '';
  return `
CONTEXTO DE MARCA (mantené coherencia con esto):
- Marca: ${marca.nombre} — ${marca.industria}
- Audiencia: ${marca.audiencia}
- Posicionamiento: ${marca.posicionamiento}
- Voz y tono: ${marca.voz}
- Palabras/clichés a evitar: ${marca.evitar?.join(', ')}
- Paleta de referencia: fondo ${marca.paleta_marca?.fondo}, acento ${marca.paleta_marca?.acento} (${marca.paleta_marca?.descripcion})
`;
}

// Convierte una imagen a base64, achicando si hace falta para no superar el
// límite de tamaño de la API (esto es solo para el análisis, el render
// final usa la foto original a full calidad)
async function fileToBase64(abs) {
  let buf = await readFile(abs);

  // La extensión del archivo no siempre coincide con el formato real
  // (ej. screenshots de iPhone guardados como .PNG que en realidad son JPEG) —
  // la API rechaza el request si el mime declarado no matchea el contenido.
  const { format } = await sharp(buf).metadata();
  let mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format] || 'image/jpeg';

  if (Buffer.byteLength(buf.toString('base64')) > MAX_BYTES) {
    buf = await sharp(buf).resize({ width: 1568, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    mime = 'image/jpeg';
  }

  return { base64: buf.toString('base64'), mime };
}

// Mapa filename → Cloudinary URL inyectado por server.mjs
let FOTOS_MAP = {};
try { if (process.env.FOTOS_MAP) FOTOS_MAP = JSON.parse(process.env.FOTOS_MAP); } catch {}

async function fetchToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar foto: ${url}`);
  let buf = Buffer.from(await res.arrayBuffer());
  // Detectar formato real con sharp — la URL puede decir .png pero ser JPEG
  const { format } = await sharp(buf).metadata();
  let mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format] || 'image/jpeg';
  if (Buffer.byteLength(buf.toString('base64')) > MAX_BYTES) {
    buf  = await sharp(buf).resize({ width: 1568, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    mime = 'image/jpeg';
  }
  return { base64: buf.toString('base64'), mime };
}

async function photoToBase64(relPath) {
  if (relPath.startsWith('http://') || relPath.startsWith('https://')) {
    return fetchToBase64(relPath);
  }
  const filename = path.basename(relPath);
  const mapped = FOTOS_MAP[filename];
  if (mapped && (mapped.startsWith('http://') || mapped.startsWith('https://'))) {
    return fetchToBase64(mapped);
  }
  return fileToBase64(path.join(__dirname, 'fotos', filename));
}

// Carga carruseles de referencia (referencias/*.jpg|png|webp) que el usuario
// quiere usar como inspiración visual para la Fase 2
async function loadReferencias(marcaId) {
  const dir = path.join(__dirname, 'marcas', marcaId, 'referencias');
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const imgs = files.filter(f => /\.(jpe?g|png|webp)$/i.test(f));
  const out = [];
  for (const f of imgs) {
    out.push(await fileToBase64(path.join(dir, f)));
  }
  return out;
}

// Persona aplicada a todas las llamadas — fija el nivel de criterio esperado
// para que las 3 fases respondan con la misma vara de "experto", no genérica
const SYSTEM_PROMPT = `Sos un equipo de élite de 2 personas trabajando como una sola: un director de arte senior con más de 15 años en agencias top de contenido para Instagram, y un estratega de marketing/copywriting senior especializado en marcas personales de fitness y coaching premium.

Como director de arte conocés a fondo: tipografía editorial (qué combinaciones de Google Fonts realmente funcionan juntas y por qué), paletas de alto contraste que generan guardados/shares, tendencias visuales actuales de carruseles que performan (no las de hace 3 años), y cómo traducir un sistema de diseño en decisiones de CSS concretas y aplicables.

Como estratega de marketing entendés copywriting persuasivo, niveles de consciencia de audiencia (Schwartz), psicología del scroll-stop, y cómo cada decisión visual (jerarquía, contraste, posición del texto) sirve al objetivo de retención y conversión del carrusel — no es decoración, es estrategia aplicada.

Tus respuestas son siempre específicas y accionables — nunca genéricas, nunca "depende". Si te piden un valor (hex, font-family, line-height), das el valor exacto, no un rango ni una sugerencia vaga.

Respondés SIEMPRE en el formato exacto solicitado (JSON puro, sin \`\`\`markdown\`\`\` ni texto antes o después), sin explicaciones adicionales fuera del JSON.`;

const FALLBACK_MODELS = [
  'claude-sonnet-4-5-20250514',
  'claude-haiku-4-5-20251001',
  'blackboxai/anthropic/claude-sonnet-4.6',
];

// Llama a Blackbox AI (API OpenAI-compatible) y devuelve el texto de la respuesta
async function callBlackbox(content, attempt = 0) {
  const apiKey = process.env.BLACKBOX_API_KEY;
  if (!apiKey) throw new Error('Falta la variable de entorno BLACKBOX_API_KEY');

  const model = process.env.BLACKBOX_MODEL || FALLBACK_MODELS[Math.min(attempt, FALLBACK_MODELS.length - 1)];

  let response;
  try {
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 20000);
    try {
      response = await fetch('https://api.blackbox.ai/chat/completions', {
        signal: ac.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          max_tokens: 3000,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content }
          ]
        })
      });
    } finally {
      clearTimeout(abortTimer);
    }
  } catch (netErr) {
    // Timeout de red (UND_ERR_HEADERS_TIMEOUT, ECONNRESET, etc.) — reintentamos
    if (attempt < 3) {
      const delay = [3000, 8000, 15000][attempt];
      console.warn(`⏳ Error de red Blackbox (intento ${attempt + 1}): ${netErr.message} — reintentando en ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return callBlackbox(content, attempt + 1);
    }
    throw netErr;
  }

  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    const preview = rawText.slice(0, 300).replace(/\n/g, ' ');
    if (attempt < 3) {
      const delay = [3000, 8000, 15000][attempt];
      console.warn(`⏳ Respuesta no-JSON de Blackbox (intento ${attempt + 1}, status ${response.status}) — reintentando en ${delay / 1000}s...`);
      console.warn(`   Preview: ${preview}`);
      await new Promise(r => setTimeout(r, delay));
      return callBlackbox(content, attempt + 1);
    }
    throw new Error(`Blackbox devolvió HTML/no-JSON (status ${response.status}): ${preview}`);
  }
  if (!response.ok) {
    const body = JSON.stringify(data);
    const is429 = response.status === 429 || body.includes('RESOURCE_EXHAUSTED') || body.includes('429');
    if (is429 && attempt < 3) {
      const delay = [3000, 8000, 15000][attempt];
      console.warn(`⏳ Rate limit (intento ${attempt + 1}) — reintentando en ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return callBlackbox(content, attempt + 1);
    }
    throw new Error(`Blackbox API error: ${data.error?.message || body}`);
  }
  return data.choices?.[0]?.message?.content || '';
}

// La IA a veces devuelve saltos de línea/tabs literales y comillas rectas
// sin escapar dentro de los strings del JSON (válido en texto plano,
// inválido en JSON estricto). Los arreglamos sin tocar el resto del documento.
function sanitizeJson(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString && ch === '\\') { out += ch + (text[i + 1] ?? ''); i++; continue; }
    if (ch === '"') {
      if (!inString) { inString = true; out += ch; continue; }
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j];
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    if (inString && ch === '\n') { out += '\\n'; continue; }
    if (inString && ch === '\r') { out += '\\r'; continue; }
    if (inString && ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// FONT PAIRS — curados y verificados en Google Fonts
// La IA elige el ID; nosotros inyectamos las URLs reales.
// ─────────────────────────────────────────────────────────────────────
const FONT_PAIRS = {
  'barlow-condensed-black': {
    mood: 'fitness extremo, impacto hero, headlines multi-color, referencias Instagram virales',
    estilos: ['editorial_brutal', 'street_urban', 'coaching_premium'],
    tipografia: {
      display: { familia: 'Barlow Condensed', url_import: 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,700;0,800;0,900;1,700&display=swap', pesos: [700,800,900], uso: 'headlines ultra-condensed impact', css_headline: "font-family:'Barlow Condensed',sans-serif;font-weight:900;letter-spacing:0.01em;text-transform:uppercase;" },
      body:    { familia: 'Barlow', url_import: 'https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&display=swap', pesos: [400,500,600,700], uso: 'cuerpo bold', css_body: "font-family:'Barlow',sans-serif;font-weight:600;" },
      mono:    { familia: 'Barlow', url_import: null, uso: 'tags, datos' }
    }
  },
  'bebas-inter': {
    mood: 'editorial brutalista, fitness, impacto, uppercase bold',
    estilos: ['editorial_brutal', 'street_urban'],
    tipografia: {
      display: { familia: 'Bebas Neue', url_import: 'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap', pesos: [400], uso: 'headlines uppercase', css_headline: "font-family:'Bebas Neue',sans-serif;font-weight:400;letter-spacing:0.03em;text-transform:uppercase;" },
      body:    { familia: 'Inter',      url_import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap', pesos: [400,500,600,700], uso: 'cuerpo, listas', css_body: "font-family:'Inter',sans-serif;font-weight:500;" },
      mono:    { familia: 'Inter',      url_import: null, uso: 'tags, handles' }
    }
  },
  'oswald-dm': {
    mood: 'deportivo, directo, masculino, condensado',
    estilos: ['editorial_brutal', 'street_urban', 'coaching_premium'],
    tipografia: {
      display: { familia: 'Oswald', url_import: 'https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&display=swap', pesos: [600,700], uso: 'headlines condensados', css_headline: "font-family:'Oswald',sans-serif;font-weight:700;letter-spacing:0.01em;text-transform:uppercase;" },
      body:    { familia: 'DM Sans', url_import: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap', pesos: [400,500,600], uso: 'cuerpo', css_body: "font-family:'DM Sans',sans-serif;font-weight:400;" },
      mono:    { familia: 'DM Sans', url_import: null, uso: 'tags' }
    }
  },
  'barlow-barlow': {
    mood: 'moderno, clean, tech, versátil, condensado',
    estilos: ['infografico_premium', 'tech_modern', 'editorial_brutal'],
    tipografia: {
      display: { familia: 'Barlow Condensed', url_import: 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&display=swap', pesos: [700,800,900], uso: 'headlines grandes', css_headline: "font-family:'Barlow Condensed',sans-serif;font-weight:900;letter-spacing:0.01em;text-transform:uppercase;" },
      body:    { familia: 'Barlow', url_import: 'https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&display=swap', pesos: [400,500,600], uso: 'cuerpo', css_body: "font-family:'Barlow',sans-serif;font-weight:500;" },
      mono:    { familia: 'Barlow', url_import: null, uso: 'tags' }
    }
  },
  'playfair-dm': {
    mood: 'luxury, premium, editorial, coaching sofisticado',
    estilos: ['photo_lifestyle', 'luxury_minimal', 'editorial_magazine'],
    tipografia: {
      display: { familia: 'Playfair Display', url_import: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800;900&display=swap', pesos: [700,800,900], uso: 'headlines elegantes', css_headline: "font-family:'Playfair Display',serif;font-weight:700;letter-spacing:-0.01em;" },
      body:    { familia: 'DM Sans', url_import: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&display=swap', pesos: [300,400,500], uso: 'cuerpo liviano', css_body: "font-family:'DM Sans',sans-serif;font-weight:400;letter-spacing:0.02em;" },
      mono:    { familia: 'DM Sans', url_import: null, uso: 'tags, handles' }
    }
  },
  'anton-inter': {
    mood: 'street, urbano, agresivo, acción, impacto crudo',
    estilos: ['street_urban', 'editorial_brutal'],
    tipografia: {
      display: { familia: 'Anton', url_import: 'https://fonts.googleapis.com/css2?family=Anton&display=swap', pesos: [400], uso: 'headlines impacto', css_headline: "font-family:'Anton',sans-serif;font-weight:400;letter-spacing:0.02em;text-transform:uppercase;" },
      body:    { familia: 'Inter', url_import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap', pesos: [400,500,600], uso: 'cuerpo', css_body: "font-family:'Inter',sans-serif;font-weight:500;" },
      mono:    { familia: 'Inter', url_import: null, uso: 'datos, tags' }
    }
  },
  'archivo-inter': {
    mood: 'editorial bold, diseño, moderno, impactante sin ser brutal',
    estilos: ['editorial_brutal', 'editorial_magazine', 'coaching_premium'],
    tipografia: {
      display: { familia: 'Archivo Black', url_import: 'https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap', pesos: [400], uso: 'headlines bold', css_headline: "font-family:'Archivo Black',sans-serif;font-weight:400;letter-spacing:-0.02em;" },
      body:    { familia: 'Inter', url_import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap', pesos: [400,500,600], uso: 'cuerpo', css_body: "font-family:'Inter',sans-serif;font-weight:500;" },
      mono:    { familia: 'Inter', url_import: null, uso: 'datos, tags' }
    }
  },
  'space-space': {
    mood: 'tech, datos, startup, minimal, futurista',
    estilos: ['infografico_premium', 'tech_modern'],
    tipografia: {
      display: { familia: 'Space Grotesk', url_import: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&display=swap', pesos: [600,700], uso: 'headlines tech', css_headline: "font-family:'Space Grotesk',sans-serif;font-weight:700;letter-spacing:-0.025em;" },
      body:    { familia: 'Space Grotesk', url_import: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500&display=swap', pesos: [400,500], uso: 'cuerpo', css_body: "font-family:'Space Grotesk',sans-serif;font-weight:400;" },
      mono:    { familia: 'Space Mono', url_import: 'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap', uso: 'datos, porcentajes' }
    }
  },
  'syne-inter': {
    mood: 'diseño de autor, agencia creativa, disruptivo, joven',
    estilos: ['tech_modern', 'editorial_brutal'],
    tipografia: {
      display: { familia: 'Syne', url_import: 'https://fonts.googleapis.com/css2?family=Syne:wght@700;800&display=swap', pesos: [700,800], uso: 'headlines display', css_headline: "font-family:'Syne',sans-serif;font-weight:800;letter-spacing:-0.01em;" },
      body:    { familia: 'Inter', url_import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap', pesos: [400,500,600], uso: 'cuerpo', css_body: "font-family:'Inter',sans-serif;font-weight:400;" },
      mono:    { familia: 'Inter', url_import: null, uso: 'tags' }
    }
  },
  'dm-serif-dm': {
    mood: 'revista, editorial cálido, aspiracional, coaching femenino',
    estilos: ['editorial_magazine', 'photo_lifestyle', 'luxury_minimal'],
    tipografia: {
      display: { familia: 'DM Serif Display', url_import: 'https://fonts.googleapis.com/css2?family=DM+Serif+Display&display=swap', pesos: [400], uso: 'headlines editorial', css_headline: "font-family:'DM Serif Display',serif;font-weight:400;letter-spacing:-0.01em;" },
      body:    { familia: 'DM Sans', url_import: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap', pesos: [400,500,600], uso: 'cuerpo, detalles', css_body: "font-family:'DM Sans',sans-serif;font-weight:400;letter-spacing:0.01em;" },
      mono:    { familia: 'DM Sans', url_import: null, uso: 'handles, tags' }
    }
  },
  'unbounded-inter': {
    mood: 'web3, tech extremo, bold futurista, new media',
    estilos: ['tech_modern', 'street_urban'],
    tipografia: {
      display: { familia: 'Unbounded', url_import: 'https://fonts.googleapis.com/css2?family=Unbounded:wght@700;800;900&display=swap', pesos: [700,800,900], uso: 'headlines máximo impacto', css_headline: "font-family:'Unbounded',sans-serif;font-weight:900;letter-spacing:-0.02em;text-transform:uppercase;" },
      body:    { familia: 'Inter', url_import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=swap', pesos: [400,500], uso: 'cuerpo compacto', css_body: "font-family:'Inter',sans-serif;font-weight:400;" },
      mono:    { familia: 'Inter', url_import: null, uso: 'datos' }
    }
  },
  'instrument-dm': {
    mood: 'ultra premium, luxury coaching, refinado, high-end',
    estilos: ['luxury_minimal', 'coaching_premium'],
    tipografia: {
      display: { familia: 'Instrument Serif', url_import: 'https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap', pesos: [400], uso: 'headlines refinados', css_headline: "font-family:'Instrument Serif',serif;font-weight:400;letter-spacing:0em;" },
      body:    { familia: 'DM Sans', url_import: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&display=swap', pesos: [300,400,500], uso: 'cuerpo minimalista', css_body: "font-family:'DM Sans',sans-serif;font-weight:300;letter-spacing:0.03em;" },
      mono:    { familia: 'DM Sans', url_import: null, uso: 'handles' }
    }
  },
  'montserrat-montserrat': {
    mood: 'versátil, limpio, corporativo premium, confiable',
    estilos: ['coaching_premium', 'infografico_premium'],
    tipografia: {
      display: { familia: 'Montserrat', url_import: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800;900&display=swap', pesos: [700,800,900], uso: 'headlines bold', css_headline: "font-family:'Montserrat',sans-serif;font-weight:900;letter-spacing:-0.01em;text-transform:uppercase;" },
      body:    { familia: 'Montserrat', url_import: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600&display=swap', pesos: [400,500,600], uso: 'cuerpo', css_body: "font-family:'Montserrat',sans-serif;font-weight:500;" },
      mono:    { familia: 'Montserrat', url_import: null, uso: 'datos, tags' }
    }
  },
  'raleway-outfit': {
    mood: 'aspiracional, wellness, femenino, clean, aireado',
    estilos: ['luxury_minimal', 'photo_lifestyle', 'coaching_premium'],
    tipografia: {
      display: { familia: 'Raleway', url_import: 'https://fonts.googleapis.com/css2?family=Raleway:wght@700;800;900&display=swap', pesos: [700,800,900], uso: 'headlines elegantes', css_headline: "font-family:'Raleway',sans-serif;font-weight:900;letter-spacing:0.04em;text-transform:uppercase;" },
      body:    { familia: 'Outfit', url_import: 'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500&display=swap', pesos: [300,400,500], uso: 'cuerpo liviano', css_body: "font-family:'Outfit',sans-serif;font-weight:400;letter-spacing:0.02em;" },
      mono:    { familia: 'Outfit', url_import: null, uso: 'handles, tags' }
    }
  }
};

function resolveFontPair(pairId) {
  if (FONT_PAIRS[pairId]) return FONT_PAIRS[pairId].tipografia;
  // fallback: bebas-inter
  return FONT_PAIRS['bebas-inter'].tipografia;
}

const FONT_PAIRS_INDEX = Object.entries(FONT_PAIRS)
  .map(([id, p]) => `  "${id}": ${p.mood}`)
  .join('\n');

// ─────────────────────────────────────────────────────────────────────
// FASE 1 — Detectar tema y tono del carrusel
// ─────────────────────────────────────────────────────────────────────
async function detectarTemaTono(slides, marca) {
  const resumen = slides.map(s => {
    const partes = [s.type, s.headline, s.body, s.quote, s.eyebrow, s.sub]
      .filter(Boolean).join(' | ');
    return partes;
  }).join('\n');

  const text = await callBlackbox(`Analizá este contenido de carrusel de Instagram de marca personal fitness/coaching y detectá su esencia.
${marcaContext(marca)}
CONTENIDO:
${resumen}

Devolvé SOLO JSON (sin markdown):
{
  "tema": "una palabra: entorno|disciplina|nutricion|entrenamiento|mentalidad|lifestyle|negocio|otro",
  "tono": "una palabra: motivacional|educativo|reflexivo|agresivo|aspiracional|intimo",
  "estilo_visual_ideal": "editorial_brutal|photo_lifestyle|infografico_premium|luxury_minimal|street_urban|tech_modern|editorial_magazine|coaching_premium",
  "razon": "por qué ese estilo para este contenido específico",
  "palabras_clave_visuales": ["3 a 5 palabras que describen la estética ideal de este carrusel"]
}`);

  try {
    return JSON.parse(sanitizeJson(text.replace(/```json|```/g, '').trim()));
  } catch {
    return { tema: 'fitness', tono: 'motivacional', estilo_visual_ideal: 'editorial_brutal', palabras_clave_visuales: ['bold', 'oscuro', 'premium'] };
  }
}

// ─────────────────────────────────────────────────────────────────────
// FASE 2 — Investigar y definir sistema de diseño completo
// ─────────────────────────────────────────────────────────────────────
async function definirSistemaDiseño(temaInfo, marca, referencias) {
  const { tema, tono, estilo_visual_ideal, palabras_clave_visuales } = temaInfo;

  console.log(`\n🔍 Definiendo sistema de diseño para estilo "${estilo_visual_ideal}" (${tema}/${tono})...`);
  if (referencias?.length) console.log(`  🖼  Usando ${referencias.length} carrusel(es) de referencia como inspiración`);

  const promptText = `Sos director de arte de una agencia top especializada en contenido viral de Instagram para marca personal fitness.
${marcaContext(marca)}
El carrusel que tenés que diseñar es:
- Tema: ${tema}
- Tono: ${tono}
- Estilo visual ideal: ${estilo_visual_ideal}
- Palabras clave visuales: ${palabras_clave_visuales?.join(', ')}

Definí el sistema de diseño COMPLETO y ESPECÍFICO. Sé milimétrico, no genérico.
${marca ? 'La paleta debe sentirse parte de la familia visual de la marca (ver paleta de referencia arriba), aunque puede variar según el tema/tono de este carrusel específico.' : ''}
${referencias?.length ? 'Te paso además imágenes de carruseles que le gustaron al cliente. Extraé de ahí el lenguaje visual (paleta, composición, iconografía, densidad) y aplicalo a este sistema — no los copies literal, usalos como dirección de arte.' : ''}

TIPOGRAFÍA — elegí EXACTAMENTE UNO de estos pares validados (devolvé solo el id):
${FONT_PAIRS_INDEX}

REGLA DE TIPOGRAFÍA PARA FITNESS/COACHING: Si el estilo_visual_ideal es editorial_brutal, street_urban, coaching_premium, o photo_lifestyle con tono agresivo/directo/motivacional, SIEMPRE elegí uno de estos: barlow-condensed-black, oswald-dm, anton-inter, bebas-inter, barlow-barlow. Nunca elijas space-space, syne-inter, dm-serif-dm, ni playfair-dm para contenido fitness activo — esos son para coaching premium femenino o lifestyle suave.

VARIEDAD VISUAL — el carrusel NO debe verse uniforme. Cada tipo de slide tiene un tratamiento distinto:
- Cover (portada): headline enorme, foto con overlay suave, impacto máximo
- Listas/pasos: fondo plano con color de acento, tipografía en dos pesos (display bold + body regular)
- Big number / stat: número gigante como elemento gráfico, foto secundaria o fondo minimal
- Split_v (antes/después): texto compacto que NO tape la figura, overlay mínimo
- Quote / cierre: peso tipográfico diferente (italic o light), mucho aire, composición centrada
Las reglas de estilo deben prescribir estas diferencias, no aplicar el mismo tratamiento en todo.

Para iconos, elegí caracteres Unicode específicos (no librerías externas).
Para colores, dá hex exactos.

Devolvé SOLO JSON (sin markdown):
{
  "font_pair_id": "id-del-par-elegido",
  "paleta": {
    "fondo": "#hex",
    "headline": "#hex",
    "body_text": "rgba o #hex con opacidad",
    "acento": "#hex — color de énfasis para líneas, kickers, divisores",
    "secundario": "#hex o rgba — textos terciarios, números, handles",
    "descripcion": "nombre del esquema de color y por qué funciona para este tono"
  },
  "iconos": {
    "flecha_derecha": "carácter Unicode o SVG path",
    "check": "carácter Unicode o SVG path",
    "numero_estilo": "circle|plain|bracket — cómo mostrar números en listas",
    "divisor_estilo": "line|dot|slash — separador entre elementos",
    "decorativo": "carácter o símbolo que refuerza el tema del carrusel"
  },
  "tratamiento_fotos": {
    "overlay_base": 0.0,
    "gradiente_default": "top_heavy|bottom_heavy|both|center_clear",
    "blend_mode": "normal|multiply|screen — si aplica sobre la foto",
    "saturacion_ajuste": "normal|reducir|aumentar",
    "descripcion": "cómo tratar las fotos para que el estilo sea coherente"
  },
  "layout": {
    "padding_slide": "valor en px",
    "espacio_entre_elementos": "valor en px",
    "alineacion_texto": "left|center|right",
    "posicion_tag": "top-left|top-right",
    "posicion_footer": "bottom-left|bottom-right|bottom-center",
    "headline_line_height": 0.0,
    "body_line_height": 0.0
  },
  "efectos": {
    "usar_glass": false,
    "usar_text_shadow": true,
    "text_shadow_default": "suave|medio|fuerte",
    "usar_borde_acento": false,
    "animacion_css": null
  },
  "reglas_estilo": [
    "regla 1 que define este sistema visual",
    "regla 2...",
    "regla 3..."
  ],
  "nombre_sistema": "nombre corto y descriptivo del sistema de diseño definido"
}`;

  const content = referencias?.length
    ? [...referencias.map(r => ({ type: 'image_url', image_url: { url: `data:${r.mime};base64,${r.base64}` } })), { type: 'text', text: promptText }]
    : promptText;

  // Prompt alternativo — más arriesgado/experimental para forzar variedad
  const promptVariante = promptText.replace(
    'Definí el sistema de diseño COMPLETO y ESPECÍFICO. Sé milimétrico, no genérico.',
    'Definí el sistema de diseño COMPLETO. Tomá el camino MÁS ARRIESGADO y visualmente DISRUPTIVO — paleta inesperada, contraste extremo, tipografía que nadie elegiría por defecto. El objetivo: que este carrusel se vea totalmente diferente al 95% del contenido de fitness en Instagram.'
  );
  const contentVariante = referencias?.length
    ? [...referencias.map(r => ({ type: 'image_url', image_url: { url: `data:${r.mime};base64,${r.base64}` } })), { type: 'text', text: promptVariante }]
    : promptVariante;

  // Generar 2 variantes en paralelo
  console.log(`  🎨 Generando 2 sistemas de diseño competitivos...`);
  const [textA, textB] = await Promise.all([
    callBlackbox(content).catch(() => null),
    callBlackbox(contentVariante).catch(() => null),
  ]);

  if (!textA && !textB) return getDefaultDesignSystem(estilo_visual_ideal);
  if (!textA) {
    const parsed = (() => { try { return JSON.parse(sanitizeJson(textB.replace(/```json|```/g, '').trim())); } catch { return null; } })();
    if (parsed) { parsed.tipografia = resolveFontPair(parsed.font_pair_id); return parsed; }
    return getDefaultDesignSystem(estilo_visual_ideal);
  }
  if (!textB) {
    const parsed = (() => { try { return JSON.parse(sanitizeJson(textA.replace(/```json|```/g, '').trim())); } catch { return null; } })();
    if (parsed) { parsed.tipografia = resolveFontPair(parsed.font_pair_id); return parsed; }
    return getDefaultDesignSystem(estilo_visual_ideal);
  }

  // Parsear ambas variantes
  let sistemaA = null, sistemaB = null;
  try { sistemaA = JSON.parse(sanitizeJson(textA.replace(/```json|```/g, '').trim())); } catch {}
  try { sistemaB = JSON.parse(sanitizeJson(textB.replace(/```json|```/g, '').trim())); } catch {}

  if (!sistemaA && !sistemaB) return getDefaultDesignSystem(estilo_visual_ideal);
  if (!sistemaA) { sistemaB.tipografia = resolveFontPair(sistemaB.font_pair_id); return sistemaB; }
  if (!sistemaB) { sistemaA.tipografia = resolveFontPair(sistemaA.font_pair_id); return sistemaA; }

  // Judge: pedir a la IA que elija la variante más fuerte
  const judgePrompt = `Sos director creativo senior. Elegís cuál de estos dos sistemas de diseño va a tener MÁS IMPACTO en Instagram para este carrusel.

TEMA: ${tema} | TONO: ${tono} | ESTILO IDEAL: ${estilo_visual_ideal}

VARIANTE A:
- Nombre: ${sistemaA.nombre_sistema}
- Paleta: fondo ${sistemaA.paleta?.fondo}, headline ${sistemaA.paleta?.headline}, acento ${sistemaA.paleta?.acento}
- Font pair: ${sistemaA.font_pair_id}
- Reglas: ${sistemaA.reglas_estilo?.slice(0,2).join(' | ')}

VARIANTE B:
- Nombre: ${sistemaB.nombre_sistema}
- Paleta: fondo ${sistemaB.paleta?.fondo}, headline ${sistemaB.paleta?.headline}, acento ${sistemaB.paleta?.acento}
- Font pair: ${sistemaB.font_pair_id}
- Reglas: ${sistemaB.reglas_estilo?.slice(0,2).join(' | ')}

Respondé SOLO con la letra ganadora y una línea de razón, así:
A: razón
o
B: razón`;

  let ganadora = 'A';
  try {
    const judgeText = await callBlackbox(judgePrompt);
    if (judgeText?.trim().startsWith('B')) ganadora = 'B';
  } catch { /* default A */ }

  const winner = ganadora === 'B' ? sistemaB : sistemaA;
  console.log(`  🏆 Sistema elegido: ${ganadora} — ${winner.nombre_sistema}`);
  // Fuente forzada por el usuario desde las preferencias de marca
  if (USER_FONT_PAIR && FONT_PAIRS[USER_FONT_PAIR]) {
    winner.font_pair_id = USER_FONT_PAIR;
    console.log(`  🔒 Fuente forzada por preferencia de marca: ${USER_FONT_PAIR}`);
  }
  winner.tipografia = resolveFontPair(winner.font_pair_id);
  console.log(`  🎨 Paleta: fondo ${winner.paleta?.fondo} | acento ${winner.paleta?.acento}`);
  if (winner.reglas_estilo?.length) {
    console.log(`  📐 Reglas:`);
    winner.reglas_estilo.forEach(r => console.log(`     • ${r}`));
  }
  console.log(`  🔤 Par: ${winner.font_pair_id} (${winner.tipografia.display.familia} + ${winner.tipografia.body.familia})`);
  const loser = ganadora === 'B' ? sistemaA : sistemaB;
  if (loser && !loser.tipografia) loser.tipografia = resolveFontPair(loser.font_pair_id);
  winner._varianteA = sistemaA;
  winner._varianteB = sistemaB;
  return winner;
}

function getDefaultDesignSystem(estilo) {
  const sistemas = {
    editorial_brutal: {
      nombre_sistema: 'Editorial Brutal',
      tipografia: resolveFontPair('bebas-inter'),
      paleta: {
        fondo: '#0a0a0a',
        headline: '#ffffff',
        body_text: 'rgba(255,255,255,0.82)',
        acento: '#e8ff00',
        secundario: 'rgba(255,255,255,0.28)',
        descripcion: 'Negro absoluto con acento amarillo neón — máximo contraste, energía, brutalismo editorial'
      },
      iconos: {
        flecha_derecha: '→',
        check: '✓',
        numero_estilo: 'plain',
        divisor_estilo: 'line',
        decorativo: '▪'
      },
      tratamiento_fotos: {
        overlay_base: 0.65,
        gradiente_default: 'top_heavy',
        blend_mode: 'normal',
        saturacion_ajuste: 'normal',
        descripcion: 'Overlay oscuro denso, gradiente top-heavy, foto como textura de fondo poderosa'
      },
      layout: {
        padding_slide: '108',
        espacio_entre_elementos: '75',
        alineacion_texto: 'left',
        posicion_tag: 'top-left',
        posicion_footer: 'bottom-left',
        headline_line_height: 0.88,
        body_line_height: 1.75
      },
      efectos: {
        usar_glass: false,
        usar_text_shadow: true,
        text_shadow_default: 'medio',
        usar_borde_acento: true,
        animacion_css: null
      },
      reglas_estilo: [
        'Sin glass morphism, nunca',
        'Headline siempre uppercase con Bebas Neue, sin excepciones',
        'Acento amarillo solo en elementos de énfasis: kicker line, divisor, número activo',
        'Máximo 2 niveles de gris en el mismo slide',
        'Fotos siempre oscurecidas, nunca compiten con el texto'
      ]
    },
    photo_lifestyle: {
      nombre_sistema: 'Photo Lifestyle',
      tipografia: resolveFontPair('playfair-dm'),
      paleta: {
        fondo: '#0d0d0d',
        headline: '#f5f0e8',
        body_text: 'rgba(245,240,232,0.72)',
        acento: '#c8a96e',
        secundario: 'rgba(245,240,232,0.32)',
        descripcion: 'Negro cálido con crema y dorado — lifestyle premium, editorial de revista'
      },
      iconos: {
        flecha_derecha: '›',
        check: '·',
        numero_estilo: 'plain',
        divisor_estilo: 'dot',
        decorativo: '—'
      },
      tratamiento_fotos: {
        overlay_base: 0.45,
        gradiente_default: 'both',
        blend_mode: 'normal',
        saturacion_ajuste: 'reducir',
        descripcion: 'Overlay suave, foto respira y comunica, texto mínimo sobre zonas limpias'
      },
      layout: {
        padding_slide: '96',
        espacio_entre_elementos: '64',
        alineacion_texto: 'left',
        posicion_tag: 'top-left',
        posicion_footer: 'bottom-left',
        headline_line_height: 1.05,
        body_line_height: 1.85
      },
      efectos: {
        usar_glass: false,
        usar_text_shadow: true,
        text_shadow_default: 'suave',
        usar_borde_acento: false,
        animacion_css: null
      },
      reglas_estilo: [
        'La foto es la protagonista, el texto la acompaña',
        'Serif elegante para headlines, sans liviana para body',
        'Acento dorado solo en elementos de jerarquía',
        'Nunca uppercase en headlines de este estilo',
        'Mucho espacio en blanco, nada saturado'
      ]
    },
    infografico_premium: {
      nombre_sistema: 'Infográfico Premium',
      tipografia: resolveFontPair('space-space'),
      paleta: {
        fondo: '#0f0f12',
        headline: '#ffffff',
        body_text: 'rgba(255,255,255,0.78)',
        acento: '#6c63ff',
        secundario: 'rgba(255,255,255,0.32)',
        descripcion: 'Negro azulado con acento púrpura — tech premium, datos limpios, confianza'
      },
      iconos: {
        flecha_derecha: '→',
        check: '✦',
        numero_estilo: 'circle',
        divisor_estilo: 'slash',
        decorativo: '◆'
      },
      tratamiento_fotos: {
        overlay_base: 0.72,
        gradiente_default: 'full',
        blend_mode: 'normal',
        saturacion_ajuste: 'reducir',
        descripcion: 'Overlay denso, fotos casi como texturas, datos y gráficos son los protagonistas'
      },
      layout: {
        padding_slide: '96',
        espacio_entre_elementos: '56',
        alineacion_texto: 'left',
        posicion_tag: 'top-right',
        posicion_footer: 'bottom-left',
        headline_line_height: 0.95,
        body_line_height: 1.65
      },
      efectos: {
        usar_glass: true,
        usar_text_shadow: false,
        text_shadow_default: 'suave',
        usar_borde_acento: true,
        animacion_css: null
      },
      reglas_estilo: [
        'Datos y números son los héroes visuales',
        'Mono para cualquier número o dato específico',
        'Glass solo en elementos de datos, nunca en texto corrido',
        'Acento para highlighting de información clave',
        'Estructura visible: el layout mismo comunica jerarquía'
      ]
    },
    luxury_minimal: {
      nombre_sistema: 'Luxury Minimal',
      tipografia: resolveFontPair('instrument-dm'),
      paleta: {
        fondo: '#f5f2ec',
        headline: '#0f0f0f',
        body_text: 'rgba(15,15,15,0.65)',
        acento: '#0f0f0f',
        secundario: 'rgba(15,15,15,0.28)',
        descripcion: 'Crema cálido con negro absoluto — luxury coaching, minimalismo de alta gama'
      },
      iconos: { flecha_derecha: '→', check: '·', numero_estilo: 'plain', divisor_estilo: 'dot', decorativo: '—' },
      tratamiento_fotos: {
        overlay_base: 0.20,
        gradiente_default: 'bottom_heavy',
        blend_mode: 'normal',
        saturacion_ajuste: 'reducir',
        descripcion: 'Overlay mínimo, foto limpia, texto sobre zonas claras'
      },
      layout: { padding_slide: '96', espacio_entre_elementos: '72', alineacion_texto: 'left', posicion_tag: 'top-left', posicion_footer: 'bottom-left', headline_line_height: 1.0, body_line_height: 1.9 },
      efectos: { usar_glass: false, usar_text_shadow: false, text_shadow_default: 'suave', usar_borde_acento: false, animacion_css: null },
      reglas_estilo: ['Serif elegante, nunca uppercase', 'Mucho espacio en blanco — la respiración es el diseño', 'Sin acento de color, todo en negro/crema', 'Foto respira, texto flota sobre zonas claras', 'Un solo nivel de jerarquía por slide']
    },
    street_urban: {
      nombre_sistema: 'Street Urban',
      tipografia: resolveFontPair('anton-inter'),
      paleta: {
        fondo: '#0d0d0d',
        headline: '#ffffff',
        body_text: 'rgba(255,255,255,0.80)',
        acento: '#ff4d00',
        secundario: 'rgba(255,255,255,0.30)',
        descripcion: 'Negro con rojo fuego — energía cruda, urbano, sin filtros'
      },
      iconos: { flecha_derecha: '→', check: '✗', numero_estilo: 'plain', divisor_estilo: 'slash', decorativo: '▶' },
      tratamiento_fotos: {
        overlay_base: 0.60,
        gradiente_default: 'top_heavy',
        blend_mode: 'normal',
        saturacion_ajuste: 'aumentar',
        descripcion: 'Alto contraste, saturación elevada, texto pesado que golpea'
      },
      layout: { padding_slide: '100', espacio_entre_elementos: '60', alineacion_texto: 'left', posicion_tag: 'top-left', posicion_footer: 'bottom-left', headline_line_height: 0.90, body_line_height: 1.60 },
      efectos: { usar_glass: false, usar_text_shadow: true, text_shadow_default: 'fuerte', usar_borde_acento: false, animacion_css: null },
      reglas_estilo: ['Anton uppercase siempre para headline', 'Acento rojo solo en 1-2 palabras o elementos', 'Sin elegancia, todo es crudo y directo', 'Fotos saturadas con overlay duro', 'Números en acento cuando hay datos']
    },
    tech_modern: {
      nombre_sistema: 'Tech Modern',
      tipografia: resolveFontPair('space-space'),
      paleta: {
        fondo: '#080810',
        headline: '#ffffff',
        body_text: 'rgba(255,255,255,0.72)',
        acento: '#00e5ff',
        secundario: 'rgba(0,229,255,0.30)',
        descripcion: 'Negro profundo con cyan eléctrico — data-driven, tech, performance'
      },
      iconos: { flecha_derecha: '›', check: '✦', numero_estilo: 'circle', divisor_estilo: 'slash', decorativo: '◈' },
      tratamiento_fotos: {
        overlay_base: 0.75,
        gradiente_default: 'full',
        blend_mode: 'normal',
        saturacion_ajuste: 'reducir',
        descripcion: 'Overlay muy denso, fotos como texturas, datos protagonizan'
      },
      layout: { padding_slide: '88', espacio_entre_elementos: '52', alineacion_texto: 'left', posicion_tag: 'top-right', posicion_footer: 'bottom-left', headline_line_height: 0.92, body_line_height: 1.65 },
      efectos: { usar_glass: true, usar_text_shadow: false, text_shadow_default: 'suave', usar_borde_acento: true, animacion_css: null },
      reglas_estilo: ['Space Mono para todos los datos y porcentajes', 'Acento cyan solo en números y highlights', 'Glass en cards de datos', 'Overlay máximo — las fotos son textura', 'Estructura de grilla visible en layouts de datos']
    },
    editorial_magazine: {
      nombre_sistema: 'Editorial Magazine',
      tipografia: resolveFontPair('dm-serif-dm'),
      paleta: {
        fondo: '#0e0c0a',
        headline: '#f0ebe2',
        body_text: 'rgba(240,235,226,0.70)',
        acento: '#c8a96e',
        secundario: 'rgba(240,235,226,0.30)',
        descripcion: 'Negro cálido con crema y oro editorial — revista de calidad, aspiracional'
      },
      iconos: { flecha_derecha: '›', check: '—', numero_estilo: 'plain', divisor_estilo: 'dot', decorativo: '·' },
      tratamiento_fotos: {
        overlay_base: 0.40,
        gradiente_default: 'both',
        blend_mode: 'normal',
        saturacion_ajuste: 'reducir',
        descripcion: 'Overlay suave cálido, foto como contexto emocional, texto serif flotando'
      },
      layout: { padding_slide: '96', espacio_entre_elementos: '68', alineacion_texto: 'left', posicion_tag: 'top-left', posicion_footer: 'bottom-left', headline_line_height: 1.05, body_line_height: 1.85 },
      efectos: { usar_glass: false, usar_text_shadow: true, text_shadow_default: 'suave', usar_borde_acento: false, animacion_css: null },
      reglas_estilo: ['Serif para headlines, NUNCA uppercase', 'Oro solo en kickers y divisores, no en texto corrido', 'Mucho aire, nunca saturado de texto', 'Fotos desaturadas con tonos cálidos', 'Una sola línea larga en cover, no partida']
    },
    coaching_premium: {
      nombre_sistema: 'Coaching Premium',
      tipografia: resolveFontPair('archivo-inter'),
      paleta: {
        fondo: '#111114',
        headline: '#ffffff',
        body_text: 'rgba(255,255,255,0.78)',
        acento: '#e8ff00',
        secundario: 'rgba(255,255,255,0.25)',
        descripcion: 'Negro neutro con lima — balance entre brutalismo editorial y autoridad de marca'
      },
      iconos: { flecha_derecha: '→', check: '✓', numero_estilo: 'bracket', divisor_estilo: 'line', decorativo: '▸' },
      tratamiento_fotos: {
        overlay_base: 0.55,
        gradiente_default: 'top_heavy',
        blend_mode: 'normal',
        saturacion_ajuste: 'normal',
        descripcion: 'Overlay equilibrado, foto refuerza el mensaje, texto visible y jerarquizado'
      },
      layout: { padding_slide: '100', espacio_entre_elementos: '64', alineacion_texto: 'left', posicion_tag: 'top-left', posicion_footer: 'bottom-left', headline_line_height: 0.92, body_line_height: 1.72 },
      efectos: { usar_glass: false, usar_text_shadow: true, text_shadow_default: 'medio', usar_borde_acento: true, animacion_css: null },
      reglas_estilo: ['Archivo Black para headlines — bold sin brutalismo', 'Lima solo en kickers y números, no en texto corrido', 'Fotos refuerzan la historia, no decoran', 'Listas con bracket [ ] para ítems clave', 'CTA siempre directo, nunca sugerido']
    }
  };
  return sistemas[estilo] || sistemas.editorial_brutal;
}

// ─────────────────────────────────────────────────────────────────────
// FASE 3 — Analizar cada slide con foto + sistema de diseño definido
// ─────────────────────────────────────────────────────────────────────
async function analizarSlideConIA(slide, base64, mime, sistema, temaInfo) {
  const contenido = JSON.stringify({
    type: slide.type,
    headline: slide.headline,
    detail: slide.detail,
    kicker: slide.kicker,
    body: slide.body,
    quote: slide.quote,
    attr: slide.attr,
    sub: slide.sub,
  }, null, 2);

  const prompt = `Sos director de arte aplicando el sistema de diseño "${sistema.nombre_sistema}".

SISTEMA DE DISEÑO DEFINIDO:
- Fuente display: ${sistema.tipografia?.display?.familia}
- Fuente body: ${sistema.tipografia?.body?.familia}
- Fondo: ${sistema.paleta?.fondo} | Headline: ${sistema.paleta?.headline} | Acento: ${sistema.paleta?.acento}
- Overlay base: ${sistema.tratamiento_fotos?.overlay_base}
- Gradiente default: ${sistema.tratamiento_fotos?.gradiente_default}
- Glass: ${sistema.efectos?.usar_glass ? 'SÍ' : 'NO'}
- Shadow default: ${sistema.efectos?.text_shadow_default}
- Reglas: ${sistema.reglas_estilo?.join(' | ')}

CONTENIDO DE LA SLIDE:
${contenido}

Analizá la imagen con precisión y devolvé SOLO JSON (sin markdown) con ajustes ESPECÍFICOS para esta foto dentro del sistema:

REGLA CRÍTICA para text_y_percent: es el % vertical donde va el TOPE del bloque de texto (0=tope del slide, 100=base). Tu trabajo es encontrar la zona de la foto que tiene MÁS ESPACIO VACÍO — cielo, pared, suelo, fondo neutro — y poner el texto AHÍ.
Proceso: 1) Identificá dónde está la cara/cuerpo principal. 2) Identificá la zona más despejada y oscura/contrastante. 3) Si esa zona está arriba (sujeto en mitad/abajo del frame) → elegí entre 8 y 18. Si está abajo (sujeto en mitad/arriba del frame) → elegí entre 72 y 85. Si hay espacio en ambos extremos y el sujeto está al centro → elegí 8-15 (arriba). NUNCA pongas text_y_percent en el rango 30-65 a menos que la foto sea de un objeto sin persona.

{
  "zonas": {
    "descripcion": "composición exacta: sujeto, zonas claras/oscuras, puntos de interés",
    "top_luminancia": "oscuro|claro|mixto",
    "middle_luminancia": "oscuro|claro|mixto",
    "bottom_luminancia": "oscuro|claro|mixto"
  },
  "sujeto": {
    "posicion": "izquierda|derecha|centro|sin_sujeto",
    "ocupa_zona": "top|middle|bottom|full",
    "evitar_zona": "top|middle|bottom|ninguna"
  },
  "ajustes_foto": {
    "overlay_ajustado": 0.0,
    "gradiente_ajustado": "top_heavy|bottom_heavy|both|center_clear|full",
    "photo_anchor_x": "left|center|right — dónde anclar la foto horizontalmente para que el sujeto quede centrado o en la mejor posición",
    "photo_anchor_y": "top|center|bottom — dónde anclar verticalmente",
    "razon": "por qué este ajuste específico para esta foto"
  },
  "ajustes_texto": {
    "posicion": "top|middle|bottom",
    "text_y_percent": 15,
    "text_shadow": "suave|medio|fuerte",
    "glass_necesario": false,
    "glass_opacidad": 0.0,
    "headline_size": "normal|reducir_10|reducir_20|aumentar_10",
    "razon": "decisión milimétrica basada en la composición real — incluí dónde está el sujeto y por qué ese text_y_percent lo evita"
  },
  "recomendacion": "una línea específica para hacer esta slide irresistible",
  "foto_sugerida": "descripción de 1 línea de qué foto encajaría mejor: tipo de toma, sujeto, ambiente",
  "layout_sugerido": "null o uno de: cover-top|cover-center|cover-split|cover-impact|list-full|list-compact|list-hero|statement-anchored|statement-top|statement-impact|split-full|quote-dominant|quote-centered|cta-top|cta-center|cta-impact — solo si la lógica default no es la mejor opción para esta foto específica"
}`;

  const text = await callBlackbox([
    { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
    { type: 'text', text: prompt }
  ]);

  try {
    return JSON.parse(sanitizeJson(text.replace(/```json|```/g, '').trim()));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// FASE 3B — Análisis de composición para modelos multi-foto
// (split_v, triple_v): cada foto se analiza individualmente para decidir
// en qué esquina va el bloque de texto sin tapar al sujeto.
// ─────────────────────────────────────────────────────────────────────
async function analizarComposicionFoto(base64, mime) {
  const prompt = `Vas a superponer un bloque de texto (label corto + headline grande, en una esquina) sobre esta foto de un carrusel de fitness/coaching.

Analizá la composición y elegí la esquina donde el texto NO tape a la persona, su cara, ni el elemento principal de la imagen.

Devolvé SOLO JSON (sin markdown):
{
  "zona_texto_h": "left|right",
  "zona_texto_v": "top|bottom",
  "razon": "una línea: qué hay en cada zona de la foto y por qué esa esquina es la mejor para el texto"
}`;

  const text = await callBlackbox([
    { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
    { type: 'text', text: prompt }
  ]);

  try {
    return JSON.parse(sanitizeJson(text.replace(/```json|```/g, '').trim()));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// FASE 4 — Elegir layout óptimo por slide
// Resuelve: espacio muerto, texto mal anclado, columnas flotando
// ─────────────────────────────────────────────────────────────────────
function elegirLayout(slide, analisis, sistema) {
  const tipo  = slide.type;
  const foto  = !!slide.photo;
  const items = slide.items?.length || 0;
  const tono  = (sistema.nombre_sistema || '').toLowerCase();

  // La IA puede haber sugerido un layout en el análisis — respetarlo si existe
  if (analisis?.layout_sugerido) return analisis.layout_sugerido;

  switch (tipo) {
    case 'cover':
      if (foto) return 'cover-top';
      if (slide.detail && slide.detail.length > 60) return 'cover-split';
      return 'cover-center';

    case 'list':
      // 5+ items → full distribuye en todo el alto, elimina negro muerto
      if (items >= 5) return 'list-full';
      if (tono.includes('infogr') || tono.includes('premium')) return 'list-hero';
      return 'list-compact';

    case 'statement': {
      const words = (slide.headline || '').split(/\s+/).length;
      if (foto) return 'statement-top';
      if (words <= 5 && slide.body && slide.body.length > 80) return 'statement-impact';
      return 'statement-anchored';
    }

    case 'split': {
      // Columnas cortas (≤2 items cada una) → compact, centrado, sin
      // estirar contenido para llenar el alto. 3+ items → full.
      const itemsLeft  = slide.left?.items?.length || 0;
      const itemsRight = slide.right?.items?.length || 0;
      if (itemsLeft <= 2 && itemsRight <= 2) return 'split-compact';
      return 'split-full';
    }

    case 'quote':
      // Con foto → dominant (quote XL arriba, attr+note anclados con línea acento abajo)
      return foto ? 'quote-dominant' : 'quote-centered';

    case 'cta': {
      if (foto) return 'cta-top';
      const ctaWords = (slide.headline || '').split(/\s+/).length;
      if (ctaWords <= 3) return 'cta-impact';
      // Sin foto, sin sub → headline + handle nomás: centrar todo el bloque
      // en vez de pinearlo arriba con espacio vacío hasta el footer.
      if (!slide.sub) return 'cta-center';
      return 'cta-top';
    }

    default:
      return tipo;
  }
}

function aplicarDecisiones(slide, analisis, sistema) {
  const s = { ...slide };

  // Layout elegido por lógica + posible sugerencia de la IA
  s._layout = elegirLayout(slide, analisis, sistema);

  // Del sistema de diseño global
  s._sistema = {
    nombre: sistema.nombre_sistema,
    font_display_familia: sistema.tipografia?.display?.familia,
    font_display_url: sistema.tipografia?.display?.url_import,
    font_display_css: sistema.tipografia?.display?.css_headline,
    font_body_familia: sistema.tipografia?.body?.familia,
    font_body_url: sistema.tipografia?.body?.url_import,
    font_body_css: sistema.tipografia?.body?.css_body,
    font_mono_familia: sistema.tipografia?.mono?.familia,
    font_mono_url: sistema.tipografia?.mono?.url_import,
    paleta: sistema.paleta,
    iconos: sistema.iconos,
    layout: sistema.layout,
    efectos: sistema.efectos,
  };

  // Del análisis específico de la foto
  if (analisis) {
    // El overlay plano se suma al degradé direccional (--grad) en el render
    s._overlay        = Math.min(analisis.ajustes_foto?.overlay_ajustado ?? sistema.tratamiento_fotos?.overlay_base ?? 0.50, 0.55);
    s._gradiente      = analisis.ajustes_foto?.gradiente_ajustado ?? sistema.tratamiento_fotos?.gradiente_default ?? 'top_heavy';
    const anchorX = analisis.ajustes_foto?.photo_anchor_x ?? 'center';
    const anchorY = analisis.ajustes_foto?.photo_anchor_y ?? 'center';
    s._photoPos       = `${anchorX} ${anchorY}`;
    s._textPosition   = analisis.ajustes_texto?.posicion ?? 'top';
    s._textShadow     = analisis.ajustes_texto?.text_shadow ?? sistema.efectos?.text_shadow_default ?? 'medio';
    s._glass          = analisis.ajustes_texto?.glass_necesario ?? sistema.efectos?.usar_glass ?? false;
    s._glassOpacidad  = analisis.ajustes_texto?.glass_opacidad ?? 0.78;
    s._headlineAjuste = analisis.ajustes_texto?.headline_size ?? 'normal';
    s._analisis = {
      zonas:         analisis.zonas,
      sujeto:        analisis.sujeto,
      recomendacion: analisis.recomendacion,
    };
    s._fotoSugerida = analisis.foto_sugerida || null;

    // Posición Y precisa del texto para evitar tapar al sujeto
    const rawTextY = analisis.ajustes_texto?.text_y_percent;
    const ocupaZona = analisis.sujeto?.ocupa_zona;
    if (rawTextY != null && !isNaN(Number(rawTextY))) {
      s._textY = Math.round(Math.max(5, Math.min(88, Number(rawTextY))));
    } else if (analisis.sujeto?.posicion !== 'sin_sujeto') {
      // Fallback heurístico: si la IA no dio porcentaje, deducirlo de la zona del sujeto
      if (ocupaZona === 'top')                                      s._textY = 78;
      else if (['middle', 'bottom', 'full'].includes(ocupaZona))   s._textY = 15;
    }
    // Sanity check: el AI a veces contradice su análisis de sujeto al dar text_y_percent.
    // Si el texto va en la misma zona que el sujeto, lo movemos al lado opuesto.
    if (s._textY != null) {
      if (s._textY < 42 && (ocupaZona === 'top' || ocupaZona === 'full')) {
        s._textY = 74; // sujeto arriba → texto al tercio inferior
      } else if (s._textY > 58 && ocupaZona === 'bottom') {
        s._textY = 10; // sujeto abajo → texto al tercio superior
      }
    }

    // Guardia de contraste: si la zona donde se ancla el texto quedó
    // "clara"/"mixta" y el overlay decidido es muy liviano, reforzar
    // overlay y sombra para que el texto siga siendo legible.
    const zonaLum = {
      top:    analisis.zonas?.top_luminancia,
      middle: analisis.zonas?.middle_luminancia,
      bottom: analisis.zonas?.bottom_luminancia,
    }[s._textPosition];
    if ((zonaLum === 'claro' || zonaLum === 'mixto') && s._overlay < 0.55) {
      s._overlay = Math.max(s._overlay, 0.6);
      if (s._textShadow === 'suave') s._textShadow = 'medio';
    }

    // Corrección de mismatch gradiente↔textPosition: las bandas casi
    // transparentes de top_heavy/bottom_heavy no deben coincidir con
    // la zona donde se ancla el texto.
    const gradTransparenteEn = { top_heavy: 'bottom', bottom_heavy: 'top' };
    if (gradTransparenteEn[s._gradiente] === s._textPosition || s._textPosition === 'middle') {
      if (s._gradiente === 'top_heavy' || s._gradiente === 'bottom_heavy') {
        s._gradiente = 'both';
      }
    }
  } else {
    // Sin foto — aplicar solo sistema
    s._overlay        = sistema.tratamiento_fotos?.overlay_base ?? 0.65;
    s._gradiente      = sistema.tratamiento_fotos?.gradiente_default ?? 'both';
    s._textPosition   = 'middle';
    s._textShadow     = sistema.efectos?.text_shadow_default ?? 'medio';
    s._glass          = sistema.efectos?.usar_glass ?? false;
    s._glassOpacidad  = 0.78;
    s._headlineAjuste = 'normal';
  }

  return s;
}

// ─────────────────────────────────────────────────────────────────────
// MODELO SELECTOR
// Detecta qué modelo visual usar para el carrusel completo según
// el tema, tono y estructura del contenido.
// Modelos: classic | split_v | full_impact | before_after | triple_v
// ─────────────────────────────────────────────────────────────────────
function elegirModeloCarrusel(slides, temaInfo) {
  const { tono } = temaInfo;
  const tiposNuevos = ['split_v', 'full_impact', 'before_after', 'triple_v'];

  // Si el usuario ya definió tipos nuevos manualmente → respetar
  if (slides.some(s => tiposNuevos.includes(s.type))) return 'mixed';

  const textos = slides
    .map(s => [s.headline, s.body, s.quote, s.eyebrow, s.sub, s.detail, s.kicker]
      .filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();

  // Antes/después: transformación, progreso, comparación temporal
  if (/antes|despu[eé]s|transform|result|progres|cambio/.test(textos) && slides.some(s => s.photo))
    return 'before_after';

  // Triple vertical: 3 estadísticas, porcentajes, etapas numeradas
  // (requiere una foto por fila — adaptarSlidesAModelo no las genera;
  // sin esto un carrusel 100% tipográfico puede convertirse a triple_v
  // y quedar con tv-bg sin imagen)
  if (/0%|100%|etapa|fase|paso [123]|nivel [123]/.test(textos) && slides.some(s => s.photo))
    return 'triple_v';

  // Full impact: tono agresivo + foto disponible
  if (['agresivo', 'motivacional'].includes(tono) && slides.some(s => s.photo))
    return 'full_impact';

  // Split vertical: comparación estadística, "el promedio vs la realidad"
  // (requiere foto para cada mitad — adaptarSlidesAModelo no las genera;
  // sin esto un carrusel 100% tipográfico puede convertirse a split_v
  // y quedar con las dos mitades sin imagen ni scrim)
  if (/promedio|media|normal|vs\.|versus|no [0-9]|sino|pero|en cambio/.test(textos) && slides.some(s => s.photo))
    return 'split_v';

  // Default: modelo clásico
  return 'classic';
}

// Adapta slides clásicas al modelo visual elegido cuando tiene sentido.
// Solo convierte la slide más apta para el modelo elegido (igual que
// full_impact con 'cover') — el resto sigue con su layout clásico.
// Las fotos (photo_top/bottom/before/after/rows[].photo) quedan sin asignar
// a propósito: se completan después a mano.
function adaptarSlidesAModelo(slides, modelo) {
  if (modelo === 'classic' || modelo === 'mixed') return slides;

  const tiposNuevos = ['split_v', 'full_impact', 'before_after', 'triple_v'];
  let convertida = false;

  return slides.map(slide => {
    if (tiposNuevos.includes(slide.type)) return slide;
    if (convertida) return slide;

    if (modelo === 'full_impact' && slide.type === 'cover') {
      convertida = true;
      return {
        ...slide,
        type:        'full_impact',
        line1:       slide.detail || '',
        line2:       slide.headline,
        footer_text: slide.kicker || '',
      };
    }

    if (modelo === 'split_v' && slide.type === 'split') {
      convertida = true;
      return {
        ...slide,
        type:            'split_v',
        label_top:       slide.left?.label || '',
        contrast_top:    (slide.left?.items || [])[0] || '',
        label_bottom:    slide.right?.label || '',
        contrast_bottom: (slide.right?.items || [])[0] || '',
      };
    }

    if (modelo === 'before_after' && (slide.type === 'split' || slide.type === 'statement')) {
      convertida = true;
      return {
        ...slide,
        type:         'before_after',
        label_before: 'ANTES',
        label_after:  'DESPUÉS',
        headline:     slide.headline || slide.left?.label || '',
        sub:          slide.body || (slide.right?.items || []).join(' · '),
      };
    }

    if (modelo === 'triple_v' && slide.type === 'list') {
      convertida = true;
      return {
        ...slide,
        type: 'triple_v',
        rows: (slide.items || []).slice(0, 3).map((item, idx) => ({
          num:  `0${idx + 1}`,
          text: item,
        })),
      };
    }

    return slide;
  });
}

// ─────────────────────────────────────────────────────────────────────
// MERGE INCREMENTAL
// Si ya existe un contenido.analizado.json previo, rescata las
// asignaciones manuales de fotos en slides multi-foto (split_v, triple_v,
// before_after) y slides clásicas con foto simple, que adaptarSlidesAModelo
// deja vacías a propósito para completar "a mano". Sin esto, cada
// re-análisis pisa esas asignaciones y rompe el output multi-foto.
// Solo se rescata si la slide nueva, en la misma posición, es del mismo
// tipo y no trae ya un valor propio para ese campo.
// ─────────────────────────────────────────────────────────────────────
function mergeAsignacionesManuales(slidesFinales, anterior) {
  if (!anterior?.slides) return slidesFinales;

  return slidesFinales.map((slide, i) => {
    const prev = anterior.slides[i];
    if (!prev || prev.type !== slide.type) return slide;

    if (slide.type === 'split_v') {
      const merged = { ...slide };
      for (const [photoKey, posKey] of [['photo_top', '_topPos'], ['photo_bottom', '_bottomPos']]) {
        if (!merged[photoKey] && prev[photoKey]) {
          merged[photoKey] = prev[photoKey];
          if (prev[posKey] && !merged[posKey]) merged[posKey] = prev[posKey];
        }
      }
      return merged;
    }

    if (slide.type === 'triple_v' && Array.isArray(slide.rows)) {
      const rows = slide.rows.map((row, j) => {
        const prevRow = prev.rows?.[j];
        if (!row.photo && prevRow?.photo) {
          return { ...row, photo: prevRow.photo, _pos: row._pos ?? prevRow._pos };
        }
        return row;
      });
      return { ...slide, rows };
    }

    if (slide.type === 'before_after') {
      const merged = { ...slide };
      for (const photoKey of ['photo_before', 'photo_after']) {
        if (!merged[photoKey] && prev[photoKey]) merged[photoKey] = prev[photoKey];
      }
      return merged;
    }

    // slides clásicas con foto simple (cover, statement, quote, etc.)
    if (!slide.photo && prev.photo) {
      return { ...slide, photo: prev.photo };
    }

    return slide;
  });
}

// ─────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────
async function main() {
  const contentFile = process.argv[2] || 'contenido.json';
  const inputPath   = path.join(__dirname, contentFile);
  const raw         = JSON.parse(await readFile(inputPath, 'utf-8'));

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  CARRUSEL DESIGNER — IA v3');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  if (PREVIEW) console.log(`👁  Preview en vivo activado → http://localhost:${PREVIEW_PORT}/preview\n`);

  broadcast('reset', {});

  const marcaId = raw._marca || 'squadteam';
  const marca = await loadMarca(marcaId);
  if (marca) console.log(`🏷  Marca: ${marca.nombre} — coherencia de voz/paleta activada`);

  // FASE 1: detectar tema y tono
  process.stdout.write('📖 Leyendo contenido...');
  broadcast('status', { message: '📖 Leyendo contenido...' });
  const temaInfo = await detectarTemaTono(raw.slides, marca);
  console.log(` ✓ Tema: ${temaInfo.tema} | Tono: ${temaInfo.tono} | Estilo: ${temaInfo.estilo_visual_ideal}`);
  console.log(`   Visual: ${temaInfo.palabras_clave_visuales?.join(', ')}`);
  console.log(`   ${temaInfo.razon}`);
  broadcast('status', { message: `✓ Tema: ${temaInfo.tema} | Tono: ${temaInfo.tono} | Estilo: ${temaInfo.estilo_visual_ideal}` });

  // FASE 2: definir sistema de diseño completo
  const referencias = await loadReferencias(marcaId);
  const sistema = await definirSistemaDiseño(temaInfo, marca, referencias);
  const sistemaA = sistema._varianteA || sistema;
  const sistemaB = sistema._varianteB || sistema;
  delete sistema._varianteA;
  delete sistema._varianteB;
  broadcast('sistema', { sistema, overlay: sistema.tratamiento_fotos?.overlay_base });
  broadcast('status', { message: `✓ Sistema "${sistema.nombre_sistema}" — ${sistema.tipografia?.display?.familia} + ${sistema.tipografia?.body?.familia}` });

  // FASE 2.5: elegir modelo visual + adaptar slides
  const modelo = raw._modelo || elegirModeloCarrusel(raw.slides, temaInfo);
  const slidesAdaptadas = adaptarSlidesAModelo(raw.slides, modelo);
  console.log(`\n🎭 Modelo visual: ${modelo.toUpperCase()}`);
  broadcast('status', { message: `🎭 Modelo visual: ${modelo.toUpperCase()}` });

  // FASE 3: analizar cada slide
  // big_number, timeline y grid también son tipos con layout propio — solo necesitan _sistema
  const tiposNuevos = ['split_v', 'full_impact', 'before_after', 'triple_v', 'big_number', 'timeline', 'grid'];
  console.log(`\n🎨 Analizando ${slidesAdaptadas.length} slides...\n`);
  const slidesFinales = [];

  for (let i = 0; i < slidesAdaptadas.length; i++) {
    const slide = slidesAdaptadas[i];
    const num   = String(i + 1).padStart(2, '0');

    // split_v: dos fotos independientes — cada una se analiza para decidir
    // en qué esquina va su bloque de texto sin tapar al sujeto
    if (slide.type === 'split_v') {
      process.stdout.write(`  ◐ Slide ${num} (split_v) — analizando composición...`);
      broadcast('status', { message: `◐ Slide ${num} (split_v) — analizando composición de ambas fotos...` });
      const final = { ...slide, _sistema: { paleta: sistema.paleta, iconos: sistema.iconos } };
      const mitades = [['photo_top', '_topPos'], ['photo_bottom', '_bottomPos']];
      for (const [photoKey, posKey] of mitades) {
        if (!slide[photoKey]) continue;
        try {
          const { base64, mime } = await photoToBase64(slide[photoKey]);
          const comp = await analizarComposicionFoto(base64, mime);
          if (comp) {
            final[posKey] = { align: comp.zona_texto_h, valign: comp.zona_texto_v };
            if (comp.razon) console.log(`\n     💡 ${photoKey}: ${comp.razon}`);
          }
        } catch (err) {
          console.log(`\n     ✗ ${photoKey}: ${err.message}`);
        }
      }
      slidesFinales.push(final);
      console.log(' ✓');
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
      continue;
    }

    // triple_v: hasta 3 fotos independientes, una por fila
    if (slide.type === 'triple_v') {
      const totalRows = slide.rows?.length || 0;
      process.stdout.write(`  ◐ Slide ${num} (triple_v) — analizando composición de ${totalRows} fotos...`);
      broadcast('status', { message: `◐ Slide ${num} (triple_v) — analizando composición de ${totalRows} fotos...` });
      const rows = [];
      for (const row of slide.rows || []) {
        let pos = null;
        if (row.photo) {
          try {
            const { base64, mime } = await photoToBase64(row.photo);
            const comp = await analizarComposicionFoto(base64, mime);
            if (comp) {
              pos = { align: comp.zona_texto_h, valign: comp.zona_texto_v };
              if (comp.razon) console.log(`\n     💡 ${row.photo}: ${comp.razon}`);
            }
          } catch (err) {
            console.log(`\n     ✗ ${row.photo}: ${err.message}`);
          }
        }
        rows.push({ ...row, _pos: pos });
      }
      const final = { ...slide, rows, _sistema: { paleta: sistema.paleta, iconos: sistema.iconos } };
      slidesFinales.push(final);
      console.log(' ✓');
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
      continue;
    }

    // Slide sin foto ni tipo nuevo → sistema sin visión
    if (!slide.photo && !tiposNuevos.includes(slide.type)) {
      process.stdout.write(`  ○ Slide ${num} (${slide.type}) — sin foto, aplicando sistema...`);
      const final = aplicarDecisiones(slide, null, sistema);
      slidesFinales.push(final);
      console.log(' ✓');
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
      continue;
    }

    // Tipo nuevo que puede no tener photo directa
    const photoPath = slide.photo
      || slide.photo_top
      || slide.photo_bottom
      || slide.photo_before
      || slide.photo_after
      || null;

    if (!photoPath) {
      process.stdout.write(`  ○ Slide ${num} (${slide.type}) — sin foto, aplicando sistema...`);
      const final = tiposNuevos.includes(slide.type)
        ? { ...slide, _sistema: { paleta: sistema.paleta, iconos: sistema.iconos } }
        : aplicarDecisiones(slide, null, sistema);
      slidesFinales.push(final);
      console.log(' ✓');
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
      continue;
    }

    process.stdout.write(`  ◐ Slide ${num} (${slide.type}) — "${photoPath}"...`);
    broadcast('status', { message: `◐ Slide ${num} (${slide.type}) — analizando "${photoPath}"...` });
    try {
      const { base64, mime } = await photoToBase64(photoPath);
      const analisis = await analizarSlideConIA(slide, base64, mime, sistema, temaInfo);
      // full_impact tiene gradiente hardcodeado bottom-heavy (96% opaco al 100%).
      // Si el sujeto ocupa la zona media/baja, ese negro aplasta exactamente lo que
      // hay que mostrar. Lo convertimos a cover que sí respeta _gradiente/_textPosition.
      const slideParaDecisiones = (
        slide.type === 'full_impact' &&
        ['middle','bottom','full'].includes(analisis?.sujeto?.ocupa_zona)
      ) ? {
        ...slide,
        type: 'cover',
        headline: slide.line2 || slide.line1 || '',
        detail:   slide.line1 || '',
        kicker:   slide.footer_text || '',
        line1: undefined, line2: undefined, footer_text: undefined,
      } : slide;
      const final = aplicarDecisiones(slideParaDecisiones, analisis, sistema);
      slidesFinales.push(final);
      const pos   = analisis?.ajustes_texto?.posicion || '?';
      const textY = analisis?.ajustes_texto?.text_y_percent;
      const rec   = analisis?.recomendacion || '';
      const yLabel = textY != null ? ` y=${textY}%` : '';
      console.log(` ✓  [${pos}${yLabel}]`);
      if (rec) console.log(`     💡 ${rec}`);
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
      if (rec) broadcast('status', { message: `  💡 ${rec}` });
    } catch (err) {
      console.log(` ✗ ${err.message}`);
      const final = aplicarDecisiones(slide, null, sistema);
      slidesFinales.push(final);
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
    }
  }

  broadcast('status', { message: '✅ Análisis completo' });
  broadcast('done', {});

  const outName = contentFile.replace('.json', '.analizado.json');

  // Merge incremental: si hay un análisis previo, rescatar asignaciones
  // manuales de fotos (multi-foto y simples) antes de pisar el archivo.
  let anterior = null;
  try {
    anterior = JSON.parse(await readFile(path.join(__dirname, outName), 'utf-8'));
  } catch {}
  const slidesConMerge = mergeAsignacionesManuales(slidesFinales, anterior);
  if (anterior) console.log('\n🔄 Merge incremental: asignaciones manuales de fotos preservadas del análisis previo');

  const output = { ...raw, _sistema: sistema, _sistemaA: sistemaA, _sistemaB: sistemaB, _modelo: modelo, slides: slidesConMerge };
  await writeFile(path.join(__dirname, outName), JSON.stringify(output, null, 2), 'utf-8');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Modelo: ${modelo} | Sistema: "${sistema.nombre_sistema}" → ${outName}`);
  console.log(`   Fuentes: ${sistema.tipografia?.display?.familia} + ${sistema.tipografia?.body?.familia}`);
  console.log(`   Paleta: ${sistema.paleta?.fondo} → ${sistema.paleta?.acento}`);
  console.log(`   Corré: node generar.mjs ${outName}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(err => { console.error(err); process.exit(1); });
