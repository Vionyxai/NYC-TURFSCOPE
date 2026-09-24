// Draws the home-screen icon (white map pin on green) as PNGs. Zero dependencies.
// Usage: node scripts/make-icon.js   → m3-map/icon-180.png, icon-192.png, icon-512.png
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from '../lib/util.js';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

function icon(size) {
  const bg = [21, 128, 61], fg = [255, 255, 255];
  const px = Buffer.alloc(size * (size * 3 + 1));
  const cx = size / 2, cy = size * 0.42, R = size * 0.24, tip = size * 0.8, hole = size * 0.095;
  for (let y = 0; y < size; y++) {
    px[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for smooth edges
      let cover = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const X = x + (sx + 0.5) / 4, Y = y + (sy + 0.5) / 4;
        const d = Math.hypot(X - cx, Y - cy);
        // pin = circle + the triangle tangent to it pointing down, minus the hole
        const t = (Y - cy) / (tip - cy);
        const inTri = Y >= cy && Y <= tip && Math.abs(X - cx) <= R * (1 - t) * 0.98;
        const inPin = (d <= R || inTri) && d > hole;
        if (inPin) cover++;
      }
      const a = cover / 16;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) px[o + i] = Math.round(bg[i] * (1 - a) + fg[i] * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(px, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) fs.writeFileSync(path.join(ROOT, 'm3-map', `icon-${size}.png`), icon(size));
console.log('[turfscope] icons → m3-map/icon-180.png, icon-192.png, icon-512.png');
