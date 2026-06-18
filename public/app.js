const $ = (sel) => document.querySelector(sel);

// ── TABS ──────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $('#' + tabId).classList.add('active');
    if (tabId === 'tab-galeria') cargarGaleria();
    if (tabId === 'tab-fotos')   cargarFotosGrid();
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
let editorRerenderizing = false;

function appendLog(line) {
  log.textContent += line;
  log.scrollTop = log.scrollHeight;
  if (editorRerenderizing) {
    const edLog = $('#editorLog');
    if (edLog) { edLog.textContent += line; edLog.scrollTop = edLog.scrollHeight; }
  }
}

function setRunning(running) {
  $('#btnGenerar').disabled = running;
  $('#btnLote').disabled    = running;
  if (running) {
    logWrap.classList.remove('hidden');
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
  es.onmessage = e => {
    const line = JSON.parse(e.data);
    appendLog(line);
    const isDone  = line.includes('✅') || line.includes('Listo');
    const isError = line.includes('❌');
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
      cargarGaleria();
      document.querySelector('.nav-btn[data-tab="tab-galeria"]')?.click();
    }
    if (isError) { setRunning(false); logStatus.style.color = 'var(--red)'; logStatus.textContent = 'Error'; }
  };
}

$('#logToggle').addEventListener('click', () => {
  logVisible = !logVisible;
  log.style.display = logVisible ? '' : 'none';
  $('#logToggle').textContent = logVisible ? 'ocultar' : 'ver log';
});

$('#btnGenerar').addEventListener('click', async () => {
  const tema = $('#temaInput').value.trim();
  if (!tema || !marcaActual) return;
  await abrirModalPreguntar(tema);
});

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
  modal.classList.remove('hidden');

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
  setRunning(true);
  const body = {
    tema: $('#temaInput').value.trim(),
    marca: marcaActual,
    model: $('#modelSelect').value,
    respuestas,
    instruccionesLibres
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

$('#modalPreguntarClose').addEventListener('click', () => $('#modalPreguntar').classList.add('hidden'));

$('#btnSaltarPreguntas').addEventListener('click', () => {
  $('#modalPreguntar').classList.add('hidden');
  dispararGenerar();
});

$('#btnConfirmarPreguntas').addEventListener('click', () => {
  $('#modalPreguntar').classList.add('hidden');
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
  $('#modalFotos').classList.remove('hidden');
});

$('#modalFotosClose').addEventListener('click', () => $('#modalFotos').classList.add('hidden'));

$('#btnConfirmarFotos').addEventListener('click', () => {
  fotosSeleccionadas = [...$('#modalFotosGrid').querySelectorAll('.foto-thumb.selected')]
    .map(el => el.dataset.nombre);
  $('#modalFotos').classList.add('hidden');
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
let tandas = [];

function openLightbox(slides, index, tandaId = null) {
  currentSlides  = slides;
  currentIndex   = index;
  currentTandaId = tandaId;
  showSlide();
  $('#lightbox').classList.remove('hidden');
  const hasId = !!tandaId;
  $('#lightboxEdit').classList.toggle('hidden', !hasId);
  $('#lightboxCaption').classList.toggle('hidden', !hasId);
  $('#lightboxDuplicar').classList.toggle('hidden', !hasId);
}

function showSlide() {
  const url = currentSlides[currentIndex];
  $('#lightboxImg').src = url;
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
  editarTanda(currentTandaId);
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

$('#captionClose').addEventListener('click', () => $('#modalCaption').classList.add('hidden'));
$('#modalCaption').addEventListener('click', e => { if (e.target === $('#modalCaption')) $('#modalCaption').classList.add('hidden'); });

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
  $('#modalCaption').classList.remove('hidden');
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
        <img src="${t.slides[0]}" alt="${t.tema}" loading="lazy">
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

  aplicarFiltroGaleria();
}

$('#btnRefrescar').addEventListener('click', cargarGaleria);

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
  editorSlideIdx = 0;
  editorTs       = Date.now();
  undoStack = [];
  redoStack = [];
  $('#editorLog').textContent = '';
  $('#editorLog').classList.add('hidden');
  $('#editorStatus').textContent = '';
  $('#editorStatus').className = 'status';
  renderEditorChips();
  renderEditorSlide(0);
  $('#modalEditor').classList.remove('hidden');
}

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
  $('#editorSlideImg').src = `/tandas/${editorTandaId}/output/slide-${num}.png?t=${editorTs}`;

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
      ${hasPhoto ? `<p class="ctrl-hint">Arrastrá la banda amarilla en el preview para mover el texto.</p>` : ''}
    </div>
  `;

  // Sección CONTENIDO — campos de texto editables
  const TEXT_FIELDS = [
    { key: 'headline',     label: 'Titular',      multi: false },
    { key: 'subheadline',  label: 'Subtitular',   multi: false },
    { key: 'kicker',       label: 'Kicker',       multi: false },
    { key: 'eyebrow',      label: 'Eyebrow',      multi: false },
    { key: 'body',         label: 'Cuerpo',       multi: true  },
    { key: 'detail',       label: 'Detalle',      multi: true  },
    { key: 'caption',      label: 'Caption',      multi: true  },
    { key: 'stat',         label: 'Estadística',  multi: false },
    { key: 'label',        label: 'Etiqueta',     multi: false },
    { key: 'sub',          label: 'Sub',          multi: false },
    { key: 'quote',        label: 'Cita',         multi: true  },
    { key: 'author',       label: 'Autor',        multi: false },
    { key: 'attr',         label: 'Atribución',   multi: false },
    { key: 'note',         label: 'Nota',         multi: true  },
    { key: 'line1',        label: 'Línea 1',      multi: false },
    { key: 'line2',        label: 'Línea 2',      multi: false },
    { key: 'footer_text',  label: 'Pie de página',multi: false },
    { key: 'handle',       label: 'Handle',       multi: false },
    { key: 'cta',          label: 'CTA',          multi: false },
  ];
  const activeFields    = TEXT_FIELDS.filter(f => slide[f.key] != null);
  const hasItems        = Array.isArray(slide.items) && slide.items.length;
  const hasHeadlineLines = Array.isArray(slide.headline_lines) && slide.headline_lines.length;

  if (activeFields.length || hasItems || hasHeadlineLines) {
    const section = document.createElement('div');
    section.className = 'ctrl-section';
    section.innerHTML = `<p class="ctrl-label">CONTENIDO — slide ${num}</p>`;

    activeFields.forEach(({ key, label, multi }) => {
      const fieldId = `ctrlText_${key}`;
      const row = document.createElement('div');
      row.className = 'ctrl-row ctrl-row-col';
      row.innerHTML = `
        <span class="ctrl-row-label">${label}</span>
        ${multi
          ? `<textarea id="${fieldId}" class="ctrl-textarea" rows="3">${slide[key]}</textarea>`
          : `<input  id="${fieldId}" class="ctrl-input" type="text" value="${String(slide[key]).replace(/"/g, '&quot;')}">`}
      `;
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
      const fieldId = 'ctrlText_items';
      const row = document.createElement('div');
      row.className = 'ctrl-row ctrl-row-col';
      row.innerHTML = `
        <span class="ctrl-row-label">Items (uno por línea)</span>
        <textarea id="${fieldId}" class="ctrl-textarea" rows="${Math.min(slide.items.length + 1, 8)}">${slide.items.join('\n')}</textarea>
      `;
      section.appendChild(row);
    }

    $('#editorControls').appendChild(section);

    // Bind texto → editorContenido
    activeFields.forEach(({ key }) => {
      const el = document.getElementById(`ctrlText_${key}`);
      if (!el) return;
      el.addEventListener('focus', () => {
        saveSnapshot();
        // En mobile el teclado tapa el modal — scrollear para que el campo quede visible
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
      }, { once: true });
      el.addEventListener('input', () => { editorContenido.slides[editorSlideIdx][key] = el.value; });
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
        });
      }
    }
    if (hasItems) {
      const el = document.getElementById('ctrlText_items');
      if (el) {
        el.addEventListener('focus', saveSnapshot, { once: true });
        el.addEventListener('input', () => {
          editorContenido.slides[editorSlideIdx].items = el.value.split('\n').filter(l => l.trim());
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
}

$('#editorClose').addEventListener('click', () => $('#modalEditor').classList.add('hidden'));
$('#btnUndo').addEventListener('click', editorUndo);
$('#btnRedo').addEventListener('click', editorRedo);

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

// ── INIT ──────────────────────────────────────────────
(async () => {
  await cargarMarcas();
  await Promise.all([cargarTemas(), cargarIdentidad(), cargarReferencias()]);
  renderTemplatesList();
  cargarClonarGrid();
  cargarGaleria();
  checkStatus();
  connectStream();
})();
