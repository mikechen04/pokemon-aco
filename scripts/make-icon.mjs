// Generates build/icon.ico (16-256 px) and build/icon.png (512 px) with no external tools.
// The logo is drawn procedurally: a navy rounded square holding a tilted blue-to-pink
// trading card with a white lightning bolt. Run with `npm run icons`.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const NAVY_TOP = [26, 34, 54];
const NAVY_BOTTOM = [11, 15, 25];
const BLUE = [143, 211, 255];
const PINK = [255, 179, 217];
const WHITE = [255, 255, 255];

const CARD = { cx: 0.5, cy: 0.52, hw: 0.25, hh: 0.33, r: 0.07, angle: (-8 * Math.PI) / 180 };
const BOLT = [
  [0.555, 0.25],
  [0.635, 0.25],
  [0.545, 0.46],
  [0.645, 0.46],
  [0.435, 0.79],
  [0.485, 0.55],
  [0.375, 0.55],
];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Signed distance to a rounded rectangle centred at (cx, cy). Negative inside. */
function roundedRectSdf(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function insidePolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Source-over composite of a straight-alpha color onto a premultiplied accumulator. */
function over(acc, color, alpha) {
  const inv = 1 - alpha;
  acc[0] = color[0] * alpha + acc[0] * inv;
  acc[1] = color[1] * alpha + acc[1] * inv;
  acc[2] = color[2] * alpha + acc[2] * inv;
  acc[3] = alpha + acc[3] * inv;
}

function shade(px, py) {
  const acc = [0, 0, 0, 0];
  if (roundedRectSdf(px, py, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return acc;
  over(acc, mix(NAVY_TOP, NAVY_BOTTOM, py), 1);

  // Undo the card rotation so the card and bolt can be tested in their upright frame.
  const cos = Math.cos(-CARD.angle);
  const sin = Math.sin(-CARD.angle);
  const dx = px - CARD.cx;
  const dy = py - CARD.cy;
  const lx = CARD.cx + dx * cos - dy * sin;
  const ly = CARD.cy + dx * sin + dy * cos;

  const shadow = roundedRectSdf(lx - 0.015, ly - 0.03, CARD.cx, CARD.cy, CARD.hw, CARD.hh, CARD.r);
  over(acc, [0, 0, 0], 0.4 * (1 - smoothstep(-0.03, 0.06, shadow)));

  if (roundedRectSdf(lx, ly, CARD.cx, CARD.cy, CARD.hw, CARD.hh, CARD.r) <= 0) {
    const t = clamp01((lx - (CARD.cx - CARD.hw) + (ly - (CARD.cy - CARD.hh))) / (2 * (CARD.hw + CARD.hh)));
    over(acc, mix(BLUE, PINK, t), 1);
    if (insidePolygon(lx, ly, BOLT)) over(acc, WHITE, 1);
  }
  return acc;
}

function render(size, samples = 4) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const c = shade((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size);
          for (let i = 0; i < 4; i++) sum[i] += c[i];
        }
      }
      const n = samples * samples;
      const a = sum[3] / n;
      const o = (y * size + x) * 4;
      // Accumulator is premultiplied; PNG wants straight alpha.
      rgba[o] = a > 0 ? Math.round(sum[0] / n / a) : 0;
      rgba[o + 1] = a > 0 ? Math.round(sum[1] / n / a) : 0;
      rgba[o + 2] = a > 0 ? Math.round(sum[2] / n / a) : 0;
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO container with PNG-compressed entries (supported since Windows Vista). */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

await mkdir('build', { recursive: true });
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const images = icoSizes.map((size) => ({ size, png: encodePng(size, render(size, size <= 32 ? 8 : 4)) }));
await writeFile('build/icon.ico', encodeIco(images));
await writeFile('build/icon.png', encodePng(512, render(512, 3)));
console.log(`Wrote build/icon.ico (${icoSizes.join(', ')} px) and build/icon.png (512 px)`);
