/// <reference lib="webworker" />
// Tile worker: fetches + decodes map chunks (cached) and rasterises tiles.

import { decodeChunk, chunkUrl, type Chunk } from '../world/chunk';
import { cachedArrayBuffer, setCacheVersion } from '../world/fetchCache';
import { drawTile, lodForZoom, tileWorldSize, TILE_PX, GUTTER, type TileJob } from './tileDraw';

declare const self: DedicatedWorkerGlobalScope;

interface Init { type: 'init'; base: string; version: string; lods: Record<string, { size: number; chunks: [number, number][] }>; region: number[] }

let base = '';
let region: Float32Array | null = null;
const lodInfo = new Map<number, { size: number; have: Set<string> }>();
const cache = new Map<string, Chunk>();
const loading = new Map<string, Promise<Chunk | null>>();
const CACHE_MAX: Record<number, number> = { 0: 90, 1: 16, 2: 9 };

const S = TILE_PX + GUTTER * 2;
const canvas = new OffscreenCanvas(S, S);
const ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D;
const shadowCanvas = new OffscreenCanvas(S, S);
const shadowCtx = shadowCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;

function touch(key: string, c: Chunk) {
  cache.delete(key);
  cache.set(key, c);
  // evict oldest of the same lod
  let n = 0;
  for (const v of cache.values()) if (v.lod === c.lod) n++;
  if (n > CACHE_MAX[c.lod]) {
    for (const [k, v] of cache) {
      if (v.lod === c.lod) { cache.delete(k); break; }
    }
  }
}

function getChunk(lod: number, i: number, j: number): Promise<Chunk | null> {
  const key = `${lod}/${i}_${j}`;
  const c = cache.get(key);
  if (c) { touch(key, c); return Promise.resolve(c); }
  const info = lodInfo.get(lod)!;
  if (!info.have.has(`${i}_${j}`)) return Promise.resolve(null);
  let p = loading.get(key);
  if (!p) {
    p = cachedArrayBuffer(chunkUrl(base, lod, i, j))
      .then((buf) => { const ch = decodeChunk(buf, key); touch(key, ch); return ch; })
      .catch((e) => { console.warn('chunk failed', key, e); return null; })
      .finally(() => loading.delete(key));
    loading.set(key, p);
  }
  return p;
}

async function render(job: TileJob) {
  const lod = lodForZoom(job.z);
  const info = lodInfo.get(lod)!;
  const T = tileWorldSize(job.z);
  const m = 320;
  const x0 = job.tx * T - m, y0 = job.ty * T - m, x1 = (job.tx + 1) * T + m, y1 = (job.ty + 1) * T + m;
  const s = info.size;
  const jobs: Promise<Chunk | null>[] = [];
  for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++)
    for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++) jobs.push(getChunk(lod, i, j));
  const chunks = (await Promise.all(jobs)).filter((c): c is Chunk => !!c);
  const t0 = performance.now();
  drawTile(ctx, shadowCtx, chunks, job, region);
  const bmp = canvas.transferToImageBitmap();
  self.postMessage({ type: 'tile', id: job.id, bmp, ms: performance.now() - t0 }, [bmp]);
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    const m = msg as Init;
    base = m.base;
    setCacheVersion(m.version);
    region = m.region && m.region.length ? new Float32Array(m.region) : null;
    for (const [k, v] of Object.entries(m.lods)) {
      lodInfo.set(+k, { size: v.size, have: new Set(v.chunks.map(([i, j]) => `${i}_${j}`)) });
    }
  } else if (msg.type === 'render') {
    render(msg.job as TileJob).catch((e) => {
      console.error(e);
      self.postMessage({ type: 'tile', id: msg.job.id, bmp: null });
    });
  }
};
