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

const USER_INSTRUCCIONES = process.env.USER_INSTRUCCIONES || '';
const USER_OVERLAY = process.env.USER_OVERLAY != null && process.env.USER_OVERLAY !== '' ? parseFloat(process.env.USER_OVERLAY) : null;

const SYSTEM_PROMPT = `Sos un equipo de élite de 2 personas trabajando como una sola: un director de arte senior con más de 15 años en agencias top de contenido para Instagram, y un estratega de marketing/copywriting senior especializado en marcas personales de fitness y coaching premium.

Como estratega de marketing entendés copywriting persuasivo, niveles de consciencia de audiencia (Schwartz), psicología del scroll-stop, y cómo cada decisión de contenido sirve al objetivo de retención y conversión del carrusel — no es decoración, es estrategia aplicada.

Tus respuestas son siempre específicas y accionables — nunca genéricas, nunca clichés motivacionales. Respondés SIEMPRE en el formato exacto solicitado (JSON puro, sin \`\`\`markdown\`\`\` ni texto antes o después), sin explicaciones adicionales fuera del JSON.`;

const FALLBACK_MODELS = [
  'blackboxai/anthropic/claude-sonnet-4.6',
  'blackboxai/anthropic/claude-sonnet-4.5',
  'claude-3-5-sonnet-20241022',
];

async function callBlackbox(content, attempt = 0) {
  const apiKey = process.env.BLACKBOX_API_KEY;
  if (!apiKey) throw new Error('Falta la variable de entorno BLACKBOX_API_KEY');

  const model = process.env.USER_MODEL || process.env.BLACKBOX_MODEL || FALLBACK_MODELS[Math.min(attempt, FALLBACK_MODELS.length - 1)];

  const response = await fetch('https://api.blackbox.ai/chat/completions', {
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
      const delay = [8000, 20000, 40000][attempt];
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
      const delay = [8000, 20000, 40000][attempt];
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
    const selectedNames = await selectSkills(tema, allSkills);
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

async function generarContenido(tema, marca, skillsDocs, referenciasIG, fotos, memoria) {
  const promptText = `Generá el contenido completo de un carrusel de Instagram de 6 slides sobre el siguiente tema.

TEMA: ${tema}
${marcaContext(marca)}
${memoriaContext(memoria)}GUÍAS DE COPY (aplicá lo que tenga sentido para este tema, no todo a la fuerza):
${skillsDocs}
${referenciasIG ? `\nESTILO DE REFERENCIA (notas sobre perfiles de IG que le gustan al cliente):\n${referenciasIG}\n` : ''}
${USER_INSTRUCCIONES ? `\nINSTRUCCIONES ESPECÍFICAS DEL USUARIO — PRIORIDAD MÁXIMA, seguí estas al pie de la letra:\n${USER_INSTRUCCIONES}\n` : ''}
${fotosContext(fotos)}
Devolvé SOLO JSON (sin markdown) con esta estructura:
{
  “overlay”: 0.45,
  “slides”: [ /* 6 slides, elegí los tipos que mejor sirvan al tema */ ]
}

TIPOS DE SLIDE disponibles — elegí el más adecuado para cada posición:

Tipos base (siempre disponibles):
- cover: portada. { “type”: “cover”, “headline”: “línea 1\\nlínea 2\\nlínea 3”, “detail”: “detalle corto\\nen 1-2 líneas”, “kicker”: “frase corta” }
- list: lista de ítems. { “type”: “list”, “eyebrow”: “frase de contexto en mayúsculas”, “items”: [“ítem 1”, “ítem 2”, “ítem 3”, “ítem 4”, “ítem 5”] }
- statement: afirmación desarrollada. { “type”: “statement”, “headline”: “afirmación\\ncorta y rotunda”, “body”: “desarrollo breve\\n\\ncon párrafos cortos” }
- split: dos columnas comparativas. { “type”: “split”, “left”: {“label”: “ETIQUETA A”, “items”: [“ítem”, “ítem”, “ítem”]}, “right”: {“label”: “ETIQUETA B”, “items”: [“ítem”, “ítem”, “ítem”]} }
- quote: cita o frase de autoridad. { “type”: “quote”, “quote”: “”cita corta y potente””, “attr”: “remate de la cita”, “note”: “nota breve que la conecta con la marca” }
- cta: llamado a la acción final. { “type”: “cta”, “headline”: “llamado\\na la acción”, “sub”: “una línea que invita\\na escribir por DM”, “handle”: “@squadteam.uy” }

Tipos de alto impacto visual — USÁ AL MENOS UNO cuando el tema lo permita:
- big_number: cuando el tema tiene un dato o estadística fuerte que habla por sí solo. { “type”: “big_number”, “stat”: “87%”, “label”: “DE LOS ATLETAS”, “body”: “una línea de contexto que explica el dato”, “handle”: “@marca” }
- timeline: cuando el tema explica un proceso, método o secuencia de pasos. { “type”: “timeline”, “eyebrow”: “EL PROCESO”, “headline”: “CÓMO\\nFUNCIONA”, “steps”: [{“num”:”01”,”text”:”primer paso”,”detail”:”detalle opcional”},{“num”:”02”,”text”:”segundo paso”},{“num”:”03”,”text”:”tercer paso”}] }
- grid: cuando el tema presenta 4 beneficios, pilares o conceptos paralelos. { “type”: “grid”, “headline”: “LO QUE\\nGANÁS”, “cells”: [{“icon”:”fitness_center”,”label”:”FUERZA”,”text”:”texto corto”},{“icon”:”psychology”,”label”:”ENFOQUE”,”text”:”texto corto”},{“icon”:”bolt”,”label”:”ENERGÍA”,”text”:”texto corto”},{“icon”:”trending_up”,”label”:”RESULTADO”,”text”:”texto corto”}] }
  IMPORTANTE: el campo “icon” del grid debe ser un nombre de Material Symbols (Google). Opciones: fitness_center, psychology, bolt, trending_up, restaurant, timer, water_drop, monitor_heart, nightlight, local_fire_department, sports, self_improvement, emoji_events, star, check_circle, rocket_launch, favorite, directions_run, speed, schedule, school, workspace_premium, shield, flag, groups, eco, nutrition, bedtime, mood, flash_on, whatshot

Regla de estructura: el slide 1 siempre es “cover”, el slide 6 siempre es “cta”. Los 4 del medio son libres — combiná tipos base y de alto impacto según lo que mejor cuente el tema.
${fotos?.length ? '' : '\nReglas:\n- NO incluyas el campo "photo" en ninguna slide — este carrusel es 100% tipográfico.'}
Reglas generales:
- El tema debe tratarse con un ángulo específico, no genérico.
- Evitá totalmente las palabras/clichés listados como “Avoid”.
- Usá “\\n” dentro de los textos para cortar líneas como en un carrusel real (nunca un solo párrafo largo en headlines).
- Nunca uses comillas dobles rectas (“) dentro de un valor de texto — para citas o términos entre comillas usá comillas tipográficas “ “ curvas.
`;

  const parse = (raw) => JSON.parse(sanitizeJson(raw.replace(/```json|```/g, '').trim()));

  let contenido;
  const text = await callBlackbox(promptText);
  contenido = parse(text);

  // Si la IA devolvió menos slides de lo pedido, reintentamos una vez
  if (!contenido.slides || contenido.slides.length < 5) {
    console.warn(`⚠ Solo ${contenido.slides?.length ?? 0} slides — reintentando...`);
    const text2 = await callBlackbox(promptText);
    const retry  = parse(text2);
    if ((retry.slides?.length ?? 0) > (contenido.slides?.length ?? 0)) contenido = retry;
  }

  if (USER_OVERLAY !== null && !isNaN(USER_OVERLAY)) contenido.overlay = USER_OVERLAY;
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
  const fotos = (process.argv[5] || '').split(',').map(f => f.trim()).filter(Boolean);

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
  contenido = await scoreYCorregir(contenido, marca, tema);
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
