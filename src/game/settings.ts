export interface Settings {
  cameraMode: 'north' | 'car';
  timeScale: number;
  carScale: number;
  lookAhead: number;
  speedZoom: number;
  showCoords: number;
  quality: number;
  color: string;
}

const DEFAULTS: Settings = {
  cameraMode: 'north', timeScale: 1.5, carScale: 1.8, lookAhead: 1, speedZoom: 1, showCoords: 1, quality: 2, color: 'peach',
};

const KEY = 'atlantasim.settings.v1';

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...s };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
