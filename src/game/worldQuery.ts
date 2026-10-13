// Main-thread spatial queries against full-detail (L0) chunks around the car:
// which road am I on, what surface is under me, building collisions.

import { decodeChunk, chunkUrl, type Chunk } from '../world/chunk';
import { cachedArrayBuffer } from '../world/fetchCache';
import { LK, PK, isDrivable } from '../world/codes';
import { BASE, distToRing, pointInRing, type Manifest } from '../world/manifest';
import { ROAD, roadStyleKey } from '../render/style';
import { LF } from '../world/codes';

export interface RoadHit {
  chunk: Chunk;
  line: number;
  kind: number;
  flags: number;
  level: number;
  name: string | null;
  ref: string | null;
  dist: number;
  halfWidth: number;
  dirx: number; diry: number; // unit tangent along geometry
  px: number; py: number;     // nearest point
}

export type Surface = 'road' | 'paved' | 'offroad';

export class WorldQuery {
  private size: number;
  private have: Set<string>;
  private cache = new Map<string, Chunk>();
  private loading = new Set<string>();
  constructor(m: Manifest) {
    this.size = m.lods['0'].size;
    this.have = new Set(m.lods['0'].chunks.map(([i, j]) => `${i}_${j}`));
  }

  /** ensure the 3×3 chunks around (x,y) are loaded (async, fire-and-forget) */
  prefetch(x: number, y: number, radius = 700) {
    const s = this.size;
    for (let i = Math.floor((x - radius) / s); i <= Math.floor((x + radius) / s); i++)
      for (let j = Math.floor((y - radius) / s); j <= Math.floor((y + radius) / s); j++) this.load(i, j);
    if (this.cache.size > 40) {
      const ci = Math.floor(x / s), cj = Math.floor(y / s);
      for (const [k, c] of this.cache) if (Math.abs(c.i - ci) > 3 || Math.abs(c.j - cj) > 3) this.cache.delete(k);
    }
  }

  async waitFor(x: number, y: number) {
    this.prefetch(x, y);
    const s = this.size;
    const key = `${Math.floor(x / s)}_${Math.floor(y / s)}`;
    for (let n = 0; n < 200 && this.have.has(key) && !this.cache.has(key); n++) await new Promise((r) => setTimeout(r, 25));
  }

  private load(i: number, j: number) {
    const k = `${i}_${j}`;
    if (this.cache.has(k) || this.loading.has(k) || !this.have.has(k)) return;
    this.loading.add(k);
    cachedArrayBuffer(chunkUrl(BASE, 0, i, j))
      .then((b) => this.cache.set(k, decodeChunk(b, k)))
      .catch((e) => console.warn('chunk', k, e))
      .finally(() => this.loading.delete(k));
  }

  private near(x: number, y: number, r: number): Chunk[] {
    const s = this.size, out: Chunk[] = [];
    for (let i = Math.floor((x - r - 400) / s); i <= Math.floor((x + r + 400) / s); i++)
      for (let j = Math.floor((y - r - 400) / s); j <= Math.floor((y + r + 400) / s); j++) {
        const c = this.cache.get(`${i}_${j}`);
        if (c) out.push(c);
      }
    return out;
  }

  /**
   * Nearest drivable road. `prefer` biases toward the road we were already on
   * (so bridges/underpasses don't flicker) and toward roads aligned with `heading`.
   */
  nearestRoad(x: number, y: number, maxDist = 30, prefer?: { name: string | null; level: number } | null, heading?: number, includePaths = false): RoadHit | null {
    let best: RoadHit | null = null;
    let bestScore = Infinity;
    const hx = heading !== undefined ? Math.cos(heading) : 0, hy = heading !== undefined ? Math.sin(heading) : 0;
    for (const c of this.near(x, y, maxDist)) {
      const b = c.lbox;
      for (let k = 0; k < c.nLines; k++) {
        const kind = c.lk[k];
        if (!(isDrivable(kind) || (includePaths && (kind === LK.pedestrian || kind === LK.path)))) continue;
        if (b[k * 4] > x + maxDist || b[k * 4 + 2] < x - maxDist || b[k * 4 + 1] > y + maxDist || b[k * 4 + 3] < y - maxDist) continue;
        const o = c.lo[k], n = c.lc[k], P = c.pts;
        for (let i = 0; i < n - 1; i++) {
          const ax = P[(o + i) * 2], ay = P[(o + i) * 2 + 1], bx = P[(o + i + 1) * 2], by = P[(o + i + 1) * 2 + 1];
          const dx = bx - ax, dy = by - ay;
          const L2 = dx * dx + dy * dy;
          if (L2 < 1e-9) continue;
          let t = ((x - ax) * dx + (y - ay) * dy) / L2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + t * dx, py = ay + t * dy;
          const d = Math.hypot(x - px, y - py);
          if (d > maxDist) continue;
          const st = ROAD[roadStyleKey(kind, (c.lf[k] & LF.link) !== 0, false)];
          const hw = st.w / 2;
          const L = Math.sqrt(L2);
          let score = Math.max(0, d - hw);
          const name = c.ln[k] >= 0 ? c.names[c.ln[k]] : null;
          if (prefer) {
            // switching level is only easy when it's the same street (bridge approach)
            if (prefer.level !== c.ll[k]) score += prefer.name && prefer.name === name ? 1 : 6;
            if (prefer.name && prefer.name === name) score -= 2;
          }
          if (heading !== undefined) score += (1 - Math.abs((dx * hx + dy * hy) / L)) * 3;
          if (kind >= LK.serviceMinor) score += 1.5;
          if (score < bestScore) {
            bestScore = score;
            best = {
              chunk: c, line: k, kind, flags: c.lf[k], level: c.ll[k], name,
              ref: c.lr[k] >= 0 ? c.refs[c.lr[k]] : null, dist: d, halfWidth: hw,
              dirx: dx / L, diry: dy / L, px, py,
            };
          }
        }
      }
    }
    return best;
  }

  surfaceAt(x: number, y: number, road: RoadHit | null): Surface {
    if (road && road.dist <= road.halfWidth + 3) return 'road';
    for (const c of this.near(x, y, 5)) {
      for (let k = 0; k < c.nPolys; k++) {
        const kind = c.pk[k];
        if (kind !== PK.parking && kind !== PK.plaza) continue;
        const b = c.pbox;
        if (b[k * 4] > x || b[k * 4 + 2] < x || b[k * 4 + 1] > y || b[k * 4 + 3] < y) continue;
        const r = c.po[k];
        if (pointInRing(x, y, c.pts, c.ro[r], c.rc[r])) return 'paved';
      }
    }
    // paths, sidewalks and service lanes count as paved
    const p = this.nearestRoad(x, y, 4, null, undefined, true);
    if (p && p.dist < p.halfWidth + 1.5) return 'paved';
    return 'offroad';
  }

  /**
   * Push a circle out of solid buildings. Returns the total correction vector
   * and the averaged contact normal (or null if no contact).
   */
  collideCircle(x: number, y: number, r: number): { dx: number; dy: number; nx: number; ny: number } | null {
    let tx = 0, ty = 0, cnt = 0;
    for (const c of this.near(x, y, r)) {
      const b = c.bbox;
      for (let k = 0; k < c.nBlds; k++) {
        if (!(c.bf[k] & 1)) continue;
        if (b[k * 4] > x + r || b[k * 4 + 2] < x - r || b[k * 4 + 1] > y + r || b[k * 4 + 3] < y - r) continue;
        const ri = c.bo[k];
        const o = c.ro[ri], n = c.rc[ri];
        const ring = c.pts.subarray(o * 2, (o + n) * 2);
        const inside = pointInRing(x, y, ring);
        const { d, nx, ny } = distToRing(x, y, ring);
        if (!inside && d >= r) continue;
        let vx = x - nx, vy = y - ny;
        const L = Math.hypot(vx, vy) || 1e-6;
        vx /= L; vy /= L;
        let push: number;
        if (inside) { vx = -vx; vy = -vy; push = d + r; } else push = r - d;
        tx += vx * push; ty += vy * push; cnt++;
      }
    }
    if (!cnt) return null;
    const L = Math.hypot(tx, ty) || 1;
    return { dx: tx, dy: ty, nx: tx / L, ny: ty / L };
  }

  /** road/rail pieces above `level` near (x,y) — redrawn over the car so it passes under overpasses */
  linesAbove(x: number, y: number, r: number, level: number): { c: Chunk; k: number }[] {
    const out: { c: Chunk; k: number }[] = [];
    for (const c of this.near(x, y, r)) {
      const b = c.lbox;
      for (let k = 0; k < c.nLines; k++) {
        if (c.ll[k] <= level || c.lk[k] > LK.tram || c.lk[k] === LK.sidewalk) continue;
        if (b[k * 4] > x + r || b[k * 4 + 2] < x - r || b[k * 4 + 1] > y + r || b[k * 4 + 3] < y - r) continue;
        out.push({ c, k });
      }
    }
    return out;
  }

  get loadedChunks() { return this.cache.size; }
}

// ---------------------------------------------------------------------------
// Neighbourhood lookup (polygons first, then nearest labelled point)

export interface Hood { n: string; r: number; x: number; y: number; s: string }
export interface HoodArea { n: string; s: string; rings: number[][] }

export function neighborhoodAt(x: number, y: number, hoods: Hood[], areas: HoodArea[]): { hood: string | null; city: string | null } {
  let city: string | null = null;
  let hood: string | null = null;
  let hoodRank = 9;
  for (const a of areas) {
    for (const ring of a.rings) {
      if (!pointInRing(x, y, ring)) continue;
      if (a.s === 'locality') { if (!city) city = a.n; }
      else if (a.s === 'microhood') continue;
      else {
        const rank = a.s === 'microhood' ? 2 : a.s === 'macrohood' ? 0 : 1;
        if (rank >= hoodRank || !hood) { hood = a.n; hoodRank = rank; }
      }
    }
  }
  if (!hood) {
    let bd = Infinity;
    for (const h of hoods) {
      if (h.s === 'locality' || h.s === 'microhood') continue;
      const d = Math.hypot(h.x - x, h.y - y) * (h.r === 0 ? 1.35 : h.r === 2 ? 0.9 : 1);
      if (d < bd) { bd = d; hood = h.n; }
    }
    if (bd > 1500) hood = null;
  }
  if (!city) {
    let bd = Infinity, n: string | null = null;
    for (const h of hoods) if (h.s === 'locality') { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; n = h.n; } }
    if (n && bd < 1800) city = n;
  }
  return { hood, city };
}
