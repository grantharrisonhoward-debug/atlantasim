// Arcade car physics: kinematic-bicycle yaw with grip-limited lateral
// velocity, speed-dependent steering, handbrake drifting.
// All units are SI (metres, seconds, radians). y grows southward.

export interface CarInput {
  throttle: number;   // 0..1
  brake: number;      // 0..1 (brake / reverse)
  steer: number;      // -1 (left) .. 1 (right)
  handbrake: boolean;
}

export interface SurfaceParams {
  topSpeed: number;   // soft speed limit for this surface (m/s)
  grip: number;       // 1 = dry asphalt
  drag: number;       // extra rolling drag (m/s²)
}

export interface Handling {
  length: number; width: number; wheelBase: number;
  accel: number;        // peak engine acceleration m/s²
  vmax: number;         // engine-limited top speed m/s
  brake: number;        // braking decel m/s²
  reverseMax: number;   // m/s
  maxSteer: number;     // rad at standstill
  steerFalloff: number; // speed (m/s) where max steer halves
  mu: number;           // tyre friction coefficient
}

export const DEFAULT_CAR: Handling = {
  length: 4.6, width: 1.95, wheelBase: 2.75,
  accel: 8.5, vmax: 62, brake: 12, reverseMax: 11,
  maxSteer: 0.62, steerFalloff: 15, mu: 1.15,
};

const G = 9.81;

export class Car {
  x = 0; y = 0; heading = 0;
  vx = 0; vy = 0;
  omega = 0;
  steerAngle = 0;
  scale = 1.6; // visual + collision scale (miniature-world exaggeration)
  h: Handling;

  // telemetry for rendering/HUD
  vLong = 0; vLat = 0;
  braking = false; reversing = false; sliding = 0; handbrake = false;
  impact = 0;
  private rearGrip = 1;

  constructor(h: Handling = DEFAULT_CAR) { this.h = h; }

  get speed() { return Math.hypot(this.vx, this.vy); }
  get length() { return this.h.length * this.scale; }
  get width() { return this.h.width * this.scale; }

  place(x: number, y: number, heading: number) {
    this.x = x; this.y = y; this.heading = heading;
    this.vx = this.vy = this.omega = this.steerAngle = 0;
  }

  step(dt: number, inp: CarInput, surf: SurfaceParams, steerDt: number) {
    const h = this.h;
    const fx = Math.cos(this.heading), fy = Math.sin(this.heading);
    const rx = -fy, ry = fx;
    let vLong = this.vx * fx + this.vy * fy;
    let vLat = this.vx * rx + this.vy * ry;
    const spd = Math.abs(vLong);

    // --- steering (rate-limited in real time so it feels the same at any game speed)
    // lock shrinks with speed and never asks for much more than the tyres can give
    // (L·μg/v² is the steady-state steer angle at the grip limit)
    const Lw = h.wheelBase * (0.5 + 0.5 * this.scale);
    const gripLimit = (Lw * h.mu * G * surf.grip * 1.6) / Math.max(1, spd * spd);
    const maxSteer = Math.min(h.maxSteer / (1 + Math.pow(spd / h.steerFalloff, 1.25)), Math.max(0.02, gripLimit));
    const target = inp.steer * (inp.handbrake ? Math.min(h.maxSteer, maxSteer * 2.2) : maxSteer);
    const rate = (Math.abs(target) < Math.abs(this.steerAngle) ? 7 : 4.2) * steerDt;
    this.steerAngle += Math.max(-rate, Math.min(rate, target - this.steerAngle));

    // --- longitudinal
    let a = 0;
    this.braking = false;
    this.reversing = false;
    if (inp.throttle > 0) {
      if (vLong < -0.4) { a += h.brake * inp.throttle; this.braking = true; }
      else {
        const lim = Math.min(h.vmax, surf.topSpeed * 1.04);
        const f = Math.max(0, 1 - Math.pow(Math.max(0, vLong) / lim, 2.2));
        a += h.accel * inp.throttle * f * Math.min(1, 0.55 + surf.grip * 0.45);
      }
    }
    if (inp.brake > 0) {
      if (vLong > 0.4) { a -= h.brake * inp.brake * Math.min(1, surf.grip + 0.1); this.braking = true; }
      else if (vLong > -h.reverseMax) { a -= 5 * inp.brake; this.reversing = true; }
    }
    // resistances
    const sgn = Math.sign(vLong);
    a -= sgn * (0.28 + surf.drag + 0.00065 * vLong * vLong);
    if (spd > surf.topSpeed) a -= sgn * (spd - surf.topSpeed) * 0.9; // soft limiter
    if (inp.handbrake) a -= sgn * Math.min(spd / dt, 5.5);
    const nv = vLong + a * dt;
    // don't let resistance flip direction
    if (inp.throttle === 0 && inp.brake === 0 && Math.sign(nv) !== Math.sign(vLong) && vLong !== 0) vLong = 0;
    else if (this.braking && Math.sign(nv) !== Math.sign(vLong)) vLong = 0;
    else vLong = nv;

    // --- lateral & yaw: dynamic bicycle model (front/rear slip angles with
    // saturating tyre forces). Handbrake cuts rear grip → oversteer / drift.
    const L = h.wheelBase * (0.5 + 0.5 * this.scale);
    const la = L * 0.46, lb = L * 0.54;            // CG → front / rear axle
    const m = 1450, Iz = 0.21 * m * L * L;
    const mu = h.mu * surf.grip;
    const Nf = (m * G * lb) / L, Nr = (m * G * la) / L;
    const hb = inp.handbrake && spd > 2;
    // traction circle: hard throttle/brake eats into rear lateral grip a little
    const longUse = Math.min(0.6, Math.abs(a) / (mu * G + 1e-6) * 0.5);
    // rear grip falls quickly when the handbrake is pulled and returns smoothly
    // (avoids a violent snap-back when it is released mid-slide)
    const rgT = hb ? 0.36 : 1;
    this.rearGrip += (rgT - this.rearGrip) * (1 - Math.exp(-steerDt * (hb ? 14 : 2.6)));
    const Ff = mu * Nf, Fr = mu * Nr * this.rearGrip * (1 - longUse * 0.5);
    const Cf = 11 * Nf, Cr = 12.5 * Nr;
    let r = this.omega;
    const delta = this.steerAngle;
    const kinYaw = (vLong * Math.tan(delta)) / L;
    // blend: kinematic at walking pace and in reverse, dynamic above
    const vTot = Math.hypot(vLong, vLat);
    const w = vLong < -0.5 ? 0 : Math.max(0, Math.min(1, (vTot - 1.5) / 4));
    if (w > 0) {
      const uu = Math.max(vLong, 0.5);
      const af = Math.atan2(vLat + la * r, uu) - delta;
      const ar = Math.atan2(vLat - lb * r, uu);
      const Fyf = -Ff * Math.tanh((Cf * af) / Ff);
      const Fyr = -Fr * Math.tanh((Cr * ar) / Fr);
      const cd = Math.cos(delta);
      vLong += vLat * r * dt;
      vLat += ((Fyf * cd + Fyr) / m - vLong * r) * dt;
      r += ((la * Fyf * cd - lb * Fyr) / Iz) * dt;
      // arcade stability assist: without the handbrake, an extreme slide is
      // gently yawed back toward the direction of travel (keyboard-friendly)
      if (!hb) {
        const beta = Math.atan2(vLat, uu);
        const ex = Math.abs(beta) - 0.3;
        if (ex > 0) r += Math.sign(beta) * ex * 4 * dt;
      }
    }
    if (w < 1) {
      r = r * w + kinYaw * (1 - w);
      vLat *= w + (1 - w) * Math.exp(-dt * 25);
    }
    if (spd < 0.05) r *= 0.5;
    this.omega = r;
    this.sliding = Math.abs(vLat);

    this.vLong = vLong;
    this.vLat = vLat;
    this.handbrake = inp.handbrake;
    this.vx = fx * vLong + rx * vLat;
    this.vy = fy * vLong + ry * vLat;
    this.heading += this.omega * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.impact *= Math.exp(-6 * steerDt);
  }

  /** collision response against a contact normal (pointing out of the obstacle) */
  bounce(nx: number, ny: number) {
    const vn = this.vx * nx + this.vy * ny;
    if (vn >= 0) return;
    const e = 0.25;
    this.vx -= (1 + e) * vn * nx;
    this.vy -= (1 + e) * vn * ny;
    this.vx *= 0.82; this.vy *= 0.82;
    this.omega *= 0.6;
    this.impact = Math.min(1, this.impact + Math.abs(vn) / 18);
  }

  /** points used for collision: front, centre, rear circles */
  circles(): { x: number; y: number; r: number; o: number }[] {
    const fx = Math.cos(this.heading), fy = Math.sin(this.heading);
    const r = this.width * 0.5;
    const o = this.length * 0.5 - r;
    return [
      { x: this.x + fx * o, y: this.y + fy * o, r, o },
      { x: this.x, y: this.y, r, o: 0 },
      { x: this.x - fx * o, y: this.y - fy * o, r, o: -o },
    ];
  }
}
