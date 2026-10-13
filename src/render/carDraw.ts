// Car sprite (vector), skid marks, tyre smoke and route overlay.

import type { Car } from '../game/car';
import type { BodyStyle } from '../game/vehicles';
import type { Route } from '../nav/graph';
import type { Chunk } from '../world/chunk';
import { LF, LK } from '../world/codes';
import { THEME_MAP, roadStyleKey, type Theme } from './style';

export const CAR_COLORS: Record<string, { body: string; dark: string; light: string }> = {
  peach: { body: '#E8775A', dark: '#B9533B', light: '#F6A68D' },
  midnight: { body: '#2F3D5C', dark: '#1D2740', light: '#53648C' },
  sage: { body: '#7FA37A', dark: '#58775A', light: '#A9C6A3' },
  cream: { body: '#EFE6D2', dark: '#C8BCA2', light: '#FFFBF0' },
  cherry: { body: '#C8343F', dark: '#8E1F28', light: '#EA6B72' },
};

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

interface BodySpec {
  r: number;                 // corner radius (× width)
  ws: [number, number];      // windshield front/back (× length, + = forward)
  rw: [number, number];      // rear window front/back
  roof: [number, number];    // roof back/front
  wheels: [number, number];  // front/rear axle position
  stripes?: boolean; scoop?: boolean; rack?: boolean; vents?: boolean; cargo?: boolean;
}

const BODIES: Record<BodyStyle, BodySpec> = {
  sedan: { r: 0.34, ws: [0.27, 0.09], rw: [-0.24, -0.36], roof: [-0.24, 0.09], wheels: [0.31, -0.3] },
  hatch: { r: 0.38, ws: [0.23, 0.06], rw: [-0.38, -0.45], roof: [-0.38, 0.06], wheels: [0.32, -0.32] },
  sport: { r: 0.42, ws: [0.12, -0.03], rw: [-0.2, -0.31], roof: [-0.2, -0.03], wheels: [0.3, -0.3], vents: true },
  muscle: { r: 0.2, ws: [0.16, 0.02], rw: [-0.17, -0.28], roof: [-0.17, 0.02], wheels: [0.31, -0.31], stripes: true, scoop: true },
  suv: { r: 0.2, ws: [0.29, 0.17], rw: [-0.43, -0.48], roof: [-0.43, 0.17], wheels: [0.32, -0.32], rack: true },
  truck: { r: 0.12, ws: [0.47, 0.39], rw: [0.24, 0.22], roof: [0.24, 0.39], wheels: [0.36, -0.3], cargo: true },
};

/** draw the car in world space (ctx already has the view transform) */
export function drawCar(ctx: CanvasRenderingContext2D, car: Car, colorKey: string, viewRot: number, pxPerM: number, body: BodyStyle = 'sedan') {
  const L = car.length, W = car.width;
  const col = CAR_COLORS[colorKey] ?? CAR_COLORS.peach;
  const B = BODIES[body];
  // soft ground shadow (sun from the north-west, fixed in world space)
  ctx.save();
  ctx.translate(car.x + L * 0.07, car.y + L * 0.11);
  ctx.rotate(car.heading);
  ctx.fillStyle = 'rgba(40,30,20,0.28)';
  ctx.shadowColor = 'rgba(40,30,20,0.35)';
  ctx.shadowBlur = Math.max(2, L * 0.12 * pxPerM);
  rr(ctx, -L / 2, -W / 2, L, W, W * B.r);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.heading);
  // wheels
  ctx.fillStyle = '#26221E';
  const wl = L * (B.cargo ? 0.12 : 0.17), ww = W * 0.17;
  const axles = B.cargo ? [L * B.wheels[0], L * B.wheels[1], L * (B.wheels[1] - 0.13)] : [L * B.wheels[0], L * B.wheels[1]];
  for (const fx of axles) for (const sy of [-1, 1]) {
    ctx.save();
    ctx.translate(fx, sy * (W / 2 - ww * 0.35));
    if (fx === axles[0]) ctx.rotate(car.steerAngle);
    rr(ctx, -wl / 2, -ww / 2, wl, ww, ww * 0.3);
    ctx.fill();
    ctx.restore();
  }
  const paint = (x0: number, x1: number, wf: number) => {
    const g = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
    g.addColorStop(0, col.dark); g.addColorStop(0.18, col.body); g.addColorStop(0.5, col.light);
    g.addColorStop(0.82, col.body); g.addColorStop(1, col.dark);
    ctx.fillStyle = g;
    rr(ctx, x0, -W * wf / 2, x1 - x0, W * wf, W * B.r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,25,15,0.35)';
    ctx.lineWidth = Math.max(0.04, 0.6 / pxPerM);
    ctx.stroke();
  };
  if (B.cargo) {
    // cab in paint colour, white cargo box behind
    paint(L * 0.2, L / 2, 0.9);
    ctx.fillStyle = '#ECE9E2';
    rr(ctx, -L / 2, -W / 2, L * 0.69, W, W * 0.06);
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,35,30,0.35)';
    ctx.lineWidth = Math.max(0.05, 0.6 / pxPerM);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(40,35,30,0.12)';
    for (let i = 1; i < 7; i++) {
      const x = -L / 2 + (L * 0.69 * i) / 7;
      ctx.beginPath(); ctx.moveTo(x, -W / 2 + 0.1); ctx.lineTo(x, W / 2 - 0.1); ctx.stroke();
    }
  } else paint(-L / 2, L / 2, 0.92);
  // glass
  ctx.fillStyle = '#2C3442';
  ctx.beginPath();
  ctx.moveTo(L * B.ws[0], -W * 0.36); ctx.lineTo(L * B.ws[0], W * 0.36);
  ctx.lineTo(L * B.ws[1], W * 0.33); ctx.lineTo(L * B.ws[1], -W * 0.33); ctx.closePath();
  ctx.fill();
  if (!B.cargo) {
    ctx.beginPath();
    ctx.moveTo(L * B.rw[1], -W * 0.33); ctx.lineTo(L * B.rw[1], W * 0.33);
    ctx.lineTo(L * B.rw[0], W * 0.31); ctx.lineTo(L * B.rw[0], -W * 0.31); ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(L * (B.ws[0] - 0.02), -W * 0.3); ctx.lineTo(L * (B.ws[0] - 0.02), -W * 0.05);
  ctx.lineTo(L * (B.ws[1] + 0.03), -W * 0.2); ctx.lineTo(L * (B.ws[1] + 0.03), -W * 0.3);
  ctx.closePath(); ctx.fill();
  // roof
  const rg = ctx.createLinearGradient(0, -W * 0.3, 0, W * 0.3);
  rg.addColorStop(0, col.body); rg.addColorStop(0.5, col.light); rg.addColorStop(1, col.body);
  ctx.fillStyle = rg;
  rr(ctx, L * B.roof[0], -W * 0.31, L * (B.roof[1] - B.roof[0]), W * 0.62, W * 0.12);
  ctx.fill();
  if (B.rack) {
    ctx.strokeStyle = 'rgba(30,30,30,0.45)';
    ctx.lineWidth = Math.max(0.05, W * 0.035);
    for (const sy of [-0.24, 0.24]) { ctx.beginPath(); ctx.moveTo(L * B.roof[0] + 0.15, W * sy); ctx.lineTo(L * B.roof[1] - 0.15, W * sy); ctx.stroke(); }
  }
  if (B.stripes) {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const sy of [-0.13, 0.05]) ctx.fillRect(-L / 2, W * sy, L, W * 0.08);
  }
  if (B.scoop) {
    ctx.fillStyle = col.dark;
    rr(ctx, L * 0.26, -W * 0.12, L * 0.12, W * 0.24, W * 0.05); ctx.fill();
  }
  if (B.vents) {
    ctx.fillStyle = 'rgba(20,20,25,0.55)';
    for (const sy of [-1, 1]) { rr(ctx, -L * 0.08, sy * W * 0.4 - W * 0.04, L * 0.1, W * 0.08, 0.04); ctx.fill(); }
  }
  // mirrors
  ctx.fillStyle = col.dark;
  const mx = B.cargo ? L * 0.37 : L * (B.ws[1] + 0.03);
  rr(ctx, mx, -W * 0.56, L * 0.05, W * 0.1, 0.05); ctx.fill();
  rr(ctx, mx, W * 0.46, L * 0.05, W * 0.1, 0.05); ctx.fill();
  // headlights
  ctx.fillStyle = '#FFF7DC';
  rr(ctx, L * 0.455, -W * 0.38, L * 0.04, W * 0.2, 0.06); ctx.fill();
  rr(ctx, L * 0.455, W * 0.18, L * 0.04, W * 0.2, 0.06); ctx.fill();
  // tail lights
  const brake = car.braking || car.handbrake;
  ctx.fillStyle = brake ? '#FF3B30' : '#A3262A';
  if (brake) { ctx.shadowColor = 'rgba(255,40,30,0.9)'; ctx.shadowBlur = Math.max(4, 6 * pxPerM * 0.25); }
  rr(ctx, -L * 0.495, -W * 0.38, L * 0.035, W * 0.2, 0.05); ctx.fill();
  rr(ctx, -L * 0.495, W * 0.18, L * 0.035, W * 0.2, 0.05); ctx.fill();
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
  if (car.reversing) {
    ctx.fillStyle = '#FFFFFF';
    rr(ctx, -L * 0.495, -W * 0.12, L * 0.03, W * 0.08, 0.04); ctx.fill();
    rr(ctx, -L * 0.495, W * 0.04, L * 0.03, W * 0.08, 0.04); ctx.fill();
  }
  ctx.restore();
  void viewRot;
}

/** navigation puck for far zoom levels (screen space) */
export function drawPuck(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, 13 * size, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(232,119,90,0.18)';
  ctx.fill();
  ctx.rotate(angle);
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.moveTo(9 * size, 0);
  ctx.lineTo(-6 * size, -6.5 * size);
  ctx.lineTo(-3 * size, 0);
  ctx.lineTo(-6 * size, 6.5 * size);
  ctx.closePath();
  ctx.fillStyle = '#E8775A';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------- skid marks --
export class Skids {
  private n = 0;
  private max = 6000;
  private seg = new Float32Array(this.max * 5);
  private last: ([number, number] | null)[] = [null, null];

  add(car: Car, time: number, active: boolean, strength: number) {
    const fx = Math.cos(car.heading), fy = Math.sin(car.heading);
    const rx = -fy, ry = fx;
    const back = -car.length * 0.3, side = car.width * 0.38;
    const wheels: [number, number][] = [
      [car.x + fx * back + rx * side, car.y + fy * back + ry * side],
      [car.x + fx * back - rx * side, car.y + fy * back - ry * side],
    ];
    for (let w = 0; w < 2; w++) {
      const p = wheels[w];
      if (!active) { this.last[w] = null; continue; }
      const l = this.last[w];
      if (l && Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.35) {
        const i = (this.n++ % this.max) * 5;
        this.seg[i] = l[0]; this.seg[i + 1] = l[1]; this.seg[i + 2] = p[0]; this.seg[i + 3] = p[1];
        this.seg[i + 4] = time - (1 - Math.min(1, strength)) * 12;
        this.last[w] = p;
      } else if (!l) this.last[w] = p;
    }
  }

  draw(ctx: CanvasRenderingContext2D, time: number, width: number, bounds: { x0: number; y0: number; x1: number; y1: number }) {
    const count = Math.min(this.n, this.max);
    if (!count) return;
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    const buckets = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    for (let k = 0; k < count; k++) {
      const i = k * 5;
      const age = time - this.seg[i + 4];
      if (age > 40) continue;
      const x = this.seg[i], y = this.seg[i + 1];
      if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) continue;
      const b = Math.max(0, Math.min(3, Math.floor(age / 10)));
      buckets[b].moveTo(x, y);
      buckets[b].lineTo(this.seg[i + 2], this.seg[i + 3]);
    }
    const alphas = [0.32, 0.22, 0.13, 0.06];
    buckets.forEach((p, b) => { ctx.strokeStyle = `rgba(45,38,32,${alphas[b]})`; ctx.stroke(p); });
  }
}

// ----------------------------------------------------------------- smoke --
export class Smoke {
  private p: { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number }[] = [];
  emit(x: number, y: number, vx: number, vy: number, r: number) {
    if (this.p.length > 260) return;
    this.p.push({ x, y, vx: vx * 0.15 + (Math.random() - 0.5) * 1.5, vy: vy * 0.15 + (Math.random() - 0.5) * 1.5, life: 0, max: 1.2 + Math.random() * 0.9, r });
  }
  update(dt: number) {
    for (const s of this.p) { s.life += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 0.96; s.vy *= 0.96; }
    this.p = this.p.filter((s) => s.life < s.max);
  }
  draw(ctx: CanvasRenderingContext2D) {
    for (const s of this.p) {
      const t = s.life / s.max;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * (0.6 + t * 1.8), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(235,232,226,${0.38 * (1 - t)})`;
      ctx.fill();
    }
  }
}

// ----------------------------------------------------------------- route --
export function drawRoute(ctx: CanvasRenderingContext2D, r: Route, fromAlong: number, pxPerM: number, bounds: { x0: number; y0: number; x1: number; y1: number }) {
  const P = r.pts, cum = r.cum;
  const n = cum.length;
  const path = new Path2D();
  let started = false;
  let i0 = 0;
  while (i0 < n - 1 && cum[i0 + 1] < fromAlong) i0++;
  const pad = 200;
  for (let i = i0; i < n; i++) {
    let x = P[i * 2], y = P[i * 2 + 1];
    if (i === i0 && i < n - 1) {
      const L = cum[i + 1] - cum[i] || 1, t = Math.max(0, Math.min(1, (fromAlong - cum[i]) / L));
      x += (P[(i + 1) * 2] - x) * t; y += (P[(i + 1) * 2 + 1] - y) * t;
    }
    const out = x < bounds.x0 - pad || x > bounds.x1 + pad || y < bounds.y0 - pad || y > bounds.y1 + pad;
    if (out && i > i0 && i < n - 1) {
      const nx = P[(i + 1) * 2], ny = P[(i + 1) * 2 + 1];
      const nextOut = nx < bounds.x0 - pad || nx > bounds.x1 + pad || ny < bounds.y0 - pad || ny > bounds.y1 + pad;
      if (nextOut) { path.moveTo(x, y); started = true; continue; }
    }
    if (!started) { path.moveTo(x, y); started = true; } else path.lineTo(x, y);
  }
  const w = Math.max(6 / pxPerM, 7);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = w + 3.5 / pxPerM;
  ctx.stroke(path);
  ctx.strokeStyle = '#3F78F0';
  ctx.lineWidth = w;
  ctx.stroke(path);
  ctx.strokeStyle = 'rgba(140,180,255,0.55)';
  ctx.lineWidth = w * 0.35;
  ctx.stroke(path);
}

export function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, color = '#3F78F0') {
  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-4, -8, -11, -12, -11, -21);
  ctx.arc(0, -21, 11, Math.PI, 0);
  ctx.bezierCurveTo(11, -12, 4, -8, 0, 0);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.beginPath();
  ctx.arc(0, -21, 4.2, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.restore();
}

/**
 * Redraw overpass pieces (world space, same widths/colours as the tiles) on top
 * of the car so it visibly drives underneath bridges.
 */
export function drawOverpasses(ctx: CanvasRenderingContext2D, items: { c: Chunk; k: number }[], scale: number, th: Theme = THEME_MAP) {
  if (!items.length) return;
  const RAIL = th.rail, ROAD = th.road;
  const byLevel = new Map<number, { c: Chunk; k: number }[]>();
  for (const it of items) {
    const l = it.c.ll[it.k];
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l)!.push(it);
  }
  const path = (c: Chunk, k: number) => {
    const p = new Path2D();
    const o = c.lo[k], n = c.lc[k];
    p.moveTo(c.pts[o * 2], c.pts[o * 2 + 1]);
    for (let i = 1; i < n; i++) p.lineTo(c.pts[(o + i) * 2], c.pts[(o + i) * 2 + 1]);
    return p;
  };
  ctx.lineJoin = 'round';
  for (const l of [...byLevel.keys()].sort((a, b) => a - b)) {
    const list = byLevel.get(l)!;
    // shadow + casing pass, then fill pass (mirrors the tile renderer)
    for (const pass of [0, 1]) {
      for (const { c, k } of list) {
        const kind = c.lk[k];
        const p = path(c, k);
        if (kind >= LK.rail) {
          const st = kind === LK.rail ? RAIL.rail : kind === LK.metro ? RAIL.metro : RAIL.tram;
          const w = Math.max(st.w * scale, st.minPx);
          if (pass === 0) { ctx.strokeStyle = th.railBridge; ctx.lineWidth = (w + 3) / scale; ctx.lineCap = 'round'; ctx.stroke(p); }
          else { ctx.strokeStyle = st.color; ctx.lineWidth = w / scale; ctx.stroke(p); }
          continue;
        }
        const st = ROAD[roadStyleKey(kind, (c.lf[k] & LF.link) !== 0, false)];
        const w = Math.max(st.w * scale, st.minPx);
        ctx.lineCap = 'butt';
        if (pass === 0) {
          if (!st.casing) continue;
          ctx.save();
          ctx.shadowColor = th.bridgeShadow;
          ctx.shadowBlur = 6;
          ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 3;
          ctx.strokeStyle = th.bridgeCasing(st.casing);
          ctx.lineWidth = (w + 2 * Math.max(st.casingPx, th.curbM * scale) + 0.8) / scale;
          ctx.stroke(p);
          ctx.restore();
        } else {
          ctx.strokeStyle = st.fill;
          ctx.lineWidth = w / scale;
          ctx.stroke(p);
        }
      }
    }
  }
  ctx.lineCap = 'round';
}
