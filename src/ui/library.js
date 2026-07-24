import { DEFAULT_SCENES } from '../data/default-scenes.js';

const ADDED_KEY = 'splathike.scenes.added.v1';
const REMOVED_BUILTIN_KEY = 'splathike.scenes.removedBuiltin.v1';

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// Merges the prefilled demo scenes with whatever the user has added/removed
// in this browser. Built-ins are never mutated on disk — removing one just
// records its id in a "hidden" set, so re-adding it (or clearing storage)
// brings it back.
export class SceneLibrary {
  constructor() {
    this.added = loadJson(ADDED_KEY, []);
    this.removedBuiltin = new Set(loadJson(REMOVED_BUILTIN_KEY, []));
  }

  list() {
    const builtins = DEFAULT_SCENES
      .filter((s) => !this.removedBuiltin.has(s.id))
      .map((s) => ({ ...s, builtin: true }));
    return [...builtins, ...this.added.map((s) => ({ ...s, builtin: false }))];
  }

  add({ url, name, rotY, scale, file }) {
    const entry = {
      id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: name || url || (file ? file.name : 'Untitled scene'),
      url: url || null,
      rotY: Number.isFinite(rotY) ? rotY : 180,
      scale: Number.isFinite(scale) ? scale : 1,
      isLocalFile: !!file,
    };
    // Local files can't be persisted to localStorage (no durable file
    // handle) — they're usable for this session only, added to the
    // in-memory list but not written to disk.
    if (file) {
      entry._file = file;
      this._sessionOnly = this._sessionOnly || [];
      this._sessionOnly.push(entry);
      return entry;
    }
    this.added.push(entry);
    saveJson(ADDED_KEY, this.added);
    return entry;
  }

  remove(entry) {
    if (entry.builtin) {
      this.removedBuiltin.add(entry.id);
      saveJson(REMOVED_BUILTIN_KEY, [...this.removedBuiltin]);
      return;
    }
    this.added = this.added.filter((s) => s.id !== entry.id);
    saveJson(ADDED_KEY, this.added);
    if (this._sessionOnly) this._sessionOnly = this._sessionOnly.filter((s) => s.id !== entry.id);
  }

  listWithSessionOnly() {
    return [...this.list(), ...(this._sessionOnly || []).map((s) => ({ ...s, builtin: false }))];
  }
}
