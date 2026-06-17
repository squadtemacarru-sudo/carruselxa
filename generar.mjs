import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

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

  const template = await readFile(path.join(__dirname, 'template.html'), 'utf-8');
  const renderCore = await readFile(path.join(__dirname, 'render-core.js'), 'utf-8');
  const html = template
    .replace('<script src="render-core.js"></script>', `<script>${renderCore}</script>`)
    .replace('__DATA__', JSON.stringify(raw));

  // Output e intermedios viven junto al contenido, así corridas en
  // carpetas distintas (ej. tandas/<id>/) nunca se pisan entre sí
  const baseDir = path.dirname(inputPath);
  const outDir = path.join(baseDir, 'output');
  await mkdir(outDir, { recursive: true });
  const tmpHtml = path.join(baseDir, '_tmp_render.html');
  await writeFile(tmpHtml, html, 'utf-8');

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
  await page.goto(`file://${tmpHtml}`, { waitUntil: 'networkidle0' });

  const total = raw.slides.length;
  for (let i = 0; i < total; i++) {
    await page.evaluate((idx) => window.__showSlide(idx), i);
    await new Promise((r) => setTimeout(r, 150));
    const wrapper = await page.$('#slideWrapper');
    const file = path.join(outDir, `slide-0${i + 1}.png`);
    await wrapper.screenshot({ path: file });
    console.log(`✓ ${file}`);
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
