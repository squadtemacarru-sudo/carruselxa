const $ = (sel) => document.querySelector(sel);

const marcaSelect = $('#marcaSelect');
const btnNuevaMarca = $('#btnNuevaMarca');

const temaInput = $('#temaInput');
const temasList = $('#temasList');
const minutosInput = $('#minutosInput');
const btnGenerar = $('#btnGenerar');
const btnLote = $('#btnLote');
const log = $('#log');

const temasArea = $('#temasArea');
const btnGuardarTemas = $('#btnGuardarTemas');
const temasStatus = $('#temasStatus');

const mNombre = $('#mNombre');
const mIndustria = $('#mIndustria');
const mAudiencia = $('#mAudiencia');
const mPosicionamiento = $('#mPosicionamiento');
const mProducto = $('#mProducto');
const mVoz = $('#mVoz');
const mEvitar = $('#mEvitar');
const mFondo = $('#mFondo');
const mAcento = $('#mAcento');
const logoPreview = $('#logoPreview');
const logoFile = $('#logoFile');
const btnGuardarMarca = $('#btnGuardarMarca');
const marcaStatus = $('#marcaStatus');

const galeria = $('#galeria');
const btnRefrescar = $('#btnRefrescar');

let marcaActual = null;

function appendLog(line) {
  log.textContent += line;
  log.scrollTop = log.scrollHeight;
}

function setRunning(running) {
  btnGenerar.disabled = running;
  btnLote.disabled = running;
}

async function checkStatus() {
  const res = await fetch('/api/job/status');
  const { running } = await res.json();
  setRunning(running);
}

function connectStream() {
  const es = new EventSource('/api/job/stream');
  es.onmessage = (e) => {
    appendLog(JSON.parse(e.data));
    checkStatus();
    if (e.data.includes('Listo') || e.data.includes('❌')) {
      setTimeout(cargarGaleria, 1000);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────
// Marcas
// ─────────────────────────────────────────────────────────────────────
async function cargarMarcas(seleccionar) {
  const res = await fetch('/api/marcas');
  const marcas = await res.json();
  marcaSelect.innerHTML = marcas.map((m) => `<option value="${m.id}">${m.nombre}</option>`).join('');
  marcaActual = seleccionar && marcas.some((m) => m.id === seleccionar)
    ? seleccionar
    : (marcas[0]?.id || null);
  if (marcaActual) marcaSelect.value = marcaActual;
}

marcaSelect.addEventListener('change', async () => {
  marcaActual = marcaSelect.value;
  await Promise.all([cargarTemas(), cargarIdentidad()]);
  cargarGaleria();
});

btnNuevaMarca.addEventListener('click', async () => {
  const nombre = prompt('Nombre de la nueva marca (ej: Mi marca personal):');
  if (!nombre) return;
  const id = nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 30);
  const res = await fetch('/api/marcas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, nombre })
  });
  if (!res.ok) {
    const { error } = await res.json();
    alert(error);
    return;
  }
  await cargarMarcas(id);
  await Promise.all([cargarTemas(), cargarIdentidad()]);
  cargarGaleria();
});

// ─────────────────────────────────────────────────────────────────────
// Generar / tanda
// ─────────────────────────────────────────────────────────────────────
btnGenerar.addEventListener('click', async () => {
  const tema = temaInput.value.trim();
  if (!tema || !marcaActual) return;
  log.textContent = '';
  setRunning(true);
  const res = await fetch('/api/generar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tema, marca: marcaActual })
  });
  if (!res.ok) {
    const { error } = await res.json();
    appendLog(`\n❌ ${error}\n`);
    setRunning(false);
  }
});

btnLote.addEventListener('click', async () => {
  const minutos = Number(minutosInput.value) || 45;
  if (!marcaActual) return;
  if (!confirm(`¿Iniciar tanda automática de ${minutos} minutos para "${marcaSelect.options[marcaSelect.selectedIndex]?.textContent}"? Va a rotar todos los temas de la marca.`)) return;
  log.textContent = '';
  setRunning(true);
  const res = await fetch('/api/lote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutos, marca: marcaActual })
  });
  if (!res.ok) {
    const { error } = await res.json();
    appendLog(`\n❌ ${error}\n`);
    setRunning(false);
  }
});

// ─────────────────────────────────────────────────────────────────────
// Temas (por marca)
// ─────────────────────────────────────────────────────────────────────
async function cargarTemas() {
  if (!marcaActual) return;
  const res = await fetch(`/api/marcas/${marcaActual}/temas`);
  const temas = await res.json();
  temasArea.value = temas.join('\n');
  temasList.innerHTML = temas.map((t) => `<option value="${t.replace(/"/g, '&quot;')}">`).join('');
}

btnGuardarTemas.addEventListener('click', async () => {
  if (!marcaActual) return;
  const temas = temasArea.value.split('\n').map((t) => t.trim()).filter(Boolean);
  const res = await fetch(`/api/marcas/${marcaActual}/temas`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(temas)
  });
  if (res.ok) {
    temasStatus.textContent = `✓ Guardado (${temas.length} temas)`;
    temasStatus.className = 'status ok';
    temasList.innerHTML = temas.map((t) => `<option value="${t.replace(/"/g, '&quot;')}">`).join('');
  } else {
    temasStatus.textContent = '✗ Error al guardar';
    temasStatus.className = 'status err';
  }
  setTimeout(() => { temasStatus.textContent = ''; }, 3000);
});

// ─────────────────────────────────────────────────────────────────────
// Identidad de marca
// ─────────────────────────────────────────────────────────────────────
async function cargarIdentidad() {
  if (!marcaActual) return;
  const res = await fetch(`/api/marcas/${marcaActual}/marca`);
  const m = res.ok ? await res.json() : {};
  mNombre.value = m.nombre || '';
  mIndustria.value = m.industria || '';
  mAudiencia.value = m.audiencia || '';
  mPosicionamiento.value = m.posicionamiento || '';
  mProducto.value = m.producto || '';
  mVoz.value = m.voz || '';
  mEvitar.value = (m.evitar || []).join(', ');
  mFondo.value = m.paleta_marca?.fondo || '#040404';
  mAcento.value = m.paleta_marca?.acento || '#e8ff00';

  const marcas = await (await fetch('/api/marcas')).json();
  const info = marcas.find((x) => x.id === marcaActual);
  logoPreview.src = info?.logo ? `${info.logo}?t=${Date.now()}` : '';
}

btnGuardarMarca.addEventListener('click', async () => {
  if (!marcaActual) return;

  if (logoFile.files[0]) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(logoFile.files[0]);
    });
    await fetch(`/api/marcas/${marcaActual}/logo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl })
    });
    logoFile.value = '';
  }

  const body = {
    nombre: mNombre.value.trim(),
    industria: mIndustria.value.trim(),
    audiencia: mAudiencia.value.trim(),
    posicionamiento: mPosicionamiento.value.trim(),
    producto: mProducto.value.trim(),
    voz: mVoz.value.trim(),
    evitar: mEvitar.value.split(',').map((s) => s.trim()).filter(Boolean),
    nivel_consciencia: 'problem-aware',
    paleta_marca: {
      fondo: mFondo.value.trim() || '#040404',
      acento: mAcento.value.trim() || '#e8ff00',
      descripcion: ''
    }
  };

  const res = await fetch(`/api/marcas/${marcaActual}/marca`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (res.ok) {
    marcaStatus.textContent = '✓ Guardado';
    marcaStatus.className = 'status ok';
    await cargarMarcas(marcaActual);
    await cargarIdentidad();
  } else {
    marcaStatus.textContent = '✗ Error al guardar';
    marcaStatus.className = 'status err';
  }
  setTimeout(() => { marcaStatus.textContent = ''; }, 3000);
});

// ─────────────────────────────────────────────────────────────────────
// Galería + lightbox
// ─────────────────────────────────────────────────────────────────────
let currentSlides = [];
let currentIndex = 0;

const lightbox = $('#lightbox');
const lightboxImg = $('#lightboxImg');
const lightboxCounter = $('#lightboxCounter');

function openLightbox(slides, index) {
  currentSlides = slides;
  currentIndex = index;
  showSlide();
  lightbox.classList.remove('hidden');
}

function showSlide() {
  lightboxImg.src = currentSlides[currentIndex];
  lightboxCounter.textContent = `${currentIndex + 1} / ${currentSlides.length}`;
}

$('#lightboxClose').addEventListener('click', () => lightbox.classList.add('hidden'));
$('#lightboxPrev').addEventListener('click', () => {
  currentIndex = (currentIndex - 1 + currentSlides.length) % currentSlides.length;
  showSlide();
});
$('#lightboxNext').addEventListener('click', () => {
  currentIndex = (currentIndex + 1) % currentSlides.length;
  showSlide();
});
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) lightbox.classList.add('hidden');
});

async function cargarGaleria() {
  const res = await fetch('/api/tandas');
  const tandas = await res.json();
  galeria.innerHTML = tandas.map((t, i) => `
    <div class="tanda" data-idx="${i}">
      <img src="${t.slides[0]}" alt="${t.tema}" loading="lazy">
      <span class="count">${t.slides.length}</span>
      <span class="label">${t.tema}</span>
    </div>
  `).join('');

  galeria.querySelectorAll('.tanda').forEach((el) => {
    el.addEventListener('click', () => {
      const t = tandas[Number(el.dataset.idx)];
      openLightbox(t.slides, 0);
    });
  });
}

btnRefrescar.addEventListener('click', cargarGaleria);

(async () => {
  await cargarMarcas();
  await Promise.all([cargarTemas(), cargarIdentidad()]);
  cargarGaleria();
  checkStatus();
  connectStream();
})();
