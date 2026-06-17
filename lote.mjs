/**
 * lote.mjs — Genera carruseles en cadena durante un tiempo dado
 *
 * Uso:
 *   node lote.mjs [marca] [minutos]
 *
 * Por cada vuelta: crear.mjs (copy) → analizar.mjs (diseño) → generar.mjs (PNGs).
 * Cada carrusel sale en su propia carpeta tandas/<timestamp>_<tema>/ — nunca
 * se pisan entre sí. Corta sola al llegar al tiempo límite (default 45 min).
 * Los temas y la identidad de marca salen de marcas/<marca>/.
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const marcaId = process.argv[2] || 'squadteam';
  const minutos = Number(process.argv[3] || 45);

  const temas = JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'temas.json'), 'utf-8'));
  if (!Array.isArray(temas) || !temas.length) {
    throw new Error(`marcas/${marcaId}/temas.json debe ser un array de strings no vacío`);
  }

  const limite = Date.now() + minutos * 60 * 1000;
  let i = 0;
  let n = 0;

  console.log(`\n🎬 Tanda de carruseles — marca "${marcaId}", hasta ${minutos} min, ${temas.length} tema(s) en rotación\n`);

  while (Date.now() < limite) {
    const tema = temas[i % temas.length];
    i++;
    n++;
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`#${n} — "${tema}"`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const crear = spawnSync('node', ['crear.mjs', tema, '', marcaId], { cwd: __dirname, encoding: 'utf-8' });
    process.stdout.write(crear.stdout || '');
    if (crear.status !== 0) {
      console.error(crear.stderr);
      continue;
    }
    const lines = crear.stdout.trim().split('\n');
    const carpeta = lines[lines.length - 1].trim();

    const analizar = spawnSync('node', ['analizar.mjs', `${carpeta}/contenido.json`], { cwd: __dirname, stdio: 'inherit' });
    if (analizar.status !== 0) continue;

    const generar = spawnSync('node', ['generar.mjs', `${carpeta}/contenido.analizado.json`], { cwd: __dirname, stdio: 'inherit' });
    if (generar.status !== 0) continue;

    // Autocrítica visual — detecta problemas y escribe critique.json
    const criticar = spawnSync('node', ['criticar.mjs', `${carpeta}/contenido.analizado.json`], { cwd: __dirname, stdio: 'inherit' });
    if (criticar.status === 0) {
      // Si la autocrítica detectó cambios, re-renderizar
      try {
        const { readFileSync } = await import('node:fs');
        const flag = JSON.parse(readFileSync(path.join(__dirname, carpeta, 'output', 'critique.json'), 'utf-8'));
        if (flag.changed) {
          const slidesEnv = flag.fixedSlides?.length
            ? { ...process.env, SLIDES_TO_RERENDER: flag.fixedSlides.join(',') }
            : process.env;
          console.log('  → Re-renderizando tras autocrítica...');
          spawnSync('node', ['generar.mjs', `${carpeta}/contenido.analizado.json`], { cwd: __dirname, stdio: 'inherit', env: slidesEnv });
        }
      } catch { /* critique.json no existe o no es válido — ignorar */ }
    }

    console.log(`\n✅ ${carpeta}/output listo`);

    if (Date.now() >= limite) break;
  }

  console.log(`\n🏁 Listo — ${n} carrusel(es) generados.`);
}

main().catch(err => { console.error(err); process.exit(1); });
