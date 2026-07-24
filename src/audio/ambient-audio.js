// Fully procedural ambient bed — filtered noise for wind/leaves plus
// synthesized bird chirps — so the whole site stays static files only
// (no audio assets to host, license, or download).
export class AmbientAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.started = false;
    this._birdTimer = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    this._startWind();
    this._scheduleBird();
  }

  setVolume(v) {
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.2);
  }

  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }

  _noiseBuffer(seconds = 4) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Leaves + light wind: looped noise through a swept band/low-pass filter,
  // with a slow LFO on cutoff so it breathes instead of sounding static.
  _startWind() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(6);
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.6;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 400;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    const gain = ctx.createGain();
    gain.gain.value = 0.14;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start();

    this._windGain = gain;
  }

  // A single short bird chirp: a handful of quick pitch-swept tone blips
  // with a percussive envelope, panned to a random position.
  _playChirp() {
    const ctx = this.ctx;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.random() * 1.8 - 0.9;
    const chirpGain = ctx.createGain();
    chirpGain.gain.value = 0.0;
    panner.connect(chirpGain);
    chirpGain.connect(this.master);

    const notes = 2 + Math.floor(Math.random() * 3);
    const baseFreq = 2200 + Math.random() * 1800;
    let t = ctx.currentTime;

    for (let i = 0; i < notes; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const freq = baseFreq * (0.85 + Math.random() * 0.4);
      osc.frequency.setValueAtTime(freq * 0.7, t);
      osc.frequency.exponentialRampToValueAtTime(freq, t + 0.04);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.11);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.5, t + 0.015);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.13);

      osc.connect(env);
      env.connect(panner);
      osc.start(t);
      osc.stop(t + 0.15);
      t += 0.1 + Math.random() * 0.09;
    }

    chirpGain.gain.setValueAtTime(0.35, ctx.currentTime);
  }

  _scheduleBird() {
    const delay = 3000 + Math.random() * 9000;
    this._birdTimer = setTimeout(() => {
      if (this.ctx && this.ctx.state === 'running') this._playChirp();
      this._scheduleBird();
    }, delay);
  }

  destroy() {
    clearTimeout(this._birdTimer);
    this.ctx?.close();
  }
}
