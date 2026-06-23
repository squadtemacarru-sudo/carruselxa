/**
 * generar-highlights.mjs — Genera Highlight Covers para Instagram (1080×1080)
 *
 * Uso:
 *   node generar-highlights.mjs [highlights.json] [carpetaSalida]
 *
 * Formato de highlights.json:
 *   [{ "label": "Workout", "emoji": "💪", "color": "#e8ff00" }, ...]
 *
 * Si no se especifica highlights.json, busca highlights.json en el directorio actual.
 * Los PNGs se guardan en [carpetaSalida]/output/
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildHighlightHtml(items) {
  const itemsHtml = items.map((item, i) => `
    <div class="cover" id="cover-${i}" style="background: ${item.color || '#e8ff00'}">
      <div class="emoji">${item.emoji || '⭐'}</div>
      <div class="label">${item.label || ''}</div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0a; }

  .cover {
    width: 1080px;
    height: 1080px;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 40px;
    position: relative;
  }
  .cover.active { display: flex; }

  .emoji {
    font-size: 320px;
    line-height: 1;
    text-align: center;
    filter: drop-shadow(0 8px 32px rgba(0,0,0,0.35));
  }

  .label {
    font-family: 'Inter', 'Arial Black', sans-serif;
    font-size: 96px;
    font-weight: 900;
    color: #000000;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    text-align: center;
    line-height: 1;
    mix-blend-mode: multiply;
    opacity: 0.75;
    max-width: 900px;
    word-break: break-word;
  }
</style>
</head>
<body>
${itemsHtml}
<script>
  window.__showCover = (i) => {
    document.querySelectorAll('.cover').forEach((c, idx) => {
      c.classList.toggle('active', idx === i);
    });
  };
</script>
</body>
</html>`;
}

async function main() {
  const inputArg = process.argv[2] || 'highlights.json';
  const inputPath = path.isAbsolute(inputArg) ? inputArg : path.join(__dirname, inputArg);

  let items;
  try {
    items = JSON.parse(await readFile(inputPath, 'utf-8'));
  } catch (e) {
    console.error(`No se pudo leer ${inputPath}: ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(items) || !items.length) {
    console.error('highlights.json debe ser un array no vacío de { label, emoji, color }');
    process.exit(1);
  }

  const baseDir = path.dirname(inputPath);
  const outDir = process.argv[3]
    ? path.join(__dirname, process.argv[3], 'output')
    : path.join(baseDir, 'output');

  await mkdir(outDir, { recursive: true });

  const html = buildHighlightHtml(items);
  const tmpHtml = path.join(baseDir, '_tmp_highlight.html');
  await writeFile(tmpHtml, html, 'utf-8');

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });
  await page.goto(`file://${tmpHtml}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise(r => setTimeout(r, 200));

  for (let i = 0; i < items.length; i++) {
    await page.evaluate((idx) => window.__showCover(idx), i);
    await new Promise(r => setTimeout(r, 100));
    const cover = await page.$(`#cover-${i}`);
    const label = (items[i].label || `cover-${i + 1}`).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const file = path.join(outDir, `highlight-${label}.png`);
    await cover.screenshot({ path: file });
    console.log(`✓ ${file}`);
  }

  await browser.close();
  await import('node:fs/promises').then(fs => fs.unlink(tmpHtml));

  console.log(`\nListo. ${items.length} highlight covers en ${outDir}`);
}

main().catch(err => { console.error(err); process.exit(1); });
