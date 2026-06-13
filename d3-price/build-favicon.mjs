// Generates favicon assets from favicon-source.svg using sharp.
// Outputs: favicon-32x32.png, favicon-192x192.png, favicon-512x512.png, favicon.ico
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/home/dthree3/d3-price-monitor/d3-worker/');
const sharp = require('sharp');

const here = new URL('.', import.meta.url).pathname;
const svg = readFileSync(here + 'favicon-source.svg');

async function png(size) {
  return await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function buildIco(entries) {
  // entries: [{ size, data(Buffer) }]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const b = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 0); // width
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1); // height
    dir.writeUInt8(0, b + 2);            // palette
    dir.writeUInt8(0, b + 3);            // reserved
    dir.writeUInt16LE(1, b + 4);         // color planes
    dir.writeUInt16LE(32, b + 6);        // bits per pixel
    dir.writeUInt32LE(e.data.length, b + 8);  // size of data
    dir.writeUInt32LE(offset, b + 12);   // offset
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

const p16 = await png(16);
const p32 = await png(32);
const p48 = await png(48);
const p192 = await png(192);
const p512 = await png(512);

writeFileSync(here + 'favicon-32x32.png', p32);
writeFileSync(here + 'favicon-192x192.png', p192);
writeFileSync(here + 'favicon-512x512.png', p512);
writeFileSync(here + 'favicon.ico', buildIco([
  { size: 16, data: p16 },
  { size: 32, data: p32 },
  { size: 48, data: p48 },
]));

console.log('Done:', {
  ico: buildIco([{ size: 16, data: p16 }]).length && 'favicon.ico',
  sizes: [16, 32, 48, 192, 512],
});
