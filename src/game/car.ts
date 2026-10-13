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
    const maxSteer = h.maxSteer / (1 + Math.pow(spd / h.steerFalloff, 1.25));
    const target = inp.steer * maxSteer * (inp.handbrake ? 1.25 : 1);
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

    // --- lateral grip
    const grip = surf.grip * (inp.handbrake ? 0.32 : 1);
    const maxLat = h.mu * G * grip;
    const want = -vLat;
    const lim = maxLat * dt * (inp.handbrake ? 1 : 1.0);
    const applied = Math.max(-lim, Math.min(lim, want));
    vLat += applied;
    this.sliding = Math.abs(vLat);

    // --- yaw
    const kin = (vLong * Math.tan(this.steerAngle)) / h.wheelBase;
    let yawTarget = kin;
    if (inp.handbrake && spd > 4) yawTarget = kin * 1.7 + inp.steer * 0.25 * Math.sign(vLong);
    // countersteer while sliding lets the player hold a drift
    if (!inp.handbrake && Math.abs(vLat) > 2.5) yawTarget += -vLat * 0.05;
    const yawRate = inp.handbrake ? 5 : 9 * Math.min(1, surf.grip + 0.2);
    this.omega += (yawTarget - this.omega) * Math.min(1, yawRate * dt);
    if (spd < 0.05) this.omega *= 0.5;

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
