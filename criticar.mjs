/**
 * criticar.mjs — Autocrítica visual post-render
 *
 * Lee el slide-01.png renderizado, lo manda a la IA y detecta problemas
 * de contraste, legibilidad o impacto. Si hay ajustes, los aplica al
 * contenido.analizado.json y escribe output/critique.json { changed: true }.
 *
 * El server.mjs lee critique.json y, si changed=true, re-corre generar.mjs.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function callVision(imageDataUrl) {
  const apiKey = process.env.BLACKBOX_API_KEY;
  if (!apiKey) return null;

  const prompt = `Sos director de arte senior especializado en Instagram. Analizá este slide de carrusel.

Evaluá SOLO estos 3 aspectos:
1. LEGIBILIDAD: ¿El texto principal es legible sobre el fondo? (sí/no)
2. IMPACTO: ¿El headline tiene suficiente tamaño/peso para detener el scroll en mobile? (sí/no)
3. OVERLAY: ¿La foto está tan oscura que pierde información, o tan clara que el texto no se lee?

Si TODO está bien → devolvé exactamente: null

Si hay un problema claro → devolvé SOLO este JSON:
{
  "problema": "descripción muy corta (ej: texto ilegible sobre foto clara)",
  "overlay_delta": 0.12,
  "headline_ajuste": "ok"
}

Reglas:
- overlay_delta: número entre -0.15 y 0.20 (positivo = más oscuro, negativo = más claro). 0 si no hay problema de contraste.
- headline_ajuste: "subir" | "bajar" | "ok"
- Solo devolvé ajuste si el problema es CLARO y OBVIO. Ante la duda, devolvé null.`;

  const res = await fetch('https://api.blackbox.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.BLACKBOX_MODEL || 'blackboxai/anthropic/claude-sonnet-4.6',
      max_tokens: 200,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' } },
        { type: 'text', text: prompt }
      ]}]
    })
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function main() {
  const contentFile = process.argv[2];
  if (!contentFile) return;

  const inputPath = path.join(__dirname, contentFile);
  const baseDir   = path.dirname(inputPath);
  const slide01   = path.join(baseDir, 'output', 'slide-01.png');
  const flagFile  = path.join(baseDir, 'output', 'critique.json');

  // Reset flag
  await writeFile(flagFile, JSON.stringify({ changed: false }), 'utf-8');

  let buf;
  try { buf = await readFile(slide01); } catch {
    console.log('  ⚠ Autocrítica: slide-01.png no encontrado, saltando');
    return;
  }

  // Achicar imagen para la API
  const resized = await sharp(buf).resize({ width: 540 }).jpeg({ quality: 75 }).toBuffer();
  const imageDataUrl = `data:image/jpeg;base64,${resized.toString('base64')}`;

  console.log('\n🔍 Autocrítica visual...');
  let raw;
  try { raw = await callVision(imageDataUrl); } catch (e) {
    console.log(`  ⚠ Autocrítica omitida: ${e.message}`);
    return;
  }

  if (!raw || raw === 'null' || !raw.includes('{')) {
    console.log('  ✓ Diseño aprobado');
    return;
  }

  let ajustes;
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    ajustes = JSON.parse(cleaned);
  } catch {
    console.log('  ✓ Diseño aprobado (respuesta no parseable)');
    return;
  }

  console.log(`  ⚠ Problema: ${ajustes.problema}`);

  const contenido = JSON.parse(await readFile(inputPath, 'utf-8'));
  let changed = false;

  if (ajustes.overlay_delta && Math.abs(ajustes.overlay_delta) > 0.04) {
    const delta = ajustes.overlay_delta;
    contenido.overlay = Math.max(0.2, Math.min(0.85, (contenido.overlay ?? 0.55) + delta));
    contenido.slides = contenido.slides.map(s => ({
      ...s,
      _overlay: s._overlay != null ? Math.max(0.2, Math.min(0.85, s._overlay + delta)) : undefined
    }));
    console.log(`  → Overlay ajustado (${delta > 0 ? '+' : ''}${delta})`);
    changed = true;
  }

  if (ajustes.headline_ajuste === 'subir') {
    contenido.slides = contenido.slides.map(s => ({ ...s, _headlineAjuste: 'normal' }));
    console.log('  → Headlines subidos');
    changed = true;
  } else if (ajustes.headline_ajuste === 'bajar') {
    contenido.slides = contenido.slides.map(s => ({
      ...s,
      _headlineAjuste: s._headlineAjuste === 'normal' ? 'small' : s._headlineAjuste
    }));
    console.log('  → Headlines bajados');
    changed = true;
  }

  if (changed) {
    await writeFile(inputPath, JSON.stringify(contenido, null, 2), 'utf-8');
    await writeFile(flagFile, JSON.stringify({ changed: true, ajustes }), 'utf-8');
    console.log('  → Ajustes aplicados — el server re-renderizará');
  } else {
    console.log('  ✓ Ajustes mínimos, no re-renderiza');
  }
}

main().catch(e => { console.error('criticar.mjs error:', e.message); });
