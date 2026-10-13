// Drivable road graph built from OSM connectivity (Overture connectors).
// Edges carry their full geometry; one-way restrictions are respected.

import { parseContainer } from '../world/container';
import { cachedArrayBuffer, binSuffix } from '../world/fetchCache';
import { BASE } from '../world/manifest';
import { LF, LK } from '../world/codes';

const SPEED: Record<number, number> = { 0: 29, 1: 22, 2: 16, 3: 14, 4: 12.5, 5: 10, 6: 9, 7: 6, 8: 5, 9: 6 };

export interface Snap { edge: number; s: number; x: number; y: number; dist: number; seg: number }

export interface RouteStep { x: number; y: number; along: number; text: string; icon: string; road: string }

export interface Route {
  pts: Float32Array;   // polyline x,y
  cum: Float32Array;   // cumulative distance at each vertex
  length: number;
  duration: number;    // seconds at typical speeds
  steps: RouteStep[];
  dest: { x: number; y: number };
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const rk = k[0], rv = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return [rk, rv];
  }
}

export class RoadGraph {
  nx!: Float32Array; ny!: Float32Array;
  ea!: Uint32Array; eb!: Uint32Array; el!: Float32Array; ec!: Uint8Array; ef!: Uint8Array; en!: Int32Array;
  go!: Uint32Array; gc!: Uint32Array; G!: Float32Array;
  names: string[] = [];
  // CSR adjacency: for node u, outgoing entries adjE[i] (edge) with adjD[i] (0 forward a→b, 1 backward b→a)
  private adjStart!: Uint32Array; private adjE!: Uint32Array; private adjD!: Uint8Array;
  // spatial grid over edges
  private cell = 120;
  private grid = new Map<number, number[]>();

  static async load(): Promise<RoadGraph> {
    const { header, arrays: a } = parseContainer<{ names: string[] }>(await cachedArrayBuffer(`${BASE}world/routing.bin${binSuffix}`));
    const g = new RoadGraph();
    Object.assign(g, {
      nx: a.nx, ny: a.ny, ea: a.ea, eb: a.eb, el: a.el, ec: a.ec, ef: a.ef, en: a.en, go: a.go, gc: a.gc, G: a.G,
    });
    g.names = header.names;
    g.build();
    return g;
  }

  canFwd(e: number) { return (this.ef[e] & LF.onewayRev) === 0; }
  canBwd(e: number) { return (this.ef[e] & LF.oneway) === 0; }
  cost(e: number) { return this.el[e] / SPEED[this.ec[e]] + (this.ec[e] >= LK.service ? 4 : 0); }
  name(e: number) { return this.en[e] >= 0 ? this.names[this.en[e]] : null; }

  private build() {
    const nN = this.nx.length, nE = this.ea.length;
    const deg = new Uint32Array(nN + 1);
    for (let e = 0; e < nE; e++) {
      if (this.canFwd(e)) deg[this.ea[e]]++;
      if (this.canBwd(e)) deg[this.eb[e]]++;
    }
    const start = new Uint32Array(nN + 1);
    for (let i = 0; i < nN; i++) start[i + 1] = start[i] + deg[i];
    const fill = start.slice();
    const adjE = new Uint32Array(start[nN]);
    const adjD = new Uint8Array(start[nN]);
    for (let e = 0; e < nE; e++) {
      if (this.canFwd(e)) { const u = this.ea[e]; adjE[fill[u]] = e; adjD[fill[u]++] = 0; }
      if (this.canBwd(e)) { const u = this.eb[e]; adjE[fill[u]] = e; adjD[fill[u]++] = 1; }
    }
    this.adjStart = start; this.adjE = adjE; this.adjD = adjD;
    // grid
    const cs = this.cell;
    for (let e = 0; e < nE; e++) {
      const o = this.go[e], n = this.gc[e];
      const seen = new Set<number>();
      for (let i = 0; i < n; i++) {
        const x = this.G[(o + i) * 2], y = this.G[(o + i) * 2 + 1];
        const key = this.key(Math.floor(x / cs), Math.floor(y / cs));
        if (!seen.has(key)) { seen.add(key); this.cellList(key).push(e); }
        if (i < n - 1) {
          // long segments: add midpoints
          const x2 = this.G[(o + i + 1) * 2], y2 = this.G[(o + i + 1) * 2 + 1];
          const L = Math.hypot(x2 - x, y2 - y);
          for (let t = cs / 2; t < L; t += cs / 2) {
            const k2 = this.key(Math.floor((x + (x2 - x) * t / L) / cs), Math.floor((y + (y2 - y) * t / L) / cs));
            if (!seen.has(k2)) { seen.add(k2); this.cellList(k2).push(e); }
          }
        }
      }
    }
  }
  private key(i: number, j: number) { return (i + 32768) * 65536 + (j + 32768); }
  private cellList(k: number) { let l = this.grid.get(k); if (!l) this.grid.set(k, (l = [])); return l; }

  /** nearest edge to a point; optional heading prefers aligned edges */
  snap(x: number, y: number, maxDist = 400, heading?: number, avoidMotorway = false, preferPublic = false): Snap | null {
    const cs = this.cell;
    let best = null as Snap | null;
    let bestScore = Infinity;
    const R = Math.ceil(maxDist / cs);
    const ci = Math.floor(x / cs), cj = Math.floor(y / cs);
    const hx = heading !== undefined ? Math.cos(heading) : 0, hy = heading !== undefined ? Math.sin(heading) : 0;
    for (let ring = 0; ring <= R; ring++) {
      for (let i = ci - ring; i <= ci + ring; i++) for (let j = cj - ring; j <= cj + ring; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
        const list = this.grid.get(this.key(i, j));
        if (!list) continue;
        for (const e of list) {
          const o = this.go[e], n = this.gc[e];
          let acc = 0;
          for (let s = 0; s < n - 1; s++) {
            const ax = this.G[(o + s) * 2], ay = this.G[(o + s) * 2 + 1], bx = this.G[(o + s + 1) * 2], by = this.G[(o + s + 1) * 2 + 1];
            const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
            if (L < 1e-6) continue;
            let t = ((x - ax) * dx + (y - ay) * dy) / (L * L);
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + dx * t, py = ay + dy * t;
            const d = Math.hypot(x - px, y - py);
            let score = d;
            if (heading !== undefined) {
              const al = (dx * hx + dy * hy) / L;
              // misaligned or wrong-way roads are less likely to be the one we're on
              score += (1 - Math.abs(al)) * 8;
              if ((al > 0 && !this.canFwd(e)) || (al < 0 && !this.canBwd(e))) score += 6;
            }
            if (avoidMotorway && this.ec[e] <= LK.trunk) score += 25;
            if (preferPublic && (this.ec[e] >= LK.service || this.en[e] < 0)) score += 35;
            if (score < bestScore) { bestScore = score; best = { edge: e, s: acc + L * t, x: px, y: py, dist: d, seg: s }; }
            acc += L;
          }
        }
      }
      if (best && best.dist < ring * cs - cs) break;
    }
    return best && best.dist <= maxDist ? best : null;
  }

  /** A* from a snapped start (optionally with heading) to a snapped goal */
  route(a: Snap, b: Snap, heading?: number): Route | null {
    const nN = this.nx.length;
    const NG = nN; // virtual goal id
    const gScore = new Float64Array(nN + 1).fill(Infinity);
    const prevE = new Int32Array(nN + 1).fill(-1);
    const prevD = new Uint8Array(nN + 1);
    const prevN = new Int32Array(nN + 1).fill(-2);
    const closed = new Uint8Array(nN + 1);
    const heap = new Heap();
    const gx = b.x, gy = b.y;
    const H = (u: number) => (u === NG ? 0 : Math.hypot(this.nx[u] - gx, this.ny[u] - gy) / 29);
    const ea = this.ea[a.edge], eb = this.eb[a.edge], La = this.el[a.edge];
    const spd = SPEED[this.ec[a.edge]];
    // heading alignment with the start edge
    let fwdPenalty = 0, bwdPenalty = 0;
    if (heading !== undefined) {
      const o = this.go[a.edge] + a.seg;
      const dx = this.G[(o + 1) * 2] - this.G[o * 2], dy = this.G[(o + 1) * 2 + 1] - this.G[o * 2 + 1];
      const al = dx * Math.cos(heading) + dy * Math.sin(heading);
      if (al < 0) fwdPenalty = 25; else bwdPenalty = 25; // U-turn cost
    }
    // same-edge shortcut
    if (a.edge === b.edge) {
      if ((b.s >= a.s && this.canFwd(a.edge)) || (b.s < a.s && this.canBwd(a.edge))) {
        gScore[NG] = Math.abs(b.s - a.s) / spd + (b.s >= a.s ? fwdPenalty : bwdPenalty);
        prevN[NG] = -1;
      }
    }
    if (this.canFwd(a.edge)) { gScore[eb] = (La - a.s) / spd + fwdPenalty; prevN[eb] = -1; prevE[eb] = a.edge; prevD[eb] = 0; heap.push(gScore[eb] + H(eb), eb); }
    if (this.canBwd(a.edge)) { const c = a.s / spd + bwdPenalty; if (c < gScore[ea]) { gScore[ea] = c; prevN[ea] = -1; prevE[ea] = a.edge; prevD[ea] = 1; heap.push(c + H(ea), ea); } }
    if (gScore[NG] < Infinity) heap.push(gScore[NG], NG);
    const gEdge = b.edge, gA = this.ea[gEdge], gB = this.eb[gEdge], gL = this.el[gEdge], gSpd = SPEED[this.ec[gEdge]];
    let iter = 0;
    while (heap.size) {
      const [, u] = heap.pop();
      if (closed[u]) continue;
      closed[u] = 1;
      if (u === NG) break;
      if (++iter > 400000) break;
      // reaching the goal edge from its endpoints
      if (u === gA && this.canFwd(gEdge)) {
        const c = gScore[u] + b.s / gSpd;
        if (c < gScore[NG]) { gScore[NG] = c; prevN[NG] = u; prevE[NG] = gEdge; prevD[NG] = 0; heap.push(c, NG); }
      }
      if (u === gB && this.canBwd(gEdge)) {
        const c = gScore[u] + (gL - b.s) / gSpd;
        if (c < gScore[NG]) { gScore[NG] = c; prevN[NG] = u; prevE[NG] = gEdge; prevD[NG] = 1; heap.push(c, NG); }
      }
      for (let i = this.adjStart[u]; i < this.adjStart[u + 1]; i++) {
        const e = this.adjE[i], d = this.adjD[i];
        // never re-traverse the start/goal edges in full (that would dodge the U-turn cost)
        if (e === a.edge || e === gEdge) continue;
        const v = d === 0 ? this.eb[e] : this.ea[e];
        if (closed[v]) continue;
        const c = gScore[u] + this.cost(e);
        if (c < gScore[v]) { gScore[v] = c; prevN[v] = u; prevE[v] = e; prevD[v] = d; heap.push(c + H(v), v); }
      }
    }
    if (gScore[NG] === Infinity) return null;
    // reconstruct
    const seq: { e: number; d: number; from: number; to: number }[] = [];
    let cur = NG;
    while (prevN[cur] !== -1 && prevN[cur] !== -2) {
      seq.push({ e: prevE[cur], d: prevD[cur], from: prevN[cur], to: cur });
      cur = prevN[cur];
    }
    seq.reverse();
    const startEdgeDir = cur === NG ? (b.s >= a.s ? 0 : 1) : prevD[cur];
    const pts: number[] = [a.x, a.y];
    const turnNodes: { idx: number; inE: number; outE: number }[] = [];
    // partial start edge
    if (cur === NG) {
      this.appendPartial(pts, a.edge, a.s, b.s);
    } else {
      this.appendPartial(pts, a.edge, a.s, startEdgeDir === 0 ? La : 0);
      let lastE = a.edge;
      for (const st of seq) {
        if (st.to === NG) {
          turnNodes.push({ idx: pts.length / 2 - 1, inE: lastE, outE: st.e });
          this.appendPartial(pts, st.e, st.d === 0 ? 0 : gL, b.s);
        } else {
          turnNodes.push({ idx: pts.length / 2 - 1, inE: lastE, outE: st.e });
          this.appendPartial(pts, st.e, st.d === 0 ? 0 : this.el[st.e], st.d === 0 ? this.el[st.e] : 0);
          lastE = st.e;
        }
      }
    }
    pts.push(b.x, b.y);
    // dedupe consecutive identical points
    const clean: number[] = [];
    const idxMap = new Map<number, number>();
    for (let i = 0; i < pts.length / 2; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      const n = clean.length / 2;
      if (n && Math.abs(clean[(n - 1) * 2] - x) < 0.05 && Math.abs(clean[(n - 1) * 2 + 1] - y) < 0.05) { idxMap.set(i, n - 1); continue; }
      idxMap.set(i, n);
      clean.push(x, y);
    }
    const P = new Float32Array(clean);
    const cum = new Float32Array(P.length / 2);
    for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(P[i * 2] - P[i * 2 - 2], P[i * 2 + 1] - P[i * 2 - 1]);
    const steps = this.maneuvers(P, cum, turnNodes.map((t) => ({ ...t, idx: idxMap.get(t.idx) ?? 0 })), b);
    return { pts: P, cum, length: cum[cum.length - 1], duration: gScore[NG], steps, dest: { x: b.x, y: b.y } };
  }

  /** append geometry of edge e between distances s0 → s1 (either direction) */
  private appendPartial(out: number[], e: number, s0: number, s1: number) {
    const o = this.go[e], n = this.gc[e];
    const P = this.G;
    const cum: number[] = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(P[(o + i) * 2] - P[(o + i - 1) * 2], P[(o + i) * 2 + 1] - P[(o + i - 1) * 2 + 1]));
    const at = (s: number): [number, number] => {
      s = Math.max(0, Math.min(cum[n - 1], s));
      let i = 0;
      while (i < n - 2 && cum[i + 1] < s) i++;
      const L = cum[i + 1] - cum[i] || 1;
      const t = (s - cum[i]) / L;
      return [P[(o + i) * 2] + (P[(o + i + 1) * 2] - P[(o + i) * 2]) * t, P[(o + i) * 2 + 1] + (P[(o + i + 1) * 2 + 1] - P[(o + i) * 2 + 1]) * t];
    };
    const p0 = at(s0);
    out.push(p0[0], p0[1]);
    if (s1 >= s0) { for (let i = 0; i < n; i++) if (cum[i] > s0 && cum[i] < s1) out.push(P[(o + i) * 2], P[(o + i) * 2 + 1]); }
    else { for (let i = n - 1; i >= 0; i--) if (cum[i] < s0 && cum[i] > s1) out.push(P[(o + i) * 2], P[(o + i) * 2 + 1]); }
    const p1 = at(s1);
    out.push(p1[0], p1[1]);
  }

  private maneuvers(P: Float32Array, cum: Float32Array, turns: { idx: number; inE: number; outE: number }[], b: Snap): RouteStep[] {
    const steps: RouteStep[] = [];
    const n = cum.length;
    const pointAt = (s: number): [number, number] => {
      s = Math.max(0, Math.min(cum[n - 1], s));
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m; else hi = m; }
      const L = cum[hi] - cum[lo] || 1, t = (s - cum[lo]) / L;
      return [P[lo * 2] + (P[hi * 2] - P[lo * 2]) * t, P[lo * 2 + 1] + (P[hi * 2 + 1] - P[lo * 2 + 1]) * t];
    };
    let curName = turns.length ? this.label(turns[0].inE) : this.label(b.edge);
    for (const t of turns) {
      const nOut = this.label(t.outE);
      const cIn = this.ec[t.inE], cOut = this.ec[t.outE];
      const linkIn = (this.ef[t.inE] & LF.link) !== 0, linkOut = (this.ef[t.outE] & LF.link) !== 0;
      const s = cum[t.idx];
      const [ax, ay] = pointAt(s - 18), [bx, by] = pointAt(s), [cx, cy] = pointAt(s + 18);
      const a1 = Math.atan2(by - ay, bx - ax), a2 = Math.atan2(cy - by, cx - bx);
      let d = a2 - a1;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const deg = (d * 180) / Math.PI; // + = right (y down)
      const sameName = nOut === curName && nOut !== 'ramp';
      const motorIn = cIn <= LK.trunk && !linkIn;
      const motorOut = cOut <= LK.trunk && !linkOut;
      let text = '', icon = '';
      if (motorIn && linkOut) { text = `Take the exit${deg < 0 ? ' on the left' : ''}`; icon = deg < 0 ? 'exit-left' : 'exit-right'; }
      else if (linkIn && motorOut && nOut !== curName) { text = `Merge onto ${nOut}`; icon = 'merge'; }
      else if (sameName && Math.abs(deg) < 35) continue;
      else if (nOut === curName && nOut === 'unnamed road' && Math.abs(deg) < 70) continue;
      else if (Math.abs(deg) < 22) { if (nOut === curName || nOut === 'ramp') continue; text = `Continue onto ${nOut}`; icon = 'straight'; }
      else if (Math.abs(deg) < 55) { text = `Slight ${deg > 0 ? 'right' : 'left'} onto ${nOut}`; icon = deg > 0 ? 'slight-right' : 'slight-left'; }
      else if (Math.abs(deg) < 140) { text = `Turn ${deg > 0 ? 'right' : 'left'} onto ${nOut}`; icon = deg > 0 ? 'right' : 'left'; }
      else { text = `Make a U-turn onto ${nOut}`; icon = 'uturn'; }
      if (nOut === 'ramp' && !(motorIn && linkOut)) text = text.replace(/onto ramp/, 'onto the ramp');
      // collapse maneuvers that are very close together with the same road
      const last = steps[steps.length - 1];
      if (last && s - last.along < 12 && last.road === nOut) continue;
      steps.push({ x: bx, y: by, along: s, text, icon, road: nOut });
      curName = nOut;
    }
    steps.push({ x: b.x, y: b.y, along: cum[n - 1], text: 'Arrive at destination', icon: 'arrive', road: '' });
    return steps;
  }

  private label(e: number): string {
    const n = this.name(e);
    if (n) return n;
    if (this.ef[e] & LF.link) return 'ramp';
    return 'unnamed road';
  }
}
