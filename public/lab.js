// lab.js — Laboratorio de carruseles (bandeja de ideas)
// Reusa marcaActual (app.js) y el job stream global para el render al aprobar.

let labIdeas = [];

const DIA_LABEL = { lun: 'Lunes', mar: 'Martes', mie: 'Miércoles', jue: 'Jueves', vie: 'Viernes', sab: 'Sábado', dom: 'Domingo' };
const LUGAR_EMOJI = { gym: '🏋️', comida: '🍽️', calle: '🚶', casa: '🏠', paisaje: '🌳', oficina: '💻', exterior: '🌤️' };

function labEl(id) { return document.getElementById(id); }

async function cargarLaboratorio() {
  if (!marcaActual) return;
  try {
    const res = await fetch(`/api/laboratorio/${marcaActual}`);
    labIdeas = await res.json();
  } catch { labIdeas = []; }
  renderLab();
}

async function generarIdeas() {
  if (!marcaActual) return;
  const cantidad = parseInt(labEl('labCantidad').value, 10) || 5;
  const btn = labEl('btnGenerarIdeas');
  btn.disabled = true;
  labEl('labLoading').classList.remove('hidden');
  labEl('labEmpty').classList.add('hidden');
  try {
    const res = await fetch(`/api/laboratorio/${marcaActual}/generar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cantidad }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error generando ideas');
    labIdeas = data.ideas || [];
    renderLab();
  } catch (e) {
    alert('No se pudieron generar ideas: ' + e.message);
  } finally {
    btn.disabled = false;
    labEl('labLoading').classList.add('hidden');
  }
}

// Guarda cambios de una idea (merge parcial) en el backend
async function guardarIdea(id, cambios) {
  if (!marcaActual) return;
  try {
    await fetch(`/api/laboratorio/${marcaActual}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cambios),
    });
  } catch {}
}

async function descartarIdea(id) {
  if (!marcaActual) return;
  if (!confirm('¿Descartar esta idea?')) return;
  await fetch(`/api/laboratorio/${marcaActual}/${id}`, { method: 'DELETE' });
  labIdeas = labIdeas.filter(i => i.id !== id);
  renderLab();
}

async function aprobarIdea(id) {
  if (!marcaActual) return;
  const idea = labIdeas.find(i => i.id === id);
  if (!idea) return;
  if (idea.necesita_foto && !idea.foto) {
    if (!confirm('Esta idea pide una foto y todavía no le asignaste ninguna. ¿Generarla igual (tipográfica por ahora)?')) return;
  }
  const res = await fetch(`/api/laboratorio/${marcaActual}/${id}/generar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ foto: idea.foto || null }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'No se pudo generar'); return; }
  idea.estado = 'generando';
  renderLab();
  // El job stream global (app.js) muestra el progreso y redirige a Galería al terminar.
  if (typeof setRunning === 'function') setRunning(true);
}

// Cambia entre idea con foto / tipográfica
function toggleFoto(id) {
  const idea = labIdeas.find(i => i.id === id);
  if (!idea) return;
  idea.necesita_foto = !idea.necesita_foto;
  if (idea.necesita_foto && !idea.shot) idea.shot = { que: '', donde: '', tip: '' };
  guardarIdea(id, { necesita_foto: idea.necesita_foto, shot: idea.shot });
  renderLab();
}

function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderLab() {
  const grid = labEl('labGrid');
  const empty = labEl('labEmpty');
  if (!labIdeas.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    renderShotList();
    return;
  }
  empty.classList.add('hidden');

  grid.innerHTML = labIdeas.map(idea => {
    const generada = idea.estado === 'generada';
    const generando = idea.estado === 'generando';
    const planRows = (idea.plan || []).map(s =>
      `<li><span class="lab-slide-type">${esc(s.type)}</span> <span class="lab-slide-title" contenteditable data-id="${idea.id}" data-pos="${s.position}">${esc(s.title)}</span></li>`
    ).join('');
    const shot = idea.necesita_foto && idea.shot
      ? `<div class="lab-shot">📷 <b>${esc(idea.shot.que)}</b>${idea.shot.donde ? ` · ${LUGAR_EMOJI[idea.shot.donde.toLowerCase()] || '📍'} ${esc(idea.shot.donde)}` : ''}${idea.shot.tip ? `<span class="lab-shot-tip">tip: ${esc(idea.shot.tip)}</span>` : ''}</div>`
      : `<div class="lab-shot lab-shot-typo">✍️ Tipográfica (sin foto)</div>`;
    return `
    <div class="lab-card ${generada ? 'is-generada' : ''}" data-id="${idea.id}">
      <div class="lab-card-top">
        <span class="lab-dia">${DIA_LABEL[idea.dia] || ''}</span>
        ${generada ? '<span class="lab-badge ok">✓ Generada</span>' : ''}
        ${generando ? '<span class="lab-badge gen">⏳ Generando…</span>' : ''}
      </div>
      <h3 class="lab-hook" contenteditable data-id="${idea.id}" data-field="hook">${esc(idea.hook)}</h3>
      <p class="lab-tema">${esc(idea.tema)}</p>
      ${shot}
      <button class="lab-foto-toggle" data-id="${idea.id}">${idea.necesita_foto ? 'Hacerla tipográfica' : 'Pedir una foto'}</button>
      <details class="lab-plan">
        <summary>Ver plan (${(idea.plan || []).length} slides)</summary>
        <ul>${planRows}</ul>
      </details>
      <div class="lab-actions">
        <button class="lab-btn-del" data-id="${idea.id}">✗ Descartar</button>
        <button class="lab-btn-ok" data-id="${idea.id}" ${generando ? 'disabled' : ''}>${generada ? '↻ Regenerar' : '✓ Aprobar y generar'}</button>
      </div>
    </div>`;
  }).join('');

  // Wire eventos
  grid.querySelectorAll('.lab-btn-del').forEach(b => b.onclick = () => descartarIdea(b.dataset.id));
  grid.querySelectorAll('.lab-btn-ok').forEach(b => b.onclick = () => aprobarIdea(b.dataset.id));
  grid.querySelectorAll('.lab-foto-toggle').forEach(b => b.onclick = () => toggleFoto(b.dataset.id));
  grid.querySelectorAll('.lab-hook').forEach(el => el.onblur = () => {
    const idea = labIdeas.find(i => i.id === el.dataset.id);
    if (idea) { idea.hook = el.textContent.trim(); guardarIdea(idea.id, { hook: idea.hook }); }
  });
  grid.querySelectorAll('.lab-slide-title').forEach(el => el.onblur = () => {
    const idea = labIdeas.find(i => i.id === el.dataset.id);
    if (!idea) return;
    const slide = (idea.plan || []).find(s => String(s.position) === el.dataset.pos);
    if (slide) { slide.title = el.textContent.trim(); guardarIdea(idea.id, { plan: idea.plan }); }
  });

  renderShotList();
}

// Lista de fotos del día — agrupa los encargos de foto por lugar
function renderShotList() {
  const box = labEl('labShotList');
  const groups = labEl('labShotGroups');
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
      ${items.map(i => `<div class="lab-shot-item">${esc(i.shot.que)}${i.shot.tip ? `<span class="lab-shot-tip">${esc(i.shot.tip)}</span>` : ''}</div>`).join('')}
    </div>`).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnGenerarIdeas');
  if (btn) btn.onclick = generarIdeas;
});
