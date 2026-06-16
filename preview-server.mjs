// preview-server.mjs — servidor local de preview en vivo.
//
// Uso:
//   node preview-server.mjs
//   → abrí http://localhost:5390 en el navegador
//
// analizar.mjs --preview hace POST a /broadcast con eventos
// {type, payload} que se reenvían a todos los clientes conectados
// vía SSE (/events). El último estado se guarda para que un cliente
// que se conecta tarde pueda "ponerse al día".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PREVIEW_PORT || 5390;

const clients = new Set();
let history = []; // eventos acumulados desde el último 'reset'

const STATIC = {
  '/': 'preview.html',
  '/preview.html': 'preview.html',
  '/render-core.js': 'render-core.js',
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Extrae el <style> de template.html para que preview.html reuse exactamente
  // las mismas clases (.slide, .tv-row, etc.) sin duplicar el CSS.
  if (url.pathname === '/styles.css') {
    try {
      const tpl = await readFile(path.join(__dirname, 'template.html'), 'utf-8');
      const match = tpl.match(/<style>([\s\S]*?)<\/style>/);
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(match ? match[1] : '');
    } catch {
      res.writeHead(404).end('No encontrado');
    }
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('\n');
    clients.add(res);
    // Reenvía el historial acumulado para que el cliente arranque al día
    for (const ev of history) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/broadcast' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let event;
      try {
        event = JSON.parse(body);
      } catch {
        res.writeHead(400).end('JSON inválido');
        return;
      }
      if (event.type === 'reset') history = [];
      history.push(event);
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of clients) client.write(payload);
      res.writeHead(204).end();
    });
    return;
  }

  // Fotos referenciadas por los slides durante el preview (rutas relativas
  // tipo "fotos/IMG_1234.jpg") — se sirven directo del disco, sin pasar por
  // el data-url base64 que usa generar.mjs para el render final.
  if (url.pathname.startsWith('/fotos/')) {
    try {
      const file = path.join(__dirname, decodeURIComponent(url.pathname));
      const buf = await readFile(file);
      const ext = path.extname(file).toLowerCase();
      const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(buf);
    } catch {
      res.writeHead(404).end('No encontrado');
    }
    return;
  }

  const file = STATIC[url.pathname];
  if (file) {
    try {
      const content = await readFile(path.join(__dirname, file), 'utf-8');
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      res.end(content);
    } catch {
      res.writeHead(404).end('No encontrado');
    }
    return;
  }

  res.writeHead(404).end('No encontrado');
});

server.listen(PORT, () => {
  console.log(`\n👁  Preview en vivo: http://localhost:${PORT}\n`);
  console.log('Dejalo abierto y corré: node analizar.mjs <contenido.json> --preview\n');
});
