/**
 * probar-modelos.mjs — benchmark liviano de modelos Blackbox para la app.
 *
 * Uso:
 *   BLACKBOX_API_KEY=... node probar-modelos.mjs
 *   BLACKBOX_API_KEY=... node probar-modelos.mjs "tema personalizado"
 *
 * No guarda respuestas completas ni imprime la key. Mide:
 * - disponibilidad del modelo
 * - tiempo de respuesta
 * - si devuelve JSON parseable
 * - si respeta una estructura mínima de carrusel
 */

const API_URL = 'https://api.blackbox.ai/v1';

const CANDIDATOS_PREFERIDOS = [
  'blackboxai/openai/gpt-5.5',
  'blackboxai/openai/gpt-5.4',
  'blackboxai/openai/gpt-5.4-pro',
  'blackboxai/anthropic/claude-nemotron',
  'blackboxai/deepseek/deepseek-v4-pro',
  'blackboxai/deepseek/deepseek-v4-flash',
  'blackboxai/google/gemini-3.1-flash-lite',
  'blackboxai/x-ai/grok-4.1-fast-non-reasoning',
];

const tema = process.argv.slice(2).join(' ').trim()
  || 'por qué una marca local pierde ventas aunque tenga buen producto';

const apiKey = process.env.BLACKBOX_API_KEY;
if (!apiKey) {
  console.error('Falta BLACKBOX_API_KEY. Seteala en el entorno antes de correr este script.');
  process.exit(1);
}

function sanitizeJson(text) {
  return text
    .replace(/```json|```/g, '')
    .trim()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function wordCount(value) {
  if (typeof value === 'string') return value.trim().split(/\s+/).filter(Boolean).length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + wordCount(item), 0);
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([key]) => !['type', 'icon'].includes(key))
      .reduce((sum, [, item]) => sum + wordCount(item), 0);
  }
  return 0;
}

function scoreRespuesta(parsed, ms) {
  const slides = Array.isArray(parsed?.slides) ? parsed.slides : [];
  let score = 0;
  const reasons = [];

  if (slides.length === 6) { score += 15; reasons.push('6 slides'); }
  else if (slides.length >= 5) { score += 8; reasons.push(`${slides.length} slides`); }

  if (slides[0]?.type === 'cover') { score += 10; reasons.push('cover inicial'); }
  if (slides.at(-1)?.type === 'cta') { score += 10; reasons.push('cta final'); }

  const types = slides.map(s => s?.type).filter(Boolean);
  const uniqueTypes = new Set(types);
  score += Math.min(uniqueTypes.size * 3, 12);
  if (uniqueTypes.size >= 4) reasons.push('variedad');

  const text = JSON.stringify(parsed).toLowerCase();
  const generico = ['transforma tu vida', 'al siguiente nivel', 'desbloquea tu potencial', 'éxito garantizado'];
  const genericHits = generico.filter(w => text.includes(w));
  if (!genericHits.length) { score += 10; reasons.push('sin clichés obvios'); }
  else score -= genericHits.length * 5;

  const development = slides.slice(1, -1);
  const denseSlides = development.filter(slide => {
    const hasStructuredDepth = ['items', 'steps', 'rows', 'cells']
      .some(key => Array.isArray(slide?.[key]) && slide[key].length >= 4 && wordCount(slide[key]) >= 30);
    return hasStructuredDepth || wordCount(slide) >= 38;
  });
  if (development.length) {
    score += Math.round(30 * denseSlides.length / development.length);
    reasons.push(`${denseSlides.length}/${development.length} slides con sustancia`);
  }

  const actionPattern = /\b(creá|definí|revisá|medí|probá|cambiá|usá|evitá|hacé|pedí|mostrá|anotá|compará)\b/i;
  const mechanismPattern = /\b(porque|cuando|si|provoca|genera|consecuencia|por eso|hace que)\b/i;
  const actionable = development.filter(slide => actionPattern.test(JSON.stringify(slide))).length;
  const explanatory = development.filter(slide => mechanismPattern.test(JSON.stringify(slide))).length;
  score += Math.round(10 * actionable / Math.max(development.length, 1));
  score += Math.round(10 * explanatory / Math.max(development.length, 1));
  if (actionable >= 3) reasons.push('acciones concretas');
  if (explanatory >= 3) reasons.push('explica mecanismos');

  if (ms < 8000) score += 3;
  else if (ms > 35000) score -= 3;

  return { score, reasons };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { res, text, data };
}

async function modelosDisponibles() {
  const { res, data, text } = await fetchJson(`${API_URL}/models`, { method: 'GET' });
  if (!res.ok) throw new Error(`No pude leer modelos (${res.status}): ${text.slice(0, 160)}`);
  const ids = new Set((data?.data || []).map(m => m.id));
  return CANDIDATOS_PREFERIDOS.filter(id => ids.has(id));
}

async function probarModelo(model) {
  const prompt = `Respondé SOLO JSON válido. Generá un mini carrusel de Instagram de 6 slides para este tema:
"${tema}"

Requisitos:
- slide 1 type cover
- slide 6 type cta
- variedad de types entre slides 2-5
- copy concreto, cero frases genéricas
- campos simples: type, headline, body/sub/items según corresponda

Formato exacto:
{
  "slides": [
    { "type": "cover", "headline": "..." },
    { "type": "statement", "headline": "...", "body": "..." },
    { "type": "list", "eyebrow": "...", "items": ["...", "...", "..."] },
    { "type": "comparison", "title": "...", "col_a": "...", "col_b": "...", "rows": [{ "label": "...", "a": "...", "b": "..." }] },
    { "type": "quote", "quote": "...", "attr": "..." },
    { "type": "cta", "headline": "...", "sub": "..." }
  ]
}`;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const { res, data, text } = await fetchJson(`${API_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 1800,
        messages: [
          { role: 'system', content: 'Sos un estratega senior de contenido. Devolvés solo JSON válido.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const ms = Date.now() - started;
    if (!res.ok) return { model, ok: false, ms, error: `HTTP ${res.status}`, preview: text.slice(0, 120) };

    const content = data?.choices?.[0]?.message?.content || '';
    if (!content.trim()) return { model, ok: false, ms, error: 'respuesta vacía' };

    let parsed;
    try { parsed = JSON.parse(sanitizeJson(content)); }
    catch (err) { return { model, ok: false, ms, error: `JSON inválido: ${err.message}`, preview: content.slice(0, 120) }; }

    const { score, reasons } = scoreRespuesta(parsed, ms);
    return {
      model,
      ok: true,
      ms,
      score,
      reasons,
      slides: parsed.slides?.length || 0,
      firstHeadline: parsed.slides?.[0]?.headline || '',
    };
  } catch (err) {
    return { model, ok: false, ms: Date.now() - started, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`Tema de prueba: ${tema}`);
  const modelos = await modelosDisponibles();
  if (!modelos.length) throw new Error('Ningún candidato preferido aparece en /v1/models.');

  console.log(`Modelos a probar: ${modelos.join(', ')}`);
  const resultados = [];
  for (const model of modelos) {
    process.stdout.write(`Probando ${model}... `);
    const r = await probarModelo(model);
    resultados.push(r);
    console.log(r.ok ? `OK score=${r.score} ${r.ms}ms` : `FAIL ${r.error} ${r.ms}ms`);
  }

  const ordenados = resultados
    .filter(r => r.ok)
    .sort((a, b) => b.score - a.score || a.ms - b.ms);

  console.log('\nResultados:');
  for (const r of resultados) {
    if (!r.ok) {
      console.log(`- ${r.model}: FAIL (${r.error})`);
      continue;
    }
    console.log(`- ${r.model}: score ${r.score}, ${r.ms}ms, ${r.slides} slides, ${r.reasons.join(', ')}`);
  }

  if (ordenados[0]) {
    console.log(`\nRecomendado para BLACKBOX_MODEL: ${ordenados[0].model}`);
    console.log(`Hook de muestra: ${String(ordenados[0].firstHeadline).replace(/\n/g, ' / ')}`);
  } else {
    process.exitCode = 1;
    console.log('\nNingún modelo pasó la prueba.');
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
