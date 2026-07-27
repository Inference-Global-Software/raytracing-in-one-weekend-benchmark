#!/usr/bin/env node
// 2x2 box downscale in linear light for supersampled renders:
// decode (filter-0 PNG from render.mjs), un-gamma (x^2), average 2x2,
// re-gamma (sqrt), re-encode. Usage: node tools/downscale.mjs in.png out.png
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

const [inPath, outPath] = process.argv.slice(2);
const data = readFileSync(inPath);

let pos = 8, W = 0, H = 0, idat = [];
while (pos < data.length) {
  const len = data.readUInt32BE(pos);
  const type = data.toString('ascii', pos + 4, pos + 8);
  if (type === 'IHDR') { W = data.readUInt32BE(pos + 8); H = data.readUInt32BE(pos + 12); }
  if (type === 'IDAT') idat.push(data.subarray(pos + 8, pos + 8 + len));
  pos += 12 + len;
}
const raw = inflateSync(Buffer.concat(idat));
const stride = 1 + W * 3;

const W2 = W >> 1, H2 = H >> 1;
const out = Buffer.alloc(H2 * (1 + W2 * 3));
for (let y = 0; y < H2; y++) {
  out[y * (1 + W2 * 3)] = 0;
  for (let x = 0; x < W2; x++) {
    for (let c = 0; c < 3; c++) {
      const p00 = raw[(2 * y) * stride + 1 + (2 * x) * 3 + c];
      const p01 = raw[(2 * y) * stride + 1 + (2 * x + 1) * 3 + c];
      const p10 = raw[(2 * y + 1) * stride + 1 + (2 * x) * 3 + c];
      const p11 = raw[(2 * y + 1) * stride + 1 + (2 * x + 1) * 3 + c];
      const lin = (p00 * p00 + p01 * p01 + p10 * p10 + p11 * p11) / 4;
      out[y * (1 + W2 * 3) + 1 + x * 3 + c] = Math.min(255, Math.round(Math.sqrt(lin)));
    }
  }
}

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, d) => {
  const b = Buffer.alloc(12 + d.length);
  b.writeUInt32BE(d.length, 0);
  b.write(type, 4, 'ascii');
  d.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length);
  return b;
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W2, 0);
ihdr.writeUInt32BE(H2, 4);
ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`${W}x${H} -> ${W2}x${H2}: ${outPath}`);
