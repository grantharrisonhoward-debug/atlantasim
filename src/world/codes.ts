// Feature codes — mirrored from tools/build_world.py (LK / LF / PK).

export const LK = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, residential: 5,
  minor: 6, service: 7, serviceMinor: 8, roadUnknown: 9, pedestrian: 10,
  path: 11, sidewalk: 12, rail: 13, metro: 14, tram: 15, stream: 16, river: 17,
  ditch: 18, waterEdge: 19, crosswalk: 20,
} as const;

export const LF = {
  link: 1, bridge: 2, tunnel: 4, oneway: 8, onewayRev: 16, construction: 32, private: 64,
} as const;

export const PK = {
  residential: 0, commercial: 1, retail: 2, industrial: 3, park: 4, grass: 5, forest: 6,
  shrub: 7, garden: 8, cemetery: 9, golf: 10, fairway: 11, green: 12, sand: 13, pitch: 14,
  track: 15, playground: 16, stadium: 17, school: 18, university: 19, hospital: 20,
  parking: 21, plaza: 22, construction: 23, railway: 24, water: 25, pool: 26,
  religious: 27, nature: 28, recreation: 29, dogpark: 30, farm: 31, bridgeDeck: 32,
} as const;

/** Road kinds a car can legally drive on (used for surface detection & routing snap). */
export function isDrivable(kind: number): boolean {
  return kind <= LK.roadUnknown;
}

export function isRoad(kind: number): boolean {
  return kind <= LK.sidewalk;
}

export const ROAD_CLASS_NAME: Record<number, string> = {
  0: 'Interstate / Freeway', 1: 'Highway', 2: 'Arterial', 3: 'Arterial', 4: 'Collector',
  5: 'Local street', 6: 'Local street', 7: 'Service road', 8: 'Driveway / lot', 9: 'Road',
  10: 'Pedestrian street', 11: 'Path', 12: 'Sidewalk',
};
