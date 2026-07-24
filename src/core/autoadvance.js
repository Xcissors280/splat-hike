// Detects "you've walked to the edge of this scan" so the next scene can
// load automatically. Two independent signals, either of which can fire:
//
//  1. Bounding-box edge proximity — how close the player is to the outer
//     wall of the scene's known extent (from the voxel collider's point
//     bounds, or the streamed scene's octree bound as a fallback). Works
//     for every scene regardless of format.
//  2. Splat density thinning — the voxel collider tracks points-per-cell;
//     photogrammetry scans reliably get sparser near their edges (fewer
//     overlapping camera views out there), so a big drop from the richest
//     density seen so far is a good proxy for "leaving the scanned area".
//     Only available when a real voxel collider exists (not the flat-plane
//     fallback), since that's what the requester actually asked for.
export class AutoAdvance {
  constructor(settingsStore) {
    this.settingsStore = settingsStore;
    this.bounds = null;
    this.collider = null;
    this.maxDensity = 0;
    this.armed = false; // requires the player to actually walk a bit first
    this.triggered = false;
  }

  reset(bounds, collider) {
    this.bounds = bounds;
    this.collider = collider;
    this.maxDensity = 0;
    this.armed = false;
    this.triggered = false;
  }

  // Returns true the moment the "near the edge" condition is met (fires
  // once per scene load; call reset() when a new scene is loaded).
  update(walkController) {
    if (this.triggered || !this.settingsStore.get('autoAdvanceEnabled')) return false;
    if (walkController.distanceWalked > 2.5) this.armed = true;
    if (!this.armed) return false;

    const sensitivity = this.settingsStore.get('autoAdvanceSensitivity');
    const { x, z } = walkController.pos;

    let edgeSignal = false;
    if (this.bounds) {
      const halfX = (this.bounds.maxX - this.bounds.minX) / 2;
      const halfZ = (this.bounds.maxZ - this.bounds.minZ) / 2;
      const cx = (this.bounds.maxX + this.bounds.minX) / 2;
      const cz = (this.bounds.maxZ + this.bounds.minZ) / 2;
      const nx = halfX > 0 ? Math.abs(x - cx) / halfX : 0;
      const nz = halfZ > 0 ? Math.abs(z - cz) / halfZ : 0;
      const proximity = Math.max(nx, nz); // 0 = center, 1 = at the wall
      const threshold = 0.98 - sensitivity * 0.28; // higher sensitivity -> fires earlier
      edgeSignal = proximity >= threshold;
    }

    let densitySignal = false;
    if (this.collider) {
      const density = this.collider.densityNear(x, walkController.pos.y + 0.9, z, 3);
      this.maxDensity = Math.max(this.maxDensity, density);
      if (this.maxDensity > 40) {
        const ratio = density / this.maxDensity;
        const threshold = 0.22 - sensitivity * 0.15;
        densitySignal = ratio <= Math.max(threshold, 0.03);
      }
    }

    if (edgeSignal || densitySignal) {
      this.triggered = true;
      return true;
    }
    return false;
  }
}
