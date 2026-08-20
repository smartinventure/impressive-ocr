// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Renders the brand icons to PNG.
 *
 * Written as a tiny rasteriser with no dependencies rather than pulling in `sharp` or a
 * headless browser: the mark is a rounded rectangle and four bars, which is trivial to draw
 * directly, and `sharp` is a native module that would need a prebuild for every platform CI
 * runs on — including win-arm64, where prebuilds are thin on the ground.
 *
 * electron-builder converts a 1024px PNG into .ico and .icns itself, so PNG is all we need.
 *
 *   node deploy/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'apps', 'desktop', 'build', 'icons');

/** Anchor green from the design system. */
const BRAND = [0x14, 0x53, 0x2d];
const WHITE = [0xff, 0xff, 0xff];
/** The server variant: darker ground, green bars — same product, unmistakably not the app. */
const SERVER_GROUND = [0x0b, 0x1f, 0x14];
const SERVER_BARS = [0x4e, 0x9b, 0x6c];

/**
 * The mark, in the original 100×100 coordinate space.
 *
 * Geometry is unchanged from the lockup: radius 22, bars at y 28/45/62, and the fourth line
 * broken 34 + 14. That break is the brand idea — it reads as *recognised* text — so it must
 * survive at every size rather than being smoothed away.
 */
const MARK = {
  size: 100,
  radius: 22,
  bars: [
    { x: 22, y: 28, w: 56, h: 9 },
    { x: 22, y: 45, w: 56, h: 9 },
    { x: 22, y: 62, w: 34, h: 9 },
    { x: 64, y: 62, w: 14, h: 9 },
  ],
};

/** Tray icons are drawn on a 16px grid, so the bars are thickened to survive rounding. */
const TRAY_MARK = {
  size: 100,
  radius: 18,
  bars: [
    { x: 18, y: 24, w: 64, h: 13 },
    { x: 18, y: 44, w: 64, h: 13 },
    { x: 18, y: 64, w: 38, h: 13 },
    { x: 64, y: 64, w: 18, h: 13 },
  ],
};

/**
 * Supersampling factor.
 *
 * The rounded corners are the only curve here, and at 1× they alias badly at small sizes.
 * Rendering 4× and box-filtering down is cheap and gives clean edges.
 */
const SUPERSAMPLE = 4;

function renderMark({ size, mark, ground, bars, knockOutBars = false }) {
  const big = size * SUPERSAMPLE;
  const scale = big / mark.size;
  const pixels = Buffer.alloc(big * big * 4);

  const radius = mark.radius * scale;

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const offset = (y * big + x) * 4;
      const insideGround = isInsideRoundedRect(x + 0.5, y + 0.5, big, big, radius);

      if (!insideGround) {
        continue; // Left transparent.
      }

      const onBar = mark.bars.some((bar) => {
        const bx = bar.x * scale;
        const by = bar.y * scale;
        return (
          x + 0.5 >= bx &&
          x + 0.5 < bx + bar.w * scale &&
          y + 0.5 >= by &&
          y + 0.5 < by + bar.h * scale
        );
      });

      if (onBar) {
        // A macOS template image carries only black and alpha — the OS tints the opaque
        // pixels. So the bars are cut *out* of the shape rather than painted a second
        // colour, which is the only way the motif survives being recoloured.
        if (knockOutBars) {
          continue;
        }
        pixels[offset] = bars[0];
        pixels[offset + 1] = bars[1];
        pixels[offset + 2] = bars[2];
        pixels[offset + 3] = 255;
      } else {
        pixels[offset] = ground[0];
        pixels[offset + 1] = ground[1];
        pixels[offset + 2] = ground[2];
        pixels[offset + 3] = 255;
      }
    }
  }

  return downsample(pixels, big, size);
}

function isInsideRoundedRect(x, y, width, height, radius) {
  const left = radius;
  const right = width - radius;
  const top = radius;
  const bottom = height - radius;

  if (x >= left && x <= right) return y >= 0 && y <= height;
  if (y >= top && y <= bottom) return x >= 0 && x <= width;

  const cx = x < left ? left : right;
  const cy = y < top ? top : bottom;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** Box filter from the supersampled buffer down to the target size. */
function downsample(source, sourceSize, targetSize) {
  const factor = sourceSize / targetSize;
  const out = Buffer.alloc(targetSize * targetSize * 4);

  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        count = 0;

      for (let sy = y * factor; sy < (y + 1) * factor; sy += 1) {
        for (let sx = x * factor; sx < (x + 1) * factor; sx += 1) {
          const offset = (Math.floor(sy) * sourceSize + Math.floor(sx)) * 4;
          const alpha = source[offset + 3];
          // Premultiply so a transparent neighbour cannot darken the edge pixels.
          r += source[offset] * alpha;
          g += source[offset + 1] * alpha;
          b += source[offset + 2] * alpha;
          a += alpha;
          count += 1;
        }
      }

      const target = (y * targetSize + x) * 4;
      if (a === 0) {
        out[target + 3] = 0;
      } else {
        out[target] = Math.round(r / a);
        out[target + 1] = Math.round(g / a);
        out[target + 2] = Math.round(b / a);
        out[target + 3] = Math.round(a / count);
      }
    }
  }
  return out;
}

// --- Minimal PNG encoder ----------------------------------------------------

function encodePng(rgba, size) {
  // One filter byte (0 = None) per scanline, as the PNG spec requires.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// --- ICO ---------------------------------------------------------------------

/**
 * Pack PNGs into a Windows .ico.
 *
 * Vista and later accept PNG-compressed entries directly, so no BMP encoder is needed. Only
 * the *shortcut* icons need this — electron-builder derives the app's own .ico from the
 * 1024px PNG itself.
 */
function encodeIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  const payloads = [];
  // Directory entries are fixed-width, so the first image's data starts right after them.
  let offset = 6 + count * 16;

  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    // 256 is stored as 0 — the field is a single byte.
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette colours
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32BE(0, 8);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);

    entries.push(entry);
    payloads.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...payloads]);
}

// --- Output -----------------------------------------------------------------

function write(name, rgba, size) {
  const path = join(outDir, name);
  writeFileSync(path, encodePng(rgba, size));
  process.stdout.write(`  ${name}  ${size}×${size}\n`);
}

function main() {
  mkdirSync(outDir, { recursive: true });
  process.stdout.write(`Writing icons to ${outDir}\n`);

  // electron-builder derives .ico and .icns from this one.
  write('icon.png', renderMark({ size: 1024, mark: MARK, ground: BRAND, bars: WHITE }), 1024);
  write(
    'icon-server.png',
    renderMark({ size: 1024, mark: MARK, ground: SERVER_GROUND, bars: SERVER_BARS }),
    1024,
  );

  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    write(`icon-${size}.png`, renderMark({ size, mark: MARK, ground: BRAND, bars: WHITE }), size);
  }

  // Tray: 32px covers both standard and HiDPI menu bars.
  const trayColours = {
    idle: [0x5a, 0x61, 0x59],
    running: [0x1d, 0x4e, 0xd8],
    paused: [0xb4, 0x53, 0x09],
    error: [0xb9, 0x1c, 0x1c],
  };
  for (const [state, colour] of Object.entries(trayColours)) {
    write(
      `tray-${state}.png`,
      renderMark({ size: 32, mark: TRAY_MARK, ground: colour, bars: WHITE }),
      32,
    );
  }

  // macOS template image: black plus alpha only. The OS tints it for the current menu bar,
  // so a coloured icon would look wrong against one of the two themes.
  write(
    'tray-template.png',
    renderMark({
      size: 32,
      mark: TRAY_MARK,
      ground: [0, 0, 0],
      bars: [0, 0, 0],
      knockOutBars: true,
    }),
    32,
  );

  // The Start Menu shortcut for headless server mode needs a real .ico — Windows shortcuts
  // will not take a PNG.
  for (const [name, config] of [
    ['icon.ico', { ground: BRAND, bars: WHITE }],
    ['icon-server.ico', { ground: SERVER_GROUND, bars: SERVER_BARS }],
  ]) {
    const images = [16, 32, 48, 64, 128, 256].map((size) => ({
      size,
      png: encodePng(renderMark({ size, mark: MARK, ...config }), size),
    }));
    const path = join(outDir, name);
    writeFileSync(path, encodeIco(images));
    process.stdout.write(`  ${name}  6 sizes\n`);
  }

  process.stdout.write('Done.\n');
}

main();
