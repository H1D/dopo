// @ts-check
/**
 * Background chiptune music: manifest, shuffle-bag, track cache, and the
 * vendored chiptune3/libopenmpt AudioWorklet player.
 *
 * Contracts (each earned the hard way in review):
 * - Additive only: every failure path ends in silence, never a broken app.
 * - Pre-warm without a gesture: engine init, wasm compile, manifest and track
 *   fetches all happen at boot when music is enabled; the first user gesture
 *   only does ctx.resume() + play(), so music lands instantly. If the gesture
 *   beats the pre-warm, an intent flag plays as soon as bytes are ready.
 * - The upstream worklet posts 'end' every 128-frame quantum (~375/s) once a
 *   module finishes — the onEnded handler latches on the first event and
 *   stop()s synchronously before any async work.
 * - repeatCount is sticky in the worklet config: reset to 0 after every
 *   play(), then raised to 1 from onMetadata for sub-minute loopers so a 25s
 *   keygen loop plays twice without leaking onto the next track.
 * - Skips are stamped with a generation counter; stale async resolutions are
 *   dropped, so hammering skip can neither double-play nor double-advance.
 * - Singleton player: toggling music off stops playback but keeps the node —
 *   a second AudioWorkletNode wired into the same bus would double audio.
 * - Tracks are cross-origin (R2); the SW ignores foreign origins by design,
 *   so caching is page-level Cache API: cache-on-play + prefetch next-in-bag.
 * - OS pause signals are law: music renders through a MediaStream-fed <audio>
 *   sink (see sfx.js createAudioBus) with Media Session metadata/handlers, so
 *   lock-screen and headphone pause/play/next work. Any pause freezes the
 *   MODULE too (the sink is a live stream — a running worklet would walk the
 *   bag inaudibly), and an OS pause survives tab-visibility round-trips.
 */

import { advance, applyBan, currentTrack, normalizeState, peekNext } from "./shuffle.js";
import { musicStateLoad, musicStateSave } from "./store.js";
import { MUSIC_VOL } from "./sfx.js";

export const MUSIC_ORIGIN = "https://dopo-music.artems.net";
const TRACK_CACHE = "dopo-music-v1";
const VENDOR_CACHE = "dopo-vendor";
const VENDOR_DIR = "chiptune3-0.8.7";
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * @typedef {object} TrackMeta
 * @property {string} id
 * @property {string} file
 * @property {string} title
 * @property {string} author
 */

/**
 * The slice of the vendored ChiptuneJsPlayer API this module uses. The vendor
 * dir is excluded from checkJs (upstream code, integrity-pinned instead), so
 * the import is dynamic-by-URL and typed here.
 * @typedef {object} ChiptunePlayer
 * @property {GainNode} gain
 * @property {(h: () => void) => void} onInitialized
 * @property {(h: () => void) => void} onEnded
 * @property {(h: {(e: {type: string}): void}) => void} onError
 * @property {(h: {(meta: {dur?: number, title?: string, artist?: string}): void}) => void} onMetadata
 * @property {(buf: ArrayBuffer) => void} play
 * @property {() => void} stop
 * @property {() => void} pause    worklet renders silence, position kept
 * @property {() => void} unpause
 * @property {(n: number) => void} setRepeatCount
 */

/** @param {unknown} raw @returns {TrackMeta[]} */
function normalizeManifest(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {TrackMeta[]} */
  const out = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const o = /** @type {Record<string, unknown>} */ (e);
    if (typeof o.id !== "string" || typeof o.file !== "string" || !o.id || !o.file) continue;
    out.push({
      id: o.id,
      file: o.file,
      title: typeof o.title === "string" && o.title ? o.title : o.id,
      author: typeof o.author === "string" && o.author ? o.author : "unknown",
    });
  }
  return out;
}

/**
 * @param {object} opts
 * @param {import("./sfx.js").AudioBus} opts.bus
 * @param {(now: {title: string, author: string}|null) => void} opts.onTrackChange
 *   mini-player repaint hook; null = nothing playing
 * @param {() => boolean} opts.anyAudioOn  is EITHER toggle on — the visibility
 *   suspend/resume acts on the shared context, so it must know about SFX too
 */
export function createMusic({ bus, onTrackChange, anyAudioOn }) {
  const { ctx } = bus;

  /** @type {ChiptunePlayer|null} */
  let player = null;
  /** @type {TrackMeta[]} */
  let tracks = [];
  /** @type {Map<string, TrackMeta>} */
  let byId = new Map();
  let state = normalizeState(null, []);
  let enabled = false; // the settings toggle, mirrored here
  let started = false; // a gesture has unlocked audio this session
  let pendingPlay = false; // gesture arrived before pre-warm finished
  let prewarmed = false;
  /** @type {Promise<void>|null} */
  let prewarmP = null;
  let generation = 0; // stamps every transition; stale async work is dropped
  let endLatch = false;
  let failStreak = 0;
  /** @type {ArrayBuffer|null} */
  let readyBuf = null; // pre-fetched bytes for the current track
  let muted = false;
  let osPaused = false; // the OS/user paused via a media control — respect it
  let expectElPause = false; // our own mediaEl.pause() calls, not OS signals

  const persist = () => { try { musicStateSave(state); } catch { /* bag restarts next session */ } };

  /** @param {MediaSessionPlaybackState} s */
  const setPlaybackState = (s) => {
    try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = s; }
    catch { /* additive only */ }
  };

  const notify = () => {
    const t = enabled ? byId.get(currentTrack(state) ?? "") : undefined;
    onTrackChange(t ? { title: t.title, author: t.author } : null);
    // Lock screen / media hub: the same attribution the popover shows.
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = t
          ? new MediaMetadata({
              title: t.title,
              artist: t.author,
              album: "dopo",
              artwork: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }],
            })
          : null;
      }
    } catch { /* additive only */ }
  };

  /** Start (or restart) the media-element sink; outside a gesture this can
   * reject under autoplay policy — caught, the next gesture retries. */
  const mediaPlay = () => {
    if (bus.mediaEl && bus.mediaEl.paused) void bus.mediaEl.play().catch(() => { /* additive only */ });
  };
  const mediaPause = () => {
    if (bus.mediaEl && !bus.mediaEl.paused) {
      expectElPause = true;
      bus.mediaEl.pause();
    }
  };

  /** An OS-level pause signal (media key, lock screen, headphones, incoming
   * call). Freeze the module position too — the element sink is a LIVE
   * stream, so leaving the worklet running would let the track (and the
   * whole bag) advance silently while "paused". */
  function pauseFromOS() {
    if (!enabled || !started) return;
    osPaused = true;
    player?.pause();
    mediaPause();
    setPlaybackState("paused");
  }

  /** The matching OS play signal. Media-session callbacks carry user
   * activation, so resume() is permitted here even from the lock screen. */
  function resumeFromOS() {
    if (!enabled) return;
    osPaused = false;
    void ctx.resume().catch(() => { /* additive only */ });
    player?.unpause();
    mediaPlay();
    setPlaybackState("playing");
  }

  try {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("pause", pauseFromOS);
      navigator.mediaSession.setActionHandler("play", resumeFromOS);
      navigator.mediaSession.setActionHandler("nexttrack", () => api.skip());
    }
  } catch { /* additive only */ }

  // Some platforms pause the element directly (audio-focus loss, wired
  // headphone buttons) without dispatching a media-session action. An
  // element pause we didn't initiate IS an OS pause signal.
  bus.mediaEl?.addEventListener("pause", () => {
    if (expectElPause) { expectElPause = false; return; }
    if (enabled && started && !osPaused && !document.hidden) pauseFromOS();
  });
  bus.mediaEl?.addEventListener("play", () => {
    if (osPaused) resumeFromOS();
  });

  /** @param {string} id @returns {string} */
  const urlOf = (id) => `${MUSIC_ORIGIN}/${byId.get(id)?.file ?? id}`;

  /** Cache-first track bytes; network fills the cache on first hearing.
   * @param {string} id @returns {Promise<ArrayBuffer>} */
  async function trackBytes(id) {
    const cache = await caches.open(TRACK_CACHE);
    const url = urlOf(id);
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(`track ${id}: ${res.status}`);
    await cache.put(url, res.clone());
    return res.arrayBuffer();
  }

  /** Warm the cache for the next bag entry; failures are the next skip's problem. */
  function prefetchNext() {
    const next = peekNext(state);
    if (!next) return;
    trackBytes(next).catch(() => { /* additive only */ });
  }

  /** Manifest: network-first (it changes when tracks are added) with a hard
   * deadline — on lie-fi the cached copy must win, not a stalled fetch —
   * and cache fallback so offline sessions still get music.
   * @returns {Promise<TrackMeta[]>} */
  async function loadManifest() {
    const cache = await caches.open(TRACK_CACHE);
    const url = `${MUSIC_ORIGIN}/manifest.json`;
    try {
      const res = await fetch(url, { mode: "cors", signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`manifest: ${res.status}`);
      await cache.put(url, res.clone());
      return normalizeManifest(await res.json());
    } catch {
      const hit = await cache.match(url);
      if (!hit) return [];
      return normalizeManifest(await hit.json().catch(() => null));
    }
  }

  /** Old vendor versions leave dead entries in the persistent vendor cache
   * (the SW's activate purge deliberately spares it) — prune them here. */
  async function pruneVendorCache() {
    try {
      const cache = await caches.open(VENDOR_CACHE);
      for (const req of await cache.keys()) {
        const path = new URL(req.url).pathname;
        if (path.includes("/vendor/") && !path.includes(`/vendor/${VENDOR_DIR}/`)) {
          await cache.delete(req);
        }
      }
    } catch { /* additive only */ }
  }

  /** @returns {Promise<ChiptunePlayer>} */
  async function initPlayer() {
    // Dynamic-by-URL so tsc doesn't pull the excluded vendor file into the
    // program; the ChiptunePlayer typedef above covers the surface we use.
    const href = new URL(`../vendor/${VENDOR_DIR}/chiptune3.js`, import.meta.url).href;
    const mod = await import(href);
    /** @type {ChiptunePlayer} */
    const p = new mod.ChiptuneJsPlayer({ context: ctx, repeatCount: 0 });
    // Upstream eats addModule rejections (constructor .catch(console.error)),
    // so onInitialized may simply never fire; without a deadline prewarm would
    // hang un-settleable for the whole session instead of degrading to silence.
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("worklet init timeout")), 10_000);
      p.onInitialized(() => { clearTimeout(deadline); resolve(undefined); });
    });
    // With an external context chiptune3 connects to nothing — wire it or
    // get perfectly silent "working" playback.
    p.gain.connect(bus.music);
    p.onEnded(() => {
      // fires every render quantum until the next play/stop — latch + stop NOW
      if (endLatch) return;
      endLatch = true;
      p.stop();
      void advanceAndPlay(++generation);
    });
    p.onError((e) => {
      if (!enabled || !started) return;
      // 'ptr'/'Load' mean module create/load failed — they fire INSTEAD of the
      // metadata that would clear the latch, so they must bypass it or a
      // corrupt track dead-ends the session.
      const createFailed = e.type === "ptr" || e.type === "Load";
      if (endLatch && !createFailed) return;
      endLatch = true;
      p.stop();
      failStreak++;
      if (failStreak < MAX_CONSECUTIVE_FAILURES) void advanceAndPlay(++generation);
      else notify(); // give up silently for the session; one bad file ≠ no music
    });
    p.onMetadata((meta) => {
      // The latch clears HERE, not in playBuffer: the worklet floods 'end'
      // until it processes stop, and port ordering guarantees every stale
      // 'end' precedes the new track's metadata — clearing any earlier lets a
      // leftover 'end' from the old track kill the new one on a warm cache.
      endLatch = false;
      failStreak = 0; // a track actually loaded — the streak is over
      // Sub-minute loopers play twice; repeatCount is sticky, so play() below
      // always resets it to 0 first and this raises it per-track.
      if (typeof meta.dur === "number" && meta.dur > 0 && meta.dur < 60) p.setRepeatCount(1);
    });
    return p;
  }

  /** @param {number} gen */
  async function advanceAndPlay(gen) {
    try {
      state = advance(state, tracks.map((t) => t.id), Math.random);
      persist();
      const id = currentTrack(state);
      if (!id) { notify(); return; }
      const buf = await trackBytes(id);
      if (gen !== generation || !enabled) return; // a newer skip/toggle won
      playBuffer(buf);
      notify();
      prefetchNext();
    } catch {
      if (gen !== generation || !enabled) return;
      failStreak++;
      if (failStreak < MAX_CONSECUTIVE_FAILURES) void advanceAndPlay(gen);
      else notify();
    }
  }

  /** @param {ArrayBuffer} buf */
  function playBuffer(buf) {
    if (!player) return;
    // Any play invalidates the staged boot buffer — a stale one surviving a
    // toggle cycle would play track A while the popover attributes (and ban
    // targets) track B, and the attribution must never lie.
    readyBuf = null;
    // endLatch is NOT cleared here — onMetadata does it (see initPlayer).
    player.play(buf);
    player.setRepeatCount(0); // undo a previous track's short-looper bump
    // A fresh track always plays audibly: an explicit start overrides a
    // stale OS pause (skip from the lock screen implies "and play it").
    osPaused = false;
    mediaPlay();
    setPlaybackState("playing");
  }

  /** Boot-time engine + data warm-up; everything here is gesture-free. */
  function prewarm() {
    if (prewarmP) return prewarmP;
    prewarmP = (async () => {
      void pruneVendorCache();
      const [p, manifest] = await Promise.all([initPlayer(), loadManifest()]);
      player = p;
      tracks = manifest;
      byId = new Map(tracks.map((t) => [t.id, t]));
      state = normalizeState(musicStateLoad(), tracks.map((t) => t.id));
      // Every open starts on a fresh track — the walk advanced across sessions.
      state = advance(state, tracks.map((t) => t.id), Math.random);
      persist();
      const id = currentTrack(state);
      if (id) {
        readyBuf = await trackBytes(id).catch(() => null);
        prefetchNext();
      }
      prewarmed = true;
      if (pendingPlay && enabled) {
        pendingPlay = false;
        if (readyBuf && player) {
          playBuffer(readyBuf);
          notify();
        } else if (player) {
          // boot fetch of the first track failed — the error-cap skip
          // machinery must still run, or this session dead-ends silent
          void advanceAndPlay(++generation);
        }
      }
    })().catch(() => { prewarmed = true; /* engine unavailable → silence */ });
    return prewarmP;
  }

  /** First-gesture unlock (also called by the toggle click). resume() is the
   * only gesture-gated call; play follows data-readiness, not the gesture. */
  function gesture() {
    if (!enabled || started) return;
    started = true;
    void ctx.resume().catch(() => { /* additive only */ });
    mediaPlay(); // inside the gesture: the element sink unlocks here too
    if (!prewarmed) {
      // pre-warm still running (or never started): flag the intent — its tail
      // plays as soon as bytes are ready. A settled promise re-runs nothing,
      // hence the explicit branch below for the already-warm case.
      pendingPlay = true;
      void prewarm();
      return;
    }
    if (readyBuf && player) {
      playBuffer(readyBuf);
      readyBuf = null;
      notify();
      prefetchNext();
    } else if (player) {
      // warm but no staged buffer (same-session re-enable): walk to the next track
      void advanceAndPlay(++generation);
    }
  }

  // -- visibility: freeze the render thread, keep the position ---------------
  // Bus-scoped, not music-scoped: an SFX-only session also holds a running
  // AudioWorklet context that must not keep rendering in a hidden tab.
  let resumeRetryArmed = false;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Pause the module and the element sink BEFORE suspending: the stream
      // is live, so a still-running worklet would walk the bag inaudibly.
      if (enabled && started && !osPaused) {
        player?.pause();
        mediaPause();
        setPlaybackState("paused");
      }
      if (ctx.state === "running") void ctx.suspend().catch(() => { /* additive only */ });
    } else {
      if (!anyAudioOn()) return;
      void ctx.resume().catch(() => { /* additive only */ });
      // Hidden-pause undoes itself on return — but an OS pause does NOT:
      // if the user paused from the lock screen, coming back keeps it paused.
      if (enabled && started && !osPaused) {
        player?.unpause();
        mediaPlay();
        setPlaybackState("playing");
      }
      // iOS parks the context in "interrupted" after lock/background; resume()
      // there can silently fail until the next gesture — retry on one (a
      // single armed retry; repeated hide/show cycles must not stack them).
      setTimeout(() => {
        if (!document.hidden && anyAudioOn() && ctx.state !== "running" && !resumeRetryArmed) {
          resumeRetryArmed = true;
          document.addEventListener("pointerdown", () => {
            resumeRetryArmed = false;
            if (anyAudioOn()) void ctx.resume().catch(() => { /* additive only */ });
          }, { once: true });
        }
      }, 500);
    }
  });

  const api = {
    /** Settings toggle → on. The toggle click itself is the unlock gesture. */
    enable() {
      if (enabled) return;
      enabled = true;
      failStreak = 0;
      osPaused = false;
      if (started) {
        // same-session re-enable: resume the walk where it stood
        started = false;
      }
      gesture();
    },

    /** Settings toggle → off. Stops playback, keeps the engine (singleton). */
    disable() {
      if (!enabled) return;
      enabled = false;
      generation++;
      endLatch = true; // swallow the end-flood from the stop below
      player?.stop();
      mediaPause();
      setPlaybackState("none");
      notify();
    },

    /** App boot with music enabled: warm everything before any gesture. */
    prewarm(/** @type {boolean} */ isEnabled) {
      enabled = isEnabled;
      if (enabled) void prewarm();
    },

    gesture,

    /** Mini-player ⏭ — advance the bag, drop stale hammered skips. */
    skip() {
      if (!enabled || !player) return;
      endLatch = true;
      player.stop();
      player.unpause(); // a skip while OS-paused means "play the next one"
      failStreak = 0;
      void advanceAndPlay(++generation);
    },

    /** Mini-player 🚫 — never play this track again, then move on. */
    ban() {
      const id = currentTrack(state);
      if (!id || !enabled || !player) return;
      state = applyBan(state, id);
      persist();
      endLatch = true;
      player.stop();
      failStreak = 0;
      void advanceAndPlay(++generation);
    },

    /** Mini-player 🔇 — volume gate only; the walk keeps moving. */
    setMuted(/** @type {boolean} */ m) {
      muted = m;
      try { bus.music.gain.value = m ? 0 : MUSIC_VOL; }
      catch { /* additive only */ }
    },

    get muted() { return muted; },

    /** @returns {{title: string, author: string}|null} */
    now() {
      const t = byId.get(currentTrack(state) ?? "");
      return enabled && t ? { title: t.title, author: t.author } : null;
    },
  };
  return api;
}
