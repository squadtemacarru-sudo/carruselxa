import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

// ── Caché local de Google Fonts ───────────────────────────────────────────────
// Intercepta requests a fonts.googleapis.com y fonts.gstatic.com en Puppeteer.
// Primera vez: descarga y guarda en font-cache/. Siguientes renders: sirve disco.
// Elimina latencia de red y variabilidad entre renders.

const FONT_CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'font-cache');
await mkdir(FONT_CACHE_DIR, { recursive: true });

function urlToCacheKey(url) {
  // Convierte la URL en nombre de archivo seguro para el sistema de archivos
  return url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

async function fetchAndCache(url) {
  const key  = urlToCacheKey(url);
  const file = path.join(FONT_CACHE_DIR, key);
  try {
    await access(file);
    return { body: await readFile(file), fromCache: true };
  } catch {
    // No está en caché — descargamos
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(file, buf);
    return { body: buf, fromCache: false };
  }
}

async function enableFontCache(page) {
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = req.url();
    if (!url.includes('fonts.googleapis.com') && !url.includes('fonts.gstatic.com')) {
      req.continue();
      return;
    }
    try {
      const result = await fetchAndCache(url);
      if (!result) { req.continue(); return; }
      const contentType = url.includes('.woff2') ? 'font/woff2'
        : url.includes('.woff') ? 'font/woff'
        : 'text/css; charset=utf-8';
      req.respond({ status: 200, contentType, body: result.body });
    } catch {
      req.continue();
    }
  });
}

async function uploadToCloudinary(filePath, folder) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const preset   = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloudName || !preset) return null;

  const buf  = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'image/png' }), path.basename(filePath));
  form.append('upload_preset', preset);
  form.append('folder', folder);

  const res  = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(`Cloudinary: ${data.error?.message}`);
  return data.secure_url;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// Mapa filename → Cloudinary URL inyectado por server.mjs al lanzar el proceso
let FOTOS_MAP = {};
try { if (process.env.FOTOS_MAP) FOTOS_MAP = JSON.parse(process.env.FOTOS_MAP); } catch {}

async function fetchUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar foto: ${url}`);
  const buf  = Buffer.from(await res.arrayBuffer());
  const ext  = url.split('?')[0].split('.').pop().toLowerCase();
  const mime = MIME[`.${ext}`] || 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function fileToDataUrl(abs) {
  const buf = await readFile(abs);
  const mime = MIME[path.extname(abs).toLowerCase()] || 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function photoToDataUrl(relPath) {
  // URL absoluta → descargar directamente
  if (relPath.startsWith('http://') || relPath.startsWith('https://')) {
    return fetchUrl(relPath);
  }
  // Nombre de archivo (con o sin prefijo "fotos/") → FOTOS_MAP si es URL absoluta, si no disco local
  const filename = path.basename(relPath);
  const mapped = FOTOS_MAP[filename];
  if (mapped && (mapped.startsWith('http://') || mapped.startsWith('https://'))) {
    return fetchUrl(mapped);
  }
  return fileToDataUrl(path.join(__dirname, 'fotos', filename));
}

// Logo de marca para el watermark — cada marca tiene su propio
// marcas/<id>/logo.png, opcional
async function loadLogo(marcaId) {
  try {
    return await fileToDataUrl(path.join(__dirname, 'marcas', marcaId, 'logo.png'));
  } catch {
    return null;
  }
}

async function main() {
  const contentFile = process.argv[2] || 'contenido.json';
  const inputPath = path.join(__dirname, contentFile);
  const raw = JSON.parse(await readFile(inputPath, 'utf-8'));

  // Rotaciones solicitadas por el usuario
  let USER_ROTATIONS = {};
  try { if (process.env.USER_ROTATIONS) USER_ROTATIONS = JSON.parse(process.env.USER_ROTATIONS); } catch {}

  // El browser se lanza antes de procesar fotos para poder rotar con canvas
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--enable-features=ShapeDetection',
    ],
  });

  // Pre-rotar fotos si el usuario lo pidió
  const rotatedCache = {};
  if (Object.keys(USER_ROTATIONS).length) {
    const rotPage = await browser.newPage();
    await rotPage.setContent('<!DOCTYPE html><html><body></body></html>');
    for (const [photoRef, degrees] of Object.entries(USER_ROTATIONS)) {
      try {
        const src = await photoToDataUrl(photoRef);
        rotatedCache[photoRef] = await rotPage.evaluate(
          async ({ src, deg }) => {
            const img = await new Promise(res => {
              const i = new Image(); i.onload = () => res(i); i.src = src;
            });
            const rad = deg * Math.PI / 180;
            const sin = Math.abs(Math.sin(rad));
            const cos = Math.abs(Math.cos(rad));
            const w = Math.round(img.width * cos + img.height * sin);
            const h = Math.round(img.width * sin + img.height * cos);
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const ctx = c.getContext('2d');
            ctx.translate(w / 2, h / 2);
            ctx.rotate(rad);
            ctx.drawImage(img, -img.width / 2, -img.height / 2);
            return c.toDataURL('image/jpeg', 0.9);
          },
          { src, deg: degrees }
        );
        console.log(`↻ Rotado ${degrees}° → ${photoRef}`);
      } catch (e) {
        console.error(`No se pudo rotar ${photoRef}: ${e.message}`);
      }
    }
    await rotPage.close();
  }

  const resolvePhoto = async (ref) => rotatedCache[ref] ?? (await photoToDataUrl(ref));

  const photoFields = ['photo', 'photo_top', 'photo_bottom', 'photo_before', 'photo_after'];
  for (const slide of raw.slides) {
    for (const field of photoFields) {
      if (slide[field]) slide[field] = await resolvePhoto(slide[field]);
    }
    if (Array.isArray(slide.rows)) {
      for (const row of slide.rows) {
        if (row.photo) row.photo = await resolvePhoto(row.photo);
      }
    }
  }

  raw._logo = await loadLogo(raw._marca || 'squadteam');

  const baseDir = path.dirname(inputPath);
  const outDir = path.join(baseDir, 'output');
  await mkdir(outDir, { recursive: true });
  const tmpHtml = path.join(baseDir, '_tmp_render.html');

  // ── Detección de caras con Chrome FaceDetector API ───────────────────
  // Corre ANTES de generar el HTML para que las correcciones queden en raw.
  // Usa el FaceDetector nativo de Chrome (ShapeDetection API) para obtener
  // coordenadas exactas de las caras en cada foto. Ajusta _textY y _photoPos
  // para que el texto nunca tape al sujeto. Sin dependencias extra.
  const faceDetectPage = await browser.newPage();
  await faceDetectPage.setContent('<!DOCTYPE html><html><body></body></html>');
  let faceDetectionAvailable = false;
  try {
    faceDetectionAvailable = await faceDetectPage.evaluate(() => 'FaceDetector' in window);
  } catch {}

  if (faceDetectionAvailable) {
    console.log('\n👤 Detección de caras activada (Chrome FaceDetector)');
    for (let i = 0; i < raw.slides.length; i++) {
      const s = raw.slides[i];
      const mainPhoto = s.photo || s.photo_top || s.photo_bottom;
      if (!mainPhoto) continue;
      try {
        const faces = await faceDetectPage.evaluate(async (src) => {
          const img = await new Promise((res, rej) => {
            const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src;
          });
          const detector = new FaceDetector({ fastMode: false, maxDetectedFaces: 3 });
          const detected = await detector.detect(img);
          return detected.map(f => ({
            x: f.boundingBox.x / img.width,
            y: f.boundingBox.y / img.height,
            w: f.boundingBox.width / img.width,
            h: f.boundingBox.height / img.height,
          }));
        }, mainPhoto);

        if (faces.length) {
          const face = faces[0];
          const faceCenterY = face.y + face.h / 2;
          const faceCenterX = face.x + face.w / 2;

          // Determinar zona segura para texto (vertical)
          const safeTextY = faceCenterY < 0.5 ? 74 : 8;
          const currentTextY = s._textY ?? null;
          const wouldOverlap = currentTextY === null ||
            (currentTextY / 100 > face.y - 0.1 && currentTextY / 100 < face.y + face.h + 0.1);
          if (wouldOverlap) {
            raw.slides[i]._textY = safeTextY;
            console.log(`  👤 Slide ${i+1}: cara en ${Math.round(faceCenterY*100)}% vertical → texto a ${safeTextY}%`);
          }

          // Ajustar background-position horizontal para centrar el sujeto
          const currentPos = s._photoPos || 'center center';
          const posY = currentPos.split(' ')[1] || 'center';
          if (faceCenterX < 0.38) {
            raw.slides[i]._photoPos = `left ${posY}`;
          } else if (faceCenterX > 0.62) {
            raw.slides[i]._photoPos = `right ${posY}`;
          } else {
            raw.slides[i]._photoPos = `center ${posY}`;
          }
        }
      } catch { /* FaceDetector falló para este slide — continuar */ }
    }
    // Reescribir contenido.analizado.json con las correcciones de cara
    await writeFile(inputPath, JSON.stringify(raw, null, 2), 'utf-8');
  } else {
    console.log('\n👤 FaceDetector no disponible en este Chrome — usando posicionamiento por IA');
  }
  await faceDetectPage.close();
  // ─────────────────────────────────────────────────────────────────────

  // Generar HTML con raw ya corregido por detección de caras
  const template = await readFile(path.join(__dirname, 'template.html'), 'utf-8');
  const renderCore = await readFile(path.join(__dirname, 'render-core.js'), 'utf-8');
  const html = template
    .replace('<script src="render-core.js"></script>', `<script>${renderCore}</script>`)
    .replace('__DATA__', JSON.stringify(raw));
  await writeFile(tmpHtml, html, 'utf-8');

  const page = await browser.newPage();
  await enableFontCache(page);
  await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 2 });
  await page.goto(`file://${tmpHtml}`, { waitUntil: 'networkidle0' });
  // Esperar a que todas las fuentes (incluyendo las cargadas dinámicamente) estén listas
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 400));

  const total = raw.slides.length;

  // If SLIDES_TO_RERENDER is set (e.g. "1,3,5"), only re-render those slides.
  // Otherwise render all.
  let toRender;
  if (process.env.SLIDES_TO_RERENDER) {
    toRender = process.env.SLIDES_TO_RERENDER.split(',')
      .map(n => parseInt(n.trim(), 10) - 1)
      .filter(n => n >= 0 && n < total);
    console.log(`\n↺ Re-renderizando solo slides: [${toRender.map(n => n+1).join(', ')}]`);
  } else {
    toRender = Array.from({ length: total }, (_, i) => i);
  }

  for (const i of toRender) {
    const file = path.join(outDir, `slide-0${i + 1}.png`);
    try {
      await page.evaluate((idx) => window.__showSlide(idx), i);
      await new Promise((r) => setTimeout(r, 150));
      const wrapper = await page.$('#slideWrapper');
      await wrapper.screenshot({ path: file });
      console.log(`✓ ${file}`);
    } catch (err) {
      // Render de este slide falló — reemplazarlo por el fallback tipográfico
      // en vivo y reintentar el screenshot. Nunca rompemos toda la tanda.
      console.warn(`⚠ Slide ${i + 1} falló al renderizar (${err.message}) — usando fallback...`);
      try {
        await page.evaluate((idx, srcData) => {
          const slide = srcData.slides[idx] || {};
          let headline = '';
          if (Array.isArray(slide.headline_lines) && slide.headline_lines.length) {
            headline = slide.headline_lines.map(l => l && l.text).filter(Boolean).join('\n');
          }
          for (const c of ['headline', 'title', 'quote', 'stat', 'line2', 'line1']) {
            if (!headline && typeof slide[c] === 'string' && slide[c].trim()) headline = slide[c].trim();
          }
          if (!headline && Array.isArray(slide.items) && slide.items.length) {
            const f = slide.items[0];
            headline = typeof f === 'string' ? f : (f && (f.text || f.title)) || '';
          }
          let body = '';
          for (const c of ['body', 'sub', 'detail', 'label', 'note', 'eyebrow']) {
            if (!body && typeof slide[c] === 'string' && slide[c].trim()) body = slide[c].trim();
          }
          const fb = { type: 'fallback', headline: headline || '—', ...(body ? { body } : {}) };
          const oldEl = document.getElementById(`slide-${idx + 1}`);
          const newEl = buildFallback(fb, idx, srcData.slides.length);
          if (oldEl) oldEl.replaceWith(newEl); else document.getElementById('slideWrapper').appendChild(newEl);
          window.__showSlide(idx);
        }, i, raw);
        await new Promise((r) => setTimeout(r, 150));
        const wrapper = await page.$('#slideWrapper');
        await wrapper.screenshot({ path: file });
        console.log(`✓ ${file} (fallback)`);
      } catch (err2) {
        console.error(`✗ Slide ${i + 1}: fallback también falló (${err2.message})`);
      }
    }
  }

  await browser.close();
  await import('node:fs/promises').then((fs) => fs.unlink(tmpHtml));

  const tandaId = path.basename(baseDir);
  const cloudFolder = `carrusel-generator/${tandaId}`;
  const cloudUrls = [];
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_UPLOAD_PRESET) {
    console.log('\n☁️  Subiendo a Cloudinary...');
    for (let i = 0; i < total; i++) {
      const file = path.join(outDir, `slide-0${i + 1}.png`);
      const url  = await uploadToCloudinary(file, cloudFolder);
      cloudUrls.push(url);
      console.log(`  ↑ slide-0${i + 1} → ${url}`);
    }
    await writeFile(path.join(outDir, 'cloudinary.json'), JSON.stringify(cloudUrls, null, 2), 'utf-8');
  }

  console.log(`\nListo. ${total} slides en ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
