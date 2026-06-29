// lab.js — Laboratorio de carruseles (bandeja de ideas)
// Reusa marcaActual (app.js) y el job stream global para el render al aprobar.

let labIdeas = [];
let labRenderActivo = null; // id de la idea que se está renderizando (QW1)

const DIA_LABEL = { lun: 'Lunes', mar: 'Martes', mie: 'Miércoles', jue: 'Jueves', vie: 'Viernes', sab: 'Sábado', dom: 'Domingo' };
const LUGAR_EMOJI = { gym: '🏋️', comida: '🍽️', calle: '🚶', casa: '🏠', paisaje: '🌳', oficina: '💻', exterior: '🌤️' };
const IMG_EXT = /\.(jpe?g|png|webp|heic|gif)$/i;

function labEl(id) { return document.getElementById(id); }
function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── QW1: hook que app.js llama desde connectStream ──────────
// Devuelve true si el Lab "consume" el evento (no redirigir a Galería)
function labOnStreamLine(line) {
  if (!labRenderActivo) return false;
  const id = labRenderActivo;
  const idea = labIdeas.find(i => i.id === id);
  if (!idea) return false;

  const isDone  = line.includes('✅') || line.includes('Listo');
  const isError = line.includes('❌');

  // Actualizar texto de progreso inline
  const card = document.querySelector(`.lab-card[data-id="${id}"]`);
  if (card) {
    const prog = card.querySelector('.lab-progress-text');
    if (prog && !isDone && !isError) {
      const paso = labStepFromLine(line);
      if (paso) prog.textContent = paso;
    }
    if (isDone) {
      labRenderActivo = null;
      idea.estado = 'generada';
      // Intentar mostrar el thumbnail del slide 1
      if (idea.tanda) {
        const thumb = `/${idea.tanda}/output/slide-01.png`;
        card.innerHTML = labCardGeneradaHtml(idea, thumb);
      } else {
        // Recargar la idea del servidor para obtener la carpeta
        fetch(`/api/laboratorio/${marcaActual}`)
          .then(r => r.json())
          .then(ideas => {
            const updated = ideas.find(i => i.id === id);
            if (updated) {
              Object.assign(idea, updated);
              const thumb = idea.tanda ? `/${idea.tanda}/output/slide-01.png` : null;
              card.innerHTML = labCardGeneradaHtml(idea, thumb);
              wireCard(card, idea);
            }
          }).catch(() => {});
        card.innerHTML = labCardGeneradaHtml(idea, null);
      }
      wireCard(card, idea);
      renderShotList();
    }
    if (isError) {
      labRenderActivo = null;
      idea.estado = 'borrador';
      card.innerHTML = labCardHtml(idea);
      wireCard(card, idea);
    }
  }
  return true; // consumido — app.js no redirige
}

function labStepFromLine(line) {
  if (line.includes('contenido') || line.includes('Generando')) return 'Pensando el contenido…';
  if (line.includes('analiz') || line.includes('sistema') || line.includes('Diseñando')) return 'Diseñando el sistema visual…';
  if (line.includes('render') || line.includes('Renderiz') || line.includes('slide')) return 'Renderizando slides…';
  if (line.includes('Skills') || line.includes('Memoria')) return 'Preparando contexto…';
  return null;
}

// ── CARGAR ──────────────────────────────────────────────────
async function cargarLaboratorio() {
  if (!marcaActual) return;
  try {
    const res = await fetch(`/api/laboratorio/${marcaActual}`);
    labIdeas = await res.json();
  } catch { labIdeas = []; }
  renderLab();
}

// ── QW3: GENERAR IDEAS con skeleton ─────────────────────────
async function generarIdeas() {
  if (!marcaActual) return;
  const cantidad = parseInt(labEl('labCantidad').value, 10) || 5;
  const btn = labEl('btnGenerarIdeas');
  btn.disabled = true;
  labEl('labEmpty').classList.add('hidden');

  // Mostrar skeletons inmediatamente
  labMostrarSkeletons(cantidad);

  try {
    const res = await fetch(`/api/laboratorio/${marcaActual}/generar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cantidad }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error generando ideas');
    labIdeas = data.ideas || [];
    renderLabConStagger();
  } catch (e) {
    labEl('labGrid').innerHTML = '';
    labEl('labEmpty').classList.remove('hidden');
    labEl('labEmpty').textContent = 'No se pudieron generar ideas: ' + e.message;
  } finally {
    btn.disabled = false;
    labEl('labLoading').classList.add('hidden');
  }
}

function labMostrarSkeletons(n) {
  const grid = labEl('labGrid');
  grid.innerHTML = Array.from({ length: n }).map(() => `
    <div class="lab-card lab-skeleton">
      <div class="lab-sk-line lab-sk-sm"></div>
      <div class="lab-sk-line lab-sk-lg"></div>
      <div class="lab-sk-line lab-sk-md"></div>
      <div class="lab-sk-line lab-sk-sm"></div>
      <div class="lab-sk-block"></div>
    </div>`).join('');
}

function renderLabConStagger() {
  const grid = labEl('labGrid');
  labEl('labEmpty').classList.add('hidden');
  if (!labIdeas.length) {
    grid.innerHTML = '';
    labEl('labEmpty').classList.remove('hidden');
    renderShotList();
    return;
  }
  // Renderizar con opacidad 0 y animar con stagger
  grid.innerHTML = labIdeas.map(idea => `
    <div class="lab-card lab-card-entering" data-id="${idea.id}" style="opacity:0;transform:translateY(16px)">
      ${labCardInner(idea)}
    </div>`).join('');

  wireAllCards();
  renderShotList();

  // Stagger con Anime.js (ya cargado globalmente)
  if (typeof anime !== 'undefined') {
    anime({
      targets: '#labGrid .lab-card',
      opacity: [0, 1],
      translateY: [16, 0],
      easing: 'easeOutCubic',
      duration: 380,
      delay: anime.stagger(60),
    });
  } else {
    // Fallback sin Anime.js
    grid.querySelectorAll('.lab-card').forEach(c => { c.style.opacity = '1'; c.style.transform = 'none'; });
  }
}

// ── GUARDAR ─────────────────────────────────────────────────
async function guardarIdea(id, cambios) {
  if (!marcaActual) return;
  try {
    await fetch(`/api/laboratorio/${marcaActual}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cambios),
    });
    // Mini-feedback "guardado"
    const card = document.querySelector(`.lab-card[data-id="${id}"]`);
    if (card) {
      let badge = card.querySelector('.lab-saved-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'lab-saved-badge';
        badge.textContent = '✓ guardado';
        card.querySelector('.lab-card-top')?.appendChild(badge);
      }
      badge.classList.add('visible');
      clearTimeout(badge._t);
      badge._t = setTimeout(() => badge.classList.remove('visible'), 1500);
    }
  } catch {}
}

async function descartarIdea(id) {
  if (!marcaActual) return;
  if (!confirm('¿Descartar esta idea?')) return;
  await fetch(`/api/laboratorio/${marcaActual}/${id}`, { method: 'DELETE' });
  labIdeas = labIdeas.filter(i => i.id !== id);
  const card = document.querySelector(`.lab-card[data-id="${id}"]`);
  if (card && typeof anime !== 'undefined') {
    anime({ targets: card, opacity: 0, scale: 0.95, duration: 220, easing: 'easeInCubic',
      complete: () => { card.remove(); renderShotList(); }});
  } else {
    card?.remove();
    renderShotList();
  }
}

// ── QW1: APROBAR sin salir del Lab ──────────────────────────
async function aprobarIdea(id) {
  if (!marcaActual) return;
  const idea = labIdeas.find(i => i.id === id);
  if (!idea) return;

  // Si necesita foto y no la tiene, preguntar pero no bloquear
  if (idea.necesita_foto && !idea.foto) {
    if (!confirm('Esta idea pide una foto. ¿Generarla tipográfica por ahora y después le ponés la foto?')) return;
  }

  const res = await fetch(`/api/laboratorio/${marcaActual}/${id}/generar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ foto: idea.foto || null }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'No se pudo generar'); return; }

  // Marcar el Lab como "dueño" del render → connectStream no redirige a Galería
  labRenderActivo = id;
  idea.estado = 'generando';

  // Reemplazar card con versión "generando" con spinner inline
  const card = document.querySelector(`.lab-card[data-id="${id}"]`);
  if (card) {
    card.innerHTML = `
      <div class="lab-card-top"><span class="lab-dia">${DIA_LABEL[idea.dia] || ''}</span></div>
      <h3 class="lab-hook" style="opacity:.6">${esc(idea.hook)}</h3>
      <div class="lab-progress">
        <div class="lab-spinner"></div>
        <span class="lab-progress-text">Preparando…</span>
      </div>`;
  }

  if (typeof setRunning === 'function') setRunning(true);
}

// Cambia entre idea con foto / tipográfica
function toggleFoto(id) {
  const idea = labIdeas.find(i => i.id === id);
  if (!idea) return;
  idea.necesita_foto = !idea.necesita_foto;
  if (idea.necesita_foto && !idea.shot) idea.shot = { que: '', donde: '', tip: '' };
  guardarIdea(id, { necesita_foto: idea.necesita_foto, shot: idea.shot });
  const card = document.querySelector(`.lab-card[data-id="${id}"]`);
  if (card) { card.innerHTML = labCardInner(idea); wireCard(card, idea); }
  renderShotList();
}

// ── QW2: SUBIR FOTO en la card ───────────────────────────────
function labSetupDropzone(card, idea) {
  const zone = card.querySelector('.lab-dropzone');
  const input = card.querySelector('.lab-foto-input');
  if (!zone || !input) return;

  const handleFile = async (file) => {
    if (!file || !IMG_EXT.test(file.name)) return;
    zone.classList.add('uploading');
    zone.innerHTML = '<span>Subiendo…</span>';
    try {
      const fd = new FormData();
      fd.append('foto', file);
      const res = await fetch('/api/fotos', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      const filename = data.nombre || data.filename || data.name || file.name;
      idea.foto = filename;
      await guardarIdea(idea.id, { foto: filename });
      // Actualizar zona con thumbnail
      const url = data.url || `/fotos/${filename}`;
      zone.innerHTML = `<img src="${esc(url)}" class="lab-foto-thumb" alt="foto"><button class="lab-foto-del" title="Quitar foto">✕</button>`;
      zone.classList.remove('uploading');
      zone.classList.add('has-foto');
      zone.querySelector('.lab-foto-del')?.addEventListener('click', () => {
        idea.foto = null;
        guardarIdea(idea.id, { foto: null });
        zone.innerHTML = labDropzoneInner(idea);
        zone.classList.remove('has-foto');
        labSetupDropzone(card, idea);
        renderShotList();
      });
      renderShotList();
    } catch (e) {
      zone.classList.remove('uploading');
      zone.innerHTML = labDropzoneInner(idea);
      labSetupDropzone(card, idea);
      alert('Error subiendo foto: ' + e.message);
    }
  };

  input.addEventListener('change', () => handleFile(input.files[0]));

  zone.addEventListener('click', (e) => {
    if (e.target.classList.contains('lab-foto-del')) return;
    if (!idea.foto) input.click();
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });
}

function labDropzoneInner(idea) {
  if (idea.foto) {
    return `<img src="/fotos/${esc(idea.foto)}" class="lab-foto-thumb" alt="foto"><button class="lab-foto-del" title="Quitar foto">✕</button>`;
  }
  return `<span class="lab-dz-icon">📷</span><span class="lab-dz-text">Soltá o elegí la foto</span>`;
}

// ── HTML de las cards ────────────────────────────────────────
function labShotHtml(idea) {
  if (!idea.necesita_foto) return `<div class="lab-shot lab-shot-typo">✍️ Tipográfica</div>`;
  const s = idea.shot;
  const desc = s ? [s.que, s.donde ? `${LUGAR_EMOJI[s.donde.toLowerCase()] || '📍'} ${s.donde}` : ''].filter(Boolean).join(' · ') : '';
  const tip  = s?.tip ? `<span class="lab-shot-tip">tip: ${esc(s.tip)}</span>` : '';
  return `<div class="lab-shot">📷 <b>${esc(desc)}</b>${tip}</div>`;
}

function labCardInner(idea) {
  const generada  = idea.estado === 'generada';
  const planRows  = (idea.plan || []).map(s =>
    `<li><span class="lab-slide-type">${esc(s.type)}</span> <span class="lab-slide-title" contenteditable data-id="${idea.id}" data-pos="${s.position}">${esc(s.title)}</span></li>`
  ).join('');

  const needsFoto = idea.necesita_foto;
  const hasFoto   = !!idea.foto;
  const dzClass   = hasFoto ? 'lab-dropzone has-foto' : 'lab-dropzone';

  return `
    <div class="lab-card-top">
      <span class="lab-dia">${DIA_LABEL[idea.dia] || ''}</span>
      ${generada ? '<span class="lab-badge ok">✓ Generada</span>' : ''}
    </div>
    <h3 class="lab-hook" contenteditable data-id="${idea.id}" data-field="hook">${esc(idea.hook)}</h3>
    <p class="lab-tema">${esc(idea.tema)}</p>
    ${labShotHtml(idea)}
    ${needsFoto ? `
    <div class="${dzClass}" data-id="${idea.id}">
      ${labDropzoneInner(idea)}
      <input type="file" class="lab-foto-input" accept="image/*" style="display:none">
    </div>` : ''}
    <div class="lab-toggle-row">
      <button class="lab-foto-toggle" data-id="${idea.id}">
        ${needsFoto ? '✍️ Hacer tipográfica' : '📷 Pedir foto'}
      </button>
    </div>
    <details class="lab-plan">
      <summary>Ver plan (${(idea.plan || []).length} slides)</summary>
      <ul>${planRows}</ul>
    </details>
    <div class="lab-actions">
      <button class="lab-btn-del" data-id="${idea.id}">✗ Descartar</button>
      <button class="lab-btn-ok" data-id="${idea.id}">${generada ? '↻ Regenerar' : '✓ Aprobar y generar'}</button>
    </div>`;
}

function labCardGeneradaHtml(idea, thumbUrl) {
  return `
    <div class="lab-card-top">
      <span class="lab-dia">${DIA_LABEL[idea.dia] || ''}</span>
      <span class="lab-badge ok">✓ Generada</span>
    </div>
    <h3 class="lab-hook" style="opacity:.7">${esc(idea.hook)}</h3>
    ${thumbUrl ? `<img src="${esc(thumbUrl)}?t=${Date.now()}" class="lab-thumb" alt="slide 1">` : ''}
    <div class="lab-actions">
      <button class="lab-btn-del" data-id="${idea.id}">✗ Descartar</button>
      <a href="#" class="lab-btn-ver" onclick="document.querySelector('.nav-btn[data-tab=tab-galeria]')?.click();return false;">Ver en Galería →</a>
    </div>`;
}

// ── RENDER PRINCIPAL ─────────────────────────────────────────
function renderLab() {
  const grid  = labEl('labGrid');
  const empty = labEl('labEmpty');
  if (!labIdeas.length) {
    grid.innerHTML = labEstadoVacioHtml();
    empty.classList.add('hidden');
    renderShotList();
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = labIdeas.map(idea =>
    `<div class="lab-card" data-id="${idea.id}">${labCardInner(idea)}</div>`
  ).join('');
  wireAllCards();
  renderShotList();
}

function labEstadoVacioHtml() {
  return `<div class="lab-estado-vacio">
    <div class="lab-ev-preview">
      <div class="lab-ev-card">
        <div class="lab-ev-dia">Lunes</div>
        <div class="lab-ev-hook">Por qué el 90% de las personas abandona el gym antes de los 3 meses</div>
        <div class="lab-ev-shot">📷 vos entrenando · 🏋️ gym · tip: plano medio, luz natural</div>
      </div>
    </div>
    <p class="lab-ev-texto">La IA te propone la semana completa: el tema, el plan de slides y <b>qué foto salir a sacar</b>.<br>Vos solo editás, le soltás la foto y aprobás.</p>
    <button class="btn-primary" onclick="generarIdeas()">✨ Armar mi semana</button>
  </div>`;
}

// ── WIRING DE EVENTOS ────────────────────────────────────────
function wireCard(card, idea) {
  card.querySelector('.lab-btn-del')?.addEventListener('click', () => descartarIdea(idea.id));
  card.querySelector('.lab-btn-ok')?.addEventListener('click', () => aprobarIdea(idea.id));
  card.querySelector('.lab-foto-toggle')?.addEventListener('click', () => toggleFoto(idea.id));
  card.querySelector('.lab-hook')?.addEventListener('blur', function() {
    idea.hook = this.textContent.trim();
    guardarIdea(idea.id, { hook: idea.hook });
  });
  card.querySelectorAll('.lab-slide-title').forEach(el => el.addEventListener('blur', function() {
    const slide = (idea.plan || []).find(s => String(s.position) === this.dataset.pos);
    if (slide) { slide.title = this.textContent.trim(); guardarIdea(idea.id, { plan: idea.plan }); }
  }));
  if (idea.necesita_foto) labSetupDropzone(card, idea);
}

function wireAllCards() {
  document.querySelectorAll('#labGrid .lab-card').forEach(card => {
    const idea = labIdeas.find(i => i.id === card.dataset.id);
    if (idea) wireCard(card, idea);
  });
}

// ── LISTA DE FOTOS DEL DÍA ───────────────────────────────────
function renderShotList() {
  const box    = labEl('labShotList');
  const groups = labEl('labShotGroups');
  if (!box || !groups) return;
  const pendientes = labIdeas.filter(i => i.necesita_foto && i.shot && i.estado !== 'generada');
  if (!pendientes.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const porLugar = {};
  for (const i of pendientes) {
    const lugar = (i.shot.donde || 'otros').toLowerCase();
    (porLugar[lugar] = porLugar[lugar] || []).push(i);
  }
  groups.innerHTML = Object.entries(porLugar).map(([lugar, items]) => `
    <div class="lab-shot-group">
      <div class="lab-shot-group-title">${LUGAR_EMOJI[lugar] || '📍'} ${esc(lugar)}</div>
      ${items.map(i => `<div class="lab-shot-item">${esc(i.shot?.que || '')}${i.shot?.tip ? `<span class="lab-shot-tip">${esc(i.shot.tip)}</span>` : ''}</div>`).join('')}
    </div>`).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnGenerarIdeas');
  if (btn) btn.onclick = generarIdeas;
});
