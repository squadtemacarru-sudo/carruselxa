// generar-fondo.mjs — prototipo: genera un fondo con FLUX.1-schnell (Hugging Face)
// respetando la paleta y el mood de SQUAD TEAM. Uso:
//   node generar-fondo.mjs "<descripción del fondo>" [salida.png]
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

process.loadEnvFile(path.join(import.meta.dirname, '.env'));

const apiKey = process.env.HF_API_TOKEN;
if (!apiKey) throw new Error('Falta HF_API_TOKEN en .env');

const prompt = process.argv[2];
if (!prompt) {
  console.error('Uso: node generar-fondo.mjs "<descripción del fondo>" [salida.png]');
  process.exit(1);
}
const salida = process.argv[3] || 'fondos/prueba.png';

const ESTILO_MARCA = `
Background photo for a premium fitness coaching Instagram carousel (SQUAD TEAM).
Vertical format 4:5.
Aesthetic: editorial, brutalist, high contrast, deep black (#040404) dominant.
Hard directional lighting, strong shadows, subtle analog film grain.
NO people, NO faces, NO text, NO logos.
Subject: gym iron — weight plates, racks, chains, barbells, concrete/metal textures.
A lime accent (#e8ff00) may appear as a single small highlight or reflection, never dominant.
Leave one area of the composition with less detail (negative space) for text overlay.
Avoid generic "stock photo" or motivational-cliché look.
`.trim();

const res = await fetch(
  'https://router.huggingface.co/fal-ai/fal-ai/flux/schnell',
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: `${ESTILO_MARCA}\n\nForeground subject: ${prompt}`,
      image_size: { width: 1024, height: 1280 }
    })
  }
);

if (!res.ok) {
  throw new Error(`HF error ${res.status}: ${await res.text()}`);
}

const data = await res.json();
const url = data.images?.[0]?.url;
if (!url) {
  throw new Error('La respuesta no incluyó imagen: ' + JSON.stringify(data).slice(0, 800));
}

const imgRes = await fetch(url);
const buf = Buffer.from(await imgRes.arrayBuffer());
await mkdir(path.dirname(salida), { recursive: true });
await writeFile(salida, buf);
console.log(`✓ ${salida}`);
