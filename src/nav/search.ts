// Offline search over real street names, places (Overture/OSM POIs),
// landmarks and neighbourhoods.

import { BASE } from '../world/manifest';

export interface SearchResult { name: string; detail: string; x: number; y: number; kind: 'street' | 'place' | 'hood' | 'landmark'; score: number }

interface Data {
  streets: [string, number, number, number][];
  places: [string, string, number, number][];
  hoods: [string, number, number][];
  landmarks: [string, string, number, number][];
}

const EXPAND: Record<string, string> = {
  st: 'street', ave: 'avenue', av: 'avenue', rd: 'road', dr: 'drive', blvd: 'boulevard', pkwy: 'parkway',
  pl: 'place', ln: 'lane', cir: 'circle', ct: 'court', ter: 'terrace', hwy: 'highway', trl: 'trail',
  ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest', n: 'north', s: 'south', e: 'east', w: 'west',
  mlk: 'martin luther king', jr: 'junior', mt: 'mount', ft: 'fort',
};

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ')
  .split(/\s+/).filter(Boolean).map((w) => EXPAND[w] ?? w).join(' ');

const PRETTY_CAT = (c: string) => c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

export class Search {
  private items: { n: string; key: string; detail: string; x: number; y: number; kind: SearchResult['kind']; boost: number }[] = [];
  ready = false;
  private loading: Promise<void> | null = null;

  load(neighborhoodOf: (x: number, y: number) => string | null) {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const d: Data = await (await fetch(`${BASE}world/search.json`)).json();
      for (const [n, , x, y] of d.landmarks) this.items.push({ n, key: norm(n), detail: 'Landmark', x, y, kind: 'landmark', boost: 3 });
      for (const [n, x, y] of d.hoods) this.items.push({ n, key: norm(n), detail: 'Neighborhood', x, y, kind: 'hood', boost: 2.5 });
      for (const [n, rank, x, y] of d.streets) {
        const h = neighborhoodOf(x, y);
        this.items.push({ n, key: norm(n), detail: h ? `Street · ${h}` : 'Street', x, y, kind: 'street', boost: 2 - rank * 0.15 });
      }
      for (const [n, c, x, y] of d.places) this.items.push({ n, key: norm(n), detail: PRETTY_CAT(c), x, y, kind: 'place', boost: 1 });
      this.ready = true;
    })();
    return this.loading;
  }

  query(q: string, near?: { x: number; y: number }, limit = 8): SearchResult[] {
    const nq = norm(q);
    if (!nq) return [];
    const words = nq.split(' ');
    const out: SearchResult[] = [];
    for (const it of this.items) {
      const k = it.key;
      let score = 0;
      if (k === nq) score = 100;
      else if (k.startsWith(nq)) score = 70;
      else if (words.every((w) => k.includes(w))) {
        const kw = k.split(' ');
        score = words.every((w) => kw.some((x) => x.startsWith(w))) ? 45 : 20;
      } else continue;
      score += it.boost * 6 - k.length * 0.12;
      if (near) score -= Math.min(15, Math.hypot(it.x - near.x, it.y - near.y) / 1500);
      out.push({ name: it.n, detail: it.detail, x: it.x, y: it.y, kind: it.kind, score });
    }
    out.sort((a, b) => b.score - a.score);
    // de-duplicate same name in nearly the same place
    const res: SearchResult[] = [];
    for (const r of out) {
      if (res.some((o) => o.name === r.name && Math.hypot(o.x - r.x, o.y - r.y) < 1200)) continue;
      res.push(r);
      if (res.length >= limit) break;
    }
    return res;
  }
}
