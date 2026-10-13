// Vehicle roster. Each one is a Handling preset (physics) plus a body style
// for the sprite. "control" is a rough 1–5 rating shown in the picker.

import { DEFAULT_CAR, type Handling } from './car';

export type BodyStyle = 'sedan' | 'hatch' | 'sport' | 'muscle' | 'suv' | 'truck';

export interface Vehicle {
  id: string;
  name: string;
  blurb: string;
  body: BodyStyle;
  stats: { speed: number; accel: number; control: number }; // 1–5
  h: Handling;
}

export const VEHICLES: Vehicle[] = [
  {
    id: 'sedan', name: 'Sedan', body: 'sedan', blurb: 'Balanced and predictable. A good all-rounder.',
    stats: { speed: 3, accel: 3, control: 4 },
    h: DEFAULT_CAR,
  },
  {
    id: 'hatch', name: 'City Hatch', body: 'hatch', blurb: 'Slow but nimble and very forgiving. Hard to spin.',
    stats: { speed: 2, accel: 2, control: 5 },
    h: { ...DEFAULT_CAR, length: 3.95, width: 1.75, wheelBase: 2.45, accel: 7, vmax: 50, brake: 12.5, maxSteer: 0.7,
      steerFalloff: 17, mu: 1.15, mass: 1150, frontGrip: 1.02, rearGrip: 1.12, handbrakeGrip: 0.45, assist: 7, steerRate: 1.15, topMul: 0.85 },
  },
  {
    id: 'sport', name: 'Sports Coupe', body: 'sport', blurb: 'Very fast with lots of grip, but twitchy at the limit.',
    stats: { speed: 5, accel: 5, control: 3 },
    h: { ...DEFAULT_CAR, length: 4.45, width: 1.92, wheelBase: 2.6, accel: 12, vmax: 78, brake: 14.5, maxSteer: 0.6,
      steerFalloff: 17, mu: 1.32, mass: 1350, frontGrip: 1.05, rearGrip: 0.96, handbrakeGrip: 0.32, assist: 2.5, steerRate: 1.35, topMul: 1.25 },
  },
  {
    id: 'muscle', name: 'Muscle Car', body: 'muscle', blurb: 'Huge power, loose rear end. Drifts easily and bites back.',
    stats: { speed: 4, accel: 5, control: 2 },
    h: { ...DEFAULT_CAR, length: 4.95, width: 1.98, wheelBase: 2.85, accel: 11, vmax: 72, brake: 10.5, maxSteer: 0.56,
      steerFalloff: 14, mu: 1.05, mass: 1650, frontGrip: 1, rearGrip: 0.8, handbrakeGrip: 0.24, assist: 0.8, steerRate: 1, topMul: 1.15 },
  },
  {
    id: 'suv', name: 'SUV', body: 'suv', blurb: 'Heavy and planted. Leans toward understeer, very stable.',
    stats: { speed: 3, accel: 2, control: 4 },
    h: { ...DEFAULT_CAR, length: 4.9, width: 2.05, wheelBase: 2.9, accel: 7.2, vmax: 56, brake: 10, maxSteer: 0.55,
      steerFalloff: 13, mu: 0.98, mass: 2100, frontGrip: 0.92, rearGrip: 1.25, handbrakeGrip: 0.5, assist: 8, steerRate: 0.85, topMul: 0.95 },
  },
  {
    id: 'truck', name: 'Box Truck', body: 'truck', blurb: 'Slow, wide and sluggish to steer. Almost impossible to spin.',
    stats: { speed: 1, accel: 1, control: 3 },
    h: { ...DEFAULT_CAR, length: 7.2, width: 2.45, wheelBase: 4.3, accel: 4.6, vmax: 40, brake: 7.5, reverseMax: 8, maxSteer: 0.55,
      steerFalloff: 11, mu: 0.88, mass: 4200, frontGrip: 0.95, rearGrip: 1.35, handbrakeGrip: 0.7, assist: 10, steerRate: 0.7, topMul: 0.75 },
  },
];

export function vehicleById(id: string): Vehicle {
  return VEHICLES.find((v) => v.id === id) ?? VEHICLES[0];
}
