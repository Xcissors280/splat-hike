import { Vec3 } from 'playcanvas';

// Turns a splat's point cloud into a sparse grid of solid voxel cells for
// walking collision. Coarse by design — position-in-cell testing rather
// than a volume sweep, same fidelity tradeoff the source technique uses.
//
// Adapted from Rouf0x/splatfpv (MIT license):
// https://github.com/Rouf0x/splatfpv/blob/main/src/physics/voxel-collider.js
// Cell coordinates are packed into one non-negative safe integer instead of
// a string key so the occupancy set stays cheap to build/query even for
// scenes with tens of millions of splats. 17 bits/axis (±65536 cells)
// comfortably covers any realistic scan at any voxel size the UI allows.
const AXIS_BITS = 17;
const AXIS_RANGE = 1 << AXIS_BITS;
const AXIS_OFFSET = AXIS_RANGE >> 1;

// Photogrammetry/SfM reconstructions (this pipeline is COLMAP-based under
// the hood) reliably produce a handful of stray outlier splats far from the
// real geometry — water and other reflective surfaces are the usual cause,
// and a splat hiking sim is guaranteed to hit water sooner or later. A
// lone-point voxel hundreds of units from everything else would otherwise
// win "highest point in this column" and the player would spawn on/fall
// toward empty space. Requiring a handful of splats per cell before it
// counts as solid ground filters that out while still catching real thin
// surfaces (leaves, thin branches), which get many overlapping splats from
// the source photos.
const MIN_DENSITY = 3;

function cellKey(ix, iy, iz) {
  const cx = ix + AXIS_OFFSET;
  const cy = iy + AXIS_OFFSET;
  const cz = iz + AXIS_OFFSET;
  if (cx < 0 || cx >= AXIS_RANGE || cy < 0 || cy >= AXIS_RANGE || cz < 0 || cz >= AXIS_RANGE) {
    return null;
  }
  return (cx * AXIS_RANGE + cy) * AXIS_RANGE + cz;
}

function decodeCellKey(key) {
  const cz = key % AXIS_RANGE;
  const rest = Math.floor(key / AXIS_RANGE);
  const cy = rest % AXIS_RANGE;
  const cx = Math.floor(rest / AXIS_RANGE);
  return [cx - AXIS_OFFSET, cy - AXIS_OFFSET, cz - AXIS_OFFSET];
}

// Returns null when the loaded splat doesn't expose CPU-side point centers.
// This is the case for streamed .lod-meta.json octree scenes, whose points
// live in a dynamically-populated GPU work buffer rather than a static
// array — see core/scene-loader.js for the fallback used in that case.
export function buildVoxelCollider(splatEntity, voxelSize, onProgress) {
  const resource = splatEntity?.gsplat?.resource;
  const centers = resource?.centers;
  if (!centers || !centers.length) return null;

  const size = Math.max(voxelSize, 0.01);
  const worldMat = splatEntity.getWorldTransform();
  const numSplats = resource.numSplats ?? Math.floor(centers.length / 3);

  const cells = new Map(); // key -> count (also gives us a density signal for auto-advance)
  const p = new Vec3();

  for (let i = 0; i < numSplats; i++) {
    p.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]);
    worldMat.transformPoint(p, p);
    const key = cellKey(Math.floor(p.x / size), Math.floor(p.y / size), Math.floor(p.z / size));
    if (key !== null) cells.set(key, (cells.get(key) || 0) + 1);
  }

  // Bounds are derived from the *solid* (density-filtered) cells rather
  // than the raw point extents — otherwise a single outlier splat from a
  // water reflection stretches the box hundreds of units into empty air
  // and every "center of the bounding box" heuristic downstream (spawn
  // point, auto-advance edge detection) breaks.
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  let solidCells = 0;
  for (const [key, count] of cells) {
    if (count < MIN_DENSITY) continue;
    solidCells++;
    const [ix, iy, iz] = decodeCellKey(key);
    if (ix * size < bounds.minX) bounds.minX = ix * size;
    if (iy * size < bounds.minY) bounds.minY = iy * size;
    if (iz * size < bounds.minZ) bounds.minZ = iz * size;
    if ((ix + 1) * size > bounds.maxX) bounds.maxX = (ix + 1) * size;
    if ((iy + 1) * size > bounds.maxY) bounds.maxY = (iy + 1) * size;
    if ((iz + 1) * size > bounds.maxZ) bounds.maxZ = (iz + 1) * size;
  }
  // Degenerate scene (every cell below the density floor) — fall back to
  // the raw extents rather than an Infinity/-Infinity box.
  if (solidCells === 0) {
    for (const key of cells.keys()) {
      const [ix, iy, iz] = decodeCellKey(key);
      bounds.minX = Math.min(bounds.minX, ix * size); bounds.maxX = Math.max(bounds.maxX, (ix + 1) * size);
      bounds.minY = Math.min(bounds.minY, iy * size); bounds.maxY = Math.max(bounds.maxY, (iy + 1) * size);
      bounds.minZ = Math.min(bounds.minZ, iz * size); bounds.maxZ = Math.max(bounds.maxZ, (iz + 1) * size);
    }
  }

  if (onProgress) onProgress(1);

  function keyFor(wx, wy, wz) {
    return cellKey(Math.floor(wx / size), Math.floor(wy / size), Math.floor(wz / size));
  }
  // Real-time collision (used every physics substep, always over a small
  // local search range) uses ANY point in a cell as solid — the outlier
  // problem only bites over the huge full-column searches spawn-finding
  // does, so gating routine walking collision behind MIN_DENSITY just
  // means most of the scene silently has no collision at all.
  function isSolid(key) {
    return key !== null && cells.has(key);
  }
  function isRobustSolid(key) {
    return key !== null && (cells.get(key) || 0) >= MIN_DENSITY;
  }

  return {
    size,
    cellCount: solidCells,
    bounds,
    occupied(wx, wy, wz) {
      return isSolid(keyFor(wx, wy, wz));
    },
    // Highest solid cell at/under (wx, wz), searching down from `fromY`
    // by at most `maxDrop` — used for ground snapping / step-up during
    // normal walking (small maxDrop, so outliers are never in range).
    groundHeight(wx, fromY, wz, maxDrop) {
      const cx = Math.floor(wx / size);
      const cz = Math.floor(wz / size);
      const startCell = Math.floor(fromY / size);
      const minCell = Math.floor((fromY - maxDrop) / size);
      for (let cy = startCell; cy >= minCell; cy--) {
        if (isSolid(cellKey(cx, cy, cz))) return (cy + 1) * size;
      }
      return null;
    },
    // Same search, but outlier-filtered — for spawn-finding only, which
    // searches the *entire* vertical column and would otherwise happily
    // land on a single stray reflection-noise splat far from real ground.
    robustGroundHeight(wx, fromY, wz, maxDrop) {
      const cx = Math.floor(wx / size);
      const cz = Math.floor(wz / size);
      const startCell = Math.floor(fromY / size);
      const minCell = Math.floor((fromY - maxDrop) / size);
      for (let cy = startCell; cy >= minCell; cy--) {
        if (isRobustSolid(cellKey(cx, cy, cz))) return (cy + 1) * size;
      }
      return null;
    },
    // Density (splat count) within a small horizontal ring around a point —
    // used by the auto-advance heuristic to notice the scan thinning out.
    densityNear(wx, wy, wz, radiusCells) {
      let total = 0;
      const cx = Math.floor(wx / size);
      const cy = Math.floor(wy / size);
      const cz = Math.floor(wz / size);
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        for (let dz = -radiusCells; dz <= radiusCells; dz++) {
          for (let dy = -2; dy <= 2; dy++) {
            const key = cellKey(cx + dx, cy + dy, cz + dz);
            if (key !== null && cells.has(key)) total += cells.get(key);
          }
        }
      }
      return total;
    },
  };
}
