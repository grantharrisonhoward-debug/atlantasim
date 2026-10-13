// Live label layer: drawn every frame in screen space so text stays crisp and
// upright at any zoom or rotation. Candidates are precomputed (build step);
// here we pick visible ones in priority order with collision avoidance.

import { BASE } from '../world/manifest';
import type { View } from './tileCache';
import { THEME_MAP, type Theme } from './style';

export const FONT = '"Inter Variable", Inter, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

interface StreetCand { name: string; rank: number; pts: Float32Array }
interface Global {
  streets: { names: string[]; c: [number, number, number[]][] };
  shields: [string, number, number][];
  areas: { n: string; k: string; x: number; y: number; a: number }[];
  landmarks: { n: string; k: string; x: number; y: number }[];
  hoods: { n: string; r: number; x: number; y: number; s: string }[];
  hoodAreas: { n: string; s: string; rings: number[][] }[];
}

const ABBR: [RegExp, string][] = [
  [/\bNortheast$/, 'NE'], [/\bNorthwest$/, 'NW'], [/\bSoutheast$/, 'SE'], [/\bSouthwest$/, 'SW'],
  [/\bStreet\b/, 'St'], [/\bAvenue\b/, 'Ave'], [/\bRoad\b/, 'Rd'], [/\bDrive\b/, 'Dr'], [/\bBoulevard\b/, 'Blvd'],
  [/\bParkway\b/, 'Pkwy'], [/\bPlace\b/, 'Pl'], [/\bLane\b/, 'Ln'], [/\bCircle\b/, 'Cir'], [/\bCourt\b/, 'Ct'],
  [/\bTerrace\b/, 'Ter'], [/\bHighway\b/, 'Hwy'], [/\bTrail\b/, 'Trl'], [/\bExpressway\b/, 'Expy'],
  [/\bFreeway\b/, 'Fwy'], [/\bSquare\b/, 'Sq'], [/^Martin Luther King Junior\b/, 'MLK Jr'],
  [/\bJunior\b/, 'Jr'], [/\bNorth$/, 'N'], [/\bSouth$/, 'S'], [/\bEast$/, 'E'], [/\bWest$/, 'W'],
];
export function abbreviate(name: string): string {
  let s = name;
  for (const [re, r] of ABBR) s = s.replace(re, r);
  return s;
}

export const LANDMARK_COLOR: Record<string, string> = {
  stadium: '#B5653D', attraction: '#B4507A', park: '#4E8A4A', museum: '#7A5FA8', civic: '#8A6D3B',
  university: '#9A6A2E', food: '#C2603A', tower: '#5F6F86', airport: '#4F7CA8', hospital: '#C2504F', transit: '#5B6CB0',
};

// --- collision grid --------------------------------------------------------
class Collider {
  private cell = 48;
  private g = new Map<number, number[][]>();
  clear() { this.g.clear(); }
  private k(i: number, j: number) { return (i + 1000) * 4096 + (j + 1000); }
  test(b: number[]) {
    const c = this.cell;
    for (let i = Math.floor(b[0] / c); i <= Math.floor(b[2] / c); i++)
      for (let j = Math.floor(b[1] / c); j <= Math.floor(b[3] / c); j++) {
        const l = this.g.get(this.k(i, j));
        if (!l) continue;
        for (const o of l) if (!(o[0] > b[2] || o[2] < b[0] || o[1] > b[3] || o[3] < b[1])) return false;
      }
    return true;
  }
  add(b: number[]) {
    const c = this.cell;
    for (let i = Math.floor(b[0] / c); i <= Math.floor(b[2] / c); i++)
      for (let j = Math.floor(b[1] / c); j <= Math.floor(b[3] / c); j++) {
        const key = this.k(i, j);
        let l = this.g.get(key);
        if (!l) this.g.set(key, (l = []));
        l.push(b);
      }
  }
}

export class LabelLayer {
  global!: Global;
  private streets: StreetCand[] = [];
  private chunkStreets = new Map<string, StreetCand[] | 'loading'>();
  private labelChunks = new Set<string>();
  private chunkSize = 4096;
  private widthCache = new Map<string, number>();
  private col = new Collider();
  /** names the player is following on the route — drawn with emphasis */
  emphasize: Set<string> = new Set();
  theme: Theme = THEME_MAP;

  async load(labelChunks: [number, number][], chunkSize: number) {
    const r = await fetch(`${BASE}world/labels/global.json`);
    this.global = await r.json();
    const gs = this.global.streets;
    this.streets = gs.c.map(([ni, rank, pts]) => ({ name: gs.names[ni], rank, pts: new Float32Array(pts) }));
    this.labelChunks = new Set(labelChunks.map(([i, j]) => `${i}_${j}`));
    const order = (h: { r: number; s: string }) => (h.s === 'locality' ? 0 : h.s === 'microhood' ? 3 : h.r + 0.5);
    const seen: { n: string; x: number; y: number }[] = [];
    this.global.hoods = this.global.hoods
      .slice()
      .sort((a, b) => order(a) - order(b))
      .filter((h) => {
        if (seen.some((o) => o.n === h.n && Math.hypot(o.x - h.x, o.y - h.y) < 1500)) return false;
        seen.push(h);
        return true;
      });
    this.chunkSize = chunkSize;
  }

  private streetsFile: Promise<void> | null = null;
  private ensureChunk(i: number, j: number) {
    const k = `${i}_${j}`;
    if (this.chunkStreets.has(k) || !this.labelChunks.has(k)) return;
    // all minor-street candidates ship in one file; fetch it once, then split by chunk
    if (!this.streetsFile) {
      this.streetsFile = fetch(`${BASE}world/labels/streets.json`).then((r) => r.json()).then((all: Record<string, { names: string[]; c: [number, number, number[]][] }>) => {
        for (const [key, d] of Object.entries(all)) {
          this.chunkStreets.set(key, d.c.map(([ni, rank, pts]) => ({ name: d.names[ni], rank, pts: new Float32Array(pts) })));
        }
      }).catch(() => { this.streetsFile = null; });
    }
  }

  private measure(ctx: CanvasRenderingContext2D, font: string, s: string) {
    const key = font + '|' + s;
    let w = this.widthCache.get(key);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(s).width;
      if (this.widthCache.size > 20000) this.widthCache.clear();
      this.widthCache.set(key, w);
    }
    return w;
  }

  draw(ctx: CanvasRenderingContext2D, v: View, opts: { map?: boolean; reserve?: number[][] } = {}) {
    if (!this.global) return;
    const s = v.scale;
    const cos = Math.cos(v.rot), sin = Math.sin(v.rot);
    const toS = (x: number, y: number): [number, number] => {
      const dx = (x - v.cx) * s, dy = (y - v.cy) * s;
      return [v.w / 2 + dx * cos - dy * sin, v.h / 2 + dx * sin + dy * cos];
    };
    const onScreen = (p: [number, number], m = 40) => p[0] > -m && p[1] > -m && p[0] < v.w + m && p[1] < v.h + m;
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    this.col.clear();
    for (const r of opts.reserve ?? []) this.col.add(r);

    const fade = (sc: number, lo: number, hi: number) => {
      if (sc < lo || sc > hi) return 0;
      const a = Math.min((sc - lo) / (lo * 0.35 + 1e-9), (hi - sc) / (hi * 0.25), 1);
      return Math.max(0, Math.min(1, a));
    };

    // ---- neighbourhoods (priority at mid/far zoom)
    const hoodWin: Record<number, [number, number]> = { 0: [0.016, 1.7], 1: [0.13, 2.4], 2: [0.42, 3.2] };
    const drawHoods = () => {
      for (const h of this.global.hoods) {
        const win = h.s === 'locality' ? [0.016, 1.4] : h.s === 'microhood' ? [3.6, 20] : hoodWin[h.r] ?? hoodWin[2];
        const a = fade(s, win[0], win[1]);
        if (a <= 0.02) continue;
        const p = toS(h.x, h.y);
        if (!onScreen(p, 100)) continue;
        const big = h.r === 0 || h.s === 'locality';
        const size = big ? (s < 0.15 ? 12 : 13.5) : h.r === 1 ? 11.5 : 10.5;
        const font = `${big ? 650 : 600} ${size}px ${FONT}`;
        const text = h.n.toUpperCase();
        const track = size * (big ? 0.2 : 0.16);
        const w = this.measure(ctx, font, text) + track * (text.length - 1);
        const box = [p[0] - w / 2 - 4, p[1] - size * 0.8, p[0] + w / 2 + 4, p[1] + size * 0.8];
        if (!this.col.test(box)) continue;
        this.col.add(box);
        ctx.globalAlpha = a * (opts.map ? 1 : 0.92);
        drawTracked(ctx, text, p[0], p[1], font, track, big ? this.theme.labels.hoodBig : this.theme.labels.hood, this.theme.labels.hoodHalo, 3.2, this, w);
      }
      ctx.globalAlpha = 1;
    };

    // ---- landmarks
    const drawLandmarks = () => {
      if (s < 0.22) return;
      for (const l of this.global.landmarks) {
        const p = toS(l.x, l.y);
        if (!onScreen(p)) continue;
        const font = `600 ${s > 1.2 ? 11.5 : 10.5}px ${FONT}`;
        const w = this.measure(ctx, font, l.n);
        const color = LANDMARK_COLOR[l.k] ?? '#6E6152';
        const box = [p[0] - 7, p[1] - 8, p[0] + 10 + w, p[1] + 8];
        if (!this.col.test(box)) continue;
        this.col.add(box);
        // pin
        ctx.beginPath();
        ctx.arc(p[0], p[1], 4.6, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p[0], p[1], 3.2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.font = font;
        ctx.textAlign = 'left';
        halo(ctx, l.n, p[0] + 8, p[1], this.theme.id === 'real' ? '#FFFFFF' : color, this.theme.id === 'real' ? 'rgba(20,20,20,0.75)' : 'rgba(255,255,255,0.92)', 3);
        ctx.textAlign = 'center';
      }
    };

    // ---- park / water names
    const drawAreas = () => {
      for (const a of this.global.areas) {
        const px2 = a.a * s * s;
        if (px2 < 9000 || (s > 2.5 && px2 < 30000)) continue;
        const p = toS(a.x, a.y);
        if (!onScreen(p)) continue;
        const water = a.k === 'water';
        const font = `italic 500 ${px2 > 200000 ? 12 : 11}px ${FONT}`;
        const w = this.measure(ctx, font, a.n);
        const box = [p[0] - w / 2 - 3, p[1] - 8, p[0] + w / 2 + 3, p[1] + 8];
        if (!this.col.test(box)) continue;
        this.col.add(box);
        ctx.font = font;
        const L = this.theme.labels;
        halo(ctx, a.n, p[0], p[1], water ? L.water : L.park, water ? L.waterHalo : L.parkHalo, 3);
      }
    };

    // ---- highway shields
    const drawShields = () => {
      if (s < 0.025 || s > 3) return;
      const step = s < 0.06 ? 3 : s < 0.12 ? 2 : 1;
      let idx = 0;
      for (const [ref, x, y] of this.global.shields) {
        idx++;
        if (idx % step) continue;
        const p = toS(x, y);
        if (!onScreen(p)) continue;
        const refs = ref.split(';').slice(0, 2).map((r) => r.split(':'));
        const ws = refs.map(([, num]) => shieldWidth(num));
        const w = ws.reduce((a, b) => a + b, 0) + (refs.length - 1) * 3;
        const box = [p[0] - w / 2 - 2, p[1] - 11, p[0] + w / 2 + 2, p[1] + 11];
        if (!this.col.test(box)) continue;
        this.col.add(box);
        let sx = p[0] - w / 2;
        refs.forEach(([net, num], i) => { drawShield(ctx, net, num, sx + ws[i] / 2, p[1]); sx += ws[i] + 3; });
      }
    };

    // ---- street names along paths
    const minScale = [0.6, 0.28, 0.2, 0.32, 0.55, 1.05, 2.2, 4.5];
    const drawStreets = () => {
      const cands: StreetCand[] = [];
      for (const c of this.streets) if (s >= minScale[c.rank]) cands.push(c);
      if (s >= 0.5) {
        const b = { x0: v.cx - v.w / s, y0: v.cy - v.w / s, x1: v.cx + v.w / s, y1: v.cy + v.w / s };
        const cs = this.chunkSize;
        for (let i = Math.floor(b.x0 / cs); i <= Math.floor(b.x1 / cs); i++)
          for (let j = Math.floor(b.y0 / cs); j <= Math.floor(b.y1 / cs); j++) {
            this.ensureChunk(i, j);
            const l = this.chunkStreets.get(`${i}_${j}`);
            if (l && l !== 'loading') for (const c of l) if (s >= minScale[c.rank]) cands.push(c);
          }
      }
      // emphasised (route) streets first, then by rank
      cands.sort((a, b) => (this.emphasize.has(b.name) ? 1 : 0) - (this.emphasize.has(a.name) ? 1 : 0) || a.rank - b.rank);
      let drawn = 0;
      for (const c of cands) {
        if (drawn > 140) break;
        if (this.drawPathLabel(ctx, c, toS, v, s)) drawn++;
      }
    };

    if (s < 0.9) { drawHoods(); drawShields(); drawLandmarks(); drawAreas(); drawStreets(); }
    else { drawShields(); drawLandmarks(); drawStreets(); drawAreas(); drawHoods(); }
    ctx.globalAlpha = 1;
  }

  private drawPathLabel(ctx: CanvasRenderingContext2D, c: StreetCand, toS: (x: number, y: number) => [number, number], v: View, s: number): boolean {
    const P = c.pts;
    const n = P.length / 2;
    if (n < 2) return false;
    // quick reject: middle point off screen
    const mid = toS(P[(n >> 1) * 2], P[(n >> 1) * 2 + 1]);
    if (mid[0] < -200 || mid[1] < -200 || mid[0] > v.w + 200 || mid[1] > v.h + 200) return false;
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) pts.push(toS(P[i * 2], P[i * 2 + 1]));
    // reading direction: left → right
    if (pts[n - 1][0] < pts[0][0]) pts.reverse();
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[n - 1];
    const major = c.rank <= 2;
    const emph = this.emphasize.has(c.name);
    const size = c.rank <= 1 ? 12.5 : c.rank <= 3 ? 12 : c.rank <= 5 ? 11.2 : 10.5;
    const font = `${major || emph ? 620 : 520} ${size}px ${FONT}`;
    const text = abbreviate(c.name);
    const tw = this.measure(ctx, font, text);
    if (tw + 16 > total) return false;
    const start = (total - tw) / 2;
    const at = (d: number): [number, number, number] => {
      let i = 0;
      while (i < n - 2 && cum[i + 1] < d) i++;
      const L = cum[i + 1] - cum[i] || 1;
      const t = (d - cum[i]) / L;
      const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
      const y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
      return [x, y, Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0])];
    };
    // lay out glyphs
    const glyphs: { ch: string; x: number; y: number; a: number }[] = [];
    let d = start, lastA: number | null = null;
    ctx.font = font;
    for (const ch of text) {
      const cw = this.measure(ctx, font, ch);
      const [x, y, a] = at(d + cw / 2);
      if (lastA !== null) {
        let da = a - lastA;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        if (Math.abs(da) > 0.5) return false;
      }
      lastA = a;
      glyphs.push({ ch, x, y, a });
      d += cw;
    }
    // collision boxes along the path
    const boxes: number[][] = [];
    const r = size * 0.62;
    for (let k = 0; k < glyphs.length; k += 2) {
      const g = glyphs[k];
      boxes.push([g.x - r, g.y - r, g.x + r, g.y + r]);
    }
    const lastG = glyphs[glyphs.length - 1];
    boxes.push([lastG.x - r, lastG.y - r, lastG.x + r, lastG.y + r]);
    for (const b of boxes) if (!this.col.test(b)) return false;
    // pad boxes a little so neighbouring labels breathe
    for (const b of boxes) this.col.add([b[0] - 6, b[1] - 3, b[2] + 6, b[3] + 3]);
    const L = this.theme.labels;
    const fill = emph ? (this.theme.id === 'real' ? '#BFD4FF' : '#2F5FD0') : major ? L.streetMajor : L.street;
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = L.halo;
    ctx.fillStyle = fill;
    for (const g of glyphs) {
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      ctx.translate(g.x, g.y);
      ctx.rotate(g.a);
      ctx.strokeText(g.ch, 0, 0.5);
    }
    for (const g of glyphs) {
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      ctx.translate(g.x, g.y);
      ctx.rotate(g.a);
      ctx.fillText(g.ch, 0, 0.5);
    }
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    return true;
  }

  measureFor(ctx: CanvasRenderingContext2D, font: string, s: string) { return this.measure(ctx, font, s); }
}

function halo(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, stroke: string, w: number) {
  ctx.lineWidth = w;
  ctx.strokeStyle = stroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function drawTracked(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, font: string, track: number,
  fill: string, stroke: string, sw: number, L: LabelLayer, total: number) {
  ctx.font = font;
  let x = cx - total / 2;
  const xs: number[] = [];
  for (const ch of text) {
    const w = L.measureFor(ctx, font, ch);
    xs.push(x + w / 2);
    x += w + track;
  }
  ctx.lineWidth = sw;
  ctx.strokeStyle = stroke;
  let i = 0;
  for (const ch of text) ctx.strokeText(ch, xs[i++], cy);
  ctx.fillStyle = fill;
  i = 0;
  for (const ch of text) ctx.fillText(ch, xs[i++], cy);
}

export function shieldWidth(num: string) { return num.length >= 3 ? 30 : 24; }

export function drawShield(ctx: CanvasRenderingContext2D, net: string, num: string, x: number, y: number, scale = 1) {
  const w = shieldWidth(num) * scale, h = 22 * scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = 'rgba(40,30,20,0.25)';
  ctx.shadowBlur = 3 * scale;
  ctx.shadowOffsetY = 1 * scale;
  if (net === 'I') {
    // interstate: blue shield with red crown
    const p = new Path2D();
    p.moveTo(-w / 2, -h / 2 + 2 * scale);
    p.quadraticCurveTo(0, -h / 2 - 2 * scale, w / 2, -h / 2 + 2 * scale);
    p.lineTo(w / 2, 0);
    p.quadraticCurveTo(w / 2, h / 2 - 1 * scale, 0, h / 2 + 1 * scale);
    p.quadraticCurveTo(-w / 2, h / 2 - 1 * scale, -w / 2, 0);
    p.closePath();
    ctx.fillStyle = '#FFFFFF';
    ctx.fill(p);
    ctx.shadowColor = 'transparent';
    ctx.save();
    ctx.clip(p);
    ctx.fillStyle = '#2B57A8';
    ctx.fillRect(-w / 2 + 1.4 * scale, -h / 2 + 4.6 * scale, w - 2.8 * scale, h);
    ctx.fillStyle = '#C8352F';
    ctx.fillRect(-w / 2, -h / 2 - 3 * scale, w, 7 * scale);
    ctx.restore();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `700 ${num.length >= 3 ? 9.5 * scale : 10.5 * scale}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(num, 0, 2.6 * scale);
  } else if (net === 'US') {
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#2B2B2B';
    ctx.lineWidth = 1.4 * scale;
    const p = new Path2D();
    p.moveTo(-w / 2 + 2, -h / 2 + 1);
    p.lineTo(w / 2 - 2, -h / 2 + 1);
    p.quadraticCurveTo(w / 2 + 1, 0, w / 2 - 3, h / 2 - 2);
    p.quadraticCurveTo(0, h / 2 + 2, -w / 2 + 3, h / 2 - 2);
    p.quadraticCurveTo(-w / 2 - 1, 0, -w / 2 + 2, -h / 2 + 1);
    p.closePath();
    ctx.fill(p);
    ctx.shadowColor = 'transparent';
    ctx.stroke(p);
    ctx.fillStyle = '#1E1E1E';
    ctx.font = `700 ${10 * scale}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(num, 0, 0.5 * scale);
  } else {
    // Georgia state route: white rounded square, black border
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#2B2B2B';
    ctx.lineWidth = 1.3 * scale;
    roundRect(ctx, -w / 2, -h / 2 + 1, w, h - 2, 4 * scale);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();
    ctx.fillStyle = '#1E1E1E';
    ctx.font = `700 ${10 * scale}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(num, 0, 0.5 * scale);
  }
  ctx.restore();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
