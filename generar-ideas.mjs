/**
 * generar-ideas.mjs — Laboratorio de carruseles
 *
 * Propone una SEMANA de ideas de carruseles para una marca, SIN renderizar nada.
 * Cada idea trae: tema, día sugerido, hook, plan completo de slides (editable),
 * y un "encargo de foto" (shot brief) si la IA decide que gana con foto.
 *
 * La IA mira los temas guardados + la memoria de marca para proponer temas
 * VARIADOS que no repitan lo ya hecho.
 *
 * Uso:
 *   node generar-ideas.mjs <marca> [cantidad] [carpetaSalida]
 *
 * Salida: un archivo JSON por idea en laboratorio/<marca>/<id>.json
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoriaParaPrompt } from './memoria.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DIAS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];

const SYSTEM_PROMPT = `Sos un director de contenido senior para Instagram. Tu trabajo es planificar una semana de carruseles variados para una marca: elegís los temas, el ángulo de cada uno, y decidís qué foto necesita el cliente sacar (o si el carrusel funciona 100% tipográfico).

Pensás como un estratega: variás los temas para que no se repita el mismo ángulo dos días seguidos, y aprovechás lo que ya funcionó sin repetir lo ya hecho.

FORMATO DE SALIDA — REGLA INQUEBRANTABLE: respondés ÚNICAMENTE con JSON puro válido. Sin markdown, sin comentarios, sin texto antes ni después. El primer carácter es { y el último es }.`;

const FALLBACK_MODELS = [
  'blackboxai/deepseek/deepseek-v4-pro',
  'blackboxai/x-ai/grok-4.1-fast-non-reasoning',
  'blackboxai/anthropic/claude-nemotron',
];

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
        inString = false; out += ch;
      } else { out += '\\"'; }
      continue;
    }
    if (inString && ch === '\n') { out += '\\n'; continue; }
    if (inString && ch === '\r') { out += '\\r'; continue; }
    if (inString && ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}

async function callBlackbox(content, attempt = 0) {
  const apiKey = process.env.BLACKBOX_API_KEY;
  if (!apiKey) throw new Error('Falta la variable de entorno BLACKBOX_API_KEY');
  const preferredModel = process.env.USER_MODEL || process.env.BLACKBOX_MODEL || '';
  const primaryModel = preferredModel || FALLBACK_MODELS[0];
  const modelPool = [
    primaryModel,
    primaryModel,
    ...FALLBACK_MODELS.filter(m => m !== primaryModel),
  ];
  const model = modelPool[Math.min(attempt, modelPool.length - 1)];

  let response;
  try {
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 90000);
    try {
      response = await fetch('https://api.blackbox.ai/v1/chat/completions', {
        signal: ac.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content },
          ],
        }),
      });
    } finally { clearTimeout(abortTimer); }
  } catch (netErr) {
    if (attempt < modelPool.length - 1) {
      const delay = [5000, 12000, 25000][attempt];
      console.warn(`⏳ Error de red Blackbox con ${model}: ${netErr.message} — probando fallback en ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return callBlackbox(content, attempt + 1);
    }
    throw netErr;
  }

  const rawText = await response.text();
  let data;
  try { data = JSON.parse(rawText); }
  catch {
    const preview = rawText.slice(0, 300).replace(/\n/g, ' ');
    if (attempt < modelPool.length - 1) {
      const delay = [5000, 12000, 25000][attempt];
      console.warn(`⏳ Respuesta no-JSON de Blackbox con ${model} (status ${response.status}) — probando fallback...`);
      await new Promise(r => setTimeout(r, delay));
      return callBlackbox(content, attempt + 1);
    }
    throw new Error(`Blackbox devolvió HTML/no-JSON (status ${response.status}): ${preview}`);
  }

  if (!response.ok) {
    const body = JSON.stringify(data);
    const is429 = response.status === 429 || body.includes('RESOURCE_EXHAUSTED') || body.includes('429');
    if ((is429 || response.status >= 400) && attempt < modelPool.length - 1) {
      const delay = [5000, 12000, 25000][attempt];
      console.warn(`⏳ Blackbox ${response.status} con ${model} — probando fallback...`);
      await new Promise(r => setTimeout(r, delay));
      return callBlackbox(content, attempt + 1);
    }
    throw new Error(`Blackbox API error: ${data.error?.message || body}`);
  }
  const output = data.choices?.[0]?.message?.content || '';
  if (!output.trim() && attempt < modelPool.length - 1) {
    console.warn(`⏳ Blackbox devolvió contenido vacío con ${model} — probando fallback...`);
    return callBlackbox(content, attempt + 1);
  }
  return output;
}

function parseJson(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(sanitizeJson(cleaned)); }
  catch {
    const norm = cleaned.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    return JSON.parse(sanitizeJson(norm));
  }
}

async function loadMarca(marcaId) {
  try { return JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'marca.json'), 'utf-8')); }
  catch { return null; }
}

async function loadTemas(marcaId) {
  try { return JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'temas.json'), 'utf-8')); }
  catch { return []; }
}

// Temas ya usados recientemente (para no repetir) — leídos de las carpetas de tandas
async function loadTemasRecientes(marcaId, limite = 20) {
  try {
    const tandasDir = path.join(__dirname, 'tandas');
    const entries = await readdir(tandasDir, { withFileTypes: true });
    const carpetas = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse().slice(0, limite);
    const temas = [];
    for (const c of carpetas) {
      try {
        const raw = await readFile(path.join(tandasDir, c, 'contenido.json'), 'utf-8');
        const j = JSON.parse(raw);
        if (j._marca && j._marca !== marcaId) continue;
        temas.push(c.replace(/^\d+_/, '').replace(/-/g, ' '));
      } catch {}
    }
    return temas;
  } catch { return []; }
}

function marcaContext(marca) {
  if (!marca) return '';
  return `
CONTEXTO DE MARCA:
- Marca: ${marca.nombre} — ${marca.industria}
- Producto: ${marca.producto}
- Audiencia: ${marca.audiencia}
- Voz y tono: ${marca.voz}
- Palabras/clichés a evitar: ${marca.evitar?.join(', ') || '—'}`;
}

function slugify(str) {
  return String(str).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
}

async function main() {
  const marcaId = process.argv[2] || 'personal';
  const cantidad = Math.max(1, Math.min(7, parseInt(process.argv[3], 10) || 5));
  const carpetaArg = process.argv[4] || path.join('laboratorio', marcaId);

  const [marca, temas, recientes, memoriaMarca] = await Promise.all([
    loadMarca(marcaId),
    loadTemas(marcaId),
    loadTemasRecientes(marcaId),
    memoriaParaPrompt(marcaId).catch(() => ''),
  ]);

  console.log(`🧪 Generando ${cantidad} idea(s) de carrusel para la semana (marca: ${marcaId})...`);

  const prompt = `Planificá ${cantidad} ideas de carrusel de Instagram para la próxima semana de esta marca.
${marcaContext(marca)}

${temas.length ? `TEMAS QUE LE INTERESAN A LA MARCA (usalos como punto de partida, no es obligatorio cubrirlos todos):\n${temas.map(t => `- ${t}`).join('\n')}\n` : ''}
${recientes.length ? `TEMAS YA PUBLICADOS RECIENTEMENTE — NO los repitas ni uses el mismo ángulo:\n${recientes.map(t => `- ${t}`).join('\n')}\n` : ''}
${memoriaMarca ? `\nSEÑALES DE LO QUE FUNCIONÓ (aprovechá estos ángulos sin repetir el tema exacto):\n${memoriaMarca}\n` : ''}

Para cada idea decidí:
1. Un TEMA y ÁNGULO específico (nunca genérico).
2. El DÍA de la semana sugerido (lun, mar, mie, jue, vie, sab, dom) — repartí para que no caiga el mismo tipo de tema dos días seguidos.
3. El HOOK del cover (el titular que para el scroll).
4. Si el carrusel GANA con una foto real del cliente o si funciona 100% tipográfico. Mezclá: algunos con foto, otros tipográficos.
5. Si necesita foto: un ENCARGO DE FOTO claro y accionable — qué mostrar, dónde se saca (gym, comida, calle, casa, paisaje, etc.), y un tip de cómo que mejore la foto.
6. Un PLAN de 6 slides: para cada slide el tipo y una idea corta de su contenido.

TIPOS DE SLIDE válidos: cover, statement, list, quote, cta, big_number, grid_stats, timeline, steps, comparison, grid, icon_list, split. El slide 1 siempre es cover y el 6 siempre cta.

Devolvé SOLO JSON con esta estructura exacta:
{
  "ideas": [
    {
      "tema": "tema y ángulo específico",
      "dia": "lun",
      "hook": "titular del cover",
      "necesita_foto": true,
      "shot": { "que": "qué mostrar en la foto", "donde": "gym", "tip": "tip corto de cómo sacarla" },
      "plan": [
        { "position": 1, "type": "cover", "title": "idea del cover", "notes": "" },
        { "position": 2, "type": "statement", "title": "idea del slide", "notes": "" }
      ]
    }
  ]
}

Si una idea es tipográfica, poné "necesita_foto": false y omití "shot". Generá EXACTAMENTE ${cantidad} ideas.`;

  let parsed, lastErr;
  for (let intento = 1; intento <= 2; intento++) {
    try { parsed = parseJson(await callBlackbox(prompt)); break; }
    catch (e) { lastErr = e; console.warn(`⚠ Respuesta no parseable (intento ${intento}/2): ${e.message}`); }
  }
  if (!parsed?.ideas?.length) throw new Error(`La IA no devolvió ideas válidas: ${lastErr?.message || 'sin ideas'}`);

  const outDir = path.join(__dirname, carpetaArg);
  await mkdir(outDir, { recursive: true });

  const creados = [];
  let i = 0;
  for (const idea of parsed.ideas) {
    if (!idea || !idea.tema) continue;
    const ts = Date.now() + (i++); // ids únicos sin Math.random
    const id = `${ts}_${slugify(idea.tema)}`;
    const necesitaFoto = idea.necesita_foto !== false && !!idea.shot;
    const registro = {
      id,
      marca: marcaId,
      tema: idea.tema,
      dia: DIAS.includes(idea.dia) ? idea.dia : DIAS[i % 7],
      hook: idea.hook || '',
      necesita_foto: necesitaFoto,
      shot: necesitaFoto ? {
        que: idea.shot?.que || '',
        donde: idea.shot?.donde || '',
        tip: idea.shot?.tip || '',
      } : null,
      plan: Array.isArray(idea.plan) ? idea.plan.map((s, idx) => ({
        position: s.position || idx + 1,
        type: s.type || 'statement',
        title: s.title || '',
        notes: s.notes || '',
      })) : [],
      estado: 'borrador', // borrador → aprobada → generada
      foto: null,
      creado: new Date().toISOString(),
    };
    await writeFile(path.join(outDir, `${id}.json`), JSON.stringify(registro, null, 2), 'utf-8');
    creados.push(id);
    console.log(`  💡 ${idea.dia || '—'} · ${idea.tema} ${necesitaFoto ? `📷 ${idea.shot?.donde || ''}` : '✍️ tipográfica'}`);
  }

  console.log(`✓ ${creados.length} idea(s) guardada(s) en ${carpetaArg}`);
}

main().catch(err => { console.error(err); process.exit(1); });
