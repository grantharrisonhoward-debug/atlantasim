// Decoded map chunk. Coordinates are expanded to Float32 world metres so that
// both the tile renderer (worker) and the physics queries (main thread) can
// use them directly.

import { parseContainer } from './container';

export interface ChunkHeader {
  lod: number; i: number; j: number; ox: number; oy: number; unit: number;
  names: string[]; refs: string[];
}

export interface Chunk {
  key: string;
  lod: number;
  i: number; j: number;
  names: string[];
  refs: string[];
  /** world-space vertices, interleaved x,y */
  pts: Float32Array;
  // lines
  nLines: number;
  lk: Uint8Array; lf: Uint8Array; ll: Int8Array; ln: Int32Array; lr: Int32Array;
  lo: Uint32Array; lc: Uint32Array;
  lbox: Float32Array; // minx,miny,maxx,maxy per line
  // polygons (areas)
  nPolys: number;
  pk: Uint8Array; po: Uint32Array; pc: Uint32Array;
  pbox: Float32Array;
  // buildings
  nBlds: number;
  bh: Uint8Array; bf: Uint8Array; bo: Uint32Array; bc: Uint32Array;
  bbox: Float32Array;
  // rings shared by polys & buildings
  ro: Uint32Array; rc: Uint32Array;
}

function bboxOfRange(pts: Float32Array, o: number, n: number, out: Float32Array, k: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let p = o * 2, e = (o + n) * 2; p < e; p += 2) {
    const x = pts[p], y = pts[p + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  out[k * 4] = x0; out[k * 4 + 1] = y0; out[k * 4 + 2] = x1; out[k * 4 + 3] = y1;
}

export function decodeChunk(buf: ArrayBuffer, key: string): Chunk {
  const { header: h, arrays: a } = parseContainer<ChunkHeader>(buf);
  const P = a.P as Int16Array;
  const pts = new Float32Array(P.length);
  const u = h.unit;
  for (let k = 0; k < P.length; k += 2) {
    pts[k] = h.ox + P[k] * u;
    pts[k + 1] = h.oy + P[k + 1] * u;
  }
  const lo = a.Lo as Uint32Array, lc = a.Lc as Uint32Array;
  const nLines = lo.length;
  const lbox = new Float32Array(nLines * 4);
  for (let k = 0; k < nLines; k++) bboxOfRange(pts, lo[k], lc[k], lbox, k);
  const ro = a.Ro as Uint32Array, rc = a.Rc as Uint32Array;
  const po = a.Po as Uint32Array, pc = a.Pc as Uint32Array;
  const nPolys = po.length;
  const pbox = new Float32Array(nPolys * 4);
  for (let k = 0; k < nPolys; k++) bboxOfRange(pts, ro[po[k]], rc[po[k]], pbox, k); // outer ring
  const bo = a.Bo as Uint32Array, bc = a.Bc as Uint32Array;
  const nBlds = bo.length;
  const bbox = new Float32Array(nBlds * 4);
  for (let k = 0; k < nBlds; k++) bboxOfRange(pts, ro[bo[k]], rc[bo[k]], bbox, k);
  return {
    key, lod: h.lod, i: h.i, j: h.j, names: h.names, refs: h.refs, pts,
    nLines, lk: a.Lk as Uint8Array, lf: a.Lf as Uint8Array, ll: a.Ll as Int8Array,
    ln: a.Ln as Int32Array, lr: a.Lr as Int32Array, lo, lc, lbox,
    nPolys, pk: a.Pk as Uint8Array, po, pc, pbox,
    nBlds, bh: a.Bh as Uint8Array, bf: a.Bf as Uint8Array, bo, bc, bbox,
    ro, rc,
  };
}

export function chunkUrl(base: string, lod: number, i: number, j: number) {
  return `${base}world/L${lod}/${i}_${j}.bin`;
}
