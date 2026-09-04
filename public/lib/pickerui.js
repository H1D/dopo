// @ts-check
/**
 * DOM engine for the fast category pickers (tiles / columns / dock / wheel).
 *
 * `picker.js` owns everything pure: the tree, the hue map, the key table and
 * the four HTML builders. This module owns the DOM and the gestures, and
 * nothing else — no storage, no fetch, no globals beyond window/document/
 * performance, no knowledge of transactions. The host passes `onPick(catId)`
 * and `onCancel()` and injects `haptic` / `reducedMotion` so the same engine
 * runs inside the swipe deck's sheet and inline in the onboarding wizard.
 *
 * Interaction rules (plan v3 §3/§11), all deliberate:
 *   - Tiles/Cols/Dock commit on POINTERDOWN. That is the whole point of these
 *     variants: no 300ms click delay, no travel between down and up.
 *   - The Wheel is the exception — pointerdown opens/highlights, pointerup
 *     commits — because it is a press-drag-release gesture; committing on down
 *     would make a drag impossible. `pointercancel` never commits.
 *   - Input is DEAD until arm(). The host arms on the sheet's transitionend
 *     (160ms floor), so the tap that opened the sheet can never fall through
 *     onto a category. Pointers that went down before arming stay ignored for
 *     the rest of their gesture.
 *   - `committed` is a one-shot latch per mount: the host keeps the DOM around
 *     for ~150ms while the sheet slides out, and a second tap in that window
 *     must not categorize twice.
 *
 * The wheel additionally paints two things no other variant needs: a `pk-lens`
 * chip riding above the finger (the finger covers the wedge it is choosing) and
 * a hue tint on the hub, both in the hovered node's own colour. And `demo` runs
 * the very same internal handlers on a script, so the onboarding step can
 * demonstrate the real picker instead of an animation of one — it never trips
 * onInteract, which fires once on the first genuine input.
 *
 * Only the wheel redraws partially: opening a group swaps the outer ring's
 * children (and the mirrored .pk-sr buttons) but keeps the <svg> element
 * itself, so the pointer capture taken on pointerdown survives the drag.
 * Everything else is a full innerHTML redraw of the level — sub-millisecond
 * for the sizes involved (MAX_LEVEL = 40) and impossible to desync.
 */

import { R_FULL, gridCols, labelOf, renderCols, renderDock, renderTiles, renderWheel, wheelGeometry, wheelHit } from "./picker.js";

/** @typedef {import("./picker.js").PickerId} PickerId */
/** @typedef {import("./picker.js").Node} PkNode */
/** @typedef {import("./picker.js").GroupNode} PkGroup */
/** @typedef {Exclude<PickerId, "list">} PickerVariant */

/**
 * @typedef {object} PickerUIDeps
 * @property {(ms: number) => void} haptic
 * @property {boolean} reducedMotion
 */

/**
 * @typedef {object} PickerUIOpts
 * @property {HTMLElement} root         mount point; the engine owns its children
 * @property {PickerVariant} variant
 * @property {PkNode[]} tree
 * @property {Record<string, number>} hues
 * @property {number|null} guessId      model guess, committed by Enter
 * @property {number[]} recentIds
 * @property {(catId: number) => void} onPick
 * @property {() => void} onCancel
 * @property {PickerUIDeps} deps
 * @property {(() => void)} [onInteract] fired ONCE, on the first real armed input
 */

/**
 * Scripted playback of the same internal handlers a finger runs, for the
 * onboarding preview's ghost finger. Nothing here is user input: it never trips
 * onInteract and never buzzes, but every class, redraw and flash is identical.
 * @typedef {object} PickerDemo
 * @property {(key: string) => {x: number, y: number}|null} spot  centre of a target, root-relative px
 * @property {(key: string) => void} act       one tap: press flash, then open or commit
 * @property {(key: string) => void} hold      wheel: press + open the group under the finger
 * @property {(key: string) => void} slide     wheel: drag the finger onto another wedge
 * @property {(key: string) => void} release   wheel: lift, committing a leaf
 */

/**
 * @typedef {object} PickerUIHandle
 * @property {() => void} render        full redraw of the current level
 * @property {() => void} arm           open the input gate
 * @property {() => void} destroy
 * @property {(e: KeyboardEvent) => boolean} key   true when the event was consumed
 * @property {(v: PickerVariant) => void} setVariant
 * @property {() => boolean} fits       every tap target >= 44px and nothing overflows
 * @property {PickerDemo} demo
 */

/** Press flash. Short enough to read as "instant", long enough to see. */
const PRESS_MS = 40;
/** Hover tick while dragging the wheel: one per wedge crossed, never per move. */
const TICK_MS = 4;
/** Level change (a group opening or its fan collapsing) — a beat longer. */
const LEVEL_MS = 8;
/** Live-region text is set on a delay so screen readers see a real mutation. */
const ANNOUNCE_MS = 30;
/** Ignore taps this close to the screen edges — that is the OS back-swipe. */
const EDGE_PX = 16;
/** Apple HIG / WCAG 2.5.5 minimum tap target. */
const MIN_TAP = 44;
/** Minimum arc length of a wheel wedge at its mid radius — see wheelFits(). */
const MIN_ARC = 32;
/** The wheel's viewBox is -102..102 on both axes. */
const WHEEL_BOX = 204;
/** Pointer travel (CSS px) after a drag-opened group inside which nothing is hovered or committed — see openGroup(). */
const OPEN_SLOP = 12;
/** Popover API present? The lens chip then renders in the top layer (above the
 *  sheet's overflow:hidden and every stacking context). Guarded so the module
 *  stays import-safe under `bun test`, which has no DOM. */
const POPOVER_OK = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

/** Monotonic mount counter behind PickerUIHandle.destroy()'s ownership check. */
let mountSeq = 0;

/**
 * @param {PickerUIOpts} opts
 * @returns {PickerUIHandle}
 */
export function createPickerUI(opts) {
  const { root, tree, hues, guessId, recentIds, onPick, onCancel, deps } = opts;

  /** @type {PickerVariant} */
  let variant = opts.variant;
  /** Key of the open group, or null at the top level. */
  let groupKey = /** @type {string|null} */ (null);
  /** Columns only: group previewed by a mouse hover (costs no tap). */
  let hoverKey = /** @type {string|null} */ (null);
  /** Wheel only: wedge under the pointer. */
  let wheelHover = /** @type {string|null} */ (null);
  /** Wheel only: geometry of the level on screen, for hit testing. */
  let geom = /** @type {ReturnType<typeof wheelGeometry>|null} */ (null);
  /** Wheel only: last pointer position in client px, so openGroup() can anchor the dead zone. */
  let lastPt = /** @type {{x: number, y: number}|null} */ (null);
  /** Wheel only: where the pointer was when it opened the current fan, until it travels OPEN_SLOP away. */
  let openedAt = /** @type {{x: number, y: number}|null} */ (null);
  /** Centre label to restore when the wheel hover clears. */
  let centerText = "";
  /** Wheel only: the chip riding above the finger. Built on first hover. */
  let lens = /** @type {HTMLElement|null} */ (null);
  /** Wheel only: last pointer position for the lens — VIEWPORT px when the chip
   *  is a popover (position:fixed), root-relative px in the fallback. */
  let lensPt = /** @type {{x: number, y: number}|null} */ (null);
  /** Lens size, re-measured only when its text changes — see paintLens(). */
  let lensBox = { w: 120, h: 34 };

  /** Identity of THIS mount, stamped on the root so a deferred destroy() can
   *  tell whether the root still belongs to it. */
  const ownerId = "pk" + String(++mountSeq);

  let armed = false;
  /** The very first paint never animates: the host measures with fits() the
   *  moment it mounts, and an in-flight transform would fail the check. */
  let painted = false;
  let committed = false;
  let destroyed = false;
  let dragging = false;
  let downCenter = false;
  let capturedId = /** @type {number|null} */ (null);
  /** onInteract is a one-shot: the host uses it to retire a scripted demo. */
  let interacted = false;
  /** True while a demo.* call runs: those are not input and must not buzz. */
  let scripted = false;

  /** Pointers that were already down when the engine mounted. @type {Set<number>} */
  const preArm = new Set();
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();
  const ac = new AbortController();
  const sig = ac.signal;

  /** key -> node + parent, so a data-key attribute resolves in O(1). */
  const index = /** @type {Map<string, {node: PkNode, parent: PkGroup|null}>} */ (new Map());
  for (const n of tree) {
    index.set(n.key, { node: n, parent: null });
    if (n.kind === "group") for (const c of n.children) index.set(c.key, { node: c, parent: n });
  }

  const live = document.createElement("div");
  live.className = "pk-live";
  live.setAttribute("aria-live", "polite");
  live.setAttribute("role", "status");

  /** @param {number} ms @param {() => void} fn */
  function after(ms, fn) {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!destroyed) fn();
    }, ms);
    timers.add(t);
  }

  /** @param {number} ms  vibrate() is a no-op on iOS and may throw in a sandbox */
  function buzz(ms) {
    if (scripted) return;
    try { deps.haptic(ms); } catch { /* additive only */ }
  }

  /** First real input of this mount: the host stops its ghost finger on it. */
  function userActed() {
    if (scripted || interacted) return;
    interacted = true;
    try { opts.onInteract?.(); } catch { /* the host's problem, not the picker's */ }
  }

  /** @param {string} msg */
  function announce(msg) {
    live.textContent = "";
    after(ANNOUNCE_MS, () => { live.textContent = msg; });
  }

  /** @param {string|null} k @returns {Element|null} */
  function elFor(k) {
    if (k === null) return null;
    for (const el of root.querySelectorAll("[data-key]")) if (el.getAttribute("data-key") === k) return el;
    return null;
  }

  /** @param {string} code @returns {Element|null} */
  function hotEl(code) {
    for (const el of root.querySelectorAll("[data-hot]")) if (el.getAttribute("data-hot") === code) return el;
    return null;
  }

  /** @param {string|null} k @returns {PkGroup|null} */
  function groupFor(k) {
    const rec = k === null ? undefined : index.get(k);
    return rec && rec.node.kind === "group" ? rec.node : null;
  }

  /**
   * The builder's view of the world. `keyed` stays true even on touch: a
   * tablet may have a hardware keyboard attached, and the CSS hides the badges
   * on coarse pointers anyway.
   * @param {string|null} k group to show as open
   */
  function viewFor(k) {
    return { nodes: tree, group: groupFor(k), guessId, recentIds, hues, keyed: true };
  }

  // ---- painting ------------------------------------------------------------

  /**
   * CSP forbids style="" in generated markup, so the per-node hue rides in a
   * data attribute and lands on the custom property here. Works for SVG too.
   * @param {ParentNode} scope
   */
  function paintHues(scope) {
    for (const el of scope.querySelectorAll("[data-h]")) {
      if (el instanceof HTMLElement || el instanceof SVGElement) el.style.setProperty("--h", el.dataset.h ?? "0");
    }
  }

  /**
   * Column counts for the grids the builders marked with data-count. The tile
   * grids get the square-ish count from gridCols; the dock's chip row and
   * circle strip are sized from their width alone (their height is auto, so
   * there is no aspect ratio to solve for).
   */
  function layoutGrids() {
    for (const el of root.querySelectorAll("[data-count]")) {
      if (!(el instanceof HTMLElement)) continue;
      const n = Math.max(1, Number(el.dataset.count) || el.childElementCount || 1);
      const w = el.clientWidth || root.clientWidth || 360;
      if (el.classList.contains("pk-dock-row")) { sizeDockRow(el, n, w); continue; }
      const h = el.clientHeight;
      const cols = el.classList.contains("pk-dock-sub") || h < 48
        ? Math.min(n, Math.max(2, Math.floor(w / 104)))
        : gridCols(n, w, h);
      el.style.setProperty("--cols", String(cols));
    }
  }

  /**
   * Dock circles: as big as fits on one row, floored at 40px, capped at 64px;
   * below that they wrap to a second row at a fixed 44px.
   * @param {HTMLElement} row @param {number} n @param {number} w
   */
  function sizeDockRow(row, n, w) {
    const gap = 8;
    const one = Math.floor((w - gap * (n - 1)) / n);
    const perRow = Math.max(1, Math.floor((w + gap) / 48));
    const size = one < 40 && n > perRow ? 44 : Math.max(40, Math.min(64, one));
    row.style.setProperty("--ds", size + "px");
  }

  /** @param {string|null} k */
  function markExpanded(k) {
    for (const el of root.querySelectorAll("[aria-expanded]")) {
      el.setAttribute("aria-expanded", el.getAttribute("data-key") === k ? "true" : "false");
    }
  }

  /** @param {boolean} [animate] */
  function render(animate = true) {
    if (destroyed) return;
    const shown = groupKey ?? (variant === "cols" ? hoverKey : null);
    const view = viewFor(shown);
    const html = variant === "tiles" ? renderTiles(view)
      : variant === "cols" ? renderCols(view)
        : variant === "dock" ? renderDock(view)
          : renderWheel(view);
    root.classList.add("pk-root");
    if (armed) root.classList.add("pk-armed");
    root.dataset.pkOwner = ownerId; // see destroy(): the host may reuse this root
    root.innerHTML = html;
    paintHues(root);
    layoutGrids();
    markExpanded(groupKey);
    root.appendChild(live);
    if (variant === "wheel") {
      geom = wheelGeometry(tree, view.group);
      wheelHover = null;
      const c1 = root.querySelector("text.pk-c1");
      centerText = c1 ? c1.textContent ?? "" : "";
    }
    const level = root.firstElementChild;
    if (animate && painted && level && !deps.reducedMotion) level.classList.add("pk-swap");
    painted = true;
  }

  /**
   * Wheel level change without touching the <svg>: the pointer capture taken
   * on pointerdown lives on that element, and re-creating it mid-drag would
   * drop the gesture. The fresh markup is parsed off-document and only the
   * outer ring + the screen-reader mirror are swapped in.
   * @param {string|null} k
   */
  function redrawWheel(k) {
    const view = viewFor(k);
    const tmp = document.createElement("div");
    tmp.innerHTML = renderWheel(view);
    // the inner paths are never re-created: CSS shrinks the ring off this class
    const svg = root.querySelector("svg");
    if (svg) svg.classList.toggle("pk-open", view.group !== null);
    const outer = root.querySelector("g.pk-outer");
    const nextOuter = tmp.querySelector("g.pk-outer");
    if (outer && nextOuter) outer.replaceChildren(...Array.from(nextOuter.childNodes));
    const sr = root.querySelector(".pk-sr");
    const nextSr = tmp.querySelector(".pk-sr");
    if (sr && nextSr) sr.replaceChildren(...Array.from(nextSr.childNodes));
    for (const p of root.querySelectorAll("g.pk-inner .pk-wedge")) {
      const mine = view.group !== null && p.getAttribute("data-key") === view.group.key;
      p.classList.toggle("pk-sel", mine);
      p.classList.toggle("pk-dim", view.group !== null && !mine);
    }
    for (const t of ["text.pk-c1", "text.pk-c2"]) {
      const cur = root.querySelector(t);
      const next = tmp.querySelector(t);
      if (cur && next) cur.textContent = next.textContent;
    }
    paintHues(root);
    markExpanded(k);
    geom = wheelGeometry(tree, view.group);
    wheelHover = null;
    const c1 = root.querySelector("text.pk-c1");
    centerText = c1 ? c1.textContent ?? "" : "";
    if (outer instanceof SVGElement && !deps.reducedMotion) {
      outer.classList.remove("pk-swap");
      void outer.getBoundingClientRect();   // restart the 120ms fade
      outer.classList.add("pk-swap");
    }
  }

  // ---- actions -------------------------------------------------------------

  /** @param {Element} el */
  function press(el) {
    el.classList.add("pk-press");
    after(PRESS_MS, () => el.classList.remove("pk-press"));
  }

  /** @param {PkGroup} g */
  function openGroup(g) {
    if (groupKey === g.key) return;
    // read the label BEFORE the redraw: in the tiles variant the group's own
    // tile is gone once its children are on screen
    const tile = elFor(g.key);
    const msg = tile?.getAttribute("aria-label") || labelOf(g, false).text;
    groupKey = g.key;
    hoverKey = null;
    if (variant === "wheel") {
      redrawWheel(g.key);
      buzz(LEVEL_MS);
      // Dead zone around the finger that just opened the fan. The hit geometry
      // flips instantly — a finger at r≈70 on a full-size group wedge is inside
      // the fan band the moment R1 becomes 56 — while the ring visibly shrinks
      // over 120ms. Without it the very next pointermove would hover a child,
      // and a tap-tap user would commit one they never chose on pointerup.
      if (!scripted && dragging && lastPt) openedAt = { x: lastPt.x, y: lastPt.y };
    } else {
      render();
    }
    announce(msg);
    if (!scripted) focusFirstChild(g);   // a demo must not yank focus off the page
  }

  /**
   * Wheel: the finger left the open group and is now over a TOP-LEVEL leaf. The
   * fan belongs to a group the user has visibly moved on from, so it goes at
   * once — otherwise the leaf under the finger stays dimmed behind a stale ring
   * and looks unpickable, even though lifting there commits it.
   * @param {string} leafKey
   */
  function closeFan(leafKey) {
    groupKey = null;
    hoverKey = null;
    redrawWheel(null);          // clears wheelHover, so the hover is set after
    buzz(LEVEL_MS);
    setWheelHover(leafKey);
    announce("Back to groups");
  }

  /** @param {PkGroup} g */
  function focusFirstChild(g) {
    const keys = new Set(g.children.map((c) => c.key));
    for (const el of root.querySelectorAll("[data-key]")) {
      const k = el.getAttribute("data-key");
      if (k && keys.has(k) && el instanceof HTMLElement) { el.focus({ preventScroll: true }); return; }
    }
  }

  function back() {
    if (groupKey === null) return;
    groupKey = null;
    hoverKey = null;
    if (variant === "wheel") redrawWheel(null); else render();
    announce("Back to groups");
  }

  /**
   * The one commit path. Flash first, then haptic, then hand over — the host
   * closes the sheet synchronously inside onPick and the flash has to be on
   * screen before that frame paints.
   * @param {number} catId @param {Element|null} el
   */
  function commit(catId, el) {
    if (committed) return;
    committed = true;
    if (el) {
      el.classList.add("pk-hit");
      for (const other of root.querySelectorAll(".pk-tile, .pk-wedge")) if (other !== el) other.classList.add("pk-fade");
    }
    try { deps.haptic(8); } catch { /* vibrate is a no-op on iOS; never fatal */ }
    onPick(catId);
  }

  /** @param {Element} el */
  function activate(el) {
    if (committed) return;
    press(el);
    if (el.hasAttribute("data-back")) { back(); return; }
    const k = el.getAttribute("data-key");
    const rec = k === null ? undefined : index.get(k);
    if (!rec) return;
    if (rec.node.kind === "group") openGroup(rec.node);
    else commit(rec.node.catId, el);
  }

  // ---- wheel gesture -------------------------------------------------------

  /** @param {PointerEvent} e @param {Element} svg */
  function polar(e, svg) {
    const r = svg.getBoundingClientRect();
    const s = Math.min(r.width, r.height) / WHEEL_BOX;
    if (!(s > 0)) return null;
    const dx = (e.clientX - (r.left + r.width / 2)) / s;
    const dy = (e.clientY - (r.top + r.height / 2)) / s;
    return { rad: Math.hypot(dx, dy), ang: Math.atan2(dy, dx) };
  }

  /** @param {PointerEvent} e @returns {{center: true}|{key: string}|null} */
  function hitAt(e) {
    const svg = root.querySelector("svg");
    if (!svg || !geom) return null;
    const p = polar(e, svg);
    // `wheelHover` is the hysteresis anchor: the commit on pointerup must be
    // the wedge the lens is showing, so down/move/up all test the same way
    return p ? wheelHit(geom, p.rad, p.ang, wheelHover) : null;
  }

  /**
   * The single highlight path. `pk-hov` alone was invisible on the outer ring:
   * a group's children sit within a couple of degrees of hue of each other, so
   * a brightness bump on one of ten near-identical wedges reads as nothing —
   * and a hovered TOP-LEVEL leaf still carried `pk-dim` from the open fan,
   * which cancelled the bump outright. The wedge under the finger now also
   * pushes its own ring's siblings back (`pk-dull`), tints the hub and raises
   * the lens chip, so the current pick is unmistakable at a glance.
   * @param {string|null} k
   */
  function setWheelHover(k) {
    if (wheelHover === k) return;
    wheelHover = k;
    const rec = k === null ? undefined : index.get(k);
    const el = k === null ? null : elFor(k);
    const ring = el ? el.parentNode : null;
    for (const p of root.querySelectorAll(".pk-wedge")) {
      const on = p === el;
      p.classList.toggle("pk-hov", on);
      p.classList.toggle("pk-dull", !on && ring !== null && p.parentNode === ring);
    }
    if (rec) buzz(TICK_MS);   // one tick per wedge crossed — never per pointermove
    const c1 = root.querySelector("text.pk-c1");
    if (c1) c1.textContent = rec ? labelOf(rec.node, rec.parent !== null).text : centerText;
    tintCenter(el);
    paintLens(rec ?? null, el);
  }

  /** Hub takes the hovered wedge's own hue, so the pick reads even with the
   *  lens clipped off the top of a short panel. @param {Element|null} el */
  function tintCenter(el) {
    const c = root.querySelector("circle.pk-center");
    if (!(c instanceof SVGElement)) return;
    const h = el instanceof SVGElement ? el.getAttribute("data-h") : null;
    if (h === null) { c.classList.remove("pk-lit"); return; }
    c.style.setProperty("--h", h);
    c.classList.add("pk-lit");
  }

  /**
   * The lens: a chip ABOVE the finger carrying the hovered node's emoji, its
   * name and its own wedge colour. The finger covers the wedge it is on — this
   * is the only way to see the current pick during a drag.
   *
   * With the Popover API it is a `popover="hint"` in the top layer, so the
   * sheet body's overflow:hidden and neighbouring stacking contexts cannot clip
   * or cover it. It stays a child of the picker root: top-layer rendering does
   * not depend on DOM position, and destroy()'s replaceChildren() still sweeps
   * it. Without the API it falls back to the absolute z-index:4 chip.
   * @param {{node: PkNode, parent: PkGroup|null}|null} rec @param {Element|null} el
   */
  function paintLens(rec, el) {
    if (!rec || !el) { hideLens(); return; }
    if (!lens) {
      lens = document.createElement("div");
      lens.className = "pk-lens";
      lens.setAttribute("aria-hidden", "true");
      if (POPOVER_OK) lens.setAttribute("popover", "hint");
      const g = document.createElement("span");
      g.className = "pk-lens-glyph";
      const t = document.createElement("span");
      t.className = "pk-lens-name";
      lens.append(g, t);
    }
    if (lens.parentNode !== root) root.appendChild(lens);
    const lab = labelOf(rec.node, rec.parent !== null);
    const glyph = lens.firstElementChild;
    const name = lens.lastElementChild;
    if (glyph instanceof HTMLElement) {
      glyph.textContent = lab.emoji || lab.mono;
      glyph.classList.toggle("pk-mono", !lab.emoji);
    }
    if (name instanceof HTMLElement) name.textContent = lab.text;
    const h = el instanceof SVGElement ? el.getAttribute("data-h") : null;
    lens.style.setProperty("--h", h ?? "0");
    // ORDER: open BEFORE measuring — a closed popover is display:none and
    // reads 0x0, which would leave the chip clamped to the wrong lift.
    if (POPOVER_OK && !lensOpen()) lensShow();
    // measured HERE and cached: moveLens runs on every pointermove and a layout
    // read per move is exactly the jank the whole picker exists to avoid
    lensBox = { w: lens.offsetWidth || 120, h: lens.offsetHeight || 34 };
    moveLens();
  }

  /** Is the popover chip currently in the top layer? `:popover-open` throws a
   *  SyntaxError where the pseudo-class is unknown, hence the guard. */
  function lensOpen() {
    if (!lens) return false;
    try { return lens.matches(":popover-open"); } catch { return false; }
  }

  /** showPopover() throws on a disconnected element or an already-open one. */
  function lensShow() {
    if (!lens || !lens.isConnected) return;
    try { lens.showPopover(); } catch { /* not connected / already open */ }
  }

  /** Follows the pointer every move, clamped inside the viewport (popover) or
   *  the picker (fallback). Near the top edge there is no room above the
   *  finger, so the chip flips below it rather than sliding under the
   *  fingertip it is there to see past. */
  function moveLens() {
    if (!lens || !lensPt) return;
    // A `hint` popover is light-dismissed by ANY pointerup outside it (a
    // second finger, a palm brushing the screen) and by Escape. Re-arming on
    // every move bounds the loss to one move event. `manual` would be the
    // stricter type; the user asked for `hint` by name, so that is what ships.
    if (POPOVER_OK && lens.isConnected && !lensOpen()) lensShow();
    const w = (POPOVER_OK ? window.innerWidth : root.clientWidth) || 1;
    const hgt = (POPOVER_OK ? window.innerHeight : root.clientHeight) || 1;
    const lh = lensBox.h;
    const half = lensBox.w / 2;
    // The thumb pad occludes roughly 50-60 px above the contact point, so the
    // lift grows with the chip: its centre must clear that band by half its
    // own height or the bottom edge tucks back under the finger.
    const lift = 56 + lh / 2;
    const x = Math.max(half + 2, Math.min(w - half - 2, lensPt.x));
    const above = lensPt.y - lift;
    const y = above - lh / 2 >= 2
      ? above
      : Math.min(hgt - lh / 2 - 2, lensPt.y + lift);
    lens.style.setProperty("--lx", String(Math.round(x)) + "px");
    lens.style.setProperty("--ly", String(Math.round(y)) + "px");
  }

  function hideLens() {
    if (!lens) return;
    if (lensOpen()) { try { lens.hidePopover(); } catch { /* already closed */ } }
    if (lens.parentNode) lens.remove();
  }

  /** Pointer position for the lens: viewport px as a popover (position:fixed),
   *  root-relative px in the fallback. @param {PointerEvent} e */
  function trackPointer(e) {
    if (POPOVER_OK) { lensPt = { x: e.clientX, y: e.clientY }; return; }
    const r = root.getBoundingClientRect();
    lensPt = { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** demo.spot() reports ROOT-relative px (the ghost finger relies on that);
   *  the popover chip wants viewport px, so shift by the root's screen offset.
   *  @param {{x: number, y: number}|null} p */
  function lensPtFromSpot(p) {
    if (!p || !POPOVER_OK) return p;
    const r = root.getBoundingClientRect();
    return { x: p.x + r.left, y: p.y + r.top };
  }

  /** @param {number|null} id */
  function releaseCapture(id) {
    const svg = root.querySelector("svg");
    if (svg && id !== null) { try { svg.releasePointerCapture(id); } catch { /* already gone */ } }
    capturedId = null;
  }

  /**
   * One hit, wherever it came from (finger or scripted demo). Groups open their
   * fan; a top-level leaf reached while some OTHER group's fan is open closes
   * that fan first — the user has visibly moved on from it, and leaving it up
   * would keep the leaf under the finger dimmed and looking unpickable.
   * @param {string} k
   */
  function wheelTo(k) {
    const rec = index.get(k);
    if (!rec) { setWheelHover(null); return; }
    if (rec.node.kind === "group") { openGroup(rec.node); return; }
    if (rec.parent === null && groupKey !== null) { closeFan(k); return; }
    setWheelHover(k);
  }

  /** @param {PointerEvent} e @param {Element} svg */
  function wheelDown(e, svg) {
    try { svg.setPointerCapture(e.pointerId); capturedId = e.pointerId; } catch { /* unsupported: drag still works via bubbling */ }
    dragging = true;
    downCenter = false;
    lastPt = { x: e.clientX, y: e.clientY };
    trackPointer(e);
    const h = hitAt(e);
    if (!h) return;
    if ("center" in h) { downCenter = true; return; }
    const el = elFor(h.key);
    if (el) press(el);
    wheelTo(h.key);
  }

  /** @param {PointerEvent} e */
  function wheelMove(e) {
    if (!dragging) return;
    lastPt = { x: e.clientX, y: e.clientY };
    trackPointer(e);
    moveLens();
    if (openedAt) {
      if (inOpenSlop(e)) return;   // still on the wedge that opened the fan: no hover change
      openedAt = null;
    }
    const h = hitAt(e);
    if (h && "key" in h) { wheelTo(h.key); return; }
    setWheelHover(null);   // the hub and the dead zone outside the rings
  }

  /** @param {PointerEvent} e */
  function inOpenSlop(e) {
    return openedAt !== null && Math.hypot(e.clientX - openedAt.x, e.clientY - openedAt.y) <= OPEN_SLOP;
  }

  /** @param {PointerEvent} e */
  function wheelUp(e) {
    dragging = false;
    releaseCapture(e.pointerId);
    if (openedAt) {
      // a tap that opened a group: the fan stays up and the NEXT tap picks a child
      const tapped = inOpenSlop(e);
      openedAt = null;
      if (tapped) { hideLens(); setWheelHover(null); return; }
    }
    const h = hitAt(e);
    hideLens();
    if (h && "center" in h) { if (downCenter) back(); return; }
    if (h && "key" in h) {
      const rec = index.get(h.key);
      if (rec && rec.node.kind === "leaf") { commit(rec.node.catId, elFor(h.key)); return; }
    }
    setWheelHover(null);
  }

  // ---- input ---------------------------------------------------------------

  /** @param {PointerEvent} e */
  function onPointerDown(e) {
    if (destroyed) return;
    if (!armed) { preArm.add(e.pointerId); return; }
    if (preArm.has(e.pointerId) || committed) return;
    if (!e.isPrimary || e.button !== 0) return;
    if (e.clientX < EDGE_PX || e.clientX > window.innerWidth - EDGE_PX) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    userActed();
    if (variant === "wheel") {
      if (t.closest(".pk-sr")) return;          // AT buttons activate through click(detail 0)
      const svg = root.querySelector("svg");
      if (!svg || !svg.contains(t)) return;
      e.preventDefault();
      wheelDown(e, svg);
      return;
    }
    const el = t.closest("[data-key], [data-back]");
    if (!el) return;
    e.preventDefault();
    activate(el);
  }

  /** @param {PointerEvent} e */
  function onPointerMove(e) {
    if (destroyed || committed || !armed) return;
    if (variant !== "wheel" || preArm.has(e.pointerId)) return;
    wheelMove(e);
  }

  /** @param {PointerEvent} e */
  function onPointerUp(e) {
    const stale = preArm.delete(e.pointerId);
    if (destroyed || committed || !armed || stale) { dragging = false; openedAt = null; hideLens(); return; }
    if (variant !== "wheel" || !dragging) { dragging = false; openedAt = null; return; }
    wheelUp(e);
  }

  /** @param {PointerEvent} e */
  function onPointerCancel(e) {
    preArm.delete(e.pointerId);
    dragging = false;
    downCenter = false;
    openedAt = null;
    releaseCapture(e.pointerId);
    hideLens();
    if (variant === "wheel" && !committed && !destroyed) setWheelHover(null);
  }

  /**
   * Ghost clicks from a pointerdown we already handled are killed; a click
   * with detail 0 is a synthetic one (Enter/Space on a focused button, or an
   * assistive-tech activation) and is the only click that acts.
   * @param {MouseEvent} e
   */
  function onClick(e) {
    if (destroyed) return;
    if (e.detail > 0) { e.preventDefault(); return; }
    if (!armed || committed) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    const el = t.closest("[data-key], [data-back]");
    if (!el) return;
    e.preventDefault();
    userActed();
    activate(el);
  }

  /** Columns: a mouse hover previews a group's children without spending a tap. */
  function onPointerOver(/** @type {PointerEvent} */ e) {
    if (destroyed || committed || !armed) return;
    if (variant !== "cols" || e.pointerType !== "mouse" || groupKey !== null) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    const el = t.closest(".pk-left [data-key]");
    const k = el ? el.getAttribute("data-key") : null;
    if (!k || k === hoverKey) return;
    if (!groupFor(k)) return;
    hoverKey = k;
    render(false);
  }

  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let resizeT;
  function onResize() {
    if (resizeT !== undefined) { clearTimeout(resizeT); timers.delete(resizeT); }
    resizeT = setTimeout(() => { if (!destroyed) layoutGrids(); }, 60);
    timers.add(resizeT);
  }

  /** @param {Element|null} el @returns {Element|null} */
  function actionable(el) {
    return el ? el.closest("[data-key], [data-back]") : null;
  }

  function focused() {
    const a = document.activeElement;
    return a instanceof Element && root.contains(a) ? actionable(a) : null;
  }

  /** @param {KeyboardEvent} e @returns {boolean} */
  function key(e) {
    if (destroyed || !armed || committed) return false;
    if (e.key === "Escape" || e.key === "Backspace") {
      e.preventDefault();                       // Backspace must never navigate back
      if (groupKey !== null) back(); else onCancel();
      return true;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === "Enter") {
      // The FOCUSED element wins. A keyboard/AT user who tabbed to "Groceries"
      // and pressed Enter means Groceries; committing the model guess there
      // would categorize a real transaction as something they never looked at.
      const f = focused();
      if (f) { e.preventDefault(); activate(f); return true; }
      const guessEl = guessId === null ? null : elFor("c:" + String(guessId));
      if (guessEl && guessId !== null) { e.preventDefault(); press(guessEl); commit(guessId, guessEl); return true; }
      return false;
    }
    if (e.code === "Space" || e.key === " ") {
      const f = focused();
      if (f) { e.preventDefault(); activate(f); return true; }
      return false;
    }
    if (e.repeat) return false;
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(e.code)) return false;
    const el = hotEl(e.code);
    if (!el) return false;
    e.preventDefault();
    activate(el);
    return true;
  }

  // ---- fit check -----------------------------------------------------------

  /**
   * True when every actionable element clears 44x44 CSS px and the level does
   * not overflow its box. The glue calls this right after mounting and falls
   * back to the scrolling list variant when it returns false, so this is the
   * guard behind "these pickers never scroll".
   */
  function fits() {
    if (destroyed) return false;
    const tiles = root.querySelectorAll(".pk-tile");
    const wedges = root.querySelectorAll(".pk-wedge");
    if (!tiles.length && !wedges.length) return false;
    for (const el of tiles) {
      const r = el.getBoundingClientRect();
      if (r.width < MIN_TAP - 0.5 || r.height < MIN_TAP - 0.5) return false;
    }
    if (wedges.length && !wheelFits()) return false;
    return root.scrollHeight <= root.clientHeight + 1;
  }

  /**
   * Wedges have no useful bounding box (a ring segment's box is its bounding
   * rectangle), so they are measured as ring thickness x arc length at the mid
   * radius. Every group is checked, not just the open one — the fallback
   * decision is made once, before the user can drill in.
   */
  function wheelFits() {
    const svg = root.querySelector("svg");
    if (!svg) return false;
    const r = svg.getBoundingClientRect();
    const s = Math.min(r.width, r.height) / WHEEL_BOX;
    if (!(s > 0)) return false;
    // A wedge is not a square: its RADIAL thickness must clear 44px, but the arc
    // may be narrower — the reachable area is still well over 44x44 because the
    // target extends the full depth of the ring. Demanding 44px of arc as well
    // rejected a 10-group wheel on a 390px phone, which is an ordinary tree.
    /** @param {{w: number}[]} ring @param {number} r0 @param {number} r1 */
    const ok = (ring, r0, r1) => (r1 - r0) * s >= MIN_TAP - 0.5
      && ring.every((it) => it.w * ((r0 + r1) / 2) * s >= MIN_ARC - 0.5);
    // At rest the inner ring is the whole disc; the conservative case is the
    // shrunken ring (R0..56) while a fan is open, so that R1 is the one checked
    // whenever the tree has a group at all.
    const top = wheelGeometry(tree, null);
    let innerR1 = top.R1;
    for (const n of tree) {
      if (n.kind !== "group") continue;
      const g = wheelGeometry(tree, n);
      innerR1 = g.R1;
      if (!ok(g.outer, g.R1, g.R2)) return false;
    }
    if (!ok(top.inner, top.R0, innerR1)) return false;
    return true;
  }

  // ---- lifecycle -----------------------------------------------------------

  root.addEventListener("pointerdown", onPointerDown, { passive: false, signal: sig });
  root.addEventListener("pointermove", onPointerMove, { signal: sig });
  root.addEventListener("pointerup", onPointerUp, { signal: sig });
  root.addEventListener("pointercancel", onPointerCancel, { signal: sig });
  root.addEventListener("pointerover", onPointerOver, { signal: sig });
  root.addEventListener("click", onClick, { signal: sig });
  root.addEventListener("contextmenu", (e) => e.preventDefault(), { signal: sig });
  window.addEventListener("resize", onResize, { signal: sig });
  window.addEventListener("orientationchange", onResize, { signal: sig });

  /**
   * Same handlers a finger runs, driven by the host's scripted preview. `spot`
   * is measured, not computed: the caller's ghost has to land on the same pixel
   * the engine will hit-test. Wheel targets report the mid-radius point of
   * their wedge, everything else the centre of its box.
   * @type {PickerDemo}
   */
  const demo = {
    spot(k) {
      const el = elFor(k);
      if (!el) return null;
      const rr = root.getBoundingClientRect();
      if (variant !== "wheel") {
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2 - rr.left, y: b.top + b.height / 2 - rr.top };
      }
      const svg = root.querySelector("svg");
      const g = geom;
      if (!svg || !g) return null;
      const rec = index.get(k);
      const ring = rec && rec.parent !== null ? g.outer : g.inner;
      const w = ring.find((it) => it.key === k);
      if (!w) return null;
      const b = svg.getBoundingClientRect();
      const sc = Math.min(b.width, b.height) / WHEEL_BOX;
      // the inner ring is drawn at R0..R_FULL and CSS-scaled, so its visual
      // mid radius is the drawn one times innerScale — not (R0 + R1) / 2
      const rad = rec && rec.parent !== null ? (g.R1 + g.R2) / 2 : g.innerScale * (g.R0 + R_FULL) / 2;
      return {
        x: b.left + b.width / 2 + Math.cos(w.a) * rad * sc - rr.left,
        y: b.top + b.height / 2 + Math.sin(w.a) * rad * sc - rr.top,
      };
    },
    act(k) {
      if (destroyed || committed) return;
      scripted = true;
      try {
        const el = elFor(k);
        if (!el) return;
        if (variant === "wheel") { press(el); wheelTo(k); if (index.get(k)?.node.kind === "leaf") demoCommit(k, el); }
        else activate(el);
      } finally { scripted = false; }
    },
    hold(k) {
      if (destroyed || committed) return;
      scripted = true;
      try {
        const el = elFor(k);
        if (el) press(el);
        lensPt = lensPtFromSpot(demo.spot(k));
        wheelTo(k);
      } finally { scripted = false; }
    },
    slide(k) {
      if (destroyed || committed) return;
      scripted = true;
      try { lensPt = lensPtFromSpot(demo.spot(k)); moveLens(); wheelTo(k); } finally { scripted = false; }
    },
    release(k) {
      if (destroyed || committed) return;
      scripted = true;
      try { hideLens(); const el = elFor(k); if (el) demoCommit(k, el); } finally { scripted = false; }
    },
  };

  /** @param {string} k @param {Element} el */
  function demoCommit(k, el) {
    const rec = index.get(k);
    if (rec && rec.node.kind === "leaf") commit(rec.node.catId, el);
  }

  return {
    render: () => render(),
    arm() {
      if (destroyed) return;
      armed = true;
      root.classList.add("pk-armed");
    },
    key(e) {
      const used = key(e);
      if (used) userActed();
      return used;
    },
    fits,
    demo,
    setVariant(v) {
      if (destroyed || v === variant) return;
      variant = v;
      groupKey = null;
      hoverKey = null;
      wheelHover = null;
      dragging = false;
      geom = null;
      hideLens();
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ac.abort();
      releaseCapture(capturedId);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      // The host defers destroy() until its sheet has slid out, and the sheet
      // can be REOPENED inside that window (Escape then Enter): by then a newer
      // engine owns this root and blanking it would leave an empty picker.
      // Listeners and timers always go; the DOM only when it is still ours.
      hideLens();
      lens = null;
      if (root.dataset.pkOwner !== ownerId) return;
      delete root.dataset.pkOwner;
      root.replaceChildren();
      root.classList.remove("pk-root", "pk-armed");
    },
  };
}
