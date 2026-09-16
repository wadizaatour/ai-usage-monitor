/**
 * Generates media/icon.png — the Marketplace listing icon.
 *
 * The Marketplace requires a raster icon (128x128 minimum); the activity-bar
 * SVG does not qualify. Rather than add an image dependency for one static
 * asset, this writes the PNG directly: PNG is just chunks wrapping zlib-
 * compressed scanlines, and node's zlib does the only hard part.
 *
 * Run `npm run icon` after changing anything here. The output is deterministic,
 * so re-running it produces a byte-identical file.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { crc32 } from "node:zlib";

const SIZE = 256;

// VS Code-ish dark panel with a green pulse line, echoing the activity-bar icon.
const BG = [24, 26, 31];
const LINE = [78, 201, 127];

/** The polyline from media/icon.svg, in a 24x24 space: a heartbeat/pulse. */
const POINTS = [
  [3, 13],
  [6, 13],
  [8.5, 7],
  [12.5, 19],
  [15, 13],
  [21, 13],
];

const scale = SIZE / 24;
const STROKE = 1.8 * scale;

/** Shortest distance from p to segment ab — used to stroke the polyline. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(px - ax, py - ay);
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Build RGBA scanlines, each prefixed with PNG filter byte 0 (none).
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
let offset = 0;

for (let y = 0; y < SIZE; y++) {
  raw[offset++] = 0;
  for (let x = 0; x < SIZE; x++) {
    // Sample at pixel centre.
    const px = x + 0.5;
    const py = y + 0.5;

    let nearest = Infinity;
    for (let i = 0; i < POINTS.length - 1; i++) {
      const [ax, ay] = POINTS[i];
      const [bx, by] = POINTS[i + 1];
      nearest = Math.min(
        nearest,
        distanceToSegment(px, py, ax * scale, ay * scale, bx * scale, by * scale),
      );
    }

    // Antialias across one pixel at the stroke edge, so the line has no jaggies.
    const edge = STROKE / 2;
    const alpha = Math.max(0, Math.min(1, edge + 0.5 - nearest));

    for (let c = 0; c < 3; c++) {
      raw[offset++] = Math.round(BG[c] + (LINE[c] - BG[c]) * alpha);
    }
    raw[offset++] = 255;
  }
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// 10-12: compression, filter, interlace — all 0.

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("media", { recursive: true });
writeFileSync("media/icon.png", png);
console.log(`wrote media/icon.png (${SIZE}x${SIZE}, ${png.length} bytes)`);
