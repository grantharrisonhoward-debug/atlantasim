// "Peachtree" map style — a warm, muted cartographic palette.
// All widths are real-world metres; `minPx` are CSS-pixel floors so roads
// remain legible when zoomed out.

import { LK, PK } from '../world/codes';

export const C = {
  land: '#F1EDE4',
  outside: '#E4DFD5',
  outsideEdge: 'rgba(120,100,80,0.18)',
  building: '#E2DACD',
  buildingTall: '#DCD6CF',
  buildingStroke: 'rgba(150,132,110,0.45)',
  buildingShadow: '#5E4C3C',
  water: '#A6CDE0',
  waterEdge: '#8EBCD4',
  waterLine: '#9FC8DD',
  pool: '#B5DFEE',
};

export const AREA_FILL: Record<number, string> = {
  [PK.residential]: '#EEE9DF',
  [PK.commercial]: '#F0E7E0',
  [PK.retail]: '#F2E6DF',
  [PK.industrial]: '#E9E6EA',
  [PK.railway]: '#E7E3DF',
  [PK.construction]: '#ECE4D4',
  [PK.school]: '#F1E9D6',
  [PK.university]: '#EFE6D3',
  [PK.hospital]: '#F2E2DF',
  [PK.religious]: '#ECE6DC',
  [PK.farm]: '#EAE8D0',
  [PK.recreation]: '#D9E8CA',
  [PK.park]: '#CFE3BE',
  [PK.nature]: '#C4DCB0',
  [PK.dogpark]: '#D3E5C2',
  [PK.cemetery]: '#D6E1C8',
  [PK.golf]: '#D2E6BE',
  [PK.grass]: '#D8E8C6',
  [PK.forest]: 'rgba(170,205,148,0.55)',
  [PK.shrub]: 'rgba(196,220,176,0.35)',
  [PK.garden]: '#CAE2B5',
  [PK.fairway]: '#C3DFAA',
  [PK.green]: '#B5DA9C',
  [PK.sand]: '#F0E4C2',
  [PK.pitch]: '#BEDCA6',
  [PK.track]: '#E1B9A2',
  [PK.playground]: '#E3EBCD',
  [PK.stadium]: '#E8E1D5',
  [PK.plaza]: '#F6F3EE',
  [PK.parking]: '#E6E2DB',
  [PK.water]: C.water,
  [PK.pool]: C.pool,
};

/** paint order for areas (low → high) */
export const AREA_ORDER: number[] = [
  PK.residential, PK.commercial, PK.retail, PK.industrial, PK.railway, PK.construction,
  PK.school, PK.university, PK.hospital, PK.religious, PK.farm,
  PK.forest, PK.shrub,
  PK.recreation, PK.park, PK.nature, PK.dogpark, PK.cemetery, PK.golf, PK.grass,
  PK.garden, PK.fairway, PK.green, PK.sand, PK.pitch, PK.track, PK.playground, PK.stadium,
  PK.plaza, PK.parking, PK.water, PK.pool,
];

/** which areas grow trees, and how densely (0..1) */
export const TREE_DENSITY: Record<number, number> = {
  [PK.forest]: 0.62, [PK.nature]: 0.75, [PK.park]: 0.4, [PK.cemetery]: 0.28,
  [PK.golf]: 0.22, [PK.garden]: 0.3, [PK.dogpark]: 0.15, [PK.recreation]: 0.12, [PK.shrub]: 0.1,
};

export interface RoadStyle {
  w: number;        // metres
  minPx: number;    // CSS px floor
  fill: string;
  casing: string | null;
  casingPx: number; // casing extra width each side (CSS px floor)
  maxMpp: number;   // hide above this CSS metres-per-pixel
  dash?: number[];  // fill dash in CSS px
}

const S = (w: number, minPx: number, fill: string, casing: string | null, casingPx: number, maxMpp: number, dash?: number[]): RoadStyle =>
  ({ w, minPx, fill, casing, casingPx, maxMpp, dash });

export const ROAD: Record<string, RoadStyle> = {
  motorway: S(17, 2.4, '#F2B48C', '#C98258', 0.9, 1e9),
  motorway_link: S(7.5, 1.4, '#F5C7A6', '#D0946C', 0.75, 30),
  trunk: S(14, 2.1, '#F6D29F', '#D2A66A', 0.8, 1e9),
  trunk_link: S(7, 1.2, '#F8DDB6', '#D8B07C', 0.7, 25),
  primary: S(13, 1.8, '#FBE7BF', '#D8BE8A', 0.75, 1e9),
  primary_link: S(7, 1.0, '#FCEDCF', '#DCC59A', 0.6, 12),
  secondary: S(12, 1.5, '#FFF6E2', '#D9CCB2', 0.7, 1e9),
  secondary_link: S(7, 0.9, '#FFF8EA', '#DDD1BA', 0.6, 10),
  tertiary: S(10, 1.2, '#FFFFFF', '#D6CEC0', 0.65, 60),
  residential: S(8, 0.75, '#FFFFFF', '#DCD5C9', 0.55, 40),
  minor: S(7, 0.7, '#FFFFFF', '#DCD5C9', 0.55, 30),
  service: S(5, 0.5, '#FBFAF7', '#E0DACF', 0.45, 6),
  serviceMinor: S(3.6, 0.4, '#FAF8F4', '#E2DCD2', 0.4, 2.5),
  roadUnknown: S(4.5, 0.5, '#FAF8F4', '#E0DACF', 0.45, 5),
  pedestrian: S(6, 0.6, '#F8F4EE', '#E2D9CC', 0.45, 4),
  path: S(1.8, 0.7, '#E2D6C3', null, 0, 2.2, [2.2, 1.6]),
  beltline: S(4, 1.3, '#8FBF73', '#FFFFFF', 0.7, 8),
  sidewalk: S(1.5, 0.5, '#F7F4EE', '#E6E0D5', 0.3, 0.55),
};

export function roadStyleKey(kind: number, link: boolean, beltline: boolean): string {
  switch (kind) {
    case LK.motorway: return link ? 'motorway_link' : 'motorway';
    case LK.trunk: return link ? 'trunk_link' : 'trunk';
    case LK.primary: return link ? 'primary_link' : 'primary';
    case LK.secondary: return link ? 'secondary_link' : 'secondary';
    case LK.tertiary: return link ? 'secondary_link' : 'tertiary';
    case LK.residential: return 'residential';
    case LK.minor: return 'minor';
    case LK.service: return 'service';
    case LK.serviceMinor: return 'serviceMinor';
    case LK.roadUnknown: return 'roadUnknown';
    case LK.pedestrian: return 'pedestrian';
    case LK.path: return beltline ? 'beltline' : 'path';
    case LK.sidewalk: return 'sidewalk';
  }
  return 'roadUnknown';
}

/** painter order of road styles (low → high) */
export const ROAD_ORDER = [
  'sidewalk', 'path', 'serviceMinor', 'roadUnknown', 'service', 'pedestrian', 'beltline', 'minor', 'residential',
  'secondary_link', 'tertiary', 'primary_link', 'secondary', 'primary', 'trunk_link', 'trunk',
  'motorway_link', 'motorway',
];

export const RAIL = {
  rail: { w: 2.2, minPx: 0.8, color: '#BDB4A8', tie: '#F6F2EC', maxMpp: 1e9 },
  metro: { w: 3.2, minPx: 0.9, color: '#ADA6BF', tie: '#F3F1F6', maxMpp: 1e9 },
  tram: { w: 1.4, minPx: 0.6, color: '#C3B8AA', tie: null, maxMpp: 4 },
};
