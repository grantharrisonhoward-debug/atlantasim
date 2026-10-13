// Tile rasteriser. Runs inside the tile workers (OffscreenCanvas 2D).
// A tile at zoom z has 2^-z device-metres per pixel and TILE_PX pixels a side.

import type { Chunk } from '../world/chunk';
import { LK, LF, PK } from '../world/codes';
import { pointInRing } from '../world/manifest';
import { ROAD_ORDER, THEMES, THEME_MAP, roadStyleKey, type Theme } from './style';

export const TILE_PX = 512;
export const GUTTER = 2;

export interface TileJob {
  id: number;
  z: number;
  tx: number;
  ty: number;
  pxScale: number; // device px per CSS px
  theme?: string;   // 'map' | 'real'
}

export const tileWorldSize = (z: number) => TILE_PX * Math.pow(2, -z);
export const lodForZoom = (z: number) => (z >= 0 ? 0 : z >= -3 ? 1 : 2);

type Ctx = OffscreenCanvasRenderingContext2D;

function hash2(i: number, j: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export function drawTile(ctx: Ctx, shadow: Ctx, chunks: Chunk[], job: TileJob, region: Float32Array | null) {
  const mpp = Math.pow(2, -job.z);
  const inv = 1 / mpp;
  const S = TILE_PX + GUTTER * 2;
  const T = TILE_PX * mpp;
  const x0 = job.tx * T - GUTTER * mpp;
  const y0 = job.ty * T - GUTTER * mpp;
  const x1 = x0 + S * mpp, y1 = y0 + S * mpp;
  const pxs = job.pxScale;
  const cssMpp = mpp * pxs;
  const lod = lodForZoom(job.z);
  const margin = 30 + 12 * mpp;
  const bx0 = x0 - margin, by0 = y0 - margin, bx1 = x1 + margin, by1 = y1 + margin;
  const X = (wx: number) => (wx - x0) * inv;
  const Y = (wy: number) => (wy - y0) * inv;
  const th: Theme = THEMES[job.theme ?? 'map'] ?? THEME_MAP;
  const ROAD = th.road, RAIL = th.rail;
  const hit = (b: Float32Array, k: number, pad = 0) =>
    !(b[k * 4] > bx1 + pad || b[k * 4 + 2] < bx0 - pad || b[k * 4 + 1] > by1 + pad || b[k * 4 + 3] < by0 - pad);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = th.land;
  ctx.fillRect(0, 0, S, S);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const ringTo = (p: Path2D, pts: Float32Array, o: number, n: number) => {
    let k = o * 2;
    p.moveTo(X(pts[k]), Y(pts[k + 1]));
    for (let e = (o + n) * 2, k2 = k + 2; k2 < e; k2 += 2) p.lineTo(X(pts[k2]), Y(pts[k2 + 1]));
    p.closePath();
  };
  const lineTo = (p: Path2D, pts: Float32Array, o: number, n: number) => {
    let k = o * 2;
    p.moveTo(X(pts[k]), Y(pts[k + 1]));
    for (let e = (o + n) * 2, k2 = k + 2; k2 < e; k2 += 2) p.lineTo(X(pts[k2]), Y(pts[k2 + 1]));
  };

  // ---------------------------------------------------------------- areas --
  const areaPaths = new Map<number, Path2D>();
  const treeAreas: { c: Chunk; k: number }[] = [];
  const waterAreas: { c: Chunk; k: number }[] = [];
  for (const c of chunks) {
    for (let k = 0; k < c.nPolys; k++) {
      if (!hit(c.pbox, k)) continue;
      const kind = c.pk[k];
      let p = areaPaths.get(kind);
      if (!p) areaPaths.set(kind, (p = new Path2D()));
      for (let r = c.po[k], e = c.po[k] + c.pc[k]; r < e; r++) ringTo(p, c.pts, c.ro[r], c.rc[r]);
      if (th.treeDensity[kind] && cssMpp < th.treeMaxMpp && lod === 0) treeAreas.push({ c, k });
      // trees stay out of water and out of mapped open ground (lawns, fields, lots)
      if (CLEAR_KINDS.has(kind)) waterAreas.push({ c, k });
    }
  }
  let grained = false;
  for (const kind of th.areaOrder) {
    const p = areaPaths.get(kind);
    if (!p) continue;
    const col = th.area[kind];
    if (!col) continue;
    if ((kind === PK.water || kind === PK.pool) && th.grain && !grained) { drawGrain(ctx, th, job, S); grained = true; }
    ctx.fillStyle = col;
    ctx.fill(p, 'evenodd');
    if (!col.startsWith('rgba')) {
      // hide anti-aliasing seams where large areas were clipped at chunk borders
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.8;
      ctx.stroke(p);
    }
    if (kind === PK.pitch && cssMpp < 0.9) {
      ctx.strokeStyle = th.pitchLine;
      ctx.lineWidth = Math.max(0.8, 0.25 * inv);
      ctx.stroke(p);
    } else if (kind === PK.parking && cssMpp < 1.5) {
      ctx.strokeStyle = th.parkingEdge;
      ctx.lineWidth = Math.max(0.6, 0.2 * inv);
      ctx.stroke(p);
    } else if (kind === PK.track && cssMpp < 0.9) {
      ctx.strokeStyle = th.trackLine;
      ctx.lineWidth = Math.max(0.6, 0.15 * inv);
      ctx.stroke(p);
    } else if (kind === PK.pool && th.poolEdge && cssMpp < 0.9) {
      ctx.strokeStyle = th.poolEdge;
      ctx.lineWidth = Math.max(0.8, 0.35 * inv);
      ctx.stroke(p);
    }
  }
  // (grain is drawn just before the water layers so water stays clean)
  if (th.grain && !grained) drawGrain(ctx, th, job, S);

  // ---------------------------------------------------------- water lines --
  const water = { stream: new Path2D(), river: new Path2D(), ditch: new Path2D(), edge: new Path2D() };
  let hasWater = false;
  for (const c of chunks) {
    for (let k = 0; k < c.nLines; k++) {
      const kind = c.lk[k];
      if (kind < LK.stream || kind === LK.crosswalk || !hit(c.lbox, k)) continue;
      hasWater = true;
      const p = kind === LK.stream ? water.stream : kind === LK.river ? water.river : kind === LK.ditch ? water.ditch : water.edge;
      lineTo(p, c.pts, c.lo[k], c.lc[k]);
    }
  }
  if (hasWater) {
    ctx.strokeStyle = th.water.line;
    ctx.lineWidth = Math.max(0.7 * pxs, 2.5 * inv); ctx.stroke(water.stream);
    ctx.lineWidth = Math.max(0.5 * pxs, 1.5 * inv); ctx.stroke(water.ditch);
    ctx.lineWidth = Math.max(1.4 * pxs, 9 * inv); ctx.stroke(water.river);
    ctx.strokeStyle = th.water.edge;
    ctx.lineWidth = Math.max(0.6 * pxs, th.water.edgeW * inv); ctx.stroke(water.edge);
  }

  // ---------------------------------------------------------------- trees --
  if (treeAreas.length) drawTrees(ctx, th, treeAreas, waterAreas, chunks, x0, y0, inv, bx0, by0, bx1, by1, cssMpp);

  // ---------------------------------------------------------------- roads --
  interface Group {
    paths: Map<string, Path2D>; rails: Map<string, Path2D>; oneway: { c: Chunk; k: number; key: string }[];
    center: Path2D | null; lanes: Path2D | null; cross: Path2D | null;
  }
  const levels = new Map<number, Group>();
  const group = (l: number) => {
    let g = levels.get(l);
    if (!g) levels.set(l, (g = { paths: new Map(), rails: new Map(), oneway: [], center: null, lanes: null, cross: null }));
    return g;
  };
  const markings = cssMpp < th.marks.maxMpp;
  const beltName = (c: Chunk, k: number) => c.ln[k] >= 0 && /beltline/i.test(c.names[c.ln[k]]);
  for (const c of chunks) {
    for (let k = 0; k < c.nLines; k++) {
      const kind = c.lk[k];
      if ((kind > LK.tram && kind !== LK.crosswalk) || !hit(c.lbox, k)) continue;
      const lvl = c.ll[k] < 0 ? -1 : c.ll[k];
      const fl = c.lf[k];
      if (kind === LK.crosswalk) {
        if (!markings || lvl < 0) continue;
        const g = group(lvl);
        lineTo(g.cross ?? (g.cross = new Path2D()), c.pts, c.lo[k], c.lc[k]);
        continue;
      }
      if (markings && !(fl & LF.link) && lvl >= 0) {
        const g = group(lvl);
        if (kind <= LK.trunk) lineTo(g.lanes ?? (g.lanes = new Path2D()), c.pts, c.lo[k], c.lc[k]);
        else if (kind <= LK.tertiary && !(fl & (LF.oneway | LF.onewayRev))) lineTo(g.center ?? (g.center = new Path2D()), c.pts, c.lo[k], c.lc[k]);
      }
      if (kind >= LK.rail) {
        const key = kind === LK.rail ? 'rail' : kind === LK.metro ? 'metro' : 'tram';
        if (cssMpp > (RAIL as any)[key].maxMpp) continue;
        const g = group(lvl);
        let p = g.rails.get(key);
        if (!p) g.rails.set(key, (p = new Path2D()));
        lineTo(p, c.pts, c.lo[k], c.lc[k]);
        continue;
      }
      let key = roadStyleKey(kind, (fl & LF.link) !== 0, kind === LK.path && beltName(c, k));
      const st = ROAD[key];
      if (cssMpp > st.maxMpp) continue;
      if (fl & LF.construction) key += ':c';
      const g = group(lvl);
      let p = g.paths.get(key);
      if (!p) g.paths.set(key, (p = new Path2D()));
      lineTo(p, c.pts, c.lo[k], c.lc[k]);
      if ((fl & (LF.oneway | LF.onewayRev)) && cssMpp < 0.42 && kind > LK.trunk && kind <= LK.service) g.oneway.push({ c, k, key });
    }
  }

  const roadW = (key: string) => {
    const st = ROAD[key.replace(':c', '')];
    return Math.max(st.w * inv, st.minPx * pxs);
  };
  const casingW = (key: string) => {
    const st = ROAD[key.replace(':c', '')];
    const w = roadW(key);
    const real = st.w * inv;
    // minor roads lose their casing when zoomed far out — keeps the city texture airy
    const major = key.startsWith('motorway') || key.startsWith('trunk') || key === 'primary' || key === 'beltline';
    if (!st.casing || (!major && real < 1.6 * pxs)) return 0;
    return w + 2 * Math.max(st.casingPx * pxs, th.curbM * inv);
  };

  const drawLevel = (lvl: number, g: Group) => {
    const keys = ROAD_ORDER.flatMap((k) => [k, k + ':c']).filter((k) => g.paths.has(k));
    const tunnel = lvl < 0;
    const bridge = lvl > 0;
    ctx.globalAlpha = tunnel ? th.tunnelAlpha : 1;
    // casings
    for (const key of keys) {
      const cw = casingW(key);
      if (!cw) continue;
      const st = ROAD[key.replace(':c', '')];
      ctx.strokeStyle = bridge ? th.bridgeCasing(st.casing!) : st.casing!;
      ctx.lineWidth = cw + (bridge ? 0.8 * pxs : 0);
      ctx.lineCap = bridge || tunnel ? 'butt' : 'round';
      if (tunnel) ctx.setLineDash([3 * pxs, 2 * pxs]);
      if (bridge) {
        ctx.shadowColor = th.bridgeShadow;
        ctx.shadowBlur = (3 + 2 * lvl) * pxs;
        ctx.shadowOffsetX = (1 + lvl) * 0.8 * pxs;
        ctx.shadowOffsetY = (1.5 + lvl) * 1.0 * pxs;
      }
      ctx.stroke(g.paths.get(key)!);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      ctx.setLineDash([]);
    }
    // fills
    for (const key of keys) {
      const st = ROAD[key.replace(':c', '')];
      ctx.strokeStyle = st.fill;
      ctx.lineWidth = roadW(key);
      ctx.lineCap = bridge ? 'butt' : 'round';
      if (st.dash) ctx.setLineDash(st.dash.map((d) => d * pxs));
      if (key.endsWith(':c')) ctx.setLineDash([4 * pxs, 3 * pxs]);
      ctx.stroke(g.paths.get(key)!);
      ctx.setLineDash([]);
    }
    ctx.lineCap = 'round';
    // road markings (close zoom only)
    if (g.center) {
      ctx.strokeStyle = th.marks.center;
      ctx.lineWidth = Math.max(0.6 * pxs, 0.22 * inv);
      ctx.stroke(g.center);
    }
    if (g.lanes) {
      ctx.strokeStyle = th.marks.lane;
      ctx.lineWidth = Math.max(0.6 * pxs, 0.18 * inv);
      ctx.lineCap = 'butt';
      ctx.setLineDash([3 * inv, 6 * inv]);
      ctx.stroke(g.lanes);
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
    }
    if (g.cross) {
      ctx.strokeStyle = th.marks.cross;
      ctx.lineWidth = 3.0 * inv;
      ctx.lineCap = 'butt';
      ctx.setLineDash([0.55 * inv, 0.6 * inv]);
      ctx.stroke(g.cross);
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
    }
    // rail
    for (const [key, p] of g.rails) {
      const st = (RAIL as any)[key];
      const w = Math.max(st.w * inv, st.minPx * pxs);
      if (bridge) {
        ctx.strokeStyle = th.railBridge;
        ctx.lineWidth = w + 3 * pxs;
        ctx.shadowColor = 'rgba(60,40,20,0.25)';
        ctx.shadowBlur = 3 * pxs; ctx.shadowOffsetX = 1.5 * pxs; ctx.shadowOffsetY = 2 * pxs;
        ctx.stroke(p);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      }
      ctx.strokeStyle = st.color;
      ctx.lineWidth = w;
      ctx.stroke(p);
      if (st.tie && w > 1.6 * pxs) {
        ctx.strokeStyle = st.tie;
        ctx.lineWidth = w * 0.45;
        ctx.setLineDash([w * 1.2, w * 1.2]);
        ctx.lineCap = 'butt';
        ctx.stroke(p);
        ctx.setLineDash([]);
        ctx.lineCap = 'round';
      }
    }
    // one-way chevrons
    if (g.oneway.length) drawOneway(ctx, g.oneway, X, Y, roadW, pxs, th.marks.oneway);
    ctx.globalAlpha = 1;
  };

  const lvls = [...levels.keys()].sort((a, b) => a - b);
  for (const l of lvls) if (l < 0 && lod < 2) drawLevel(l, levels.get(l)!);
  if (levels.has(0)) drawLevel(0, levels.get(0)!);

  // ------------------------------------------------------------ buildings --
  if (lod < 2) drawBuildings(ctx, shadow, th, chunks, x0, y0, inv, cssMpp, pxs, hit, S);

  for (const l of lvls) if (l > 0) drawLevel(l, levels.get(l)!);

  // ------------------------------------------------- outside the perimeter --
  if (region) {
    const p = new Path2D();
    p.rect(-10, -10, S + 20, S + 20);
    p.moveTo(X(region[0]), Y(region[1]));
    for (let k = 2; k < region.length; k += 2) p.lineTo(X(region[k]), Y(region[k + 1]));
    p.closePath();
    ctx.fillStyle = th.outside;
    ctx.globalAlpha = th.outsideAlpha;
    ctx.fill(p, 'evenodd');
    ctx.globalAlpha = 1;
    const edge = new Path2D();
    edge.moveTo(X(region[0]), Y(region[1]));
    for (let k = 2; k < region.length; k += 2) edge.lineTo(X(region[k]), Y(region[k + 1]));
    edge.closePath();
    ctx.strokeStyle = th.outsideEdge;
    ctx.lineWidth = 1.2 * pxs;
    ctx.setLineDash([6 * pxs, 4 * pxs]);
    ctx.stroke(edge);
    ctx.setLineDash([]);
  }
}

// --------------------------------------------------------------------------

export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  r = f(r); g = f(g); b = f(b);
  return `rgb(${r},${g},${b})`;
}

function drawOneway(ctx: Ctx, items: { c: Chunk; k: number; key: string }[], X: (x: number) => number, Y: (y: number) => number,
  roadW: (k: string) => number, pxs: number, color: string) {
  const p = new Path2D();
  const spacing = 90 * pxs;
  for (const { c, k, key } of items) {
    const w = roadW(key);
    if (w < 5 * pxs) continue;
    const s = Math.min(w * 0.28, 4.5 * pxs);
    const rev = (c.lf[k] & LF.onewayRev) !== 0;
    const o = c.lo[k], n = c.lc[k];
    let acc = spacing * 0.5;
    for (let i = 0; i < n - 1; i++) {
      const ax = X(c.pts[(o + i) * 2]), ay = Y(c.pts[(o + i) * 2 + 1]);
      const bx = X(c.pts[(o + i + 1) * 2]), by = Y(c.pts[(o + i + 1) * 2 + 1]);
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-6) continue;
      let ux = (bx - ax) / L, uy = (by - ay) / L;
      if (rev) { ux = -ux; uy = -uy; }
      let t = acc;
      while (t < L) {
        const cx = ax + (bx - ax) * (t / L), cy = ay + (by - ay) * (t / L);
        // chevron ›
        p.moveTo(cx - ux * s - uy * s * 0.8, cy - uy * s + ux * s * 0.8);
        p.lineTo(cx, cy);
        p.lineTo(cx - ux * s + uy * s * 0.8, cy - uy * s - ux * s * 0.8);
        t += spacing;
      }
      acc = t - L;
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.1 * pxs;
  ctx.lineCap = 'round';
  ctx.stroke(p);
}

// ------------------------------------------------------------------ grain --
const grainCache = new Map<string, OffscreenCanvas>();
const GRAIN = 128;

/** world-aligned speckle texture over the ground (lawns, lots) — 'real' theme */
function drawGrain(ctx: Ctx, th: Theme, job: TileJob, S: number) {
  const g = th.grain!;
  let cv = grainCache.get(th.id);
  if (!cv) {
    cv = new OffscreenCanvas(GRAIN, GRAIN);
    const c = cv.getContext('2d') as OffscreenCanvasRenderingContext2D;
    for (let i = 0; i < 900; i++) {
      const h = hash2(i, 7919);
      const x = (h & 127), y = ((h >>> 7) & 127), r = 0.5 + ((h >>> 14) & 3) * 0.45;
      c.fillStyle = (h >>> 20) & 1 ? g.dark : g.light;
      c.globalAlpha = 0.35 + ((h >>> 21) & 7) / 14;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    }
    grainCache.set(th.id, cv);
  }
  const pat = ctx.createPattern(cv, 'repeat');
  if (!pat) return;
  const ox = -(((job.tx * TILE_PX - GUTTER) % GRAIN) + GRAIN) % GRAIN;
  const oy = -(((job.ty * TILE_PX - GUTTER) % GRAIN) + GRAIN) % GRAIN;
  try { pat.setTransform(new DOMMatrix([1, 0, 0, 1, ox, oy])); } catch { /* old browsers: unaligned grain */ }
  ctx.globalAlpha = g.alpha;
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, S, S);
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ trees --
const CLEAR_KINDS = new Set<number>([PK.water, PK.pool, PK.grass, PK.pitch, PK.fairway, PK.green, PK.sand, PK.track,
  PK.playground, PK.parking, PK.plaza, PK.stadium, PK.construction]);
const WATER_LINE_HW: Record<number, number> = { [LK.river]: 6, [LK.stream]: 1.8, [LK.ditch]: 1 };

function inPoly(c: Chunk, k: number, x: number, y: number) {
  const b = c.pbox;
  if (x < b[k * 4] || x > b[k * 4 + 2] || y < b[k * 4 + 1] || y > b[k * 4 + 3]) return false;
  const r0 = c.po[k];
  if (!pointInRing(x, y, c.pts, c.ro[r0], c.rc[r0])) return false;
  for (let r = r0 + 1; r < r0 + c.pc[k]; r++) if (pointInRing(x, y, c.pts, c.ro[r], c.rc[r])) return false;
  return true;
}

function nearLine(c: Chunk, k: number, x: number, y: number, d: number) {
  const b = c.lbox;
  if (x < b[k * 4] - d || x > b[k * 4 + 2] + d || y < b[k * 4 + 1] - d || y > b[k * 4 + 3] + d) return false;
  const o = c.lo[k], n = c.lc[k], P = c.pts;
  for (let i = 0; i < n - 1; i++) {
    const ax = P[(o + i) * 2], ay = P[(o + i) * 2 + 1], dx = P[(o + i + 1) * 2] - ax, dy = P[(o + i + 1) * 2 + 1] - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if ((x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2 < d * d) return true;
  }
  return false;
}

function drawTrees(ctx: Ctx, th: Theme, areas: { c: Chunk; k: number }[], water: { c: Chunk; k: number }[], chunks: Chunk[],
  x0: number, y0: number, inv: number, bx0: number, by0: number, bx1: number, by1: number, cssMpp: number) {
  const g = cssMpp < 0.55 ? 8 : 11;
  const tones = th.treeTones;
  // waterways that trees must stay out of (lakes, ponds, pools, rivers, creeks)
  const wLines: { c: Chunk; k: number; hw: number }[] = [];
  for (const c of chunks) for (let k = 0; k < c.nLines; k++) {
    const hw = WATER_LINE_HW[c.lk[k]];
    if (hw && !(c.lbox[k * 4] > bx1 || c.lbox[k * 4 + 2] < bx0 || c.lbox[k * 4 + 1] > by1 || c.lbox[k * 4 + 3] < by0)) wLines.push({ c, k, hw });
  }
  const wet = (x: number, y: number, r: number) => {
    for (const w of water) if (inPoly(w.c, w.k, x, y)) return true;
    for (const l of wLines) if (nearLine(l.c, l.k, x, y, l.hw + r * 0.6)) return true;
    return false;
  };
  const seen = new Set<number>();
  const xs: number[] = [], ys: number[] = [], rs: number[] = [], ts: number[] = [];
  for (const { c, k } of areas) {
    const dens = th.treeDensity[c.pk[k]];
    const b = c.pbox;
    const ax0 = Math.max(b[k * 4], bx0), ay0 = Math.max(b[k * 4 + 1], by0);
    const ax1 = Math.min(b[k * 4 + 2], bx1), ay1 = Math.min(b[k * 4 + 3], by1);
    if (ax0 >= ax1 || ay0 >= ay1) continue;
    for (let gi = Math.floor(ax0 / g); gi * g < ax1; gi++) {
      for (let gj = Math.floor(ay0 / g); gj * g < ay1; gj++) {
        const h = hash2(gi, gj);
        if ((h & 1023) / 1024 > dens) continue;
        const key = (gi & 0xffff) * 65536 + (gj & 0xffff);
        if (seen.has(key)) continue;
        const wx = (gi + 0.15 + ((h >>> 10) & 255) / 255 * 0.7) * g;
        const wy = (gj + 0.15 + ((h >>> 18) & 255) / 255 * 0.7) * g;
        if (!inPoly(c, k, wx, wy)) continue;
        const rw = (2.6 + ((h >>> 26) & 63) / 63 * 2.6) * th.treeSize;
        if (wet(wx, wy, rw)) { seen.add(key); continue; }
        seen.add(key);
        xs.push((wx - x0) * inv); ys.push((wy - y0) * inv);
        rs.push(rw * inv);
        ts.push(h % tones.length);
      }
    }
  }
  if (!xs.length) return;
  const sh = new Path2D();
  for (let i = 0; i < xs.length; i++) {
    const r = rs[i];
    sh.moveTo(xs[i] + r * 0.45 + r, ys[i] + r * 0.6);
    sh.arc(xs[i] + r * 0.45, ys[i] + r * 0.6, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = th.treeShadow;
  ctx.fill(sh);
  const paths = tones.map(() => new Path2D());
  const hi = new Path2D();
  for (let i = 0; i < xs.length; i++) {
    const r = rs[i];
    const p = paths[ts[i]];
    p.moveTo(xs[i] + r, ys[i]);
    p.arc(xs[i], ys[i], r, 0, Math.PI * 2);
    if (r > 2.2) {
      hi.moveTo(xs[i] - r * 0.28 + r * 0.5, ys[i] - r * 0.3);
      hi.arc(xs[i] - r * 0.28, ys[i] - r * 0.3, r * 0.5, 0, Math.PI * 2);
    }
  }
  paths.forEach((p, i) => { ctx.fillStyle = tones[i]; ctx.fill(p); });
  ctx.fillStyle = th.treeHighlight;
  ctx.fill(hi);
}

// -------------------------------------------------------------- buildings --
function drawBuildings(ctx: Ctx, shadow: Ctx, th: Theme, chunks: Chunk[], x0: number, y0: number, inv: number, cssMpp: number, pxs: number,
  hit: (b: Float32Array, k: number, pad?: number) => boolean, S: number) {
  const B = th.building;
  const tones = B.tones.map(() => new Path2D());
  const houses = B.houses ? B.houses.map(() => new Path2D()) : null;
  const tall = new Path2D();
  const all = new Path2D();
  const sh = new Path2D();
  const doShadow = cssMpp < B.shadowMaxMpp;
  const bevel = B.bevel && cssMpp < 1.2;
  // sun from the north-west: shadows fall to the south-east
  const SX = 0.55, SY = 0.83;
  let any = false;
  for (const c of chunks) {
    for (let k = 0; k < c.nBlds; k++) {
      if (!hit(c.bbox, k, 70)) continue;
      any = true;
      const h = c.bh[k];
      const hv = (c.ro[c.bo[k]] * 2654435761) >>> 0;
      const fp = (c.bbox[k * 4 + 2] - c.bbox[k * 4]) * (c.bbox[k * 4 + 3] - c.bbox[k * 4 + 1]);
      const tone = h >= 40 ? tall
        : houses && fp < 420 && h < 14 ? houses[hv % houses.length]
        : tones[hv % tones.length];
      const len = Math.min(h, 90) * B.shadowLen * inv;
      const dx = SX * len, dy = SY * len;
      for (let r = c.bo[k], e = c.bo[k] + c.bc[k]; r < e; r++) {
        const o = c.ro[r], n = c.rc[r];
        const P = c.pts;
        tone.moveTo((P[o * 2] - x0) * inv, (P[o * 2 + 1] - y0) * inv);
        for (let i = 1; i < n; i++) tone.lineTo((P[(o + i) * 2] - x0) * inv, (P[(o + i) * 2 + 1] - y0) * inv);
        tone.closePath();
        if (bevel) {
          all.moveTo((P[o * 2] - x0) * inv, (P[o * 2 + 1] - y0) * inv);
          for (let i = 1; i < n; i++) all.lineTo((P[(o + i) * 2] - x0) * inv, (P[(o + i) * 2 + 1] - y0) * inv);
          all.closePath();
        }
        if (!doShadow || r !== c.bo[k] || len < 0.3) continue;
        // extruded shadow: translated footprint + one quad per edge, all wound the same way
        let area = 0;
        for (let i = 0, j = n - 1; i < n; j = i++) area += P[(o + j) * 2] * P[(o + i) * 2 + 1] - P[(o + i) * 2] * P[(o + j) * 2 + 1];
        const fwd = area > 0;
        const vx = (i: number) => (P[(o + i) * 2] - x0) * inv, vy = (i: number) => (P[(o + i) * 2 + 1] - y0) * inv;
        if (fwd) { sh.moveTo(vx(0) + dx, vy(0) + dy); for (let i = 1; i < n; i++) sh.lineTo(vx(i) + dx, vy(i) + dy); }
        else { sh.moveTo(vx(n - 1) + dx, vy(n - 1) + dy); for (let i = n - 2; i >= 0; i--) sh.lineTo(vx(i) + dx, vy(i) + dy); }
        sh.closePath();
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const ax = vx(j), ay = vy(j), bx = vx(i), by = vy(i);
          const cr = (bx - ax) * dy - (by - ay) * dx;
          if (Math.abs(cr) < 1e-6) continue;
          if (cr > 0) { sh.moveTo(ax, ay); sh.lineTo(bx, by); sh.lineTo(bx + dx, by + dy); sh.lineTo(ax + dx, ay + dy); }
          else { sh.moveTo(ax, ay); sh.lineTo(ax + dx, ay + dy); sh.lineTo(bx + dx, by + dy); sh.lineTo(bx, by); }
          sh.closePath();
        }
      }
    }
  }
  if (!any) return;
  if (doShadow) {
    shadow.setTransform(1, 0, 0, 1, 0, 0);
    shadow.globalCompositeOperation = 'source-over';
    shadow.clearRect(0, 0, S, S);
    shadow.fillStyle = B.shadow;
    shadow.fill(sh, 'nonzero');
    ctx.globalAlpha = cssMpp < 2 ? B.shadowAlpha : B.shadowAlpha * 0.75;
    ctx.drawImage(shadow.canvas, 0, 0);
    ctx.globalAlpha = 1;
  }
  tones.forEach((p, i) => { ctx.fillStyle = B.tones[i]; ctx.fill(p, 'evenodd'); });
  houses?.forEach((p, i) => { ctx.fillStyle = B.houses![i]; ctx.fill(p, 'evenodd'); });
  ctx.fillStyle = B.tall;
  ctx.fill(tall, 'evenodd');
  if (bevel) {
    // sunlit north-west roof edges / shaded south-east edges, clipped inside the roofs
    const w = Math.max(1, 0.6 * inv);
    ctx.save();
    ctx.clip(all, 'evenodd');
    ctx.lineWidth = w * 2;
    ctx.strokeStyle = 'rgba(255,255,245,0.28)';
    ctx.translate(w, w); ctx.stroke(all);
    ctx.translate(-2 * w, -2 * w);
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.stroke(all);
    ctx.restore();
  }
  if (cssMpp < 1.0) {
    ctx.strokeStyle = B.stroke;
    ctx.lineWidth = Math.min(1.0 * pxs, Math.max(0.5, 0.18 * inv));
    for (const p of tones) ctx.stroke(p);
    houses?.forEach((p) => ctx.stroke(p));
    ctx.stroke(tall);
  }
}
