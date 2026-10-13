// DOM HUD: street pill, speedometer, compass, nav card, coords, toasts.

import { abbreviate, drawShield } from '../render/labels';
import { ROAD_CLASS_NAME } from '../world/codes';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const ICONS: Record<string, string> = {
  left: '<path d="M30 38V22a6 6 0 0 0-6-6H12m0 0 7-7m-7 7 7 7" />',
  right: '<path d="M14 38V22a6 6 0 0 1 6-6h12m0 0-7-7m7 7-7 7" />',
  'slight-left': '<path d="M28 38V26L16 14m0 0v9m0-9h9" />',
  'slight-right': '<path d="M16 38V26l12-12m0 0v9m0-9h-9" />',
  straight: '<path d="M22 38V8m0 0-7 7m7-7 7 7" />',
  uturn: '<path d="M16 38V18a7 7 0 0 1 14 0v8m0 0-6-6m6 6 6-6" />',
  merge: '<path d="M14 38c0-10 8-12 8-22V8m0 0-6 6m6-6 6 6M30 38c0-6-4-9-6-11" />',
  'exit-right': '<path d="M16 38V8M16 24c0-6 6-8 12-12m0 0h-8m8 0v8" />',
  'exit-left': '<path d="M28 38V8M28 24c0-6-6-8-12-12m0 0h8m-8 0v8" />',
  arrive: '<circle cx="22" cy="18" r="7" /><path d="M22 25v13" />',
};

export function iconSvg(name: string, color = '#fff') {
  return `<svg viewBox="0 0 44 44" fill="none" stroke="${color}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS.straight}</svg>`;
}

export function fmtDist(m: number): string {
  const ft = m * 3.28084;
  if (ft < 900) return `${Math.max(10, Math.round(ft / 10) * 10)} ft`;
  const mi = m / 1609.344;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

export function fmtDur(s: number): string {
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const G0 = Math.PI * 0.75, G1 = Math.PI * 2.25, GMAX = 140;

export class Hud {
  private speedEl = $('speed');
  private gearEl = $('gear');
  private gaugeVal = $('gauge-val');
  private nameEl = $('street-name');
  private subEl = $('street-sub');
  private shieldEl = $('street-shield');
  private coordsEl = $('coords');
  private needle = $('compass-needle');
  private mmN = $('minimap-n');
  private toastEl = $('toast');
  private toastT = 0;
  private lastName = '';
  private lastShield = '';
  private lastSub = '';
  private lastSpeed = -1;

  constructor() {
    $('gauge-track').setAttribute('d', arcPath(60, 60, 50, G0, G1));
    $('hud').classList.remove('hidden');
  }

  setSpeed(mph: number, gear: string) {
    const v = Math.round(mph);
    if (v !== this.lastSpeed) {
      this.speedEl.textContent = String(v);
      const f = Math.min(1, mph / GMAX);
      this.gaugeVal.setAttribute('d', f < 0.004 ? '' : arcPath(60, 60, 50, G0, G0 + (G1 - G0) * f));
      this.lastSpeed = v;
    }
    if (this.gearEl.textContent !== gear) this.gearEl.textContent = gear;
  }

  setRoad(name: string | null, ref: string | null, kind: number | null, offroad: boolean) {
    let label: string;
    if (offroad) label = 'Off road';
    else if (name) label = abbreviate(name);
    else if (ref) label = ref.split(';').map((r) => r.replace('I:', 'I-').replace('US:', 'US ').replace('GA:', 'GA ')).join(' / ');
    else label = kind !== null ? ROAD_CLASS_NAME[kind] ?? 'Road' : '—';
    if (label !== this.lastName) { this.nameEl.textContent = label; this.lastName = label; }
    const sh = offroad ? '' : ref ?? '';
    if (sh !== this.lastShield) {
      this.lastShield = sh;
      this.shieldEl.innerHTML = '';
      for (const r of sh.split(';').filter(Boolean).slice(0, 2)) {
        const [net, num] = r.split(':');
        const c = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        const w = num.length >= 3 ? 34 : 28;
        c.width = w * dpr; c.height = 26 * dpr;
        c.style.width = `${w}px`; c.style.height = '26px';
        const ctx = c.getContext('2d')!;
        ctx.scale(dpr, dpr);
        drawShield(ctx, net, num, w / 2, 13, 1.05);
        this.shieldEl.appendChild(c);
      }
    }
  }

  setPlace(hood: string | null, city: string | null) {
    const s = [hood, city].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ');
    if (s !== this.lastSub) { this.subEl.textContent = s || 'Atlanta'; this.lastSub = s; }
  }

  setCompass(rot: number) {
    const deg = (rot * 180) / Math.PI;
    this.needle.style.transform = `rotate(${deg}deg)`;
    this.mmN.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
  }

  setCoords(text: string) {
    if (this.coordsEl.textContent !== text) this.coordsEl.textContent = text;
  }

  toast(text: string, secs = 2.6) {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('hidden');
    this.toastT = secs;
  }

  tick(dt: number) {
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.toastEl.classList.add('hidden');
    }
  }
}
