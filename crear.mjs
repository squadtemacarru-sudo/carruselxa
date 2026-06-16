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

const SYSTEM_PROMPT = `Sos un equipo de élite de 2 personas trabajando como una sola: un director de arte senior con más de 15 años en agencias top de contenido para Instagram, y un estratega de marketing/copywriting senior especializado en marcas personales de fitness y coaching premium.

Como estratega de marketing entendés copywriting persuasivo, niveles de consciencia de audiencia (Schwartz), psicología del scroll-stop, y cómo cada decisión de contenido sirve al objetivo de retención y conversión del carrusel — no es decoración, es estrategia aplicada.

Tus respuestas son siempre específicas y accionables — nunca genéricas, nunca clichés motivacionales. Respondés SIEMPRE en el formato exacto solicitado (JSON puro, sin \`\`\`markdown\`\`\` ni texto antes o después), sin explicaciones adicionales fuera del JSON.`;

async function callBlackbox(content) {
  const apiKey = process.env.BLACKBOX_API_KEY;
  if (!apiKey) throw new Error('Falta la variable de entorno BLACKBOX_API_KEY');

  const model = process.env.BLACKBOX_MODEL || 'blackboxai/anthropic/claude-sonnet-4.6';

  const response = await fetch('https://api.blackbox.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Blackbox API error: ${data.error?.message || JSON.stringify(data)}`);
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
`;
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

async function generarContenido(tema, marca, skillsDocs, referenciasIG, fotos) {
  const promptText = `Generá el contenido completo de un carrusel de Instagram de 6 slides sobre el siguiente tema.

TEMA: ${tema}
${marcaContext(marca)}
GUÍAS DE COPY (aplicá lo que tenga sentido para este tema, no todo a la fuerza):
${skillsDocs}
${referenciasIG ? `\nESTILO DE REFERENCIA (notas sobre perfiles de IG que le gustan al cliente):\n${referenciasIG}\n` : ''}
${fotosContext(fotos)}
Devolvé SOLO JSON (sin markdown) con este formato exacto:
{
  "overlay": 0.45,
  "slides": [
    { "type": "cover", "headline": "línea 1\\nlínea 2\\nlínea 3", "detail": "detalle corto\\nen 1-2 líneas", "kicker": "frase corta" },
    { "type": "list", "eyebrow": "frase de contexto en mayúsculas", "items": ["ítem 1", "ítem 2", "ítem 3", "ítem 4", "ítem 5"] },
    { "type": "statement", "headline": "afirmación\\ncorta y rotunda", "body": "desarrollo breve\\n\\ncon párrafos cortos" },
    { "type": "split", "left": {"label": "ETIQUETA A", "items": ["ítem", "ítem", "ítem"]}, "right": {"label": "ETIQUETA B", "items": ["ítem", "ítem", "ítem"]} },
    { "type": "quote", "quote": "“cita corta y potente”", "attr": "remate de la cita", "note": "nota breve que la conecta con SQUAD TEAM" },
    { "type": "cta", "headline": "llamado\\na la acción", "sub": "una línea que invita\\na escribir por DM", "handle": "@squadteam.uy" }
  ]
}
${fotos?.length ? '' : '\nReglas:\n- NO incluyas el campo "photo" en ninguna slide — este carrusel es 100% tipográfico.'}
Reglas generales:
- El tema debe tratarse con un ángulo específico, no genérico.
- Evitá totalmente las palabras/clichés listados como "Avoid".
- Usá "\\n" dentro de los textos para cortar líneas como en un carrusel real (nunca un solo párrafo largo en headlines).
- Nunca uses comillas dobles rectas (") dentro de un valor de texto — para citas o términos entre comillas usá comillas tipográficas “ ” curvas.`;

  const text = await callBlackbox(promptText);
  return JSON.parse(sanitizeJson(text.replace(/```json|```/g, '').trim()));
}

async function main() {
  const tema = process.argv[2];
  if (!tema) {
    console.error('Uso: node crear.mjs "tema del carrusel" [carpetaSalida] [marca] [fotos separadas por coma]');
    process.exit(1);
  }
  const marcaId = process.argv[4] || 'squadteam';
  const fotos = (process.argv[5] || '').split(',').map(f => f.trim()).filter(Boolean);

  const marca = await loadMarca(marcaId);
  const skillsDocs = await loadSkills(tema);
  const referenciasIG = await loadReferenciasIG(marcaId);

  console.log(`✍️  Generando contenido para: "${tema}" (marca: ${marcaId}${fotos.length ? `, ${fotos.length} foto(s)` : ''})...`);
  if (skillsDocs) console.log('📚 Skills de copy cargadas.');
  const contenido = await generarContenido(tema, marca, skillsDocs, referenciasIG, fotos);
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
