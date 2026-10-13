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

// ---------------------------------------------------------------- themes --
// A theme bundles every colour/treatment decision of the tile renderer.
// 'map' is the cartographic style above; 'real' is a simplified, arcade-style
// take on how the city looks from the air (asphalt roads, lawns, shingle
// roofs, tree canopy) — drawn entirely from the vector data, no imagery.

export interface Theme {
  id: 'map' | 'real';
  land: string;
  outside: string; outsideAlpha: number; outsideEdge: string;
  area: Record<number, string>;
  areaOrder: number[];
  treeDensity: Record<number, number>;
  treeTones: string[]; treeShadow: string; treeHighlight: string; treeSize: number; treeMaxMpp: number;
  road: Record<string, RoadStyle>;
  curbM: number;              // casing width each side (metres) at close zoom
  bridgeCasing: (casing: string) => string;
  bridgeShadow: string;
  tunnelAlpha: number;
  rail: typeof RAIL;
  railBridge: string;
  water: { line: string; edge: string; edgeW: number };
  pitchLine: string; parkingEdge: string; trackLine: string; poolEdge: string | null;
  building: {
    tones: string[]; tall: string; houses: string[] | null; stroke: string;
    shadow: string; shadowAlpha: number; shadowLen: number; bevel: boolean; shadowMaxMpp: number;
  };
  marks: { maxMpp: number; center: string; lane: string; cross: string; oneway: string; parkingStripes: boolean };
  grain: { alpha: number; dark: string; light: string } | null;
  labels: { street: string; streetMajor: string; halo: string; hood: string; hoodBig: string; hoodHalo: string; park: string; parkHalo: string; water: string; waterHalo: string };
}

function shadeHex(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

export const THEME_MAP: Theme = {
  id: 'map',
  land: C.land,
  outside: C.outside, outsideAlpha: 0.82, outsideEdge: C.outsideEdge,
  area: AREA_FILL,
  areaOrder: AREA_ORDER,
  treeDensity: TREE_DENSITY,
  treeTones: ['#9CC387', '#A7CB91', '#93BB7F', '#AFCF98', '#8FB67D'],
  treeShadow: 'rgba(70,95,50,0.20)', treeHighlight: 'rgba(255,255,240,0.20)', treeSize: 1, treeMaxMpp: 1.4,
  road: ROAD,
  curbM: 0.45,
  bridgeCasing: (c) => shadeHex(c, -0.12),
  bridgeShadow: 'rgba(60,40,20,0.30)',
  tunnelAlpha: 0.5,
  rail: RAIL,
  railBridge: '#D9D2C7',
  water: { line: C.waterLine, edge: C.waterEdge, edgeW: 0.5 },
  pitchLine: 'rgba(255,255,255,0.75)', parkingEdge: '#D8D2C8', trackLine: 'rgba(255,255,255,0.55)', poolEdge: null,
  building: {
    tones: ['#E2DACD', '#E5DED3', '#DED6C8', '#E3DCD0'], tall: C.buildingTall, houses: null, stroke: C.buildingStroke,
    shadow: C.buildingShadow, shadowAlpha: 0.17, shadowLen: 0.24, bevel: false, shadowMaxMpp: 2.6,
  },
  marks: { maxMpp: 0.45, center: 'rgba(232,196,110,0.85)', lane: 'rgba(255,255,255,0.8)', cross: 'rgba(196,184,166,0.7)', oneway: 'rgba(160,145,125,0.55)', parkingStripes: false },
  grain: null,
  labels: {
    street: '#665B4E', streetMajor: '#5A4E40', halo: 'rgba(255,255,255,0.92)',
    hood: '#857767', hoodBig: '#6E6152', hoodHalo: 'rgba(250,247,240,0.92)',
    park: '#4B7A41', parkHalo: 'rgba(240,247,232,0.85)', water: '#3F7698', waterHalo: 'rgba(220,238,246,0.85)',
  },
};

// realistic palette: asphalt, concrete curbs, lawns, deep water, shingle roofs
const REAL_ROAD_COLORS: Record<string, [string, string | null]> = {
  motorway: ['#55575C', '#E6E3DC'], motorway_link: ['#5C5E62', '#DAD6CE'],
  trunk: ['#5A5C60', '#D8D4CB'], trunk_link: ['#5F6165', '#CFCBC2'],
  primary: ['#5E6064', '#B9B4AA'], primary_link: ['#636569', '#B9B4AA'],
  secondary: ['#626468', '#BBB6AC'], secondary_link: ['#66686B', '#BBB6AC'],
  tertiary: ['#66686C', '#BDB8AE'], residential: ['#6B6D70', '#BEB9AF'], minor: ['#6E7073', '#BEB9AF'],
  service: ['#74767A', '#B3AEA4'], serviceMinor: ['#7A7C7F', null], roadUnknown: ['#77797C', null],
  pedestrian: ['#C2BBAD', '#A9A397'], path: ['#C9C1B1', null], beltline: ['#D2CBBE', '#9C9689'], sidewalk: ['#C4BFB5', null],
};
const REAL_ROAD: Record<string, RoadStyle> = Object.fromEntries(
  Object.entries(ROAD).map(([k, st]) => {
    const [fill, casing] = REAL_ROAD_COLORS[k] ?? [st.fill, st.casing];
    // freeway "casing" reads as painted edge lines: keep it thin
    const casingPx = k.startsWith('motorway') || k.startsWith('trunk') ? 0.45 : st.casingPx;
    return [k, { ...st, fill, casing, casingPx, dash: k === 'path' ? undefined : st.dash }];
  }),
);

export const THEME_REAL: Theme = {
  id: 'real',
  land: '#8E9B69',
  outside: '#4A5045', outsideAlpha: 0.6, outsideEdge: 'rgba(255,255,255,0.25)',
  area: {
    [PK.residential]: '#8C9A66', [PK.commercial]: '#A3A196', [PK.retail]: '#A6A398', [PK.industrial]: '#9C9A93',
    [PK.railway]: '#8F887D', [PK.construction]: '#B09B78', [PK.school]: '#93A06C', [PK.university]: '#93A06C',
    [PK.hospital]: '#A4A297', [PK.religious]: '#97A070', [PK.farm]: '#A5A36A', [PK.recreation]: '#82A457',
    [PK.park]: '#7DA352', [PK.nature]: '#6A9244', [PK.dogpark]: '#88A65B', [PK.cemetery]: '#7D9A56',
    [PK.golf]: '#7FAA50', [PK.grass]: '#82A856', [PK.forest]: 'rgba(58,92,44,0.7)', [PK.shrub]: 'rgba(80,118,58,0.35)',
    [PK.garden]: '#749F4C', [PK.fairway]: '#86B955', [PK.green]: '#72B04A', [PK.sand]: '#E0CE9A',
    [PK.pitch]: '#6DA246', [PK.track]: '#B05440', [PK.playground]: '#A89E70', [PK.stadium]: '#9A988F',
    [PK.plaza]: '#C4BDAF', [PK.parking]: '#76787B', [PK.water]: '#2E6483', [PK.pool]: '#4DB5DC',
  },
  areaOrder: AREA_ORDER,
  treeDensity: {
    [PK.forest]: 0.9, [PK.nature]: 0.9, [PK.park]: 0.5, [PK.cemetery]: 0.38, [PK.golf]: 0.24, [PK.garden]: 0.45,
    [PK.dogpark]: 0.2, [PK.recreation]: 0.14, [PK.shrub]: 0.2, [PK.residential]: 0.2, [PK.school]: 0.12, [PK.religious]: 0.15,
  },
  treeTones: ['#3E6A33', '#4A7A3C', '#38602F', '#56813F', '#44703A'],
  treeShadow: 'rgba(12,28,10,0.42)', treeHighlight: 'rgba(210,235,160,0.20)', treeSize: 1.15, treeMaxMpp: 2.2,
  road: REAL_ROAD,
  curbM: 0.9,
  bridgeCasing: () => '#C9C5BC',
  bridgeShadow: 'rgba(0,0,0,0.5)',
  tunnelAlpha: 0.35,
  rail: {
    rail: { w: 3.4, minPx: 0.9, color: '#8A8174', tie: '#4E4842', maxMpp: 1e9 },
    metro: { w: 3.6, minPx: 1.0, color: '#8C8579', tie: '#47423D', maxMpp: 1e9 },
    tram: { w: 1.6, minPx: 0.6, color: '#77736C', tie: null, maxMpp: 4 },
  },
  railBridge: '#BDB8AE',
  water: { line: '#356D8C', edge: '#6C98AE', edgeW: 1.4 },
  pitchLine: 'rgba(255,255,255,0.85)', parkingEdge: '#B4B1AB', trackLine: 'rgba(255,255,255,0.7)', poolEdge: '#E8F3F6',
  building: {
    tones: ['#B3B1AB', '#C6C4BE', '#A09E99', '#D3D1CB', '#ABA69C'], tall: '#8E9299',
    houses: ['#6A6561', '#7B746B', '#5D5956', '#8A7E71', '#6F625A', '#827A72'],
    stroke: 'rgba(30,30,30,0.35)',
    shadow: '#141A20', shadowAlpha: 0.38, shadowLen: 0.36, bevel: true, shadowMaxMpp: 3.5,
  },
  marks: { maxMpp: 0.9, center: '#E2B93B', lane: 'rgba(245,245,240,0.9)', cross: 'rgba(240,240,236,0.9)', oneway: 'rgba(240,240,236,0.75)', parkingStripes: true },
  grain: { alpha: 0.16, dark: '#2E3A1E', light: '#D7D9B0' },
  labels: {
    street: '#FFFFFF', streetMajor: '#FFFFFF', halo: 'rgba(28,30,32,0.78)',
    hood: '#F4F1E8', hoodBig: '#FFFFFF', hoodHalo: 'rgba(24,28,22,0.72)',
    park: '#E7F3D6', parkHalo: 'rgba(24,40,18,0.75)', water: '#DDF0FA', waterHalo: 'rgba(14,40,58,0.75)',
  },
};

export const THEMES: Record<string, Theme> = { map: THEME_MAP, real: THEME_REAL };
