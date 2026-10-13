// Tracks the car's progress along an active route.

import type { Route } from './graph';

export class RouteFollower {
  route: Route | null = null;
  along = 0;
  offDist = 0;
  private idx = 0;
  offTime = 0;

  set(r: Route | null) {
    this.route = r;
    this.along = 0;
    this.idx = 0;
    this.offTime = 0;
  }

  /** update progress; returns 'arrived' | 'off' | 'ok' */
  update(x: number, y: number, dt: number): 'arrived' | 'off' | 'ok' | 'none' {
    const r = this.route;
    if (!r) return 'none';
    const P = r.pts, cum = r.cum, n = cum.length;
    let best = Infinity, bestAlong = this.along, bestIdx = this.idx;
    const i0 = Math.max(0, this.idx - 4);
    for (let i = i0; i < n - 1; i++) {
      if (cum[i] - this.along > 600) break;
      const ax = P[i * 2], ay = P[i * 2 + 1], bx = P[i * 2 + 2], by = P[i * 2 + 3];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
      if (d < best) { best = d; bestAlong = cum[i] + Math.sqrt(L2) * t; bestIdx = i; }
    }
    this.offDist = best;
    if (best < 45) {
      this.along = Math.max(this.along, bestAlong);
      this.idx = bestIdx;
      this.offTime = 0;
    } else {
      this.offTime += dt;
    }
    if (r.length - this.along < 22 && best < 40) return 'arrived';
    if (this.offTime > 1.6) return 'off';
    return 'ok';
  }

  nextStep() {
    const r = this.route;
    if (!r) return null;
    for (const s of r.steps) if (s.along > this.along + 4) return s;
    return r.steps[r.steps.length - 1];
  }

  remaining() {
    const r = this.route;
    if (!r) return { dist: 0, time: 0 };
    const f = r.length > 0 ? (r.length - this.along) / r.length : 0;
    return { dist: r.length - this.along, time: r.duration * f };
  }
}
