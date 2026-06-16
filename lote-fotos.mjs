/**
 * lote-fotos.mjs — Genera carruseles con fotos en cadena durante un tiempo dado
 *
 * Uso:
 *   node lote-fotos.mjs [marca] [minutos]
 *
 * Por cada vuelta toma 2-3 fotos sin usar de fotos/ (sin repetir entre
 * carruseles — el registro queda en fotos/.usadas.json) y las pasa a
 * crear.mjs para que arme un carrusel con layouts multi-foto (full_impact,
 * before_after, split_v, triple_v) + slides clásicas. Igual que lote.mjs:
 * crear.mjs → analizar.mjs → generar.mjs, cada carrusel en su propia
 * carpeta tandas/<timestamp>_<tema>/. Corta sola cuando quedan menos de 2
 * fotos sin usar o al llegar al tiempo límite (default 45 min).
 */

import { spawnSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FOTOS_DIR = path.join(__dirname, 'fotos');
const USADAS_FILE = path.join(FOTOS_DIR, '.usadas.json');
const EXT_RE = /\.(jpe?g|png|webp)$/i;

async function loadUsadas() {
  try {
    return new Set(JSON.parse(await readFile(USADAS_FILE, 'utf-8')));
  } catch {
    return new Set();
  }
}

async function saveUsadas(set) {
  await writeFile(USADAS_FILE, JSON.stringify([...set], null, 2), 'utf-8');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  const marcaId = process.argv[2] || 'squadteam';
  const minutos = Number(process.argv[3] || 45);

  const temas = JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'temas.json'), 'utf-8'));
  if (!Array.isArray(temas) || !temas.length) {
    throw new Error(`marcas/${marcaId}/temas.json debe ser un array de strings no vacío`);
  }

  const usadas = await loadUsadas();
  const todasFotos = (await readdir(FOTOS_DIR)).filter(f => EXT_RE.test(f));

  const limite = Date.now() + minutos * 60 * 1000;
  let i = 0;
  let n = 0;

  console.log(`\n📸 Tanda de carruseles con fotos — marca "${marcaId}", hasta ${minutos} min\n`);

  while (Date.now() < limite) {
    const disponibles = shuffle(todasFotos.filter(f => !usadas.has(f)));
    if (disponibles.length < 2) {
      console.log(`\n📭 Quedan ${disponibles.length} foto(s) sin usar — se necesitan al menos 2. Cortando.`);
      break;
    }
    const cantidad = disponibles.length >= 3 && Math.random() < 0.5 ? 3 : 2;
    const fotosTanda = disponibles.slice(0, cantidad);

    const tema = temas[i % temas.length];
    i++;
    n++;
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`#${n} — "${tema}"`);
    console.log(`   📷 ${fotosTanda.join(', ')}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const crear = spawnSync('node', ['crear.mjs', tema, '', marcaId, fotosTanda.join(',')], { cwd: __dirname, encoding: 'utf-8' });
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

    fotosTanda.forEach(f => usadas.add(f));
    await saveUsadas(usadas);

    console.log(`\n✅ ${carpeta}/output listo`);

    if (Date.now() >= limite) break;
  }

  console.log(`\n🏁 Listo — ${n} carrusel(es) generados.`);
}

main().catch(err => { console.error(err); process.exit(1); });
