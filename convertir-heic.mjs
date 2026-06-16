import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import convert from 'heic-convert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fotosDir = path.join(__dirname, 'fotos');

const files = await readdir(fotosDir);
for (const file of files) {
  if (!/\.heic$/i.test(file)) continue;
  const inputPath = path.join(fotosDir, file);
  const outputPath = path.join(fotosDir, file.replace(/\.heic$/i, '.jpg'));
  console.log(`Convirtiendo ${file}...`);
  const inputBuffer = await readFile(inputPath);
  const outputBuffer = await convert({ buffer: inputBuffer, format: 'JPEG', quality: 0.9 });
  await writeFile(outputPath, outputBuffer);
  await unlink(inputPath);
  console.log(`✓ ${path.basename(outputPath)}`);
}
