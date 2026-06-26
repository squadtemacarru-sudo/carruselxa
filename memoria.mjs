/**
 * memoria.mjs — Memoria de marca real (roadmap #7)
 *
 * Agrega señales de calidad de los carruseles ya generados de una marca
 * (guardado / descartado / descargado / editado) en un resumen ejecutivo
 * por marca: marcas/<id>/memoria.json.
 *
 * Diseño:
 *  - 100% agregación local. NUNCA llama a la IA. Síncrono y barato.
 *  - El score por tanda se deriva de señales objetivas que ya persiste la app:
 *      descargado (ZIP)  = intención de usar      → señal MUY fuerte
 *      guardado          = aprobado explícito      → señal fuerte
 *      editado           = base buena, necesitó mano → señal media (positiva)
 *      nuevo / sin tocar = sin información          → neutro
 *      descartado        = rechazado explícito      → señal negativa
 *  - Lo que aprende de cada carrusel: paleta (fondo+acento), par tipográfico,
 *    nombre del sistema de diseño, tipos de slide usados, y el ángulo del tema.
 *  - memoria.json se actualiza de forma incremental (bump barato) cuando llega
 *    una señal, o se reconstruye desde cero recorriendo todas las tandas.
 *
 * Estructura de memoria.json:
 * {
 *   "marca": "squadteam",
 *   "actualizado": "2026-06-25T...",
 *   "tandas_analizadas": 12,
 *   "señales": { "descargado": 3, "guardado": 5, "editado": 2, "descartado": 4, "nuevo": 1 },
 *   "ganadores": {                // agregados de carruseles con score > 0, ordenados por peso
 *     "paletas":     [{ "clave": "#040404 + #e8ff00", "peso": 12, "n": 5 }],
 *     "tipografias": [{ "clave": "Bebas Neue / Inter", "peso": 12, "n": 5 }],
 *     "sistemas":    [{ "clave": "Void Acid", "peso": 9, "n": 4 }],
 *     "tipos_slide": [{ "clave": "statement", "peso": 8, "n": 6 }],
 *     "angulos":     [{ "clave": "señales de crecimiento", "peso": 5, "n": 1 }]
 *   },
 *   "descartados": {              // mismos ejes, pero de carruseles con score < 0
 *     "paletas": [...], "tipografias": [...], "sistemas": [...], "tipos_slide": [...]
 *   }
 * }
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pesos de cada señal. El score de una tanda es la suma de las señales que tenga.
// Una tanda guardada y descargada vale 5; una descartada vale -2 aunque la hayan editado.
export const PESOS_SEÑAL = {
  descargado: 3,
  guardado:   2,
  editado:    1,
  nuevo:      0,
  descartado: -2,
};

const MEMORIA_FILENAME = 'memoria.json';
const memoriaPath = (marcaId) => path.join(__dirname, 'marcas', marcaId, MEMORIA_FILENAME);

// ── Extracción de rasgos de un contenido.json ────────────────────────────────
// Lee el sistema de diseño y los tipos de slide de un carrusel y devuelve sus
// "rasgos" — las dimensiones que la memoria aprende. Tolera contenido.json y
// contenido.analizado.json (estructuras ligeramente distintas).
function extraerRasgos(contenido) {
  const sis = contenido?._sistema || {};
  const pal = sis.paleta || {};
  const tipo = sis.tipografia || {};

  const fondo  = (pal.fondo  || '').toLowerCase().trim();
  const acento = (pal.acento || '').toLowerCase().trim();
  const paleta = (fondo || acento) ? `${fondo || '?'} + ${acento || '?'}` : null;

  const display = tipo.display?.familia || sis.font_display_familia || null;
  const body    = tipo.body?.familia    || sis.font_body_familia    || null;
  const tipografia = (display || body) ? `${display || '?'} / ${body || '?'}` : null;

  const sistema = sis.nombre_sistema || sis.nombre || null;

  const tipos = Array.isArray(contenido?.slides)
    ? [...new Set(contenido.slides.map(s => s?.type).filter(Boolean))]
    : [];

  return { paleta, tipografia, sistema, tipos };
}

// El ángulo del tema sale del nombre de carpeta (formato: timestamp_slug).
function anguloDeCarpeta(carpeta) {
  return carpeta.replace(/^\d+_/, '').replace(/-/g, ' ').trim() || null;
}

// ── Acumulador de rasgos ponderados ──────────────────────────────────────────
// Mantiene, por cada eje (paleta, tipografia, ...), un mapa clave → { peso, n }.
function nuevoAcumulador() {
  return { paletas: new Map(), tipografias: new Map(), sistemas: new Map(), tipos_slide: new Map(), angulos: new Map() };
}

function bump(map, clave, peso) {
  if (!clave) return;
  const cur = map.get(clave) || { peso: 0, n: 0 };
  cur.peso += peso;
  cur.n    += 1;
  map.set(clave, cur);
}

function acumularRasgos(acc, rasgos, angulo, peso) {
  bump(acc.paletas,     rasgos.paleta,     peso);
  bump(acc.tipografias, rasgos.tipografia, peso);
  bump(acc.sistemas,    rasgos.sistema,    peso);
  for (const t of rasgos.tipos) bump(acc.tipos_slide, t, peso);
  bump(acc.angulos, angulo, peso);
}

// Convierte un Map a array ordenado por peso desc, top N.
function topN(map, n = 5) {
  return [...map.entries()]
    .map(([clave, { peso, n: count }]) => ({ clave, peso: Math.round(peso * 10) / 10, n: count }))
    .sort((a, b) => b.peso - a.peso)
    .slice(0, n);
}

// ── Lectura de señales de una tanda ──────────────────────────────────────────
async function leerEstado(tandaDir) {
  try {
    const e = JSON.parse(await readFile(path.join(tandaDir, 'estado.json'), 'utf-8'));
    return e.estado || 'nuevo';
  } catch {
    return 'nuevo';
  }
}

// Lee el rastro de señales explícitas (descargado/editado) que guardamos aparte
// del estado binario. Si no existe, no hubo descarga ni edición registradas.
async function leerSeñales(tandaDir) {
  try {
    const s = JSON.parse(await readFile(path.join(tandaDir, 'senales.json'), 'utf-8'));
    return { descargado: !!s.descargado, editado: !!s.editado };
  } catch {
    return { descargado: false, editado: false };
  }
}

// Calcula el score de una tanda a partir de su estado + señales.
// El descarte es excluyente: si fue descartada, su score es negativo aunque
// se haya descargado/editado antes (el usuario la rechazó al final).
function scoreTanda(estado, señales) {
  if (estado === 'descartado') return { score: PESOS_SEÑAL.descartado, etiqueta: 'descartado' };
  let score = 0;
  if (estado === 'guardado') score += PESOS_SEÑAL.guardado;
  if (señales.descargado)    score += PESOS_SEÑAL.descargado;
  if (señales.editado)       score += PESOS_SEÑAL.editado;
  const etiqueta = score > 0 ? 'positivo' : 'nuevo';
  return { score, etiqueta };
}

// ── Reconstrucción completa ──────────────────────────────────────────────────
// Recorre TODAS las tandas de una marca y reconstruye memoria.json desde cero.
// Pura agregación local — sin IA. Útil para marcas con historial previo.
export async function reconstruirMemoria(marcaId) {
  const tandasDir = path.join(__dirname, 'tandas');
  let carpetas;
  try {
    carpetas = (await readdir(tandasDir, { withFileTypes: true }))
      .filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    carpetas = [];
  }

  const ganadores   = nuevoAcumulador();
  const descartados = nuevoAcumulador();
  const señalesCount = { descargado: 0, guardado: 0, editado: 0, descartado: 0, nuevo: 0 };
  let analizadas = 0;

  for (const carpeta of carpetas) {
    const tandaDir = path.join(tandasDir, carpeta);
    let contenido;
    try {
      contenido = JSON.parse(await readFile(path.join(tandaDir, 'contenido.json'), 'utf-8'));
    } catch {
      try {
        contenido = JSON.parse(await readFile(path.join(tandaDir, 'contenido.analizado.json'), 'utf-8'));
      } catch {
        continue; // carpeta sin contenido
      }
    }
    // Sólo tandas de esta marca (si el carrusel declara marca).
    if (contenido._marca && contenido._marca !== marcaId) continue;

    const estado  = await leerEstado(tandaDir);
    const señales = await leerSeñales(tandaDir);
    const { score } = scoreTanda(estado, señales);

    // Conteo de señales (para diagnóstico en el JSON).
    if (estado === 'descartado') señalesCount.descartado++;
    else if (estado === 'guardado') señalesCount.guardado++;
    else señalesCount.nuevo++;
    if (señales.descargado) señalesCount.descargado++;
    if (señales.editado)    señalesCount.editado++;

    if (score === 0) continue; // tandas neutras no aportan a ningún lado

    analizadas++;
    const rasgos = extraerRasgos(contenido);
    const angulo = anguloDeCarpeta(carpeta);
    if (score > 0) acumularRasgos(ganadores, rasgos, angulo, score);
    else           acumularRasgos(descartados, rasgos, angulo, -score); // peso positivo del lado negativo
  }

  const memoria = {
    marca: marcaId,
    actualizado: new Date().toISOString(),
    tandas_analizadas: analizadas,
    señales: señalesCount,
    ganadores: {
      paletas:     topN(ganadores.paletas),
      tipografias: topN(ganadores.tipografias),
      sistemas:    topN(ganadores.sistemas),
      tipos_slide: topN(ganadores.tipos_slide),
      angulos:     topN(ganadores.angulos),
    },
    descartados: {
      paletas:     topN(descartados.paletas),
      tipografias: topN(descartados.tipografias),
      sistemas:    topN(descartados.sistemas),
      tipos_slide: topN(descartados.tipos_slide),
    },
  };

  try {
    await writeFile(memoriaPath(marcaId), JSON.stringify(memoria, null, 2), 'utf-8');
  } catch (e) {
    // Si la carpeta de la marca no existe todavía, no rompemos nada.
    console.warn(`⚠ No se pudo escribir memoria.json de ${marcaId}: ${e.message}`);
  }
  return memoria;
}

// ── Actualización incremental ────────────────────────────────────────────────
// Llamada cuando llega UNA señal de UNA tanda (guardar/descartar/descargar/editar).
// En vez de mantener un acumulador frágil, registramos la señal en la tanda y
// reconstruimos la memoria de la marca (recorrer N tandas locales es barato:
// son lecturas de JSON pequeños, sin red ni IA). Esto garantiza consistencia y
// que el descarte revierta correctamente un guardado/descarga previo.
//
// señal: 'guardado' | 'descartado' | 'descargado' | 'editado'
export async function registrarSeñal(tandaId, señal) {
  const tandaDir = path.join(__dirname, 'tandas', tandaId);

  // Persistimos descargado/editado en senales.json (acumulativas, no se borran).
  if (señal === 'descargado' || señal === 'editado') {
    let actual = {};
    try { actual = JSON.parse(await readFile(path.join(tandaDir, 'senales.json'), 'utf-8')); } catch {}
    actual[señal] = true;
    try {
      await writeFile(path.join(tandaDir, 'senales.json'), JSON.stringify(actual, null, 2), 'utf-8');
    } catch (e) {
      console.warn(`⚠ No se pudo escribir senales.json de ${tandaId}: ${e.message}`);
    }
  }
  // (guardado/descartado ya los persiste el endpoint de estado en estado.json.)

  // Averiguar a qué marca pertenece la tanda y reconstruir su memoria.
  let marcaId = null;
  for (const f of ['contenido.json', 'contenido.analizado.json']) {
    try {
      const c = JSON.parse(await readFile(path.join(tandaDir, f), 'utf-8'));
      marcaId = c._marca || marcaId;
      if (marcaId) break;
    } catch {}
  }
  if (!marcaId) return null;
  return reconstruirMemoria(marcaId);
}

// ── Contexto para el prompt de crear.mjs ─────────────────────────────────────
// Lee memoria.json y devuelve un resumen ejecutivo ≤300 tokens. Guía sin
// constreñir. Si no hay memoria útil, devuelve '' (el sistema sigue igual que hoy).
export async function memoriaParaPrompt(marcaId) {
  let mem;
  try {
    mem = JSON.parse(await readFile(memoriaPath(marcaId), 'utf-8'));
  } catch {
    return '';
  }
  if (!mem.tandas_analizadas) return '';

  const lista = (arr, max = 2) => (arr || []).slice(0, max).map(x => x.clave).filter(Boolean);
  const g = mem.ganadores || {};
  const d = mem.descartados || {};

  const funciona = [];
  if (lista(g.paletas).length)     funciona.push(`paletas ${lista(g.paletas).join(' / ')}`);
  if (lista(g.tipografias).length) funciona.push(`tipografías ${lista(g.tipografias).join(' / ')}`);
  if (lista(g.tipos_slide, 3).length) funciona.push(`slides ${lista(g.tipos_slide, 3).join(', ')}`);

  const evitar = [];
  // Sólo señalamos como "evitar" lo que aparece en descartados y NO en ganadores.
  const ganadorasPaletas = new Set(lista(g.paletas, 5));
  const malasPaletas = lista(d.paletas, 3).filter(p => !ganadorasPaletas.has(p));
  if (malasPaletas.length) evitar.push(`paletas ${malasPaletas.join(' / ')}`);
  const ganadorasTipos = new Set(lista(g.tipos_slide, 5));
  const malosTipos = lista(d.tipos_slide, 3).filter(t => !ganadorasTipos.has(t));
  if (malosTipos.length) evitar.push(`exceso de slides ${malosTipos.join(', ')}`);

  if (!funciona.length && !evitar.length) return '';

  let out = `\nMEMORIA DE MARCA (señales reales de ${mem.tandas_analizadas} carrusel(es) guardados/descargados/descartados — orientativo, NO una plantilla rígida):\n`;
  if (funciona.length) out += `- Funcionó bien (replicá el espíritu, no copies exacto): ${funciona.join('; ')}.\n`;
  if (evitar.length)   out += `- Tendió a descartarse (evitá repetir): ${evitar.join('; ')}.\n`;
  // Variedad forzada: evita el loop de feedback que congela a la marca en un solo look.
  out += `- IMPORTANTE: no te quedes atrapado en un único estilo. Tomá esto como referencia de lo que conecta con la marca, pero introducí variación deliberada en al menos un eje (composición, tipo de cover o ritmo de slides) para no volverte repetitivo.\n`;
  return out;
}
