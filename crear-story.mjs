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

const SYSTEM_PROMPT = `Sos un equipo de élite de 2 personas trabajando como una sola: un director de arte senior con más de 15 años en agencias top de contenido para Instagram, y un estratega de marketing/copywriting senior especializado en marcas personales de fitness y coaching premium.

Como estratega de marketing entendés copywriting persuasivo, niveles de consciencia de audiencia (Schwartz), psicología del scroll-stop, y cómo cada decisión de contenido sirve al objetivo de retención y conversión del carrusel — no es decoración, es estrategia aplicada.

Tus respuestas son siempre específicas y accionables — nunca genéricas, nunca clichés motivacionales. Respondés SIEMPRE en el formato exacto solicitado (JSON puro, sin \`\`\`markdown\`\`\` ni texto antes o después), sin explicaciones adicionales fuera del JSON.`;

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
      const delay = [3000, 8000, 15000][attempt];
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
FOTOS DISPONIBLES (copiá el valor exacto, puede ser URL https:// o nombre de archivo). No repitas una foto en más de un slide:
${fotos.map(f => `- ${f}`).join('\n')}

Las stories pueden ser tipográficas o con foto — mezclá según lo que mejor cuente el tema. Usá fotos en estos tipos:
- { "type": "full_impact", "photo": "<archivo>", "line1": "línea corta de contexto", "line2": "HEADLINE\\nIMPACTO", "footer_text": "frase breve" }
- { "type": "before_after", "photo_before": "<archivo>", "photo_after": "<archivo>", "label_before": "ANTES", "label_after": "DESPUÉS", "headline": "resultado en pocas palabras", "sub": "una línea" }
- { "type": "cover", "photo": "<archivo>", "headline": "titular\\ncorto", "kicker": "frase de apoyo" } — foto como fondo del cover
- cualquier slide clásica (statement/quote/cta) puede llevar "photo": "<archivo>" como fondo con overlay.

Las slides SIN foto van sin campo "photo" y son 100% tipográficas — ambas opciones son válidas en la misma story.`;
}

async function generarContenido(tema, marca, skillsDocs, referenciasIG, fotos, memoria) {
  const slideCount = USER_PLAN.length || 4;
  const promptText = `Generá el contenido de una STORY de Instagram de ${slideCount} slides sobre el siguiente tema.

FORMATO: Story de Instagram (9:16, vertical). Cada slide se ve ~2-3 segundos. Texto MÍNIMO.
REGLAS DE STORY:
- ${slideCount} slides en total
- Cada slide tipográfico: UN headline corto (máximo 5 palabras) + opcionalmente UNA línea de cuerpo (máximo 8 palabras)
- Los slides con foto pueden tener menos texto — la imagen habla sola
- Sin listas largas. Sin items. Sin párrafos.
- Visual primero: el tipo “statement” y “cover” son los mejores para stories
- El slide 1 es el hook — tiene que detener el scroll en 0.5 segundos
- El último slide siempre termina con CTA directo y el handle de la marca

TEMA: ${tema}
${marcaContext(marca)}
${referenciasIG ? `\nESTILO DE REFERENCIA:\n${referenciasIG}\n` : ''}
${USER_ESTILO_ID && ESTILOS_HINTS[USER_ESTILO_ID] ? `\nESTILO VISUAL: ${ESTILOS_HINTS[USER_ESTILO_ID]}\n` : ''}
${USER_FUENTE_ID && FUENTES_HINTS[USER_FUENTE_ID] ? `\nTIPOGRAFÍA — usá EXACTAMENTE en _sistema.tipografia:\n- Display/Titular: “${FUENTES_HINTS[USER_FUENTE_ID].display}”\n- Cuerpo: “${FUENTES_HINTS[USER_FUENTE_ID].body}”\n- URL: “${FUENTES_HINTS[USER_FUENTE_ID].url}”\n` : ''}${USER_PALETA_ID && PALETAS_HINTS[USER_PALETA_ID] ? `\nPALETA — usá EXACTAMENTE en _sistema.paleta:\n- Fondo: “${PALETAS_HINTS[USER_PALETA_ID].fondo}”\n- Acento: “${PALETAS_HINTS[USER_PALETA_ID].acento}”\n- Texto: “${PALETAS_HINTS[USER_PALETA_ID].texto}”\n` : ''}
${USER_INSTRUCCIONES ? `\nINSTRUCCIONES DEL USUARIO — PRIORIDAD MÁXIMA:\n${USER_INSTRUCCIONES}\n` : ''}
${fotosContext(fotos)}
Devolvé SOLO JSON (sin markdown):
{
  “overlay”: 0.55,
  “slides”: [ /* EXACTAMENTE ${slideCount} slides */ ]
}

TIPOS DE SLIDE disponibles — elegí el más adecuado para cada posición:

Tipos base (siempre disponibles):
- cover: portada. Dos formatos posibles:
  a) Formato clásico: { “type”: “cover”, “headline”: “línea 1\\nlínea 2\\nlínea 3”, “detail”: “detalle corto”, “kicker”: “frase corta” }
  b) Formato hero multi-línea (PREFERIDO para temas con dato o número fuerte): { “type”: “cover”, “_layout”: “cover-impact”, “headline_lines”: [{“text”:”TEXTO CONECTOR”,”size”:”connector”,”color”:”#ffffff”},{“text”:”EL DATO”,”size”:”hero”,”color”:”#e8000d”,”stroke”:true},{“text”:”OTRO CONECTOR”,”size”:”connector”,”color”:”#ffffff”},{“text”:”IMPACTO”,”size”:”hero”,”color”:”#e8000d”}] }
     Tamaños de línea: “hero” = enorme (el dato/número), “md” = mediano, “connector” = pequeño conector
     stroke:true agrega subrayado decorativo debajo de esa línea
- list: lista de ítems. { “type”: “list”, “eyebrow”: “frase de contexto en mayúsculas”, “items”: [“ítem 1”, “ítem 2”, “ítem 3”, “ítem 4”, “ítem 5”] }
- statement: afirmación desarrollada. { “type”: “statement”, “headline”: “afirmación\\ncorta y rotunda”, “body”: “desarrollo breve\\n\\ncon párrafos cortos” }
- split: dos columnas comparativas. { “type”: “split”, “left”: {“label”: “ETIQUETA A”, “items”: [“ítem”, “ítem”, “ítem”]}, “right”: {“label”: “ETIQUETA B”, “items”: [“ítem”, “ítem”, “ítem”]} }
- quote: cita o frase de autoridad. { “type”: “quote”, “quote”: “”cita corta y potente””, “attr”: “remate de la cita”, “note”: “nota breve que la conecta con la marca” }
- cta: llamado a la acción final. { “type”: “cta”, “headline”: “llamado\\na la acción”, “sub”: “una línea que invita\\na escribir por DM”, “handle”: “${USER_HANDLE || '@tumarca'}” }

Tipos de alto impacto visual — USÁ AL MENOS UNO cuando el tema lo permita:
- big_number: cuando el tema tiene un dato o estadística fuerte que habla por sí solo. { “type”: “big_number”, “stat”: “87%”, “label”: “DE LOS ATLETAS”, “body”: “una línea de contexto que explica el dato”, “handle”: “@marca” }
- timeline: cuando el tema explica un proceso, método o secuencia de pasos. { “type”: “timeline”, “eyebrow”: “EL PROCESO”, “headline”: “CÓMO\\nFUNCIONA”, “steps”: [{“num”:”01”,”text”:”primer paso”,”detail”:”detalle opcional”},{“num”:”02”,”text”:”segundo paso”},{“num”:”03”,”text”:”tercer paso”}] }
- grid: cuando el tema presenta 4 beneficios, pilares o conceptos paralelos. { “type”: “grid”, “headline”: “LO QUE\\nGANÁS”, “cells”: [{“icon”:”fitness_center”,”label”:”FUERZA”,”text”:”texto corto”},{“icon”:”psychology”,”label”:”ENFOQUE”,”text”:”texto corto”},{“icon”:”bolt”,”label”:”ENERGÍA”,”text”:”texto corto”},{“icon”:”trending_up”,”label”:”RESULTADO”,”text”:”texto corto”}] }
  IMPORTANTE: el campo “icon” del grid debe ser un nombre de Material Symbols (Google). Opciones: fitness_center, psychology, bolt, trending_up, restaurant, timer, water_drop, monitor_heart, nightlight, local_fire_department, sports, self_improvement, emoji_events, star, check_circle, rocket_launch, favorite, directions_run, speed, schedule, school, workspace_premium, shield, flag, groups, eco, nutrition, bedtime, mood, flash_on, whatshot

${USER_PLAN.length ? `PLAN ACORDADO CON EL USUARIO — seguí EXACTAMENTE esta estructura (respetá tipos y orden, ajustá el copy):
${USER_PLAN.map(s => `  Slide ${s.position}: [${s.type}] ${s.title}${s.notes ? ` — ${s.notes}` : ''}`).join('\n')}
El JSON debe tener EXACTAMENTE ${USER_PLAN.length} slides en ese orden.` : `Regla de estructura: slide 1 siempre “cover”, slide 4 siempre “cta”. Los del medio son libres.`}
${fotos?.length ? '' : '\nReglas:\n- NO incluyas el campo "photo" en ninguna slide — este carrusel es 100% tipográfico.'}
Reglas generales:
- El tema debe tratarse con un ángulo específico, no genérico.
- Evitá totalmente las palabras/clichés listados como “Avoid”.
- Usá “\\n” dentro de los textos para cortar líneas como en un carrusel real (nunca un solo párrafo largo en headlines).
- Nunca uses comillas dobles rectas (“) dentro de un valor de texto — para citas o términos entre comillas usá comillas tipográficas “ “ curvas.
- En cualquier campo de texto podés usar [texto]{#hex} para colorear palabras clave en el color de acento, y [texto]{bg:#hex} para poner una caja de fondo de color detrás de una palabra (ej: “Nadie me regaló [nada,]{bg:#00cc00} tú tampoco.”). Usalo con criterio — máximo 1-2 palabras destacadas por slide.
`;

  const parse = (raw) => JSON.parse(sanitizeJson(raw.replace(/```json|```/g, '').trim()));

  let contenido;
  const text = await callBlackbox(promptText);
  contenido = parse(text);

  // Si la IA devolvió menos slides de lo pedido, reintentamos una vez
  if (!contenido.slides || contenido.slides.length < Math.max(2, slideCount - 1)) {
    console.warn(`⚠ Solo ${contenido.slides?.length ?? 0} slides — reintentando...`);
    const text2 = await callBlackbox(promptText);
    const retry  = parse(text2);
    if ((retry.slides?.length ?? 0) > (contenido.slides?.length ?? 0)) contenido = retry;
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

  const prompt = `Sos un editor de copy senior. Evaluá este carrusel de Instagram y corregí los slides que fallen.

TEMA: ${tema}
VOZ DE MARCA: ${marca.voz}
POSICIONAMIENTO: ${marca.posicionamiento}
${evitar ? `PALABRAS PROHIBIDAS (no deben aparecer en ningún slide): ${evitar}` : ''}

SLIDES GENERADOS:
${slidesResumen}

Para cada slide, asigná:
- "ok": true si el copy es específico, respeta la voz y no usa palabras prohibidas. false si falla en algo.
- "problema": (solo si ok=false) qué falla en una línea: genérico / cliché / voz incorrecta / otro.
- "fix": (solo si ok=false) reescribí SOLO el campo o campos que fallan, en el mismo formato JSON del slide original. Mantenés el type y todos los campos que no cambian.

Devolvé SOLO JSON (sin markdown):
{
  "slides": [
    { "idx": 0, "ok": true },
    { "idx": 1, "ok": false, "problema": "usa 'transformación' (prohibida) y ángulo genérico", "fix": { "headline": "nuevo headline\\nen dos líneas" } },
    ...
  ]
}`;

  try {
    const raw = await callBlackbox(prompt);
    const result = JSON.parse(sanitizeJson(raw.replace(/```json|```/g, '').trim()));
    const fixes = (result.slides || []).filter(s => !s.ok && s.fix);

    if (!fixes.length) {
      console.log('✅ Validación: copy OK en todos los slides.');
      return contenido;
    }

    console.log(`⚡ Validación: corrigiendo ${fixes.length} slide(s)...`);
    const slidesCorregidos = [...contenido.slides];
    for (const { idx, problema, fix } of fixes) {
      if (idx < 0 || idx >= slidesCorregidos.length) continue;
      console.log(`   Slide ${idx + 1}: ${problema}`);
      slidesCorregidos[idx] = { ...slidesCorregidos[idx], ...fix };
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
  const fotos = (process.argv[5] || process.env.USER_FOTOS || '').split(',').map(f => f.trim()).filter(Boolean);

  const [marca, skillsDocs, referenciasIG, memoria] = await Promise.all([
    loadMarca(marcaId),
    loadSkills(tema),
    loadReferenciasIG(marcaId),
    loadMemoria(marcaId),
  ]);

  console.log(`✍️  Generando contenido para: "${tema}" (marca: ${marcaId}${fotos.length ? `, ${fotos.length} foto(s)` : ''})...`);
  if (skillsDocs) console.log('📚 Skills de copy cargadas.');
  if (memoria.length) console.log(`🧠 Memoria: ${memoria.length} carrusel(es) previos cargados.`);
  let contenido = await generarContenido(tema, marca, skillsDocs, referenciasIG, fotos, memoria);
  contenido = await withTimeout(20000, scoreYCorregir(contenido, marca, tema), contenido);
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
