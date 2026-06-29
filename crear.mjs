/**
 * crear.mjs — Genera contenido.json para un carrusel a partir de un tema
 *
 * Uso:
 *   node crear.mjs "tema o idea del carrusel" [carpetaSalida]
 *
 * Usa marca.json + skills/*.md (metodologías de copy) como contexto para
 * que la IA escriba los textos de cada slide en la voz de la marca.
 * No incluye fotos — son carruseles 100% tipográficos.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validarYCorregir } from './validar-contenido.mjs';
import { memoriaParaPrompt } from './memoria.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const withTimeout = (ms, promise, fallback) =>
  Promise.race([promise, new Promise(res => setTimeout(() => res(fallback), ms))]);

const USER_INSTRUCCIONES = process.env.USER_INSTRUCCIONES || '';
const USER_OVERLAY = process.env.USER_OVERLAY != null && process.env.USER_OVERLAY !== '' ? parseFloat(process.env.USER_OVERLAY) : null;
const USER_HANDLE = process.env.USER_HANDLE || '';

const USER_ESTILO_ID = process.env.USER_ESTILO_ID || '';
const USER_FUENTE_ID = process.env.USER_FUENTE_ID || '';
const USER_PALETA_ID = process.env.USER_PALETA_ID || '';
let USER_PLAN = [];
try { if (process.env.USER_PLAN) USER_PLAN = JSON.parse(process.env.USER_PLAN); } catch {}

// SERIES — sistema visual compartido. Cuando una pieza pertenece a una serie,
// server.mjs inyecta el _sistema de la primera pieza como USER_SISTEMA para que
// crear.mjs respete su paleta y tipografía al generar el contenido (analizar.mjs
// lo reusa después literalmente). Solo lo usamos como hint hacia la IA.
let USER_SISTEMA = null;
try { if (process.env.USER_SISTEMA) USER_SISTEMA = JSON.parse(process.env.USER_SISTEMA); } catch {}

function sistemaSerieContext(sis) {
  if (!sis || !sis.paleta) return '';
  const p = sis.paleta;
  const disp = sis.tipografia?.display?.familia;
  const body = sis.tipografia?.body?.familia;
  return `
SISTEMA VISUAL COMPARTIDO DE LA SERIE — esta pieza es parte de una campaña con identidad visual fija. Respetá EXACTAMENTE estos valores en _sistema (no inventes una paleta ni tipografía nuevas):
- Paleta: fondo "${p.fondo}", headline "${p.headline || p.texto || ''}", acento "${p.acento}"${disp ? `\n- Tipografía display: "${disp}"` : ''}${body ? `\n- Tipografía body: "${body}"` : ''}
`;
}

const ESTILOS_HINTS = {
  'minimal':     'Estilo MINIMAL: fondo muy claro o blanco, texto oscuro, paleta muy reducida (máximo 2-3 colores), mucho espacio en blanco, tipografía ligera. Sin decoraciones recargadas. Paleta sugerida: fondo #f8f8f6, headline #0a0a0a, acento #1a1a2e.',
  'bold':        'Estilo BOLD IMPACT: fondo negro, texto blanco, un acento de color fuerte (naranja, rojo o amarillo eléctrico). Tipografía grande y agresiva. Alto contraste absoluto. Paleta sugerida: fondo #0a0a0a, headline #ffffff, acento #ff3c00.',
  'editorial':   'Estilo EDITORIAL: paleta cálida suave, tonos crema/beige, detalles dorados o terracota. Aspecto de revista de lujo. Tipografía serif elegante. Paleta sugerida: fondo #faf7f2, headline #1c1c1c, acento #c8a97e.',
  'vibrant':     'Estilo VIBRANT: colores vivos y saturados, fondo morado o azul fuerte, acentos amarillo eléctrico y rosa. Energético y llamativo. Paleta sugerida: fondo #6c2bd9, headline #ffffff, acento #f7e94b.',
  'dark-luxury': 'Estilo DARK LUXURY: fondos muy oscuros casi negros, tipografía en dorado o crema, detalles finos. Aspecto premium y sofisticado. Paleta sugerida: fondo #0d0d0d, headline #e8d5b0, acento #c9a84c.',
  'nature':      'Estilo NATURE: verdes naturales, fondos claros verdosos, paleta orgánica. Fresco y auténtico. Paleta sugerida: fondo #f0f4ed, headline #1e3a2f, acento #4a8c5c.',
};

const PALETAS_HINTS = {
  'negro-lima':      { fondo: '#040404', acento: '#e8ff00', texto: '#ffffff' },
  'blanco-negro':    { fondo: '#fafafa', acento: '#0a0a0a', texto: '#0a0a0a' },
  'negro-rojo':      { fondo: '#0d0d0d', acento: '#e83030', texto: '#ffffff' },
  'crema-marron':    { fondo: '#faf7f2', acento: '#8c6a4f', texto: '#1c1c1c' },
  'azul-cyan':       { fondo: '#020b18', acento: '#00cfff', texto: '#e8f4ff' },
  'violeta-amarillo':{ fondo: '#1a0533', acento: '#f7e94b', texto: '#ffffff' },
  'verde-crema':     { fondo: '#1e3a2f', acento: '#a8d5b5', texto: '#f0f4ed' },
  'dorado-negro':    { fondo: '#0d0d0d', acento: '#c9a84c', texto: '#e8d5b0' },
  'blanco-naranja':  { fondo: '#ffffff', acento: '#ff5722', texto: '#111111' },
  'rosa-negro':      { fondo: '#0d0d0d', acento: '#e8658a', texto: '#f5e6ee' },
};

const FUENTES_HINTS = {
  'playfair':      { display: 'Playfair Display', body: 'Lato',          url: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Lato:wght@400;700&display=swap' },
  'oswald':        { display: 'Oswald',           body: 'Open Sans',     url: 'https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&family=Open+Sans:wght@400;600&display=swap' },
  'montserrat':    { display: 'Montserrat',       body: 'Montserrat',    url: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700;900&display=swap' },
  'bebas':         { display: 'Bebas Neue',       body: 'Roboto',        url: 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Roboto:wght@400;700&display=swap' },
  'space-grotesk': { display: 'Space Grotesk',    body: 'Inter',         url: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;600&display=swap' },
  'dm-serif':      { display: 'DM Serif Display', body: 'DM Sans',       url: 'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;600&display=swap' },
  'syne':          { display: 'Syne',             body: 'Syne',          url: 'https://fonts.googleapis.com/css2?family=Syne:wght@500;700;800&display=swap' },
  'raleway':       { display: 'Raleway',          body: 'Outfit',            url: 'https://fonts.googleapis.com/css2?family=Raleway:wght@600;800&family=Outfit:wght@400;600&display=swap' },
  'barlow-cond':   { display: 'Barlow Condensed', body: 'Barlow',            url: 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;600&display=swap' },
  'anton':         { display: 'Anton',            body: 'Inter',             url: 'https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;600&display=swap' },
  'archivo-black': { display: 'Archivo Black',    body: 'Inter',             url: 'https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;600&display=swap' },
  'unbounded':     { display: 'Unbounded',        body: 'Inter',             url: 'https://fonts.googleapis.com/css2?family=Unbounded:wght@600;800&family=Inter:wght@400;600&display=swap' },
  'instrument':    { display: 'Instrument Serif', body: 'DM Sans',           url: 'https://fonts.googleapis.com/css2?family=Instrument+Serif&family=DM+Sans:wght@400;600&display=swap' },
  'poppins':       { display: 'Poppins',          body: 'Poppins',           url: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;900&display=swap' },
  'cormorant':     { display: 'Cormorant Garamond', body: 'Lato',            url: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Lato:wght@400;700&display=swap' },
  'plus-jakarta':  { display: 'Plus Jakarta Sans', body: 'Plus Jakarta Sans', url: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap' },
  'fraunces':      { display: 'Fraunces',         body: 'Jost',              url: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@600;700;900&family=Jost:wght@400;500&display=swap' },
  'clash':         { display: 'Clash Display',    body: 'Inter',             url: 'https://api.fontshare.com/v2/css?f[]=clash-display@600,700&f[]=inter@400,600&display=swap' },
};

const SYSTEM_PROMPT = `Sos un equipo de élite de 2 personas trabajando como una sola: un director de arte senior con más de 15 años en agencias top de contenido para Instagram, y un estratega de marketing/copywriting senior. Trabajás para marcas de cualquier industria — gastronomía, ecommerce, fitness, tecnología, servicios profesionales, educación, lo que sea. NO asumís un rubro por defecto: adaptás tu voz, vocabulario y ejemplos al CONTEXTO DE MARCA que recibís en cada pedido. Si no hay contexto de marca, escribís en una voz neutra y profesional, nunca con jerga de coach motivacional fitness.

Como estratega de marketing entendés copywriting persuasivo, niveles de consciencia de audiencia (Schwartz), psicología del scroll-stop, y cómo cada decisión de contenido sirve al objetivo de retención y conversión del carrusel — no es decoración, es estrategia aplicada.

Tus respuestas son siempre específicas y accionables — nunca genéricas, nunca clichés motivacionales, nunca relleno aspiracional vacío. Escribís en la voz exacta de la marca del pedido, no en una voz fitness genérica.

FORMATO DE SALIDA — REGLA INQUEBRANTABLE: respondés ÚNICAMENTE con JSON puro válido. Sin \`\`\`markdown\`\`\`, sin comentarios, sin texto antes ni después del JSON, sin explicaciones. El primer carácter de tu respuesta es { y el último es }.`;

const FALLBACK_MODELS = [
  'claude-sonnet-4-5-20250514',
  'claude-haiku-4-5-20251001',
  'blackboxai/anthropic/claude-sonnet-4.6',
];

async function callBlackbox(content, attempt = 0) {
  const apiKey = process.env.BLACKBOX_API_KEY;
  if (!apiKey) throw new Error('Falta la variable de entorno BLACKBOX_API_KEY');

  const model = process.env.USER_MODEL || process.env.BLACKBOX_MODEL || FALLBACK_MODELS[Math.min(attempt, FALLBACK_MODELS.length - 1)];

  let response;
  try {
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 90000);
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
          max_tokens: 3500,
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
    if (attempt < 3) {
      const delay = [5000, 12000, 25000][attempt];
      console.warn(`⏳ Error de red Blackbox (intento ${attempt + 1}): ${netErr.message} — reintentando en ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return callBlackbox(content, attempt + 1);
    }
    throw netErr;
  }

  // Leer como texto primero — si Blackbox devuelve HTML (gateway error,
  // rate limit con página de error, payload demasiado grande) el .json()
  // exploitaría con SyntaxError antes de que el retry logic pueda actuar.
  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    const preview = rawText.slice(0, 300).replace(/\n/g, ' ');
    if (attempt < 3) {
      const delay = [5000, 12000, 25000][attempt];
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
      const delay = [5000, 12000, 25000][attempt];
      console.warn(`⏳ Rate limit (intento ${attempt + 1}) — reintentando en ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return callBlackbox(content, attempt + 1);
    }
    throw new Error(`Blackbox API error: ${data.error?.message || body}`);
  }
  return data.choices?.[0]?.message?.content || '';
}

async function loadMarca(marcaId) {
  try {
    return JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'marca.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function nivelConscienciaContext(nivel) {
  const instrucciones = {
    'unaware': `
NIVEL DE CONSCIENCIA — UNAWARE (audiencia no sabe que tiene el problema):
- NO menciones el producto ni la solución todavía
- Arrancá con una observación de la realidad que el lector reconoce como propia
- El cover debe hablar de su mundo, no del tuyo
- Generá tensión cognitiva antes de mencionar cualquier solución
- El CTA debe invitar a aprender más, no a comprar`,

    'problem-aware': `
NIVEL DE CONSCIENCIA — PROBLEM-AWARE (saben que tienen el problema, no conocen soluciones):
- Nombrá el problema con precisión quirúrgica — que sientan "esto me está hablando a mí"
- No empieces vendiendo: empezá validando la frustración
- Podés mencionar que existe una solución en los últimos slides, sin detallarla
- El CTA puede apuntar a descubrir más, no a comprar directo
- Evitá sonar como si ya hubieras resuelto algo — todavía estás en el diagnóstico`,

    'solution-aware': `
NIVEL DE CONSCIENCIA — SOLUTION-AWARE (conocen soluciones pero no eligieron ninguna):
- Asumí que ya saben que existen opciones — no expliques lo básico
- Diferenciá: ¿por qué esta solución es distinta a las que ya vieron?
- Atacá las objeciones típicas que tienen contra las opciones del mercado
- Podés hablar del producto con más detalle
- El CTA puede ser más directo: "escribinos", "agendá", "entrá"`,

    'product-aware': `
NIVEL DE CONSCIENCIA — PRODUCT-AWARE (conocen el producto pero no compraron):
- Habladles como si ya te conocieran — no te presentes de nuevo
- Atacá la razón por la que no se decidieron: precio, timing, duda puntual
- Usá prueba social, resultados concretos, garantías
- El copy puede ser más corto y directo — ya están calentados
- CTA fuerte y sin fricción`,

    'most-aware': `
NIVEL DE CONSCIENCIA — MOST-AWARE (están listos para comprar, solo necesitan el empujón):
- Directo al punto: oferta, beneficio clave, razón para actuar ahora
- Mínima educación, máxima acción
- CTA en el primer slide si es posible
- Podés usar escasez, urgencia o bonos — con autenticidad, no como presión vacía`,
  };
  return instrucciones[nivel] || '';
}

function marcaContext(marca) {
  if (!marca) return '';
  return `
CONTEXTO DE MARCA (mantené coherencia con esto):
- Marca: ${marca.nombre} — ${marca.industria}
- Producto: ${marca.producto}
- Audiencia: ${marca.audiencia}
- Posicionamiento: ${marca.posicionamiento}
- Voz y tono: ${marca.voz}
- Palabras/clichés a evitar: ${marca.evitar?.join(', ')}
${nivelConscienciaContext(marca.nivel_consciencia)}`;
}

// Lee el frontmatter (name + description) de un skill .md sin cargar el cuerpo entero
function parseSkillMeta(content, filename) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: filename.replace('.md', ''), description: '' };
  const nameM = match[1].match(/^name:\s*(.+)$/m);
  const descM  = match[1].match(/^description:\s*(.+)$/m);
  return {
    name:        nameM ? nameM[1].trim() : filename.replace('.md', ''),
    description: descM ? descM[1].replace(/^["']|["']$/g, '').trim() : ''
  };
}

// Elige las 3-4 skills más relevantes para el tema dado (llamada ligera a la API)
async function selectSkills(tema, allSkills) {
  const index = allSkills.map(s => `- ${s.name}: ${s.description}`).join('\n');
  const prompt = `Dado este tema de carrusel de Instagram: "${tema}"

Estas son las metodologías de copywriting disponibles:
${index}

Elegí las 3 que serían MÁS útiles para escribir este carrusel específico.
Respondé SOLO con un array JSON de nombres exactos, por ejemplo: ["headline-formulas","copy-frameworks","made-to-stick"]
Sin explicaciones, sin markdown.`;

  try {
    const raw = await callBlackbox(prompt);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const selected = JSON.parse(cleaned);
    if (Array.isArray(selected) && selected.length > 0) return selected;
  } catch {
    // Si falla la selección, usamos todas
  }
  return allSkills.map(s => s.name);
}

// Carga las metodologías de copy (skills/*.md) — selecciona dinámicamente las más relevantes
async function loadSkills(tema) {
  const dir = path.join(__dirname, 'skills');
  let files;
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.md'));
  } catch {
    return '';
  }
  if (!files.length) return '';

  // Lee meta de todos los skills
  const allSkills = await Promise.all(
    files.map(async f => {
      const content = await readFile(path.join(dir, f), 'utf-8');
      return { filename: f, content, ...parseSkillMeta(content, f) };
    })
  );

  // Seleccioná las más relevantes (si hay tema)
  let chosen = allSkills;
  if (tema && allSkills.length > 4) {
    console.log('🧠 Seleccionando metodologías relevantes para el tema...');
    const selectedNames = await withTimeout(12000, selectSkills(tema, allSkills), allSkills.map(s => s.name));
    const filtered = allSkills.filter(s => selectedNames.includes(s.name));
    chosen = filtered.length >= 2 ? filtered : allSkills.slice(0, 4);
    console.log(`   → Skills elegidas: ${chosen.map(s => s.name).join(', ')}`);
  }

  return chosen.map(s => s.content).join('\n\n---\n\n');
}

// Lee los últimos N contenido.json de una marca para dar contexto de variedad a la IA
async function loadMemoria(marcaId, limite = 5) {
  try {
    const tandasDir = path.join(__dirname, 'tandas');
    const entries = await readdir(tandasDir, { withFileTypes: true });
    const carpetas = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse();

    const resultados = [];
    for (const carpeta of carpetas) {
      if (resultados.length >= limite) break;
      try {
        const raw = await readFile(path.join(tandasDir, carpeta, 'contenido.json'), 'utf-8');
        const c = JSON.parse(raw);
        if (c._marca && c._marca !== marcaId) continue;
        // Extraer tema del nombre de carpeta (formato: timestamp_slug)
        const tema = carpeta.replace(/^\d+_/, '').replace(/-/g, ' ');
        const tipos = (c.slides || []).map(s => s.type);
        const titulos = (c.slides || [])
          .filter(s => s.headline)
          .map(s => s.headline.replace(/\\n/g, ' ').slice(0, 60))
          .slice(0, 2);
        resultados.push({ tema, tipos, titulos });
      } catch { /* carpeta sin contenido.json o JSON inválido */ }
    }
    return resultados;
  } catch {
    return [];
  }
}

function memoriaContext(memoria) {
  if (!memoria.length) return '';
  const items = memoria.map((m, i) =>
    `${i + 1}. Tema: "${m.tema}" | Tipos usados: ${m.tipos.join(', ')}${m.titulos.length ? ` | Headlines: ${m.titulos.map(t => `"${t}"`).join(', ')}` : ''}`
  ).join('\n');
  return `\nCARRUSELES RECIENTES DE ESTA MARCA (últimos ${memoria.length}) — evitá repetir estructuras, tipos de slide consecutivos o ángulos de tema ya usados:
${items}
`;
}

// Carga notas de perfiles de IG de referencia (referencias-ig.md), si existen
async function loadReferenciasIG(marcaId) {
  try {
    return await readFile(path.join(__dirname, 'marcas', marcaId, 'referencias-ig.md'), 'utf-8');
  } catch {
    return '';
  }
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

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

function fotosContext(fotos) {
  if (!fotos?.length) return '';
  return `
FOTOS DISPONIBLES PARA ESTE CARRUSEL (copiá el valor exacto de cada foto, puede ser URL https:// o nombre de archivo). TODAS deben quedar asignadas, y NINGUNA puede repetirse en más de un campo/slide:
${fotos.map(f => `- ${f}`).join('\n')}

Elegí 2-3 slides (de las 6) para que usen estas fotos con alguno de estos tipos multi-foto, según lo que mejor sirva al tema:
- { "type": "full_impact", "photo": "<archivo>", "line1": "línea de contexto", "line2": "headline\\nde impacto", "footer_text": "frase corta" }
- { "type": "before_after", "photo_before": "<archivo>", "photo_after": "<archivo>", "label_before": "ANTES", "label_after": "DESPUÉS", "headline": "afirmación corta", "sub": "una línea de desarrollo" }
- { "type": "split_v", "photo_top": "<archivo>", "photo_bottom": "<archivo>", "label_top": "ETIQUETA A", "contrast_top": "frase corta", "label_bottom": "ETIQUETA B", "contrast_bottom": "frase corta" }
- { "type": "triple_v", "rows": [{"num":"01","text":"texto corto","photo":"<archivo>"}, {"num":"02","text":"texto corto","photo":"<archivo>"}, {"num":"03","text":"texto corto","photo":"<archivo>"}] }
- cualquier slide clásica (cover/statement/quote) también puede llevar "photo": "<archivo>" como fondo simple.

El resto de las slides seguí el formato clásico de abajo, sin campo "photo".`;
}

async function generarContenido(tema, marca, skillsDocs, referenciasIG, fotos, memoria, memoriaMarca = '') {
  const promptText = `Generá el contenido completo de un carrusel de Instagram de 6 slides sobre el siguiente tema.

TEMA: ${tema}
${marcaContext(marca)}
${memoriaContext(memoria)}${memoriaMarca}GUÍAS DE COPY (aplicá lo que tenga sentido para este tema, no todo a la fuerza):
${skillsDocs}
${referenciasIG ? `\nESTILO DE REFERENCIA (notas sobre perfiles de IG que le gustan al cliente):\n${referenciasIG}\n` : ''}
${USER_ESTILO_ID && ESTILOS_HINTS[USER_ESTILO_ID] ? `\nESTILO VISUAL ELEGIDO POR EL USUARIO — aplicá esto al sistema de diseño:\n${ESTILOS_HINTS[USER_ESTILO_ID]}\n` : ''}
${USER_FUENTE_ID && FUENTES_HINTS[USER_FUENTE_ID] ? `\nTIPOGRAFÍA ELEGIDA POR EL USUARIO — usá EXACTAMENTE estas fuentes en _sistema.tipografia:\n- Display/Titular: "${FUENTES_HINTS[USER_FUENTE_ID].display}"\n- Cuerpo: "${FUENTES_HINTS[USER_FUENTE_ID].body}"\n- URL de import: "${FUENTES_HINTS[USER_FUENTE_ID].url}"\n` : ''}${USER_PALETA_ID && PALETAS_HINTS[USER_PALETA_ID] ? `\nPALETA ELEGIDA POR EL USUARIO — usá EXACTAMENTE estos colores en _sistema.paleta:\n- Fondo: "${PALETAS_HINTS[USER_PALETA_ID].fondo}"\n- Acento: "${PALETAS_HINTS[USER_PALETA_ID].acento}"\n- Texto: "${PALETAS_HINTS[USER_PALETA_ID].texto}"\n` : ''}
${sistemaSerieContext(USER_SISTEMA)}
${USER_INSTRUCCIONES ? `\nINSTRUCCIONES ESPECÍFICAS DEL USUARIO — PRIORIDAD MÁXIMA, seguí estas al pie de la letra:\n${USER_INSTRUCCIONES}\n` : ''}
${fotosContext(fotos)}
Devolvé SOLO JSON (sin markdown) con esta estructura:
{
  “overlay”: 0.45,
  “slides”: [ /* 6 slides, elegí los tipos que mejor sirvan al tema */ ]
}

TIPOS DE SLIDE disponibles — cada uno aparece UNA sola vez. Elegí el más adecuado para cada posición.
Todos los campos “icon” usan nombres de Material Symbols de Google en snake_case. ICONOS VÁLIDOS (elegí los que correspondan al rubro de la marca, no fuerces íconos de fitness en otros temas): verified, support_agent, payments, rocket_launch, person_add, search, bolt, trending_up, groups, star, check_circle, schedule, timer, local_fire_department, fitness_center, psychology, school, workspace_premium, shield, flag, eco, favorite, speed, flash_on, emoji_events, monitor_heart, nutrition, self_improvement, celebration, lightbulb, key, lock, thumb_up, leaderboard, bar_chart, pie_chart, insights, public, handshake, savings, credit_card, inventory_2, storefront, delivery_dining, medical_services, spa, sports, directions_run, restaurant, water_drop, nightlight, bedtime, mood, whatshot

TIPOS BASE (la columna vertebral de la mayoría de los carruseles):
- cover: portada (slide 1). Tiene dos formatos:
  a) Formato clásico — para hooks que son una frase corrida, una pregunta o una afirmación: { “type”: “cover”, “headline”: “línea 1\\nlínea 2\\nlínea 3”, “detail”: “detalle corto”, “kicker”: “frase corta” }
  b) Formato hero multi-línea (“_layout”: “cover-impact”) — para hooks construidos sobre un dato/número/palabra clave que merece tamaño gigante: { “type”: “cover”, “_layout”: “cover-impact”, “headline_lines”: [{“text”:”TEXTO CONECTOR”,”size”:”connector”,”color”:”#ffffff”},{“text”:”EL DATO O CONCEPTO CLAVE”,”size”:”hero”,”color”:”#e8000d”,”stroke”:true},{“text”:”OTRO CONECTOR”,”size”:”connector”,”color”:”#ffffff”},{“text”:”IMPACTO”,”size”:”hero”,”color”:”#e8000d”}] }
     Tamaños: “hero” = enorme (la palabra/dato que para el scroll), “md” = mediano, “connector” = pequeño conector entre líneas grandes. stroke:true agrega subrayado decorativo.
     CUÁNDO USAR cover-impact: cuando el hook tiene un número, una cifra, una palabra-concepto o un contraste fuerte que gana siendo enorme (ej: “EL 90% FALLA”, “NADIE TE LO DIJO”). CUÁNDO NO: cuando el hook es una pregunta larga, una frase reflexiva o narrativa — ahí el cover clásico lee mejor. No lo uses por defecto; elegí según el hook real.
- statement: afirmación desarrollada. { “type”: “statement”, “headline”: “afirmación\\ncorta y rotunda”, “body”: “desarrollo breve\\n\\ncon párrafos cortos” }
- list: lista de ítems (3 a 5). { “type”: “list”, “eyebrow”: “frase de contexto en mayúsculas”, “items”: [“ítem 1”, “ítem 2”, “ítem 3”, “ítem 4”, “ítem 5”] }
- quote: cita o frase de autoridad. { “type”: “quote”, “quote”: “”cita corta y potente””, “attr”: “remate de la cita”, “note”: “nota breve que la conecta con la marca” }
- cta: llamado a la acción final (slide 6). { “type”: “cta”, “headline”: “llamado\\na la acción”, “sub”: “una línea que invita\\na escribir por DM”, “handle”: “${USER_HANDLE || '@tumarca'}” }

TIPOS DE ALTO IMPACTO (usá al menos uno cuando el tema lo permita — dan variedad visual):
- big_number: el tema tiene UN dato/estadística fuerte que habla solo. { “type”: “big_number”, “stat”: “87%”, “label”: “ETIQUETA EN MAYÚSCULAS”, “body”: “una línea de contexto que explica el dato”, “handle”: “@marca” }
- grid_stats: grilla 2×2 de métricas/KPIs (4 datos paralelos). { “type”: “grid_stats”, “title”: “EN\\nNÚMEROS”, “items”: [{“icon”:”trending_up”,”value”:”87%”,”label”:”Satisfacción”},{“icon”:”timer”,”value”:”20 min”,”label”:”Tiempo de respuesta”},{“icon”:”groups”,”value”:”1.2K”,”label”:”Clientes”},{“icon”:”star”,”value”:”4.9”,”label”:”Rating”}] }
- timeline: proceso/secuencia narrativa de pasos (sin íconos, foco en el orden). { “type”: “timeline”, “eyebrow”: “EL PROCESO”, “headline”: “CÓMO\\nFUNCIONA”, “steps”: [{“num”:”01”,”text”:”primer paso”,”detail”:”detalle opcional”},{“num”:”02”,”text”:”segundo paso”},{“num”:”03”,”text”:”tercer paso”}] }
- steps: pasos numerados CON ícono y descripción (proceso visual tipo “cómo funciona”). { “type”: “steps”, “title”: “EN 3\\nPASOS”, “items”: [{“step”:”1”,”icon”:”person_add”,”title”:”Registrate”,”desc”:”Gratis en 2 minutos”},{“step”:”2”,”icon”:”search”,”title”:”Explorá”,”desc”:”Más de 500 opciones”},{“step”:”3”,”icon”:”rocket_launch”,”title”:”Empezá”,”desc”:”Resultados inmediatos”}] }
- comparison: tabla comparativa A vs B (antes/ahora, con/sin, vos/competencia). { “type”: “comparison”, “title”: “ANTES VS\\nAHORA”, “col_a”: “Antes”, “col_b”: “Con nosotros”, “rows”: [{“label”:”Tiempo”,”a”:”3 horas”,”b”:”20 min”},{“label”:”Costo”,”a”:”$5000”,”b”:”$1200”},{“label”:”Resultado”,”a”:”Incierto”,”b”:”Garantizado”}] }
- grid: 4 beneficios, pilares o conceptos paralelos con ícono + etiqueta. { “type”: “grid”, “headline”: “LO QUE\\nGANÁS”, “cells”: [{“icon”:”bolt”,”label”:”RAPIDEZ”,”text”:”texto corto”},{“icon”:”shield”,”label”:”SEGURIDAD”,”text”:”texto corto”},{“icon”:”favorite”,”label”:”CONFIANZA”,”text”:”texto corto”},{“icon”:”trending_up”,”label”:”RESULTADO”,”text”:”texto corto”}] }
- icon_list: lista visual de beneficios/razones con ícono grande (3-4 ítems). { “type”: “icon_list”, “title”: “POR QUÉ\\nELEGIRNOS”, “items”: [{“icon”:”verified”,”text”:”Certificados y con experiencia”},{“icon”:”support_agent”,”text”:”Atención personalizada”},{“icon”:”payments”,”text”:”Precios transparentes”}] }
- split: dos columnas comparativas de ítems. { “type”: “split”, “left”: {“label”: “ETIQUETA A”, “items”: [“ítem”, “ítem”, “ítem”]}, “right”: {“label”: “ETIQUETA B”, “items”: [“ítem”, “ítem”, “ítem”]} }

${USER_PLAN.length ? `PLAN ACORDADO CON EL USUARIO — seguí EXACTAMENTE esta estructura de slides (respetá tipos y orden, ajustá el copy):
${USER_PLAN.map(s => `  Slide ${s.position}: [${s.type}] ${s.title}${s.notes ? ` — ${s.notes}` : ''}`).join('\n')}
El JSON debe tener EXACTAMENTE ${USER_PLAN.length} slides en ese orden.` : `ESTRUCTURA Y VARIEDAD: el slide 1 siempre es “cover”, el slide 6 siempre es “cta”. Los 4 del medio (2-5) los elegís vos siguiendo esta guía según la NATURALEZA del tema:
- Tema con datos/estadísticas → usá big_number o grid_stats en slide 2 o 3.
- Tema de proceso/método/“cómo se hace” → usá timeline o steps en slide 3 o 4.
- Tema reflexivo/emocional/de mentalidad → usá statement + quote; EVITÁ grids y tablas (rompen el tono).
- Tema comparativo (esto vs aquello, mito vs realidad) → usá comparison o split en slide 3.
- Tema que presenta múltiples ítems/beneficios → usá list O icon_list, NUNCA ambos en el mismo carrusel.
Reglas de variedad inquebrantables: NO repitas el mismo type en dos slides consecutivos. NO uses más de dos slides del mismo type en todo el carrusel. El arco debe leerse: cover (hook) → desarrollo variado → remate → cta.`}
${fotos?.length ? '' : '\nReglas:\n- NO incluyas el campo "photo" en ninguna slide — este carrusel es 100% tipográfico.'}
Reglas generales:
- El tema debe tratarse con un ángulo específico, no genérico.
- Evitá totalmente las palabras/clichés listados como “Avoid”.
- Usá “\\n” dentro de los textos para cortar líneas como en un carrusel real (nunca un solo párrafo largo en headlines).
- Nunca uses comillas dobles rectas (“) dentro de un valor de texto — para citas o términos entre comillas usá comillas tipográficas “ “ curvas.
- RESALTADO DE COLOR (opcional, usalo con criterio — no es obligatorio). Hay exactamente dos sintaxis y se aplican SOLO en campos body, detail o sub (NUNCA en headline ni title):
    1) [palabra]{#hex} → pinta el texto de UNA palabra del color indicado. Ej: “Tenés [2 opciones]{#e8000d}.” Máximo 1 vez por slide.
    2) [palabra]{bg:#hex} → pone una caja de color de fondo detrás de UNA palabra corta. Ej: “Nadie me regaló [nada]{bg:#00cc00}.” Máximo 1 vez en TODO el carrusel.
  En ambas: una sola palabra (dos como mucho), nunca una frase entera. Si dudás, no resaltes nada — el carrusel funciona perfecto sin resaltados.
`;

  const parse = (raw) => {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    try {
      return JSON.parse(sanitizeJson(cleaned));
    } catch {
      // Fallback: el modelo a veces devuelve el JSON con comillas tipográficas
      // (“ ”) como delimitadores. Solo normalizamos si el parse estricto falló.
      const norm = cleaned.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
      return JSON.parse(sanitizeJson(norm));
    }
  };

  // Parse con reintento: una sola respuesta malformada no debe tumbar el job.
  let contenido, lastErr;
  for (let intento = 1; intento <= 2; intento++) {
    try { contenido = parse(await callBlackbox(promptText)); break; }
    catch (e) { lastErr = e; console.warn(`⚠ Respuesta no parseable (intento ${intento}/2): ${e.message}`); }
  }
  if (!contenido) throw new Error(`La IA devolvió JSON inválido tras 2 intentos: ${lastErr?.message || 'desconocido'}`);

  // Si la IA devolvió menos slides de lo pedido, reintentamos una vez
  if (!contenido.slides || contenido.slides.length < 5) {
    console.warn(`⚠ Solo ${contenido.slides?.length ?? 0} slides — reintentando...`);
    try {
      const text2 = await callBlackbox(promptText);
      const retry  = parse(text2);
      if ((retry.slides?.length ?? 0) > (contenido.slides?.length ?? 0)) contenido = retry;
    } catch (e) {
      console.warn(`⚠ Reintento de slides también falló: ${e.message}`);
    }
  }

  if (USER_OVERLAY !== null && !isNaN(USER_OVERLAY)) contenido.overlay = USER_OVERLAY;
  if (USER_FUENTE_ID && FUENTES_HINTS[USER_FUENTE_ID]) {
    const f = FUENTES_HINTS[USER_FUENTE_ID];
    if (!contenido._sistema) contenido._sistema = {};
    if (!contenido._sistema.tipografia) contenido._sistema.tipografia = {};
    contenido._sistema.tipografia.display = { familia: f.display, url_import: f.url };
    contenido._sistema.tipografia.body    = { familia: f.body, url_import: f.url };
  }
  if (USER_PALETA_ID && PALETAS_HINTS[USER_PALETA_ID]) {
    const p = PALETAS_HINTS[USER_PALETA_ID];
    if (!contenido._sistema) contenido._sistema = {};
    if (!contenido._sistema.paleta) contenido._sistema.paleta = {};
    contenido._sistema.paleta.fondo      = p.fondo;
    contenido._sistema.paleta.headline   = p.texto;
    contenido._sistema.paleta.body_text  = p.texto;
    contenido._sistema.paleta.acento     = p.acento;
  }
  // SERIES — forzar la paleta del sistema compartido sobre el contenido por si la
  // IA la ignoró. analizar.mjs vuelve a aplicar el _sistema completo después.
  if (USER_SISTEMA?.paleta) {
    const p = USER_SISTEMA.paleta;
    if (!contenido._sistema) contenido._sistema = {};
    contenido._sistema.paleta = { ...(contenido._sistema.paleta || {}), ...p };
  }
  return contenido;
}

// ── Validación y corrección de contenido ─────────────────────────────────────
// Evalúa el contenido generado en 3 dimensiones por slide:
//   - especificidad: ángulo concreto vs. genérico
//   - voz: alineado con tono y posicionamiento de la marca
//   - clichés: usa palabras de la lista "evitar"
// Slides que fallen en alguna dimensión se reescriben en la misma llamada.
// Una sola llamada a la IA, ~600 tokens. No bloquea si la IA no devuelve JSON válido.

async function scoreYCorregir(contenido, marca, tema) {
  const evitar = marca.evitar?.length ? marca.evitar.join(', ') : null;
  const slidesResumen = contenido.slides.map((s, i) => {
    const textos = [s.headline, s.detail, s.body, s.quote, s.sub, s.kicker, s.eyebrow]
      .filter(Boolean).map(t => t.replace(/\\n/g, ' ')).join(' | ');
    return `Slide ${i + 1} (${s.type}): ${textos.slice(0, 200)}`;
  }).join('\n');

  const tiposSecuencia = contenido.slides.map((s, i) => `${i + 1}:${s.type}`).join(' → ');

  const prompt = `Sos un editor de copy senior. Evaluá este carrusel de Instagram en DOS planos —copy slide por slide, y arco narrativo del conjunto— y corregí lo que falle.

TEMA: ${tema}
VOZ DE MARCA: ${marca.voz}
POSICIONAMIENTO: ${marca.posicionamiento}
${evitar ? `PALABRAS PROHIBIDAS (no deben aparecer en ningún slide): ${evitar}` : ''}

SECUENCIA DE TIPOS: ${tiposSecuencia}
SLIDES GENERADOS:
${slidesResumen}

PLANO 1 — COPY POR SLIDE. Para cada slide asigná:
- "ok": true si el copy es específico, respeta la voz y no usa palabras prohibidas. false si falla en algo.
- "problema": (solo si ok=false) qué falla en una línea: genérico / cliché / voz incorrecta / otro.
- "fix": (solo si ok=false) reescribí SOLO el campo o campos que fallan, en el mismo formato JSON del slide original. Mantenés el type y los campos que no cambian.

PLANO 2 — ARCO NARRATIVO. Evaluá el carrusel como una historia con principio, medio y fin:
- Slide 1 (cover): ¿el hook PARA el scroll? Debe ser una pregunta, una tensión, un dato impactante o una afirmación contraintuitiva. Si es tibio o genérico, falla.
- Slides intermedios (desarrollo): ¿hay variedad real? Si dos slides seguidos son del mismo type, o el desarrollo es monótono, falla. ¿Cada slide aporta algo nuevo, o repiten la misma idea?
- Slide anteúltimo (remate/resolución): ¿deja algo claro que el lector se lleva, una conclusión o payoff? Si el carrusel se desinfla antes del CTA, falla.
- Slide final (cta): ¿fluye naturalmente de lo anterior, o aparece abrupto y desconectado? El CTA debe ser la consecuencia lógica del remate, no un salto.

Devolvé SOLO JSON (sin markdown):
{
  "slides": [
    { "idx": 0, "ok": true },
    { "idx": 1, "ok": false, "problema": "usa 'transformación' (prohibida) y ángulo genérico", "fix": { "headline": "nuevo headline\\nen dos líneas" } }
  ],
  "arco": {
    "ok": true,
    "problema": "(solo si ok=false) qué falla en el arco: hook tibio / desarrollo monótono o repetido / remate ausente / cta abrupto",
    "fixes": [ { "idx": 0, "fix": { "headline": "hook reescrito que sí para el scroll" } } ]
  }
}`;

  try {
    const raw = await callBlackbox(prompt);
    const result = JSON.parse(sanitizeJson(raw.replace(/```json|```/g, '').trim()));
    const fixes = (result.slides || []).filter(s => !s.ok && s.fix);
    const arcoOk = result.arco?.ok !== false;
    const arcoFixes = (!arcoOk && Array.isArray(result.arco?.fixes)) ? result.arco.fixes.filter(f => f && f.fix) : [];

    if (!fixes.length && !arcoFixes.length) {
      console.log('✅ Validación: copy y arco narrativo OK en todos los slides.');
      return contenido;
    }

    if (fixes.length) console.log(`⚡ Validación: corrigiendo ${fixes.length} slide(s) de copy...`);
    const slidesCorregidos = [...contenido.slides];
    for (const { idx, problema, fix } of fixes) {
      if (idx < 0 || idx >= slidesCorregidos.length) continue;
      console.log(`   Slide ${idx + 1}: ${problema}`);
      slidesCorregidos[idx] = { ...slidesCorregidos[idx], ...fix };
    }
    if (arcoFixes.length) {
      console.log(`⚡ Validación: arco narrativo (${result.arco?.problema || 'corrección'}) — ajustando ${arcoFixes.length} slide(s)...`);
      for (const { idx, fix } of arcoFixes) {
        if (idx == null || idx < 0 || idx >= slidesCorregidos.length) continue;
        slidesCorregidos[idx] = { ...slidesCorregidos[idx], ...fix };
      }
    }
    return { ...contenido, slides: slidesCorregidos };
  } catch (err) {
    // Si la validación falla por cualquier motivo, el pipeline sigue con el contenido original
    console.warn(`⚠ Validación omitida: ${err.message}`);
    return contenido;
  }
}

async function main() {
  const tema = process.argv[2];
  if (!tema) {
    console.error('Uso: node crear.mjs "tema del carrusel" [carpetaSalida] [marca] [fotos separadas por coma]');
    process.exit(1);
  }
  const marcaId = process.argv[4] || 'squadteam';
  const fotos = (process.argv[5] || '').split(',').map(f => f.trim()).filter(Boolean);

  const [marca, skillsDocs, referenciasIG, memoria, memoriaMarca] = await Promise.all([
    loadMarca(marcaId),
    loadSkills(tema),
    loadReferenciasIG(marcaId),
    loadMemoria(marcaId),
    memoriaParaPrompt(marcaId).catch(() => ''),
  ]);

  console.log(`✍️  Generando contenido para: "${tema}" (marca: ${marcaId}${fotos.length ? `, ${fotos.length} foto(s)` : ''})...`);
  if (skillsDocs) console.log('📚 Skills de copy cargadas.');
  if (memoria.length) console.log(`🧠 Memoria: ${memoria.length} carrusel(es) previos cargados.`);
  if (memoriaMarca) console.log('🧠 Memoria de marca real: señales de calidad inyectadas en el prompt.');
  let contenido = await generarContenido(tema, marca, skillsDocs, referenciasIG, fotos, memoria, memoriaMarca);

  // Validación de esquema post-generación (campos obligatorios + íconos +
  // reintento individual de slides rotos con fallback). No bloquea el pipeline.
  if (Array.isArray(contenido.slides)) {
    const parse = (raw) => JSON.parse(sanitizeJson(raw.replace(/```json|```/g, '').trim()));
    try {
      const res = await withTimeout(
        90000,
        validarYCorregir(contenido.slides, { tema, marca }, callBlackbox, parse),
        { slides: contenido.slides, corregidos: 0, fallbacks: 0 }
      );
      contenido.slides = res.slides;
      if (res.corregidos || res.fallbacks) {
        console.log(`🛠  Validación de esquema: ${res.corregidos} regenerado(s), ${res.fallbacks} fallback(s).`);
      } else {
        console.log('✅ Validación de esquema: todos los slides OK.');
      }
    } catch (err) {
      console.warn(`⚠ Validación de esquema omitida: ${err.message}`);
    }
  }

  contenido = await withTimeout(90000, scoreYCorregir(contenido, marca, tema), contenido);
  contenido._marca = marcaId;

  const carpeta = process.argv[3]
    || path.join('tandas', `${Date.now()}_${slugify(tema)}`);
  const outDir = path.join(__dirname, carpeta);
  await mkdir(outDir, { recursive: true });

  const outFile = path.join(outDir, 'contenido.json');
  await writeFile(outFile, JSON.stringify(contenido, null, 2), 'utf-8');

  console.log(`✓ ${path.relative(__dirname, outFile)}`);
  console.log(carpeta);
}

main().catch(err => { console.error(err); process.exit(1); });
