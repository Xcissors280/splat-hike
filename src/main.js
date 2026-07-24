import { createApp, createCamera, createSky, applyFog } from './core/app.js';
import { InputManager } from './core/input.js';
import { createSceneManager } from './core/scene-loader.js';
import { SettingsStore, QUALITY_LOD_MAX } from './core/settings-store.js';
import { SceneLibrary } from './ui/library.js';
import { buildVoxelCollider } from './physics/voxel-collider.js';
import { WalkController } from './physics/walk-controller.js';
import { findSpawnPoint } from './physics/spawn-finder.js';
import { AutoAdvance } from './core/autoadvance.js';
import { AmbientAudio } from './audio/ambient-audio.js';

// ---------------------------------------------------------------- bootstrap
const canvas = document.getElementById('glcanvas');
const app = createApp(canvas);
const camera = createCamera(app);
const sky = createSky(app);
const settings = new SettingsStore();
const library = new SceneLibrary();
const sceneManager = createSceneManager(app);
const walker = new WalkController(settings);
const autoAdvance = new AutoAdvance(settings);
const audio = new AmbientAudio();
const input = new InputManager(canvas, settings);

let currentIndex = -1;
let inHike = false;

sky.setColors(settings.get('skyTop'), settings.get('skyHorizon'));
let currentSceneScale = 30; // updated per-scene once bounds are known; reasonable default for the menu background
applyFogForScene();

// Fog density is stored as a 0-1 "relative amount", not a raw exp2 density
// — see settings-store.js. Scaling it by the scene's own measured extent
// means the same slider position looks similar regardless of whether this
// particular scan's coordinates happen to be in meters, or some 10x/100x
// arbitrary reconstruction unit.
function applyFogForScene() {
  const relative = settings.get('fogDensity');
  const density = (relative * 3) / currentSceneScale;
  applyFog(app, { color: settings.get('fogColor'), density });
}

// ------------------------------------------------------------------- DOM
const el = (id) => document.getElementById(id);
const menu = el('menu');
const loading = el('loading');
const loadingText = el('loadingText');
const hud = el('hud');
const sceneListEl = el('sceneList');
const addDialog = el('addDialog');
const settingsPanel = el('settingsPanel');
const nextSceneHint = el('nextSceneHint');
const clickToLook = el('clickToLook');
const crashToast = el('crashToast');

function showToast(msg) {
  crashToast.textContent = msg;
  crashToast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { crashToast.hidden = true; }, 2600);
}

// ------------------------------------------------------------ scene list UI
function renderSceneList() {
  const scenes = library.listWithSessionOnly();
  sceneListEl.innerHTML = '';
  for (const entry of scenes) {
    const item = document.createElement('div');
    item.className = 'scene-item' + (entry.builtin ? ' builtin' : '');
    item.innerHTML = `
      <div class="thumb">🥾</div>
      <div class="meta">
        <div class="name">${escapeHtml(entry.name)}</div>
        <div class="src">${escapeHtml(entry.author ? 'by ' + entry.author : (entry.isLocalFile ? 'local file' : entry.url || ''))}</div>
      </div>
      <button class="remove-btn" title="Remove">✕</button>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.remove-btn')) return;
      startHike(entry);
    });
    item.querySelector('.remove-btn').addEventListener('click', () => {
      library.remove(entry);
      renderSceneList();
    });
    sceneListEl.appendChild(item);
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
renderSceneList();

// --------------------------------------------------------------- add scene
el('addSceneBtn').addEventListener('click', () => {
  el('addUrlInput').value = '';
  el('addNameInput').value = '';
  el('addRotY').value = 180;
  el('addScale').value = 1;
  el('addStatus').textContent = '';
  addDialog.hidden = false;
});
el('addCancelBtn').addEventListener('click', () => { addDialog.hidden = true; });
el('addConfirmBtn').addEventListener('click', () => {
  const url = el('addUrlInput').value.trim();
  if (!url) { el('addStatus').textContent = 'Paste a link or URL first.'; el('addStatus').className = 'load-status error'; return; }
  const name = el('addNameInput').value.trim();
  const rotY = parseFloat(el('addRotY').value);
  const scale = parseFloat(el('addScale').value);
  library.add({ url, name, rotY, scale });
  renderSceneList();
  addDialog.hidden = true;
});

el('fileBtn').addEventListener('click', () => el('fileInput').click());
el('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const entry = library.add({ name: file.name, file, rotY: 180, scale: 1 });
  renderSceneList();
  startHike(entry);
  e.target.value = '';
});

// ----------------------------------------------------------------- settings
function initSettingsUI() {
  el('fogDensity').value = settings.get('fogDensity');
  el('fogColor').value = settings.get('fogColor');
  el('skyTop').value = settings.get('skyTop');
  el('skyHorizon').value = settings.get('skyHorizon');
  el('walkSpeed').value = settings.get('walkSpeed');
  el('mouseSens').value = settings.get('mouseSens');
  el('voxelSize').value = settings.get('voxelSize');
  el('qualitySelect').value = settings.get('quality');
  el('ambientVolume').value = settings.get('ambientVolume');
  el('autoAdvanceEnabled').checked = settings.get('autoAdvanceEnabled');
  el('autoAdvanceSensitivity').value = settings.get('autoAdvanceSensitivity');
}
initSettingsUI();

el('fogDensity').addEventListener('input', (e) => {
  settings.set('fogDensity', parseFloat(e.target.value));
  applyFogForScene();
});
el('fogColor').addEventListener('input', (e) => {
  settings.set('fogColor', e.target.value);
  applyFogForScene();
});
el('skyTop').addEventListener('input', (e) => {
  settings.set('skyTop', e.target.value);
  sky.setColors(settings.get('skyTop'), settings.get('skyHorizon'));
});
el('skyHorizon').addEventListener('input', (e) => {
  settings.set('skyHorizon', e.target.value);
  sky.setColors(settings.get('skyTop'), settings.get('skyHorizon'));
});
el('walkSpeed').addEventListener('input', (e) => settings.set('walkSpeed', parseFloat(e.target.value)));
el('mouseSens').addEventListener('input', (e) => settings.set('mouseSens', parseFloat(e.target.value)));
el('voxelSize').addEventListener('change', (e) => {
  settings.set('voxelSize', parseFloat(e.target.value));
  if (currentEntry && currentKind !== 'lod-meta') rebuildCollider();
});
el('qualitySelect').addEventListener('change', (e) => {
  settings.set('quality', e.target.value);
  sceneManager.applyQuality(QUALITY_LOD_MAX[e.target.value]);
});
el('ambientVolume').addEventListener('input', (e) => {
  settings.set('ambientVolume', parseFloat(e.target.value));
  audio.setVolume(settings.get('muted') ? 0 : parseFloat(e.target.value));
});
el('autoAdvanceEnabled').addEventListener('change', (e) => settings.set('autoAdvanceEnabled', e.target.checked));
el('autoAdvanceSensitivity').addEventListener('input', (e) => settings.set('autoAdvanceSensitivity', parseFloat(e.target.value)));

el('settingsToggle').addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  if (!settingsPanel.hidden && currentEntry) {
    el('rotX').value = currentEntry.rotX ?? 0;
    el('rotY').value = currentEntry.rotY ?? 180;
    el('rotZ').value = currentEntry.rotZ ?? 0;
  }
});

// Live visual feedback while dragging (cheap: just re-orients the entity),
// full recompute (collision, bounds, fog/LOD scale, respawn) only once the
// slider is released — rebuilding the voxel collider on every drag tick
// would stutter badly on a multi-million-point scan.
function previewOrientation() {
  if (!currentEntry) return;
  currentEntry.rotX = parseFloat(el('rotX').value);
  currentEntry.rotY = parseFloat(el('rotY').value);
  currentEntry.rotZ = parseFloat(el('rotZ').value);
  sceneManager.applyTransform(currentEntry);
}
function commitOrientation() {
  if (!currentEntry) return;
  previewOrientation();
  reorientCurrentScene();
}
el('rotX').addEventListener('input', previewOrientation);
el('rotY').addEventListener('input', previewOrientation);
el('rotZ').addEventListener('input', previewOrientation);
el('rotX').addEventListener('change', commitOrientation);
el('rotY').addEventListener('change', commitOrientation);
el('rotZ').addEventListener('change', commitOrientation);
el('closeSettingsBtn').addEventListener('click', () => { settingsPanel.hidden = true; });
el('menuToggle').addEventListener('click', () => { endHike(); });
el('muteToggle').addEventListener('click', () => {
  settings.set('muted', !settings.get('muted'));
  audio.setVolume(settings.get('muted') ? 0 : settings.get('ambientVolume'));
  el('muteToggle').textContent = settings.get('muted') ? '🔇' : '🔊';
});

// --------------------------------------------------------- hike lifecycle
let currentEntry = null;
let currentKind = null;
let currentCollider = null;
let currentBounds = null;
let currentAuthoredTarget = null;

function rebuildCollider() {
  const entity = sceneManager.entity;
  if (!entity) return;
  currentCollider = buildVoxelCollider(entity, settings.get('voxelSize'));
  walker.setCollider(currentCollider);
  if (currentCollider) autoAdvance.reset(boundsFromCollider(currentCollider), currentCollider);
}

function boundsFromCollider(collider) {
  const b = collider.bounds;
  return { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY, minZ: b.minZ, maxZ: b.maxZ };
}

// Called after a manual tilt/turn adjustment (settings → Scene orientation)
// changes the entity's transform out from under everything derived from
// it — collision, bounds, the fog/LOD scale reference, and where the
// player is standing all need to be redone. Mirrors the post-load section
// of startHike(). Note: the authored-target spawn hint isn't re-derived
// here (it was computed once against the original orientation) — a manual
// retilt is a deliberate one-off correction, and fly mode covers repositioning
// afterward if the fallback bbox-center spawn isn't ideal.
function reorientCurrentScene() {
  if (currentKind !== 'lod-meta') rebuildCollider();
  const bounds = currentCollider ? boundsFromCollider(currentCollider) : currentBounds;
  currentBounds = bounds;
  currentSceneScale = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, 5);
  applyFogForScene();
  if (sceneManager.entity?.gsplat) {
    sceneManager.entity.gsplat.lodBaseDistance = currentSceneScale * 0.05;
    sceneManager.entity.gsplat.lodMultiplier = 2.2;
  }
  const spawn = findSpawnPoint(currentCollider, bounds, walker.flatGroundY, null);
  walker.spawnAt(spawn.x, spawn.y, spawn.z);
}

async function startHike(entry) {
  menu.style.display = 'none';
  loading.hidden = false;
  loadingText.textContent = `Loading ${entry.name || 'scene'}…`;
  nextSceneHint.hidden = true;
  input.exitLock();

  try {
    let result;
    if (entry._file || entry.file) {
      result = await sceneManager.loadFromFile(entry._file || entry.file, entry, {
        lodRangeMax: QUALITY_LOD_MAX[settings.get('quality')],
        onStatus: (s) => { if (s) loadingText.textContent = s; },
      });
    } else {
      result = await sceneManager.load(entry, {
        lodRangeMax: QUALITY_LOD_MAX[settings.get('quality')],
        onStatus: (s) => { if (s) loadingText.textContent = s; },
      });
    }

    currentEntry = entry;
    currentKind = result.kind;
    currentIndex = library.listWithSessionOnly().findIndex((s) => s.id === entry.id);

    let spawn;
    if (result.kind !== 'lod-meta') {
      currentCollider = buildVoxelCollider(result.entity, settings.get('voxelSize'));
    } else {
      currentCollider = null;
    }
    walker.setCollider(currentCollider);

    let bounds;
    if (currentCollider) {
      bounds = boundsFromCollider(currentCollider);
    } else if (result.worldBound) {
      bounds = result.worldBound;
    } else {
      bounds = { minX: -10, maxX: 10, minY: -2, maxY: 5, minZ: -10, maxZ: 10 };
    }

    const flatY = (result.groundYHint ?? bounds.minY) + 0.05;
    walker.setFlatGroundY(flatY);
    currentBounds = bounds;
    currentAuthoredTarget = result.authoredTarget;

    // See applyFogForScene()/settings-store.js — same reasoning applies to
    // the gsplat LOD distance thresholds, which are also absolute-unit
    // (PlayCanvas defaults: full detail only within 5 units of the camera).
    // On a scene whose coordinates are 10-100x "normal" scale, 5 units is
    // nowhere near the camera even when visually right up close, so it
    // serves coarse detail immediately. Scaling the threshold by the
    // scene's own measured size keeps "close up" meaning the same thing
    // regardless of the reconstruction's arbitrary unit scale.
    currentSceneScale = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, 5);
    applyFogForScene();
    if (result.entity?.gsplat) {
      result.entity.gsplat.lodBaseDistance = currentSceneScale * 0.05;
      result.entity.gsplat.lodMultiplier = 2.2;
    }

    spawn = findSpawnPoint(currentCollider, bounds, flatY, currentAuthoredTarget);
    walker.spawnAt(spawn.x, spawn.y, spawn.z);
    input.yaw = 0;
    input.pitch = 0;

    autoAdvance.reset(bounds, currentCollider);

    el('sceneName').textContent = entry.name || '';
    hud.hidden = false;
    loading.hidden = true;
    inHike = true;
    clickToLook.classList.remove('hidden');
    audio.start();
    audio.setVolume(settings.get('muted') ? 0 : settings.get('ambientVolume'));
  } catch (err) {
    loadingText.textContent = `Failed to load: ${err.message || err}`;
    setTimeout(() => {
      loading.hidden = true;
      menu.style.display = '';
    }, 2200);
  }
}

function endHike() {
  inHike = false;
  hud.hidden = true;
  nextSceneHint.hidden = true;
  input.exitLock();
  sceneManager.unload();
  menu.style.display = '';
  renderSceneList();
}

walker.onFellThrough = () => {
  showToast('Lost the trail — resetting to solid ground');
  const spawn = findSpawnPoint(currentCollider, currentBounds, walker.flatGroundY, currentAuthoredTarget);
  walker.spawnAt(spawn.x, spawn.y, spawn.z);
};

el('nextSceneBtn').addEventListener('click', () => goToNextScene());

function goToNextScene() {
  const scenes = library.listWithSessionOnly();
  if (!scenes.length) return;
  const next = scenes[(currentIndex + 1) % scenes.length];
  nextSceneHint.hidden = true;
  startHike(next);
}

input.onLockChange((locked) => {
  clickToLook.classList.toggle('hidden', locked);
});
// The overlay sits on top of the canvas (so its "Click to walk" prompt is
// visible), which means clicks on it never reach the canvas underneath —
// it needs its own listener or pointer lock never actually engages.
clickToLook.addEventListener('click', () => input.requestLock());

// --------------------------------------------------------------- main loop
const flyBadge = el('flyBadge');
let wasFlying = false;

app.on('update', (dt) => {
  if (!inHike) return;
  const inp = input.read();
  walker.update(dt, inp);

  if (walker.flying !== wasFlying) {
    wasFlying = walker.flying;
    flyBadge.hidden = !wasFlying;
  }

  const eye = walker.eyePosition;
  camera.setPosition(eye.x, eye.y, eye.z);
  camera.setEulerAngles(inp.pitch, inp.yaw, 0);
  sky.follow(camera);

  if (!walker.flying && autoAdvance.update(walker)) {
    nextSceneHint.hidden = false;
    setTimeout(() => { if (!nextSceneHint.hidden) goToNextScene(); }, 6000);
  }
});
