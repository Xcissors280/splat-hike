const KEY = 'splathike.settings.v1';

const DEFAULTS = {
  // Relative amount (0-1), not a raw exp2 density — community scans have
  // wildly inconsistent coordinate scale (some scenes span ~30 units,
  // others ~300 for a similarly-sized area), so a fixed absolute density
  // looks totally different per scene. main.js scales this by the actual
  // measured scene size before applying it. See applyFogForScene().
  fogDensity: 0.35,
  fogColor: '#b9c8bd',
  skyTop: '#4f7fb8',
  skyHorizon: '#cfd9c8',
  walkSpeed: 1.8,
  mouseSens: 0.35,
  voxelSize: 0.12,
  quality: 'balanced', // high | balanced | perf -> gsplat.lodRangeMax
  ambientVolume: 0.5,
  muted: false,
  autoAdvanceEnabled: true,
  autoAdvanceSensitivity: 0.5,
};

export const QUALITY_LOD_MAX = { high: 99, balanced: 60, perf: 25 };

export class SettingsStore {
  constructor() {
    this.values = { ...DEFAULTS };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(this.values, JSON.parse(raw));
    } catch { /* ignore corrupt storage */ }
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    this.values[key] = value;
    this.save();
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* storage full/unavailable */ }
  }
}
