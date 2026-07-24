// Finds a safe place to drop the player into a scene. Naively spawning at
// the dead center of the scan's bounding box works for tidy scans but fails
// on anything irregular (a waterfall gorge, an L-shaped building, a scan
// with a hole in the middle) — the center X/Z column may have no ground
// under it at all, or land far from the actual subject of the scan. Spiral
// outward from a center instead, and require a candidate to have a few
// *neighboring* occupied cells at the same height (not just one stray
// point) before trusting it as real ground.
function isSupported(collider, x, y, z) {
  const offsets = [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]];
  let hits = 0;
  for (const [dx, dz] of offsets) {
    if (collider.occupied(x + dx, y - 0.08, z + dz)) hits++;
  }
  return hits >= 2;
}

// Rejects candidates buried under low foliage/overhangs — a "ground" cell
// that's really the top of a fern or a low rock lip would otherwise plant
// the camera's head inside solid geometry (the extreme-closeup blur that
// looks like when this went wrong the first time).
function hasHeadroom(collider, x, y, z, clearHeight) {
  const offsets = [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]];
  for (const [dx, dz] of offsets) {
    for (let h = 0.3; h <= clearHeight; h += 0.3) {
      if (collider.occupied(x + dx, y + h, z + dz)) return false;
    }
  }
  return true;
}

// Rejects candidates wedged sideways against dense undergrowth/a trunk —
// headroom alone doesn't catch standing inside a bush with clear air above
// it. Samples an 8-point ring at a couple of body heights out to `radius`.
function hasSideClearance(collider, x, y, z, radius) {
  const ring = 8;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2;
    const sx = x + Math.cos(a) * radius;
    const sz = z + Math.sin(a) * radius;
    if (collider.occupied(sx, y + 0.3, sz)) return false;
    if (collider.occupied(sx, y + 1.2, sz)) return false;
  }
  return true;
}

// 8 points evenly spaced around a ring at the given radius index.
function ringOffsets(ring, count) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pts.push([Math.cos(a) * ring, Math.sin(a) * ring]);
  }
  return pts;
}

// Spirals outward from (cx, cz) looking for ground. Returns the first fully
// "supported + clear" candidate immediately (via early return through the
// caller), and otherwise the best partial matches found so the caller can
// fall back gracefully.
function ringSearch(collider, cx, cz, bounds) {
  const fullDrop = (bounds.maxY - bounds.minY) + 2;
  const searchFrom = bounds.maxY + 1;
  const ringStep = Math.max(Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 0.06, 0.5);

  let bestAny = null;
  let bestClear = null;

  for (let ring = 0; ring < 10; ring++) {
    const points = ring === 0 ? [[0, 0]] : ringOffsets(ring, 8);
    for (const [ox, oz] of points) {
      const x = cx + ox * ringStep;
      const z = cz + oz * ringStep;
      const ground = collider.robustGroundHeight(x, searchFrom, z, fullDrop);
      if (ground === null) continue;
      const candidate = { x, y: ground + 0.05, z };
      if (!bestAny) bestAny = candidate;
      const clear = hasHeadroom(collider, x, ground + 0.05, z, 1.9)
        && hasSideClearance(collider, x, ground + 0.05, z, 0.45);
      if (clear && !bestClear) bestClear = candidate;
      if (clear && isSupported(collider, x, ground, z)) return { found: candidate, bestClear, bestAny };
    }
  }
  return { found: null, bestClear, bestAny };
}

// preferredXZ (optional): the scene's authored camera "target" from its
// published settings.json (see core/scene-loader.js) — reliably aimed at
// the actual subject of the scan, unlike the bounding-box center which is
// frequently empty space for anything not a neat blob. Tried first; the
// bbox center is only a fallback if nothing walkable turns up near it.
export function findSpawnPoint(collider, bounds, flatGroundY, preferredXZ) {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;

  if (!collider) {
    const x = preferredXZ?.x ?? cx;
    const z = preferredXZ?.z ?? cz;
    return { x, y: flatGroundY + 0.05, z };
  }

  const attempts = [];
  if (preferredXZ) attempts.push(ringSearch(collider, preferredXZ.x, preferredXZ.z, bounds));
  attempts.push(ringSearch(collider, cx, cz, bounds));

  for (const a of attempts) if (a.found) return a.found;
  for (const a of attempts) if (a.bestClear) return a.bestClear;
  for (const a of attempts) if (a.bestAny) return a.bestAny;
  return { x: cx, y: flatGroundY + 0.05, z: cz };
}
