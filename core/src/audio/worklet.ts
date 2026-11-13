// Source of the playback AudioWorkletProcessor, as a string: AudioPlayer loads it from a
// Blob URL, so no extra bundle entry or file is needed (a page CSP must then allow blob: scripts),
// or from AudioPlayerOptions.workletUrl, a file holding this source (the app's build writes one,
// so its CSP needs no blob:).
//
// A ring buffer per channel acting as the jitter buffer:
// * "buffering": output silence until `targetFrames` are queued, then "playing";
// * playing and the queue runs dry: output silence, count a rebuffer, back to "buffering" (the
// peer's noise gate stops packets during silence, so a rebuffer after sound stops is normal);
// * clock drift: the peer's sample clock and ours never match exactly (one peer ran 0.27%
// fast), so a fixed-rate queue slowly fills or empties. Playback therefore runs at a rate of
// 1 +- RATE_STEP (0.5%, about 8.6 cents, inaudible), read with linear interpolation, steering
// the LOWEST queue level seen over a window (at least 1.5 x the packet arrival gap, so a
// bursty peer's sawtooth does not make it wobble) towards MARGIN above empty;
// * more than `maxFrames` queued anyway (after a stall raised the target and it fell back, or a
// long pause): skip the excess, crossfading over XFADE frames (10 ms) from the current
// position to the one after the skipped audio, so the jump does not click;
// * a short fade (FADE frames) in after every start, and out before a stop.
// AudioPlayer sets target, max and the arrival gap from what it observes ("target" message).
// Every ~250 ms it posts stats, including `clicks`: render quanta where the output's second
// difference jumped above CLICK_THRESHOLD (a discontinuity; a pure test tone never does that).
export const WORKLET_NAME = "rustdesk-audio-player";

export const WORKLET_SOURCE = String.raw`
const FADE = 96; // 2 ms at 48 kHz
const CLICK_THRESHOLD = 0.05;
const RATE_STEP = 0.005;
const XFADE = 480; // 10 ms at 48 kHz
class Player extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.channels = o.channels;
    this.cap = o.capacityFrames;
    this.setLevels(o);
    this.buf = Array.from({ length: this.channels }, () => new Float32Array(this.cap));
    this.read = 0; // integer read index
    this.frac = 0; // fractional position between read and read + 1
    this.size = 0;
    this.playing = false;
    this.fadeIn = 0;
    this.rate = 1;
    this.skip = 0; // frames to skip at the end of the running crossfade
    this.xf = 0; // crossfade frames left
    this.winMin = Infinity; // lowest level in the current control window
    this.winLeft = this.window;
    this.stats = { played: 0, silent: 0, rebuffers: 0, dropped: 0, clicks: 0, maxStep: 0, pushes: 0, fastFrames: 0, slowFrames: 0 };
    this.prev = [0, 0];
    this.sinceReport = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "push") this.push(m.planes);
      else if (m.type === "flush") { this.size = 0; this.frac = 0; this.playing = false; }
      else if (m.type === "target") this.setLevels(m);
    };
  }
  setLevels(m) {
    this.target = m.targetFrames;
    this.max = m.maxFrames;
    this.margin = Math.round(sampleRate * 0.04);
    this.window = Math.max(Math.round(sampleRate * 0.5), Math.round(1.5 * (m.gapFrames || 0)));
  }
  push(planes) {
    const n = planes[0].length;
    this.stats.pushes++;
    if (this.size + n > this.cap) this.drop(this.size + n - this.cap);
    let w = (this.read + this.size) % this.cap;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.channels; c++) this.buf[c][w] = planes[Math.min(c, planes.length - 1)][i];
      w = (w + 1) % this.cap;
    }
    this.size += n;
    if (this.playing && this.size > this.max) this.skipAhead(this.size - this.target);
  }
  drop(n) {
    // Immediate drop: only when not playing (nothing audible) or the ring itself overflows.
    this.read = (this.read + n) % this.cap;
    this.size -= n;
    this.stats.dropped += n;
    if (this.playing) this.fadeIn = FADE;
  }
  skipAhead(n) {
    // While playing: crossfade to the audio n frames later instead of cutting (see header).
    if (!this.playing) return this.drop(n);
    if (this.xf > 0 || n <= 0) return;
    this.skip = n;
    this.xf = XFADE;
  }
  steer(n) {
    // Track the lowest level of the window; at its end pick the rate for the next one.
    if (this.size < this.winMin) this.winMin = this.size;
    this.winLeft -= n;
    if (this.winLeft > 0) return;
    const low = this.winMin;
    this.rate = low > this.margin * 2 ? 1 + RATE_STEP : low < this.margin / 2 ? 1 - RATE_STEP : 1;
    this.winMin = Infinity;
    this.winLeft = this.window;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (!this.playing && this.size >= this.target) { this.playing = true; this.fadeIn = FADE; this.frac = 0; this.rate = 1; this.winMin = Infinity; this.winLeft = this.window; this.xf = 0; this.skip = 0; }
    let produced = 0;
    if (this.playing) {
      this.steer(n);
      if (this.rate > 1) this.stats.fastFrames += n;
      else if (this.rate < 1) this.stats.slowFrames += n;
      // Frames needed for n outputs at this rate (+1 for interpolation, + the skip if crossfading).
      const extra = this.xf > 0 ? this.skip : 0;
      const need = Math.ceil(this.frac + n * this.rate) + 1 + extra;
      if (need > this.size && extra) { this.xf = 0; this.skip = 0; } // not enough data: no jump
      produced = need <= this.size ? n : Math.max(0, Math.floor((this.size - 1 - this.frac) / this.rate));
      const fadeOutFrom = produced < n ? Math.max(0, produced - FADE) : n;
      let pos = this.frac;
      for (let i = 0; i < produced; i++) {
        let g = 1;
        if (this.fadeIn > 0) { g = 1 - this.fadeIn / FADE; this.fadeIn--; }
        if (i >= fadeOutFrom) g *= (produced - i) / (produced - fadeOutFrom + 1);
        const k = Math.floor(pos);
        const t = pos - k;
        const r0 = (this.read + k) % this.cap;
        const r1 = (r0 + 1) % this.cap;
        const w = this.xf > 0 ? 1 - this.xf / XFADE : 0;
        const s0 = (r0 + this.skip) % this.cap;
        const s1 = (s0 + 1) % this.cap;
        for (let c = 0; c < out.length; c++) {
          const b = this.buf[Math.min(c, this.channels - 1)];
          let v = b[r0] + (b[r1] - b[r0]) * t;
          if (w > 0) v = v * (1 - w) + (b[s0] + (b[s1] - b[s0]) * t) * w;
          out[c][i] = v * g;
        }
        pos += this.rate;
        if (this.xf > 0 && --this.xf === 0) {
          pos += this.skip; // the crossfade is complete: continue from the later audio
          this.stats.dropped += this.skip;
          this.skip = 0;
        }
      }
      const used = Math.floor(pos);
      this.frac = pos - used;
      this.read = (this.read + used) % this.cap;
      this.size -= used;
      if (produced < n) { this.playing = false; this.stats.rebuffers++; this.frac = 0; }
    }
    for (let c = 0; c < out.length; c++) out[c].fill(0, produced);
    this.stats.played += produced;
    this.stats.silent += n - produced;
    // Discontinuity detector on channel 0.
    const x = out[0];
    let [a, b] = this.prev;
    let step = 0;
    for (let i = 0; i < n; i++) { const d = Math.abs(x[i] - 2 * b + a); if (d > step) step = d; a = b; b = x[i]; }
    this.prev = [a, b];
    if (step > this.stats.maxStep) this.stats.maxStep = step;
    if (step > CLICK_THRESHOLD) this.stats.clicks++;
    this.sinceReport += n;
    if (this.sinceReport >= sampleRate / 4) {
      this.sinceReport = 0;
      this.port.postMessage({ type: "stats", ...this.stats, bufferedFrames: this.size, playing: this.playing, rate: this.rate });
      this.stats.maxStep = 0;
    }
    return true;
  }
}
registerProcessor("${WORKLET_NAME}", Player);
`;
