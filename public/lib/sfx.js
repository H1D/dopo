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
 *
 * Decision blips are weighted by the same heft() signal the dust uses, so a
 * rent payment drops with more mass than a coffee. dropParams() holds that
 * mapping as pure arithmetic — importable and unit-testable without an
 * AudioContext; everything below it is graph-building.
 */

import { QUAKE_AT } from "./dust.js";

export const MUSIC_VOL = 0.4;
export const SFX_VOL = 0.7;

// Swipe zap pitches: the three actions get distinct bases so the ear learns
// them — accept highest, pick middle, park lowest.
export const SWIPE_HZ = { accept: 880, pick: 660, park: 440 };

/**
 * Heft at or below this is an ordinary transaction: it drops with exactly the
 * pre-weight blip and nothing else. The weight curve is re-normalized above
 * the floor rather than applied from 0, so the common case is untouched and
 * the whole expressive range is spent on the cards that actually feel big.
 */
const DROP_FLOOR = 0.3;

/** @param {number} n @returns {number} 0..1, NaN-safe */
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * How a decision should sound for a transaction of this weight. Pure.
 *
 * @param {"accept"|"pick"|"park"} kind
 * @param {number} [weight] heft() 0..1 of the card being dropped
 * @returns {{hz: number, ms: number, thump: number, rumble: number}}
 *   hz/ms shape the zap itself; thump 0..1 is how much low drop layer to mix
 *   under it; rumble 0..1 is the sub tail, 0 below the quake threshold. The
 *   tail steps in at 0.4 rather than from zero on purpose — it shares
 *   QUAKE_AT with the screen shake, and a threshold event that fades in
 *   inaudibly is just a threshold nobody hears.
 */
export function dropParams(kind, weight = 0) {
  const base = SWIPE_HZ[kind] ?? SWIPE_HZ.pick;
  const w = clamp01(weight);
  const heavy = w <= DROP_FLOOR ? 0 : (w - DROP_FLOOR) / (1 - DROP_FLOOR);
  return {
    hz: base * (1 - 0.35 * heavy),
    ms: 70 + 60 * heavy,
    thump: heavy,
    rumble: w < QUAKE_AT ? 0 : 0.4 + 0.6 * ((w - QUAKE_AT) / (1 - QUAKE_AT)),
  };
}

/**
 * @typedef {object} AudioBus
 * @property {AudioContext} ctx
 * @property {GainNode} music  BGM plugs its player gain in here
 * @property {GainNode} sfx    all effects mix through here
 * @property {HTMLAudioElement|null} mediaEl  the music sink — a hidden media
 *   element fed by a MediaStream, so the OS owns a real pause handle for the
 *   music (lock screen, headphone buttons, call interruptions). null when the
 *   stream route failed; music then plays via ctx.destination like SFX.
 */

/** @param {AudioContext} ctx @returns {DynamicsCompressorNode} */
function makeLimiter(ctx) {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -4;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.25;
  return limiter;
}

/** @returns {AudioBus} */
export function createAudioBus() {
  const ctx = new AudioContext();
  // Two sinks on purpose. SFX go straight to the context destination — they
  // are UI feedback, not "media", and must not summon OS media controls or
  // die with them. Music goes through a MediaStream-fed <audio> element:
  // that element is what OS pause signals act on, what the lock screen
  // shows (with Media Session metadata from lib/music.js), and — as media
  // playback — what the iPhone silent switch does NOT mute. srcObject is a
  // live stream, not a fetched URL, so no media-src CSP entry is needed.
  const sfx = ctx.createGain();
  sfx.gain.value = SFX_VOL;
  const sfxLimiter = makeLimiter(ctx);
  sfx.connect(sfxLimiter);
  sfxLimiter.connect(ctx.destination);

  const music = ctx.createGain();
  music.gain.value = MUSIC_VOL;
  const musicLimiter = makeLimiter(ctx);
  music.connect(musicLimiter);
  /** @type {HTMLAudioElement|null} */
  let mediaEl = null;
  try {
    const sink = ctx.createMediaStreamDestination();
    const el = new Audio();
    el.srcObject = sink.stream;
    musicLimiter.connect(sink);
    mediaEl = el; // kept referenced here; never in the DOM
  } catch {
    musicLimiter.connect(ctx.destination); // additive only: music still plays
  }
  return { ctx, music, sfx, mediaEl };
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

  return {
    /**
     * Decision blip: a square zap with a fast downward pitch slide, plus — for
     * a heavy transaction — the sound of something with mass hitting the floor.
     * At weight 0 this is bit-for-bit the old 70ms zap.
     *
     * Layers, all under ~240ms total so the next card is never sung over:
     *   zap    lower and a touch longer as weight grows
     *   drop   triangle sweeping 120→45Hz with a noise tick, mixed by `thump`
     *   tail   a sine sub past QUAKE_AT — the audible half of the screen shake
     *
     * @param {"accept"|"pick"|"park"} kind
     * @param {number} [weight] heft() 0..1 of the transaction being decided
     */
    swipe(kind, weight = 0) {
      safe(() => {
        const { hz, ms, thump, rumble } = dropParams(kind, weight);
        voice("square", hz * 1.5, 0.22, ms / 1000, hz, 30);
        if (thump > 0) {
          // The tick is what makes it read as an impact on a phone speaker,
          // which reproduces none of the sweep below it.
          noiseVoice("lowpass", 400, 0.7, 0.06 * thump, 0.035);
          voice("triangle", 120, 0.1 + 0.14 * thump, 0.14, 45, 140);
        }
        // Offset behind the drop: a sub that starts with it reads as one fat
        // note, one that follows reads as the floor still moving.
        if (rumble > 0) voice("sine", 48, 0.06 + 0.08 * rumble, 0.16, 0, 0, 0.06);
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
