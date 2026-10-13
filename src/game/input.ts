// Keyboard (+ optional gamepad) input with smoothed analogue axes.

import type { CarInput } from './car';

export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  wheel = 0;
  enabled = true;
  private steer = 0;
  private throttle = 0;
  private brake = 0;

  constructor(target: HTMLElement | Window = window) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.keys.delete(k);
    });
    window.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('wheel', (e) => {
      const we = e as WheelEvent;
      we.preventDefault();
      this.wheel += we.deltaMode === 1 ? we.deltaY * 30 : we.deltaY;
    }, { passive: false });
  }

  down(k: string) { return this.keys.has(k); }
  /** true once per key press */
  hit(k: string) {
    if (this.pressed.has(k)) { this.pressed.delete(k); return true; }
    return false;
  }
  endFrame() { this.pressed.clear(); this.wheel = 0; }

  read(dt: number): CarInput {
    if (!this.enabled) return { throttle: 0, brake: 0, steer: 0, handbrake: false };
    const up = this.down('w') || this.down('ArrowUp');
    const dn = this.down('s') || this.down('ArrowDown');
    const lf = this.down('a') || this.down('ArrowLeft');
    const rt = this.down('d') || this.down('ArrowRight');
    let hb = this.down(' ');
    let steerT = (rt ? 1 : 0) - (lf ? 1 : 0);
    let thrT = up ? 1 : 0, brkT = dn ? 1 : 0;
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) steerT = ax;
      const rtB = p.buttons[7]?.value ?? 0, ltB = p.buttons[6]?.value ?? 0;
      if (rtB > 0.05) thrT = rtB;
      if (ltB > 0.05) brkT = ltB;
      if (p.buttons[0]?.pressed || p.buttons[1]?.pressed) hb = true;
      break;
    }
    // smooth digital inputs so steering and throttle feel analogue
    const k = 1 - Math.exp(-dt * 10);
    this.steer += (steerT - this.steer) * (steerT === 0 ? 1 - Math.exp(-dt * 14) : k);
    this.throttle += (thrT - this.throttle) * (1 - Math.exp(-dt * 8));
    this.brake += (brkT - this.brake) * (1 - Math.exp(-dt * 12));
    return {
      throttle: this.throttle < 0.02 ? 0 : this.throttle,
      brake: this.brake < 0.02 ? 0 : this.brake,
      steer: Math.abs(this.steer) < 0.01 ? 0 : this.steer,
      handbrake: hb,
    };
  }
}
