import { Entity, Vec3 } from 'playcanvas';

// --- superspl.at share-link resolution ---------------------------------
// A superspl.at "share link" (https://superspl.at/scene/<hash> or
// /s?id=<hash>) is an HTML viewer page, not a splat file. The viewer itself
// has to fetch the raw asset from somewhere public to render it in the
// browser, and that somewhere is a fixed CloudFront location keyed by the
// scene hash — it's reachable even when the page has no visible "Download"
// button (that button just controls a separate, friendlier export; it does
// not gate the render asset itself).
//
// Approach and CDN path adapted from Rouf0x/splatfpv (MIT license),
// https://github.com/Rouf0x/splatfpv/blob/main/src/core/scene.js — credit
// there for finding this in the first place.
const SUPERSPLAT_CDN_BASE = 'https://d28zzqy0iyovbz.cloudfront.net';
const SUPERSPLAT_CONTENT_CANDIDATES = ['lod-meta.json', 'meta.json', 'scene.compressed.ply'];

export function extractSuperSplatHash(url) {
  let u;
  try {
    u = new URL(url, window.location.href);
  } catch {
    return null;
  }
  if (!/(^|\.)superspl\.at$/i.test(u.hostname)) return null;
  const idParam = u.searchParams.get('id');
  if (idParam) return idParam;
  const match = u.pathname.match(/\/scene\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// kind: 'lod-meta' scenes stream in progressively and never expose a full
// CPU-side point array (see physics/voxel-collider.js) — everything else
// ('meta' / 'ply' / 'direct') loads its geometry up front and can be
// voxelized normally.
function kindFromFilename(filename) {
  if (/lod-meta\.json$/i.test(filename)) return 'lod-meta';
  if (/meta\.json$/i.test(filename)) return 'meta';
  return 'ply';
}

export async function resolveSceneUrl(url) {
  const hash = extractSuperSplatHash(url);
  if (!hash) return { url, kind: 'direct' }; // already a direct file URL
  for (const filename of SUPERSPLAT_CONTENT_CANDIDATES) {
    const candidate = `${SUPERSPLAT_CDN_BASE}/${hash}/v1/${filename}`;
    try {
      const res = await fetch(candidate, { method: 'HEAD' });
      if (res.ok) return { url: candidate, kind: kindFromFilename(filename) };
    } catch {
      // CORS/network error on this candidate — try the next format
    }
  }
  throw new Error('Could not find a public asset for this superspl.at link (the scene may be private).');
}

// The streamed lod-meta.json format never exposes CPU point centers, but it
// does carry the octree's overall bound in the JSON itself — cheap to fetch
// separately and good enough for scene-edge bounds for auto-advance (see
// core/autoadvance.js). The bound's raw minY is NOT used for ground height
// though — see robustGroundY below.
async function fetchLodMeta(url) {
  const res = await fetch(url);
  return res.json();
}

// The raw octree bound's bottom is exactly as outlier-prone as the raw
// point-cloud min/max in voxel-collider.js (same underlying reconstruction,
// same water-reflection artifacts) — a single stray leaf far below the real
// scene would otherwise become the flat-fallback "ground", stranding the
// player in empty space below everything. Each leaf node corresponds to a
// real chunk file, so instead of the absolute bottom, take a low percentile
// across all leaves' bottoms — one or two outlier leaves get skipped, the
// real ground (represented by many leaves at a similar height) doesn't.
function robustGroundY(tree) {
  const mins = [];
  (function walk(node) {
    if (!node) return;
    if (!node.children || node.children.length === 0) {
      if (node.bound) mins.push(node.bound.min[1]);
      return;
    }
    node.children.forEach(walk);
  })(tree);
  if (!mins.length) return tree?.bound?.min?.[1] ?? 0;
  mins.sort((a, b) => a - b);
  return mins[Math.min(Math.floor(mins.length * 0.15), mins.length - 1)];
}

// Every superspl.at scene also publishes the settings.json SuperSplat
// Studio produces for it, at a sibling path to the render asset — the same
// file the official viewer reads for its default camera framing. Its
// "target" point is the creator's (or the editor's auto-computed) look-at
// point, which is a far better walk-spawn hint than the raw bounding-box
// center: the bbox center of an irregular scan (a gorge, an L-shaped
// building, anything not a neat blob) is frequently empty space, while the
// authored target is reliably aimed at the actual subject. Two schema
// generations exist in the wild — handle both.
async function fetchAuthoredTarget(hash) {
  try {
    const res = await fetch(`${SUPERSPLAT_CDN_BASE}/${hash}/v1/settings.json`);
    if (!res.ok) return null;
    const json = await res.json();
    const target = json?.camera?.target || json?.cameras?.[0]?.initial?.target || null;
    return Array.isArray(target) && target.length === 3 ? target : null;
  } catch {
    return null;
  }
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url, window.location.href);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : 'scene.ply';
  } catch {
    return 'scene.ply';
  }
}

export function createSceneManager(app) {
  let splatEntity = null;
  let currentBlobUrl = null;

  function revokeBlobUrl() {
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }
  }

  // rotX/rotZ correct for scans that weren't reconstructed level — these
  // are uncalibrated community scans, and while rotY (yaw) is nearly always
  // needed (SuperSplat's own default export convention), a genuine pitch/
  // roll tilt in the source reconstruction is also possible and yaw alone
  // can't fix it. No default nonzero value here (unlike rotY) since a
  // level scan is the common case and most scenes don't need this.
  function applyTransform(entry) {
    if (!splatEntity) return;
    splatEntity.setLocalEulerAngles(entry.rotX ?? 0, entry.rotY ?? 180, entry.rotZ ?? 0);
    const s = entry.scale ?? 1;
    splatEntity.setLocalScale(s, s, s);
    splatEntity.setLocalPosition(0, 0, 0);
  }

  function applyQuality(lodRangeMax) {
    if (splatEntity?.gsplat) splatEntity.gsplat.lodRangeMax = lodRangeMax;
  }

  function placeSplat(asset, entry, lodRangeMax) {
    if (splatEntity) {
      splatEntity.destroy();
      splatEntity = null;
    }
    splatEntity = new Entity('Splat');
    splatEntity.addComponent('gsplat', { asset });
    app.root.addChild(splatEntity);
    applyTransform(entry);
    applyQuality(lodRangeMax);
  }

  function loadAsset(url, filename, entry, lodRangeMax) {
    return new Promise((resolve, reject) => {
      app.assets.loadFromUrlAndFilename(url, filename, 'gsplat', (err, asset) => {
        if (err) { reject(new Error(err)); return; }
        placeSplat(asset, entry, lodRangeMax);
        resolve(splatEntity);
      });
    });
  }

  function pointToWorld(local) {
    if (!splatEntity || !local) return null;
    const p = new Vec3(local[0], local[1], local[2]);
    splatEntity.getWorldTransform().transformPoint(p, p);
    return { x: p.x, y: p.y, z: p.z };
  }

  // Turns a local-space AABB (e.g. the streamed scene's octree bound) into
  // a world-space AABB by transforming all 8 corners through the splat
  // entity's world matrix — cheap, and correct under rotation/scale.
  function boundToWorld(bound) {
    if (!splatEntity || !bound) return null;
    const mat = splatEntity.getWorldTransform();
    const out = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    const p = new Vec3();
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? bound.max[0] : bound.min[0];
      const y = i & 2 ? bound.max[1] : bound.min[1];
      const z = i & 4 ? bound.max[2] : bound.min[2];
      p.set(x, y, z);
      mat.transformPoint(p, p);
      out.minX = Math.min(out.minX, p.x); out.maxX = Math.max(out.maxX, p.x);
      out.minY = Math.min(out.minY, p.y); out.maxY = Math.max(out.maxY, p.y);
      out.minZ = Math.min(out.minZ, p.z); out.maxZ = Math.max(out.maxZ, p.z);
    }
    return out;
  }

  // entry: { url, rotY, scale } — url may be a superspl.at share link, a
  // direct splat file URL, or an object-URL from a locally-loaded file.
  // Returns { entity, kind, worldBound, groundYHint, authoredTarget } — all
  // extras are best-effort and null when not applicable/available.
  // groundYHint is only populated for streamed ('lod-meta') scenes, where
  // it's the sole source of ground height (no CPU points to derive it from
  // otherwise). authoredTarget (world-space) comes from the scene's
  // published settings.json when the link is a superspl.at share link.
  async function load(entry, { lodRangeMax = 99, onStatus = () => {} } = {}) {
    onStatus('Resolving scene…');
    const hash = extractSuperSplatHash(entry.url);
    const [{ url: resolved, kind }, authoredTargetLocal] = await Promise.all([
      resolveSceneUrl(entry.url),
      hash ? fetchAuthoredTarget(hash) : Promise.resolve(null),
    ]);
    const filename = entry.filename || filenameFromUrl(resolved);
    let bound = null;
    let groundYHint = null;
    if (kind === 'lod-meta') {
      try {
        const meta = await fetchLodMeta(resolved);
        bound = meta?.tree?.bound || null;
        // Y is untouched by yaw-only rotation — only the entry's uniform
        // scale carries through from local to world space.
        if (meta?.tree) groundYHint = robustGroundY(meta.tree) * (entry.scale ?? 1);
      } catch { /* non-fatal, falls back to no bound/hint */ }
    }
    onStatus('Loading splat data…');
    await loadAsset(resolved, filename, entry, lodRangeMax);
    onStatus('');
    return {
      entity: splatEntity,
      kind,
      worldBound: boundToWorld(bound),
      groundYHint,
      authoredTarget: pointToWorld(authoredTargetLocal),
    };
  }

  function loadFromFile(file, entry, { lodRangeMax = 99, onStatus = () => {} } = {}) {
    onStatus('Loading local file…');
    revokeBlobUrl();
    currentBlobUrl = URL.createObjectURL(file);
    return loadAsset(currentBlobUrl, file.name, entry, lodRangeMax).then(() => {
      onStatus('');
      return { entity: splatEntity, kind: 'ply', worldBound: null, groundYHint: null, authoredTarget: null };
    });
  }

  function unload() {
    if (splatEntity) {
      splatEntity.destroy();
      splatEntity = null;
    }
    revokeBlobUrl();
  }

  return {
    get entity() { return splatEntity; },
    load,
    loadFromFile,
    applyQuality,
    applyTransform,
    unload,
  };
}
