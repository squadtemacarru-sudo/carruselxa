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

Evaluá estos 4 aspectos:
1. LEGIBILIDAD: ¿El texto principal es legible sobre el fondo?
2. IMPACTO: ¿El headline tiene suficiente tamaño/peso para detener el scroll en mobile?
3. OVERLAY: ¿La foto está tan oscura que perdió información visual importante, o tan clara que el texto no se lee?
4. TEXTO SOBRE PERSONA: ¿El bloque de texto (headline, párrafo) tapa la cara, torso, o zona central del sujeto principal de la foto?

Si TODO está bien → devolvé exactamente: null

Si hay un problema CLARO → devolvé SOLO este JSON:
{
  "problema": "descripción muy corta del problema más grave",
  "overlay_delta": 0.0,
  "headline_ajuste": "ok",
  "text_y_nuevo": null
}

Reglas estrictas:
- overlay_delta: entre -0.20 y 0.15. Positivo = más oscuro (si texto ilegible). Negativo = aclarar (si foto destruida, muy oscura). 0 si el contraste está bien.
- headline_ajuste: "subir" | "bajar" | "ok"
- text_y_nuevo: si el texto tapa la cara/cuerpo del sujeto → el % vertical (0-100) donde debería ir el TOPE del bloque de texto para no taparlo. Ejemplo: 75 = texto en zona inferior (sujeto arriba), 8 = texto en zona superior (sujeto abajo). Si no hay persona en la foto o el texto ya está bien posicionado → null.
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

async function callVisionCoherencia(imageDataUrls) {
  const apiKey = process.env.BLACKBOX_API_KEY;
  if (!apiKey || !imageDataUrls.length) return null;

  const prompt = `Sos director de arte senior. Estás viendo los ${imageDataUrls.length} slides de un carrusel de Instagram en orden.

Analizá la coherencia visual entre slides y detectá estos problemas específicos:
1. FONDOS REPETIDOS: ¿Hay 3 o más slides consecutivos con el mismo tono de fondo (todos muy oscuros, todos muy claros, o todos del mismo color dominante)?
2. SLIDE VACÍO O SOBRECARGADO: ¿Algún slide parece visualmente vacío o demasiado denso comparado con los demás?
3. PESO VISUAL BRUSCO: ¿Hay un salto demasiado brusco de peso visual entre slides adyacentes (ej: slide muy cargado seguido de uno casi vacío)?

Si TODO está bien → devolvé exactamente: { "ok": true }

Si hay un problema CLARO → devolvé SOLO este JSON:
{
  "ok": false,
  "problemas": [
    { "slides": [1,2,3], "tipo": "fondos_repetidos", "sugerencia": "variar paleta en slides 2-3" }
  ]
}

Reglas:
- Los slides están numerados desde 1.
- Solo reportá problemas CLAROS y OBVIOS. Ante la duda → { "ok": true }
- No reportes problemas de texto, legibilidad ni composición individual — solo coherencia entre slides.`;

  const imageContent = imageDataUrls.map(url => ({
    type: 'image_url',
    image_url: { url, detail: 'low' }
  }));

  const res = await fetch('https://api.blackbox.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.BLACKBOX_MODEL || 'blackboxai/anthropic/claude-sonnet-4.6',
      max_tokens: 300,
      messages: [{ role: 'user', content: [
        ...imageContent,
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
  const outDir    = path.join(baseDir, 'output');
  const flagFile  = path.join(outDir, 'critique.json');

  await writeFile(flagFile, JSON.stringify({ changed: false }), 'utf-8');

  const contenido = JSON.parse(await readFile(inputPath, 'utf-8'));
  const total = contenido.slides?.length || 0;
  if (!total) return;

  console.log('\n🔍 Autocrítica visual por slide...');

  let anyChanged = false;
  const fixedSlides = [];

  for (let i = 0; i < total; i++) {
    const slideFile = path.join(outDir, `slide-0${i + 1}.png`);
    let buf;
    try { buf = await readFile(slideFile); } catch { continue; }

    const resized = await sharp(buf).resize({ width: 540 }).jpeg({ quality: 75 }).toBuffer();
    const imageDataUrl = `data:image/jpeg;base64,${resized.toString('base64')}`;

    let raw;
    try { raw = await callVision(imageDataUrl); } catch (e) {
      console.log(`  ⚠ Slide ${i + 1}: autocrítica omitida (${e.message})`);
      continue;
    }

    if (!raw || raw === 'null' || !raw.includes('{')) {
      console.log(`  ✓ Slide ${i + 1}: ok`);
      continue;
    }

    let ajustes;
    try { ajustes = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch {
      console.log(`  ✓ Slide ${i + 1}: ok`);
      continue;
    }

    console.log(`  ⚠ Slide ${i + 1}: ${ajustes.problema}`);

    const s = contenido.slides[i];
    let slideChanged = false;

    if (ajustes.overlay_delta && Math.abs(ajustes.overlay_delta) > 0.04) {
      const delta = ajustes.overlay_delta;
      contenido.slides[i]._overlay = Math.max(0.10, Math.min(0.80, (s._overlay ?? contenido.overlay ?? 0.50) + delta));
      console.log(`    → Overlay slide ${i + 1}: ${ajustes.overlay_delta > 0 ? '+' : ''}${ajustes.overlay_delta}`);
      slideChanged = true;
    }

    if (ajustes.headline_ajuste === 'subir') {
      contenido.slides[i]._headlineAjuste = 'normal';
      console.log(`    → Headline slide ${i + 1}: subir`);
      slideChanged = true;
    } else if (ajustes.headline_ajuste === 'bajar') {
      contenido.slides[i]._headlineAjuste = contenido.slides[i]._headlineAjuste === 'normal' ? 'small' : (contenido.slides[i]._headlineAjuste || 'small');
      console.log(`    → Headline slide ${i + 1}: bajar`);
      slideChanged = true;
    }

    if (ajustes.text_y_nuevo != null && !isNaN(Number(ajustes.text_y_nuevo))) {
      const ty = Math.round(Math.max(5, Math.min(88, Number(ajustes.text_y_nuevo))));
      const ly = s._layout || '';
      if (s.photo && (ly.startsWith('cover') || ly.startsWith('quote') || ly.startsWith('cta') || ly === '')) {
        contenido.slides[i]._textY = ty;
        console.log(`    → TextY slide ${i + 1}: ${ty}%`);
        slideChanged = true;
      }
    }

    if (slideChanged) {
      anyChanged = true;
      fixedSlides.push(i + 1); // 1-indexed
    }
  }

  if (anyChanged) {
    await writeFile(inputPath, JSON.stringify(contenido, null, 2), 'utf-8');
    await writeFile(flagFile, JSON.stringify({ changed: true, fixedSlides }), 'utf-8');
    console.log(`  → Ajustes aplicados en slides: [${fixedSlides.join(', ')}] — re-renderizando`);
  } else {
    console.log('  ✓ Todos los slides aprobados');
  }

  // --- Coherencia entre slides ---
  try {
    const slideUrls = [];
    for (let i = 1; i <= total; i++) {
      const slidePath = path.join(outDir, `slide-0${i}.png`);
      let slideBuf;
      try { slideBuf = await readFile(slidePath); } catch { continue; }
      const r = await sharp(slideBuf).resize({ width: 360 }).jpeg({ quality: 70 }).toBuffer();
      slideUrls.push(`data:image/jpeg;base64,${r.toString('base64')}`);
    }

    if (slideUrls.length > 1) {
      console.log(`\n🎨 Coherencia entre ${slideUrls.length} slides...`);
      let rawCoh;
      try { rawCoh = await callVisionCoherencia(slideUrls); } catch { rawCoh = null; }

      if (rawCoh && rawCoh.includes('{')) {
        let cohResult;
        try { cohResult = JSON.parse(rawCoh.replace(/```json|```/g, '').trim()); } catch { cohResult = null; }

        if (cohResult?.ok === false && Array.isArray(cohResult.problemas)) {
          for (const p of cohResult.problemas) {
            console.log(`  🎨 Slides [${p.slides.join(',')}] — ${p.tipo}: ${p.sugerencia}`);
          }
          let flagData = { changed: false };
          try { flagData = JSON.parse(await readFile(flagFile, 'utf-8')); } catch {}
          flagData.coherencia = { problemas: cohResult.problemas };
          await writeFile(flagFile, JSON.stringify(flagData, null, 2), 'utf-8');
        } else {
          console.log('  🎨 Coherencia: ok');
        }
      }
    }
  } catch { /* ignorar */ }
}

main().catch(e => { console.error('criticar.mjs error:', e.message); });
