// World manifest + projection helpers.

export interface Manifest {
  version: number;
  generated: string;
  source: string;
  projection: { proj: 'tmerc'; lat0: number; lon0: number; k: number; ellps: string; yFlip: boolean };
  lods: Record<string, { size: number; unit: number; chunks: [number, number][] }>;
  labelChunks: [number, number][];
  labelChunkSize: number;
  perimeter: number[];
  regionBuffer: number;
  bounds: [number, number, number, number];
  spawn: { x: number; y: number; heading: number };
}

// absolute so that workers (whose scripts live under assets/) resolve data paths correctly
export const BASE: string = typeof document !== 'undefined'
  ? new URL(import.meta.env.BASE_URL, document.baseURI).href
  : import.meta.env.BASE_URL;

export async function loadManifest(): Promise<Manifest> {
  const r = await fetch(`${BASE}world/manifest.json`);
  if (!r.ok) throw new Error('Could not load world/manifest.json — run `npm run data:build` first.');
  return r.json();
}

// --- Transverse Mercator (WGS84) — Snyder, "Map Projections: A Working Manual" §8 ---
const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const D2R = Math.PI / 180;

function meridianArc(phi: number) {
  const e4 = E2 * E2, e6 = e4 * E2;
  return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
    - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
    - (35 * e6 / 3072) * Math.sin(6 * phi));
}

export class Projection {
  private M0: number;
  constructor(lat0: number, private lon0: number) {
    this.M0 = meridianArc(lat0 * D2R);
  }

  /** lon/lat (deg) → game metres (x east, y south) */
  forward(lon: number, lat: number): [number, number] {
    const phi = lat * D2R, lam = (lon - this.lon0) * D2R;
    const N = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
    const T = Math.tan(phi) ** 2, C = EP2 * Math.cos(phi) ** 2;
    const Aa = lam * Math.cos(phi);
    const M = meridianArc(phi);
    const x = N * (Aa + (1 - T + C) * Aa ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120);
    const y = M - this.M0 + N * Math.tan(phi) * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720);
    return [x, -y];
  }

  /** game metres → [lon, lat] (deg) */
  inverse(gx: number, gy: number): [number, number] {
    const x = gx, y = -gy;
    const M = this.M0 + y;
    const mu = M / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256));
    const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
    const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
      + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
    const C1 = EP2 * Math.cos(phi1) ** 2, T1 = Math.tan(phi1) ** 2;
    const N1 = A / Math.sqrt(1 - E2 * Math.sin(phi1) ** 2);
    const R1 = A * (1 - E2) / Math.pow(1 - E2 * Math.sin(phi1) ** 2, 1.5);
    const D = x / N1;
    const phi = phi1 - (N1 * Math.tan(phi1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
    const lam = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(phi1);
    return [this.lon0 + lam / D2R, phi / D2R];
  }
}

// --- polygon helpers ---------------------------------------------------------
export function pointInRing(x: number, y: number, ring: ArrayLike<number>, o = 0, n = ring.length / 2): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[(o + i) * 2], yi = ring[(o + i) * 2 + 1];
    const xj = ring[(o + j) * 2], yj = ring[(o + j) * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** distance from point to a closed ring (flat xy array) */
export function distToRing(x: number, y: number, ring: ArrayLike<number>): { d: number; nx: number; ny: number } {
  let best = Infinity, bx = 0, by = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = ring[j * 2], ay = ring[j * 2 + 1], cx = ring[i * 2], cy = ring[i * 2 + 1];
    const dx = cx - ax, dy = cy - ay;
    const L = dx * dx + dy * dy;
    let t = L > 0 ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx, py = ay + t * dy;
    const d = (x - px) ** 2 + (y - py) ** 2;
    if (d < best) { best = d; bx = px; by = py; }
  }
  return { d: Math.sqrt(best), nx: bx, ny: by };
}
