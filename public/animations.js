/**
 * animations.js — Carruselesgen microinteractions layer
 * Requires: anime.js v3 loaded via CDN before this script
 */

document.addEventListener('DOMContentLoaded', () => {

  // ─── 1. TAB SWITCH TRANSITION ────────────────────────────────────────────

  let currentTab = document.querySelector('.tab.active');

  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const nextId = btn.dataset.tab;
      const nextTab = document.getElementById(nextId);
      if (!nextTab || nextTab === currentTab) return;

      const outgoing = currentTab;
      currentTab = nextTab;

      if (outgoing) {
        anime({
          targets: outgoing,
          opacity: [1, 0],
          translateX: [0, -12],
          duration: 160,
          easing: 'easeInQuad'
        });
      }

      anime.set(nextTab, { opacity: 0, translateX: 12 });
      anime({
        targets: nextTab,
        opacity: [0, 1],
        translateX: [12, 0],
        duration: 220,
        easing: 'easeOutExpo',
        delay: 80
      });

      // Trigger gallery stagger when galeria tab opens
      if (nextId === 'tab-galeria') {
        animateGalleryCards();
      }
    });
  });


  // ─── 2. GENERATE BUTTON — PRESS ANIMATION ────────────────────────────────

  const btnGenerar = document.getElementById('btnGenerar');
  if (btnGenerar) {
    btnGenerar.addEventListener('click', () => {
      anime({
        targets: btnGenerar,
        scale: [1, 0.97, 1],
        duration: 200,
        easing: 'spring(1, 300, 20, 0)'
      });
      anime({
        targets: btnGenerar,
        boxShadow: [
          '0 0 0px rgba(232,255,0,0)',
          '0 0 20px rgba(232,255,0,0.4)',
          '0 0 0px rgba(232,255,0,0)'
        ],
        duration: 400,
        easing: 'easeOutQuad'
      });
    });
  }


  // ─── 3. GALLERY CARDS — STAGGER ENTRANCE ─────────────────────────────────

  const animatedTandas = new Set();

  function animateGalleryCards() {
    const cards = document.querySelectorAll('.tanda');
    const toAnimate = Array.from(cards).filter(c => !animatedTandas.has(c));
    if (!toAnimate.length) return;

    toAnimate.forEach(c => animatedTandas.add(c));
    anime.set(toAnimate, { opacity: 0, translateY: 16 });
    anime({
      targets: toAnimate,
      opacity: [0, 1],
      translateY: [16, 0],
      delay: anime.stagger(40),
      duration: 300,
      easing: 'easeOutQuart'
    });
  }

  // Also watch for new .tanda elements added while galeria is active
  const galeriaTab = document.getElementById('tab-galeria');
  if (galeriaTab) {
    new MutationObserver(() => {
      if (galeriaTab.classList.contains('active')) {
        animateGalleryCards();
      }
    }).observe(galeriaTab, { childList: true, subtree: true });
  }


  // ─── 4. FOTO CHIPS — BOUNCE IN ───────────────────────────────────────────

  const fotosChips = document.getElementById('fotosChips');
  if (fotosChips) {
    new MutationObserver(mutations => {
      mutations.forEach(m => {
        m.addedNodes.forEach(node => {
          if (node.nodeType !== 1) return;
          const chips = node.classList?.contains('foto-chip')
            ? [node]
            : Array.from(node.querySelectorAll('.foto-chip'));
          chips.forEach(chip => {
            anime.set(chip, { scale: 0 });
            anime({
              targets: chip,
              scale: [0, 1.1, 1],
              duration: 280,
              easing: 'spring(1, 300, 15, 0)'
            });
          });
        });
      });
    }).observe(fotosChips, { childList: true, subtree: true });
  }


  // ─── 5. CONFIG ACCORDION — SMOOTH HEIGHT ─────────────────────────────────

  document.querySelectorAll('.config-block-body').forEach(body => {
    new MutationObserver(() => {
      const isCollapsed = body.classList.contains('collapsed');
      if (isCollapsed) {
        anime({
          targets: body,
          maxHeight: [body.scrollHeight, 0],
          duration: 300,
          easing: 'easeInOutQuart'
        });
      } else {
        anime.set(body, { maxHeight: 0 });
        anime({
          targets: body,
          maxHeight: [0, body.scrollHeight],
          duration: 300,
          easing: 'easeInOutQuart'
        });
      }
    }).observe(body, { attributes: true, attributeFilter: ['class'] });
  });


  // ─── 6. NAV BUTTON — SPRING TAP ──────────────────────────────────────────

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      anime({
        targets: btn,
        scale: [1, 0.88, 1],
        duration: 250,
        easing: 'spring(1, 300, 15, 0)'
      });
    });
  });


  // ─── 7. MODAL ENTRANCE ───────────────────────────────────────────────────

  document.querySelectorAll('.modal').forEach(modal => {
    new MutationObserver(() => {
      const isVisible = !modal.classList.contains('hidden');
      const box = modal.querySelector('.modal-box');
      if (isVisible) {
        anime.set(modal, { opacity: 0 });
        if (box) anime.set(box, { opacity: 0, translateY: 20 });

        anime({
          targets: modal,
          opacity: [0, 1],
          duration: 200,
          easing: 'linear'
        });
        if (box) {
          anime({
            targets: box,
            opacity: [0, 1],
            translateY: [20, 0],
            duration: 280,
            easing: 'easeOutExpo',
            delay: 40
          });
        }
      }
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  });


  // ─── 8. LOG WRAP — SLIDE IN ──────────────────────────────────────────────

  const logWrap = document.getElementById('logWrap');
  if (logWrap) {
    new MutationObserver(() => {
      if (!logWrap.classList.contains('hidden')) {
        anime.set(logWrap, { opacity: 0, translateY: 8 });
        anime({
          targets: logWrap,
          opacity: [0, 1],
          translateY: [8, 0],
          duration: 240,
          easing: 'easeOutQuart'
        });
      }
    }).observe(logWrap, { attributes: true, attributeFilter: ['class'] });
  }


  // ─── 9. TEXTAREA FOCUS GLOW ──────────────────────────────────────────────

  const temaInput = document.getElementById('temaInput');
  const genHero = temaInput?.closest('.gen-hero');

  if (temaInput) {
    temaInput.addEventListener('focus', () => {
      temaInput.classList.add('textarea-focused');
      if (genHero) {
        anime({
          targets: genHero,
          scale: [1, 1.002],
          duration: 200,
          easing: 'easeOutQuad'
        });
      }
    });

    temaInput.addEventListener('blur', () => {
      temaInput.classList.remove('textarea-focused');
      if (genHero) {
        anime({
          targets: genHero,
          scale: [1.002, 1],
          duration: 200,
          easing: 'easeOutQuad'
        });
      }
    });
  }

});


// ── MOBILE TOUCH ──────────────────────────────────────────────────────────────

// ─── T1. SWIPE LEFT/RIGHT TO CHANGE TABS ─────────────────────────────────────
// Runs outside DOMContentLoaded because it is self-contained and defensive.
(function setupSwipeTabs() {
  const tabs = ['tab-generar', 'tab-fotos', 'tab-galeria', 'tab-config'];
  let touchStartX = 0;
  let touchStartY = 0;

  const el = document.querySelector('.main-content') || document.body;

  el.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;

    // Require a meaningful horizontal movement and reject mostly-vertical gestures
    if (Math.abs(dx) < 50 || Math.abs(dy) > 80) return;

    const activeTab = document.querySelector('.tab.active');
    if (!activeTab) return;

    const currentIndex = tabs.indexOf(activeTab.id);
    if (currentIndex === -1) return;

    const nextIndex = dx < 0
      ? Math.min(currentIndex + 1, tabs.length - 1)  // swipe left → next tab
      : Math.max(currentIndex - 1, 0);               // swipe right → prev tab

    if (nextIndex === currentIndex) return;

    // Delegate to the existing nav-btn click handler so app.js tab logic runs
    const btn = document.querySelector(`.nav-btn[data-tab="${tabs[nextIndex]}"]`);
    if (btn) btn.click();
  }, { passive: true });
})();


// ─── T2. PULL-DOWN-TO-REFRESH PREVENTION ─────────────────────────────────────
// Blocks iOS rubber-band pull-to-refresh when a modal-box is at scroll top
// and has no scrollable content. Non-passive so preventDefault() can fire.
(function preventPullRefresh() {
  function attachToBox(box) {
    box.addEventListener('touchmove', e => {
      if (box.scrollTop === 0 && e.touches[0].clientY > 0) {
        // Only block when the box itself has nothing to scroll
        if (box.scrollHeight <= box.clientHeight) e.preventDefault();
      }
    }, { passive: false });
  }

  // Attach to any modal-box already in the DOM
  document.querySelectorAll('.modal-box').forEach(attachToBox);

  // Also catch modal-boxes injected dynamically
  new MutationObserver(mutations => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.classList && node.classList.contains('modal-box')) {
          attachToBox(node);
        }
        node.querySelectorAll && node.querySelectorAll('.modal-box').forEach(attachToBox);
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();


// ─── T3. TOUCH FEEDBACK (NO HOVER ON MOBILE) ─────────────────────────────────
// Provides immediate visual feedback on tap since :hover is unreliable on touch.
// Nav-btn already has a spring scale on click (section 6); these touchstart/end
// listeners add a faster leading-edge response without duplicating click logic.
(function touchFeedback() {
  if (!('ontouchstart' in window)) return;

  // ── Nav buttons ──
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('touchstart', () => {
      anime({ targets: btn, scale: 0.92, duration: 80, easing: 'easeOutQuad' });
    }, { passive: true });

    btn.addEventListener('touchend', () => {
      anime({ targets: btn, scale: 1, duration: 200, easing: 'easeOutElastic(1, 0.5)' });
    }, { passive: true });

    // Restore scale if the finger slides off without lifting
    btn.addEventListener('touchcancel', () => {
      anime({ targets: btn, scale: 1, duration: 200, easing: 'easeOutQuad' });
    }, { passive: true });
  });

  // ── Generate / primary CTA ──
  const genBtn = document.getElementById('btnGenerar');
  if (genBtn) {
    genBtn.addEventListener('touchstart', () => {
      anime({ targets: genBtn, scale: 0.97, duration: 80, easing: 'easeOutQuad' });
    }, { passive: true });

    genBtn.addEventListener('touchend', () => {
      anime({ targets: genBtn, scale: 1, duration: 300, easing: 'easeOutElastic(1, 0.5)' });
    }, { passive: true });

    genBtn.addEventListener('touchcancel', () => {
      anime({ targets: genBtn, scale: 1, duration: 200, easing: 'easeOutQuad' });
    }, { passive: true });
  }

  // ── Gallery cards — delegated so dynamically added cards are covered ──
  document.addEventListener('touchstart', e => {
    const card = e.target.closest('.tanda');
    if (!card) return;
    anime({ targets: card, scale: 0.97, duration: 80, easing: 'easeOutQuad' });
  }, { passive: true });

  document.addEventListener('touchend', e => {
    const card = e.target.closest('.tanda');
    if (!card) return;
    anime({ targets: card, scale: 1, duration: 300, easing: 'easeOutElastic(1, 0.5)' });
  }, { passive: true });

  document.addEventListener('touchcancel', e => {
    const card = e.target.closest('.tanda');
    if (!card) return;
    anime({ targets: card, scale: 1, duration: 200, easing: 'easeOutQuad' });
  }, { passive: true });
})();
