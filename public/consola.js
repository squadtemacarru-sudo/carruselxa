// consola.js — lógica de la mini consola integrada

(function () {
  const form    = document.getElementById('consolaForm');
  const input   = document.getElementById('consolaInput');
  const output  = document.getElementById('consolaOutput');
  if (!form || !input || !output) return;

  // Historial de comandos (navegable con ↑↓)
  const history = [];
  let histIdx   = -1;

  function getMarca() {
    return document.getElementById('marcaSelect')?.value || 'squadteam';
  }

  // Agrega una línea al output
  function addLine(text, cls = 'consola-out') {
    const el = document.createElement('span');
    el.className = `consola-line ${cls}`;
    el.textContent = text;
    output.appendChild(el);
    scrollBottom();
    return el;
  }

  function scrollBottom() {
    output.scrollTop = output.scrollHeight;
  }

  // Indicador de "pensando..."
  function addThinking() {
    const el = document.createElement('div');
    el.className = 'consola-thinking';
    el.innerHTML = `<span>procesando</span><div class="consola-thinking-dots"><span></span><span></span><span></span></div>`;
    output.appendChild(el);
    scrollBottom();
    return el;
  }

  // Conecta al SSE del job y muestra las líneas en tiempo real
  function streamJobLog() {
    if (window._consolaStream) {
      window._consolaStream.close();
    }
    const es = new EventSource('/api/job/stream');
    window._consolaStream = es;

    let done = false;
    es.onmessage = (e) => {
      const text = JSON.parse(e.data);
      const lines = text.split('\n');
      lines.forEach(l => {
        if (!l) return;
        const cls = l.startsWith('✅') ? 'consola-ok'
                  : l.startsWith('❌') ? 'consola-err'
                  : 'consola-stream';
        addLine(l, cls);
      });
      if (text.includes('✅') || text.includes('❌')) {
        if (!done) { done = true; es.close(); }
      }
    };
    es.onerror = () => { if (!done) { done = true; es.close(); } };
  }

  // Enviar comando
  async function sendInput(text) {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Historial
    history.unshift(trimmed);
    if (history.length > 50) history.pop();
    histIdx = -1;

    // Mostrar comando
    addLine(trimmed, 'consola-cmd');
    input.value = '';

    // Thinking indicator
    const thinking = addThinking();

    try {
      const res = await fetch('/api/consola', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: trimmed, marca: getMarca() })
      });
      const data = await res.json();

      thinking.remove();

      // Mostrar líneas de respuesta
      (data.lines || []).forEach(line => {
        const cls = line.startsWith('  ✓') || line.startsWith('✅') ? 'consola-ok'
                  : line.startsWith('  ✗') || line.startsWith('❌') ? 'consola-err'
                  : line.startsWith('  IA:') ? 'consola-out'
                  : 'consola-out';
        addLine(line, cls);
      });

      // Si hay streaming, conectar al SSE
      if (data.streaming) {
        streamJobLog();
      }
    } catch (err) {
      thinking.remove();
      addLine(`  ✗ Error de red: ${err.message}`, 'consola-err');
    }

    scrollBottom();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendInput(input.value);
  });

  // Navegación de historial con ↑↓
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (histIdx < history.length - 1) {
        histIdx++;
        input.value = history[histIdx];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx > 0) {
        histIdx--;
        input.value = history[histIdx];
      } else {
        histIdx = -1;
        input.value = '';
      }
    }
  });

  // Auto-focus cuando se abre el tab consola
  document.querySelectorAll('.nav-btn[data-tab="tab-consola"]').forEach(btn => {
    btn.addEventListener('click', () => {
      setTimeout(() => input.focus(), 100);
    });
  });

})();
