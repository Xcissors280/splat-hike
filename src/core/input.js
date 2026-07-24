// Pointer-lock mouse look + WASD/shift/space key state. Kept deliberately
// dumb (no smoothing/inertia here) — smoothing belongs to the walk
// controller, which needs raw input to do its own accel/friction model.
export class InputManager {
  constructor(canvas, settingsStore) {
    this.canvas = canvas;
    this.settingsStore = settingsStore;
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.locked = false;
    this.jumpQueued = false;
    this.flyToggleQueued = false;

    canvas.addEventListener('click', () => this.requestLock());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      this._onLockChange?.(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const sens = this.settingsStore.get('mouseSens');
      this.yaw -= e.movementX * sens * 0.1;
      this.pitch -= e.movementY * sens * 0.1;
      this.pitch = Math.max(-89, Math.min(89, this.pitch));
    });
    window.addEventListener('keydown', (e) => {
      if (this._typing()) return;
      if (!this.keys.has(e.code) && e.code === 'KeyF') this.flyToggleQueued = true;
      this.keys.add(e.code);
      if (e.code === 'Space') { this.jumpQueued = true; e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
  }

  _typing() {
    const tag = document.activeElement?.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  }

  onLockChange(fn) { this._onLockChange = fn; }

  // Pointer lock is a user-gesture-gated browser API that can reject (tab
  // not focused, called too soon after an exit, etc) — requestPointerLock()
  // returns a promise in modern browsers, so failures are caught instead of
  // silently leaving the click-to-look prompt stuck with no feedback.
  requestLock() {
    if (this.locked) return;
    const result = this.canvas.requestPointerLock();
    if (result?.catch) result.catch(() => {});
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  read() {
    const forward = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0)
      - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const right = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0)
      - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    const up = (this.keys.has('Space') ? 1 : 0) - (this.keys.has('KeyC') || this.keys.has('ControlLeft') ? 1 : 0);
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const jump = this.jumpQueued;
    const flyToggle = this.flyToggleQueued;
    this.jumpQueued = false;
    this.flyToggleQueued = false;
    return { forward, right, up, sprint, jump, flyToggle, yaw: this.yaw, pitch: this.pitch };
  }
}
