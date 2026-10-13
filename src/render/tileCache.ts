// Main-thread tile manager: worker pool, prioritised request queue, LRU cache,
// and a view renderer that composites tiles (with parent/child fallback while
// sharper tiles are being produced).

import type { Manifest } from '../world/manifest';
import { BASE } from '../world/manifest';
import { GUTTER, TILE_PX, tileWorldSize, type TileJob } from './tileDraw';

export interface View {
  cx: number; cy: number;   // world centre (m)
  scale: number;            // CSS px per metre
  rot: number;              // radians; screen = R(rot) * (world - c)
  w: number; h: number;     // CSS px
  dpr: number;
}

interface Tile { key: string; z: number; tx: number; ty: number; bmp: ImageBitmap | null; used: number }

export const ZMIN = -6;
export const ZMAX = 3;

export class TileCache {
  private workers: { w: Worker; busy: boolean; job: string | null }[] = [];
  private tiles = new Map<string, Tile>();
  private inflight = new Set<string>();
  private wanted = new Map<string, { z: number; tx: number; ty: number; pri: number }>();
  private nextId = 1;
  private idToKey = new Map<number, string>();
  private frame = 0;
  pxScale: number;
  maxTiles = 260;
  onTile: (() => void) | null = null;

  constructor(manifest: Manifest, pxScale: number) {
    this.pxScale = pxScale;
    const n = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    const lods: Record<string, { size: number; chunks: [number, number][] }> = {};
    for (const [k, v] of Object.entries(manifest.lods)) lods[k] = { size: v.size, chunks: v.chunks };
    const region = (manifest as any).region ?? manifest.perimeter;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
      w.postMessage({ type: 'init', base: BASE, lods, region });
      const slot = { w, busy: false, job: null as string | null };
      w.onmessage = (ev) => this.onMessage(slot, ev.data);
      w.onerror = (e) => { console.error('tile worker error', e); slot.busy = false; };
      this.workers.push(slot);
    }
  }

  setPxScale(s: number) {
    if (s === this.pxScale) return;
    this.pxScale = s;
    for (const t of this.tiles.values()) t.bmp?.close();
    this.tiles.clear();
  }

  private onMessage(slot: { busy: boolean; job: string | null }, msg: any) {
    if (msg.type !== 'tile') return;
    const key = this.idToKey.get(msg.id);
    this.idToKey.delete(msg.id);
    slot.busy = false;
    slot.job = null;
    if (key) {
      this.inflight.delete(key);
      const [z, tx, ty] = key.split('/').map(Number);
      if (msg.bmp) this.tiles.set(key, { key, z, tx, ty, bmp: msg.bmp, used: this.frame });
    } else msg.bmp?.close();
    this.evict();
    this.pump();
    this.onTile?.();
  }

  beginFrame() {
    this.frame++;
    this.wanted.clear();
  }

  private want(z: number, tx: number, ty: number, pri: number) {
    const key = `${z}/${tx}/${ty}`;
    if (this.tiles.has(key) || this.inflight.has(key)) return;
    const w = this.wanted.get(key);
    if (!w || w.pri > pri) this.wanted.set(key, { z, tx, ty, pri });
  }

  /** dispatch the highest-priority wanted tiles to idle workers */
  pump() {
    const idle = this.workers.filter((w) => !w.busy);
    if (!idle.length || !this.wanted.size) return;
    const list = [...this.wanted.entries()].sort((a, b) => a[1].pri - b[1].pri);
    for (const [key, t] of list) {
      if (!idle.length) break;
      // keep spatially-coherent tiles on the same worker so its chunk cache is reused
      const T = tileWorldSize(t.z);
      const cx = Math.floor(((t.tx + 0.5) * T) / 2048), cy = Math.floor(((t.ty + 0.5) * T) / 2048);
      const pref = (((cx * 73856093) ^ (cy * 19349663)) >>> 0) % this.workers.length;
      let slot = idle.find((s) => s === this.workers[pref]) ?? idle[0];
      idle.splice(idle.indexOf(slot), 1);
      const id = this.nextId++;
      this.idToKey.set(id, key);
      this.inflight.add(key);
      this.wanted.delete(key);
      slot.busy = true;
      slot.job = key;
      const job: TileJob = { id, z: t.z, tx: t.tx, ty: t.ty, pxScale: this.pxScale };
      slot.w.postMessage({ type: 'render', job });
    }
  }

  private evict() {
    if (this.tiles.size <= this.maxTiles) return;
    const arr = [...this.tiles.values()].sort((a, b) => a.used - b.used);
    for (let i = 0; i < arr.length - this.maxTiles; i++) {
      const t = arr[i];
      if (t.used >= this.frame - 1) break;
      t.bmp?.close();
      this.tiles.delete(t.key);
    }
  }

  zoomFor(view: View, bias = 0.25) {
    const z = Math.round(Math.log2(view.scale * this.pxScale) + bias);
    return Math.max(ZMIN, Math.min(ZMAX, z));
  }

  /** world-space AABB of the view (rotation aware) */
  static viewBounds(v: View, pad = 0) {
    const hw = v.w / 2 / v.scale + pad, hh = v.h / 2 / v.scale + pad;
    const c = Math.abs(Math.cos(v.rot)), s = Math.abs(Math.sin(v.rot));
    const ex = hw * c + hh * s, ey = hw * s + hh * c;
    return { x0: v.cx - ex, y0: v.cy - ey, x1: v.cx + ex, y1: v.cy + ey };
  }

  /** set ctx transform for drawing in world coordinates */
  static applyView(ctx: CanvasRenderingContext2D, v: View) {
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    ctx.translate(v.w / 2, v.h / 2);
    ctx.rotate(v.rot);
    ctx.scale(v.scale, v.scale);
    ctx.translate(-v.cx, -v.cy);
  }

  /** composite the map for a view; returns true if every tile was sharp */
  draw(ctx: CanvasRenderingContext2D, v: View, priBase = 0, prefetch = true): boolean {
    const z = this.zoomFor(v);
    const T = tileWorldSize(z);
    const b = TileCache.viewBounds(v);
    const tx0 = Math.floor(b.x0 / T), ty0 = Math.floor(b.y0 / T);
    const tx1 = Math.floor(b.x1 / T), ty1 = Math.floor(b.y1 / T);
    const ctxT = (b.x0 + b.x1) / 2 / T, ctyT = (b.y0 + b.y1) / 2 / T;
    TileCache.applyView(ctx, v);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const exact: Tile[] = [];
    const fallback = new Map<string, { t: Tile; cx0: number; cy0: number; cx1: number; cy1: number }>();
    let complete = true;
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const key = `${z}/${tx}/${ty}`;
        const t = this.tiles.get(key);
        if (t && t.bmp) { t.used = this.frame; exact.push(t); continue; }
        complete = false;
        const d = Math.hypot(tx + 0.5 - ctxT, ty + 0.5 - ctyT);
        this.want(z, tx, ty, priBase + d);
        // parent fallback
        let found = false;
        for (let pz = z - 1; pz >= Math.max(ZMIN, z - 5); pz--) {
          const f = Math.pow(2, z - pz);
          const ptx = Math.floor(tx / f), pty = Math.floor(ty / f);
          const pk = `${pz}/${ptx}/${pty}`;
          const pt = this.tiles.get(pk);
          if (pt && pt.bmp) {
            pt.used = this.frame;
            fallback.set(pk + '|' + key, { t: pt, cx0: tx * T, cy0: ty * T, cx1: (tx + 1) * T, cy1: (ty + 1) * T });
            found = true;
            break;
          }
        }
        if (!found && z < ZMAX) {
          for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) {
            const ck = `${z + 1}/${tx * 2 + dx}/${ty * 2 + dy}`;
            const ct = this.tiles.get(ck);
            if (ct && ct.bmp) { ct.used = this.frame; exact.unshift(ct); }
          }
        }
      }
    }
    // coarse fallbacks first (clipped to the missing tile), then sharp tiles
    for (const { t, cx0, cy0, cx1, cy1 } of fallback.values()) {
      const PT = tileWorldSize(t.z);
      const mpp = PT / TILE_PX;
      const ox = t.tx * PT - GUTTER * mpp, oy = t.ty * PT - GUTTER * mpp;
      const sx = (cx0 - ox) / mpp, sy = (cy0 - oy) / mpp, sw = (cx1 - cx0) / mpp, sh = (cy1 - cy0) / mpp;
      const e = 0.5 / v.scale;
      ctx.drawImage(t.bmp!, sx, sy, sw, sh, cx0 - e, cy0 - e, cx1 - cx0 + 2 * e, cy1 - cy0 + 2 * e);
    }
    for (const t of exact) {
      const TT = tileWorldSize(t.z);
      const mpp = TT / TILE_PX;
      const S = TILE_PX + 2 * GUTTER;
      ctx.drawImage(t.bmp!, t.tx * TT - GUTTER * mpp, t.ty * TT - GUTTER * mpp, S * mpp, S * mpp);
    }
    // prefetch a ring around the view (and the next zoom out) at low priority
    if (prefetch && complete) {
      for (let tx = tx0 - 1; tx <= tx1 + 1; tx++) for (let ty = ty0 - 1; ty <= ty1 + 1; ty++) {
        if (tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) continue;
        this.want(z, tx, ty, priBase + 50 + Math.hypot(tx + 0.5 - ctxT, ty + 0.5 - ctyT));
      }
    }
    if (z > ZMIN) {
      const f = 2;
      for (let tx = Math.floor(tx0 / f); tx <= Math.floor(tx1 / f); tx++)
        for (let ty = Math.floor(ty0 / f); ty <= Math.floor(ty1 / f); ty++) this.want(z - 1, tx, ty, priBase + 30);
    }
    return complete;
  }

  stats() {
    return { tiles: this.tiles.size, inflight: this.inflight.size, queued: this.wanted.size };
  }
}
