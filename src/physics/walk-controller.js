const GRAVITY = -9.8;
const EYE_HEIGHT = 1.65;
const RADIUS = 0.32;
const STEP_HEIGHT = 0.35;
const JUMP_SPEED = 4.2;
const ACCEL = 14;
const AIR_ACCEL = 4;
const GROUND_FRICTION = 10;
const MAX_FALL_TIME = 1.6; // seconds ungrounded before we assume a hole/void and respawn
const SUBSTEP = 1 / 120;
const DEG2RAD = Math.PI / 180;
const FLY_SPEED = 6;
const FLY_SPRINT_MULT = 3;

// Sample points around the capsule's circumference used for horizontal
// collision + step-up tests (8-way ring at two heights: near the feet and
// near chest height, so the capsule can't clip a wall between them).
const RING_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315].map((d) => d * DEG2RAD);
const TEST_HEIGHTS = [0.15, 1.1];

// Walking capsule controller. Consumes either a real voxel collider (built
// from CPU-side splat centers, see physics/voxel-collider.js) or a flat
// fallback plane (used for streamed .lod-meta.json scenes where no CPU
// point data is available — see core/scene-loader.js) so the rest of the
// game doesn't need to know which mode is active.
export class WalkController {
  constructor(settingsStore) {
    this.settingsStore = settingsStore;
    this.pos = { x: 0, y: 0, z: 0 }; // feet position
    this.vel = { x: 0, y: 0, z: 0 };
    this.grounded = false;
    this.airTime = 0;
    this.lastGrounded = { x: 0, y: 0, z: 0 };
    this.collider = null; // { occupied, groundHeight, densityNear, bounds } or null
    this.flatGroundY = 0;
    this.onFellThrough = null;
    this.distanceWalked = 0;
    this._lastXZ = null;
    // Freecam/reposition mode — no gravity, no collision, full 3D movement.
    // A manual escape hatch for bad spawns or scenes with patchy collision,
    // toggled with F (see core/input.js).
    this.flying = false;
  }

  setCollider(collider) { this.collider = collider; }
  setFlatGroundY(y) { this.flatGroundY = y; }

  spawnAt(x, y, z) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.vel.x = 0; this.vel.y = 0; this.vel.z = 0;
    this.grounded = true;
    this.airTime = 0;
    this.flying = false;
    this.lastGrounded = { x, y, z };
    this._lastXZ = { x, z };
    this.distanceWalked = 0;
  }

  // Finds ground height under (x,z) starting the search at `fromY`, using
  // the voxel collider if we have one, otherwise the flat fallback plane.
  _groundHeight(x, fromY, z, maxDrop) {
    if (this.collider) return this.collider.groundHeight(x, fromY, z, maxDrop);
    return this.flatGroundY <= fromY ? this.flatGroundY : null;
  }

  _occupied(x, y, z) {
    if (!this.collider) return false;
    return this.collider.occupied(x, y, z);
  }

  _capsuleBlocked(x, y, z) {
    if (!this.collider) return false;
    for (const h of TEST_HEIGHTS) {
      for (const a of RING_ANGLES) {
        const sx = x + Math.cos(a) * RADIUS;
        const sz = z + Math.sin(a) * RADIUS;
        if (this._occupied(sx, y + h, sz)) return true;
      }
    }
    return false;
  }

  update(dt, input) {
    if (input.flyToggle) {
      this.flying = !this.flying;
      if (this.flying) { this.vel.x = 0; this.vel.y = 0; this.vel.z = 0; }
      // Turning fly OFF does nothing special — gravity/ground-search just
      // takes back over next substep from wherever you let go, and the
      // existing fall-through safety net (onFellThrough) already handles
      // "let go somewhere with no ground below" by finding a fresh spawn.
    }

    if (this.flying) {
      this._updateFly(dt, input);
      return;
    }

    const speed = this.settingsStore.get('walkSpeed') * (input.sprint ? 1.7 : 1);
    const yawRad = input.yaw * DEG2RAD;
    const fx = -Math.sin(yawRad), fz = -Math.cos(yawRad);
    const rx = Math.cos(yawRad), rz = -Math.sin(yawRad);

    let wishX = fx * input.forward + rx * input.right;
    let wishZ = fz * input.forward + rz * input.right;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 0) { wishX /= wishLen; wishZ /= wishLen; }

    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-6) {
      const h = Math.min(SUBSTEP, remaining);
      this._substep(h, wishX, wishZ, speed, input.jump);
      remaining -= h;
    }
    input.jump = false;
  }

  // Free-flight: full 3D direction (pitch included, unlike grounded walk),
  // no gravity, no collision — pure kinematic movement for repositioning.
  _updateFly(dt, input) {
    const speed = FLY_SPEED * (input.sprint ? FLY_SPRINT_MULT : 1);
    const yawRad = input.yaw * DEG2RAD;
    const pitchRad = input.pitch * DEG2RAD;
    const cosPitch = Math.cos(pitchRad);
    const fx = -Math.sin(yawRad) * cosPitch, fy = Math.sin(pitchRad), fz = -Math.cos(yawRad) * cosPitch;
    const rx = Math.cos(yawRad), rz = -Math.sin(yawRad);

    let wx = fx * input.forward + rx * input.right;
    let wy = fy * input.forward + (input.up || 0);
    let wz = fz * input.forward + rz * input.right;
    const len = Math.hypot(wx, wy, wz);
    if (len > 0) { wx /= len; wy /= len; wz /= len; }

    this.pos.x += wx * speed * dt;
    this.pos.y += wy * speed * dt;
    this.pos.z += wz * speed * dt;
    this.vel.x = 0; this.vel.y = 0; this.vel.z = 0;
    this.grounded = false;
    this.airTime = 0;
  }

  _substep(dt, wishX, wishZ, speed, jump) {
    const accel = this.grounded ? ACCEL : AIR_ACCEL;
    const targetX = wishX * speed;
    const targetZ = wishZ * speed;
    const alpha = Math.min(accel * dt, 1);
    this.vel.x += (targetX - this.vel.x) * alpha;
    this.vel.z += (targetZ - this.vel.z) * alpha;
    if (wishX === 0 && wishZ === 0 && this.grounded) {
      const damp = Math.exp(-GROUND_FRICTION * dt);
      this.vel.x *= damp;
      this.vel.z *= damp;
    }

    if (this.grounded && jump) {
      this.vel.y = JUMP_SPEED;
      this.grounded = false;
    }
    if (!this.grounded) {
      this.vel.y += GRAVITY * dt;
      this.vel.y = Math.max(this.vel.y, -30);
    }

    const prevX = this.pos.x, prevZ = this.pos.z, prevY = this.pos.y;
    let nx = this.pos.x + this.vel.x * dt;
    let nz = this.pos.z + this.vel.z * dt;

    // Horizontal collision, axis-separated (slide along whichever axis is
    // actually blocked rather than stopping dead on a diagonal into a
    // corner). Each axis first tries a flat block; if blocked, tries a
    // step-up onto a ledge no taller than STEP_HEIGHT before giving up —
    // this is what keeps roots/rocks/small rubble from snagging movement
    // while real obstacles (trunks, boulders, walls) still stop you.
    let stepUpY = null;
    if (this._capsuleBlocked(nx, this.pos.y, prevZ)) {
      const stepped = this._tryStepUp(nx, prevZ);
      if (stepped !== null) { stepUpY = stepped; } else { nx = prevX; this.vel.x = 0; }
    }
    if (this._capsuleBlocked(nx, stepUpY ?? this.pos.y, nz)) {
      const stepped = this._tryStepUp(nx, nz);
      if (stepped !== null) { stepUpY = Math.max(stepUpY ?? -Infinity, stepped); } else { nz = prevZ; this.vel.z = 0; }
    }
    this.pos.x = nx;
    this.pos.z = nz;

    // Vertical: integrate, then snap to ground if we're close enough to it.
    let ny = this.pos.y + this.vel.y * dt;
    if (stepUpY !== null && stepUpY > ny) ny = stepUpY;

    const searchFrom = Math.max(ny, prevY) + 0.6;
    const ground = this._groundHeight(this.pos.x, searchFrom, this.pos.z, 2.2 + Math.max(0, prevY - ny));
    if (ground !== null && ny <= ground + 0.05) {
      ny = ground;
      this.vel.y = 0;
      this.grounded = true;
      this.airTime = 0;
      this.lastGrounded.x = this.pos.x;
      this.lastGrounded.y = ny;
      this.lastGrounded.z = this.pos.z;
    } else {
      this.grounded = false;
      this.airTime += dt;
    }
    this.pos.y = ny;

    if (this._lastXZ) {
      this.distanceWalked += Math.hypot(this.pos.x - this._lastXZ.x, this.pos.z - this._lastXZ.z);
    }
    this._lastXZ = { x: this.pos.x, z: this.pos.z };

    if (this.airTime > MAX_FALL_TIME) {
      this.airTime = 0;
      this.vel.x = this.vel.y = this.vel.z = 0;
      // Let the caller (main.js) find a fresh, verified spawn point rather
      // than re-teleporting here — if the *original* spawn was the one over
      // a gap, snapping back to lastGrounded (== that same bad spot, if we
      // never actually landed once) would just loop forever.
      if (this.onFellThrough) {
        this.onFellThrough();
      } else {
        this.pos.x = this.lastGrounded.x;
        this.pos.y = this.lastGrounded.y;
        this.pos.z = this.lastGrounded.z;
        this.grounded = true;
      }
    }
  }

  // Returns a lifted ground height if (x,z) has a walkable ledge within
  // STEP_HEIGHT of the current feet position with clear headroom above it,
  // otherwise null (real obstacle, no step available).
  _tryStepUp(x, z) {
    if (!this.collider) return null;
    const ground = this.collider.groundHeight(x, this.pos.y + STEP_HEIGHT + 0.05, z, STEP_HEIGHT + 0.15);
    if (ground === null) return null;
    if (ground > this.pos.y + STEP_HEIGHT) return null;
    if (this._capsuleBlocked(x, ground + 0.05, z)) return null;
    return ground;
  }

  get eyePosition() {
    return { x: this.pos.x, y: this.pos.y + EYE_HEIGHT, z: this.pos.z };
  }
}
