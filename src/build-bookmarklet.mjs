import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(root, 'bookmarklet', 'grab-price.js');
const outDir = path.join(root, 'dist');
const outPath = path.join(outDir, 'grab-price.bookmarklet.txt');

const source = fs.readFileSync(sourcePath, 'utf8');
const lines = source
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('//'));

const bookmarklet = `javascript:${lines.join(' ')}`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, `${bookmarklet}\n`);

console.log(`Wrote ${path.relative(root, outPath)}`);
