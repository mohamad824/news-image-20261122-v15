// news-image-20261122 v15 — "Sunday 22 November 2026"
// One-page broadsheet, rendered from scratch in Node 22 (stdlib only):
// own TrueType parser + rasterizer, own PNG encoder, every illustration
// drawn in code as flat vector editorial scenes.
// Writes a single 1024x1024 image to /output/entry.png
// (or $MAKEFUN_OUTPUT_DIR/entry.png when set). Deterministic, no network.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";

const W = 1024;
const H = 1024;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- palette
const CREAM = [246, 238, 220];
const INK = [16, 16, 18];
const RED = [200, 16, 46];
const NAVY = [11, 16, 32];
const NAVY2 = [22, 30, 58];
const PAPER_LINE = [190, 175, 150];
const GOLD = [198, 148, 52];
const GREEN = [46, 110, 72];
const TEAL = [42, 110, 106];
const AMBER = [196, 120, 30];
const SKY = [70, 110, 150];

// ---------------------------------------------------------------- utilities
function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------- PNG
function crc32(buf: Buffer): number {
  let table = (crc32 as unknown as { t?: Int32Array }).t;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    (crc32 as unknown as { t?: Int32Array }).t = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgb: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- TrueType
type Pt = { x: number; y: number; on: boolean };
interface GlyphOutline { contours: Pt[][]; advance: number; }
class Font {
  name: string;
  data: Buffer;
  upm = 1000;
  ascent = 800;
  descent = -200;
  numGlyphs = 0;
  indexToLocFormat = 0;
  numHMetrics = 0;
  cmap4: { endCodes: number[]; startCodes: number[]; idDeltas: number[]; idRangeOffsets: number[]; rangeOff: number } | null = null;
  cmap12: { startCodes: number[]; endCodes: number[]; startGlyphs: number[] } | null = null;
  locaOff = 0; glyfOff = 0; hmtxOff = 0;
  cache = new Map<string, { bmp: Uint8Array; w: number; h: number; ox: number; oy: number }>();
  missing = new Set<string>();

  constructor(file: string) {
    this.name = path.basename(file);
    this.data = fs.readFileSync(file);
    const d = this.data;
    const numTables = d.readUInt16BE(4);
    const tables = new Map<string, { off: number; len: number }>();
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      const tag = d.toString("ascii", o, o + 4);
      tables.set(tag, { off: d.readUInt32BE(o + 8), len: d.readUInt32BE(o + 12) });
    }
    const need = ["cmap", "head", "hhea", "maxp", "hmtx", "loca", "glyf"];
    for (const t of need) if (!tables.has(t)) throw new Error(this.name + ": missing table " + t);
    const head = tables.get("head")!;
    this.upm = d.readUInt16BE(head.off + 18);
    this.indexToLocFormat = d.readInt16BE(head.off + 50);
    const hhea = tables.get("hhea")!;
    this.ascent = d.readInt16BE(hhea.off + 4);
    this.descent = d.readInt16BE(hhea.off + 6);
    this.numHMetrics = d.readUInt16BE(hhea.off + 34);
    const maxp = tables.get("maxp")!;
    this.numGlyphs = d.readUInt32BE(maxp.off + 4);
    this.locaOff = tables.get("loca")!.off;
    this.glyfOff = tables.get("glyf")!.off;
    this.hmtxOff = tables.get("hmtx")!.off;
    const cmap = tables.get("cmap")!;
    const nSub = d.readUInt16BE(cmap.off + 2);
    let fmt4off = -1, fmt12off = -1;
    for (let i = 0; i < nSub; i++) {
      const rec = cmap.off + 4 + i * 8;
      const platform = d.readUInt16BE(rec);
      const enc = d.readUInt16BE(rec + 2);
      const sub = cmap.off + d.readUInt32BE(rec + 4);
      const fmt = d.readUInt16BE(sub);
      if (fmt === 4 && (platform === 3 || platform === 0)) fmt4off = sub;
      if (fmt === 12) fmt12off = sub;
      void enc;
    }
    if (fmt4off >= 0) {
      const segCount = d.readUInt16BE(fmt4off + 6) / 2;
      const endOff = fmt4off + 14;
      const startOff = endOff + segCount * 2 + 2;
      const deltaOff = startOff + segCount * 2;
      const rangeOff = deltaOff + segCount * 2;
      const glyphOff = rangeOff + segCount * 2;
      const endCodes: number[] = [], startCodes: number[] = [], idDeltas: number[] = [], idRangeOffsets: number[] = [];
      for (let i = 0; i < segCount; i++) {
        endCodes.push(d.readUInt16BE(endOff + i * 2));
        startCodes.push(d.readUInt16BE(startOff + i * 2));
        idDeltas.push(d.readInt16BE(deltaOff + i * 2));
        idRangeOffsets.push(d.readUInt16BE(rangeOff + i * 2));
      }
      const glyphIds: number[] = [];
      void glyphIds;
      this.cmap4 = { endCodes, startCodes, idDeltas, idRangeOffsets, rangeOff };
    }
    if (fmt12off >= 0) {
      const nGroups = d.readUInt32BE(fmt12off + 12);
      const startCodes: number[] = [], endCodes: number[] = [], startGlyphs: number[] = [];
      for (let i = 0; i < nGroups; i++) {
        const o = fmt12off + 16 + i * 12;
        startCodes.push(d.readUInt32BE(o));
        endCodes.push(d.readUInt32BE(o + 4));
        startGlyphs.push(d.readUInt32BE(o + 8));
      }
      this.cmap12 = { startCodes, endCodes, startGlyphs };
    }
  }

  glyphIndex(cp: number): number {
    if (this.cmap12) {
      const c = this.cmap12;
      for (let i = 0; i < c.startCodes.length; i++) {
        if (cp >= c.startCodes[i] && cp <= c.endCodes[i]) return c.startGlyphs[i] + (cp - c.startCodes[i]);
      }
    }
    if (this.cmap4) {
      const c = this.cmap4;
      for (let i = 0; i < c.endCodes.length; i++) {
        if (cp <= c.endCodes[i]) {
          if (cp < c.startCodes[i]) return 0;
          const ro = c.idRangeOffsets[i];
          if (ro === 0) return (cp + c.idDeltas[i]) & 0xffff;
          const addr = c.rangeOff + i * 2 + ro + (cp - c.startCodes[i]) * 2;
          return this.data.readUInt16BE(addr);
        }
      }
    }
    return 0;
  }

  glyphOffset(gid: number): [number, number] {
    const d = this.data;
    if (this.indexToLocFormat === 0) {
      const a = d.readUInt16BE(this.locaOff + gid * 2) * 2;
      const b = d.readUInt16BE(this.locaOff + (gid + 1) * 2) * 2;
      return [a, b];
    }
    return [d.readUInt32BE(this.locaOff + gid * 4), d.readUInt32BE(this.locaOff + (gid + 1) * 4)];
  }

  advance(gid: number): number {
    const g = Math.min(gid, this.numHMetrics - 1);
    return this.data.readUInt16BE(this.hmtxOff + g * 4);
  }

  outline(gid: number): GlyphOutline {
    const [a, b] = this.glyphOffset(gid);
    const adv = this.advance(gid);
    if (b <= a) return { contours: [], advance: adv };
    const d = this.data;
    const goff = this.glyfOff + a;
    const nContours = d.readInt16BE(goff);
    if (nContours >= 0) return { contours: this.simpleOutline(goff, nContours), advance: adv };
    // composite glyph
    const contours: Pt[][] = [];
    let p = goff + 10;
    while (true) {
      const flags = d.readUInt16BE(p);
      const compGid = d.readUInt16BE(p + 2);
      p += 4;
      let dx = 0, dy = 0, sx = 1, sy = 1;
      if (flags & 0x0001) { dx = d.readInt16BE(p); dy = d.readInt16BE(p + 2); p += 4; }
      else { dx = d.readInt8(p); dy = d.readInt8(p + 1); p += 2; }
      if (flags & 0x0008) { sx = d.readInt16BE(p) / 16384; sy = sx; p += 2; }
      else if (flags & 0x0040) { sx = d.readInt16BE(p) / 16384; p += 2; sy = d.readInt16BE(p) / 16384; p += 2; }
      else if (flags & 0x0080) { sx = d.readInt16BE(p) / 16384; p += 2; const s01 = d.readInt16BE(p) / 16384; p += 2; const s10 = d.readInt16BE(p) / 16384; p += 2; sy = d.readInt16BE(p) / 16384; p += 2; void s01; void s10; }
      const sub = this.outline(compGid);
      for (const c of sub.contours) contours.push(c.map((pt) => ({ x: pt.x * sx + dx, y: pt.y * sy + dy, on: pt.on })));
      if (!(flags & 0x0020)) break;
    }
    return { contours, advance: adv };
  }

  simpleOutline(goff: number, nContours: number): Pt[][] {
    const d = this.data;
    const endPts: number[] = [];
    for (let i = 0; i < nContours; i++) endPts.push(d.readUInt16BE(goff + 10 + i * 2));
    const nPts = endPts.length ? endPts[endPts.length - 1] + 1 : 0;
    const instrLen = d.readUInt16BE(goff + 10 + nContours * 2);
    let p = goff + 10 + nContours * 2 + 2 + instrLen;
    const flags: number[] = [];
    while (flags.length < nPts) {
      const f = d[p++];
      flags.push(f);
      if (f & 0x08) {
        const rep = d[p++];
        for (let i = 0; i < rep; i++) flags.push(f);
      }
    }
    const xs: number[] = new Array(nPts).fill(0);
    const ys: number[] = new Array(nPts).fill(0);
    let x = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 0x02) { const v = d[p++]; x += f & 0x10 ? v : -v; }
      else if (!(f & 0x10)) { x += d.readInt16BE(p); p += 2; }
      xs[i] = x;
    }
    let y = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 0x04) { const v = d[p++]; y += f & 0x20 ? v : -v; }
      else if (!(f & 0x20)) { y += d.readInt16BE(p); p += 2; }
      ys[i] = y;
    }
    const contours: Pt[][] = [];
    let start = 0;
    for (const end of endPts) {
      const pts: Pt[] = [];
      for (let i = start; i <= end; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 0x01) !== 0 });
      contours.push(pts);
      start = end + 1;
    }
    return contours;
  }

  // Rasterize one glyph at pixel size `size`, supersampled SSx.
  raster(gid: number, size: number): { bmp: Uint8Array; w: number; h: number; ox: number; oy: number } {
    const key = gid + "@" + size;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const SS = size <= 16 ? 3 : 2;
    const scale = (size / this.upm) * SS;
    const ol = this.outline(gid);
    const segs: [number, number, number, number][] = [];
    for (const contour of ol.contours) {
      if (contour.length < 2) continue;
      // Insert implied on-curve points between consecutive off-curve points (incl. wrap).
      const exp: Pt[] = [];
      const n0 = contour.length;
      for (let i = 0; i < n0; i++) {
        const cur = contour[i];
        const prev = contour[(i - 1 + n0) % n0];
        if (!cur.on && !prev.on) exp.push({ x: (prev.x + cur.x) / 2, y: (prev.y + cur.y) / 2, on: true });
        exp.push(cur);
      }
      // Rotate so the sequence starts at an on-curve point.
      let si = 0;
      while (si < exp.length && !exp[si].on) si++;
      if (si >= exp.length) continue;
      const seq = exp.slice(si).concat(exp.slice(0, si));
      let px = seq[0].x * scale, py = seq[0].y * scale;
      const m = seq.length;
      for (let k = 1; k <= m; k++) {
        const cur = seq[k % m];
        if (cur.on) {
          segs.push([px, py, cur.x * scale, cur.y * scale]);
          px = cur.x * scale; py = cur.y * scale;
        } else {
          const nxt = seq[(k + 1) % m];
          const ex = nxt.x * scale, ey = nxt.y * scale;
          const cx = cur.x * scale, cy = cur.y * scale;
          const steps = 8;
          let lx = px, ly = py;
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const qx = (1 - t) * (1 - t) * px + 2 * (1 - t) * t * cx + t * t * ex;
            const qy = (1 - t) * (1 - t) * py + 2 * (1 - t) * t * cy + t * t * ey;
            segs.push([lx, ly, qx, qy]);
            lx = qx; ly = qy;
          }
          px = ex; py = ey;
          k++; // consumed nxt as the curve endpoint
        }
      }
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x0, y0, x1, y1] of segs) {
      minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
      minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
    }
    if (!isFinite(minX)) {
      const empty = { bmp: new Uint8Array(0), w: 0, h: 0, ox: 0, oy: 0 };
      this.cache.set(key, empty);
      return empty;
    }
    const pad = 2;
    const w = Math.ceil(maxX - minX) + pad * 2;
    const h = Math.ceil(maxY - minY) + pad * 2;
    const baseX = Math.floor(minX) - pad; // supersampled x of bitmap column 0
    const baseY = maxY + pad;             // supersampled font-y of bitmap row 0 (top)
    const bmp = new Uint8Array(w * h);
    const e3: [number, number, number, number][] = segs.map(([x0, y0, x1, y1]) => [
      x0 - baseX, baseY - y0, x1 - baseX, baseY - y1,
    ]);
    for (let row = 0; row < h; row++) {
      const yC = row + 0.5;
      const xs: [number, number][] = [];
      for (const [ax, ay, bx, by] of e3) {
        if ((ay <= yC && by > yC) || (by <= yC && ay > yC)) {
          const t = (yC - ay) / (by - ay);
          xs.push([ax + t * (bx - ax), by > ay ? 1 : -1]);
        }
      }
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0, startX = 0;
      for (const [x, dir] of xs) {
        if (wind === 0) startX = x;
        wind += dir;
        if (wind === 0) {
          const x0 = Math.max(0, Math.ceil(startX));
          const x1 = Math.min(w, Math.floor(x));
          for (let xx = x0; xx < x1; xx++) bmp[row * w + xx] = 255;
        }
      }
    }
    const fw = Math.max(1, Math.round(w / SS));
    const fh = Math.max(1, Math.round(h / SS));
    const fb = new Uint8Array(fw * fh);
    for (let yy = 0; yy < fh; yy++) {
      for (let xx = 0; xx < fw; xx++) {
        let sum = 0, cnt = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
          const bx = xx * SS + sx, by = yy * SS + sy;
          if (bx < w && by < h) { sum += bmp[by * w + bx]; cnt++; }
        }
        fb[yy * fw + xx] = cnt ? Math.round(sum / cnt) : 0;
      }
    }
    const res = {
      bmp: fb, w: fw, h: fh,
      ox: Math.floor(baseX / SS),
      oy: Math.ceil(baseY / SS),
    };
    this.cache.set(key, res);
    return res;
  }

  widthOf(text: string, size: number): number {
    let w = 0;
    for (const ch of text) {
      const gid = this.glyphIndex(ch.codePointAt(0)!);
      if (gid === 0 && ch !== " ") this.missing.add(ch + " in " + this.name);
      w += (this.advance(gid) / this.upm) * size;
    }
    return w;
  }
}

// ---------------------------------------------------------------- Canvas
const CHECKS: string[] = [];
class Canvas {
  buf: Uint8Array;
  constructor() {
    this.buf = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      this.buf[i * 3] = CREAM[0]; this.buf[i * 3 + 1] = CREAM[1]; this.buf[i * 3 + 2] = CREAM[2];
    }
  }
  px(x: number, y: number, c: number[]): void {
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
    const o = (iy * W + ix) * 3;
    this.buf[o] = c[0]; this.buf[o + 1] = c[1]; this.buf[o + 2] = c[2];
  }
  blend(x: number, y: number, c: number[], a: number): void {
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H || a <= 0) return;
    const o = (iy * W + ix) * 3;
    if (a >= 255) { this.buf[o] = c[0]; this.buf[o + 1] = c[1]; this.buf[o + 2] = c[2]; return; }
    this.buf[o] = Math.round((c[0] * a + this.buf[o] * (255 - a)) / 255);
    this.buf[o + 1] = Math.round((c[1] * a + this.buf[o + 1] * (255 - a)) / 255);
    this.buf[o + 2] = Math.round((c[2] * a + this.buf[o + 2] * (255 - a)) / 255);
  }
  rect(x: number, y: number, w: number, h: number, c: number[]): void {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(W, Math.round(x + w)), y1 = Math.min(H, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      let o = (yy * W + x0) * 3;
      for (let xx = x0; xx < x1; xx++) { this.buf[o] = c[0]; this.buf[o + 1] = c[1]; this.buf[o + 2] = c[2]; o += 3; }
    }
  }
  hline(x: number, y: number, w: number, c: number[], th = 1): void {
    this.rect(x, y - Math.floor(th / 2), w, th, c);
  }
  vline(x: number, y: number, h: number, c: number[], th = 1): void {
    this.rect(x - Math.floor(th / 2), y, th, h, c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: number[], th = 1): void {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
    const r = th / 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.disc(x0 + dx * t, y0 + dy * t, r, c);
    }
  }
  disc(cx: number, cy: number, r: number, c: number[]): void {
    const rr = Math.max(0.5, r);
    const x0 = Math.floor(cx - rr), x1 = Math.ceil(cx + rr);
    const y0 = Math.floor(cy - rr), y1 = Math.ceil(cy + rr);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= rr * rr) this.px(x, y, c);
    }
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, c: number[]): void {
    const x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx);
    const y0 = Math.floor(cy - ry), y1 = Math.ceil(cy + ry);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const v = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
      if (v <= 1) this.px(x, y, c);
    }
  }
  poly(pts: [number, number][], c: number[]): void {
    if (pts.length < 3) return;
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) {
          xs.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) this.px(x, y, c);
      }
    }
  }
  outlineRect(x: number, y: number, w: number, h: number, c: number[], th = 1): void {
    this.rect(x, y, w, th, c);
    this.rect(x, y + h - th, w, th, c);
    this.rect(x, y, th, h, c);
    this.rect(x + w - th, y, th, h, c);
  }
  // ---- text ----
  text(font: Font, size: number, color: number[], x: number, baseY: number, str: string): number {
    let pen = x;
    for (const ch of str) {
      const gid = font.glyphIndex(ch.codePointAt(0)!);
      if (gid === 0 && ch !== " ") font.missing.add(ch + " in " + font.name);
      const r = font.raster(gid, size);
      if (r.w > 0) {
        const sx = Math.round(pen + r.ox);
        const sy = Math.round(baseY - r.oy);
        for (let yy = 0; yy < r.h; yy++) for (let xx = 0; xx < r.w; xx++) {
          const a = r.bmp[yy * r.w + xx];
          if (a) this.blend(sx + xx, sy + yy, color, a);
        }
      }
      pen += (font.advance(gid) / font.upm) * size;
    }
    return pen;
  }
  textC(font: Font, size: number, color: number[], cx: number, baseY: number, str: string): void {
    const w = font.widthOf(str, size);
    this.text(font, size, color, cx - w / 2, baseY, str);
  }
  textR(font: Font, size: number, color: number[], rx: number, baseY: number, str: string): void {
    const w = font.widthOf(str, size);
    this.text(font, size, color, rx - w, baseY, str);
  }
}

function wrap(font: Font, size: number, text: string, maxW: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? cur + " " + w : w;
    if (font.widthOf(trial, size) <= maxW || !cur) cur = trial;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
function drawWrapped(g: Canvas, font: Font, size: number, color: number[], x: number, baseY: number, lh: number, text: string, maxW: number, maxLines: number, tag: string): number {
  const lines: string[] = [];
  for (const part of text.split("\n")) lines.push(...wrap(font, size, part, maxW));
  if (lines.length > maxLines) CHECKS.push("OVERFLOW " + tag + ": " + lines.length + " lines (max " + maxLines + "): " + JSON.stringify(lines));
  const n = Math.min(lines.length, maxLines);
  for (let i = 0; i < n; i++) g.text(font, size, color, x, baseY + i * lh, lines[i]);
  return n;
}
function chip(g: Canvas, x: number, y: number, label: string, bg: number[], fg: number[], font: Font, size = 8): number {
  const w = font.widthOf(label, size) + 10;
  g.rect(x, y, w, 13, bg);
  g.text(font, size, fg, x + 5, y + 10, label);
  return w;
}
function nightSky(g: Canvas, x: number, y: number, w: number, h: number, seed: number): void {
  g.rect(x, y, w, h, NAVY);
  const rnd = lcg(seed);
  for (let i = 0; i < Math.floor(w * h / 220); i++) {
    const sx = x + 2 + rnd() * (w - 4);
    const sy = y + 2 + rnd() * (h * 0.55);
    g.disc(sx, sy, rnd() < 0.12 ? 1.1 : 0.7, [220, 220, 200]);
  }
}
function flame(g: Canvas, x: number, y: number, s: number): void {
  g.poly([[x, y - 3.2 * s], [x + 1.5 * s, y - 0.6 * s], [x + 1.1 * s, y + 1.2 * s], [x - 1.1 * s, y + 1.2 * s], [x - 1.5 * s, y - 0.6 * s]], [230, 90, 30]);
  g.poly([[x, y - 1.6 * s], [x + 0.8 * s, y - 0.2 * s], [x + 0.6 * s, y + 1.2 * s], [x - 0.6 * s, y + 1.2 * s], [x - 0.8 * s, y - 0.2 * s]], [245, 180, 40]);
}
function litWindows(g: Canvas, x: number, y: number, cols: number, rows: number, cw: number, ch: number, gx: number, gy: number, seed: number): void {
  const rnd = lcg(seed);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const lit = rnd();
    const col = lit < 0.55 ? [240, 190, 80] : lit < 0.75 ? [200, 210, 220] : [40, 48, 70];
    g.rect(x + c * (cw + gx), y + r * (ch + gy), cw, ch, col);
  }
}
function star4(g: Canvas, x: number, y: number, s: number, c: number[]): void {
  g.poly([[x, y - s], [x + 0.28 * s, y - 0.28 * s], [x + s, y], [x + 0.28 * s, y + 0.28 * s], [x, y + s], [x - 0.28 * s, y + 0.28 * s], [x - s, y], [x - 0.28 * s, y - 0.28 * s]], c);
}

// ---------------------------------------------------------------- scenes
// Every scene is drawn in code, flat vector editorial style, night navy
// skies with warm light. (g, x, y, w, h) = the illustration box.
type Scene = (g: Canvas, x: number, y: number, w: number, h: number) => void;

function sceneCOP31(g: Canvas, x: number, y: number, w: number, h: number): void {
  nightSky(g, x, y, w, h, 11);
  // hall back wall + windows
  g.rect(x, y, w, h * 0.42, [16, 24, 48]);
  g.rect(x + 8, y + 6, w - 16, 4, [60, 70, 100]);
  // flags row
  const flagCols: number[][] = [[200, 16, 46], [40, 80, 140], [240, 190, 80], [46, 110, 72], [200, 120, 40]];
  for (let i = 0; i < 5; i++) g.rect(x + 14 + i * 16, y + 12, 11, 7, flagCols[i]);
  // red NO DEAL banner
  g.rect(x + w * 0.30, y + 4, w * 0.40, 13, RED);
  // back row delegates (smaller)
  for (let i = 0; i < 6; i++) {
    const dx = x + 16 + i * 40;
    g.disc(dx + 12, y + 34, 6, [220, 190, 160]);
    g.poly([[dx + 2, y + 40], [dx + 22, y + 40], [dx + 18, y + 52], [dx + 6, y + 52]], [50, 60, 90]);
  }
  // long conference table
  g.poly([[x + 6, y + 56], [x + w - 6, y + 56], [x + w - 14, y + h - 6], [x + 14, y + h - 6]], [120, 90, 60]);
  g.rect(x + 6, y + 56, w - 12, 3, [90, 66, 44]);
  // front row delegates: heads + shoulders, name plates, mics
  const suits: number[][] = [[30, 40, 70], [90, 40, 50], [40, 70, 50], [70, 60, 30], [50, 50, 80], [80, 70, 40], [60, 40, 40]];
  for (let i = 0; i < 7; i++) {
    const dx = x + 10 + i * 36;
    g.disc(dx + 10, y + 62, 7, [225, 195, 165]);
    g.poly([[dx, y + 70], [dx + 20, y + 70], [dx + 17, y + 84], [dx + 3, y + 84]], suits[i]);
    g.rect(dx + 3, y + 84, 14, 5, [240, 235, 220]);
    g.line(dx + 18, y + 70, dx + 22, y + 62, [200, 200, 190], 1);
    g.disc(dx + 22, y + 61, 1.6, [200, 200, 190]);
  }
  // podium + speaker, left
  g.rect(x + w - 34, y + 58, 26, h - 64, [70, 50, 36]);
  g.disc(x + w - 21, y + 52, 6, [225, 195, 165]);
  g.poly([[x + w - 30, y + 58], [x + w - 12, y + 58], [x + w - 14, y + 68], [x + w - 28, y + 68]], [30, 40, 70]);
}
function sceneDymer(g: Canvas, x: number, y: number, w: number, h: number): void {
  nightSky(g, x, y, w, h, 22);
  const bx = x + w * 0.12, bw = w * 0.58, by = y + 10, bh = h - 16;
  g.rect(bx, by, bw, bh, [38, 42, 60]);
  litWindows(g, bx + 6, by + 6, 4, 4, 12, 8, 8, 8, 31);
  // collapsed corner + rubble
  g.poly([[bx + bw * 0.62, by], [bx + bw, by], [bx + bw, by + bh * 0.55], [bx + bw * 0.72, by + bh * 0.42]], [18, 20, 30]);
  g.poly([[bx + bw * 0.55, by + bh], [bx + bw, by + bh], [bx + bw, by + bh * 0.6], [bx + bw * 0.7, by + bh * 0.75]], [52, 48, 44]);
  g.disc(bx + bw * 0.8, by + bh * 0.9, 3, [120, 110, 100]);
  g.disc(bx + bw * 0.68, by + bh * 0.95, 2.4, [100, 92, 84]);
  // red rescue ladder
  g.line(bx + bw * 0.45, by + bh, bx + bw * 0.62, by + 4, RED, 2);
  g.line(bx + bw * 0.45 + 7, by + bh, bx + bw * 0.62 + 7, by + 4, RED, 2);
  for (let i = 0; i < 5; i++) {
    const t = i / 5;
    g.line(bx + bw * 0.45 + (bw * 0.17) * t, by + bh - (bh - 4) * t, bx + bw * 0.45 + 7 + (bw * 0.17) * t, by + bh - (bh - 4) * t, RED, 1);
  }
  // rescuer + survivor on stretcher
  g.disc(x + w * 0.82, y + h - 22, 4, [230, 200, 170]);
  g.rect(x + w * 0.79, y + h - 18, 7, 12, [200, 120, 30]);
  flame(g, x + w * 0.88, y + h - 26, 2.2);
  g.rect(x, y + h - 6, w, 6, [24, 26, 40]);
}
function sceneBahrain(g: Canvas, x: number, y: number, w: number, h: number): void {
  nightSky(g, x, y, w, h, 33);
  g.rect(x, y + h * 0.72, w, h * 0.28, [60, 52, 40]);
  // two radar dishes
  for (const [rx, tilt] of [[0.28, -0.5], [0.68, 0.4]] as [number, number][]) {
    const cx = x + w * rx, cy = y + h * 0.52;
    g.rect(cx - 2, cy, 4, h * 0.22, [150, 150, 145]);
    g.ellipse(cx, cy, 26, 9, [200, 200, 195]);
    g.ellipse(cx, cy - 1, 22, 7, [120, 125, 130]);
    g.line(cx, cy, cx + Math.sin(tilt) * 30, cy - Math.cos(tilt) * 22, [240, 190, 80], 1);
  }
  // missile trails + starburst
  g.line(x + w * 0.1, y + 8, x + w * 0.42, y + h * 0.45, [240, 200, 90], 2);
  g.line(x + w * 0.9, y + 6, x + w * 0.62, y + h * 0.4, [240, 200, 90], 2);
  star4(g, x + w * 0.5, y + h * 0.42, 7, [245, 180, 40]);
  star4(g, x + w * 0.5, y + h * 0.42, 3.5, [255, 230, 150]);
  // small base buildings
  g.rect(x + 6, y + h * 0.62, 18, 10, [40, 44, 60]);
  g.rect(x + w - 24, y + h * 0.62, 18, 10, [40, 44, 60]);
}
function sceneSparta(g: Canvas, x: number, y: number, w: number, h: number): void {
  nightSky(g, x, y, w, h, 44);
  g.rect(x, y + h * 0.58, w, h * 0.42, [14, 30, 52]);
  g.rect(x, y + h * 0.58, w, 2, [60, 90, 120]);
  // ship
  const hx = x + w * 0.08, hw = w * 0.84, hy = y + h * 0.42;
  g.poly([[hx, hy], [hx + hw, hy], [hx + hw - 8, hy + 14], [hx + 6, hy + 14]], [40, 44, 56]);
  g.rect(hx + 8, hy - 12, hw * 0.5, 12, [150, 60, 40]);
  g.rect(hx + hw * 0.55, hy - 12, hw * 0.3, 12, [180, 120, 50]);
  g.rect(hx + hw * 0.55, hy - 22, 16, 10, [200, 200, 195]);
  litWindows(g, hx + hw * 0.55 + 2, hy - 21, 2, 1, 5, 6, 3, 0, 55);
  flame(g, hx + hw * 0.3, hy - 8, 3);
  flame(g, hx + hw * 0.42, hy - 6, 2.4);
  g.disc(hx + hw * 0.36, hy - 22, 6, [80, 80, 85]);
  g.disc(hx + hw * 0.36, hy - 30, 4.5, [100, 100, 105]);
  // drone silhouette
  g.line(x + w * 0.78, y + 10, x + w * 0.92, y + 10, [220, 220, 210], 1.5);
  g.disc(x + w * 0.85, y + 10, 2.5, [220, 220, 210]);
}
function scenePeru(g: Canvas, x: number, y: number, w: number, h: number): void {
  g.rect(x, y, w, h, [52, 74, 88]);
  g.disc(x + w * 0.8, y + 12, 8, [240, 220, 160]);
  g.poly([[x, y + h], [x + w * 0.3, y + h * 0.25], [x + w * 0.55, y + h]], [40, 60, 52]);
  g.poly([[x + w * 0.4, y + h], [x + w * 0.68, y + h * 0.18], [x + w * 0.95, y + h]], [30, 48, 44]);
  g.poly([[x + w * 0.24, y + h * 0.3], [x + w * 0.3, y + h * 0.25], [x + w * 0.36, y + h * 0.3]], [235, 235, 225]);
  // shaking building with cracks
  const bx = x + w * 0.12, by = y + h * 0.42;
  g.rect(bx, by, 34, h - by + y - 4, [200, 190, 170]);
  litWindows(g, bx + 4, by + 4, 3, 2, 7, 6, 4, 5, 66);
  g.line(bx + 8, by, bx + 16, by + 12, [90, 40, 30], 1.5);
  g.line(bx + 16, by + 12, bx + 10, by + 22, [90, 40, 30], 1.5);
  g.line(bx + 24, by + 4, bx + 28, by + 16, [90, 40, 30], 1.5);
  // running figures
  for (const [fx, fy] of [[0.62, 0.82], [0.74, 0.86]] as [number, number][]) {
    g.disc(x + w * fx, y + h * fy - 8, 3.5, [40, 30, 25]);
    g.line(x + w * fx, y + h * fy - 5, x + w * fx + 3, y + h * fy + 4, [40, 30, 25], 2);
    g.line(x + w * fx, y + h * fy - 2, x + w * fx - 6, y + h * fy - 6, [40, 30, 25], 1.5);
    g.line(x + w * fx, y + h * fy - 2, x + w * fx + 6, y + h * fy - 4, [40, 30, 25], 1.5);
  }
  g.rect(x, y + h - 5, w, 5, [70, 60, 44]);
}
function sceneJerusalem(g: Canvas, x: number, y: number, w: number, h: number): void {
  g.rect(x, y, w, h, [214, 196, 160]);
  g.rect(x, y, w, h * 0.4, [150, 180, 205]);
  g.disc(x + w * 0.82, y + 10, 7, [245, 225, 150]);
  // domed government building
  const bx = x + w * 0.18, bw = w * 0.64;
  g.rect(bx, y + h * 0.45, bw, h * 0.4, [240, 235, 220]);
  g.ellipse(bx + bw / 2, y + h * 0.45, bw * 0.32, h * 0.2, [200, 160, 60]);
  g.rect(bx + bw / 2 - 2, y + h * 0.45 - h * 0.2 - 6, 4, 8, [200, 160, 60]);
  for (let i = 0; i < 5; i++) g.rect(bx + 8 + i * 18, y + h * 0.58, 8, h * 0.27, [120, 110, 95]);
  // flags
  g.line(x + 8, y + h * 0.3, x + 8, y + h * 0.55, [60, 60, 60], 1.5);
  g.rect(x + 8, y + h * 0.3, 12, 8, [30, 80, 160]);
  g.line(x + w - 10, y + h * 0.3, x + w - 10, y + h * 0.55, [60, 60, 60], 1.5);
  g.rect(x + w - 22, y + h * 0.3, 12, 8, [240, 240, 240]);
  g.rect(x + w - 22, y + h * 0.3 + 4, 12, 4, [30, 80, 160]);
  // podium + figure
  g.rect(x + w * 0.42, y + h - 14, 22, 10, [90, 60, 40]);
  g.disc(x + w * 0.5, y + h - 20, 4, [200, 170, 140]);
  g.poly([[x + w * 0.44, y + h - 16], [x + w * 0.56, y + h - 16], [x + w * 0.54, y + h - 8], [x + w * 0.46, y + h - 8]], [40, 50, 70]);
  g.rect(x, y + h - 4, w, 4, [110, 95, 70]);
}
function sceneKryvyi(g: Canvas, x: number, y: number, w: number, h: number): void {
  nightSky(g, x, y, w, h, 77);
  // missile streaks
  g.line(x + 10, y + 4, x + w * 0.4, y + h * 0.5, [245, 200, 90], 2);
  g.line(x + w * 0.7, y + 2, x + w * 0.5, y + h * 0.45, [245, 200, 90], 2);
  star4(g, x + w * 0.42, y + h * 0.52, 8, [245, 180, 40]);
  star4(g, x + w * 0.42, y + h * 0.52, 4, [255, 230, 150]);
  // damaged blocks + hospital
  g.rect(x + 6, y + h * 0.55, 34, h * 0.4, [52, 56, 72]);
  g.poly([[x + 6, y + h * 0.55], [x + 40, y + h * 0.55], [x + 34, y + h * 0.68], [x + 12, y + h * 0.68]], [24, 26, 36]);
  litWindows(g, x + 10, y + h * 0.62, 3, 2, 6, 6, 4, 5, 88);
  g.rect(x + w * 0.42, y + h * 0.6, 40, h * 0.35, [225, 225, 220]);
  g.rect(x + w * 0.42 + 16, y + h * 0.6 - 6, 8, 6, [225, 225, 220]);
  g.rect(x + w * 0.5, y + h * 0.68, 12, 3, RED);
  g.rect(x + w * 0.5 + 4.5, y + h * 0.68 - 4.5, 3, 12, RED);
  // ambulance
  g.rect(x + w * 0.72, y + h - 16, 26, 11, [240, 240, 235]);
  g.rect(x + w * 0.72 + 9, y + h - 13, 8, 2, RED);
  g.rect(x + w * 0.72 + 12, y + h - 16, 2, 8, RED);
  g.disc(x + w * 0.76, y + h - 4, 2.5, [20, 20, 20]);
  g.disc(x + w * 0.92, y + h - 4, 2.5, [20, 20, 20]);
  g.disc(x + w * 0.55, y + h * 0.5, 5, [90, 90, 95]);
  g.disc(x + w * 0.55, y + h * 0.42, 4, [110, 110, 115]);
  g.rect(x, y + h - 4, w, 4, [24, 26, 40]);
}
function sceneMexico(g: Canvas, x: number, y: number, w: number, h: number): void {
  g.rect(x, y, w, h, [232, 190, 130]);
  g.disc(x + w * 0.82, y + 10, 8, [245, 210, 110]);
  g.poly([[x, y + h * 0.55], [x + w * 0.25, y + h * 0.3], [x + w * 0.5, y + h * 0.55]], [170, 120, 80]);
  g.poly([[x + w * 0.4, y + h * 0.55], [x + w * 0.68, y + h * 0.22], [x + w, y + h * 0.55]], [150, 105, 70]);
  g.rect(x, y + h * 0.55, w, h * 0.45, [205, 165, 105]);
  // cactus
  g.rect(x + 8, y + h * 0.3, 6, h * 0.4, [50, 110, 60]);
  g.rect(x + 2, y + h * 0.42, 6, 4, [50, 110, 60]);
  g.rect(x + 14, y + h * 0.48, 6, 4, [50, 110, 60]);
  g.rect(x + 2, y + h * 0.42, 4, 12, [50, 110, 60]);
  g.rect(x + 16, y + h * 0.48, 4, 10, [50, 110, 60]);
  // police car
  g.rect(x + w * 0.42, y + h * 0.66, w * 0.5, 12, [30, 40, 60]);
  g.rect(x + w * 0.5, y + h * 0.55, w * 0.3, 10, [30, 40, 60]);
  g.rect(x + w * 0.52, y + h * 0.57, 8, 6, [150, 200, 230]);
  g.rect(x + w * 0.64, y + h * 0.57, 8, 6, [150, 200, 230]);
  g.rect(x + w * 0.6, y + h * 0.63, 12, 4, RED);
  g.rect(x + w * 0.6 + 12, y + h * 0.63, 12, 4, [40, 90, 200]);
  g.disc(x + w * 0.5, y + h * 0.66 + 12, 3.5, [15, 15, 15]);
  g.disc(x + w * 0.84, y + h * 0.66 + 12, 3.5, [15, 15, 15]);
  // handcuffs, foreground
  g.disc(x + w * 0.2, y + h * 0.82, 6, [200, 200, 205]);
  g.disc(x + w * 0.2, y + h * 0.82, 3.5, [232, 190, 130]);
  g.disc(x + w * 0.36, y + h * 0.82, 6, [200, 200, 205]);
  g.disc(x + w * 0.36, y + h * 0.82, 3.5, [232, 190, 130]);
  g.line(x + w * 0.2 + 5, y + h * 0.82, x + w * 0.36 - 5, y + h * 0.82, [160, 160, 165], 2);
}
function sceneHongKong(g: Canvas, x: number, y: number, w: number, h: number): void {
  g.rect(x, y, w, h, [180, 200, 215]);
  // skyline
  const towers: [number, number, number][] = [[0.02, 0.55, 0.12], [0.16, 0.35, 0.1], [0.28, 0.45, 0.12], [0.42, 0.3, 0.1], [0.54, 0.5, 0.12], [0.68, 0.38, 0.1], [0.8, 0.48, 0.12], [0.92, 0.6, 0.08]];
  for (const [tx, ty, tw] of towers) {
    g.rect(x + w * tx, y + h * ty, w * tw, h * (0.95 - ty), [40, 52, 70]);
    litWindows(g, x + w * tx + 2, y + h * ty + 4, 1, 3, 4, 4, 2, 4, 99 + Math.round(tx * 100));
  }
  // ballot box + ballot
  g.rect(x + w * 0.36, y + h * 0.62, w * 0.28, h * 0.3, RED);
  g.rect(x + w * 0.36, y + h * 0.62, w * 0.28, 4, [140, 10, 30]);
  g.rect(x + w * 0.45, y + h * 0.62 + 1, w * 0.1, 2, [20, 20, 20]);
  g.poly([[x + w * 0.44, y + h * 0.42], [x + w * 0.56, y + h * 0.42], [x + w * 0.54, y + h * 0.6], [x + w * 0.46, y + h * 0.6]], [245, 245, 240]);
  g.line(x + w * 0.47, y + h * 0.47, x + w * 0.5, y + h * 0.53, RED, 1.5);
  g.line(x + w * 0.5, y + h * 0.53, x + w * 0.55, y + h * 0.45, RED, 1.5);
  // voter figure
  g.disc(x + w * 0.16, y + h * 0.72, 4, [230, 200, 170]);
  g.poly([[x + w * 0.11, y + h * 0.77], [x + w * 0.21, y + h * 0.77], [x + w * 0.19, y + h * 0.95], [x + w * 0.13, y + h * 0.95]], [60, 70, 100]);
}
function sceneHormuz(g: Canvas, x: number, y: number, w: number, h: number): void {
  nightSky(g, x, y, w, h, 1010);
  g.rect(x, y + h * 0.6, w, h * 0.4, [16, 34, 56]);
  g.rect(x, y + h * 0.6, w, 2, [70, 100, 130]);
  // tanker 1 (left, stern hit)
  g.poly([[x + 4, y + h * 0.5], [x + w * 0.48, y + h * 0.5], [x + w * 0.44, y + h * 0.64], [x + 8, y + h * 0.64]], [60, 50, 45]);
  g.rect(x + w * 0.3, y + h * 0.38, w * 0.14, h * 0.12, [200, 200, 195]);
  flame(g, x + w * 0.12, y + h * 0.44, 3);
  flame(g, x + w * 0.2, y + h * 0.46, 2.2);
  g.disc(x + w * 0.16, y + h * 0.3, 6, [85, 85, 90]);
  g.disc(x + w * 0.16, y + h * 0.2, 4.5, [105, 105, 110]);
  // tanker 2 (right, engine room)
  g.poly([[x + w * 0.55, y + h * 0.54], [x + w - 4, y + h * 0.54], [x + w - 8, y + h * 0.68], [x + w * 0.58, y + h * 0.68]], [70, 55, 48]);
  g.rect(x + w * 0.82, y + h * 0.42, w * 0.12, h * 0.12, [200, 200, 195]);
  flame(g, x + w * 0.86, y + h * 0.48, 2.6);
  // lifeboat
  g.ellipse(x + w * 0.5, y + h * 0.8, 12, 4, [240, 160, 40]);
  g.disc(x + w * 0.5, y + h * 0.76, 3, [230, 200, 170]);
}
function sceneMQ1(g: Canvas, x: number, y: number, w: number, h: number): void {
  nightSky(g, x, y, w, h, 1111);
  // radar waves from the station (gold arcs)
  for (let i = 1; i <= 3; i++) {
    const r = i * 9;
    for (let a = -0.9; a <= 0.9; a += 0.15) {
      const px = x + w * 0.16 + Math.sin(a) * r;
      const py = y + h * 0.72 - Math.cos(a) * r * 0.5;
      g.disc(px, py, 0.9, [240, 200, 90]);
    }
  }
  // drone silhouette, centre
  const dx = x + w * 0.55, dy = y + h * 0.42;
  g.line(dx - 34, dy, dx + 34, dy, [225, 225, 220], 2);
  g.line(dx - 6, dy - 4, dx + 6, dy - 4, [225, 225, 220], 2);
  g.ellipse(dx, dy, 5, 9, [225, 225, 220]);
  g.disc(dx, dy + 8, 2, [225, 225, 220]);
  // explosion + falling debris
  star4(g, x + w * 0.82, y + h * 0.3, 9, [245, 180, 40]);
  star4(g, x + w * 0.82, y + h * 0.3, 4.5, [255, 230, 150]);
  g.disc(x + w * 0.78, y + h * 0.55, 2, [240, 200, 90]);
  g.disc(x + w * 0.86, y + h * 0.5, 1.8, [240, 200, 90]);
  // radar station below
  g.rect(x + w * 0.14, y + h * 0.72, 4, h * 0.2, [150, 150, 145]);
  g.ellipse(x + w * 0.16, y + h * 0.72, 14, 5, [200, 200, 195]);
  g.rect(x, y + h - 6, w, 6, [20, 26, 44]);
}
function sceneBrussels(g: Canvas, x: number, y: number, w: number, h: number): void {
  g.rect(x, y, w, h, [205, 190, 165]);
  // EU flag
  g.rect(x + 8, y + 8, 56, 34, [30, 60, 130]);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    star4(g, x + 36 + Math.cos(a) * 11, y + 25 + Math.sin(a) * 11, 1.8, [245, 210, 80]);
  }
  // Indonesian flag
  g.rect(x + w - 64, y + 8, 56, 34, [240, 240, 235]);
  g.rect(x + w - 64, y + 8, 56, 17, RED);
  // document + seal on table
  g.poly([[x + w * 0.28, y + h * 0.55], [x + w * 0.72, y + h * 0.55], [x + w * 0.66, y + h * 0.92], [x + w * 0.34, y + h * 0.92]], [245, 242, 230]);
  g.line(x + w * 0.36, y + h * 0.63, x + w * 0.64, y + h * 0.63, [60, 60, 60], 1);
  g.line(x + w * 0.37, y + h * 0.7, x + w * 0.63, y + h * 0.7, [60, 60, 60], 1);
  g.line(x + w * 0.38, y + h * 0.77, x + w * 0.56, y + h * 0.77, [60, 60, 60], 1);
  g.disc(x + w * 0.62, y + h * 0.84, 5, RED);
  g.disc(x + w * 0.62, y + h * 0.84, 2.5, [245, 210, 80]);
  // pen
  g.line(x + w * 0.7, y + h * 0.6, x + w * 0.78, y + h * 0.5, [30, 30, 30], 2);
  // handshake suggestion: two sleeves meeting
  g.poly([[x + w * 0.2, y + h * 0.5], [x + w * 0.46, y + h * 0.5], [x + w * 0.5, y + h * 0.58], [x + w * 0.24, y + h * 0.58]], [40, 60, 110]);
  g.poly([[x + w * 0.8, y + h * 0.5], [x + w * 0.54, y + h * 0.5], [x + w * 0.5, y + h * 0.58], [x + w * 0.76, y + h * 0.58]], [200, 60, 50]);
  g.disc(x + w * 0.5, y + h * 0.54, 4, [225, 195, 165]);
}
function sceneSomalia(g: Canvas, x: number, y: number, w: number, h: number): void {
  g.rect(x, y, w, h, [215, 200, 170]);
  g.rect(x, y, w, h * 0.38, [160, 185, 210]);
  g.disc(x + w * 0.85, y + 10, 7, [245, 225, 150]);
  // embassy building with columns + pediment
  const bx = x + w * 0.14, bw = w * 0.72;
  g.poly([[bx, y + h * 0.42], [bx + bw, y + h * 0.42], [bx + bw / 2, y + h * 0.28]], [200, 180, 140]);
  g.rect(bx, y + h * 0.42, bw, 4, [180, 160, 120]);
  for (let i = 0; i < 4; i++) g.rect(bx + 6 + i * (bw - 12) / 3.4, y + h * 0.46, 7, h * 0.3, [240, 235, 220]);
  g.rect(bx, y + h * 0.46, bw, h * 0.3, [225, 215, 195]);
  for (let i = 0; i < 4; i++) g.rect(bx + 6 + i * (bw - 12) / 3.4, y + h * 0.46, 7, h * 0.3, [245, 240, 228]);
  g.rect(bx + bw * 0.42, y + h * 0.58, bw * 0.16, h * 0.18, [60, 50, 40]);
  // flags: Somalia (blue + white star) and UAE
  g.line(x + 10, y + h * 0.3, x + 10, y + h * 0.52, [60, 60, 60], 1.5);
  g.rect(x + 10, y + h * 0.3, 14, 9, [60, 110, 200]);
  star4(g, x + 17, y + h * 0.3 + 4.5, 2.5, [255, 255, 255]);
  g.line(x + w - 12, y + h * 0.3, x + w - 12, y + h * 0.52, [60, 60, 60], 1.5);
  g.rect(x + w - 26, y + h * 0.3, 14, 9, [240, 240, 235]);
  g.rect(x + w - 26, y + h * 0.3, 14, 3, [0, 120, 60]);
  g.rect(x + w - 26, y + h * 0.3 + 6, 14, 3, [20, 20, 20]);
  // envoy with suitcase walking out
  g.disc(x + w * 0.62, y + h * 0.84, 3.5, [210, 180, 150]);
  g.poly([[x + w * 0.58, y + h * 0.88], [x + w * 0.66, y + h * 0.88], [x + w * 0.65, y + h - 2], [x + w * 0.59, y + h - 2]], [40, 50, 70]);
  g.rect(x + w * 0.7, y + h * 0.9, 10, 7, [120, 80, 40]);
  g.line(x + w * 0.66, y + h * 0.9, x + w * 0.7, y + h * 0.9, [60, 40, 20], 1.5);
  // car
  g.rect(x + w * 0.06, y + h * 0.86, 30, 8, [30, 35, 50]);
  g.rect(x + w * 0.1, y + h * 0.8, 18, 7, [30, 35, 50]);
  g.disc(x + w * 0.11, y + h * 0.86 + 8, 2.5, [15, 15, 15]);
  g.disc(x + w * 0.28, y + h * 0.86 + 8, 2.5, [15, 15, 15]);
  g.rect(x, y + h - 3, w, 3, [120, 105, 75]);
}
function sceneGaza(g: Canvas, x: number, y: number, w: number, h: number): void {
  g.rect(x, y, w, h, [140, 160, 180]);
  // rain
  for (let i = 0; i < 14; i++) {
    const rx = x + 6 + ((i * 37) % (w - 12));
    const ry = y + 4 + ((i * 23) % (h - 20));
    g.line(rx, ry, rx - 3, ry + 8, [220, 230, 240], 1);
  }
  // four flags
  const flagCols: number[][][] = [
    [[30, 60, 140], [240, 240, 235]],
    [[200, 30, 40], [255, 255, 255]],
    [[0, 140, 70], [255, 255, 255]],
    [[30, 60, 140], [255, 255, 255]],
  ];
  for (let i = 0; i < 4; i++) {
    const fx = x + 8 + i * ((w - 16) / 4);
    g.line(fx + 7, y + 8, fx + 7, y + 30, [60, 60, 60], 1.5);
    g.rect(fx + 7, y + 8, 13, 8, flagCols[i][0]);
    g.rect(fx + 7, y + 12, 13, 4, flagCols[i][1]);
  }
  // aid trucks
  for (const tx of [0.1, 0.52] as number[]) {
    g.rect(x + w * tx, y + h * 0.62, w * 0.36, h * 0.22, [240, 240, 235]);
    g.rect(x + w * tx, y + h * 0.62, w * 0.36, 3, RED);
    g.rect(x + w * tx + w * 0.28, y + h * 0.66, w * 0.08, h * 0.1, [150, 200, 230]);
    g.disc(x + w * tx + w * 0.08, y + h * 0.84 + 4, 3, [20, 20, 20]);
    g.disc(x + w * tx + w * 0.28, y + h * 0.84 + 4, 3, [20, 20, 20]);
  }
  // flood water
  g.rect(x, y + h - 10, w, 10, [70, 110, 140]);
  g.rect(x + 10, y + h - 7, 26, 1.5, [200, 220, 240]);
  g.rect(x + w - 40, y + h - 5, 26, 1.5, [200, 220, 240]);
}
function sceneVegas(g: Canvas, x: number, y: number, w: number, h: number): void {
  nightSky(g, x, y, w, h, 1515);
  // skyline lights
  for (let i = 0; i < 6; i++) {
    const tx = x + 4 + i * 26;
    g.rect(tx, y + h * 0.3 + (i % 3) * 6, 18, h * 0.4, [30, 34, 52]);
    g.rect(tx + 3, y + h * 0.32 + (i % 3) * 6, 3, 3, [240, 200, 90]);
    g.rect(tx + 10, y + h * 0.4 + (i % 3) * 6, 3, 3, [240, 120, 60]);
  }
  // checkered flag
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
    g.rect(x + w - 30 + c * 5, y + 6 + r * 5, 5, 5, (r + c) % 2 ? [20, 20, 20] : [245, 245, 240]);
  }
  g.line(x + w - 30, y + 6, x + w - 30, y + 26, [200, 200, 190], 1.5);
  // F1 car
  const cx = x + w * 0.1, cy = y + h * 0.68;
  g.poly([[cx, cy], [cx + w * 0.62, cy - 4], [cx + w * 0.78, cy + 2], [cx + w * 0.62, cy + 6], [cx + 6, cy + 6]], [200, 30, 50]);
  g.poly([[cx + w * 0.42, cy - 8], [cx + w * 0.58, cy - 8], [cx + w * 0.56, cy - 2], [cx + w * 0.44, cy - 2]], [30, 30, 40]);
  g.disc(cx + w * 0.2, cy + 8, 6, [15, 15, 15]);
  g.disc(cx + w * 0.2, cy + 8, 2.5, [200, 200, 200]);
  g.disc(cx + w * 0.68, cy + 8, 6, [15, 15, 15]);
  g.disc(cx + w * 0.68, cy + 8, 2.5, [200, 200, 200]);
  g.rect(cx + w * 0.78, cy - 10, 4, 14, [30, 30, 40]);
  g.rect(cx + w * 0.74, cy - 10, 12, 3, [30, 30, 40]);
  // speed lines
  g.line(x + 4, cy - 12, x + w * 0.3, cy - 12, [240, 200, 90], 1.5);
  g.line(x + 10, cy - 18, x + w * 0.22, cy - 18, [240, 200, 90], 1.5);
  g.rect(x, y + h - 6, w, 6, [24, 26, 40]);
}

// ---------------------------------------------------------------- content
interface Story {
  n: number; loc: string; cat: string; chip: string; chipBg: number[]; chipFg: number[];
  head: string; body: string; scene: Scene;
}
const CLAIM_BG = RED, CLAIM_FG = [255, 255, 255];
const CONF_BG = [255, 255, 255], CONF_FG = RED;
const LEADS: Story[] = [
  {
    n: 1, loc: "ANTALYA, TURKIYE", cat: "CLIMATE", chip: "NO DEAL", chipBg: RED, chipFg: [255, 255, 255],
    head: "COP31 collapses with no deal",
    body: "After days of overtime, the summit ends Sunday with no deal. The EU and ~130 nations reject a text that drops fossil fuels. President Kurum admits no consensus. The longest COP in history; the biggest setback since COP15 in 2009.",
    scene: sceneCOP31,
  },
  {
    n: 2, loc: "DYMER, UKRAINE", cat: "WAR", chip: "CONFIRMED", chipBg: CONF_BG, chipFg: CONF_FG,
    head: "Strike on Dymer block\nkills at least 10",
    body: "A drone hits a five-storey block 45 km north of Kyiv early on Sunday; the building partly collapses. A boy of seven is pulled alive after 14 hours; 11 people were unaccounted for.",
    scene: sceneDymer,
  },
  {
    n: 3, loc: "MANAMA, BAHRAIN", cat: "IRAN", chip: "CLAIM", chipBg: CLAIM_BG, chipFg: CLAIM_FG,
    head: "Iran claims two US radars hit;\nUS denies damage",
    body: "The IRGC claims a missile + drone operation destroyed two US Patriot radars at Al-Riffa and Awali. The US denies any damage to personnel or facilities. Bahrain: air defence intercepts; fire at a civilian industrial site.",
    scene: sceneBahrain,
  },
];
const GRID: Story[] = [
  { n: 4, loc: "GULF OF FINLAND", cat: "SEA", chip: "STILL ABLAZE", chipBg: CONF_BG, chipFg: CONF_FG, head: "Russian cargo ship Sparta II still ablaze", body: "Sanctioned ship tied to Russia's defence ministry, hit by a suspected Ukrainian drone; fire raged overnight.", scene: sceneSparta },
  { n: 5, loc: "PERU", cat: "EARTHQUAKE", chip: "6.8", chipBg: CONF_BG, chipFg: CONF_FG, head: "Magnitude 6.8 quake shakes Peru's Andes", body: "Tremors send Lima residents fleeing early; reports cite no damage or casualties.", scene: scenePeru },
  { n: 6, loc: "JERUSALEM", cat: "POLITICS", chip: "MANDATE", chipBg: CONF_BG, chipFg: CONF_FG, head: "Eisenkot asked to form Israel's government", body: "President Herzog passes over Netanyahu; mandate ceremony on Sunday.", scene: sceneJerusalem },
  { n: 7, loc: "UKRAINE", cat: "WAR", chip: "2 DEAD", chipBg: CONF_BG, chipFg: CONF_FG, head: "Missiles hit Zelenskyy's hometown, 2 dead", body: "Kryvyi Rih: 60 hurt, a hospital and 25 blocks hit; rubble and ambulances.", scene: sceneKryvyi },
  { n: 8, loc: "MEXICO", cat: "CARTELS", chip: "11 KILLED", chipBg: CONF_BG, chipFg: CONF_FG, head: "Cartel boss captured;\n11 killed", body: "Eleven killed after 'El Chapo Isidro' Meza Flores is arrested in Sinaloa.", scene: sceneMexico },
  { n: 9, loc: "HONG KONG", cat: "ELECTION", chip: "723 SEATS", chipBg: CONF_BG, chipFg: CONF_FG, head: "Hong Kong votes fill all 723 seats", body: "723 seats from 856 candidates, 31 subsectors; record 98.79% turnout; 5,640 voters.", scene: sceneHongKong },
  { n: 10, loc: "HORMUZ", cat: "SEA", chip: "2 TANKERS", chipBg: CONF_BG, chipFg: CONF_FG, head: "Two tankers hit and set ablaze near Hormuz", body: "Two tankers hit near Khasab, Oman; crews evacuated. No casualties; mine claim unproven.", scene: sceneHormuz },
  { n: 11, loc: "HORMUZ", cat: "AIR", chip: "20TH DRONE", chipBg: CLAIM_BG, chipFg: CLAIM_FG, head: "Iran claims 20th US MQ-1 drone downed", body: "IRGC claims a US MQ-1 downed east of Hormuz, the 20th of the war and 4th in 24 hours; unverified.", scene: sceneMQ1 },
  { n: 12, loc: "BRUSSELS", cat: "TRADE", chip: "98.5%", chipBg: CONF_BG, chipFg: CONF_FG, head: "EU and Indonesia sign landmark trade deal", body: "Signed Saturday in Brussels. EU exporters save €600m/year; car tariffs (up to 50%) gone in 5 years.", scene: sceneBrussels },
  { n: 13, loc: "SOMALIA", cat: "DIPLOMACY", chip: "ENVOY OUT", chipBg: CONF_BG, chipFg: CONF_FG, head: "Somalia orders UAE envoy to leave", body: "Mogadishu orders the UAE envoy out and recalls its ambassador too.", scene: sceneSomalia },
  { n: 14, loc: "GAZA", cat: "AID", chip: "4 NATIONS", chipBg: CONF_BG, chipFg: CONF_FG, head: "Four nations press Israel on Gaza aid", body: "Australia, Canada, Italy and Britain cite floods and suffering as aid flows in.", scene: sceneGaza },
  { n: 15, loc: "LAS VEGAS", cat: "FORMULA 1", chip: "35 LEAD CHANGES", chipBg: CONF_BG, chipFg: CONF_FG, head: "Verstappen wins the Las Vegas Grand Prix", body: "Third win in four years; 35 lead changes; beats Antonelli and Russell; Ferraris collide.", scene: sceneVegas },
];
const WIRES: string[] = [
  "Court backs $7.25bn Roundup settlement",
  "England thrash the All Blacks 37-12",
  "Arsenal held 2-2; Leeds stun Chelsea 4-1",
  "Estonia to close its Russia border; Moscow cries \"Iron Curtain\"",
  "France: police jailed for racist violence, a landmark ruling",
  "France: 6th straight Saturday of cost-of-living protests",
  "Trump warns of a \"tremendous tax\" on AI centres abroad",
  "Man convicted of starting the deadly 2025 Palisades fire",
  "State Dept details $12bn of Venezuelan oil revenue",
  "Trump ousts cyber director after outage criticism",
  "Ebola: the death toll passes 5,700, containment goes on",
  "Myanmar: France seeks UN action on the genocide ruling",
  "India-China: commanders meet on the Arunachal frontier",
  "Japan: forces to train live-fire at Indian facilities, a first",
  "Air India extends Jeddah suspension to 24 Nov",
  "ICMR signs off 100 health technology transfers",
  "Rahul's century headlines India's Test in NZ",
  "Cummins wins unanimous backing as Australia captain",
  "Switzerland: 4,000-year-old bronze ring found in melting ice",
  "Bystanders pull a driver from a burning car, Canberra",
  "PSG win 3-2 at Nice; Doue hurt badly",
];
const NUMBERS: [string, string][] = [
  ["186", "drones at Ukraine overnight"],
  ["10", "Dymer dead, at least"],
  ["2", "US radars claimed hit"],
  ["723", "Hong Kong seats filled"],
  ["98.5%", "tariffs removed, EU-Indonesia"],
  ["$7.25bn", "Roundup settlement"],
];
const REGIONS: [string, string, number[]][] = [
  ["EUROPE", "10", [176, 74, 60]],
  ["MIDDLE EAST", "5", [192, 122, 44]],
  ["AMERICAS", "8", [78, 122, 110]],
  ["ASIA-PACIFIC", "7", [96, 116, 150]],
  ["AFRICA", "2", [150, 122, 60]],
  ["OCEANIA", "2", [90, 120, 130]],
  ["WORLD", "2", [110, 100, 130]],
];

// ---------------------------------------------------------------- dotted map
const LAND: [number, number][][] = [
  [[-168, 66], [-140, 70], [-125, 71], [-110, 68], [-95, 69], [-85, 66], [-80, 73], [-75, 62], [-65, 60], [-55, 52], [-60, 47], [-70, 42], [-75, 35], [-80, 26], [-84, 30], [-90, 21], [-97, 16], [-92, 15], [-83, 9], [-79, 9], [-86, 13], [-92, 15], [-97, 16], [-105, 20], [-110, 24], [-117, 33], [-125, 40], [-124, 48], [-135, 58], [-155, 58], [-165, 60]],
  [[-79, 9], [-77, 4], [-80, -3], [-81, -6], [-77, -12], [-72, -18], [-70, -23], [-70, -30], [-72, -37], [-73, -44], [-74, -52], [-68, -55], [-65, -45], [-62, -39], [-58, -34], [-52, -32], [-48, -28], [-40, -22], [-35, -9], [-35, -6], [-40, -3], [-44, -2], [-50, 0], [-55, 5], [-60, 8], [-68, 11], [-72, 12], [-77, 8]],
  [[-10, 37], [-9, 43], [-2, 48], [0, 50], [3, 51], [7, 54], [8, 57], [11, 58], [7, 60], [5, 62], [12, 65], [18, 69], [29, 71], [31, 68], [30, 64], [26, 60], [23, 58], [27, 56], [30, 55], [28, 52], [23, 50], [18, 50], [14, 48], [12, 46], [8, 44], [3, 43], [-1, 44], [-2, 40], [-6, 37], [-9, 37]],
  [[-5, 50], [-3, 53], [-5, 56], [-3, 58], [-1, 57], [0, 53], [1, 51]],
  [[-6, 35], [-10, 31], [-15, 27], [-17, 21], [-17, 15], [-15, 11], [-12, 8], [-8, 5], [-4, 5], [2, 6], [6, 4], [9, 4], [9, 0], [12, -2], [12, -6], [13, -12], [12, -17], [14, -22], [12, -26], [16, -29], [19, -34], [26, -34], [32, -29], [35, -24], [36, -18], [40, -15], [40, -10], [42, -4], [46, -1], [51, 2], [51, 10], [48, 11], [44, 11], [42, 13], [39, 15], [37, 18], [34, 22], [32, 27], [30, 31], [25, 32], [19, 33], [11, 34], [10, 37], [6, 37]],
  [[28, 70], [40, 68], [55, 68], [70, 72], [80, 73], [95, 76], [110, 76], [130, 72], [150, 70], [170, 66], [180, 65], [180, 60], [170, 60], [162, 60], [158, 52], [142, 50], [140, 45], [135, 43], [130, 42], [127, 40], [126, 38], [122, 37], [120, 32], [122, 28], [118, 25], [112, 22], [108, 18], [106, 10], [104, 9], [103, 2], [100, 6], [98, 10], [97, 16], [94, 17], [92, 21], [89, 22], [86, 20], [82, 17], [80, 13], [77, 8], [76, 10], [73, 16], [70, 20], [66, 25], [61, 25], [57, 26], [54, 26], [50, 29], [48, 30], [44, 29], [40, 31], [36, 36], [33, 36], [30, 36], [28, 42], [26, 45], [24, 50], [28, 55], [30, 60], [28, 65]],
  [[113, -22], [114, -30], [115, -35], [118, -35], [124, -33], [129, -32], [132, -32], [135, -35], [138, -35], [140, -38], [145, -38], [150, -37], [153, -32], [153, -27], [150, -22], [146, -19], [142, -15], [142, -11], [137, -12], [135, -12], [132, -11], [130, -13], [126, -14], [122, -17], [118, -20]],
  [[109, 1], [111, 3], [114, 4], [117, 6], [119, 1], [117, -3], [114, -3], [110, -2]],
  [[95, 5], [98, 3], [101, 0], [104, -3], [106, -6], [104, -6], [101, -3], [98, 0]],
  [[105, -6], [110, -7], [114, -8], [114, -7], [108, -6]],
  [[131, -1], [136, -2], [141, -3], [146, -6], [150, -9], [147, -9], [142, -8], [137, -6], [132, -4]],
];
function inPoly(lon: number, lat: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function onLand(lon: number, lat: number): boolean {
  for (const p of LAND) if (inPoly(lon, lat, p)) return true;
  return false;
}
// pin: [story no, lon, lat, badge dx, badge dy]
const PINS: [number, number, number, number, number][] = [
  [1, 30.7, 36.9, -20, 17],
  [2, 30.3, 50.8, 24, -9],
  [3, 50.6, 26.2, 20, -17],
  [4, 24.0, 59.5, 13, -23],
  [5, -77.0, -12.0, -16, -12],
  [6, 35.2, 31.8, 24, -9],
  [7, 33.4, 47.9, -24, -9],
  [8, -107.9, 25.0, 14, -12],
  [9, 114.2, 22.3, 14, -10],
  [10, 56.3, 26.5, 26, 0],
  [11, 58.2, 25.0, 13, 22],
  [12, 4.4, 50.8, -24, -9],
  [13, 45.3, 2.0, -17, -20],
  [14, 34.5, 31.5, -9, 24],
  [15, -115.1, 36.2, 14, 10],
];

// ---------------------------------------------------------------- render
function render(): Canvas {
  const g = new Canvas();
  const pfBlack = new Font(path.join(SCRIPT_DIR, "fonts", "PlayfairDisplay-Black.ttf"));
  const pfBold = new Font(path.join(SCRIPT_DIR, "fonts", "PlayfairDisplay-Bold.ttf"));
  const bcSB = new Font(path.join(SCRIPT_DIR, "fonts", "BarlowCondensed-SemiBold.ttf"));
  const bcR = new Font(path.join(SCRIPT_DIR, "fonts", "BarlowCondensed-Regular.ttf"));
  const bcB = new Font(path.join(SCRIPT_DIR, "fonts", "BarlowCondensed-Bold.ttf"));
  const fonts = [pfBlack, pfBold, bcSB, bcR, bcB];

  // ---- top strip: dense region band
  g.text(bcSB, 10.5, INK, 16, 19, "36 STORIES · 7 REGIONS · ALL FROM THIS ONE DAY");
  // dense region band, centred between the left label and PRESS TIME
  const chipWidths = REGIONS.map(([name, count]) => bcB.widthOf(name + " " + count, 9.5) + 18);
  const chipTotal = chipWidths.reduce((a, b) => a + b, 0) + 3 * (REGIONS.length - 1);
  let cx = 232 + Math.max(0, (884 - 232 - chipTotal) / 2);
  REGIONS.forEach(([name, count, col], i) => {
    const label = name + " " + count;
    const wch = chipWidths[i];
    g.rect(cx, 6, wch, 15, col);
    g.text(bcB, 9.5, [255, 255, 255], cx + 9, 17.5, label);
    cx += wch + 3;
  });
  g.textR(bcB, 10.5, RED, 1008, 19, "PRESS TIME 23:59 UTC");

  // ---- masthead
  g.textC(pfBlack, 52, INK, 512, 76, "Sunday 22 November 2026");
  g.hline(16, 84, 992, RED, 1);
  // ---- red summary line
  g.textC(pfBold, 15, RED, 512, 99, "186 drones over Ukraine overnight — COP31 ends with no deal — Iran's radar claim meets Bahrain's denial");

  // ---- timeline bar
  g.rect(16, 104, 992, 18, NAVY);
  g.text(bcB, 10, [255, 255, 255], 26, 117, "THE DAY IN UTC");
  const TL: [string, string, number][] = [
    ["03:00", "COP31 objections due", 158],
    ["05:30", "Verstappen wins Vegas", 306],
    ["06:00", "COP31 plenary (no deal)", 452],
    ["MORNING", "Dymer strike", 640],
    ["EVENING", "Hong Kong results", 762],
    ["NIGHT", "COP31 collapses", 906],
  ];
  for (const [t, label, tx] of TL) {
    g.text(bcB, 10, GOLD, tx, 117, t);
    g.text(bcR, 10, [255, 255, 255], tx + bcB.widthOf(t + " ", 10), 117, label);
  }

  // ---- leads + sidebar
  const leadX = [16, 288, 560];
  const leadW = 264;
  const leadY = 128;
  LEADS.forEach((s, i) => {
    const x = leadX[i];
    s.scene(g, x, leadY, leadW, 96);
    // number badge top-left on illustration
    g.disc(x + 12, leadY + 12, 9, RED);
    g.textC(bcB, 11, [255, 255, 255], x + 12, leadY + 16, String(s.n));
    // data chip top-right on illustration
    const cw = bcB.widthOf(s.chip, 8) + 10;
    g.rect(x + leadW - cw - 6, leadY + 5, cw, 13, s.chipBg);
    g.text(bcB, 8, s.chipFg, x + leadW - cw - 1, leadY + 15, s.chip);
    // label
    g.text(bcSB, 10, RED, x, leadY + 112, s.loc + " — " + s.cat);
    // headline, max 2 lines
    drawWrapped(g, pfBold, 17, INK, x, leadY + 130, 18, s.head, leadW, 2, "lead" + s.n + "-head");
    // body, max 4 lines
    drawWrapped(g, bcR, 10, INK, x, leadY + 162, 12.5, s.body, leadW, 4, "lead" + s.n + "-body");
  });
  // sidebar THE DAY IN NUMBERS (all figures red)
  const sbX = 832, sbW = 176;
  g.rect(sbX, leadY, sbW, 202, NAVY);
  g.text(bcB, 11.5, [255, 255, 255], sbX + 10, leadY + 20, "THE DAY IN NUMBERS");
  g.hline(sbX + 10, leadY + 26, sbW - 20, GOLD, 1);
  NUMBERS.forEach(([num, cap], i) => {
    const ry = leadY + 30 + i * 28.5;
    g.text(pfBlack, 19, RED, sbX + 10, ry + 19, num);
    const capLines = wrap(bcR, 9.5, cap, sbW - 20 - pfBlack.widthOf(num, 19) - 10);
    capLines.slice(0, 2).forEach((ln, j) => {
      g.text(bcR, 9.5, [235, 235, 230], sbX + 10 + pfBlack.widthOf(num, 19) + 8, ry + 12 + j * 11, ln);
    });
    if (capLines.length > 2) CHECKS.push("OVERFLOW sidebar " + num);
  });

  // ---- red divider
  g.hline(16, 336, 992, RED, 1.5);

  // ---- grid: 2 rows x 6 cols, uniform height 148
  const colW = 159, gapX = (992 - 6 * colW) / 5;
  const rowY = [342, 498];
  GRID.forEach((s, i) => {
    const row = Math.floor(i / 6), col = i % 6;
    const x = 16 + col * (colW + gapX);
    const y = rowY[row];
    s.scene(g, x, y, colW, 60);
    g.disc(x + 10, y + 10, 8, RED);
    g.textC(bcB, 10, [255, 255, 255], x + 10, y + 13.5, String(s.n));
    const cw = bcB.widthOf(s.chip, 7.5) + 9;
    g.rect(x + colW - cw - 4, y + 4, cw, 12, s.chipBg);
    g.text(bcB, 7.5, s.chipFg, x + colW - cw + 0.5, y + 13, s.chip);
    g.text(bcSB, 9.5, RED, x, y + 73, s.loc + " — " + s.cat);
    drawWrapped(g, pfBold, 13, INK, x, y + 88, 15, s.head, colW, 2, "grid" + s.n + "-head");
    drawWrapped(g, bcR, 9.5, INK, x, y + 118, 11.5, s.body, colW, 3, "grid" + s.n + "-body");
  });

  // ---- ALSO ON: 3 columns x 7, bottoms aligned
  g.text(bcB, 13, RED, 16, 668, "ALSO ON SUNDAY 22 NOVEMBER — 21 MORE STORIES");
  g.hline(16, 674, 992, RED, 1.5);
  const colX = [16, 352, 688];
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 7; r++) {
      const idx = c * 7 + r;
      const n = 16 + idx;
      const by = 690 + r * 13.5;
      g.text(bcB, 9.5, RED, colX[c], by, String(n));
      g.text(bcR, 9.5, INK, colX[c] + 18, by, WIRES[idx]);
      const wdt = 18 + bcR.widthOf(WIRES[idx], 9.5);
      if (wdt > 318) CHECKS.push("OVERFLOW wire " + n + " width " + Math.round(wdt));
    }
  }

  // ---- bottom row: map + DATE CHECK, same height 168
  const botY = 780, botH = 168;
  // map box
  g.outlineRect(16, botY, 624, botH, INK, 1);
  g.text(bcB, 12, RED, 26, botY + 18, "WHERE IT HAPPENED");
  const mapX = 24, mapY = botY + 26, mapW = 608, mapH = 112;
  const lon2x = (lon: number) => mapX + ((lon + 168) / 360) * mapW;
  const lat2y = (lat: number) => mapY + ((84 - lat) / 142) * mapH;
  for (let py = mapY; py < mapY + mapH; py += 3.5) {
    for (let px = mapX; px < mapX + mapW; px += 3.5) {
      const lon = ((px - mapX) / mapW) * 360 - 168;
      const lat = 84 - ((py - mapY) / mapH) * 142;
      if (onLand(lon, lat)) g.disc(px, py, 1.05, [74, 64, 48]);
    }
  }
  for (const [n, lon, lat, dx, dy] of PINS) {
    const px = lon2x(lon), py = lat2y(lat);
    const bx = px + dx, by = py + dy;
    g.line(px, py, bx, by, RED, 1);
    g.disc(px, py, 2.6, RED);
    g.disc(bx, by, 8, RED);
    g.textC(bcB, 9, [255, 255, 255], bx, by + 3.2, String(n));
  }
  g.text(bcR, 8, INK, 26, botY + 152, "1 ANTALYA · 2 DYMER · 3 BAHRAIN · 4 GULF OF FINLAND · 5 PERU · 6 JERUSALEM · 7 KRYVYI RIH · 8 SINALOA");
  g.text(bcR, 8, INK, 26, botY + 162, "9 HONG KONG · 10 HORMUZ (TANKERS) · 11 HORMUZ (MQ-1) · 12 BRUSSELS · 13 MOGADISHU · 14 GAZA · 15 LAS VEGAS");
  // DATE CHECK box
  const dcX = 648, dcW = 360;
  g.outlineRect(dcX, botY, dcW, botH, RED, 2);
  g.text(bcB, 12, RED, dcX + 10, botY + 18, "DATE CHECK");
  const dcChip = "FULL-DAY EDITION";
  const dcw = bcB.widthOf(dcChip, 8) + 10;
  g.rect(dcX + dcW - dcw - 10, botY + 8, dcw, 13, RED);
  g.text(bcB, 8, [255, 255, 255], dcX + dcW - dcw - 5, botY + 18, dcChip);
  const dcBody = "DATE CHECK — FULL-DAY EDITION: wires through the end of Sunday 22 November 2026. Left out as Saturday 21 November news: the Kyiv bridge strikes, the Shenzhen summit and India's Nitish Setu opening — and the Lviv strike (Friday 20 Nov). Now included (22 November): COP31's collapse, the Dymer strike, Iran's Bahrain radar claim, Hong Kong's vote count, the Hormuz tanker fires, the MQ-1 claim. COP31's vote is no longer pending — the summit ended with no deal.";
  drawWrapped(g, bcR, 10, INK, dcX + 10, botY + 36, 12.5, dcBody, dcW - 20, 9, "datecheck");
  g.text(bcB, 9.5, RED, dcX + 10, botY + 152, "NOW INCLUDED — 22 NOVEMBER: COP31 collapse · Dymer strike · Bahrain claim");
  g.text(bcR, 9, INK, dcX + 10, botY + 163, "LEFT OUT — SATURDAY 21 NOVEMBER: Kyiv bridge · Shenzhen · Nitish Setu · Lviv (20 Nov)");

  // ---- footer
  g.text(bcR, 8.5, INK, 16, 962, "Sources: Reuters · CNN · AP · Xinhua · China Daily · UKMTO · IRIB · Al Jazeera · European Commission · Finnish Border Guard · FT · France 24 · Kyiv regional officials · SES · Bahrain");
  g.text(bcR, 8.5, INK, 16, 974, "CERTAINTY: CONFIRMED — official / 2+ outlets · CLAIM — one side's claim · REPORTED — witnesses / one source · PENDING — not settled yet  ·  Screens are illustrations — no photographs. All stories happened or were first reported on Sunday 22 November 2026 (UTC).");

  // ---- bottom navy bar
  g.rect(16, 982, 992, 30, NAVY);
  g.text(bcB, 12, [255, 255, 255], 28, 1002, "THE WORLD IN ONE DAY");
  g.textR(bcB, 12, [255, 255, 255], 996, 1002, "SUNDAY 22 NOVEMBER 2026 · ONE PAGE");

  // ---- fine grain (deterministic)
  const rnd = lcg(20261122);
  for (let i = 0; i < 2600; i++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H);
    g.blend(x, y, [60, 50, 35], 10);
  }
  for (const f of fonts) {
    if (f.missing.size) for (const m of f.missing) CHECKS.push("MISSING GLYPH: " + m);
  }
  return g;
}

function main(): void {
  const g = render();
  const png = encodePNG(g.buf, W, H);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  const sha = crypto.createHash("sha256").update(png).digest("hex");
  console.error("entry: " + outPath + " " + png.length + " bytes sha256=" + sha);
  if (CHECKS.length) for (const c of CHECKS) console.error("CHECK: " + c);
  else console.error("CHECKS: none");
}
main();
