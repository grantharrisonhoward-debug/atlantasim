// Full-screen interactive map: pan / zoom / search / destination / route preview.

import { TileCache, type View } from '../render/tileCache';
import { drawPin, drawPuck, drawRoute } from '../render/carDraw';
import type { Game } from '../game/game';
import { fmtDist, fmtDur } from './hud';
import type { SearchResult } from '../nav/search';
import { LANDMARK_COLOR } from '../render/labels';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class FullMap {
  open = false;
  view: View = { cx: 0, cy: 0, scale: 0.3, rot: 0, w: 1, h: 1, dpr: 1 };
  private el = $('map-overlay');
  private canvas = $<HTMLCanvasElement>('map-canvas');
  private ctx = this.canvas.getContext('2d', { alpha: false })!;
  private input = $<HTMLInputElement>('search-input');
  private results = $('search-results');
  private card = $('route-card');
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private targetScale = 0.3;
  private anchor: { sx: number; sy: number; wx: number; wy: number } | null = null;
  private sel = -1;
  private found: SearchResult[] = [];
  private destTitle = '';
  private pinches = new Map<number, { x: number; y: number }>();
  private puckDrag: { id: number; x: number; y: number } | null = null;
  private pinWorld: { x: number; y: number } | null = null;

  private carScreen(): [number, number] {
    const v = this.view, car = this.g.car;
    return [(car.x - v.cx) * v.scale + v.w / 2, (car.y - v.cy) * v.scale + v.h / 2];
  }

  constructor(private g: Game) {
    $('map-close').onclick = () => this.hide();
    $('map-zin').onclick = () => this.zoomAt(1.8);
    $('map-zout').onclick = () => this.zoomAt(1 / 1.8);
    $('map-me').onclick = () => { this.view.cx = g.car.x; this.view.cy = g.car.y; this.targetScale = Math.max(this.targetScale, 0.6); };
    $('route-go').onclick = () => this.hide();
    $('route-tp').onclick = async () => {
      const p = this.pinWorld ?? this.g.dest;
      if (!p) return;
      g.clearRoute();
      this.card.classList.add('hidden');
      if (await g.teleport(p.x, p.y)) this.hide();
    };
    $('route-clear').onclick = () => { g.clearRoute(); this.card.classList.add('hidden'); };

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      // grab your own car to move it somewhere else
      const cs = this.carScreen();
      if (this.pinches.size === 0 && Math.hypot(e.clientX - cs[0], e.clientY - cs[1]) < 22) {
        this.puckDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        c.classList.add('dragging');
        return;
      }
      this.pinches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinches.size === 1) this.drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy, moved: false };
      else this.drag = null;
    });
    c.addEventListener('pointermove', (e) => {
      if (this.puckDrag) {
        if (e.pointerId === this.puckDrag.id) { this.puckDrag.x = e.clientX; this.puckDrag.y = e.clientY; }
        return;
      }
      if (!this.drag) {
        const cs = this.carScreen();
        c.style.cursor = Math.hypot(e.clientX - cs[0], e.clientY - cs[1]) < 22 ? 'move' : '';
      }
      const prev = this.pinches.get(e.pointerId);
      if (prev && this.pinches.size === 2) {
        const pts = [...this.pinches.values()];
        const d0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        this.pinches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pts2 = [...this.pinches.values()];
        const d1 = Math.hypot(pts2[0].x - pts2[1].x, pts2[0].y - pts2[1].y);
        if (d0 > 0) this.zoomAt(d1 / d0, (pts2[0].x + pts2[1].x) / 2, (pts2[0].y + pts2[1].y) / 2, true);
        return;
      }
      if (prev) this.pinches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (Math.hypot(dx, dy) > 4) { this.drag.moved = true; c.classList.add('dragging'); }
      this.view.cx = this.drag.cx - dx / this.view.scale;
      this.view.cy = this.drag.cy - dy / this.view.scale;
      this.anchor = null;
    });
    const up = (e: PointerEvent) => {
      if (this.puckDrag && e.pointerId === this.puckDrag.id) {
        const [wx, wy] = this.toWorld(this.puckDrag.x, this.puckDrag.y);
        this.puckDrag = null;
        c.classList.remove('dragging');
        g.teleport(wx, wy);
        return;
      }
      this.pinches.delete(e.pointerId);
      c.classList.remove('dragging');
      if (this.drag && !this.drag.moved) {
        const [wx, wy] = this.toWorld(e.clientX, e.clientY);
        this.setDest(wx, wy, null);
      }
      this.drag = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', (e) => { this.pinches.delete(e.pointerId); this.drag = null; this.puckDrag = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      this.zoomAt(Math.exp(-d * 0.0022), e.clientX, e.clientY);
    }, { passive: false });
    c.addEventListener('dblclick', (e) => this.zoomAt(2, e.clientX, e.clientY));

    this.input.addEventListener('input', () => this.runSearch());
    this.input.addEventListener('focus', () => g.search.load((x, y) => g.hoodName(x, y)).then(() => this.runSearch()));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { this.sel = Math.min(this.found.length - 1, this.sel + 1); this.renderResults(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.sel = Math.max(0, this.sel - 1); this.renderResults(); e.preventDefault(); }
      else if (e.key === 'Enter') { const r = this.found[Math.max(0, this.sel)]; if (r) this.pick(r); }
      else if (e.key === 'Escape') { this.input.blur(); this.results.innerHTML = ''; }
      e.stopPropagation();
    });
  }

  private toWorld(sx: number, sy: number): [number, number] {
    const v = this.view;
    return [v.cx + (sx - v.w / 2) / v.scale, v.cy + (sy - v.h / 2) / v.scale];
  }

  private zoomAt(f: number, sx = this.view.w / 2, sy = this.view.h / 2, immediate = false) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.targetScale = Math.max(0.02, Math.min(8, this.targetScale * f));
    this.anchor = { sx, sy, wx, wy };
    if (immediate) this.view.scale = this.targetScale;
  }

  show() {
    this.open = true;
    this.el.classList.remove('hidden');
    this.view.cx = this.g.car.x; this.view.cy = this.g.car.y;
    if (!this.g.follower.route) { this.targetScale = 0.22; this.view.scale = 0.12; }
    else {
      const r = this.g.follower.route;
      this.fitRoute(r.pts);
    }
    this.anchor = null;
    this.g.ensureGraph();
  }

  hide() {
    this.open = false;
    this.el.classList.add('hidden');
    this.input.blur();
    this.results.innerHTML = '';
  }

  toggle() { this.open ? this.hide() : this.show(); }

  private fitRoute(P: Float32Array) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < P.length; i += 2) {
      x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]);
    }
    this.view.cx = (x0 + x1) / 2; this.view.cy = (y0 + y1) / 2;
    const s = Math.min((this.view.w - 160) / Math.max(200, x1 - x0), (this.view.h - 260) / Math.max(200, y1 - y0));
    this.targetScale = Math.max(0.03, Math.min(2.5, s));
  }

  private runSearch() {
    const q = this.input.value.trim();
    if (!q || !this.g.search.ready) { this.found = []; this.renderResults(); return; }
    this.found = this.g.search.query(q, { x: this.view.cx, y: this.view.cy });
    this.sel = this.found.length ? 0 : -1;
    this.renderResults();
  }

  private renderResults() {
    const color = (r: SearchResult) => r.kind === 'street' ? '#C9A46A' : r.kind === 'hood' ? '#8A7E70' : r.kind === 'landmark' ? LANDMARK_COLOR.attraction : '#6B8FC4';
    this.results.innerHTML = '';
    this.found.forEach((r, i) => {
      const d = document.createElement('div');
      d.className = 'result' + (i === this.sel ? ' sel' : '');
      d.innerHTML = `<span class="dot" style="background:${color(r)}"></span><div><div class="n"></div><div class="d"></div></div>`;
      (d.querySelector('.n') as HTMLElement).textContent = r.name;
      (d.querySelector('.d') as HTMLElement).textContent = r.detail;
      d.onclick = () => this.pick(r);
      this.results.appendChild(d);
    });
  }

  private pick(r: SearchResult) {
    this.results.innerHTML = '';
    this.input.value = r.name;
    this.input.blur();
    this.view.cx = r.x; this.view.cy = r.y;
    this.targetScale = Math.max(this.targetScale, r.kind === 'hood' ? 0.7 : 1.2);
    this.anchor = null;
    this.setDest(r.x, r.y, r.name);
  }

  private async setDest(wx: number, wy: number, title: string | null) {
    this.card.classList.remove('hidden');
    $('route-title').textContent = title ?? 'Dropped pin';
    $('route-meta').textContent = 'Finding a route…';
    this.pinWorld = { x: wx, y: wy };
    const res = await this.g.setDestination(wx, wy);
    if (!res) { $('route-meta').textContent = 'No drivable route found to this point.'; return; }
    this.destTitle = title ?? res.roadName ?? 'Dropped pin';
    $('route-title').textContent = this.destTitle;
    $('route-meta').textContent = `${fmtDur(res.route.duration)} · ${fmtDist(res.route.length)} · via real streets`;
  }

  frame(dt: number) {
    if (!this.open) return;
    const v = this.view;
    const dpr = this.g.renderDpr();
    const w = window.innerWidth, h = window.innerHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    }
    v.w = w; v.h = h; v.dpr = dpr;
    // carrying the car to an edge scrolls the map
    if (this.puckDrag) {
      const m = 60, sp = 700 * dt / v.scale;
      const px = this.puckDrag.x, py = this.puckDrag.y;
      if (px < m) v.cx -= sp * (m - px) / m; else if (px > w - m) v.cx += sp * (px - (w - m)) / m;
      if (py < m) v.cy -= sp * (m - py) / m; else if (py > h - m) v.cy += sp * (py - (h - m)) / m;
      this.anchor = null;
    }
    // smooth zoom about the anchor
    const k = 1 - Math.exp(-dt * 12);
    v.scale *= Math.pow(this.targetScale / v.scale, k);
    if (this.anchor) {
      v.cx = this.anchor.wx - (this.anchor.sx - w / 2) / v.scale;
      v.cy = this.anchor.wy - (this.anchor.sy - h / 2) / v.scale;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#E4DFD5';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.g.cache.draw(ctx as any, v, 0);
    TileCache.applyView(ctx as any, v);
    const b = TileCache.viewBounds(v, 100);
    const r = this.g.follower.route;
    if (r) drawRoute(ctx as any, r, this.g.follower.along, v.scale, b);
    this.g.labels.draw(ctx as any, v, { map: true });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const car = this.g.car;
    const cs = [(car.x - v.cx) * v.scale + w / 2, (car.y - v.cy) * v.scale + h / 2];
    if (this.puckDrag) {
      // ghost at the old spot, lifted puck under the pointer
      ctx.globalAlpha = 0.35;
      drawPuck(ctx as any, cs[0], cs[1], car.heading, 1.1);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(this.puckDrag.x, this.puckDrag.y, 24, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(232,119,90,0.18)';
      ctx.fill();
      drawPuck(ctx as any, this.puckDrag.x, this.puckDrag.y - 4, car.heading, 1.35);
    } else drawPuck(ctx as any, cs[0], cs[1], car.heading, 1.1);
    const dest = this.g.dest;
    if (dest) drawPin(ctx as any, (dest.x - v.cx) * v.scale + w / 2, (dest.y - v.cy) * v.scale + h / 2);
  }
}
