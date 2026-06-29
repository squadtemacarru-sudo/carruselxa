const $ = (sel) => document.querySelector(sel);

function openModal(el) {
  el.classList.remove('hidden');
  document.body.classList.add('modal-open');
}
function closeModal(el) {
  el.classList.add('hidden');
  // Only remove modal-open if no other modal is visible
  if (!document.querySelector('.modal:not(.hidden)')) {
    document.body.classList.remove('modal-open');
  }
}

// ── TABS ──────────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const btn = document.querySelector(`.nav-btn[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');
  const tab = document.getElementById(tabId);
  if (tab) tab.classList.add('active');
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    switchTab(tabId);
    if (tabId === 'tab-galeria') { cargarGaleria(); if (typeof cargarStoriesGaleria === 'function') cargarStoriesGaleria(); }
    if (tabId === 'tab-fotos')   cargarFotosGrid();
    if (tabId === 'tab-series' && typeof cargarSeries === 'function') cargarSeries();
    if (tabId === 'tab-laboratorio' && typeof cargarLaboratorio === 'function') cargarLaboratorio();
  });
});

// ── COLLAPSIBLES ──────────────────────────────────────
document.querySelectorAll('.config-block-header').forEach(header => {
  header.addEventListener('click', () => {
    const bodyId = header.dataset.toggle;
    const body   = $('#' + bodyId);
    const isOpen = !body.classList.contains('collapsed');
    body.classList.toggle('collapsed', isOpen);
    header.classList.toggle('open', !isOpen);
    if (!isOpen && bodyId === 'bloque-clonar') cargarClonarGrid();
    if (!isOpen && bodyId === 'bloque-diseno') cargarDiseno();
  });
});

// ── MARCA ─────────────────────────────────────────────
const marcaSelect = $('#marcaSelect');
let marcaActual   = null;

async function cargarMarcas(seleccionar) {
  const res    = await fetch('/api/marcas');
  const marcas = await res.json();
  marcaSelect.innerHTML = marcas.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
  marcaActual = seleccionar && marcas.some(m => m.id === seleccionar)
    ? seleccionar : (marcas[0]?.id || null);
  if (marcaActual) marcaSelect.value = marcaActual;
}

marcaSelect.addEventListener('change', async () => {
  marcaActual = marcaSelect.value;
  await Promise.all([cargarTemas(), cargarIdentidad(), cargarReferencias()]);
  renderTemplatesList();
  cargarClonarGrid();
  cargarDiseno();
  serieActiva = null;
  $('#serieCalendario')?.classList.add('hidden');
  $('#seriesList')?.classList.remove('hidden');
  if ($('#tab-series')?.classList.contains('active')) cargarSeries();
});

$('#btnNuevaMarca').addEventListener('click', async () => {
  const nombre = prompt('Nombre de la nueva marca:');
  if (!nombre) return;
  const id = nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 30);
  const res = await fetch('/api/marcas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, nombre })
  });
  if (!res.ok) { alert((await res.json()).error); return; }
  await cargarMarcas(id);
  await Promise.all([cargarTemas(), cargarIdentidad()]);
});

// ── GENERAR ───────────────────────────────────────────
const logWrap   = $('#logWrap');
const log       = $('#log');
const logStatus = $('#logStatus');
let logVisible  = true;
let jobStream   = null;
let editorRerenderizing = false;
let editorTemplateHtml = null;
let editorTemplateLoading = false;
let liveUpdateTimer = null;

function appendLog(line) {
  log.textContent += line;
  log.scrollTop = log.scrollHeight;
  if (editorRerenderizing) {
    const edLog = $('#editorLog');
    if (edLog) { edLog.textContent += line; edLog.scrollTop = edLog.scrollHeight; }
  }
}

// ── MODO ADMIN (logs técnicos) vs MODO USUARIO (progreso) ──
let adminMode = false;
function initAdminMode() {
  const fromUrl = new URLSearchParams(location.search).get('admin') === '1';
  const stored  = localStorage.getItem('cgAdminMode') === '1';
  adminMode = fromUrl || stored;
  if (fromUrl) localStorage.setItem('cgAdminMode', '1');
  applyAdminMode();
}
function applyAdminMode() {
  document.body.classList.toggle('admin-mode', adminMode);
}
function setAdminMode(on) {
  adminMode = on;
  localStorage.setItem('cgAdminMode', on ? '1' : '0');
  applyAdminMode();
  // reflejar visibilidad si hay un job corriendo
  const running = $('#btnGenerar')?.disabled;
  if (running) updateProgressVisibility(true);
}

// ── PANEL DE PROGRESO ──────────────────────────────────
const PROGRESS_ORDER = ['crear', 'analizar', 'generar', 'listo'];
const PROGRESS_SUBS = {
  crear:    ['La IA está pensando el ángulo del contenido…', 'Redactando titulares y copy…', 'Estructurando los slides…'],
  analizar: ['Definiendo el sistema de diseño…', 'Eligiendo tipografía y paleta…', 'Equilibrando jerarquía visual…'],
  generar:  ['Renderizando con Puppeteer…', 'Componiendo cada slide…', 'Exportando imágenes en alta…'],
  listo:    ['¡Tu carrusel está listo!'],
};
let progressSubTimer = null;

function progressStepEl(step) {
  return document.querySelector(`.progress-step[data-step="${step}"]`);
}

function resetProgress() {
  document.querySelectorAll('.progress-step').forEach(el => {
    el.classList.remove('active', 'done', 'error');
    const sub = el.querySelector('.ps-sub');
    if (sub) sub.textContent = '';
  });
  const errEl = $('#progressError');
  if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
  if (progressSubTimer) { clearInterval(progressSubTimer); progressSubTimer = null; }
}

function cycleSub(step) {
  if (progressSubTimer) { clearInterval(progressSubTimer); progressSubTimer = null; }
  const el  = progressStepEl(step);
  const sub = el?.querySelector('.ps-sub');
  const frases = PROGRESS_SUBS[step] || [];
  if (!sub || !frases.length) return;
  let i = 0;
  sub.textContent = frases[0];
  if (frases.length < 2) return;
  progressSubTimer = setInterval(() => {
    i = (i + 1) % frases.length;
    sub.style.opacity = '0';
    setTimeout(() => { sub.textContent = frases[i]; sub.style.opacity = '1'; }, 180);
  }, 4000);
}

// Marca un paso como activo; completa todos los anteriores.
function setProgressStep(step) {
  const idx = PROGRESS_ORDER.indexOf(step);
  if (idx === -1) return;
  PROGRESS_ORDER.forEach((s, i) => {
    const el = progressStepEl(s);
    if (!el) return;
    el.classList.remove('active', 'done', 'error');
    if (i < idx) el.classList.add('done');
    else if (i === idx) el.classList.add('active');
  });
  if (step === 'listo') {
    // último paso: marcarlo como done también
    progressStepEl('listo')?.classList.remove('active');
    progressStepEl('listo')?.classList.add('done');
    if (progressSubTimer) { clearInterval(progressSubTimer); progressSubTimer = null; }
    const sub = progressStepEl('listo')?.querySelector('.ps-sub');
    if (sub) sub.textContent = PROGRESS_SUBS.listo[0];
  } else {
    cycleSub(step);
  }
}

function setProgressError(step, mensaje) {
  if (progressSubTimer) { clearInterval(progressSubTimer); progressSubTimer = null; }
  // el paso fallido es el último activo, o el indicado
  const target = step || document.querySelector('.progress-step.active')?.dataset.step || 'crear';
  const el = progressStepEl(target);
  if (el) { el.classList.remove('active', 'done'); el.classList.add('error'); }
  const errEl = $('#progressError');
  if (errEl) {
    errEl.textContent = simplificarError(mensaje);
    errEl.classList.remove('hidden');
  }
}

function simplificarError(linea) {
  if (!linea) return 'Ocurrió un error durante la generación. Intentá de nuevo.';
  let t = String(linea).replace(/^[❌✗\s]+/, '').trim();
  // recortar stacktraces / rutas largas
  t = t.split('\n')[0].slice(0, 200);
  return t || 'Ocurrió un error durante la generación. Intentá de nuevo.';
}

// Mapea una línea del log SSE a un paso del pipeline.
function progressStepFromLog(line) {
  if (/▶\s*crear|crear\.mjs/.test(line))    return 'crear';
  if (/▶\s*analizar|analizar\.mjs/.test(line)) return 'analizar';
  if (/▶\s*generar|generar\.mjs/.test(line))   return 'generar';
  return null;
}

// Muestra panel de progreso y/o logs según el modo.
function updateProgressVisibility(running) {
  const pw = $('#progressWrap');
  if (running) {
    if (pw) pw.classList.remove('hidden');
    // En modo usuario: ocultar logs. En admin: mostrarlos.
    logWrap.classList.toggle('hidden', !adminMode);
  } else {
    logWrap.classList.add('hidden');
  }
}

$('#btnAdminToggle')?.addEventListener('click', () => setAdminMode(!adminMode));

function setRunning(running) {
  $('#btnGenerar').disabled = running;
  $('#btnLote').disabled    = running;
  if (running) {
    hidePlanPreview();
    resetProgress();
    updateProgressVisibility(true);
    log.textContent = '';
    logStatus.textContent = 'Generando...';
    logStatus.style.color = 'var(--acc)';
    logVisible = true;
    log.style.display = '';
    $('#logToggle').textContent = 'ocultar';
  } else {
    logStatus.textContent = 'Listo';
    logStatus.style.color = 'var(--green)';
  }
}

async function checkStatus() {
  const { running } = await (await fetch('/api/job/status')).json();
  setRunning(running);
}

function connectStream() {
  const es = new EventSource('/api/job/stream');
  jobStream = es;
  es.onmessage = e => {
    const line = JSON.parse(e.data);

    // Evento especial: preview del plan (wireframe antes de renderizar)
    if (typeof line === 'string' && line.startsWith('__PLAN__:')) {
      try { renderPlanPreview(JSON.parse(line.slice('__PLAN__:'.length))); } catch {}
      return;
    }

    // Eventos de serie — progreso pieza por pieza
    if (typeof line === 'string' && line.includes('__SERIE_PIEZA__:')) {
      const m = line.slice(line.indexOf('__SERIE_PIEZA__:') + '__SERIE_PIEZA__:'.length);
      try { if (typeof onSeriePieza === 'function') onSeriePieza(JSON.parse(m)); } catch {}
      appendLog(line.replace(/__SERIE_PIEZA__:.*$/, ''));
      return;
    }
    if (typeof line === 'string' && line.includes('__SERIE_DONE__:')) {
      const m = line.slice(line.indexOf('__SERIE_DONE__:') + '__SERIE_DONE__:'.length);
      try { if (typeof onSerieDone === 'function') onSerieDone(JSON.parse(m)); } catch {}
      setRunning(false);
      return;
    }

    appendLog(line);
    const isDone  = line.includes('✅') || line.includes('Listo');
    const isError = line.includes('❌');

    // Laboratorio consume el evento — no redirigir a Galería si Lab está renderizando
    if (typeof labOnStreamLine === 'function' && labOnStreamLine(line)) {
      if (isDone || isError) { setRunning(false); hidePlanPreview(); }
      return;
    }

    // Actualizar panel de progreso (modo usuario)
    if (isError)      setProgressError(null, line);
    else if (isDone)  setProgressStep('listo');
    else {
      const step = progressStepFromLog(line);
      if (step) setProgressStep(step);
    }

    if (isDone || isError) hidePlanPreview();
    if (editorRerenderizing && (isDone || isError)) {
      editorRerenderizing = false;
      const btn = $('#btnRerenderizar');
      if (btn) btn.disabled = false;
      const st = $('#editorStatus');
      if (st) { st.textContent = isDone ? '✓ Listo' : '✗ Error'; st.className = 'status ' + (isDone ? 'ok' : 'err'); }
      if (isDone) { editorTs = Date.now(); renderEditorSlide(editorSlideIdx); setTimeout(cargarGaleria, 500); }
      return;
    }
    if (isDone) {
      setRunning(false);
      // Esperar 1.5s para que el server termine de escribir archivos antes de recargar
      setTimeout(async () => {
        await cargarGaleria();
        document.querySelector('.nav-btn[data-tab="tab-galeria"]')?.click();
      }, 1500);
    }
    if (isError) { setRunning(false); logStatus.style.color = 'var(--red)'; logStatus.textContent = 'Error'; }
  };
}

// ── PREVIEW DEL PLAN (wireframe de slides) ─────────────
// Diferenciación visual por tipo de slide
const PLAN_TIPOS = {
  cover:       { label: 'Cover',     glyph: '◆',  color: '#e8ff00' },
  list:        { label: 'Lista',     glyph: '☰',  color: '#5ec8ff' },
  statement:   { label: 'Frase',     glyph: '“',  color: '#ff8ad1' },
  split:       { label: 'Split',     glyph: '◫',  color: '#9b8cff' },
  quote:       { label: 'Cita',      glyph: '❝',  color: '#ffb86b' },
  cta:         { label: 'CTA',       glyph: '→',  color: '#00cf7a' },
  big_number:  { label: 'Dato',      glyph: '#',  color: '#ff5e5e' },
  timeline:    { label: 'Timeline',  glyph: '⋯',  color: '#7ee0c0' },
  grid:        { label: 'Grid',      glyph: '▦',  color: '#c0a0ff' },
  grid_stats:  { label: 'Métricas',  glyph: '▦',  color: '#5ec8ff' },
  comparison:  { label: 'Comparar',  glyph: '⇄',  color: '#ffb86b' },
  steps:       { label: 'Pasos',     glyph: '№',  color: '#7ee0c0' },
  icon_list:   { label: 'Íconos',    glyph: '✦',  color: '#9b8cff' },
  full_impact: { label: 'Foto',      glyph: '▣',  color: '#ff8ad1' },
  before_after:{ label: 'Antes/Desp',glyph: '◧',  color: '#5ec8ff' },
  split_v:     { label: 'Split V',   glyph: '⬓',  color: '#9b8cff' },
  triple_v:    { label: 'Triple',    glyph: '☰',  color: '#7ee0c0' },
};

function planTextoPrincipal(s) {
  // Devuelve el texto más representativo del slide, según su tipo
  const limpiar = (t) => String(t || '').replace(/\\n|\n/g, ' ').trim();
  if (Array.isArray(s.headline_lines) && s.headline_lines.length) {
    return s.headline_lines.map(l => typeof l === 'object' ? l.text : l).join(' ').replace(/\\n|\n/g, ' ').trim();
  }
  const directos = [s.headline, s.stat, s.quote, s.title, s.eyebrow];
  for (const d of directos) { const v = limpiar(d); if (v) return v; }
  if (Array.isArray(s.items) && s.items.length) {
    return s.items.map(it => typeof it === 'object' ? (it.text || it.label || it.value || '') : it).filter(Boolean).slice(0, 3).join(' · ');
  }
  if (Array.isArray(s.steps) && s.steps.length) return s.steps.map(st => st.text || st.title).filter(Boolean).slice(0, 3).join(' · ');
  if (Array.isArray(s.cells) && s.cells.length) return s.cells.map(c => c.label).filter(Boolean).join(' · ');
  if (s.left && s.right) return `${s.left.label || ''} vs ${s.right.label || ''}`;
  return limpiar(s.body || s.detail || s.sub || s.label || '');
}

// Estado editable del plan — copia que el usuario modifica antes de generar
let planSlides = [];

// Mapea texto editado de vuelta al campo principal del slide (mismo orden de
// prioridad que planTextoPrincipal). Devuelve false si no hay campo simple.
function setPlanPrimaryText(s, text) {
  if (typeof s.headline === 'string') { s.headline = text; return true; }
  if (typeof s.stat === 'string')     { s.stat = text; return true; }
  if (typeof s.quote === 'string')    { s.quote = text; return true; }
  if (typeof s.title === 'string')    { s.title = text; return true; }
  if (typeof s.eyebrow === 'string')  { s.eyebrow = text; return true; }
  return false;
}
function planEditable(s) {
  return ['headline', 'stat', 'quote', 'title', 'eyebrow'].some(k => typeof s[k] === 'string');
}

function drawPlanGrid() {
  const grid = document.getElementById('planGrid');
  const count = document.getElementById('planCount');
  if (!grid) return;
  if (count) count.textContent = `· ${planSlides.length} slides`;
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  grid.innerHTML = planSlides.map((s, i) => {
    const meta  = PLAN_TIPOS[s.type] || { label: s.type || '?', glyph: '▢', color: '#8a8aa0' };
    const num   = String(i + 1).padStart(2, '0');
    const texto = planTextoPrincipal(s) || '—';
    const editable = planEditable(s);
    return `
      <div class="pw-card" style="--pw-accent:${meta.color}">
        <div class="pw-card-top">
          <span class="pw-card-num">${num}</span>
          <span class="pw-card-badge">${esc(meta.label)}</span>
          <button class="pw-card-del" data-idx="${i}" type="button" title="Sacar este slide">✕</button>
        </div>
        <div class="pw-card-glyph">${meta.glyph}</div>
        <p class="pw-card-text${editable ? ' editable' : ''}"${editable ? ` contenteditable="true" data-idx="${i}"` : ''}>${esc(texto)}</p>
      </div>`;
  }).join('');

  // Wire delete buttons
  grid.querySelectorAll('.pw-card-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      if (planSlides.length <= 1) return; // no dejar el plan vacío
      planSlides.splice(idx, 1);
      drawPlanGrid();
    });
  });
  // Wire inline editing
  grid.querySelectorAll('.pw-card-text.editable').forEach(p => {
    p.addEventListener('blur', () => {
      const idx = parseInt(p.dataset.idx);
      if (planSlides[idx]) setPlanPrimaryText(planSlides[idx], p.textContent.trim());
    });
  });
}

function renderPlanPreview(contenido) {
  const wrap = document.getElementById('planWrap');
  const slides = Array.isArray(contenido?.slides) ? contenido.slides : [];
  if (!wrap || !slides.length) return;
  // Copia profunda para que las ediciones no toquen el contenido original
  planSlides = JSON.parse(JSON.stringify(slides));
  drawPlanGrid();
  wrap.classList.remove('hidden');
  logStatus.style.color = 'var(--acc)';
  logStatus.textContent = 'Esperando tu aprobación';
}

function hidePlanPreview() {
  const wrap = document.getElementById('planWrap');
  if (wrap) wrap.classList.add('hidden');
}

document.getElementById('btnAprobarPlan')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnAprobarPlan');
  if (btn) { btn.disabled = true; btn.textContent = 'Generando...'; }
  try {
    await fetch('/api/aprobar-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slides: planSlides })
    });
    hidePlanPreview();
    logStatus.style.color = 'var(--acc)';
    logStatus.textContent = 'Renderizando...';
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Generar así'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Generar así'; }
  }
});

document.getElementById('btnDescartarPlan')?.addEventListener('click', async () => {
  try { await fetch('/api/descartar-plan', { method: 'POST' }); } catch {}
  hidePlanPreview();
  setRunning(false);
  logStatus.style.color = 'var(--sub)';
  logStatus.textContent = 'Plan descartado';
});

$('#logToggle').addEventListener('click', () => {
  logVisible = !logVisible;
  log.style.display = logVisible ? '' : 'none';
  $('#logToggle').textContent = logVisible ? 'ocultar' : 'ver log';
});

$('#btnGenerar').addEventListener('click', async () => {
  const tema = $('#temaInput').value.trim();
  if (!tema || !marcaActual) return;
  abrirWizardEstilo(tema);
});

// ── AUTO-GUARDADO DEL DRAFT ──────────────────────────
const DRAFT_KEY = 'carruselgen_draft_tema';
$('#temaInput').addEventListener('input', () => {
  localStorage.setItem(DRAFT_KEY, $('#temaInput').value);
});

// ── WIZARD ESTILO ──────────────────────────────────
const ESTILOS = [
  { id: 'minimal',      nombre: 'Minimal',       desc: 'Limpio, elegante, mucho espacio',     paleta: ['#f8f8f6','#0a0a0a','#e8e8e4','#1a1a2e'] },
  { id: 'bold',         nombre: 'Bold Impact',   desc: 'Alto contraste, tipografía grande',   paleta: ['#0a0a0a','#ffffff','#ff3c00','#222'] },
  { id: 'editorial',    nombre: 'Editorial',     desc: 'Estilo revista, sofisticado',          paleta: ['#faf7f2','#1c1c1c','#c8a97e','#8c7b6b'] },
  { id: 'vibrant',      nombre: 'Vibrant',       desc: 'Colorido, energético',                paleta: ['#6c2bd9','#f7e94b','#ff6b6b','#fff'] },
  { id: 'dark-luxury',  nombre: 'Dark Luxury',   desc: 'Oscuro, premium, sofisticado',         paleta: ['#0d0d0d','#e8d5b0','#c9a84c','#1a1a1a'] },
  { id: 'nature',       nombre: 'Nature',        desc: 'Verde, orgánico, fresco',             paleta: ['#f0f4ed','#1e3a2f','#4a8c5c','#b8d4c0'] },
];

const FUENTES = [
  { id: 'playfair',        display: 'Playfair Display', body: 'Lato',              hint: 'Luxury · premium · editorial',      url: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Lato:wght@400;700&display=swap' },
  { id: 'oswald',          display: 'Oswald',           body: 'DM Sans',           hint: 'Deportivo · directo · masculino',   url: 'https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&family=DM+Sans:wght@400;600&display=swap' },
  { id: 'montserrat',      display: 'Montserrat',       body: 'Montserrat',        hint: 'Versátil · limpio · corporativo',   url: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700;900&display=swap' },
  { id: 'bebas',           display: 'Bebas Neue',       body: 'Inter',             hint: 'Editorial · fitness · impacto',     url: 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;600&display=swap' },
  { id: 'space-grotesk',   display: 'Space Grotesk',    body: 'Inter',             hint: 'Tech · datos · startup',            url: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;600&display=swap' },
  { id: 'dm-serif',        display: 'DM Serif Display', body: 'DM Sans',           hint: 'Revista · editorial cálido',        url: 'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;600&display=swap' },
  { id: 'syne',            display: 'Syne',             body: 'Inter',             hint: 'Diseño de autor · disruptivo',      url: 'https://fonts.googleapis.com/css2?family=Syne:wght@500;700;800&family=Inter:wght@400;600&display=swap' },
  { id: 'raleway',         display: 'Raleway',          body: 'Outfit',            hint: 'Aspiracional · femenino',           url: 'https://fonts.googleapis.com/css2?family=Raleway:wght@600;800&family=Outfit:wght@400;600&display=swap' },
  { id: 'barlow-cond',     display: 'Barlow Condensed', body: 'Barlow',            hint: 'Moderno · clean · tech',            url: 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;600&display=swap' },
  { id: 'anton',           display: 'Anton',            body: 'Inter',             hint: 'Street · urbano · agresivo',        url: 'https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;600&display=swap' },
  { id: 'archivo-black',   display: 'Archivo Black',    body: 'Inter',             hint: 'Editorial bold · diseño',           url: 'https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;600&display=swap' },
  { id: 'unbounded',       display: 'Unbounded',        body: 'Inter',             hint: 'Web3 · tech extremo · bold',        url: 'https://fonts.googleapis.com/css2?family=Unbounded:wght@400;700;900&family=Inter:wght@400;600&display=swap' },
  { id: 'instrument',      display: 'Instrument Serif', body: 'DM Sans',           hint: 'Ultra premium · luxury',            url: 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;600&display=swap' },
  { id: 'poppins',         display: 'Poppins',          body: 'Poppins',           hint: 'Amigable · popular · accesible',    url: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;900&display=swap' },
  { id: 'cormorant',       display: 'Cormorant Garamond', body: 'Lato',            hint: 'Moda · lujo · fashion',             url: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Lato:wght@400;600&display=swap' },
  { id: 'plus-jakarta',    display: 'Plus Jakarta Sans', body: 'Plus Jakarta Sans', hint: 'Moderno · profesional · SaaS',     url: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap' },
  { id: 'fraunces',        display: 'Fraunces',         body: 'Jost',              hint: 'Orgánico · artesanal · editorial',  url: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@700;900&family=Jost:wght@400;500&display=swap' },
  { id: 'clash',           display: 'Clash Display',    body: 'Satoshi',           hint: 'Youth · streetwear · moderno',      url: 'https://fonts.googleapis.com/css2?family=Clash+Display:wght@600;700&family=Satoshi:wght@400;500&display=swap' },
];

const PALETAS = [
  { id: 'negro-lima',       nombre: 'Negro Lima',        desc: 'Energético · fitness · alto impacto',       preview: ['#040404','#e8ff00','#ffffff'] },
  { id: 'blanco-negro',     nombre: 'Minimal Blanco',    desc: 'Limpio · premium · tipográfico',            preview: ['#fafafa','#0a0a0a','#555'] },
  { id: 'negro-rojo',       nombre: 'Rojo Oscuro',       desc: 'Urgencia · agresivo · impacto',             preview: ['#0d0d0d','#e83030','#ffffff'] },
  { id: 'crema-marron',     nombre: 'Editorial Crema',   desc: 'Sofisticado · editorial · café',            preview: ['#faf7f2','#8c6a4f','#1c1c1c'] },
  { id: 'azul-cyan',        nombre: 'Tech Azul',         desc: 'Digital · startup · datos',                 preview: ['#020b18','#00cfff','#e8f4ff'] },
  { id: 'violeta-amarillo', nombre: 'Vibrant Pop',       desc: 'Llamativo · creativo · joven',              preview: ['#1a0533','#f7e94b','#ff6b8a'] },
  { id: 'verde-crema',      nombre: 'Nature Orgánico',   desc: 'Wellness · bienestar · natural',            preview: ['#1e3a2f','#a8d5b5','#f0f4ed'] },
  { id: 'dorado-negro',     nombre: 'Dark Luxury',       desc: 'Oscuro · premium · lujo',                   preview: ['#0d0d0d','#c9a84c','#e8d5b0'] },
  { id: 'blanco-naranja',   nombre: 'Energía Blanca',    desc: 'Limpio con punch · dinámico',               preview: ['#ffffff','#ff5722','#222'] },
  { id: 'rosa-negro',       nombre: 'Fashion Dark',      desc: 'Moda · femenino · lifestyle oscuro',        preview: ['#0d0d0d','#e8658a','#f5e6ee'] },
];

let wizardTema        = '';
let wizardEstiloId    = null;
let wizardFuenteId    = null;
let wizardPaletaId    = null;
let fontLinksLoaded   = false;

function abrirWizardEstilo(tema) {
  wizardTema     = tema;
  wizardEstiloId = null;
  wizardFuenteId = null;
  wizardPaletaId = null;

  const grid = $('#estiloGrid');
  grid.innerHTML = ESTILOS.map(e => `
    <div class="estilo-card" data-id="${e.id}">
      <div class="estilo-paleta">${e.paleta.map(c => `<span style="background:${c}"></span>`).join('')}</div>
      <p class="estilo-nombre">${e.nombre}</p>
      <p class="estilo-desc">${e.desc}</p>
    </div>
  `).join('');

  grid.querySelectorAll('.estilo-card').forEach(card => {
    card.addEventListener('click', () => {
      grid.querySelectorAll('.estilo-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      wizardEstiloId = card.dataset.id;
      $('#estiloBtnNext').disabled = false;
    });
  });

  $('#estiloStep1').classList.remove('hidden');
  $('#estiloStep2').classList.add('hidden');
  $('#estiloStep3').classList.add('hidden');
  openModal($('#modalEstilo'));
}

function renderFuenteGrid() {
  if (!fontLinksLoaded) {
    FUENTES.forEach(f => {
      if (!document.querySelector(`link[data-font="${f.id}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = f.url;
        link.dataset.font = f.id;
        document.head.appendChild(link);
      }
    });
    fontLinksLoaded = true;
  }

  const grid = $('#fuenteGrid');
  grid.innerHTML = FUENTES.map(f => `
    <div class="fuente-card" data-id="${f.id}" data-display="${f.display}">
      <p class="fuente-preview" style="font-family:'${f.display}',serif">Tu titular aquí</p>
      <p class="fuente-nombre">${f.display} / ${f.body}</p>
      <p class="fuente-hint">${f.hint}</p>
    </div>
  `).join('');

  grid.querySelectorAll('.fuente-card').forEach(card => {
    card.addEventListener('click', () => {
      grid.querySelectorAll('.fuente-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      wizardFuenteId = card.dataset.id;
      $('#fuenteBtnNext2').disabled = false;
    });
  });
}

function renderPaletaGrid() {
  const grid = $('#paletaGrid');
  grid.innerHTML = PALETAS.map(p => `
    <div class="paleta-card" data-id="${p.id}">
      <div class="paleta-swatches">${p.preview.map(c => `<span class="paleta-swatch" style="background:${c}"></span>`).join('')}</div>
      <p class="paleta-nombre">${p.nombre}</p>
      <p class="paleta-desc">${p.desc}</p>
    </div>
  `).join('');

  grid.querySelectorAll('.paleta-card').forEach(card => {
    card.addEventListener('click', () => {
      grid.querySelectorAll('.paleta-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      wizardPaletaId = card.dataset.id;
      $('#paletaBtnConfirmar').disabled = false;
    });
  });
}

function cerrarWizard() {
  closeModal($('#modalEstilo'));
}

function confirmarWizardYGenerar() {
  cerrarWizard();
  abrirModalPreguntar(wizardTema);
}

$('#estiloClose').addEventListener('click', cerrarWizard);

$('#estiloBtnSaltear').addEventListener('click', () => {
  wizardEstiloId = null;
  wizardFuenteId = null;
  wizardPaletaId = null;
  confirmarWizardYGenerar();
});

$('#estiloBtnNext').addEventListener('click', () => {
  $('#estiloStep1').classList.add('hidden');
  $('#estiloStep2').classList.remove('hidden');
  renderFuenteGrid();
});

$('#estiloBtnPrev').addEventListener('click', () => {
  $('#estiloStep2').classList.add('hidden');
  $('#estiloStep1').classList.remove('hidden');
});

$('#fuenteBtnSaltear').addEventListener('click', () => {
  wizardFuenteId = null;
  $('#estiloStep2').classList.add('hidden');
  $('#estiloStep3').classList.remove('hidden');
  renderPaletaGrid();
});

$('#fuenteBtnNext2').addEventListener('click', () => {
  $('#estiloStep2').classList.add('hidden');
  $('#estiloStep3').classList.remove('hidden');
  renderPaletaGrid();
});

$('#paletaBtnPrev').addEventListener('click', () => {
  $('#estiloStep3').classList.add('hidden');
  $('#estiloStep2').classList.remove('hidden');
});

$('#paletaBtnSaltear').addEventListener('click', () => {
  wizardPaletaId = null;
  confirmarWizardYGenerar();
});

$('#paletaBtnConfirmar').addEventListener('click', confirmarWizardYGenerar);

// ── MODAL PREGUNTAR ───────────────────────────────────
let preguntasActuales = [];
let rotacionesPendientes = {};
let fotosPorSlide = {};  // { "1": "foto.jpg", "4": "foto2.jpg" }
let fpsSlotActivo = null;

async function abrirModalPreguntar(tema) {
  const modal    = $('#modalPreguntar');
  const loader   = $('#preguntarLoader');
  const content  = $('#preguntarContent');
  const btnConf  = $('#btnConfirmarPreguntas');
  preguntasActuales = [];
  rotacionesPendientes = {};
  fotosPorSlide = {};
  $('#instruccionesLibres').value = '';
  renderTplPickerChips();

  loader.classList.remove('hidden');
  content.classList.add('hidden');
  btnConf.classList.add('hidden');
  openModal(modal);

  // Secciones que solo aparecen cuando hay fotos
  const rotSection = $('#rotacionSection');
  const fpsSection = $('#fpsSlidesSection');
  if (fotosSeleccionadas.length) {
    rotSection.classList.remove('hidden');
    fpsSection.classList.remove('hidden');
    renderRotacionGrid();
    renderFpsSlots();
  } else {
    rotSection.classList.add('hidden');
    fpsSection.classList.add('hidden');
  }

  // Preguntas de la IA
  try {
    const fotoUrls = fotosSeleccionadas.map(n => {
      const f = fotosDisponibles.find(x => x.nombre === n);
      return f ? f.url : `/fotos/${n}`;
    });
    const res = await fetch('/api/preguntar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tema, marca: marcaActual, fotoUrls })
    });
    const data = await res.json();
    preguntasActuales = data.preguntas || [];
  } catch {
    preguntasActuales = [];
  }

  renderPreguntas(preguntasActuales);
  loader.classList.add('hidden');
  content.classList.remove('hidden');
  btnConf.classList.remove('hidden');
}

function renderRotacionGrid() {
  const grid = $('#rotacionGrid');
  grid.innerHTML = fotosSeleccionadas.map(nombre => {
    const foto = fotosDisponibles.find(f => f.nombre === nombre);
    const url  = foto ? foto.url : `/fotos/${nombre}`;
    return `<div class="rot-item" data-nombre="${nombre}">
      <div class="rot-img-wrap">
        <img src="${url}" class="rot-img" data-rot="0" alt="${nombre}">
      </div>
      <div class="rot-controls">
        <button class="rot-btn btn-ghost btn-sm" data-nombre="${nombre}" data-dir="-1">↺</button>
        <span class="rot-deg" data-nombre="${nombre}">0°</span>
        <button class="rot-btn btn-ghost btn-sm" data-nombre="${nombre}" data-dir="1">↻</button>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.rot-btn').forEach(btn => {
    btn.addEventListener('click', () => rotarFoto(btn.dataset.nombre, parseInt(btn.dataset.dir) * 90));
  });
}

function rotarFoto(nombre, delta) {
  const img = document.querySelector(`.rot-item[data-nombre="${nombre}"] .rot-img`);
  const deg = document.querySelector(`.rot-deg[data-nombre="${nombre}"]`);
  const actual  = parseInt(img?.dataset.rot || '0');
  const nuevo   = ((actual + delta) + 360) % 360;
  if (img) { img.style.transform = `rotate(${nuevo}deg)`; img.dataset.rot = nuevo; }
  if (deg) deg.textContent = `${nuevo}°`;
  if (nuevo === 0) delete rotacionesPendientes[nombre];
  else rotacionesPendientes[nombre] = nuevo;
}

function renderPreguntas(preguntas) {
  const container = $('#preguntasContainer');
  container.innerHTML = preguntas.map(p => {
    if (p.tipo === 'slider') {
      return `<div class="pregunta-block">
        <p class="pregunta-label">${p.pregunta}</p>
        <div class="slider-row">
          <span class="slider-lbl">${p.label_min || ''}</span>
          <input type="range" id="preg_${p.id}" class="preg-slider"
            min="${p.min}" max="${p.max}" step="${p.step || 0.05}" value="${p.default}">
          <span class="slider-lbl">${p.label_max || ''}</span>
        </div>
        <div style="text-align:center;margin-top:4px">
          <span class="slider-val" id="preg_${p.id}_val">${p.default}</span>
        </div>
      </div>`;
    }
    if (p.tipo === 'opciones') {
      return `<div class="pregunta-block">
        <p class="pregunta-label">${p.pregunta}</p>
        <div class="opciones-row">
          ${(p.opciones || []).map(op =>
            `<button class="opcion-btn${op === p.default ? ' selected' : ''}" data-preg="${p.id}">${op}</button>`
          ).join('')}
        </div>
      </div>`;
    }
    return '';
  }).join('');

  container.querySelectorAll('.preg-slider').forEach(sl => {
    const valEl = document.getElementById(`${sl.id}_val`);
    sl.addEventListener('input', () => { if (valEl) valEl.textContent = parseFloat(sl.value).toFixed(2); });
  });

  container.querySelectorAll('.opcion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll(`.opcion-btn[data-preg="${btn.dataset.preg}"]`)
        .forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });
}

// ── FOTOS POR SLIDE ───────────────────────────────────
function renderFpsSlots() {
  const grid   = $('#fpsSlotsGrid');
  const picker = $('#fpsPicker');
  picker.classList.add('hidden');
  fpsSlotActivo = null;

  grid.innerHTML = Array.from({ length: 6 }, (_, i) => {
    const n    = i + 1;
    const asig = fotosPorSlide[n];
    const foto = asig ? fotosDisponibles.find(f => f.nombre === asig) : null;
    return `<div class="fps-slot ${asig ? 'asignada' : ''}" data-slot="${n}">
      ${foto
        ? `<img src="${foto.url}" class="fps-slot-img" alt="${asig}"><button class="fps-clear" data-slot="${n}">×</button>`
        : `<span class="fps-num">0${n}</span>`
      }
    </div>`;
  }).join('');

  grid.querySelectorAll('.fps-slot').forEach(sl => {
    sl.addEventListener('click', (e) => {
      if (e.target.classList.contains('fps-clear')) return;
      abrirFpsPicker(parseInt(sl.dataset.slot));
    });
  });
  grid.querySelectorAll('.fps-clear').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      delete fotosPorSlide[parseInt(btn.dataset.slot)];
      renderFpsSlots();
    });
  });
}

function abrirFpsPicker(slot) {
  fpsSlotActivo = slot;
  $('#fpsSlotLabel').textContent = `0${slot}`;
  const pickerGrid = $('#fpsPickerGrid');
  pickerGrid.innerHTML = fotosSeleccionadas.map(nombre => {
    const foto = fotosDisponibles.find(f => f.nombre === nombre);
    const url  = foto ? foto.url : `/fotos/${nombre}`;
    const sel  = fotosPorSlide[slot] === nombre;
    return `<div class="fps-pick-thumb ${sel ? 'selected' : ''}" data-nombre="${nombre}">
      <img src="${url}" alt="${nombre}">
      ${sel ? '<span class="foto-check">✓</span>' : ''}
    </div>`;
  }).join('');
  pickerGrid.querySelectorAll('.fps-pick-thumb').forEach(th => {
    th.addEventListener('click', () => {
      fotosPorSlide[fpsSlotActivo] = th.dataset.nombre;
      $('#fpsPicker').classList.add('hidden');
      fpsSlotActivo = null;
      renderFpsSlots();
    });
  });
  $('#fpsPicker').classList.remove('hidden');
}

function collectRespuestas() {
  const respuestas = {};
  preguntasActuales.forEach(p => {
    if (p.tipo === 'slider') {
      const el = document.getElementById(`preg_${p.id}`);
      if (el) respuestas[p.id] = parseFloat(el.value);
    }
    if (p.tipo === 'opciones') {
      const sel = document.querySelector(`#preguntasContainer .opcion-btn[data-preg="${p.id}"].selected`);
      if (sel) respuestas[p.id] = sel.textContent;
    }
  });
  if (Object.keys(rotacionesPendientes).length) respuestas.rotaciones   = { ...rotacionesPendientes };
  if (Object.keys(fotosPorSlide).length)        respuestas.fotosPorSlide = { ...fotosPorSlide };
  return respuestas;
}

async function dispararGenerar(respuestas = {}, instruccionesLibres = '') {
  localStorage.removeItem(DRAFT_KEY);
  setRunning(true);
  const body = {
    tema: $('#temaInput').value.trim(),
    marca: marcaActual,
    model: $('#modelSelect').value,
    respuestas,
    instruccionesLibres,
    estiloId: wizardEstiloId || null,
    fuenteId: wizardFuenteId || null,
    paletaId: wizardPaletaId || null,
  };
  if (fotosSeleccionadas.length) body.fotos = fotosSeleccionadas;
  const res = await fetch('/api/generar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    appendLog('\n❌ ' + (await res.json()).error + '\n');
    setRunning(false);
  }
}

$('#modalPreguntarClose').addEventListener('click', () => closeModal($('#modalPreguntar')));

$('#btnSaltarPreguntas').addEventListener('click', () => {
  closeModal($('#modalPreguntar'));
  dispararGenerar();
});

$('#btnConfirmarPreguntas').addEventListener('click', () => {
  closeModal($('#modalPreguntar'));
  dispararGenerar(collectRespuestas(), $('#instruccionesLibres').value.trim());
});

$('#btnLote').addEventListener('click', async () => {
  const minutos = Number($('#minutosInput').value) || 45;
  if (!marcaActual) return;
  if (!confirm(`¿Iniciar tanda de ${minutos} minutos?`)) return;
  setRunning(true);
  const res = await fetch('/api/lote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutos, marca: marcaActual })
  });
  if (!res.ok) {
    appendLog('\n❌ ' + (await res.json()).error + '\n');
    setRunning(false);
  }
});

// ── TEMAS ─────────────────────────────────────────────
async function cargarTemas() {
  if (!marcaActual) return;
  const temas = await (await fetch(`/api/marcas/${marcaActual}/temas`)).json();
  $('#temasArea').value = temas.join('\n');
}

$('#btnGuardarTemas').addEventListener('click', async () => {
  if (!marcaActual) return;
  const temas = $('#temasArea').value.split('\n').map(t => t.trim()).filter(Boolean);
  const res = await fetch(`/api/marcas/${marcaActual}/temas`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(temas)
  });
  const st = $('#temasStatus');
  st.textContent = res.ok ? `✓ ${temas.length} temas guardados` : '✗ Error al guardar';
  st.className = 'status ' + (res.ok ? 'ok' : 'err');
  setTimeout(() => { st.textContent = ''; }, 3000);
});

// ── IDENTIDAD ─────────────────────────────────────────
async function cargarIdentidad() {
  if (!marcaActual) return;
  const res = await fetch(`/api/marcas/${marcaActual}/marca`);
  const m   = res.ok ? await res.json() : {};
  $('#mNombre').value          = m.nombre || '';
  $('#mHandle').value          = m.handle || '';
  $('#mIndustria').value       = m.industria || '';
  $('#mAudiencia').value       = m.audiencia || '';
  $('#mPosicionamiento').value = m.posicionamiento || '';
  $('#mProducto').value        = m.producto || '';
  $('#mVoz').value             = m.voz || '';
  $('#mEvitar').value          = (m.evitar || []).join(', ');
  const fondoVal  = m.paleta_marca?.fondo  || '#040404';
  const acentoVal = m.paleta_marca?.acento || '#e8ff00';
  $('#mFondo').value        = fondoVal;
  $('#mFondoSwatch').value  = fondoVal;
  $('#mAcento').value       = acentoVal;
  $('#mAcentoSwatch').value = acentoVal;
  $('#mPaletaDesc').value   = m.paleta_marca?.descripcion || '';

  const marcas  = await (await fetch('/api/marcas')).json();
  const info    = marcas.find(x => x.id === marcaActual);
  const preview = $('#logoPreview');
  preview.src           = info?.logo ? `${info.logo}?t=${Date.now()}` : '';
  preview.style.display = info?.logo ? '' : 'none';
}

// Sincronización color picker ↔ hex text para fondo y acento
[['mFondoSwatch', 'mFondo'], ['mAcentoSwatch', 'mAcento']].forEach(([swatchId, textId]) => {
  const swatch = $('#' + swatchId);
  const text   = $('#' + textId);
  if (!swatch || !text) return;
  swatch.addEventListener('input', () => { text.value = swatch.value; });
  text.addEventListener('input', () => {
    if (/^#[0-9a-f]{6}$/i.test(text.value)) swatch.value = text.value;
  });
});

$('#btnGuardarMarca').addEventListener('click', async () => {
  if (!marcaActual) return;
  const logoFile = $('#logoFile');
  if (logoFile.files[0]) {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(logoFile.files[0]);
    });
    await fetch(`/api/marcas/${marcaActual}/logo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl })
    });
    logoFile.value = '';
  }

  const body = {
    nombre:           $('#mNombre').value.trim(),
    handle:           $('#mHandle').value.trim(),
    industria:        $('#mIndustria').value.trim(),
    audiencia:        $('#mAudiencia').value.trim(),
    posicionamiento:  $('#mPosicionamiento').value.trim(),
    producto:         $('#mProducto').value.trim(),
    voz:              $('#mVoz').value.trim(),
    evitar:           $('#mEvitar').value.split(',').map(s => s.trim()).filter(Boolean),
    nivel_consciencia:'problem-aware',
    paleta_marca: {
      fondo:       $('#mFondo').value.trim() || '#040404',
      acento:      $('#mAcento').value.trim() || '#e8ff00',
      descripcion: $('#mPaletaDesc').value.trim()
    }
  };

  const res = await fetch(`/api/marcas/${marcaActual}/marca`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const st = $('#marcaStatus');
  if (res.ok) {
    st.textContent = '✓ Guardado';
    st.className   = 'status ok';
    await cargarMarcas(marcaActual);
    await cargarIdentidad();
  } else {
    st.textContent = '✗ Error';
    st.className   = 'status err';
  }
  setTimeout(() => { st.textContent = ''; }, 3000);
});

// ── FOTOS ─────────────────────────────────────────────
let fotosDisponibles   = [];
let fotosSeleccionadas = [];

async function cargarFotosGrid(targetGrid = '#fotosGrid') {
  const res   = await fetch('/api/fotos');
  const fotos = res.ok ? await res.json() : [];
  fotosDisponibles = fotos;

  const grid  = $(targetGrid);
  const empty = targetGrid === '#fotosGrid' ? $('#fotosEmpty') : null;

  if (!fotos.length) {
    grid.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  grid.innerHTML = fotos.map(f => `
    <div class="foto-thumb ${fotosSeleccionadas.includes(f.nombre) ? 'selected' : ''}" data-nombre="${f.nombre}">
      <img src="${f.url}" loading="lazy" alt="${f.nombre}">
      <span class="foto-check">✓</span>
      ${targetGrid === '#fotosGrid' ? `<button class="foto-del" data-nombre="${f.nombre}" title="Eliminar">×</button>` : ''}
    </div>
  `).join('');

  grid.querySelectorAll('.foto-thumb').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('foto-del')) return;
      el.classList.toggle('selected');
    });
  });

  if (targetGrid === '#fotosGrid') {
    grid.querySelectorAll('.foto-del').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const nombre = btn.dataset.nombre;
        if (!confirm(`¿Eliminar ${nombre}?`)) return;
        await fetch('/api/fotos/' + encodeURIComponent(nombre), { method: 'DELETE' });
        cargarFotosGrid();
      });
    });
  }
}

$('#fotosUpload').addEventListener('change', async e => {
  const files = [...e.target.files];
  if (!files.length) return;

  const progress = $('#upload-progress');
  const bar      = $('#upload-bar-inner');
  const txt      = $('#upload-progress-text');
  progress.classList.remove('hidden');

  for (let i = 0; i < files.length; i++) {
    txt.textContent  = `Subiendo ${i + 1}/${files.length}: ${files[i].name}`;
    bar.style.width  = `${(i / files.length) * 100}%`;
    const fd = new FormData();
    fd.append('foto', files[i]);
    await fetch('/api/fotos', { method: 'POST', body: fd });
  }

  bar.style.width  = '100%';
  txt.textContent  = `${files.length} foto(s) subidas`;
  e.target.value   = '';
  setTimeout(() => progress.classList.add('hidden'), 2000);
  cargarFotosGrid();
});

$('#btnAgregarFotos').addEventListener('click', async () => {
  await cargarFotosGrid('#modalFotosGrid');
  $('#modalFotosGrid').querySelectorAll('.foto-thumb').forEach(el => {
    if (fotosSeleccionadas.includes(el.dataset.nombre)) el.classList.add('selected');
  });
  openModal($('#modalFotos'));
});

$('#modalFotosClose').addEventListener('click', () => closeModal($('#modalFotos')));

$('#btnConfirmarFotos').addEventListener('click', () => {
  fotosSeleccionadas = [...$('#modalFotosGrid').querySelectorAll('.foto-thumb.selected')]
    .map(el => el.dataset.nombre);
  closeModal($('#modalFotos'));
  renderFotosChips();
});

function renderFotosChips() {
  const row   = $('#fotosRow');
  const chips = $('#fotosChips');
  if (!fotosSeleccionadas.length) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');
  chips.innerHTML = fotosSeleccionadas.map(nombre => {
    const foto = fotosDisponibles.find(f => f.nombre === nombre);
    return `<span class="foto-chip">${foto ? `<img src="${foto.url}" alt="">` : ''}${nombre}</span>`;
  }).join('');
}

$('#btnClearFotos').addEventListener('click', () => {
  fotosSeleccionadas = [];
  renderFotosChips();
});

// ── GALERÍA ───────────────────────────────────────────
let currentSlides = [];
let currentIndex  = 0;
let currentTandaId = null;
let currentKind   = 'tanda'; // 'tanda' (carrusel) | 'story'
let tandas = [];

function openLightbox(slides, index, tandaId = null, kind = 'tanda') {
  currentSlides  = slides;
  currentIndex   = index;
  currentTandaId = tandaId;
  currentKind    = kind;
  showSlide();
  $('#lightbox').classList.remove('hidden');
  const hasId    = !!tandaId;
  const isStory  = kind === 'story';
  // Editar y ZIP funcionan para ambos; caption/duplicar son solo de carruseles
  $('#lightboxEdit').classList.toggle('hidden', !hasId);
  $('#lightboxCaption').classList.toggle('hidden', !hasId || isStory);
  $('#lightboxDuplicar').classList.toggle('hidden', !hasId || isStory);
  $('#lightboxZip').classList.toggle('hidden', !hasId);
}

$('#lightboxZip').addEventListener('click', () => {
  if (!currentTandaId) return;
  const base = currentKind === 'story' ? '/api/stories/' : '/api/tandas/';
  window.location.href = base + currentTandaId + '/zip';
});

function showSlide() {
  const url = currentSlides[currentIndex];
  const bust = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
  $('#lightboxImg').src = bust;
  $('#lightboxCounter').textContent = `${currentIndex + 1} / ${currentSlides.length}`;
  const dl = $('#lightboxDownload');
  dl.href     = url;
  dl.download = url.split('/').pop();
}

$('#lightboxClose').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
$('#lightboxPrev').addEventListener('click',  () => { currentIndex = (currentIndex - 1 + currentSlides.length) % currentSlides.length; showSlide(); });
$('#lightboxNext').addEventListener('click',  () => { currentIndex = (currentIndex + 1) % currentSlides.length; showSlide(); });
$('#lightbox').addEventListener('click',      e  => { if (e.target === $('#lightbox')) $('#lightbox').classList.add('hidden'); });
$('#lightboxEdit').addEventListener('click',  () => {
  $('#lightbox').classList.add('hidden');
  if (currentKind === 'story') {
    window.open(`/editor.html?story=${currentTandaId}`, '_blank');
  } else {
    editarTanda(currentTandaId);
  }
});

$('#lightboxCaption').addEventListener('click', () => {
  $('#lightbox').classList.add('hidden');
  abrirCaption(currentTandaId);
});

$('#lightboxDuplicar').addEventListener('click', async () => {
  const id = currentTandaId;
  const btn = $('#lightboxDuplicar');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const res  = await fetch(`/api/tandas/${id}/duplicar`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al clonar');
    $('#lightbox').classList.add('hidden');
    await cargarGaleria();
    editarTanda(data.id);
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⊕ Clonar';
  }
});

$('#captionClose').addEventListener('click', () => closeModal($('#modalCaption')));
$('#modalCaption').addEventListener('click', e => { if (e.target === $('#modalCaption')) closeModal($('#modalCaption')); });

$('#btnCopiarCaption').addEventListener('click', () => {
  navigator.clipboard.writeText($('#captionText').value).then(() => {
    const st = $('#captionStatus');
    st.textContent = 'Copiado';
    st.className = 'status ok';
    setTimeout(() => { st.textContent = ''; st.className = 'status'; }, 2000);
  });
});

$('#btnRegenerarCaption').addEventListener('click', () => generarCaption(captionTandaId));

let captionTandaId = null;

function abrirCaption(tandaId) {
  captionTandaId = tandaId;
  openModal($('#modalCaption'));
  generarCaption(tandaId);
}

async function generarCaption(tandaId) {
  $('#captionLoader').classList.remove('hidden');
  $('#captionContent').classList.add('hidden');
  $('#captionStatus').textContent = '';
  $('#btnRegenerarCaption').disabled = true;

  try {
    const res = await fetch(`/api/tandas/${tandaId}/caption`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al generar');
    $('#captionText').value = data.caption;
    $('#captionLoader').classList.add('hidden');
    $('#captionContent').classList.remove('hidden');
  } catch (e) {
    $('#captionLoader').classList.add('hidden');
    $('#captionContent').classList.remove('hidden');
    $('#captionStatus').textContent = e.message;
    $('#captionStatus').className = 'status error';
  } finally {
    $('#btnRegenerarCaption').disabled = false;
  }
}

let galeriaFiltro = 'todos';

document.querySelectorAll('.galeria-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    galeriaFiltro = tab.dataset.filter;
    document.querySelectorAll('.galeria-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    aplicarFiltroGaleria();
  });
});

function aplicarFiltroGaleria() {
  let visible = 0;
  document.querySelectorAll('#galeria .tanda').forEach(card => {
    const show = galeriaFiltro === 'todos' || card.dataset.estado === galeriaFiltro;
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  $('#galeriaEmpty').classList.toggle('hidden', visible > 0);
}

async function setEstado(id, card, newEstado) {
  const res = await fetch(`/api/tandas/${id}/estado`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estado: newEstado })
  });
  if (!res.ok) return;
  card.dataset.estado = newEstado;
  card.className = `tanda estado-${newEstado}`;
  card.querySelector('.tanda-save').classList.toggle('on', newEstado === 'guardado');
  card.querySelector('.tanda-disc').classList.toggle('on', newEstado === 'descartado');
  const t = tandas[Number(card.dataset.idx)];
  if (t) t.estado = newEstado;
  aplicarFiltroGaleria();
}

// ── SKELETONS de galería ───────────────────────────────
// Inserta un skeleton shimmer detrás de cada <img.cg-img-loading> de un
// contenedor y hace crossfade a la imagen cuando carga (o muestra placeholder
// de error). `ratio` es opcional ('9/16' para stories).
function aplicarSkeletons(container, ratio) {
  if (!container) return;
  container.querySelectorAll('img.cg-img-loading').forEach(img => {
    const card = img.closest('.tanda');
    if (!card || card.querySelector('.cg-skel')) return;

    const skel = document.createElement('div');
    skel.className = 'cg-skel';
    if (ratio) skel.dataset.ratio = ratio;
    card.insertBefore(skel, card.firstChild);

    const onReady = () => {
      img.classList.remove('cg-img-loading');
      img.classList.add('cg-img-ready');
      skel.classList.add('cg-skel-hidden');
      setTimeout(() => skel.remove(), 320);
    };
    const onError = () => {
      img.style.display = 'none';
      const tema = (img.getAttribute('alt') || '').trim();
      skel.classList.add('cg-skel-error');
      skel.innerHTML = `<span class="cg-err-icon">🖼</span><span class="cg-err-text">${tema || 'No se pudo cargar la imagen'}</span>`;
    };

    if (img.complete && img.naturalWidth > 0) { onReady(); return; }
    if (img.complete && img.naturalWidth === 0) { onError(); return; }
    img.addEventListener('load',  onReady,  { once: true });
    img.addEventListener('error', onError, { once: true });
  });
}

async function cargarGaleria() {
  tandas = await (await fetch('/api/tandas')).json();
  const galeria = $('#galeria');
  const empty   = $('#galeriaEmpty');

  if (!tandas.length) {
    galeria.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  galeria.innerHTML = tandas.map((t, i) => {
    const estado = t.estado || 'nuevo';
    return `
      <div class="tanda estado-${estado}" data-idx="${i}" data-estado="${estado}" data-id="${t.id}">
        <img class="cg-img-loading" src="${t.slides[0]}?t=${t.ts || Date.now()}" alt="${t.tema}" loading="lazy">
        <span class="count">${t.slides.length}</span>
        <div class="label">
          <span class="tanda-tema">${t.tema}</span>
          <div class="tanda-acts">
            <button class="tanda-edit" data-action="editar" title="Editar">✏</button>
            <button class="tanda-save${estado === 'guardado' ? ' on' : ''}" data-action="guardado" title="Guardar">★</button>
            <button class="tanda-disc${estado === 'descartado' ? ' on' : ''}" data-action="descartado" title="Descartar">✕</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  galeria.querySelectorAll('.tanda').forEach(card => {
    const t = tandas[Number(card.dataset.idx)];
    card.addEventListener('click', (e) => {
      if (e.target.closest('.tanda-acts')) return;
      openLightbox(t.slides, 0, t.id);
    });
    card.querySelector('.tanda-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(`/editor.html?tanda=${t.id}`, '_blank');
    });
    card.querySelector('.tanda-save').addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = card.dataset.estado;
      setEstado(t.id, card, cur === 'guardado' ? 'nuevo' : 'guardado');
    });
    card.querySelector('.tanda-disc').addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = card.dataset.estado;
      setEstado(t.id, card, cur === 'descartado' ? 'nuevo' : 'descartado');
    });
  });

  aplicarSkeletons(galeria);
  aplicarFiltroGaleria();
}

$('#btnRefrescar').addEventListener('click', () => { cargarGaleria(); cargarStoriesGaleria(); });

// ── ESTUDIAR CARRUSELES ───────────────────────────────
let estudiarFiles = [];

async function cargarReferencias() {
  if (!marcaActual) return;
  const res = await fetch(`/api/marcas/${marcaActual}/referencias`);
  const data = res.ok ? await res.json() : {};
  $('#referenciasArea').value = data.texto || '';
}

$('#estudiarInput').addEventListener('change', e => {
  estudiarFiles = [...e.target.files];
  const previews = $('#estudiarPreviews');
  previews.innerHTML = estudiarFiles.map(file => {
    const url = URL.createObjectURL(file);
    return `<div class="foto-thumb"><img src="${url}" alt="${file.name}"></div>`;
  }).join('');
  $('#btnEstudiar').disabled = !estudiarFiles.length;
});

$('#btnEstudiar').addEventListener('click', async () => {
  if (!marcaActual || !estudiarFiles.length) return;
  const btn = $('#btnEstudiar');
  const st  = $('#estudiarStatus');
  btn.disabled = true;
  st.textContent = 'Convirtiendo imágenes...';
  st.className   = 'status';

  try {
    const imagenes = await Promise.all(estudiarFiles.map(file => new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    })));

    st.textContent = `Analizando ${imagenes.length} slide(s) con IA...`;
    const resp = await fetch(`/api/marcas/${marcaActual}/estudiar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagenes })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Error desconocido' }));
      throw new Error(err.error || 'Error en el servidor');
    }

    st.textContent = '✓ Estilo analizado y guardado';
    st.className   = 'status ok';
    await cargarReferencias();
    $('#estudiarInput').value      = '';
    $('#estudiarPreviews').innerHTML = '';
    estudiarFiles = [];
    btn.disabled  = true;
  } catch (err) {
    st.textContent = '✗ ' + err.message;
    st.className   = 'status err';
    btn.disabled   = false;
  }
  setTimeout(() => { st.textContent = ''; st.className = 'status'; }, 5000);
});

$('#btnGuardarRefs').addEventListener('click', async () => {
  if (!marcaActual) return;
  const texto = $('#referenciasArea').value;
  const res = await fetch(`/api/marcas/${marcaActual}/referencias`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texto })
  });
  const st = $('#estudiarStatus');
  st.textContent = res.ok ? '✓ Guardado' : '✗ Error al guardar';
  st.className   = 'status ' + (res.ok ? 'ok' : 'err');
  setTimeout(() => { st.textContent = ''; st.className = 'status'; }, 3000);
});

$('#btnBorrarRefs').addEventListener('click', async () => {
  if (!marcaActual) return;
  if (!confirm('¿Borrar todo el estilo aprendido para esta marca?')) return;
  const res = await fetch(`/api/marcas/${marcaActual}/referencias`, { method: 'DELETE' });
  if (res.ok) {
    $('#referenciasArea').value = '';
    const st = $('#estudiarStatus');
    st.textContent = 'Referencias borradas';
    st.className   = 'status ok';
    setTimeout(() => { st.textContent = ''; st.className = 'status'; }, 3000);
  }
});

// ── EDITOR DE CARRUSEL ───────────────────────────────
let editorTandaId   = null;
let editorContenido = null;
let editorSlideIdx  = 0;
let editorTs        = Date.now();
// ── Undo / Redo ──────────────────────────────────────
const UNDO_LIMIT = 30;
let undoStack = [];  // snapshots anteriores
let redoStack = [];  // snapshots descartados por nuevas acciones

function saveSnapshot() {
  undoStack.push(JSON.stringify(editorContenido));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}

function updateUndoButtons() {
  const btnUndo = document.getElementById('btnUndo');
  const btnRedo = document.getElementById('btnRedo');
  if (btnUndo) btnUndo.disabled = undoStack.length === 0;
  if (btnRedo) btnRedo.disabled = redoStack.length === 0;
}

function applyHistoryState(snapshot) {
  editorContenido = JSON.parse(snapshot);
  renderEditorChips();
  renderEditorSlide(editorSlideIdx);
  updateUndoButtons();
}

function editorUndo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(editorContenido));
  applyHistoryState(undoStack.pop());
}

function editorRedo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(editorContenido));
  applyHistoryState(redoStack.pop());
}

document.addEventListener('keydown', e => {
  if (!editorContenido) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); editorUndo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); editorRedo(); }
});

async function editarTanda(tandaId) {
  editorTandaId = tandaId;
  try {
    const res = await fetch(`/api/tandas/${tandaId}/contenido`);
    if (!res.ok) throw new Error('No se encontró el contenido. Generá primero el carrusel.');
    editorContenido = await res.json();
  } catch (e) {
    alert(e.message);
    return;
  }
  editorSlideIdx  = 0;
  editorTs        = Date.now();
  undoStack = [];
  redoStack = [];
  editorTemplateHtml = null;
  editorTemplateLoading = false;
  $('#editorLog').textContent = '';
  $('#editorLog').classList.add('hidden');
  $('#editorStatus').textContent = '';
  $('#editorStatus').className = 'status';
  renderEditorChips();
  renderEditorSlide(0);
  $('#modalEditor').classList.remove('hidden');

  // Load sistema options
  loadSistemaOptions(tandaId);
  initEditorSwipe();
}

let editorSwipeTouchX = 0;

function initEditorSwipe() {
  const wrap = $('.editor-preview-wrap');
  if (!wrap || wrap._swipeInited) return;
  wrap._swipeInited = true;
  wrap.addEventListener('touchstart', e => {
    editorSwipeTouchX = e.touches[0].clientX;
  }, { passive: true });
  wrap.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - editorSwipeTouchX;
    if (Math.abs(dx) < 50) return;
    const total = editorContenido?.slides?.length || 1;
    if (dx < 0) {
      editorSlideIdx = (editorSlideIdx + 1) % total;
    } else {
      editorSlideIdx = (editorSlideIdx - 1 + total) % total;
    }
    renderEditorChips();
    renderEditorSlide(editorSlideIdx);
  }, { passive: true });
}

async function loadSistemaOptions(tandaId) {
  const section = $('#editorSistemaSection');
  const btnA = $('#btnSistemaA');
  const btnB = $('#btnSistemaB');
  try {
    const res = await fetch(`/api/tandas/${tandaId}/preview-sistemas`);
    if (!res.ok) { section.classList.add('hidden'); return; }
    const data = await res.json();
    const nameA = data.a?.nombre_sistema || 'A';
    const nameB = data.b?.nombre_sistema || 'B';
    const fontA = data.a?.tipografia?.display?.familia || '';
    const fontB = data.b?.tipografia?.display?.familia || '';
    btnA.textContent = `${nameA}${fontA ? ' · ' + fontA : ''}`;
    btnB.textContent = `${nameB}${fontB ? ' · ' + fontB : ''}`;
    const currentName = data.current?.nombre_sistema;
    btnA.classList.toggle('active', currentName === data.a?.nombre_sistema);
    btnB.classList.toggle('active', currentName === data.b?.nombre_sistema);
    section.classList.remove('hidden');
  } catch {
    section.classList.add('hidden');
  }
}

$('#btnSistemaA').addEventListener('click', async () => {
  if (!editorTandaId) return;
  await fetch(`/api/tandas/${editorTandaId}/apply-sistema`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sistema: 'a' })
  });
  loadSistemaOptions(editorTandaId);
});

$('#btnSistemaB').addEventListener('click', async () => {
  if (!editorTandaId) return;
  await fetch(`/api/tandas/${editorTandaId}/apply-sistema`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sistema: 'b' })
  });
  loadSistemaOptions(editorTandaId);
});

function renderEditorChips() {
  const chips = $('#editorChips');
  chips.innerHTML = editorContenido.slides.map((_, i) =>
    `<button class="editor-chip ${i === editorSlideIdx ? 'active' : ''}" data-idx="${i}">${String(i + 1).padStart(2, '0')}</button>`
  ).join('');
  chips.querySelectorAll('.editor-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      editorSlideIdx = parseInt(btn.dataset.idx);
      renderEditorChips();
      renderEditorSlide(editorSlideIdx);
    });
  });
}

function renderEditorSlide(idx) {
  const slide = editorContenido.slides[idx];
  const num   = String(idx + 1).padStart(2, '0');
  loadLivePreview(idx);

  const hasPhotoPos = !!slide.photo;
  const hasPhoto    = !!(slide.photo || slide.photo_before || slide.photo_after ||
                         slide.photo_top || slide.photo_bottom ||
                         (Array.isArray(slide.rows) && slide.rows.some(r => r.photo)));

  const globalOv  = editorContenido.overlay ?? 0.55;
  const slideOv   = slide._overlay ?? null;
  const photoPosY = (() => {
    const pos = slide._photoPos || 'center center';
    const m   = pos.match(/(\d+(?:\.\d+)?)%/);
    return m ? parseFloat(m[1]) : 50;
  })();
  const headlineAj = slide._headlineAjuste || 'normal';

  // Drag band — solo para slides con foto
  const wrap = $('.editor-preview-wrap');
  wrap.querySelectorAll('.drag-band').forEach(b => b.remove());
  if (hasPhoto) {
    const initY = slide._textY != null ? slide._textY :
                  slide._textPosition === 'top' ? 20 :
                  slide._textPosition === 'bottom' ? 75 : 50;
    const band = document.createElement('div');
    band.className = 'drag-band';
    band.style.top = initY + '%';
    band.innerHTML = '<span class="drag-band-label">≡ TEXTO — arrastrá para mover</span><span class="drag-band-hint">re-renderizá para aplicar</span>';
    wrap.appendChild(band);

    let dragging = false, startY = 0, startTopPx = 0;
    band.addEventListener('pointerdown', e => {
      saveSnapshot();
      dragging    = true;
      startY      = e.clientY;
      startTopPx  = (parseFloat(band.style.top) / 100) * wrap.offsetHeight;
      band.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    band.addEventListener('pointermove', e => {
      if (!dragging) return;
      const newTop = Math.max(5, Math.min(90, ((startTopPx + e.clientY - startY) / wrap.offsetHeight) * 100));
      band.style.top = newTop + '%';
      editorContenido.slides[editorSlideIdx]._textY = Math.round(newTop);
    });
    band.addEventListener('pointerup', () => { dragging = false; });
  }

  $('#editorControls').innerHTML = `
    <div class="ctrl-section">
      <p class="ctrl-label">GLOBAL</p>
      <div class="ctrl-row">
        <span class="ctrl-row-label">Oscuridad global</span>
        <div class="ctrl-right">
          <input type="range" id="ctrlGlobalOv" min="0.1" max="0.9" step="0.05" value="${globalOv}">
          <span class="ctrl-val" id="ctrlGlobalOvVal">${globalOv}</span>
        </div>
      </div>
    </div>

    ${hasPhoto ? `
    <div class="ctrl-section">
      <p class="ctrl-label">FOTO — slide ${num}</p>
      ${hasPhotoPos ? `
      <div class="ctrl-row">
        <span class="ctrl-row-label">Posición vertical de foto</span>
        <div class="ctrl-right">
          <input type="range" id="ctrlPhotoY" min="0" max="100" step="5" value="${photoPosY}">
          <span class="ctrl-val" id="ctrlPhotoYVal">${photoPosY}%</span>
        </div>
      </div>` : ''}
      <div class="ctrl-row">
        <span class="ctrl-row-label">Oscuridad de este slide</span>
        <div class="ctrl-right">
          <input type="range" id="ctrlSlideOv" min="0.1" max="0.9" step="0.05" value="${slideOv ?? globalOv}">
          <span class="ctrl-val" id="ctrlSlideOvVal">${slideOv !== null ? slideOv : globalOv}</span>
        </div>
      </div>
    </div>` : ''}

    <div class="ctrl-section">
      <p class="ctrl-label">TEXTO — slide ${num}</p>
      <div class="ctrl-row">
        <span class="ctrl-row-label">Tamaño</span>
        <div class="ctrl-right">
          <select id="ctrlHsAjuste">
            <option value="normal" ${headlineAj === 'normal'  ? 'selected' : ''}>Normal</option>
            <option value="small"  ${headlineAj === 'small'   ? 'selected' : ''}>Chico</option>
            <option value="xsmall" ${headlineAj === 'xsmall'  ? 'selected' : ''}>Muy chico</option>
          </select>
        </div>
      </div>
      <div class="ctrl-row">
        <span class="ctrl-row-label">Color titular</span>
        <div class="ctrl-right">
          <input type="color" id="ctrlColorHeadline" value="${slide._colorHeadline || editorContenido._sistema?.paleta?.headline || '#ffffff'}">
        </div>
      </div>
      <div class="ctrl-row">
        <span class="ctrl-row-label">Color cuerpo</span>
        <div class="ctrl-right">
          <input type="color" id="ctrlColorBody" value="${slide._colorBody || editorContenido._sistema?.paleta?.body_text || '#e0e0e0'}">
        </div>
      </div>
      ${hasPhoto ? `<p class="ctrl-hint">Arrastrá la banda amarilla en el preview para mover el texto.</p>` : ''}
    </div>
  `;

  // Mostrar botón de cambio de diseño si hay alternativa
  fetch(`/api/tandas/${editorTandaId}/contenido`)
    .then(r => r.json())
    .then(data => {
      const alt = data._sistema?._sistemaAlt;
      if (!alt) return;
      const sec = document.createElement('div');
      sec.className = 'ctrl-section';
      sec.innerHTML = `
        <p class="ctrl-label">DISEÑO ALTERNATIVO</p>
        <p class="ctrl-hint">Sistema: <strong>${alt.nombre_sistema || '?'}</strong> — ${alt.tipografia?.display?.familia || '?'}</p>
        <button id="btnSwitchDesign" class="btn-secondary" style="width:100%;margin-top:8px">⇄ Cambiar a este diseño (re-renderizar)</button>
      `;
      $('#editorControls').appendChild(sec);
      document.getElementById('btnSwitchDesign')?.addEventListener('click', async () => {
        const r = await fetch(`/api/tandas/${editorTandaId}/switch-design`, { method: 'POST' });
        if (!r.ok) { alert('Error al cambiar diseño'); return; }
        // Trigger re-render
        document.getElementById('btnRerenderizar')?.click();
      });
    });

  // Sección CONTENIDO — todos los campos de texto del slide
  const TEXT_FIELDS = [
    { key: 'headline',        label: 'Titular',        multi: false },
    { key: 'subheadline',     label: 'Subtitular',     multi: false },
    { key: 'kicker',          label: 'Kicker',         multi: false },
    { key: 'eyebrow',         label: 'Eyebrow',        multi: false },
    { key: 'body',            label: 'Cuerpo',         multi: true  },
    { key: 'detail',          label: 'Detalle',        multi: true  },
    { key: 'caption',         label: 'Caption',        multi: true  },
    { key: 'stat',            label: 'Estadística',    multi: false },
    { key: 'label',           label: 'Etiqueta',       multi: false },
    { key: 'sub',             label: 'Sub',            multi: false },
    { key: 'quote',           label: 'Cita',           multi: true  },
    { key: 'author',          label: 'Autor',          multi: false },
    { key: 'attr',            label: 'Atribución',     multi: false },
    { key: 'note',            label: 'Nota',           multi: true  },
    { key: 'line1',           label: 'Línea 1',        multi: false },
    { key: 'line2',           label: 'Línea 2',        multi: false },
    { key: 'footer_text',     label: 'Pie de página',  multi: false },
    { key: 'handle',          label: 'Handle',         multi: false },
    { key: 'cta',             label: 'CTA',            multi: false },
    { key: 'contrast_top',    label: 'Texto sup.',     multi: false },
    { key: 'contrast_bottom', label: 'Texto inf.',     multi: false },
    { key: 'label_top',       label: 'Etiqueta sup.',  multi: false },
    { key: 'label_bottom',    label: 'Etiqueta inf.',  multi: false },
  ];
  const activeFields    = TEXT_FIELDS.filter(f => slide[f.key] != null);
  const hasItems        = Array.isArray(slide.items) && slide.items.length;
  const hasHeadlineLines = Array.isArray(slide.headline_lines) && slide.headline_lines.length;

  if (activeFields.length || hasItems || hasHeadlineLines) {
    const section = document.createElement('div');
    section.className = 'ctrl-section';
    section.innerHTML = `<p class="ctrl-label">CONTENIDO — slide ${num}</p>`;

    // headline_lines: editar cada línea del hero cover
    if (hasHeadlineLines) {
      slide.headline_lines.forEach((line, li) => {
        const row = document.createElement('div');
        row.className = 'ctrl-row ctrl-row-col';
        row.innerHTML = `
          <span class="ctrl-row-label">Línea hero ${li + 1} <small style="opacity:.5">(${line.size || 'hero'})</small></span>
          <input class="ctrl-input" type="text" value="${String(line.text || '').replace(/"/g, '&quot;')}">
        `;
        const inp = row.querySelector('input');
        inp.addEventListener('focus', saveSnapshot, { once: true });
        inp.addEventListener('input', () => {
          editorContenido.slides[editorSlideIdx].headline_lines[li].text = inp.value;
        });
        section.appendChild(row);
      });
    }

    activeFields.forEach(({ key, label, multi }) => {
      const row = document.createElement('div');
      row.className = 'ctrl-row ctrl-row-col';
      const safeVal = String(slide[key]).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      if (multi) {
        const lbl = document.createElement('span');
        lbl.className = 'ctrl-row-label';
        lbl.textContent = label;
        const ta = document.createElement('textarea');
        ta.className = 'ctrl-textarea';
        ta.rows = 3;
        ta.value = String(slide[key]);
        ta.addEventListener('focus', saveSnapshot, { once: true });
        ta.addEventListener('input', () => { editorContenido.slides[editorSlideIdx][key] = ta.value; });
        row.appendChild(lbl);
        row.appendChild(ta);
      } else {
        const lbl = document.createElement('span');
        lbl.className = 'ctrl-row-label';
        lbl.textContent = label;
        const inp = document.createElement('input');
        inp.className = 'ctrl-input';
        inp.type = 'text';
        inp.value = String(slide[key]);
        inp.addEventListener('focus', saveSnapshot, { once: true });
        inp.addEventListener('input', () => { editorContenido.slides[editorSlideIdx][key] = inp.value; });
        row.appendChild(lbl);
        row.appendChild(inp);
      }
      section.appendChild(row);
    });

    if (hasHeadlineLines) {
      const fieldId = 'ctrlText_headline_lines';
      const row = document.createElement('div');
      row.className = 'ctrl-row ctrl-row-col';
      row.innerHTML = `
        <span class="ctrl-row-label">Titular (líneas, una por fila)</span>
        <textarea id="${fieldId}" class="ctrl-textarea" rows="${Math.min(slide.headline_lines.length + 1, 6)}">${slide.headline_lines.map(l => typeof l === 'object' ? l.text : l).join('\n')}</textarea>
      `;
      section.appendChild(row);
    }

    if (hasItems) {
      const row = document.createElement('div');
      row.className = 'ctrl-row ctrl-row-col';
      const lbl = document.createElement('span');
      lbl.className = 'ctrl-row-label';
      lbl.textContent = 'Items (uno por línea)';
      const ta = document.createElement('textarea');
      ta.className = 'ctrl-textarea';
      ta.rows = Math.min(slide.items.length + 1, 8);
      ta.value = slide.items.join('\n');
      ta.addEventListener('focus', saveSnapshot, { once: true });
      ta.addEventListener('input', () => {
        editorContenido.slides[editorSlideIdx].items = ta.value.split('\n').filter(l => l.trim());
      });
      row.appendChild(lbl);
      row.appendChild(ta);
      section.appendChild(row);
    }

    $('#editorControls').appendChild(section);

  if (slide._fotoSugerida) {
    const section = document.createElement('div');
    section.className = 'ctrl-section';
    section.innerHTML = `<p class="ctrl-label">FOTO SUGERIDA</p><p class="ctrl-hint" style="font-style:italic;color:var(--text-muted)">${slide._fotoSugerida}</p>`;
    $('#editorControls').appendChild(section);
  }

    // Bind texto → editorContenido
    activeFields.forEach(({ key }) => {
      const el = document.getElementById(`ctrlText_${key}`);
      if (!el) return;
      el.addEventListener('focus', () => {
        saveSnapshot();
        // En mobile el teclado tapa el modal — scrollear para que el campo quede visible
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
      }, { once: true });
      el.addEventListener('input', () => { editorContenido.slides[editorSlideIdx][key] = el.value; sendLiveUpdate(editorSlideIdx); });
    });
    if (hasHeadlineLines) {
      const el = document.getElementById('ctrlText_headline_lines');
      if (el) {
        el.addEventListener('focus', saveSnapshot, { once: true });
        el.addEventListener('input', () => {
          const lines = el.value.split('\n');
          const orig  = editorContenido.slides[editorSlideIdx].headline_lines;
          editorContenido.slides[editorSlideIdx].headline_lines = lines.map((text, i) => {
            const o = orig[i];
            return (o && typeof o === 'object') ? { ...o, text } : text;
          });
          sendLiveUpdate(editorSlideIdx);
        });
      }
    }
    if (hasItems) {
      const el = document.getElementById('ctrlText_items');
      if (el) {
        el.addEventListener('focus', saveSnapshot, { once: true });
        el.addEventListener('input', () => {
          editorContenido.slides[editorSlideIdx].items = el.value.split('\n').filter(l => l.trim());
          sendLiveUpdate(editorSlideIdx);
        });
      }
    }
  }

  // Bind controls → editorContenido
  const bind = (id, valId, update, fmt = v => v) => {
    const el = document.getElementById(id);
    const vl = document.getElementById(valId);
    if (!el) return;
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => {
        saveSnapshot();
        update(el.value);
      });
    } else {
      // Slider: snapshot en mousedown (antes de que empiece a cambiar)
      el.addEventListener('mousedown', saveSnapshot, { once: false });
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        update(v);
        if (vl) vl.textContent = fmt(v);
      });
    }
  };

  bind('ctrlGlobalOv', 'ctrlGlobalOvVal', v => { editorContenido.overlay = v; });
  bind('ctrlPhotoY',   'ctrlPhotoYVal',   v => { editorContenido.slides[editorSlideIdx]._photoPos = `center ${v}%`; }, v => `${v}%`);
  bind('ctrlSlideOv',  'ctrlSlideOvVal',  v => { editorContenido.slides[editorSlideIdx]._overlay = v; });
  bind('ctrlHsAjuste', null, v => { editorContenido.slides[editorSlideIdx]._headlineAjuste = v; });

  const colorHl = document.getElementById('ctrlColorHeadline');
  const colorBd = document.getElementById('ctrlColorBody');
  if (colorHl) colorHl.addEventListener('input', () => {
    saveSnapshot();
    editorContenido.slides[editorSlideIdx]._colorHeadline = colorHl.value;
  });
  if (colorBd) colorBd.addEventListener('input', () => {
    saveSnapshot();
    editorContenido.slides[editorSlideIdx]._colorBody = colorBd.value;
  });

  // Debounced live update on any input change
  $('#editorControls').addEventListener('input', () => {
    clearTimeout(liveUpdateTimer);
    liveUpdateTimer = setTimeout(() => sendLiveUpdate(editorSlideIdx), 200);
  });
}

async function loadLivePreview(idx) {
  const frame = $('#editorSlideFrame');
  const img = $('#editorSlideImg');
  const num = String(idx + 1).padStart(2, '0');

  if (!editorTemplateHtml && !editorTemplateLoading) {
    editorTemplateLoading = true;
    try {
      const res = await fetch(`/api/tandas/${editorTandaId}/template-html`);
      if (res.ok) {
        editorTemplateHtml = await res.text();
      }
    } catch {}
    editorTemplateLoading = false;
  }

  if (editorTemplateHtml) {
    if (!frame.srcdoc) {
      frame.srcdoc = editorTemplateHtml;
      frame.style.display = '';
      img.style.display = 'none';
      // Wait for frame load then send liveUpdate
      frame.onload = () => sendLiveUpdate(idx);
    } else {
      sendLiveUpdate(idx);
    }
    // Scale frame to fit container
    const wrap = $('#editorPreviewWrap') || frame.parentElement;
    const containerWidth = wrap.offsetWidth || 400;
    const scale = containerWidth / 1080;
    frame.style.transform = `scale(${scale})`;
    frame.style.height = `${1350 * scale}px`;
    wrap.style.height = `${1350 * scale}px`;
  } else {
    // Fallback to img
    img.style.display = '';
    if (frame) frame.style.display = 'none';
    img.src = `/tandas/${editorTandaId}/output/slide-${num}.png?t=${editorTs}`;
  }
}

function sendLiveUpdate(idx) {
  const frame = $('#editorSlideFrame');
  if (!frame || !frame.contentWindow) return;
  frame.contentWindow.postMessage({ type: 'liveUpdate', contenido: editorContenido, idx }, '*');
}

$('#editorClose').addEventListener('click', () => {
  clearInterval(editorLiveTimer);
  editorLivePreview = false;
  const btn = $('#btnLivePreview');
  if (btn) btn.classList.remove('active');
  closeModal($('#modalEditor'));
});
$('#btnUndo').addEventListener('click', editorUndo);
$('#btnRedo').addEventListener('click', editorRedo);

let editorLivePreview = false;
let editorLiveTimer = null;

$('#btnLivePreview').addEventListener('click', () => {
  editorLivePreview = !editorLivePreview;
  const btn = $('#btnLivePreview');
  if (editorLivePreview) {
    btn.classList.add('active');
    btn.textContent = '◉ Viva';
    editorLiveTimer = setInterval(() => {
      const img = $('#editorSlideImg');
      if (img) img.src = img.src.replace(/\?t=\d+/, '') + '?t=' + Date.now();
    }, 3000);
  } else {
    btn.classList.remove('active');
    btn.textContent = '◎ Vista';
    clearInterval(editorLiveTimer);
    editorLiveTimer = null;
  }
});

$('#btnRerenderizar').addEventListener('click', async () => {
  const btn = $('#btnRerenderizar');
  const st  = $('#editorStatus');
  try {
    await fetch(`/api/tandas/${editorTandaId}/contenido`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editorContenido)
    });
    const res = await fetch(`/api/tandas/${editorTandaId}/rerenderizar`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json();
      st.textContent = '✗ ' + err.error;
      st.className   = 'status err';
      return;
    }
    editorRerenderizing = true;
    btn.disabled        = true;
    st.textContent      = '';
    const edLog = $('#editorLog');
    edLog.textContent = '';
    edLog.classList.remove('hidden');
  } catch (e) {
    st.textContent = '✗ ' + e.message;
    st.className   = 'status err';
  }
});

// ── CLONADOR DE DISEÑO ────────────────────────────────
async function cargarClonarGrid() {
  const res  = await fetch(`/api/marcas/${marcaActual}/referencias-img`);
  const data = await res.json();
  const grid  = $('#clonarGrid');
  const empty = $('#clonarEmpty');
  if (!data.files?.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = data.files.map(f => `
    <div class="foto-thumb clonar-thumb" data-file="${f}">
      <img src="/marcas/${marcaActual}/referencias/${f}" alt="${f}">
      <button class="foto-delete clonar-delete" data-file="${f}">×</button>
    </div>
  `).join('');
  grid.querySelectorAll('.clonar-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/marcas/${marcaActual}/referencias-img/${btn.dataset.file}`, { method: 'DELETE' });
      cargarClonarGrid();
    });
  });
}

$('#clonarInput').addEventListener('change', async () => {
  const files = Array.from($('#clonarInput').files);
  if (!files.length) return;
  for (const file of files) {
    const reader = new FileReader();
    await new Promise(resolve => {
      reader.onload = async (e) => {
        await fetch(`/api/marcas/${marcaActual}/referencias-img`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, data: e.target.result })
        });
        resolve();
      };
      reader.readAsDataURL(file);
    });
  }
  $('#clonarInput').value = '';
  cargarClonarGrid();
});

// ── TEMPLATES ─────────────────────────────────────────
function tplKey()           { return `templates_${marcaActual || 'default'}`; }
function getTemplates()     { try { return JSON.parse(localStorage.getItem(tplKey()) || '[]'); } catch { return []; } }
function saveTemplatesLS(t) { localStorage.setItem(tplKey(), JSON.stringify(t)); }

function renderTemplatesList() {
  const list = $('#templatesList');
  if (!list) return;
  const tpls = getTemplates();
  if (!tpls.length) {
    list.innerHTML = '<p class="hint" style="margin:0 0 10px">Todavía no hay templates.</p>';
    return;
  }
  list.innerHTML = tpls.map(t => `
    <div class="tpl-item">
      <div class="tpl-item-info">
        <span class="tpl-item-name">${t.nombre}</span>
        <span class="tpl-item-preview">${t.instrucciones.slice(0, 80)}${t.instrucciones.length > 80 ? '…' : ''}</span>
      </div>
      <button class="btn-ghost btn-sm tpl-delete" data-id="${t.id}">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('.tpl-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const updated = getTemplates().filter(t => t.id !== btn.dataset.id);
      saveTemplatesLS(updated);
      renderTemplatesList();
      renderTplPickerChips();
    });
  });
}

function renderTplPickerChips() {
  const block = $('#tplPickerBlock');
  const chips = $('#tplPickerChips');
  if (!block || !chips) return;
  const tpls = getTemplates();
  block.classList.toggle('hidden', !tpls.length);
  chips.innerHTML = tpls.map(t =>
    `<button class="tpl-chip" data-id="${t.id}">${t.nombre}</button>`
  ).join('');
  chips.querySelectorAll('.tpl-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = getTemplates().find(x => x.id === btn.dataset.id);
      if (!t) return;
      $('#instruccionesLibres').value = t.instrucciones;
      chips.querySelectorAll('.tpl-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

$('#btnGuardarTemplate').addEventListener('click', () => {
  const nombre        = $('#tplNombre').value.trim();
  const instrucciones = $('#tplInstrucciones').value.trim();
  if (!nombre || !instrucciones) return;
  const tpls = getTemplates();
  tpls.push({ id: Date.now().toString(), nombre, instrucciones });
  saveTemplatesLS(tpls);
  $('#tplNombre').value        = '';
  $('#tplInstrucciones').value = '';
  renderTemplatesList();
});

// ── DISEÑO BASE (font picker) ─────────────────────────
const FONT_PAIRS_UI = [
  { id: 'auto',                  display: 'IA elige',    body: '',               mood: 'La IA elige la tipografía para cada carrusel según el tema y tono', isAuto: true },
  { id: 'bebas-inter',           display: 'Bebas Neue',  body: '+ Inter',        mood: 'Editorial · fitness · impacto' },
  { id: 'oswald-dm',             display: 'Oswald',      body: '+ DM Sans',      mood: 'Deportivo · directo · masculino' },
  { id: 'barlow-barlow',         display: 'Barlow Cond', body: '+ Barlow',       mood: 'Moderno · clean · tech' },
  { id: 'playfair-dm',           display: 'Playfair',    body: '+ DM Sans',      mood: 'Luxury · premium · editorial' },
  { id: 'anton-inter',           display: 'Anton',       body: '+ Inter',        mood: 'Street · urbano · agresivo' },
  { id: 'archivo-inter',         display: 'Archivo Black', body: '+ Inter',      mood: 'Editorial bold · diseño' },
  { id: 'space-space',           display: 'Space Grotesk', body: '+ Space',      mood: 'Tech · datos · startup' },
  { id: 'syne-inter',            display: 'Syne',        body: '+ Inter',        mood: 'Diseño de autor · disruptivo' },
  { id: 'dm-serif-dm',           display: 'DM Serif',    body: '+ DM Sans',      mood: 'Revista · editorial cálido' },
  { id: 'unbounded-inter',       display: 'Unbounded',   body: '+ Inter',        mood: 'Web3 · tech extremo · bold' },
  { id: 'instrument-dm',         display: 'Instrument',  body: '+ DM Sans',      mood: 'Ultra premium · luxury' },
  { id: 'montserrat-montserrat', display: 'Montserrat',  body: '+ Montserrat',   mood: 'Versátil · limpio · corporativo' },
  { id: 'raleway-outfit',        display: 'Raleway',     body: '+ Outfit',       mood: 'Aspiracional · wellness · femenino' },
];

let disenoActual = {};

async function cargarDiseno() {
  if (!marcaActual) return;
  try {
    const res = await fetch(`/api/marcas/${marcaActual}/diseno`);
    disenoActual = res.ok ? await res.json() : {};
  } catch { disenoActual = {}; }
  renderFontPairGrid();
}

function renderFontPairGrid() {
  const grid = $('#fontPairGrid');
  if (!grid) return;
  const selected = disenoActual.font_pair_id || 'auto';
  grid.innerHTML = FONT_PAIRS_UI.map(fp => `
    <div class="font-pair-card${fp.id === selected ? ' selected' : ''}${fp.isAuto ? ' fp-auto' : ''}" data-id="${fp.id}">
      <div>
        <div class="fp-display">${fp.display}</div>
        ${fp.body ? `<div class="fp-body">${fp.body}</div>` : ''}
      </div>
      <div class="fp-mood">${fp.mood}</div>
    </div>
  `).join('');
  grid.querySelectorAll('.font-pair-card').forEach(card => {
    card.addEventListener('click', async () => {
      const id = card.dataset.id;
      const payload = id === 'auto' ? {} : { font_pair_id: id };
      const res = await fetch(`/api/marcas/${marcaActual}/diseno`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) return;
      disenoActual = payload;
      grid.querySelectorAll('.font-pair-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const st = $('#disenoStatus');
      st.textContent = id === 'auto' ? 'La IA elige la fuente automáticamente' : `Fuente guardada: ${card.querySelector('.fp-display').textContent}`;
      setTimeout(() => { if (st) st.textContent = ''; }, 2500);
    });
  });
}

// ── CHAT / ASISTENTE ──────────────────────────────────
(function initChat() {
  const form        = $('#chatForm');
  const input       = $('#chatInput');
  const messages    = $('#chatMessages');
  const sendBtn     = $('#chatSend');
  const suggestions = $('#chatSuggestions');
  if (!form) return;

  let chatHistory = []; // { role: 'user'|'assistant', content: string }

  function scrollBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function addBubble(role, text, actionCard = null) {
    const wrap = document.createElement('div');
    wrap.className = `chat-bubble chat-${role === 'user' ? 'user' : 'ai'}`;

    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    avatar.textContent = role === 'user' ? 'TÚ' : 'AI';

    const textEl = document.createElement('div');
    textEl.className = 'chat-text';
    textEl.textContent = text;

    wrap.appendChild(avatar);
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-width:calc(100% - 50px)';
    right.appendChild(textEl);
    if (actionCard) right.appendChild(actionCard);
    wrap.appendChild(right);

    messages.appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  function addTyping() {
    const wrap = document.createElement('div');
    wrap.className = 'chat-bubble chat-ai chat-typing';

    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    avatar.textContent = 'AI';

    const textEl = document.createElement('div');
    textEl.className = 'chat-text';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('div');
      dot.className = 'chat-dot';
      textEl.appendChild(dot);
    }

    wrap.appendChild(avatar);
    wrap.appendChild(textEl);
    messages.appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  function buildActionCard(action) {
    if (!action) return null;
    const card = document.createElement('div');
    card.className = 'chat-action-card';

    const label = document.createElement('span');
    label.className = 'chat-action-label';

    const btn = document.createElement('button');
    btn.className = 'chat-action-btn';

    if (action.type === 'show_tanda') {
      label.textContent = `Ver carrusel`;
      btn.textContent = 'Abrir';
      btn.addEventListener('click', () => {
        // Switch to gallery tab and highlight the tanda
        switchTab('tab-galeria');
        setTimeout(() => {
          const el = document.querySelector(`[data-tanda-id="${action.params.id}"]`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
      });
    } else if (action.type === 'generate') {
      label.textContent = `Generar: "${action.params.tema}"`;
      btn.textContent = 'Generar';
      btn.addEventListener('click', () => {
        switchTab('tab-generar');
        const temaInput = $('#temaInput');
        if (temaInput) temaInput.value = action.params.tema;
        setTimeout(() => $('#btnGenerar')?.click(), 200);
      });
    } else if (action.type === 'set_estado') {
      label.textContent = `Marcar como ${action.params.estado}`;
      btn.textContent = 'Confirmar';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '...';
        try {
          await fetch(`/api/tandas/${action.params.id}/estado`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ estado: action.params.estado })
          });
          btn.textContent = '✓ Listo';
          setTimeout(() => cargarGaleria(), 500);
        } catch { btn.textContent = 'Error'; }
      });
    } else if (action.type === 'go_tab') {
      label.textContent = `Ir a ${action.params.tab.replace('tab-', '')}`;
      btn.textContent = 'Ir';
      btn.addEventListener('click', () => switchTab(action.params.tab));
    } else if (action.type === 'open_editor') {
      label.textContent = `Abrir editor`;
      btn.textContent = 'Editar';
      btn.addEventListener('click', () => {
        // Find the tanda in gallery and trigger its edit button
        switchTab('tab-galeria');
        setTimeout(() => {
          const el = document.querySelector(`[data-tanda-id="${action.params.id}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.querySelector?.('.btn-edit')?.click();
          }
        }, 400);
      });
    } else if (action.type === 'edit_slide') {
      if (action.executed) {
        label.textContent = `Slide ${action.params.slide} editado — re-renderizando`;
        btn.textContent = 'Ver galería';
        btn.addEventListener('click', () => {
          switchTab('tab-galeria');
          setTimeout(() => cargarGaleria(), 1000);
        });
      } else {
        label.textContent = `Editar slide ${action.params.slide}`;
        btn.textContent = 'Ver galería';
        btn.addEventListener('click', () => switchTab('tab-galeria'));
      }
    } else if (action.type === 'propose_plan') {
      // Render rich plan card
      const plan = action.params?.slides || [];
      const format = action.params?.format || 'carrusel';
      const planCard = document.createElement('div');
      planCard.className = 'plan-card';
      planCard.innerHTML = `
        <div class="plan-header">📋 Plan propuesto — ${format === 'story' ? 'Historia' : 'Carrusel'} (${plan.length} slides)</div>
        <div class="plan-slides">${plan.map(s => `
          <div class="plan-slide">
            <span class="plan-num">${s.position}</span>
            <span class="plan-type">${s.type}</span>
            <span class="plan-desc">${s.title || ''}${s.notes ? ` — ${s.notes}` : ''}</span>
          </div>`).join('')}
        </div>
        <div class="plan-actions">
          <button class="btn-secondary plan-btn-edit">✏ Modificar</button>
          <button class="btn-primary plan-btn-ok">✓ Generar así</button>
        </div>`;
      planCard.querySelector('.plan-btn-edit').addEventListener('click', () => {
        const inp = $('#chatInput');
        if (inp) { inp.focus(); inp.placeholder = '¿Qué cambiamos?'; }
      });
      planCard.querySelector('.plan-btn-ok').addEventListener('click', () => {
        const inp = $('#chatInput');
        if (inp) { inp.value = 'Generá con este plan'; inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
      });
      return planCard;
    } else if (action.type === 'confirm_generate') {
      label.textContent = action.executing
        ? `Generando ${action.params?.format || 'carrusel'}... revisá el log`
        : `Generación lista`;
      btn.textContent = 'Ver log';
      btn.addEventListener('click', () => switchTab('tab-generar'));
    } else {
      return null;
    }

    card.appendChild(label);
    card.appendChild(btn);
    return card;
  }

  async function sendMessage(text) {
    if (!text.trim()) return;
    if (sendBtn.disabled) return;

    suggestions.style.display = 'none';
    sendBtn.disabled = true;
    input.value = '';
    input.style.height = 'auto';

    addBubble('user', text);
    chatHistory.push({ role: 'user', content: text });

    const typingEl = addTyping();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: chatHistory.slice(-10), marca: marcaActual })
      });
      const data = await res.json();
      typingEl.remove();

      const actionCard = buildActionCard(data.action);
      addBubble('assistant', data.reply || 'Lo siento, no pude procesar eso.', actionCard);
      chatHistory.push({ role: 'assistant', content: data.reply || '' });

      // Auto-execute non-destructive navigation actions
      if (data.action?.type === 'go_tab') {
        switchTab(data.action.params.tab);
      }
      // If slide was edited server-side, refresh gallery in background
      if (data.action?.type === 'edit_slide' && data.action.executed) {
        setTimeout(() => cargarGaleria(), 4000);
      }
    } catch (e) {
      typingEl.remove();
      addBubble('assistant', 'Hubo un error al conectarme con la IA. Intentá de nuevo.');
    }

    sendBtn.disabled = false;
    input.focus();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(input.value.trim());
  });

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // Enter to send (Shift+Enter for newline)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input.value.trim());
    }
  });

  // Suggestion chips
  suggestions.querySelectorAll('.chat-suggestion').forEach(btn => {
    btn.addEventListener('click', () => sendMessage(btn.dataset.msg));
  });
})();

// ── SERIES / CALENDARIO ───────────────────────────────
let seriesData = [];
let serieActiva = null; // serie abierta en vista calendario

const ARCO_LABELS = {
  'intriga-progresiva': 'Intriga progresiva',
  'educativo-escalonado': 'Educativo escalonado',
  'antes-durante-despues': 'Antes / Durante / Después',
  'lanzamiento-countdown': 'Lanzamiento countdown',
};
const ESTADO_PIEZA_LABEL = { pendiente: 'Pendiente', generado: 'Generado', publicado: 'Publicado' };

function toggleSerieForm(show) {
  const f = $('#serieForm');
  if (!f) return;
  f.classList.toggle('hidden', !show);
  if (show) {
    // default fecha de inicio = hoy
    const hoy = new Date().toISOString().slice(0, 10);
    if (!$('#serieFechaInicio').value) $('#serieFechaInicio').value = hoy;
  }
}

$('#btnNuevaSerie')?.addEventListener('click', () => toggleSerieForm(!$('#serieForm')?.classList.contains('hidden') ? false : true));
$('#btnCancelarSerie')?.addEventListener('click', () => toggleSerieForm(false));
$('#btnVolverSeries')?.addEventListener('click', () => {
  serieActiva = null;
  $('#serieCalendario')?.classList.add('hidden');
  $('#seriesList')?.classList.remove('hidden');
  cargarSeries();
});

async function cargarSeries() {
  if (!marcaActual) return;
  const res = await fetch(`/api/series?marca=${encodeURIComponent(marcaActual)}`);
  seriesData = res.ok ? await res.json() : [];
  renderSeriesList();
}

function renderSeriesList() {
  const list = $('#seriesList');
  const empty = $('#seriesEmpty');
  if (!list) return;
  if (!seriesData.length) {
    list.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');
  list.innerHTML = seriesData.map(s => {
    const generadas = (s.piezas || []).filter(p => p.estado === 'generado' || p.estado === 'publicado').length;
    const total = s.totalPiezas || (s.piezas || []).length;
    return `
      <div class="serie-card" data-id="${s.id}">
        <div class="serie-card-main">
          <span class="serie-card-nombre">${s.nombre}</span>
          <span class="serie-card-meta">${ARCO_LABELS[s.arco] || s.arco} · ${total} piezas · ${s.tipo}</span>
        </div>
        <div class="serie-card-side">
          <span class="serie-card-prog">${generadas}/${total}</span>
          <button class="btn-ghost btn-sm" data-open="${s.id}">Abrir calendario ›</button>
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('[data-open]').forEach(btn => {
    btn.addEventListener('click', () => abrirCalendario(btn.dataset.open));
  });
}

async function abrirCalendario(serieId) {
  const res = await fetch(`/api/series/${serieId}?marca=${encodeURIComponent(marcaActual)}`);
  if (!res.ok) { alert('No se pudo cargar la serie'); return; }
  serieActiva = await res.json();
  $('#seriesList')?.classList.add('hidden');
  $('#seriesEmpty')?.classList.add('hidden');
  $('#serieForm')?.classList.add('hidden');
  $('#serieCalendario')?.classList.remove('hidden');
  $('#serieCalTitulo').textContent = serieActiva.nombre;
  renderCalendario();
}

// Renderiza una grilla de 4 semanas a partir de la primera fecha de la serie
function renderCalendario() {
  const grid = $('#calendarGrid');
  if (!grid || !serieActiva) return;
  const piezas = serieActiva.piezas || [];

  // Mapa fecha -> piezas
  const porFecha = {};
  for (const p of piezas) { (porFecha[p.fecha] = porFecha[p.fecha] || []).push(p); }

  // Fecha base: lunes de la semana de la primera fecha
  const fechas = piezas.map(p => p.fecha).sort();
  const primera = fechas[0] ? new Date(fechas[0] + 'T12:00:00') : new Date();
  const diaSemana = (primera.getDay() + 6) % 7; // lunes=0
  const inicio = new Date(primera);
  inicio.setDate(inicio.getDate() - diaSemana);

  const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  let html = DIAS.map(d => `<div class="cal-head">${d}</div>`).join('');

  for (let i = 0; i < 28; i++) {
    const d = new Date(inicio);
    d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const piezasDia = porFecha[iso] || [];
    const cells = piezasDia.map(p => {
      const thumb = (p.slides && p.slides[0]) ? `<img src="${p.slides[0]}" loading="lazy" alt="">` : `<div class="cal-piece-empty">${p.tipo === 'story' ? '▭' : '◳'}</div>`;
      return `<div class="cal-piece estado-${p.estado}" data-tanda="${p.tandaId || ''}" data-orden="${p.orden}" draggable="${p.tandaId ? 'true' : 'false'}" title="${p.titulo} (${ESTADO_PIEZA_LABEL[p.estado]})">
        ${thumb}
        <span class="cal-piece-tag">P${p.orden}</span>
      </div>`;
    }).join('');
    html += `<div class="cal-cell" data-fecha="${iso}"><span class="cal-date">${d.getDate()}</span>${cells}</div>`;
  }
  grid.innerHTML = html;
  wireCalendario();
}

function wireCalendario() {
  const grid = $('#calendarGrid');
  if (!grid) return;

  // Click pieza -> lightbox
  grid.querySelectorAll('.cal-piece').forEach(el => {
    el.addEventListener('click', () => {
      const tandaId = el.dataset.tanda;
      if (!tandaId) return;
      const pieza = (serieActiva.piezas || []).find(p => p.tandaId === tandaId);
      if (pieza?.slides?.length) openLightbox(pieza.slides, 0, tandaId, pieza.tipo === 'story' ? 'story' : 'tanda');
    });
    // Botón derecho / doble click -> marcar publicado/generado
    el.addEventListener('dblclick', async (e) => {
      e.preventDefault();
      const tandaId = el.dataset.tanda;
      const pieza = (serieActiva.piezas || []).find(p => p.tandaId === tandaId);
      if (!pieza || !tandaId) return;
      const nuevo = pieza.estado === 'publicado' ? 'generado' : 'publicado';
      await fetch(`/api/series/${serieActiva.id}/estado/${tandaId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marca: marcaActual, estado: nuevo })
      });
      pieza.estado = nuevo;
      renderCalendario();
    });
  });

  // Drag & drop para reagendar
  let dragging = null;
  grid.querySelectorAll('.cal-piece[draggable="true"]').forEach(el => {
    el.addEventListener('dragstart', () => { dragging = el.dataset.tanda; });
  });
  grid.querySelectorAll('.cal-cell').forEach(cell => {
    cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('drop-hover'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('drop-hover'));
    cell.addEventListener('drop', async e => {
      e.preventDefault();
      cell.classList.remove('drop-hover');
      if (!dragging) return;
      const fecha = cell.dataset.fecha;
      const pieza = (serieActiva.piezas || []).find(p => p.tandaId === dragging);
      if (!pieza) return;
      await fetch(`/api/series/${serieActiva.id}/fecha/${dragging}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marca: marcaActual, fecha })
      });
      pieza.fecha = fecha;
      dragging = null;
      renderCalendario();
    });
  });
}

// Hooks de progreso SSE (llamados desde connectStream)
function onSeriePieza(ev) {
  // Cuando una pieza termina de generar, si tenés su serie abierta, refrescala
  if (ev.estado === 'generado' && serieActiva && serieActiva.id === ev.serieId) {
    abrirCalendario(ev.serieId);
  }
}
function onSerieDone(ev) {
  // Recargar series; si tenías abierto el calendario de esa serie, refrescar
  cargarSeries().then(() => {
    if (serieActiva && serieActiva.id === ev.serieId) abrirCalendario(ev.serieId);
  });
}

$('#btnGenerarSerie')?.addEventListener('click', async () => {
  if (!marcaActual) { alert('Seleccioná una marca'); return; }
  if ($('#btnGenerar')?.disabled) { alert('Ya hay una generación en curso'); return; }
  const nombre = $('#serieNombre').value.trim();
  if (!nombre) { alert('Escribí un nombre/tema para la campaña'); return; }
  const payload = {
    marca: marcaActual,
    nombre,
    tipo: $('#serieTipo').value,
    piezas: Number($('#seriePiezas').value) || 3,
    arco: $('#serieArco').value,
    fechaInicio: $('#serieFechaInicio').value || new Date().toISOString().slice(0, 10),
    frecuencia: $('#serieFrecuencia').value,
  };
  const res = await fetch('/api/series', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Error al crear la serie'); return; }
  setRunning(true);
  toggleSerieForm(false);
  $('#serieNombre').value = '';
  appendLog(`\n▶ Generando serie "${nombre}" (${payload.piezas} piezas)...\n`);
});

// ── INIT ──────────────────────────────────────────────
(async () => {
  initAdminMode();
  await cargarMarcas();
  await Promise.all([cargarTemas(), cargarIdentidad(), cargarReferencias()]);
  renderTemplatesList();
  cargarClonarGrid();
  cargarGaleria();
  cargarStoriesGaleria();
  checkStatus();
  connectStream();
  // Restaurar draft del tema
  const savedTema = localStorage.getItem(DRAFT_KEY);
  if (savedTema) $('#temaInput').value = savedTema;
})();

// ── GENERAR STORY ─────────────────────────────────────
$('#btnGenerarStory').addEventListener('click', async () => {
  const tema = $('#temaInput').value.trim();
  if (!tema) { alert('Escribí un tema primero'); return; }
  if ($('#btnGenerar').disabled) { alert('Ya hay una generación en curso'); return; }
  setRunning(true);
  const res = await fetch('/api/generar-story', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tema, marca: marcaActual || 'squadteam', model: $('#modelSelect').value })
  });
  if (!res.ok) {
    appendLog('\n❌ ' + (await res.json()).error + '\n');
    setRunning(false);
  }
});

// ── STORIES GALERÍA ───────────────────────────────────
async function cargarStoriesGaleria() {
  const res = await fetch('/api/stories');
  const stories = res.ok ? await res.json() : [];
  const galeria = $('#storiesGaleria');
  const empty = $('#storiesEmpty');
  if (!galeria) return;
  if (!stories.length) {
    galeria.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  galeria.innerHTML = stories.map(s => `
    <div class="tanda" data-story-id="${s.id}" style="cursor:pointer">
      <img class="cg-img-loading" src="${s.slides[0]}?t=${s.ts || Date.now()}" alt="${s.tema}" loading="lazy" style="aspect-ratio:9/16;object-fit:cover">
      <span class="count">${s.slides.length}</span>
      <div class="label">
        <span class="tanda-tema">${s.tema}</span>
        <div class="tanda-acts">
          <button class="tanda-edit" data-action="editar" title="Editar">✏</button>
          <button class="tanda-zip" data-action="zip" title="Descargar ZIP">⬇</button>
        </div>
      </div>
    </div>
  `).join('');
  galeria.querySelectorAll('.tanda').forEach((card, i) => {
    const s = stories[i];
    card.addEventListener('click', (e) => {
      if (e.target.closest('.tanda-acts')) return;
      openLightbox(s.slides, 0, s.id, 'story');
    });
    card.querySelector('.tanda-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(`/editor.html?story=${s.id}`, '_blank');
    });
    card.querySelector('.tanda-zip').addEventListener('click', (e) => {
      e.stopPropagation();
      window.location.href = `/api/stories/${s.id}/zip`;
    });
  });

  aplicarSkeletons(galeria, '9/16');
}

// ── HIGHLIGHTS COVERS ─────────────────────────────────
let highlightItems = [];

function renderHighlightsList() {
  const list = $('#highlightsList');
  if (!list) return;
  if (!highlightItems.length) {
    list.innerHTML = '<p class="hint" style="margin:0 0 10px">No hay covers. Agregá uno.</p>';
    return;
  }
  list.innerHTML = highlightItems.map((item, i) => `
    <div class="highlight-item" data-idx="${i}">
      <input class="emoji-input" type="text" placeholder="💪" value="${item.emoji || ''}" data-field="emoji" data-idx="${i}">
      <input type="text" placeholder="Etiqueta" value="${item.label || ''}" data-field="label" data-idx="${i}">
      <input type="color" value="${item.color || '#e8ff00'}" data-field="color" data-idx="${i}">
      <button class="btn-del" data-idx="${i}">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = parseInt(inp.dataset.idx);
      highlightItems[idx][inp.dataset.field] = inp.value;
    });
  });
  list.querySelectorAll('.btn-del').forEach(btn => {
    btn.addEventListener('click', () => {
      highlightItems.splice(parseInt(btn.dataset.idx), 1);
      renderHighlightsList();
    });
  });
}

$('#btnAddHighlight')?.addEventListener('click', () => {
  highlightItems.push({ label: '', emoji: '⭐', color: '#e8ff00' });
  renderHighlightsList();
});

$('#btnGenerarHighlights')?.addEventListener('click', async () => {
  if (!marcaActual || !highlightItems.length) return;
  if (jobRunning) { alert('Ya hay una generación en curso'); return; }
  const valid = highlightItems.filter(h => h.label.trim() || h.emoji.trim());
  if (!valid.length) { alert('Agregá al menos un cover con etiqueta o emoji'); return; }
  setRunning(true);
  const res = await fetch('/api/highlights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marca: marcaActual, items: valid })
  });
  if (!res.ok) {
    appendLog('\n❌ ' + (await res.json()).error + '\n');
    setRunning(false);
  }
});

async function cargarHighlightsOutput() {
  if (!marcaActual) return;
  const res = await fetch(`/api/marcas/${marcaActual}/highlights`);
  const urls = res.ok ? await res.json() : [];
  const out = $('#highlightsOutput');
  if (!out) return;
  out.innerHTML = urls.map(url => `
    <div class="foto-thumb"><img src="${url}?t=${Date.now()}" loading="lazy" alt="highlight"></div>
  `).join('');
}

document.querySelectorAll('.config-block-header').forEach(header => {
  if (header.dataset.toggle === 'bloque-highlights') {
    header.addEventListener('click', () => {
      const body = $('#bloque-highlights');
      if (body && !body.classList.contains('collapsed')) {
        setTimeout(cargarHighlightsOutput, 50);
      }
    });
  }
});
