/**
 * validar-contenido.mjs — Validación de esquema post-generación
 *
 * Compartido por crear.mjs y crear-story.mjs. Hace 3 cosas:
 *   A) Valida que cada slide tenga los campos obligatorios según su `type`.
 *   B) Valida/normaliza los íconos Material Symbols (reemplaza desconocidos).
 *   C) Expone helpers para reintentar slides individuales y para fabricar
 *      el slide de fallback tipográfico (item #2 del roadmap).
 *
 * No hace llamadas a la IA por sí mismo — recibe un `callBlackbox` para
 * poder reintentar slides individuales sin acoplar este módulo al transporte.
 */

// ── Lista de íconos Material Symbols conocidos ───────────────────────────────
// Cubre todos los que el prompt sugiere + los más comunes. Si la IA inventa
// uno que no está acá, lo reemplazamos por uno semánticamente similar o por
// un fallback genérico.
export const ICONOS_VALIDOS = new Set([
  // fitness / salud
  'fitness_center', 'sports', 'self_improvement', 'directions_run', 'monitor_heart',
  'nutrition', 'restaurant', 'water_drop', 'bedtime', 'nightlight', 'spa',
  'medical_services', 'local_fire_department', 'whatshot', 'mood', 'psychology',
  // progreso / métricas
  'trending_up', 'trending_down', 'bolt', 'flash_on', 'speed', 'timer', 'schedule',
  'insights', 'leaderboard', 'bar_chart', 'pie_chart', 'analytics', 'show_chart',
  'query_stats', 'monitoring',
  // logros / valor
  'emoji_events', 'star', 'workspace_premium', 'verified', 'military_tech',
  'celebration', 'rocket_launch', 'flag', 'key', 'lock', 'diamond', 'crown',
  // social / soporte
  'groups', 'group', 'person', 'person_add', 'handshake', 'support_agent',
  'thumb_up', 'favorite', 'chat', 'forum', 'public',
  // acciones / proceso
  'check_circle', 'check', 'done_all', 'search', 'lightbulb', 'school',
  'shield', 'eco', 'savings', 'payments', 'credit_card', 'storefront',
  'inventory_2', 'delivery_dining', 'settings', 'build', 'tune', 'autorenew',
  'add_circle', 'play_circle', 'arrow_forward', 'visibility', 'calendar_month',
  'event', 'task_alt', 'campaign', 'volume_up', 'info', 'help', 'warning',
]);

// Mapa de sinónimos comunes → ícono válido. La IA suele inventar nombres
// plausibles pero inexistentes; los redirigimos al equivalente real.
const SINONIMOS = {
  dumbbell: 'fitness_center', gym: 'fitness_center', muscle: 'fitness_center',
  brain: 'psychology', mind: 'psychology', focus: 'psychology',
  energy: 'bolt', lightning: 'bolt', power: 'bolt',
  growth: 'trending_up', increase: 'trending_up', grow: 'trending_up', up: 'trending_up',
  decrease: 'trending_down', down: 'trending_down',
  trophy: 'emoji_events', award: 'emoji_events', win: 'emoji_events', medal: 'military_tech',
  fire: 'local_fire_department', flame: 'local_fire_department', hot: 'whatshot',
  food: 'restaurant', meal: 'restaurant', diet: 'nutrition', water: 'water_drop',
  sleep: 'bedtime', moon: 'nightlight', rest: 'bedtime',
  heart: 'favorite', love: 'favorite', health: 'monitor_heart', heartbeat: 'monitor_heart',
  clock: 'schedule', time: 'schedule', stopwatch: 'timer', calendar: 'calendar_month',
  run: 'directions_run', running: 'directions_run', cardio: 'directions_run',
  people: 'groups', team: 'groups', community: 'groups', users: 'groups',
  rocket: 'rocket_launch', launch: 'rocket_launch', start: 'rocket_launch',
  check_mark: 'check_circle', checkmark: 'check_circle', tick: 'check_circle', ok: 'check_circle',
  idea: 'lightbulb', bulb: 'lightbulb', tip: 'lightbulb',
  goal: 'flag', target: 'flag', objective: 'flag',
  money: 'payments', cash: 'payments', dollar: 'payments', price: 'payments',
  trust: 'verified', certified: 'verified', badge: 'workspace_premium', premium: 'workspace_premium',
  protect: 'shield', security: 'shield', guard: 'shield',
  nature: 'eco', green: 'eco', leaf: 'eco', plant: 'eco',
  chart: 'bar_chart', graph: 'show_chart', stats: 'insights', data: 'analytics',
  speedometer: 'speed', fast: 'speed', quick: 'bolt',
  support: 'support_agent', help_center: 'support_agent', assistance: 'support_agent',
  star_rate: 'star', rating: 'star', favorite_star: 'star',
  learn: 'school', education: 'school', knowledge: 'school', book: 'school',
  meditation: 'self_improvement', yoga: 'self_improvement', mindfulness: 'self_improvement',
  store: 'storefront', shop: 'storefront', cart: 'storefront',
  deliver: 'delivery_dining', shipping: 'delivery_dining',
};

const FALLBACK_ICON = 'info';

// Normaliza un único valor de ícono. Devuelve siempre un ícono válido.
export function normalizarIcono(icon) {
  if (!icon || typeof icon !== 'string') return FALLBACK_ICON;
  const key = icon.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (ICONOS_VALIDOS.has(key)) return key;
  if (SINONIMOS[key]) return SINONIMOS[key];
  // Coincidencia parcial: si el nombre contiene una palabra clave conocida
  for (const valido of ICONOS_VALIDOS) {
    if (key.includes(valido) || valido.includes(key)) return valido;
  }
  return FALLBACK_ICON;
}

// Recorre un slide y normaliza todos los campos `icon` que contenga
// (en el slide, en items[], en cells[]).
export function normalizarIconosSlide(slide) {
  if (!slide || typeof slide !== 'object') return slide;
  if (typeof slide.icon === 'string') slide.icon = normalizarIcono(slide.icon);
  for (const arrKey of ['items', 'cells', 'rows', 'steps']) {
    if (Array.isArray(slide[arrKey])) {
      slide[arrKey].forEach(el => {
        if (el && typeof el === 'object' && typeof el.icon === 'string') {
          el.icon = normalizarIcono(el.icon);
        }
      });
    }
  }
  return slide;
}

// ── Validación de campos obligatorios por tipo de slide ──────────────────────
// Devuelve null si el slide es válido, o un string describiendo el problema.
export function validarSlide(slide) {
  if (!slide || typeof slide !== 'object') return 'slide no es un objeto';
  if (!slide.type) return 'falta el campo "type"';

  const hayTexto = (...campos) => campos.some(c => typeof slide[c] === 'string' && slide[c].trim());
  const arr = (k) => Array.isArray(slide[k]) ? slide[k] : null;

  switch (slide.type) {
    case 'cover':
      if (!hayTexto('headline') && !(arr('headline_lines') && slide.headline_lines.length))
        return 'cover sin "headline" ni "headline_lines"';
      return null;

    case 'list': {
      const items = arr('items');
      if (!items || items.length < 2) return 'list necesita "items[]" (mínimo 2)';
      return null;
    }

    case 'statement':
      if (!hayTexto('headline')) return 'statement sin "headline"';
      return null;

    case 'split':
      if (!slide.left || !slide.right) return 'split necesita "left" y "right"';
      if (!Array.isArray(slide.left.items) || !Array.isArray(slide.right.items))
        return 'split: left/right necesitan "items[]"';
      return null;

    case 'quote':
      if (!hayTexto('quote')) return 'quote sin "quote"';
      return null;

    case 'cta':
      if (!hayTexto('headline')) return 'cta sin "headline"';
      return null;

    case 'big_number':
      if (!hayTexto('stat')) return 'big_number sin "stat"';
      if (!hayTexto('label')) return 'big_number sin "label"';
      return null;

    case 'timeline': {
      const steps = arr('steps');
      if (!steps || !steps.length) return 'timeline necesita "steps[]"';
      if (!steps.every(s => s && typeof s.text === 'string' && s.text.trim()))
        return 'timeline: cada step necesita "text"';
      return null;
    }

    case 'grid': {
      const cells = arr('cells');
      if (!cells || !cells.length) return 'grid necesita "cells[]"';
      if (!cells.every(c => c && (typeof c.label === 'string' || typeof c.text === 'string')))
        return 'grid: cada cell necesita "label" o "text"';
      return null;
    }

    case 'grid_stats': {
      const items = arr('items');
      if (!items || !items.length) return 'grid_stats necesita "items[]"';
      if (!items.every(it => it && hayCampoEnObj(it, 'value') && hayCampoEnObj(it, 'label')))
        return 'grid_stats: cada item necesita "value" y "label"';
      return null;
    }

    case 'comparison': {
      const rows = arr('rows');
      if (!rows || !rows.length) return 'comparison necesita "rows[]"';
      if (!rows.every(r => r && hayCampoEnObj(r, 'label') && hayCampoEnObj(r, 'a') && hayCampoEnObj(r, 'b')))
        return 'comparison: cada row necesita "label", "a" y "b"';
      return null;
    }

    case 'steps': {
      const items = arr('items');
      if (!items || !items.length) return 'steps necesita "items[]"';
      if (!items.every(it => it && hayCampoEnObj(it, 'title')))
        return 'steps: cada item necesita "title"';
      return null;
    }

    case 'icon_list': {
      const items = arr('items');
      if (!items || !items.length) return 'icon_list necesita "items[]"';
      if (!items.every(it => it && hayCampoEnObj(it, 'text')))
        return 'icon_list: cada item necesita "text"';
      return null;
    }

    // Tipos con foto — requieren la(s) foto(s) correspondiente(s)
    case 'full_impact':
      if (!hayTexto('photo') && !hayTexto('line2')) return 'full_impact sin "photo" ni "line2"';
      return null;

    case 'before_after':
      if (!hayTexto('photo_before') || !hayTexto('photo_after'))
        return 'before_after necesita "photo_before" y "photo_after"';
      return null;

    case 'split_v':
      if (!hayTexto('photo_top') || !hayTexto('photo_bottom'))
        return 'split_v necesita "photo_top" y "photo_bottom"';
      return null;

    case 'triple_v': {
      const rows = arr('rows');
      if (!rows || !rows.length) return 'triple_v necesita "rows[]"';
      return null;
    }

    case 'fallback':
      return null; // el fallback siempre es válido

    default:
      // Tipo desconocido — no lo conocemos, lo marcamos para fallback
      return `tipo de slide desconocido: "${slide.type}"`;
  }
}

function hayCampoEnObj(obj, k) {
  const v = obj[k];
  return v != null && String(v).trim() !== '';
}

// ── Slide de fallback tipográfico (item #2) ──────────────────────────────────
// Construye un slide minimalista a partir de lo que haya disponible en el
// slide roto. Extrae el primer texto significativo como headline.
export function construirFallback(slideRoto) {
  const s = slideRoto && typeof slideRoto === 'object' ? slideRoto : {};
  let headline = '';

  // headline_lines (cover-impact)
  if (!headline && Array.isArray(s.headline_lines) && s.headline_lines.length) {
    headline = s.headline_lines.map(l => l?.text).filter(Boolean).join('\n');
  }
  // campos típicos que contienen el texto principal
  for (const campo of ['headline', 'title', 'quote', 'stat', 'line2', 'line1']) {
    if (!headline && typeof s[campo] === 'string' && s[campo].trim()) headline = s[campo].trim();
  }
  // primer item de una lista
  if (!headline && Array.isArray(s.items) && s.items.length) {
    const first = s.items[0];
    headline = typeof first === 'string' ? first : (first?.text || first?.title || '');
  }

  let body = '';
  for (const campo of ['body', 'sub', 'detail', 'label', 'note', 'eyebrow']) {
    if (!body && typeof s[campo] === 'string' && s[campo].trim()) body = s[campo].trim();
  }

  return {
    type: 'fallback',
    headline: headline || '—',
    ...(body ? { body } : {}),
  };
}

// ── Reintento individual de un slide vía IA (item #1.C) ──────────────────────
// callBlackbox: función async (prompt) => string (respuesta cruda de la IA)
// parse: función (rawText) => objeto JSON parseado
// Reintenta hasta `maxReintentos` veces. Si todos fallan, devuelve un fallback.
export async function corregirSlide(slideRoto, problema, contexto, callBlackbox, parse, maxReintentos = 2) {
  const { tema = '', marca = null } = contexto || {};
  for (let intento = 1; intento <= maxReintentos; intento++) {
    const prompt = `Un slide de un carrusel de Instagram salió mal y hay que regenerarlo SOLO a él.

TEMA DEL CARRUSEL: ${tema}
${marca ? `VOZ DE MARCA: ${marca.voz || ''}\nPOSICIONAMIENTO: ${marca.posicionamiento || ''}` : ''}

SLIDE ACTUAL (roto/incompleto):
${JSON.stringify(slideRoto)}

PROBLEMA DETECTADO: ${problema}

Regenerá ESTE slide manteniendo el mismo "type" ("${slideRoto?.type}") y completando TODOS los campos
obligatorios para ese tipo, con copy específico y alineado al tema. Los íconos deben ser nombres
válidos de Material Symbols en snake_case.

Devolvé SOLO el JSON del slide corregido (un único objeto, sin markdown, sin texto extra).`;

    try {
      const raw = await callBlackbox(prompt);
      const slideCorregido = parse(raw);
      // A veces la IA envuelve el slide en { slide: {...} } o { slides: [...] }
      const candidato = slideCorregido?.slides?.[0] || slideCorregido?.slide || slideCorregido;
      normalizarIconosSlide(candidato);
      if (!validarSlide(candidato)) {
        return candidato;
      }
    } catch {
      // parse o red falló — seguimos al próximo intento
    }
  }
  // Todos los reintentos fallaron → fallback tipográfico (item #2)
  return construirFallback(slideRoto);
}

// ── Orquestador completo (item #1.A + #1.B + #1.C) ───────────────────────────
// Valida cada slide, normaliza íconos, reintenta los rotos y aplica fallback.
// Devuelve { slides, corregidos, fallbacks }.
export async function validarYCorregir(slides, contexto, callBlackbox, parse) {
  const out = [];
  let corregidos = 0, fallbacks = 0;

  for (const slide of slides) {
    // B) normalizar íconos siempre
    normalizarIconosSlide(slide);

    // A) validar campos obligatorios
    const problema = validarSlide(slide);
    if (!problema) { out.push(slide); continue; }

    console.warn(`⚠ Slide inválido (${slide?.type || '?'}): ${problema} — regenerando...`);
    // C) reintentar individualmente, con fallback si falla 2 veces
    const corregido = await corregirSlide(slide, problema, contexto, callBlackbox, parse, 2);
    if (corregido.type === 'fallback') {
      console.warn(`   → fallback tipográfico aplicado`);
      fallbacks++;
    } else {
      console.log(`   ✓ slide regenerado`);
      corregidos++;
    }
    out.push(corregido);
  }

  return { slides: out, corregidos, fallbacks };
}
