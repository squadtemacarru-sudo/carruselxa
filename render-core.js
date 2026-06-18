// render-core.js — funciones de construcción de slides compartidas entre
// template.html (render final con Puppeteer) y preview.html (preview en
// vivo vía SSE). Definen únicamente funciones — no leen datos por sí solas.
//
// Contexto global esperado antes de usar buildAny/buildSlide:
//   RC.wrapper  = elemento #slideWrapper
//   RC.gOverlay = data.overlay ?? 0.65
//   RC.logo     = data._logo || null
//   RC.ARROW    = sistema.iconos?.flecha_derecha || '→'
const RC = { wrapper: null, gOverlay: 0.65, logo: null, ARROW: '→' };

// ── Aplicar sistema de diseño ──
function aplicarSistema(s, wrapper) {
  if (!s) return;
  const r = document.documentElement;
  // Lee formato plano (font_display_familia) O anidado (tipografia.display.familia)
  const dispFamilia = s.font_display_familia || s.tipografia?.display?.familia;
  const bodyFamilia = s.font_body_familia    || s.tipografia?.body?.familia;
  const monoFamilia = s.font_mono_familia    || s.tipografia?.mono?.familia;
  const dispUrl     = s.font_display_url     || s.tipografia?.display?.url_import;
  const bodyUrl     = s.font_body_url        || s.tipografia?.body?.url_import;
  const monoUrl     = s.font_mono_url        || s.tipografia?.mono?.url_import;
  if (dispFamilia) r.style.setProperty('--font-display', `'${dispFamilia}', sans-serif`);
  if (bodyFamilia) r.style.setProperty('--font-body',    `'${bodyFamilia}', sans-serif`);
  if (monoFamilia) r.style.setProperty('--font-mono',    `'${monoFamilia}', monospace`);
  const p = s.paleta || {};
  if (p.fondo)      r.style.setProperty('--color-fondo',    p.fondo);
  if (p.headline)   r.style.setProperty('--color-headline', p.headline);
  if (p.body_text)  r.style.setProperty('--color-body',     p.body_text);
  if (p.acento)     r.style.setProperty('--color-acento',   p.acento);
  if (p.secundario) r.style.setProperty('--color-sec',      p.secundario);
  if (p.fondo && wrapper) wrapper.style.background = p.fondo;
  const l = s.layout || {};
  if (l.padding_slide)           r.style.setProperty('--pad',         parseFloat(l.padding_slide) + 'px');
  if (l.espacio_entre_elementos)  r.style.setProperty('--gap',         parseFloat(l.espacio_entre_elementos) + 'px');
  if (l.headline_line_height)     r.style.setProperty('--lh-headline', l.headline_line_height);
  if (l.body_line_height)         r.style.setProperty('--lh-body',     l.body_line_height);
  ['font-display-link','font-body-link','font-mono-link'].forEach((id, i) => {
    const url = [dispUrl, bodyUrl, monoUrl][i];
    if (url) { const el = document.getElementById(id); if (el) el.href = url; }
  });
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls)  n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\n/g,'<br>').replace(/<br>\s*<br>/g,'<br><br>');
}

// Rich text: [text]{#hex} → colored span; [text]{bg:#hex} → highlight box
function richText(str) {
  if (!str) return '';
  const RICH = /\[([^\]]*)\]\{(bg:)?([^}]+)\}/g;
  let result = '', last = 0, m;
  while ((m = RICH.exec(str)) !== null) {
    result += esc(str.slice(last, m.index));
    const t = String(m[1]).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    result += m[2]
      ? `<span class="hl-word" style="--hl-bg:${m[3]}">${t}</span>`
      : `<span style="color:${m[3]}">${t}</span>`;
    last = m.index + m[0].length;
  }
  result += esc(str.slice(last));
  return result;
}

// ─────────────────────────────────────────────────────────────
// BUILD SLIDE — usa _layout elegido por la IA
// _layout: "cover-top" | "cover-center" | "cover-split"
//          "list-full" | "list-compact" | "list-hero"
//          "statement-anchored" | "statement-top" | "statement-impact"
//          "split-full" | "split-compact"
//          "quote-dominant" | "quote-centered"
//          "cta-top" | "cta-center" | "cta-impact"
// ─────────────────────────────────────────────────────────────
function buildSlide(slide, idx, total) {
  const layout   = slide._layout       || defaultLayout(slide.type, slide);
  const shadow   = slide._textShadow   || 'medio';
  const grad     = slide._gradiente    || 'both';
  const hs       = slide._headlineAjuste || 'normal';
  const useGlass = slide._glass === true;
  const glassOp  = slide._glassOpacidad ?? 0.80;
  const ovVal    = slide._overlay ?? RC.gOverlay;

  const section = el('div', [
    'slide', idx === 0 ? 'active' : '',
    `layout-${layout}`,
    `ts-${shadow}`,
    `hs-${hs}`,
    slide.photo ? `grad-${grad}` : '',
    slide.photo && slide._textPosition ? `tp-${slide._textPosition}` : '',
  ].filter(Boolean).join(' '));
  section.id = `slide-${idx + 1}`;

  // Tag
  const tag = el('span', 'slide-tag', `0${idx+1} — 0${total}`);
  section.appendChild(tag);

  // Builders por tipo
  const builders = { cover, list, statement, split, quote, cta };
  const fn = builders[slide.type];
  if (fn) fn(section, slide, layout, useGlass, glassOp);

  // Fondo foto
  if (slide.photo) {
    const bg = el('div', 'slide-bg');
    bg.style.backgroundImage = `url(${slide.photo})`;
    if (slide._photoPos) bg.style.backgroundPosition = slide._photoPos;
    section.style.setProperty('--overlay', String(ovVal));
    section.insertBefore(bg, section.firstChild);
    section.classList.add('has-photo');

    // _textY posiciona el bloque de texto en slides con foto.
    // Solo aplica a layouts compactos (cover, quote, cta) donde el contenido
    // es un bloque único. Statement y list tienen su propia lógica CSS
    // (space-between / flex-full) que funciona mejor que el wrap absoluto.
    if (slide._textY != null) {
      const ly = layout || '';
      const isCompact = ly.startsWith('cover') || ly.startsWith('quote') || ly.startsWith('cta');
      if (isCompact) {
        const FIXED = new Set(['slide-bg', 'slide-tag', 'brand-logo', 'c-swipe', 'cta-footer']);
        const toWrap = [...section.children].filter(c =>
          ![...c.classList].some(cls => FIXED.has(cls))
        );
        if (toWrap.length) {
          const wrap = document.createElement('div');
          wrap.className = 'text-y-wrap';
          const ty = slide._textY;
          // Anclar desde arriba si el texto va al top, desde abajo si va al bottom.
          // Evita que bloques altos desborden sobre el sujeto de la foto.
          const posStyle = ty <= 50
            ? `top:${ty}%`
            : `bottom:${100 - ty}%`;
          wrap.style.cssText = `position:absolute;${posStyle};left:0;right:0;padding:var(--pad);box-sizing:border-box;display:flex;flex-direction:column;gap:var(--gap);`;
          toWrap.forEach(c => wrap.appendChild(c));
          section.appendChild(wrap);
        }
      }
    }
  }

  // Logo de marca (watermark)
  if (RC.logo) {
    const logo = el('img', 'brand-logo');
    logo.src = RC.logo;
    section.appendChild(logo);
  }

  return section;
}

// ─── COVER ───────────────────────────────────────────────────
function cover(sec, s, layout, useGlass, glassOp) {
  // cover-impact: stacked multi-line hero with headline_lines array
  if (layout === 'cover-impact' && Array.isArray(s.headline_lines) && s.headline_lines.length) {
    const main = el('div', 'cover-impact-main');
    s.headline_lines.forEach(line => {
      const sz = line.size === 'hero' ? 'ci-hero' : line.size === 'md' ? 'ci-md' : 'ci-connector';
      const lineEl = el('div', sz + (line.stroke ? ' ci-stroke' : ''));
      lineEl.innerHTML = richText(line.text);
      if (line.color) lineEl.style.color = line.color;
      main.appendChild(lineEl);
    });
    sec.appendChild(main);
    if (s.detail) sec.appendChild(el('p', 'ci-detail', richText(s.detail)));
    sec.appendChild(el('span', 'c-swipe', `DESLIZÁ ${RC.ARROW}`));
    return;
  }
  if (layout === 'cover-split') {
    const main = el('div', 'cover-main');
    const left = el('div', 'cover-left');
    left.appendChild(el('h1', 'c-headline h-display', richText(s.headline)));
    const right = el('div', 'cover-right');
    if (s.detail) right.appendChild(el('p', 'c-body', esc(s.detail)));
    if (s.kicker) {
      const k = el('div', 'c-kicker');
      k.appendChild(el('div', 'c-kicker-line'));
      k.appendChild(el('span', 'c-kicker-text', esc(s.kicker)));
      right.appendChild(k);
    }
    main.appendChild(left); main.appendChild(right);
    sec.appendChild(main);
    sec.appendChild(el('span', 'c-swipe', `DESLIZÁ ${RC.ARROW}`));
    return;
  }
  // cover-top / cover-center
  const main = el('div', 'cover-main');
  if (useGlass) { main.classList.add('glass-wrap'); main.style.setProperty('--glass-bg', `rgba(4,4,6,${glassOp})`); }
  main.appendChild(el('h1', 'c-headline h-display', richText(s.headline)));
  if (s.detail) main.appendChild(el('p', 'c-body', esc(s.detail)));
  if (s.kicker) {
    const k = el('div', 'c-kicker');
    k.appendChild(el('div', 'c-kicker-line'));
    k.appendChild(el('span', 'c-kicker-text', esc(s.kicker)));
    main.appendChild(k);
  }
  sec.appendChild(main);
  if (layout !== 'cover-center') sec.appendChild(el('span', 'c-swipe', `DESLIZÁ ${RC.ARROW}`));
}

// ─── LIST ────────────────────────────────────────────────────
function list(sec, s, layout) {
  const items = s.items || [];
  const useSmall = items.length >= 5;

  if (layout === 'list-full') {
    const header = el('div', 'list-header');
    if (s.eyebrow) header.appendChild(el('p', 'c-eyebrow', esc(s.eyebrow)));
    sec.appendChild(header);
    const ul = el('ul', 'list-items');
    items.forEach((item, i) => {
      const li = el('li', 'list-item');
      li.appendChild(el('span', 'list-num', String(i+1).padStart(2,'0')));
      li.appendChild(el('span', useSmall ? 'list-text-sm' : 'list-text', richText(item)));
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    return;
  }

  if (layout === 'list-hero') {
    const header = el('div', 'list-header');
    if (s.eyebrow) header.appendChild(el('p', 'c-eyebrow', esc(s.eyebrow)));
    sec.appendChild(header);
    const ul = el('ul', 'list-items');
    items.forEach((item, i) => {
      const li = el('li', 'list-item');
      li.appendChild(el('span', 'list-num-hero', String(i+1).padStart(2,'0')));
      li.appendChild(el('span', 'list-text-sm', richText(item)));
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    return;
  }

  // list-compact (default)
  if (s.eyebrow) sec.appendChild(el('p', 'c-eyebrow', esc(s.eyebrow)));
  const ul = el('ul', 'list-items');
  items.forEach((item, i) => {
    const li = el('li', 'list-item');
    li.appendChild(el('span', 'list-num-bracket', `[0${i+1}]`));
    li.appendChild(el('span', useSmall ? 'list-text-sm' : 'list-text', richText(item)));
    ul.appendChild(li);
  });
  sec.appendChild(ul);
}

// ─── STATEMENT ───────────────────────────────────────────────
function statement(sec, s, layout) {
  if (layout === 'statement-top') {
    const top = el('div', 'stmt-top');
    top.appendChild(el('h2', 'c-headline h-display', esc(s.headline)));
    sec.appendChild(top);
    // Con foto: el body va anclado al fondo como elemento fijo — no se mezcla con el headline
    if (s.body) {
      if (s.photo) {
        const bot = el('div', 'stmt-photo-body');
        bot.appendChild(divider());
        bot.appendChild(el('p', 'c-body', esc(s.body)));
        sec.appendChild(bot);
      } else {
        const bot = el('div', 'stmt-bottom');
        bot.appendChild(divider());
        bot.appendChild(el('p', 'c-body', esc(s.body)));
        sec.appendChild(bot);
      }
    }
    return;
  }
  if (layout === 'statement-impact') {
    sec.appendChild(el('h2', 'c-headline h-display stmt-headline', esc(s.headline)));
    const wrap = el('div', 'stmt-body-wrap');
    wrap.appendChild(divider());
    if (s.body) wrap.appendChild(el('p', 'c-body', esc(s.body)));
    sec.appendChild(wrap);
    return;
  }
  // statement-anchored (default)
  sec.appendChild(el('h2', 'c-headline h-display', esc(s.headline)));
  sec.appendChild(divider());
  if (s.body) sec.appendChild(el('p', 'c-body', esc(s.body)));
}

// ─── SPLIT ───────────────────────────────────────────────────
function split(sec, s, layout) {
  if (layout === 'split-full') {
    const tagRow = el('div', 'split-tag-row');
    sec.appendChild(tagRow);
    const grid = el('div', 'split-grid');
    [s.left, s.right].forEach((col, i) => {
      const colEl = el('div', 'split-col ' + (i === 0 ? 'dark' : 'light'));
      colEl.appendChild(el('span', 'split-label', esc(col.label)));
      const ul = el('ul', 'split-items');
      (col.items || []).forEach(item => ul.appendChild(el('li', '', esc(item))));
      colEl.appendChild(ul);
      grid.appendChild(colEl);
    });
    sec.appendChild(grid);
    return;
  }
  // split-compact
  const grid = el('div', 'split-grid');
  [s.left, s.right].forEach((col, i) => {
    const colEl = el('div', 'split-col ' + (i === 0 ? 'dark' : 'light'));
    colEl.style.padding = '44px';
    colEl.appendChild(el('span', 'split-label', esc(col.label)));
    const ul = el('ul', 'split-items');
    ul.style.cssText = 'list-style:none;display:flex;flex-direction:column;gap:24px;margin-top:28px;';
    (col.items || []).forEach(item => {
      const li = el('li', '');
      li.style.cssText = `font-family:var(--font-body);font-size:32px;line-height:1.4;color:${i===0?'rgba(255,255,255,0.9)':'#111'};font-weight:600;`;
      li.innerHTML = esc(item);
      ul.appendChild(li);
    });
    colEl.appendChild(ul);
    grid.appendChild(colEl);
  });
  sec.appendChild(grid);
}

// ─── QUOTE ───────────────────────────────────────────────────
function quote(sec, s, layout, useGlass, glassOp) {
  if (layout === 'quote-centered') {
    if (s.quote) sec.appendChild(el('p', 'quote-text', esc(s.quote)));
    const line = el('div', 'c-divider-line'); sec.appendChild(line);
    if (s.attr) sec.appendChild(el('p', 'quote-attr', esc(s.attr)));
    if (s.note) sec.appendChild(el('p', 'quote-note', esc(s.note)));
    return;
  }
  // quote-dominant
  const top = el('div', 'quote-top');
  const qText = el('p', 'quote-text', esc(s.quote));
  if (useGlass) { qText.classList.add('glass-wrap'); qText.style.setProperty('--glass-bg', `rgba(4,4,6,${glassOp})`); }
  top.appendChild(qText);
  sec.appendChild(top);
  const bot = el('div', 'quote-bottom');
  if (s.attr) bot.appendChild(el('p', 'quote-attr', esc(s.attr)));
  if (s.note) bot.appendChild(el('p', 'quote-note', esc(s.note)));
  sec.appendChild(bot);
}

// ─── CTA ─────────────────────────────────────────────────────
function cta(sec, s, layout, useGlass, glassOp) {
  const main = el('div', 'cta-main');
  if (useGlass) { main.classList.add('glass-wrap'); main.style.setProperty('--glass-bg',`rgba(4,4,6,${glassOp})`); }
  main.appendChild(el('h2', 'cta-hl', esc(s.headline)));
  if (s.sub) main.appendChild(el('p', 'cta-sub', esc(s.sub)));
  sec.appendChild(main);
  const footer = el('div', 'cta-footer');
  footer.appendChild(el('span', 'c-handle', esc(s.handle || '')));
  footer.appendChild(el('div', 'c-arrow-box', RC.ARROW));
  sec.appendChild(footer);
}

// ─── HELPERS ─────────────────────────────────────────────────
function divider() {
  const d = el('div', 'c-divider-slash');
  for (let i = 0; i < 3; i++) d.appendChild(el('span', '', '/'));
  return d;
}

function defaultLayout(type, slide) {
  const map = {
    cover:     slide.headline_lines?.length ? 'cover-impact' : 'cover-top',
    list:      slide.items?.length >= 5 ? 'list-full' : 'list-compact',
    statement: 'statement-anchored',
    split:     'split-full',
    quote:     slide.photo ? 'quote-dominant' : 'quote-centered',
    cta:       'cta-top',
  };
  return map[type] || type;
}

// ── Dispatcher — maneja todos los tipos incluidos los 5 nuevos ──
function buildAny(slide, i, total) {
  if (slide.type === 'split_v')      return buildSplitV(slide, i, total);
  if (slide.type === 'full_impact')  return buildFullImpact(slide, i, total);
  if (slide.type === 'before_after') return buildBeforeAfter(slide, i, total);
  if (slide.type === 'triple_v')     return buildTripleV(slide, i, total);
  if (slide.type === 'big_number')   return buildBigNumber(slide, i, total);
  if (slide.type === 'timeline')     return buildTimeline(slide, i, total);
  if (slide.type === 'grid')         return buildGrid(slide, i, total);
  return buildSlide(slide, i, total);
}

// ── MODELO A: Split Vertical ──────────────────────────────────────────
// _topPos / _bottomPos vienen del análisis de composición por foto
// (FASE 3B de analizar.mjs) — { align: 'left'|'right', valign: 'top'|'bottom' }
// e indican en qué esquina de cada mitad ubicar el bloque de texto sin
// tapar al sujeto de esa foto.
function svTextClasses(pos) {
  const cls = ['sv-text'];
  if (pos?.align === 'left')    cls.push('align-left');
  if (pos?.align === 'right')   cls.push('align-right');
  if (pos?.valign === 'top')    cls.push('valign-top');
  if (pos?.valign === 'bottom') cls.push('valign-bottom');
  return cls.join(' ');
}

function buildSplitV(slide, i, total) {
  const sec = el('div', 'slide-split-v' + (i === 0 ? ' active' : ''));
  sec.id = `slide-${i+1}`;

  const top = el('div', 'sv-half top' + (slide._topPos?.valign === 'top' ? ' scrim-top' : ''));
  if (slide.photo_top) { const bg = el('div','sv-bg'); bg.style.backgroundImage=`url(${slide.photo_top})`; top.appendChild(bg); }
  const tt = el('div', svTextClasses(slide._topPos));
  if (slide.label_top)    tt.appendChild(el('p','sv-label',   esc(slide.label_top)));
  if (slide.contrast_top) tt.appendChild(el('p','sv-contrast',esc(slide.contrast_top)));
  top.appendChild(tt); sec.appendChild(top);
  sec.appendChild(el('div','sv-divider'));

  const bot = el('div', 'sv-half bottom' + (slide._bottomPos?.valign === 'top' ? ' scrim-top' : ''));
  if (slide.photo_bottom) { const bg = el('div','sv-bg'); bg.style.backgroundImage=`url(${slide.photo_bottom})`; bot.appendChild(bg); }
  const bt = el('div', svTextClasses(slide._bottomPos));
  if (slide.label_bottom)    bt.appendChild(el('p','sv-label',   esc(slide.label_bottom)));
  if (slide.contrast_bottom) bt.appendChild(el('p','sv-contrast',esc(slide.contrast_bottom)));
  bot.appendChild(bt); sec.appendChild(bot);
  return sec;
}

// ── MODELO B: Full Impact ─────────────────────────────────────────────
function buildFullImpact(slide, i, total) {
  const sec = el('div', 'slide-full-impact' + (i === 0 ? ' active' : ''));
  sec.id = `slide-${i+1}`;
  if (slide.photo) { const bg = el('div','fi-bg'); bg.style.backgroundImage=`url(${slide.photo})`; sec.appendChild(bg); }
  const content = el('div','fi-content');
  if (slide._textY != null) {
    content.style.position  = 'absolute';
    content.style.top       = slide._textY + '%';
    content.style.transform = 'translateY(-50%)';
  }
  content.appendChild(el('span','fi-tag', `0${i+1} — 0${total}`));
  if (slide.line1) content.appendChild(el('p','fi-line1',richText(slide.line1)));
  if (slide.line2) content.appendChild(el('p','fi-line2',richText(slide.line2)));
  if (slide.footer_text) {
    const ft = el('div','fi-footer');
    ft.appendChild(el('span','fi-footer-text',esc(slide.footer_text)));
    ft.appendChild(el('span','fi-arrow',RC.ARROW));
    content.appendChild(ft);
  }
  sec.appendChild(content);
  return sec;
}

// ── MODELO C: Antes / Después ─────────────────────────────────────────
function buildBeforeAfter(slide, i, total) {
  const sec = el('div', 'slide-before-after' + (i === 0 ? ' active' : ''));
  sec.id = `slide-${i+1}`;
  const photos = el('div','ba-photos');
  photos.appendChild(el('div','ba-vline'));
  ['before','after'].forEach(side => {
    const col = el('div','ba-photo');
    const bg  = el('div','ba-bg'); bg.style.backgroundImage=`url(${slide[`photo_${side}`]||''})`;
    col.appendChild(bg);
    col.appendChild(el('span','ba-pill', esc(slide[`label_${side}`] || (side==='before'?'ANTES':'DESPUÉS'))));
    photos.appendChild(col);
  });
  sec.appendChild(photos);
  if (slide.headline || slide.sub) {
    const footer = el('div','ba-footer');
    if (slide.headline) footer.appendChild(el('h2','ba-headline',richText(slide.headline)));
    if (slide.sub)      footer.appendChild(el('p','ba-sub',richText(slide.sub)));
    sec.appendChild(footer);
  }
  return sec;
}

// ── MODELO E: Big Number ─────────────────────────────────────────────
function buildBigNumber(slide, i, total) {
  const sec = el('div', 'slide-big-number' + (i === 0 ? ' active' : ''));
  sec.id = `slide-${i+1}`;
  if (slide._overlay) sec.style.setProperty('--bn-overlay', slide._overlay);
  if (slide.photo) {
    const bg = el('div','bn-bg'); bg.style.backgroundImage=`url(${slide.photo})`; sec.appendChild(bg);
  }
  sec.appendChild(el('span','bn-tag', `0${i+1} / 0${total}`));
  if (slide.stat)  sec.appendChild(el('p','bn-stat',  esc(slide.stat)));
  if (slide.label) sec.appendChild(el('p','bn-label', esc(slide.label)));
  if (slide.body)  sec.appendChild(el('p','bn-body',  esc(slide.body)));
  if (slide.handle) {
    const ft = el('div','bn-footer');
    ft.appendChild(el('span','bn-handle', esc(slide.handle)));
    sec.appendChild(ft);
  }
  return sec;
}

// ── MODELO F: Timeline ────────────────────────────────────────────────
function buildTimeline(slide, i, total) {
  const sec = el('div', 'slide-timeline' + (i === 0 ? ' active' : ''));
  sec.id = `slide-${i+1}`;
  sec.appendChild(el('span','slide-tag', `0${i+1} — 0${total}`));
  if (slide.eyebrow)  sec.appendChild(el('p','tl-eyebrow', esc(slide.eyebrow)));
  if (slide.headline) sec.appendChild(el('p','tl-headline', esc(slide.headline)));
  const steps = slide.steps || [];
  if (steps.length) {
    const stepsEl = el('div','tl-steps');
    steps.forEach((step, si) => {
      if (si > 0) stepsEl.appendChild(el('div','tl-line'));
      const stepEl = el('div','tl-step');
      stepEl.appendChild(el('span','tl-num', esc(step.num || String(si+1))));
      const content = el('div','tl-content');
      if (step.text)   content.appendChild(el('p','tl-text',   esc(step.text)));
      if (step.detail) content.appendChild(el('p','tl-detail', esc(step.detail)));
      stepEl.appendChild(content);
      stepsEl.appendChild(stepEl);
    });
    sec.appendChild(stepsEl);
  }
  if (RC.logo) { const logo = el('img','brand-logo'); logo.src = RC.logo; sec.appendChild(logo); }
  return sec;
}

// ── MODELO G: Grid 2×2 ───────────────────────────────────────────────
function buildGrid(slide, i, total) {
  const sec = el('div', 'slide-grid' + (i === 0 ? ' active' : ''));
  sec.id = `slide-${i+1}`;
  sec.appendChild(el('span','slide-tag', `0${i+1} — 0${total}`));
  if (slide.headline) sec.appendChild(el('p','gr-headline', esc(slide.headline)));
  const cells = el('div','gr-cells');
  (slide.cells || []).forEach(c => {
    const cell = el('div','gr-cell');
    if (c.icon)  cell.appendChild(el('span','gr-icon',  c.icon));
    if (c.label) cell.appendChild(el('p','gr-label',    esc(c.label)));
    if (c.text)  cell.appendChild(el('p','gr-text',     esc(c.text)));
    cells.appendChild(cell);
  });
  sec.appendChild(cells);
  if (RC.logo) { const logo = el('img','brand-logo'); logo.src = RC.logo; sec.appendChild(logo); }
  return sec;
}

// ── MODELO D: Triple Vertical ─────────────────────────────────────────
// row._pos viene del análisis de composición por foto (FASE 3B de
// analizar.mjs) — { align: 'left'|'right', valign: 'top'|'bottom' } e
// indica en qué esquina de la fila ubicar el label sin tapar al sujeto.
function buildTripleV(slide, i, total) {
  const sec = el('div', 'slide-triple-v' + (i === 0 ? ' active' : ''));
  sec.id = `slide-${i+1}`;
  (slide.rows || []).forEach((row, ri) => {
    if (ri > 0) sec.appendChild(el('div','tv-sep'));
    const pos = row._pos;
    const rowEl = el('div', 'tv-row' + (pos?.valign === 'top' ? ' scrim-top' : ''));
    const bg = el('div','tv-bg'); bg.style.backgroundImage=`url(${row.photo||''})`;
    if (row.bgPos) bg.style.backgroundPosition = row.bgPos;
    rowEl.appendChild(bg);
    const wrapCls = ['tv-label-wrap'];
    if (pos?.align === 'right') wrapCls.push('justify-end');
    if (pos?.valign === 'top')  wrapCls.push('align-top');
    const wrap = el('div', wrapCls.join(' '));
    if (row.num)  wrap.appendChild(el('span','tv-num', esc(row.num)));
    if (row.text) wrap.appendChild(el('span','tv-text',esc(row.text)));
    rowEl.appendChild(wrap);
    sec.appendChild(rowEl);
  });
  return sec;
}

// Si el headline (a veces forzado a un tamaño grande por el layout/IA)
// hace que el contenido se desborde del slide o pise el tag de página,
// lo reducimos hasta que entre dentro del padding.
function autofitHeadlines(section) {
  const wrapper = RC.wrapper;
  const padTop  = parseFloat(getComputedStyle(section).paddingTop);
  const padLeft = parseFloat(getComputedStyle(section).paddingLeft);
  const headlines = section.querySelectorAll('.h-display, .cta-hl');
  if (!headlines.length) return;
  const kids = [...section.children, ...headlines].filter(
    (c) => !c.classList.contains('slide-tag') && !c.classList.contains('brand-logo')
  );
  let guard = 0;
  while (guard < 15) {
    const wrapperRect = wrapper.getBoundingClientRect();
    const tops    = kids.map((c) => c.getBoundingClientRect().top - wrapperRect.top);
    const bottoms = kids.map((c) => c.getBoundingClientRect().bottom - wrapperRect.top);
    const lefts   = kids.map((c) => c.getBoundingClientRect().left - wrapperRect.left);
    const rights  = kids.map((c) => c.getBoundingClientRect().right - wrapperRect.left);
    const overflow = Math.max(
      padTop - Math.min(...tops),
      Math.max(...bottoms) - (wrapperRect.height - padTop),
      padLeft - Math.min(...lefts),
      Math.max(...rights) - (wrapperRect.width - padLeft)
    );
    if (overflow <= 1) break;
    let shrunk = false;
    headlines.forEach((hl) => {
      const size = parseFloat(getComputedStyle(hl).fontSize);
      if (size > 56) {
        hl.style.setProperty('font-size', (size - 4) + 'px', 'important');
        shrunk = true;
      }
    });
    if (!shrunk) break;
    guard++;
  }
}

// El texto de contraste de split_v viene de copy de la IA y puede ser
// mucho más largo de lo que el layout (pensado para 1-3 palabras) espera.
// Si desborda su mitad, reducimos .sv-contrast hasta que entre.
function autofitSvContrast(section) {
  section.querySelectorAll('.sv-half').forEach((half) => {
    const contrast = half.querySelector('.sv-contrast');
    if (!contrast) return;
    let guard = 0;
    while (half.scrollHeight > half.clientHeight && guard < 15) {
      const size = parseFloat(getComputedStyle(contrast).fontSize);
      if (size <= 40) break;
      contrast.style.setProperty('font-size', (size - 4) + 'px', 'important');
      guard++;
    }
  });
}
