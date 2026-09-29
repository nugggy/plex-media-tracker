// Renders the legacy launcher PNGs (Android 7 and older, and anywhere a
// bitmap is wanted) from the same shapes as the dashboard's header disc:
// a black rounded square with a faint edge and the orange play triangle.
// Android 8 and up use the vector adaptive icon in res/drawable-v24 instead.
// No image library: pixels are drawn here and written as PNG by hand.
import { writeFileSync, rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';

const res = resolve(import.meta.dirname, '../android/app/src/main/res');
const SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const BG = [0, 0, 0];
const LINE = [0x2c, 0x2c, 0x2c];
const ACCENT = [0xc9, 0x7b, 0x3c];
const SS = 4; // supersampling per axis

/** Signed distance to a rounded square of half-size h and corner radius r, centred at 0. */
function roundedSquare(x, y, h, r) {
  const qx = Math.abs(x) - h + r;
  const qy = Math.abs(y) - h + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** The disc's triangle, M15 11 L28 20 L15 29 in the 40-unit box, as a distance sign only. */
function inTriangle(u, v) {
  const [ax, ay, bx, by, cx, cy] = [15, 11, 28, 20, 15, 29];
  const s1 = (bx - ax) * (v - ay) - (by - ay) * (u - ax);
  const s2 = (cx - bx) * (v - by) - (cy - by) * (u - bx);
  const s3 = (ax - cx) * (v - cy) - (ay - cy) * (u - cx);
  return s1 >= 0 && s2 >= 0 && s3 >= 0;
}

function render(size, round) {
  const px = new Uint8Array(size * size * 4);
  const unit = size / 40;
  const edge = Math.max(1, unit); // the 1-unit border, never thinner than a pixel
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const cx = fx - size / 2;
          const cy = fy - size / 2;
          const d = round ? Math.hypot(cx, cy) - size / 2 : roundedSquare(cx, cy, size / 2, size * 0.225);
          if (d > 0) continue;
          let c = d > -edge ? LINE : BG;
          if (inTriangle(fx / unit, fy / unit)) c = ACCENT;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      // Premultiplied averages back to straight alpha.
      const cov = a / n;
      px[i] = cov ? Math.round(r / n / (cov / 255)) : 0;
      px[i + 1] = cov ? Math.round(g / n / (cov / 255)) : 0;
      px[i + 2] = cov ? Math.round(b / n / (cov / 255)) : 0;
      px[i + 3] = Math.round(cov);
    }
  }
  return px;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [density, size] of Object.entries(SIZES)) {
  const dir = `${res}/mipmap-${density}`;
  writeFileSync(`${dir}/ic_launcher.png`, png(size, render(size, false)));
  writeFileSync(`${dir}/ic_launcher_round.png`, png(size, render(size, true)));
  // The adaptive icon now draws its foreground from the vector, so the bitmap
  // foreground is no longer referenced by anything.
  rmSync(`${dir}/ic_launcher_foreground.png`, { force: true });
}
console.log('launcher icons rendered');
