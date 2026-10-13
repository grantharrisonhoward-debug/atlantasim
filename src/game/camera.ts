// Smooth follow camera with velocity look-ahead, speed-based zoom-out,
// optional car-up rotation and impact shake.

import type { Car } from './car';

export const ZOOM_MIN = 0.06;  // CSS px per metre
export const ZOOM_MAX = 14;

export class Camera {
  x = 0; y = 0;
  rot = 0;
  scale = 2.2;
  userScale = 2.2;
  mode: 'north' | 'car' = 'north';
  private lx = 0; private ly = 0;
  private shakeT = 0;

  snapTo(car: Car) {
    this.x = car.x; this.y = car.y;
    this.lx = this.ly = 0;
    this.scale = this.userScale;
    this.rot = this.mode === 'car' ? -(car.heading + Math.PI / 2) : 0;
  }

  zoomBy(f: number) {
    this.userScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.userScale * f));
  }

  update(dt: number, car: Car, w: number, h: number, lookAhead: boolean, speedZoom: boolean) {
    const spd = car.speed;
    // zoom
    const zf = speedZoom ? 1 / (1 + Math.max(0, spd - 9) / 34 * 0.6) : 1;
    const target = this.userScale * zf;
    this.scale *= Math.pow(target / this.scale, 1 - Math.exp(-dt * (Math.abs(target - this.scale) / this.scale > 0.2 ? 6 : 1.6)));
    // look-ahead (metres), limited to a fraction of the screen
    let tx = 0, ty = 0;
    if (lookAhead) {
      const maxL = (Math.min(w, h) * 0.26) / this.scale;
      tx = car.vx * 0.9; ty = car.vy * 0.9;
      const L = Math.hypot(tx, ty);
      if (L > maxL) { tx *= maxL / L; ty *= maxL / L; }
    }
    const kl = 1 - Math.exp(-dt * 2.2);
    this.lx += (tx - this.lx) * kl;
    this.ly += (ty - this.ly) * kl;
    const kp = 1 - Math.exp(-dt * 9);
    this.x += (car.x + this.lx - this.x) * kp;
    this.y += (car.y + this.ly - this.y) * kp;
    // rotation
    const rt = this.mode === 'car' ? -(car.heading + Math.PI / 2) : 0;
    let d = rt - this.rot;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    this.rot += d * (1 - Math.exp(-dt * (this.mode === 'car' ? 3.2 : 5)));
    // shake
    this.shakeT += dt;
  }

  shakeOffset(amount: number): [number, number] {
    if (amount < 0.01) return [0, 0];
    const a = amount * 6;
    return [Math.sin(this.shakeT * 61) * a, Math.cos(this.shakeT * 47) * a];
  }
}
