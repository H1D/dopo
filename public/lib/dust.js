/**
 * Impact dust for the deal-in animation.
 *
 * The sprite sheet is baked at build time (scripts/gen-dust-sprite.ts): 16
 * frames x 2 rows, white with an alpha channel. Rendering those frames in-page
 * cost ~300ms of blocked main thread on a mid-range phone, on every cold load.
 * Row 0 is a compact puff (canvas particles), row 1 a wide ground cloud (a
 * single CSS-masked element, coloured via --dust so one asset serves both
 * themes).
 *
 * This fires on every set load, so it is tiered:
 *   2  wide cloud + contact shadow + canvas puffs + grit specks   (default)
 *   1  wide cloud + contact shadow only — no canvas, no rAF
 *   0  nothing                                                     (reduced motion)
 *
 * Tier 2 demotes itself to 1 when a blast blows its frame budget, so a slow
 * device pays for one janky animation instead of every one. Demotion is
 * deliberately one-way for the session: re-probing would risk handing a
 * struggling device the expensive path back on every few landings, and the
 * cheap tier still shows a cloud. Everything renders
 * at z-index 0 inside .stage, i.e. UNDER the cards (z 1-3): the dust billows
 * out from beneath the deck rather than washing across the card face.
 */

/** Keep in sync with .card.dealing in app.css. */
export const DEAL_MS = 520;
/** Keyframe offset where the card touches down — when the dust fires. */
export const DEAL_IMPACT = 0.62;
/** Same, for .card.landing: the shorter hop the next card makes after a swipe.
 *  0.52 is where card-land's fall segment ends — the frame the card actually
 *  touches down, not where it finishes settling. */
export const LAND_MS = 420;
export const LAND_IMPACT = 0.52;

/** Impact delay per landing kind, so the dust hits when the card actually does. */
const IMPACT_MS = {
  deal: DEAL_MS * DEAL_IMPACT,
  land: LAND_MS * LAND_IMPACT,
};

const FRAMES = 16;
const CELL = 128;          // one sprite cell, matches gen-dust-sprite.ts
const MAX_PARTS = 40;      // hard ceiling on concurrent canvas particles
const BUDGET_MS = 7;       // >7ms of a 16.7ms frame on dust alone = we are the problem
const JANK_MS = 30;        // sustained <33fps while dusting = back off regardless of cause

/** Heft at or below this leaves the landing at its baseline weight. */
const HEFT_FLOOR = 1;
/** Multiple of the reference amount that counts as "as big as it gets". */
const HEFT_CEIL = 8;
/** Heft above this shakes the screen. */
export const QUAKE_AT = 0.5;

/**
 * How heavy a transaction should feel, 0..1.
 *
 * Measured against the deck's OWN median rather than a fixed "€100 is big"
 * threshold: amounts are strings from Lunch Money in whatever currency the
 * account uses, and what counts as a big transaction differs per person. A
 * relative scale adapts to both. Log-scaled because spending is roughly
 * log-normal — linear scaling would leave almost everything at zero and let
 * one rent payment saturate the whole range.
 *
 * @param {unknown} amount raw LM amount (string or number, sign ignored)
 * @param {number} reference median absolute amount of the loaded deck
 * @returns {number} 0 at or below the median, 1 at HEFT_CEIL x the median
 */
export function heft(amount, reference) {
  const amt = Math.abs(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  if (!Number.isFinite(reference) || reference <= 0) return 0;
  const ratio = amt / reference;
  if (ratio <= HEFT_FLOOR) return 0;
  return Math.min(1, Math.log2(ratio) / Math.log2(HEFT_CEIL));
}

/**
 * Median absolute amount across the loaded deck — the reference heft is scored
 * against. Median, not mean, so one outlier does not flatten everything else.
 * @param {{amount?: unknown}[]} txns
 * @returns {number} 0 when there is nothing usable to measure
 */
export function referenceAmount(txns) {
  const xs = [];
  for (const t of txns) {
    const n = Math.abs(Number(t?.amount));
    if (Number.isFinite(n) && n > 0) xs.push(n);
  }
  if (!xs.length) return 0;
  xs.sort((a, b) => a - b);
  const mid = xs.length >> 1;
  return xs.length % 2 ? (xs[mid] ?? 0) : ((xs[mid - 1] ?? 0) + (xs[mid] ?? 0)) / 2;
}

/**
 * Only demote on signals that genuinely mean "weak device". Safari exposes no
 * deviceMemory and an unhelpful hardwareConcurrency, so guessing from those
 * would wrongly punish iPhones — the frame-budget check is what catches
 * everything else, by measuring instead of predicting.
 */
export function initialTier() {
  if (typeof navigator === "undefined") return 2;
  const nav = /** @type {any} */ (navigator);
  if (nav.connection?.saveData) return 1;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 2) return 1;
  const cpu = nav.hardwareConcurrency;
  if (typeof cpu === "number" && cpu > 0 && cpu <= 2) return 1;
  return 2;
}

/**
 * @param {{ reducedMotion?: boolean, haptic?: (p: number[]) => void, sheetUrl?: string }} [opts]
 */
export function createDust(opts = {}) {
  const { reducedMotion = false, haptic = () => {}, sheetUrl = "dust.png" } = opts;

  let tier = reducedMotion ? 0 : initialTier();
  /** @type {HTMLImageElement | null} */ let sheet = null;
  let sheetState = ""; // "" | "loading" | "ready" | "failed"
  /** @type {HTMLCanvasElement | null} */ let tinted = null;
  let tintKey = "";
  /** @type {HTMLCanvasElement | null} */ let cv = null;
  let raf = 0;
  let last = 0, frames = 0, drawMs = 0, simStart = 0;
  // retained after a blast scores itself, so the dev harness can read them
  let lastDrawMs = 0, lastFrameMs = 0;
  /** @type {{x:number,y:number,vx:number,vy:number,size:number,rot:number,vr:number,life:number,max:number,delay:number,op:number}[]} */
  let parts = [];
  /** @type {{x:number,y:number,vx:number,vy:number,r:number,life:number,max:number}[]} */
  let grit = [];
  /** @type {ReturnType<typeof setTimeout>[]} */ let timers = [];
  /** @type {ReturnType<typeof setTimeout>|0} own timer: a new shake must cancel
   *  the old one's cleanup rather than inherit it */
  let quakeTimer = 0;

  /** Decode off the critical path so the first deal-in has it ready. A failed
   *  load drops to tier 0 rather than throwing on every landing. */
  function preload() {
    if (sheetState || tier === 0) return;
    sheetState = "loading";
    const img = new Image();
    img.decoding = "async";
    img.addEventListener("load", () => { sheet = img; sheetState = "ready"; }, { once: true });
    img.addEventListener("error", () => { sheetState = "failed"; tier = 0; }, { once: true });
    img.src = sheetUrl;
  }

  /** Row 0 recoloured to --dust. Cached: ~260k pixels, one pass per theme
   *  rather than per particle. */
  function tintedSheet() {
    if (!sheet) return null;
    const color = getComputedStyle(document.documentElement)
      .getPropertyValue("--dust").trim() || "#b3a89a";
    if (tinted && tintKey === color) return tinted;
    const c = document.createElement("canvas");
    c.width = sheet.naturalWidth;
    c.height = CELL;
    const x = c.getContext("2d");
    if (!x) return null;
    x.drawImage(sheet, 0, 0, c.width, CELL, 0, 0, c.width, CELL);
    x.globalCompositeOperation = "source-in";
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    tinted = c;
    tintKey = color;
    return c;
  }

  /** @param {() => void} fn @param {number} ms */
  function later(fn, ms) {
    const id = setTimeout(fn, ms);
    timers.push(id);
    return id;
  }

  /**
   * Fire a landing. `stackEl` is the card deck; dust is positioned relative to
   * its offset parent so it layers under the cards. `kind` picks which card
   * animation to sync to — a swipe's hop lands sooner than a dealt card.
   * @param {HTMLElement} stackEl
   * @param {"deal"|"land"} [kind]
   * @param {number} [hf] 0..1 from heft() — scales the puff and, past
   *   QUAKE_AT, shakes the screen
   */
  function blast(stackEl, kind = "deal", hf = 0) {
    if (tier === 0) return;
    const stage = stackEl.parentElement;
    if (!stage) return;
    const stackR = stackEl.getBoundingClientRect();
    const stageR = stage.getBoundingClientRect();
    const cx = stackR.left - stageR.left + stackR.width / 2;
    const cy = stackR.bottom - stageR.top - 8;
    const w = stackR.width;
    if (!w) return;

    // One card hopping into place is a smaller event than dealing a whole deck,
    // and it fires on every swipe — so it throws less dust and skips the
    // stragglers, which exist for the peek cards landing behind the top one.
    const heavy = kind === "deal";
    // A big transaction throws more of everything. Clamped, because this fires
    // on every swipe and the ceiling has to stay tasteful.
    const h = Math.max(0, Math.min(1, hf));

    later(() => {
      if (document.hidden || tier === 0) return;
      if (h >= QUAKE_AT) quake((h - QUAKE_AT) / (1 - QUAKE_AT));
      haptic(heavy ? [18, 40, 10] : h >= QUAKE_AT ? [12, 30, 18] : [12]);
      ground(stage, cx, heavy ? cy : cy + 10, w, heavy ? 500 : 380);
      // Wide ground-hugging cloud: it has to end up WIDER than the deck, or the
      // card silhouette hides all of it and only the canvas particles read.
      //
      // The swipe puff also spawns near full size and BELOW the card's bottom
      // edge. Starting small and tucked 12px inside the silhouette (as the deal
      // does) means the first ~130ms of the cloud's life is spent invisible
      // behind an opaque card, which turns an impact into smoke that drifts up
      // afterwards. The deal can afford that ramp; a per-swipe puff cannot.
      cloud(stage, cx, heavy ? cy - 4 : cy + 10, {
        // Growth is mostly in s1 rather than the base size: the cloud spawns
        // behind the card, so extra width only reads once it clears the
        // silhouette — scaling the base alone was 2.7x internally but 1.4x
        // on screen, most of it occluded.
        size: Math.round(w * (heavy ? 0.86 : 0.8) * (1 + h * 0.3)),
        wide: true, dur: heavy ? 950 : 560 + h * 160,
        dy: -6 - h * 14, s0: heavy ? 0.5 : 0.95, s1: (heavy ? 1.3 : 1.7) + h * 0.6,
        // at tier 1 there are no particles adding ink, so the cloud carries the
        // whole landing on its own and needs to be denser to register at all
        op: Math.min(1, (heavy ? 0.95 : 0.78) * (1 + h * 0.25) * (tier === 1 ? 1.35 : 1)),
      });
      if (tier >= 2) {
        sim(stage, cx, cy, w, Math.round((heavy ? 13 : 8) * (1 + h * 0.7)), h);
        // stragglers timed to the two peek cards landing behind the top one
        if (heavy) later(() => tier >= 2 && cloud(stage, cx - w * 0.3, cy, {
          size: Math.round(w * 0.3), dur: 800, dx: -26, dy: -14, s0: 0.5, s1: 1.5, op: 0.5,
        }), 70);
        if (heavy) later(() => tier >= 2 && cloud(stage, cx + w * 0.3, cy, {
          size: Math.round(w * 0.3), dur: 800, dx: 26, dy: -12, s0: 0.5, s1: 1.5, op: 0.45,
        }), 140);
      }
    }, IMPACT_MS[kind] ?? IMPACT_MS.deal);
  }

  /**
   * One sheet-animated cloud. CSS drives it: mask-position steps through the
   * frames while the transform eases.
   * @param {HTMLElement} stage
   * @param {number} x @param {number} y
   * @param {{size:number, dur:number, dy:number, s0:number, s1:number,
   *          wide?:boolean, dx?:number, op?:number}} o
   */
  function cloud(stage, x, y, o) {
    const el = document.createElement("div");
    el.className = "dust-cloud";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.setProperty("--sz", `${o.size}px`);
    el.style.setProperty("--sheet-w", `${o.size * FRAMES}px`);
    el.style.setProperty("--row", o.wide ? `${-o.size}px` : "0px");
    el.style.setProperty("--dur", `${o.dur}ms`);
    el.style.setProperty("--dx", `${o.dx ?? 0}px`);
    el.style.setProperty("--dy", `${o.dy}px`);
    el.style.setProperty("--s0", String(o.s0));
    el.style.setProperty("--s1", String(o.s1));
    el.style.setProperty("--op", String(o.op ?? 1));
    el.addEventListener("animationend", () => el.remove(), { once: true });
    // animationend never fires while backgrounded — don't leak the node
    later(() => el.remove(), o.dur + 400);
    stage.appendChild(el);
  }

  /** @param {HTMLElement} stage @param {number} x @param {number} y
   *  @param {number} w @param {number} [dur] */
  function ground(stage, x, y, w, dur = 500) {
    const g = document.createElement("div");
    g.className = "dust-ground";
    g.style.left = `${x}px`;
    g.style.top = `${y - 10}px`;
    g.style.width = `${w * 0.92}px`;
    g.style.height = "26px";
    g.style.animationDuration = `${dur}ms`;
    g.addEventListener("animationend", () => g.remove(), { once: true });
    later(() => g.remove(), 900);
    stage.appendChild(g);
  }

  /**
   * Canvas particles: heavy drag then buoyancy for the puffs, real gravity for
   * the grit. The canvas covers the deck's footprint, not the viewport.
   * @param {HTMLElement} stage
   * @param {number} x @param {number} y @param {number} w
   * @param {number} [count] puff count; a swipe landing throws fewer than a deal
   * @param {number} [h] 0..1 heft — a heavier card throws its dust further
   */
  function sim(stage, x, y, w, count = 13, h = 0) {
    const tex = tintedSheet();
    if (!tex) { preload(); return; } // cloud alone still reads fine
    const bw = Math.round(w + 260);
    const bh = 190;
    const left = x - bw / 2;
    const top = y - 120;
    // 1.5x is plenty for something this soft; 2x would nearly double fill cost
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);

    if (!cv) {
      cv = document.createElement("canvas");
      cv.className = "dust-canvas";
    }
    cv.style.left = `${left}px`;
    cv.style.top = `${top}px`;
    cv.style.width = `${bw}px`;
    cv.style.height = `${bh}px`;
    cv.width = Math.round(bw * dpr);
    cv.height = Math.round(bh * dpr);
    if (!cv.isConnected) stage.appendChild(cv);

    const ox = x - left, oy = y - top;
    const rnd = Math.random;
    for (let i = 0; i < count && parts.length < MAX_PARTS; i++) {
      const side = i % 2 ? 1 : -1;
      parts.push({
        x: ox + side * w * (0.12 + rnd() * 0.34), y: oy - rnd() * 6,
        vx: side * (110 + rnd() * 230) * (1 + h * 0.5), vy: -(14 + rnd() * 55) * (1 + h * 0.4),
        size: (70 + rnd() * 90) * (1 + h * 0.25), rot: rnd() * 6.28, vr: (rnd() - 0.5) * 1.6,
        life: 0, max: 0.75 + rnd() * 0.45, delay: rnd() * 0.06, op: 0.5 + rnd() * 0.4,
      });
    }
    for (let i = 0; i < 10 && grit.length < MAX_PARTS; i++) {
      const side = i % 2 ? 1 : -1;
      grit.push({
        x: ox + side * w * (0.1 + rnd() * 0.32), y: oy,
        vx: side * (160 + rnd() * 280), vy: -(80 + rnd() * 180),
        r: 0.8 + rnd() * 1.6, life: 0, max: 0.5 + rnd() * 0.3,
      });
    }
    if (!raf) {
      last = performance.now();
      simStart = last;
      frames = 0;
      drawMs = 0;
      raf = requestAnimationFrame(tick);
    }
  }

  /** @param {number} now */
  function tick(now) {
    raf = 0;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx || document.hidden) { stop(); return; }

    const t0 = performance.now();
    const dpr = cv.width / parseFloat(cv.style.width || "1");
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cv.width / dpr, cv.height / dpr);
    const tex = tintedSheet();
    if (!tex) { stop(); return; }

    let alive = false;
    for (const p of parts) {
      if (p.delay > 0) { p.delay -= dt; alive = true; continue; }
      p.life += dt;
      if (p.life >= p.max) continue;
      alive = true;
      const t = p.life / p.max;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= Math.pow(0.06, dt);                   // heavy drag: burst, then hang
      p.vy = p.vy * Math.pow(0.12, dt) - 26 * dt;   // settle, then drift upward
      p.rot += p.vr * dt;
      const f = Math.min(FRAMES - 1, Math.floor(t * FRAMES));
      const s = p.size * (0.55 + t * 0.95);
      ctx.save();
      ctx.globalAlpha = p.op * (t < 0.1 ? t / 0.1 : Math.pow(1 - (t - 0.1) / 0.9, 1.3));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.drawImage(tex, f * CELL, 0, CELL, CELL, -s / 2, -s / 2, s, s);
      ctx.restore();
    }

    ctx.fillStyle = tintKey || "#b3a89a";
    for (const g of grit) {
      g.life += dt;
      if (g.life >= g.max) continue;
      alive = true;
      g.x += g.vx * dt; g.y += g.vy * dt;
      g.vx *= Math.pow(0.25, dt);
      g.vy += 620 * dt;                              // grit is heavy: it arcs and falls
      ctx.globalAlpha = 0.5 * (1 - g.life / g.max);
      ctx.beginPath();
      ctx.arc(g.x, g.y, g.r, 0, 6.284);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    drawMs += performance.now() - t0;
    frames++;

    if (alive) raf = requestAnimationFrame(tick);
    else stop();
  }

  /**
   * Tear down, and score the blast we just ran. Two independent demotion
   * signals, because they catch different failures:
   *   - draw cost: our own work inside tick() is too expensive (we are at fault)
   *   - frame interval: the animation was visibly janky whatever the cause
   * The second matters because on a device that is merely busy, our draw stays
   * cheap while the user still sees a stuttering effect — and dust is
   * decoration, so it should be the first thing to yield.
   */
  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    parts = [];
    grit = [];
    cv?.remove();
    if (frames >= 6) {
      lastDrawMs = drawMs / frames;
      lastFrameMs = (performance.now() - simStart) / frames;
      if (tier > 1 && (lastDrawMs > BUDGET_MS || lastFrameMs > JANK_MS)) tier = 1;
    }
    frames = 0;
    drawMs = 0;
    return lastDrawMs;
  }

  /** Cancel pending timers too — used when the page goes away. */
  function reset() {
    for (const id of timers) clearTimeout(id);
    timers = [];
    if (quakeTimer) { clearTimeout(quakeTimer); quakeTimer = 0; }
    document.body.classList.remove("quaking");
    stop();
  }

  /**
   * Screen shake for a genuinely big transaction.
   *
   * The class goes on <body> but the transform is applied to body's LAYOUT
   * children, never to body itself: body carries the safe-area padding, and
   * transforming it would make it the containing block for all ten
   * position:fixed overlays — shifting every toast and sheet down by the notch
   * inset on exactly the iPhone PWA this targets. The fixed overlays sit
   * outside the shaken set on purpose; chrome holding still while the deck
   * jolts is what sells the hit.
   *
   * @param {number} strength 0..1 above the quake threshold
   */
  function quake(strength) {
    const b = document.body;
    const ms = Math.round(280 + strength * 140);
    // Floor the amplitude: below ~4px the shake is masked by the dust cloud
    // exploding in the same frames, so it costs motion and reads as nothing.
    b.style.setProperty("--quake-amp", `${(4.5 + strength * 5.5).toFixed(1)}px`);
    b.style.setProperty("--quake-ms", `${ms}ms`);
    // Cancel the previous shake's cleanup, or an earlier timer ends a later,
    // still-running shake — which hard-snaps the screen back from mid-swing
    // instead of letting it decay. That snap is the one thing here that reads
    // as a glitch rather than an impact.
    if (quakeTimer) clearTimeout(quakeTimer);
    b.classList.remove("quaking");
    void b.offsetWidth; // restart the animation on a back-to-back big landing
    b.classList.add("quaking");
    quakeTimer = setTimeout(() => {
      b.classList.remove("quaking");
      quakeTimer = 0;
    }, ms + 80);
  }

  function onThemeChange() { tinted = null; tintKey = ""; }

  return {
    blast,
    stop,
    reset,
    preload,
    onThemeChange,
    get tier() { return tier; },
    /** @param {number} n */
    setTier(n) { tier = n; },
    /** Scores of the last *tier 2* blast, retained for the dev harness. Below
     *  tier 2 the sim never runs, so these keep their last real reading. */
    get lastAvgDrawMs() { return lastDrawMs; },
    get lastAvgFrameMs() { return lastFrameMs; },
  };
}
