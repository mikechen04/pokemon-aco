// Generates build/icon.ico (16-256 px) and build/icon.png (512 px) with no external tools.
// The logo is the "PA" monogram: a pink P and a light-blue A with a white check, on a light
// gray rounded square. A white outline around the A keeps a gap where the letters touch.
// Every stroke is a round-capped line or arc, drawn with signed distances. The same shapes
// are in the Logo component (src/renderer/components/ui.tsx). Run with `npm run icons`.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const BACKGROUND = [238, 240, 244];
const PINK = [255, 148, 180];
const BLUE = [106, 174, 235];
const WHITE = [255, 255, 255];

// Coordinates are in a 100 x 100 box, like the SVG viewBox.
const LETTER_WIDTH = 15;
const GAP_WIDTH = 22;
const CHECK_WIDTH = 3.2;
const P_LINES = [
  [22, 76, 22, 26],
  [22, 26, 35, 26],
  [35, 54, 22, 54],
];
const P_BOWL = { cx: 35, cy: 40, r: 14 };
const A_LINES = [
  [48, 76, 64, 26],
  [64, 26, 80, 76],
  [55, 63, 73, 63],
];
const CHECK_LINES = [
  [60, 32, 63.5, 35.5],
  [63.5, 35.5, 70, 28.5],
];

/** Signed distance to a rounded rectangle centred at (cx, cy). Negative inside. */
function roundedRectSdf(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance from a point to a line segment. */
function segmentDistance(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

/** Distance to the right half of a circle (the P's bowl). */
function bowlDistance(px, py, { cx, cy, r }) {
  if (px >= cx) return Math.abs(Math.hypot(px - cx, py - cy) - r);
  return Math.min(Math.hypot(px - cx, py - (cy - r)), Math.hypot(px - cx, py - (cy + r)));
}

const nearest = (px, py, lines) => Math.min(...lines.map((line) => segmentDistance(px, py, line)));

/** Source-over composite of a straight-alpha color onto a premultiplied accumulator. */
function over(acc, color, alpha) {
  const inv = 1 - alpha;
  acc[0] = color[0] * alpha + acc[0] * inv;
  acc[1] = color[1] * alpha + acc[1] * inv;
  acc[2] = color[2] * alpha + acc[2] * inv;
  acc[3] = alpha + acc[3] * inv;
}

function shade(u, v) {
  const acc = [0, 0, 0, 0];
  if (roundedRectSdf(u, v, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return acc;
  over(acc, BACKGROUND, 1);
  const px = u * 100;
  const py = v * 100;
  const p = Math.min(nearest(px, py, P_LINES), bowlDistance(px, py, P_BOWL));
  if (p <= LETTER_WIDTH / 2) over(acc, PINK, 1);
  const a = nearest(px, py, A_LINES);
  if (a <= GAP_WIDTH / 2) over(acc, WHITE, 1);
  if (a <= LETTER_WIDTH / 2) over(acc, BLUE, 1);
  if (nearest(px, py, CHECK_LINES) <= CHECK_WIDTH / 2) over(acc, WHITE, 1);
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
