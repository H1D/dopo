// @ts-check
/**
 * Synthesized chip-style sound effects + the shared audio graph.
 *
 * Zero assets by design: every sound is oscillators and one shared noise
 * buffer, so SFX add no CSP origins, no precache weight and no fetches.
 * Everything is additive-only: a Web Audio failure degrades to silence,
 * never to a broken app (same contract as haptic()).
 *
 * One AudioContext serves both music and SFX, split into two gain buses so
 * either can be toggled without suspending the other. The context is created
 * suspended and only resume()d from a user gesture (autoplay policy); callers
 * own that. The master DynamicsCompressor is configured as a LIMITER (high
 * threshold, steep ratio) — clip insurance when a thud lands mid-fanfare —
 * NOT as a leveler, which would audibly duck the music on every effect.
 */

export const MUSIC_VOL = 0.4;
export const SFX_VOL = 0.7;

/**
 * @typedef {object} AudioBus
 * @property {AudioContext} ctx
 * @property {GainNode} music  BGM plugs its player gain in here
 * @property {GainNode} sfx    all effects mix through here
 */

/** @returns {AudioBus} */
export function createAudioBus() {
  const ctx = new AudioContext();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -4;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);
  const music = ctx.createGain();
  music.gain.value = MUSIC_VOL;
  music.connect(limiter);
  const sfx = ctx.createGain();
  sfx.gain.value = SFX_VOL;
  sfx.connect(limiter);
  return { ctx, music, sfx };
}

/** Exponential ramps can't reach 0 — this is "silence" for envelope tails. */
const EPS = 0.0001;

/**
 * @param {AudioBus} bus
 */
export function createSfx(bus) {
  const { ctx, sfx: out } = bus;

  /** @type {AudioBuffer|null} */
  let noiseBuf = null;
  /** One shared noise buffer, built lazily — never allocate per effect. */
  const noise = () => {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.5), ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  };

  /**
   * Enveloped oscillator voice: attack snap to peak, exponential decay, hard
   * stop after the tail — a bare osc.stop() clicks.
   * @param {OscillatorType} type
   * @param {number} freq  Hz at t0
   * @param {number} peak  linear gain into the sfx bus (keep ≤ 0.3)
   * @param {number} dur   seconds to EPS
   * @param {number} [glideTo]  optional exponential pitch target
   * @param {number} [glideMs]
   * @param {number} [at]  ctx time offset from now
   */
  const voice = (type, freq, peak, dur, glideTo = 0, glideMs = 0, at = 0) => {
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo > 0) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + glideMs / 1000);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(EPS, t0 + dur);
    osc.connect(g);
    g.connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  };

  /**
   * Enveloped noise voice through a filter.
   * @param {BiquadFilterType} filterType
   * @param {number} freq  filter frequency
   * @param {number} q
   * @param {number} peak
   * @param {number} dur
   * @param {number} [at]
   * @returns {GainNode} the voice gain, for extra shaping (rumble wobble)
   */
  const noiseVoice = (filterType, freq, q, peak, dur, at = 0) => {
    const t0 = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noise();
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(EPS, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    return g;
  };

  /** @param {() => void} fn  every effect is additive-only */
  const safe = (fn) => { try { fn(); } catch { /* additive only */ } };

  // Swipe zap pitches: the three actions get distinct bases so the ear learns
  // them — accept highest, pick middle, park lowest.
  const SWIPE_HZ = { accept: 880, pick: 660, park: 440 };

  return {
    /** Decision blip: 60ms square zap with a fast downward pitch slide.
     * @param {"accept"|"pick"|"park"} kind */
    swipe(kind) {
      safe(() => {
        const f = SWIPE_HZ[kind] ?? 660;
        voice("square", f * 1.5, 0.22, 0.07, f, 30);
      });
    },

    /** Card landing, scaled by heft (0..1, same signal as the dust).
     * Layered: a 1.5kHz knock transient that survives phone speakers over a
     * low triangle+noise fundamental for headphones. @param {number} heft */
    thud(heft) {
      safe(() => {
        const h = Math.min(1, Math.max(0, heft));
        noiseVoice("bandpass", 1500, 1.2, 0.12 + 0.1 * h, 0.03);
        voice("triangle", 130, 0.15 + 0.15 * h, 0.14, 75, 110);
        noiseVoice("lowpass", 220, 0.7, 0.06 + 0.08 * h, 0.12);
      });
    },

    /** Big-transaction quake rumble: bandpassed noise with amplitude wobble
     * (audible on speakers) plus a sub layer (headphones). ~300ms.
     * @param {number} strength 0..1 */
    rumble(strength) {
      safe(() => {
        const s = Math.min(1, Math.max(0, strength));
        const g = noiseVoice("bandpass", 300, 1, 0.18 + 0.12 * s, 0.32);
        const t0 = ctx.currentTime;
        // wobble: a continuous dip-and-swell mid-burst so it shudders, not
        // hisses — ramps only; a set-event would hold at peak then step down
        g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.12);
        g.gain.exponentialRampToValueAtTime(0.14 + 0.1 * s, t0 + 0.17);
        g.gain.exponentialRampToValueAtTime(EPS, t0 + 0.32);
        voice("triangle", 55, 0.2 + 0.1 * s, 0.3);
      });
    },

    /** Every-10-decisions burst: 4-note rising square arpeggio, chip-arp speed. */
    streak() {
      safe(() => {
        [523, 659, 784, 1047].forEach((f, i) => voice("square", f, 0.18, 0.08, 0, 0, i * 0.04));
      });
    },

    /** Inbox-zero fanfare: 6-note triad climb plus a noise sparkle. */
    fanfare() {
      safe(() => {
        [523, 659, 784, 1047, 1319, 1568].forEach((f, i) =>
          voice("square", f, 0.16, 0.14, 0, 0, i * 0.09));
        noiseVoice("highpass", 4000, 0.7, 0.07, 0.5, 0.45);
      });
    },
  };
}
