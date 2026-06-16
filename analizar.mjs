/**
 * analizar.mjs v3 — Sistema de diseño completo con IA
 *
 * Uso:
 *   node analizar.mjs [contenido.json]
 *
 * Fases:
 *   1. Lee el contenido y detecta tema/tono
 *   2. Investiga tendencias + fuentes + iconos + paletas en la web
 *   3. Define el sistema de diseño completo para este carrusel
 *   4. Analiza cada foto individualmente con ese sistema como guía
 *   5. Genera contenido.analizado.json listo para renderizar
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 5 * 1024 * 1024; // límite de la API para imágenes en base64

// ─────────────────────────────────────────────────────────────────────
// PREVIEW EN VIVO — si se pasa --preview, cada fase emite eventos a
// preview-server.mjs (debe estar corriendo en paralelo) vía HTTP POST.
// Si el servidor no está levantado, los POST fallan en silencio.
// ─────────────────────────────────────────────────────────────────────
const PREVIEW = process.argv.includes('--preview');
const PREVIEW_PORT = process.env.PREVIEW_PORT || 5390;

function broadcast(type, payload) {
  if (!PREVIEW) return;
  fetch(`http://localhost:${PREVIEW_PORT}/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, payload }),
  }).catch(() => {});
}

// Carga el perfil de marca (marca.json) si existe — define voz, audiencia,
// palabras a evitar y paleta de referencia para mantener coherencia entre carruseles
async function loadMarca(marcaId) {
  try {
    return JSON.parse(await readFile(path.join(__dirname, 'marcas', marcaId, 'marca.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function marcaContext(marca) {
  if (!marca) return '';
  return `
CONTEXTO DE MARCA (mantené coherencia con esto):
- Marca: ${marca.nombre} — ${marca.industria}
- Audiencia: ${marca.audiencia}
- Posicionamiento: ${marca.posicionamiento}
- Voz y tono: ${marca.voz}
- Palabras/clichés a evitar: ${marca.evitar?.join(', ')}
- Paleta de referencia: fondo ${marca.paleta_marca?.fondo}, acento ${marca.paleta_marca?.acento} (${marca.paleta_marca?.descripcion})
`;
}

// Convierte una imagen a base64, achicando si hace falta para no superar el
// límite de tamaño de la API (esto es solo para el análisis, el render
// final usa la foto original a full calidad)
async function fileToBase64(abs) {
  let buf = await readFile(abs);

  // La extensión del archivo no siempre coincide con el formato real
  // (ej. screenshots de iPhone guardados como .PNG que en realidad son JPEG) —
  // la API rechaza el request si el mime declarado no matchea el contenido.
  const { format } = await sharp(buf).metadata();
  let mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format] || 'image/jpeg';

  if (Buffer.byteLength(buf.toString('base64')) > MAX_BYTES) {
    buf = await sharp(buf).resize({ width: 1568, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    mime = 'image/jpeg';
  }

  return { base64: buf.toString('base64'), mime };
}

async function photoToBase64(relPath) {
  return fileToBase64(path.join(__dirname, 'fotos', relPath));
}

// Carga carruseles de referencia (referencias/*.jpg|png|webp) que el usuario
// quiere usar como inspiración visual para la Fase 2
async function loadReferencias(marcaId) {
  const dir = path.join(__dirname, 'marcas', marcaId, 'referencias');
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const imgs = files.filter(f => /\.(jpe?g|png|webp)$/i.test(f));
  const out = [];
  for (const f of imgs) {
    out.push(await fileToBase64(path.join(dir, f)));
  }
  return out;
}

// Persona aplicada a todas las llamadas — fija el nivel de criterio esperado
// para que las 3 fases respondan con la misma vara de "experto", no genérica
const SYSTEM_PROMPT = `Sos un equipo de élite de 2 personas trabajando como una sola: un director de arte senior con más de 15 años en agencias top de contenido para Instagram, y un estratega de marketing/copywriting senior especializado en marcas personales de fitness y coaching premium.

Como director de arte conocés a fondo: tipografía editorial (qué combinaciones de Google Fonts realmente funcionan juntas y por qué), paletas de alto contraste que generan guardados/shares, tendencias visuales actuales de carruseles que performan (no las de hace 3 años), y cómo traducir un sistema de diseño en decisiones de CSS concretas y aplicables.

Como estratega de marketing entendés copywriting persuasivo, niveles de consciencia de audiencia (Schwartz), psicología del scroll-stop, y cómo cada decisión visual (jerarquía, contraste, posición del texto) sirve al objetivo de retención y conversión del carrusel — no es decoración, es estrategia aplicada.

Tus respuestas son siempre específicas y accionables — nunca genéricas, nunca "depende". Si te piden un valor (hex, font-family, line-height), das el valor exacto, no un rango ni una sugerencia vaga.

Respondés SIEMPRE en el formato exacto solicitado (JSON puro, sin \`\`\`markdown\`\`\` ni texto antes o después), sin explicaciones adicionales fuera del JSON.`;

// Llama a Blackbox AI (API OpenAI-compatible) y devuelve el texto de la respuesta
async function callBlackbox(content) {
  const apiKey = process.env.BLACKBOX_API_KEY;
  if (!apiKey) throw new Error('Falta la variable de entorno BLACKBOX_API_KEY');

  const model = process.env.BLACKBOX_MODEL || 'blackboxai/anthropic/claude-sonnet-4.6';

  const response = await fetch('https://api.blackbox.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Blackbox API error: ${data.error?.message || JSON.stringify(data)}`);
  }
  return data.choices?.[0]?.message?.content || '';
}

// La IA a veces devuelve saltos de línea/tabs literales y comillas rectas
// sin escapar dentro de los strings del JSON (válido en texto plano,
// inválido en JSON estricto). Los arreglamos sin tocar el resto del documento.
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
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    if (inString && ch === '\n') { out += '\\n'; continue; }
    if (inString && ch === '\r') { out += '\\r'; continue; }
    if (inString && ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// FASE 1 — Detectar tema y tono del carrusel
// ─────────────────────────────────────────────────────────────────────
async function detectarTemaTono(slides, marca) {
  const resumen = slides.map(s => {
    const partes = [s.type, s.headline, s.body, s.quote, s.eyebrow, s.sub]
      .filter(Boolean).join(' | ');
    return partes;
  }).join('\n');

  const text = await callBlackbox(`Analizá este contenido de carrusel de Instagram de marca personal fitness/coaching y detectá su esencia.
${marcaContext(marca)}
CONTENIDO:
${resumen}

Devolvé SOLO JSON (sin markdown):
{
  "tema": "una palabra: entorno|disciplina|nutricion|entrenamiento|mentalidad|lifestyle|negocio|otro",
  "tono": "una palabra: motivacional|educativo|reflexivo|agresivo|aspiracional|intimo",
  "estilo_visual_ideal": "editorial_brutal|photo_lifestyle|infografico_premium",
  "razon": "por qué ese estilo para este contenido específico",
  "palabras_clave_visuales": ["3 a 5 palabras que describen la estética ideal de este carrusel"]
}`);

  try {
    return JSON.parse(sanitizeJson(text.replace(/```json|```/g, '').trim()));
  } catch {
    return { tema: 'fitness', tono: 'motivacional', estilo_visual_ideal: 'editorial_brutal', palabras_clave_visuales: ['bold', 'oscuro', 'premium'] };
  }
}

// ─────────────────────────────────────────────────────────────────────
// FASE 2 — Investigar y definir sistema de diseño completo
// ─────────────────────────────────────────────────────────────────────
async function definirSistemaDiseño(temaInfo, marca, referencias) {
  const { tema, tono, estilo_visual_ideal, palabras_clave_visuales } = temaInfo;

  console.log(`\n🔍 Definiendo sistema de diseño para estilo "${estilo_visual_ideal}" (${tema}/${tono})...`);
  if (referencias?.length) console.log(`  🖼  Usando ${referencias.length} carrusel(es) de referencia como inspiración`);

  const promptText = `Sos director de arte de una agencia top especializada en contenido viral de Instagram para marca personal fitness.
${marcaContext(marca)}
El carrusel que tenés que diseñar es:
- Tema: ${tema}
- Tono: ${tono}
- Estilo visual ideal: ${estilo_visual_ideal}
- Palabras clave visuales: ${palabras_clave_visuales?.join(', ')}

Definí el sistema de diseño COMPLETO y ESPECÍFICO. Sé milimétrico, no genérico.
${marca ? 'La paleta debe sentirse parte de la familia visual de la marca (ver paleta de referencia arriba), aunque puede variar según el tema/tono de este carrusel específico.' : ''}
${referencias?.length ? 'Te paso además imágenes de carruseles que le gustaron al cliente. Extraé de ahí el lenguaje visual (tipografía, paleta, iconografía, composición) y aplicalo a este sistema — no los copies literal, usalos como dirección de arte.' : ''}

Para tipografía, elegí fuentes reales disponibles en Google Fonts que funcionen para este estilo específico.
Para iconos, elegí caracteres Unicode o SVG paths específicos (no librerías externas).
Para colores, dá hex exactos.

Devolvé SOLO JSON (sin markdown):
{
  "tipografia": {
    "display": {
      "familia": "nombre exacto en Google Fonts",
      "url_import": "URL completa para @import de Google Fonts",
      "pesos": [900, 700],
      "uso": "para qué elementos",
      "css_headline": "font-family: ...; font-weight: 900; letter-spacing: -0.03em; text-transform: uppercase;"
    },
    "body": {
      "familia": "nombre exacto en Google Fonts",
      "url_import": "URL completa para @import",
      "pesos": [400, 500, 600],
      "uso": "para qué elementos",
      "css_body": "font-family: ...; font-weight: 500; letter-spacing: 0.01em;"
    },
    "mono": {
      "familia": "nombre exacto en Google Fonts o system-ui monospace",
      "url_import": "URL o null si es system",
      "uso": "tags, números, handles"
    }
  },
  "paleta": {
    "fondo": "#hex",
    "headline": "#hex",
    "body_text": "rgba o #hex con opacidad",
    "acento": "#hex — color de énfasis para líneas, kickers, divisores",
    "secundario": "#hex o rgba — textos terciarios, números, handles",
    "descripcion": "nombre del esquema de color y por qué funciona para este tono"
  },
  "iconos": {
    "flecha_derecha": "carácter Unicode o SVG path",
    "check": "carácter Unicode o SVG path",
    "numero_estilo": "circle|plain|bracket — cómo mostrar números en listas",
    "divisor_estilo": "line|dot|slash — separador entre elementos",
    "decorativo": "carácter o símbolo que refuerza el tema del carrusel"
  },
  "tratamiento_fotos": {
    "overlay_base": 0.0,
    "gradiente_default": "top_heavy|bottom_heavy|both|center_clear",
    "blend_mode": "normal|multiply|screen — si aplica sobre la foto",
    "saturacion_ajuste": "normal|reducir|aumentar",
    "descripcion": "cómo tratar las fotos para que el estilo sea coherente"
  },
  "layout": {
    "padding_slide": "valor en px",
    "espacio_entre_elementos": "valor en px",
    "alineacion_texto": "left|center|right",
    "posicion_tag": "top-left|top-right",
    "posicion_footer": "bottom-left|bottom-right|bottom-center",
    "headline_line_height": 0.0,
    "body_line_height": 0.0
  },
  "efectos": {
    "usar_glass": false,
    "usar_text_shadow": true,
    "text_shadow_default": "suave|medio|fuerte",
    "usar_borde_acento": false,
    "animacion_css": null
  },
  "reglas_estilo": [
    "regla 1 que define este sistema visual",
    "regla 2...",
    "regla 3..."
  ],
  "nombre_sistema": "nombre corto y descriptivo del sistema de diseño definido"
}`;

  const content = referencias?.length
    ? [...referencias.map(r => ({ type: 'image_url', image_url: { url: `data:${r.mime};base64,${r.base64}` } })), { type: 'text', text: promptText }]
    : promptText;

  const text = await callBlackbox(content);

  if (!text) return getDefaultDesignSystem(estilo_visual_ideal);

  try {
    const sistema = JSON.parse(sanitizeJson(text.replace(/```json|```/g, '').trim()));
    console.log(`  ✓ Sistema "${sistema.nombre_sistema}" definido`);
    console.log(`  🔤 Display: ${sistema.tipografia?.display?.familia} | Body: ${sistema.tipografia?.body?.familia}`);
    console.log(`  🎨 Paleta: fondo ${sistema.paleta?.fondo} | acento ${sistema.paleta?.acento}`);
    if (sistema.reglas_estilo?.length) {
      console.log(`  📐 Reglas:`);
      sistema.reglas_estilo.forEach(r => console.log(`     • ${r}`));
    }
    return sistema;
  } catch {
    console.log('  ⚠ Usando sistema default');
    return getDefaultDesignSystem(estilo_visual_ideal);
  }
}

function getDefaultDesignSystem(estilo) {
  const sistemas = {
    editorial_brutal: {
      nombre_sistema: 'Editorial Brutal',
      tipografia: {
        display: {
          familia: 'Bebas Neue',
          url_import: 'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap',
          pesos: [400],
          uso: 'headlines principales',
          css_headline: "font-family: 'Bebas Neue', sans-serif; font-weight: 400; letter-spacing: 0.02em; text-transform: uppercase;"
        },
        body: {
          familia: 'Inter',
          url_import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
          pesos: [400, 500, 600, 700],
          uso: 'cuerpo, subtítulos, listas',
          css_body: "font-family: 'Inter', sans-serif; font-weight: 500;"
        },
        mono: { familia: 'monospace', url_import: null, uso: 'tags, números, handles' }
      },
      paleta: {
        fondo: '#0a0a0a',
        headline: '#ffffff',
        body_text: 'rgba(255,255,255,0.82)',
        acento: '#e8ff00',
        secundario: 'rgba(255,255,255,0.28)',
        descripcion: 'Negro absoluto con acento amarillo neón — máximo contraste, energía, brutalismo editorial'
      },
      iconos: {
        flecha_derecha: '→',
        check: '✓',
        numero_estilo: 'plain',
        divisor_estilo: 'line',
        decorativo: '▪'
      },
      tratamiento_fotos: {
        overlay_base: 0.65,
        gradiente_default: 'top_heavy',
        blend_mode: 'normal',
        saturacion_ajuste: 'normal',
        descripcion: 'Overlay oscuro denso, gradiente top-heavy, foto como textura de fondo poderosa'
      },
      layout: {
        padding_slide: '108',
        espacio_entre_elementos: '75',
        alineacion_texto: 'left',
        posicion_tag: 'top-left',
        posicion_footer: 'bottom-left',
        headline_line_height: 0.88,
        body_line_height: 1.75
      },
      efectos: {
        usar_glass: false,
        usar_text_shadow: true,
        text_shadow_default: 'medio',
        usar_borde_acento: true,
        animacion_css: null
      },
      reglas_estilo: [
        'Sin glass morphism, nunca',
        'Headline siempre uppercase con Bebas Neue, sin excepciones',
        'Acento amarillo solo en elementos de énfasis: kicker line, divisor, número activo',
        'Máximo 2 niveles de gris en el mismo slide',
        'Fotos siempre oscurecidas, nunca compiten con el texto'
      ]
    },
    photo_lifestyle: {
      nombre_sistema: 'Photo Lifestyle',
      tipografia: {
        display: {
          familia: 'Playfair Display',
          url_import: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&display=swap',
          pesos: [700, 900],
          uso: 'headlines, citas',
          css_headline: "font-family: 'Playfair Display', serif; font-weight: 700; letter-spacing: -0.01em;"
        },
        body: {
          familia: 'DM Sans',
          url_import: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&display=swap',
          pesos: [300, 400, 500],
          uso: 'cuerpo, detalles',
          css_body: "font-family: 'DM Sans', sans-serif; font-weight: 400; letter-spacing: 0.02em;"
        },
        mono: { familia: 'monospace', url_import: null, uso: 'tags, handles' }
      },
      paleta: {
        fondo: '#0d0d0d',
        headline: '#f5f0e8',
        body_text: 'rgba(245,240,232,0.72)',
        acento: '#c8a96e',
        secundario: 'rgba(245,240,232,0.32)',
        descripcion: 'Negro cálido con crema y dorado — lifestyle premium, editorial de revista'
      },
      iconos: {
        flecha_derecha: '›',
        check: '·',
        numero_estilo: 'plain',
        divisor_estilo: 'dot',
        decorativo: '—'
      },
      tratamiento_fotos: {
        overlay_base: 0.45,
        gradiente_default: 'both',
        blend_mode: 'normal',
        saturacion_ajuste: 'reducir',
        descripcion: 'Overlay suave, foto respira y comunica, texto mínimo sobre zonas limpias'
      },
      layout: {
        padding_slide: '96',
        espacio_entre_elementos: '64',
        alineacion_texto: 'left',
        posicion_tag: 'top-left',
        posicion_footer: 'bottom-left',
        headline_line_height: 1.05,
        body_line_height: 1.85
      },
      efectos: {
        usar_glass: false,
        usar_text_shadow: true,
        text_shadow_default: 'suave',
        usar_borde_acento: false,
        animacion_css: null
      },
      reglas_estilo: [
        'La foto es la protagonista, el texto la acompaña',
        'Serif elegante para headlines, sans liviana para body',
        'Acento dorado solo en elementos de jerarquía',
        'Nunca uppercase en headlines de este estilo',
        'Mucho espacio en blanco, nada saturado'
      ]
    },
    infografico_premium: {
      nombre_sistema: 'Infográfico Premium',
      tipografia: {
        display: {
          familia: 'Space Grotesk',
          url_import: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&display=swap',
          pesos: [700],
          uso: 'números grandes, headlines',
          css_headline: "font-family: 'Space Grotesk', sans-serif; font-weight: 700; letter-spacing: -0.02em;"
        },
        body: {
          familia: 'Inter',
          url_import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap',
          pesos: [400, 500, 600],
          uso: 'explicaciones, labels, items',
          css_body: "font-family: 'Inter', sans-serif; font-weight: 500; letter-spacing: 0.005em;"
        },
        mono: { familia: 'JetBrains Mono', url_import: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap', uso: 'datos, porcentajes, códigos' }
      },
      paleta: {
        fondo: '#0f0f12',
        headline: '#ffffff',
        body_text: 'rgba(255,255,255,0.78)',
        acento: '#6c63ff',
        secundario: 'rgba(255,255,255,0.32)',
        descripcion: 'Negro azulado con acento púrpura — tech premium, datos limpios, confianza'
      },
      iconos: {
        flecha_derecha: '→',
        check: '✦',
        numero_estilo: 'circle',
        divisor_estilo: 'slash',
        decorativo: '◆'
      },
      tratamiento_fotos: {
        overlay_base: 0.72,
        gradiente_default: 'full',
        blend_mode: 'normal',
        saturacion_ajuste: 'reducir',
        descripcion: 'Overlay denso, fotos casi como texturas, datos y gráficos son los protagonistas'
      },
      layout: {
        padding_slide: '96',
        espacio_entre_elementos: '56',
        alineacion_texto: 'left',
        posicion_tag: 'top-right',
        posicion_footer: 'bottom-left',
        headline_line_height: 0.95,
        body_line_height: 1.65
      },
      efectos: {
        usar_glass: true,
        usar_text_shadow: false,
        text_shadow_default: 'suave',
        usar_borde_acento: true,
        animacion_css: null
      },
      reglas_estilo: [
        'Datos y números son los héroes visuales',
        'Mono para cualquier número o dato específico',
        'Glass solo en elementos de datos, nunca en texto corrido',
        'Acento para highlighting de información clave',
        'Estructura visible: el layout mismo comunica jerarquía'
      ]
    }
  };
  return sistemas[estilo] || sistemas.editorial_brutal;
}

// ─────────────────────────────────────────────────────────────────────
// FASE 3 — Analizar cada slide con foto + sistema de diseño definido
// ─────────────────────────────────────────────────────────────────────
async function analizarSlideConIA(slide, base64, mime, sistema, temaInfo) {
  const contenido = JSON.stringify({
    type: slide.type,
    headline: slide.headline,
    detail: slide.detail,
    kicker: slide.kicker,
    body: slide.body,
    quote: slide.quote,
    attr: slide.attr,
    sub: slide.sub,
  }, null, 2);

  const prompt = `Sos director de arte aplicando el sistema de diseño "${sistema.nombre_sistema}".

SISTEMA DE DISEÑO DEFINIDO:
- Fuente display: ${sistema.tipografia?.display?.familia}
- Fuente body: ${sistema.tipografia?.body?.familia}
- Fondo: ${sistema.paleta?.fondo} | Headline: ${sistema.paleta?.headline} | Acento: ${sistema.paleta?.acento}
- Overlay base: ${sistema.tratamiento_fotos?.overlay_base}
- Gradiente default: ${sistema.tratamiento_fotos?.gradiente_default}
- Glass: ${sistema.efectos?.usar_glass ? 'SÍ' : 'NO'}
- Shadow default: ${sistema.efectos?.text_shadow_default}
- Reglas: ${sistema.reglas_estilo?.join(' | ')}

CONTENIDO DE LA SLIDE:
${contenido}

Analizá la imagen con precisión y devolvé SOLO JSON (sin markdown) con ajustes ESPECÍFICOS para esta foto dentro del sistema:

{
  "zonas": {
    "descripcion": "composición exacta: sujeto, zonas claras/oscuras, puntos de interés",
    "top_luminancia": "oscuro|claro|mixto",
    "middle_luminancia": "oscuro|claro|mixto",
    "bottom_luminancia": "oscuro|claro|mixto"
  },
  "sujeto": {
    "posicion": "izquierda|derecha|centro|sin_sujeto",
    "ocupa_zona": "top|middle|bottom|full",
    "evitar_zona": "top|middle|bottom|ninguna"
  },
  "ajustes_foto": {
    "overlay_ajustado": 0.0,
    "gradiente_ajustado": "top_heavy|bottom_heavy|both|center_clear|full",
    "razon": "por qué este ajuste específico para esta foto"
  },
  "ajustes_texto": {
    "posicion": "top|middle|bottom",
    "text_shadow": "suave|medio|fuerte",
    "glass_necesario": false,
    "glass_opacidad": 0.0,
    "headline_size": "normal|reducir_10|reducir_20|aumentar_10",
    "razon": "decisión milimétrica basada en la composición real"
  },
  "recomendacion": "una línea específica para hacer esta slide irresistible",
  "layout_sugerido": "null o uno de: cover-top|cover-center|cover-split|list-full|list-compact|list-hero|statement-anchored|statement-top|statement-impact|split-full|quote-dominant|quote-centered|cta-top|cta-center|cta-impact — solo si la lógica default no es la mejor opción para esta foto específica"
}`;

  const text = await callBlackbox([
    { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
    { type: 'text', text: prompt }
  ]);

  try {
    return JSON.parse(sanitizeJson(text.replace(/```json|```/g, '').trim()));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// FASE 3B — Análisis de composición para modelos multi-foto
// (split_v, triple_v): cada foto se analiza individualmente para decidir
// en qué esquina va el bloque de texto sin tapar al sujeto.
// ─────────────────────────────────────────────────────────────────────
async function analizarComposicionFoto(base64, mime) {
  const prompt = `Vas a superponer un bloque de texto (label corto + headline grande, en una esquina) sobre esta foto de un carrusel de fitness/coaching.

Analizá la composición y elegí la esquina donde el texto NO tape a la persona, su cara, ni el elemento principal de la imagen.

Devolvé SOLO JSON (sin markdown):
{
  "zona_texto_h": "left|right",
  "zona_texto_v": "top|bottom",
  "razon": "una línea: qué hay en cada zona de la foto y por qué esa esquina es la mejor para el texto"
}`;

  const text = await callBlackbox([
    { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
    { type: 'text', text: prompt }
  ]);

  try {
    return JSON.parse(sanitizeJson(text.replace(/```json|```/g, '').trim()));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// FASE 4 — Elegir layout óptimo por slide
// Resuelve: espacio muerto, texto mal anclado, columnas flotando
// ─────────────────────────────────────────────────────────────────────
function elegirLayout(slide, analisis, sistema) {
  const tipo  = slide.type;
  const foto  = !!slide.photo;
  const items = slide.items?.length || 0;
  const tono  = (sistema.nombre_sistema || '').toLowerCase();

  // La IA puede haber sugerido un layout en el análisis — respetarlo si existe
  if (analisis?.layout_sugerido) return analisis.layout_sugerido;

  switch (tipo) {
    case 'cover':
      if (foto) return 'cover-top';
      if (slide.detail && slide.detail.length > 60) return 'cover-split';
      return 'cover-center';

    case 'list':
      // 5+ items → full distribuye en todo el alto, elimina negro muerto
      if (items >= 5) return 'list-full';
      if (tono.includes('infogr') || tono.includes('premium')) return 'list-hero';
      return 'list-compact';

    case 'statement': {
      const words = (slide.headline || '').split(/\s+/).length;
      if (foto) return 'statement-top';
      if (words <= 5 && slide.body && slide.body.length > 80) return 'statement-impact';
      return 'statement-anchored';
    }

    case 'split': {
      // Columnas cortas (≤2 items cada una) → compact, centrado, sin
      // estirar contenido para llenar el alto. 3+ items → full.
      const itemsLeft  = slide.left?.items?.length || 0;
      const itemsRight = slide.right?.items?.length || 0;
      if (itemsLeft <= 2 && itemsRight <= 2) return 'split-compact';
      return 'split-full';
    }

    case 'quote':
      // Con foto → dominant (quote XL arriba, attr+note anclados con línea acento abajo)
      return foto ? 'quote-dominant' : 'quote-centered';

    case 'cta': {
      if (foto) return 'cta-top';
      const ctaWords = (slide.headline || '').split(/\s+/).length;
      if (ctaWords <= 3) return 'cta-impact';
      // Sin foto, sin sub → headline + handle nomás: centrar todo el bloque
      // en vez de pinearlo arriba con espacio vacío hasta el footer.
      if (!slide.sub) return 'cta-center';
      return 'cta-top';
    }

    default:
      return tipo;
  }
}

function aplicarDecisiones(slide, analisis, sistema) {
  const s = { ...slide };

  // Layout elegido por lógica + posible sugerencia de la IA
  s._layout = elegirLayout(slide, analisis, sistema);

  // Del sistema de diseño global
  s._sistema = {
    nombre: sistema.nombre_sistema,
    font_display_familia: sistema.tipografia?.display?.familia,
    font_display_url: sistema.tipografia?.display?.url_import,
    font_display_css: sistema.tipografia?.display?.css_headline,
    font_body_familia: sistema.tipografia?.body?.familia,
    font_body_url: sistema.tipografia?.body?.url_import,
    font_body_css: sistema.tipografia?.body?.css_body,
    font_mono_familia: sistema.tipografia?.mono?.familia,
    font_mono_url: sistema.tipografia?.mono?.url_import,
    paleta: sistema.paleta,
    iconos: sistema.iconos,
    layout: sistema.layout,
    efectos: sistema.efectos,
  };

  // Del análisis específico de la foto
  if (analisis) {
    // El overlay plano se suma al degradé direccional (--grad) en el render
    // (dos capas oscuras apiladas) — por encima de ~0.6 el flat overlay solo
    // ya deja la foto en <40% de visibilidad incluso en zonas "transparentes"
    // del degradé, así que se cappea para que la foto no quede negra.
    s._overlay        = Math.min(analisis.ajustes_foto?.overlay_ajustado ?? sistema.tratamiento_fotos?.overlay_base ?? 0.65, 0.6);
    s._gradiente      = analisis.ajustes_foto?.gradiente_ajustado ?? sistema.tratamiento_fotos?.gradiente_default ?? 'top_heavy';
    s._textPosition   = analisis.ajustes_texto?.posicion ?? 'top';
    s._textShadow     = analisis.ajustes_texto?.text_shadow ?? sistema.efectos?.text_shadow_default ?? 'medio';
    s._glass          = analisis.ajustes_texto?.glass_necesario ?? sistema.efectos?.usar_glass ?? false;
    s._glassOpacidad  = analisis.ajustes_texto?.glass_opacidad ?? 0.78;
    s._headlineAjuste = analisis.ajustes_texto?.headline_size ?? 'normal';
    s._analisis = {
      zonas:         analisis.zonas,
      sujeto:        analisis.sujeto,
      recomendacion: analisis.recomendacion,
    };

    // Guardia de contraste: si la zona donde se ancla el texto quedó
    // "clara"/"mixta" y el overlay decidido es muy liviano, reforzar
    // overlay y sombra para que el texto siga siendo legible.
    const zonaLum = {
      top:    analisis.zonas?.top_luminancia,
      middle: analisis.zonas?.middle_luminancia,
      bottom: analisis.zonas?.bottom_luminancia,
    }[s._textPosition];
    if ((zonaLum === 'claro' || zonaLum === 'mixto') && s._overlay < 0.55) {
      s._overlay = Math.max(s._overlay, 0.6);
      if (s._textShadow === 'suave') s._textShadow = 'medio';
    }

    // Corrección de mismatch gradiente↔textPosition: las bandas casi
    // transparentes de top_heavy/bottom_heavy no deben coincidir con
    // la zona donde se ancla el texto.
    const gradTransparenteEn = { top_heavy: 'bottom', bottom_heavy: 'top' };
    if (gradTransparenteEn[s._gradiente] === s._textPosition || s._textPosition === 'middle') {
      if (s._gradiente === 'top_heavy' || s._gradiente === 'bottom_heavy') {
        s._gradiente = 'both';
      }
    }
  } else {
    // Sin foto — aplicar solo sistema
    s._overlay        = sistema.tratamiento_fotos?.overlay_base ?? 0.65;
    s._gradiente      = sistema.tratamiento_fotos?.gradiente_default ?? 'both';
    s._textPosition   = 'middle';
    s._textShadow     = sistema.efectos?.text_shadow_default ?? 'medio';
    s._glass          = sistema.efectos?.usar_glass ?? false;
    s._glassOpacidad  = 0.78;
    s._headlineAjuste = 'normal';
  }

  return s;
}

// ─────────────────────────────────────────────────────────────────────
// MODELO SELECTOR
// Detecta qué modelo visual usar para el carrusel completo según
// el tema, tono y estructura del contenido.
// Modelos: classic | split_v | full_impact | before_after | triple_v
// ─────────────────────────────────────────────────────────────────────
function elegirModeloCarrusel(slides, temaInfo) {
  const { tono } = temaInfo;
  const tiposNuevos = ['split_v', 'full_impact', 'before_after', 'triple_v'];

  // Si el usuario ya definió tipos nuevos manualmente → respetar
  if (slides.some(s => tiposNuevos.includes(s.type))) return 'mixed';

  const textos = slides
    .map(s => [s.headline, s.body, s.quote, s.eyebrow, s.sub, s.detail, s.kicker]
      .filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();

  // Antes/después: transformación, progreso, comparación temporal
  if (/antes|despu[eé]s|transform|result|progres|cambio/.test(textos) && slides.some(s => s.photo))
    return 'before_after';

  // Triple vertical: 3 estadísticas, porcentajes, etapas numeradas
  // (requiere una foto por fila — adaptarSlidesAModelo no las genera;
  // sin esto un carrusel 100% tipográfico puede convertirse a triple_v
  // y quedar con tv-bg sin imagen)
  if (/0%|100%|etapa|fase|paso [123]|nivel [123]/.test(textos) && slides.some(s => s.photo))
    return 'triple_v';

  // Full impact: tono agresivo + foto disponible
  if (['agresivo', 'motivacional'].includes(tono) && slides.some(s => s.photo))
    return 'full_impact';

  // Split vertical: comparación estadística, "el promedio vs la realidad"
  // (requiere foto para cada mitad — adaptarSlidesAModelo no las genera;
  // sin esto un carrusel 100% tipográfico puede convertirse a split_v
  // y quedar con las dos mitades sin imagen ni scrim)
  if (/promedio|media|normal|vs\.|versus|no [0-9]|sino|pero|en cambio/.test(textos) && slides.some(s => s.photo))
    return 'split_v';

  // Default: modelo clásico
  return 'classic';
}

// Adapta slides clásicas al modelo visual elegido cuando tiene sentido.
// Solo convierte la slide más apta para el modelo elegido (igual que
// full_impact con 'cover') — el resto sigue con su layout clásico.
// Las fotos (photo_top/bottom/before/after/rows[].photo) quedan sin asignar
// a propósito: se completan después a mano.
function adaptarSlidesAModelo(slides, modelo) {
  if (modelo === 'classic' || modelo === 'mixed') return slides;

  const tiposNuevos = ['split_v', 'full_impact', 'before_after', 'triple_v'];
  let convertida = false;

  return slides.map(slide => {
    if (tiposNuevos.includes(slide.type)) return slide;
    if (convertida) return slide;

    if (modelo === 'full_impact' && slide.type === 'cover') {
      convertida = true;
      return {
        ...slide,
        type:        'full_impact',
        line1:       slide.detail || '',
        line2:       slide.headline,
        footer_text: slide.kicker || '',
      };
    }

    if (modelo === 'split_v' && slide.type === 'split') {
      convertida = true;
      return {
        ...slide,
        type:            'split_v',
        label_top:       slide.left?.label || '',
        contrast_top:    (slide.left?.items || [])[0] || '',
        label_bottom:    slide.right?.label || '',
        contrast_bottom: (slide.right?.items || [])[0] || '',
      };
    }

    if (modelo === 'before_after' && (slide.type === 'split' || slide.type === 'statement')) {
      convertida = true;
      return {
        ...slide,
        type:         'before_after',
        label_before: 'ANTES',
        label_after:  'DESPUÉS',
        headline:     slide.headline || slide.left?.label || '',
        sub:          slide.body || (slide.right?.items || []).join(' · '),
      };
    }

    if (modelo === 'triple_v' && slide.type === 'list') {
      convertida = true;
      return {
        ...slide,
        type: 'triple_v',
        rows: (slide.items || []).slice(0, 3).map((item, idx) => ({
          num:  `0${idx + 1}`,
          text: item,
        })),
      };
    }

    return slide;
  });
}

// ─────────────────────────────────────────────────────────────────────
// MERGE INCREMENTAL
// Si ya existe un contenido.analizado.json previo, rescata las
// asignaciones manuales de fotos en slides multi-foto (split_v, triple_v,
// before_after) y slides clásicas con foto simple, que adaptarSlidesAModelo
// deja vacías a propósito para completar "a mano". Sin esto, cada
// re-análisis pisa esas asignaciones y rompe el output multi-foto.
// Solo se rescata si la slide nueva, en la misma posición, es del mismo
// tipo y no trae ya un valor propio para ese campo.
// ─────────────────────────────────────────────────────────────────────
function mergeAsignacionesManuales(slidesFinales, anterior) {
  if (!anterior?.slides) return slidesFinales;

  return slidesFinales.map((slide, i) => {
    const prev = anterior.slides[i];
    if (!prev || prev.type !== slide.type) return slide;

    if (slide.type === 'split_v') {
      const merged = { ...slide };
      for (const [photoKey, posKey] of [['photo_top', '_topPos'], ['photo_bottom', '_bottomPos']]) {
        if (!merged[photoKey] && prev[photoKey]) {
          merged[photoKey] = prev[photoKey];
          if (prev[posKey] && !merged[posKey]) merged[posKey] = prev[posKey];
        }
      }
      return merged;
    }

    if (slide.type === 'triple_v' && Array.isArray(slide.rows)) {
      const rows = slide.rows.map((row, j) => {
        const prevRow = prev.rows?.[j];
        if (!row.photo && prevRow?.photo) {
          return { ...row, photo: prevRow.photo, _pos: row._pos ?? prevRow._pos };
        }
        return row;
      });
      return { ...slide, rows };
    }

    if (slide.type === 'before_after') {
      const merged = { ...slide };
      for (const photoKey of ['photo_before', 'photo_after']) {
        if (!merged[photoKey] && prev[photoKey]) merged[photoKey] = prev[photoKey];
      }
      return merged;
    }

    // slides clásicas con foto simple (cover, statement, quote, etc.)
    if (!slide.photo && prev.photo) {
      return { ...slide, photo: prev.photo };
    }

    return slide;
  });
}

// ─────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────
async function main() {
  const contentFile = process.argv[2] || 'contenido.json';
  const inputPath   = path.join(__dirname, contentFile);
  const raw         = JSON.parse(await readFile(inputPath, 'utf-8'));

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  CARRUSEL DESIGNER — IA v3');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  if (PREVIEW) console.log(`👁  Preview en vivo activado → http://localhost:${PREVIEW_PORT}\n`);

  broadcast('reset', {});

  const marcaId = raw._marca || 'squadteam';
  const marca = await loadMarca(marcaId);
  if (marca) console.log(`🏷  Marca: ${marca.nombre} — coherencia de voz/paleta activada`);

  // FASE 1: detectar tema y tono
  process.stdout.write('📖 Leyendo contenido...');
  broadcast('status', { message: '📖 Leyendo contenido...' });
  const temaInfo = await detectarTemaTono(raw.slides, marca);
  console.log(` ✓ Tema: ${temaInfo.tema} | Tono: ${temaInfo.tono} | Estilo: ${temaInfo.estilo_visual_ideal}`);
  console.log(`   Visual: ${temaInfo.palabras_clave_visuales?.join(', ')}`);
  console.log(`   ${temaInfo.razon}`);
  broadcast('status', { message: `✓ Tema: ${temaInfo.tema} | Tono: ${temaInfo.tono} | Estilo: ${temaInfo.estilo_visual_ideal}` });

  // FASE 2: definir sistema de diseño completo
  const referencias = await loadReferencias(marcaId);
  const sistema = await definirSistemaDiseño(temaInfo, marca, referencias);
  broadcast('sistema', { sistema, overlay: sistema.tratamiento_fotos?.overlay_base });
  broadcast('status', { message: `✓ Sistema "${sistema.nombre_sistema}" — ${sistema.tipografia?.display?.familia} + ${sistema.tipografia?.body?.familia}` });

  // FASE 2.5: elegir modelo visual + adaptar slides
  const modelo = raw._modelo || elegirModeloCarrusel(raw.slides, temaInfo);
  const slidesAdaptadas = adaptarSlidesAModelo(raw.slides, modelo);
  console.log(`\n🎭 Modelo visual: ${modelo.toUpperCase()}`);
  broadcast('status', { message: `🎭 Modelo visual: ${modelo.toUpperCase()}` });

  // FASE 3: analizar cada slide
  const tiposNuevos = ['split_v', 'full_impact', 'before_after', 'triple_v'];
  console.log(`\n🎨 Analizando ${slidesAdaptadas.length} slides...\n`);
  const slidesFinales = [];

  for (let i = 0; i < slidesAdaptadas.length; i++) {
    const slide = slidesAdaptadas[i];
    const num   = String(i + 1).padStart(2, '0');

    // split_v: dos fotos independientes — cada una se analiza para decidir
    // en qué esquina va su bloque de texto sin tapar al sujeto
    if (slide.type === 'split_v') {
      process.stdout.write(`  ◐ Slide ${num} (split_v) — analizando composición...`);
      broadcast('status', { message: `◐ Slide ${num} (split_v) — analizando composición de ambas fotos...` });
      const final = { ...slide, _sistema: { paleta: sistema.paleta, iconos: sistema.iconos } };
      const mitades = [['photo_top', '_topPos'], ['photo_bottom', '_bottomPos']];
      for (const [photoKey, posKey] of mitades) {
        if (!slide[photoKey]) continue;
        try {
          const { base64, mime } = await photoToBase64(slide[photoKey]);
          const comp = await analizarComposicionFoto(base64, mime);
          if (comp) {
            final[posKey] = { align: comp.zona_texto_h, valign: comp.zona_texto_v };
            if (comp.razon) console.log(`\n     💡 ${photoKey}: ${comp.razon}`);
          }
        } catch (err) {
          console.log(`\n     ✗ ${photoKey}: ${err.message}`);
        }
      }
      slidesFinales.push(final);
      console.log(' ✓');
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
      continue;
    }

    // triple_v: hasta 3 fotos independientes, una por fila
    if (slide.type === 'triple_v') {
      const totalRows = slide.rows?.length || 0;
      process.stdout.write(`  ◐ Slide ${num} (triple_v) — analizando composición de ${totalRows} fotos...`);
      broadcast('status', { message: `◐ Slide ${num} (triple_v) — analizando composición de ${totalRows} fotos...` });
      const rows = [];
      for (const row of slide.rows || []) {
        let pos = null;
        if (row.photo) {
          try {
            const { base64, mime } = await photoToBase64(row.photo);
            const comp = await analizarComposicionFoto(base64, mime);
            if (comp) {
              pos = { align: comp.zona_texto_h, valign: comp.zona_texto_v };
              if (comp.razon) console.log(`\n     💡 ${row.photo}: ${comp.razon}`);
            }
          } catch (err) {
            console.log(`\n     ✗ ${row.photo}: ${err.message}`);
          }
        }
        rows.push({ ...row, _pos: pos });
      }
      const final = { ...slide, rows, _sistema: { paleta: sistema.paleta, iconos: sistema.iconos } };
      slidesFinales.push(final);
      console.log(' ✓');
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
      continue;
    }

    // Slide sin foto ni tipo nuevo → sistema sin visión
    if (!slide.photo && !tiposNuevos.includes(slide.type)) {
      process.stdout.write(`  ○ Slide ${num} (${slide.type}) — sin foto, aplicando sistema...`);
      const final = aplicarDecisiones(slide, null, sistema);
      slidesFinales.push(final);
      console.log(' ✓');
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
      continue;
    }

    // Tipo nuevo que puede no tener photo directa
    const photoPath = slide.photo
      || slide.photo_top
      || slide.photo_bottom
      || slide.photo_before
      || slide.photo_after
      || null;

    if (!photoPath) {
      process.stdout.write(`  ○ Slide ${num} (${slide.type}) — sin foto, aplicando sistema...`);
      const final = tiposNuevos.includes(slide.type)
        ? { ...slide, _sistema: { paleta: sistema.paleta, iconos: sistema.iconos } }
        : aplicarDecisiones(slide, null, sistema);
      slidesFinales.push(final);
      console.log(' ✓');
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
      continue;
    }

    process.stdout.write(`  ◐ Slide ${num} (${slide.type}) — "${photoPath}"...`);
    broadcast('status', { message: `◐ Slide ${num} (${slide.type}) — analizando "${photoPath}"...` });
    try {
      const { base64, mime } = await photoToBase64(photoPath);
      const analisis = await analizarSlideConIA(slide, base64, mime, sistema, temaInfo);
      // full_impact tiene gradiente hardcodeado bottom-heavy (96% opaco al 100%).
      // Si el sujeto ocupa la zona media/baja, ese negro aplasta exactamente lo que
      // hay que mostrar. Lo convertimos a cover que sí respeta _gradiente/_textPosition.
      const slideParaDecisiones = (
        slide.type === 'full_impact' &&
        ['middle','bottom','full'].includes(analisis?.sujeto?.ocupa_zona)
      ) ? {
        ...slide,
        type: 'cover',
        headline: slide.line2 || slide.line1 || '',
        detail:   slide.line1 || '',
        kicker:   slide.footer_text || '',
        line1: undefined, line2: undefined, footer_text: undefined,
      } : slide;
      const final = aplicarDecisiones(slideParaDecisiones, analisis, sistema);
      slidesFinales.push(final);
      const pos = analisis?.ajustes_texto?.posicion || '?';
      const rec = analisis?.recomendacion || '';
      console.log(` ✓  [${pos}]`);
      if (rec) console.log(`     💡 ${rec}`);
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
      if (rec) broadcast('status', { message: `  💡 ${rec}` });
    } catch (err) {
      console.log(` ✗ ${err.message}`);
      const final = aplicarDecisiones(slide, null, sistema);
      slidesFinales.push(final);
      broadcast('slide', { slide: final, index: i, total: slidesAdaptadas.length });
    }
  }

  broadcast('status', { message: '✅ Análisis completo' });
  broadcast('done', {});

  const outName = contentFile.replace('.json', '.analizado.json');

  // Merge incremental: si hay un análisis previo, rescatar asignaciones
  // manuales de fotos (multi-foto y simples) antes de pisar el archivo.
  let anterior = null;
  try {
    anterior = JSON.parse(await readFile(path.join(__dirname, outName), 'utf-8'));
  } catch {}
  const slidesConMerge = mergeAsignacionesManuales(slidesFinales, anterior);
  if (anterior) console.log('\n🔄 Merge incremental: asignaciones manuales de fotos preservadas del análisis previo');

  const output = { ...raw, _sistema: sistema, _modelo: modelo, slides: slidesConMerge };
  await writeFile(path.join(__dirname, outName), JSON.stringify(output, null, 2), 'utf-8');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Modelo: ${modelo} | Sistema: "${sistema.nombre_sistema}" → ${outName}`);
  console.log(`   Fuentes: ${sistema.tipografia?.display?.familia} + ${sistema.tipografia?.body?.familia}`);
  console.log(`   Paleta: ${sistema.paleta?.fondo} → ${sistema.paleta?.acento}`);
  console.log(`   Corré: node generar.mjs ${outName}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(err => { console.error(err); process.exit(1); });
