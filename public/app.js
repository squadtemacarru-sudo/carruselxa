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

function appendLog(line) {
  log.textContent += line;
  log.scrollTop = log.scrollHeight;
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
    if (line.includes('✅') || line.includes('Listo')) {
      setRunning(false);
      setTimeout(cargarGaleria, 1000);
    }
    if (line.includes('❌')) {
      setRunning(false);
      logStatus.style.color = 'var(--red)';
      logStatus.textContent = 'Error';
    }
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
  $('#mFondo').value           = m.paleta_marca?.fondo || '#040404';
  $('#mAcento').value          = m.paleta_marca?.acento || '#e8ff00';

  const marcas  = await (await fetch('/api/marcas')).json();
  const info    = marcas.find(x => x.id === marcaActual);
  const preview = $('#logoPreview');
  preview.src           = info?.logo ? `${info.logo}?t=${Date.now()}` : '';
  preview.style.display = info?.logo ? '' : 'none';
}

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
      descripcion: ''
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

function openLightbox(slides, index) {
  currentSlides = slides;
  currentIndex  = index;
  showSlide();
  $('#lightbox').classList.remove('hidden');
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

async function cargarGaleria() {
  const tandas  = await (await fetch('/api/tandas')).json();
  const galeria = $('#galeria');
  const empty   = $('#galeriaEmpty');

  if (!tandas.length) {
    galeria.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  galeria.innerHTML = tandas.map((t, i) => `
    <div class="tanda" data-idx="${i}">
      <img src="${t.slides[0]}" alt="${t.tema}" loading="lazy">
      <span class="count">${t.slides.length}</span>
      <span class="label">${t.tema}</span>
    </div>
  `).join('');

  galeria.querySelectorAll('.tanda').forEach(el => {
    el.addEventListener('click', () => openLightbox(tandas[Number(el.dataset.idx)].slides, 0));
  });
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

// ── INIT ──────────────────────────────────────────────
(async () => {
  await cargarMarcas();
  await Promise.all([cargarTemas(), cargarIdentidad(), cargarReferencias()]);
  cargarGaleria();
  checkStatus();
  connectStream();
})();
