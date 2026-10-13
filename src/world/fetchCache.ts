// Persistent cache for world data (Cache Storage, available to windows and
// workers). Keyed by the world build timestamp so a rebuild invalidates it.

let cacheName = 'atlantasim-world';
/** extra suffix for binary data files (hosts that only serve web types publish them as .wasm) */
export let binSuffix = '';
export function setBinSuffix(s: string | undefined) { binSuffix = s ?? ''; }

export function setCacheVersion(v: string) {
  cacheName = `atlantasim-world-${v}`;
}

export async function cachedArrayBuffer(url: string): Promise<ArrayBuffer> {
  const hasCaches = typeof caches !== 'undefined';
  if (hasCaches) {
    try {
      const c = await caches.open(cacheName);
      const hit = await c.match(url);
      if (hit) return await hit.arrayBuffer();
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const buf = await r.arrayBuffer();
      c.put(url, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
      return buf;
    } catch (e) {
      if ((e as Error).message?.startsWith('4')) throw e;
      // fall through to a plain fetch (e.g. insecure context, quota)
    }
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.arrayBuffer();
}

/** drop caches from older world builds */
export async function pruneOldCaches() {
  if (typeof caches === 'undefined') return;
  try {
    for (const k of await caches.keys()) if (k.startsWith('atlantasim-world') && k !== cacheName) await caches.delete(k);
  } catch { /* ignore */ }
}
