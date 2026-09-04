// @ts-check
/**
 * dopo category picker — PURE data + string builders. No DOM, no storage, no
 * network: `lib/pickerui.js` turns these strings into nodes and owns every
 * event, `app.js` owns the prefs. Unit-tested directly (bun has no DOM).
 *
 * Escaping contract (SPEC-STATIC "CSP & XSS", ci-checks gate 3): every value
 * derived from category data — text OR attribute — goes through esc(). The
 * gate's interpolation regex stops at the first `}`, so conditional attributes
 * and SVG path data are pre-built `*Html` consts on their own lines instead of
 * nested template ternaries.
 */

import { esc, splitEmoji } from "./card.js";

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/** @typedef {"tiles"|"cols"|"dock"|"wheel"|"list"} PickerId */
export const PICKER_IDS = /** @type {const} */ (["tiles", "cols", "dock", "wheel", "list"]);

/** @type {readonly {id: PickerId, title: string, blurb: string}[]} */
export const PICKER_META = [
  { id: "tiles", title: "Tiles", blurb: "Big grid, one screen per level" },
  { id: "cols", title: "Columns", blurb: "Groups left, subcategories right" },
  { id: "dock", title: "Dock", blurb: "Thumb-sized row along the bottom" },
  { id: "wheel", title: "Wheel", blurb: "Hold and drag around a dial" },
  { id: "list", title: "List", blurb: "Classic scrolling list" },
];

/**
 * @param {unknown} v
 * @returns {PickerId|null}
 */
export function parsePicker(v) {
  return typeof v === "string" && (/** @type {readonly string[]} */ (PICKER_IDS)).includes(v)
    ? /** @type {PickerId} */ (v)
    : null;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

/**
 * The flat leaf shape lm.js already produces (`LMState.categories`) — the
 * picker never sees group ids, so live and snapshot boots agree.
 * @typedef {object} LeafCategory
 * @property {number} id
 * @property {string} name
 * @property {string|null} group
 */

/** @typedef {{kind:"leaf", key:string, name:string, catId:number}} LeafNode */
/** @typedef {{kind:"group", key:string, name:string, children: LeafNode[]}} GroupNode */
/** @typedef {LeafNode|GroupNode} Node */

/**
 * Two-level tree from the flat leaf list. Order is the input order (= LM
 * order) and a group takes the position of its FIRST leaf, so the layout is
 * stable across renders. An empty/blank group name means "top level".
 * @param {readonly LeafCategory[]} categories
 * @returns {Node[]}
 */
export function buildTree(categories) {
  /** @type {Node[]} */
  const tree = [];
  /** @type {Map<string, GroupNode>} */
  const groups = new Map();
  for (const c of categories ?? []) {
    if (!c) continue;
    const catId = Number(c.id);
    /** @type {LeafNode} */
    const leaf = { kind: "leaf", key: `c:${catId}`, name: String(c.name ?? ""), catId };
    const group = c.group == null ? "" : String(c.group).trim();
    if (!group) {
      tree.push(leaf);
      continue;
    }
    let g = groups.get(group);
    if (!g) {
      g = { kind: "group", key: `g:${group}`, name: group, children: [] };
      groups.set(group, g);
      tree.push(g);
    }
    g.children.push(leaf);
  }
  return tree;
}

/**
 * @param {readonly Node[]} tree
 * @param {string} key
 * @returns {Node|null}
 */
export function findNode(tree, key) {
  for (const n of tree ?? []) {
    if (n.key === key) return n;
    if (n.kind === "group") {
      for (const c of n.children) if (c.key === key) return c;
    }
  }
  return null;
}

/**
 * Largest number of tiles any single screen would have to show. Above
 * MAX_LEVEL the glue falls back to the scrolling list for that open, because
 * every fast variant is a strict no-scroll layout.
 */
export const MAX_LEVEL = 40;

/**
 * @param {readonly Node[]} tree
 * @returns {number}
 */
export function maxLevel(tree) {
  let m = (tree ?? []).length;
  for (const n of tree ?? []) {
    if (n.kind === "group" && n.children.length > m) m = n.children.length;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Hues
// ---------------------------------------------------------------------------

/** Hue map size ceiling; over it, keys no longer in the tree are dropped. */


/** @param {number} x @returns {number} 0..359 */
const norm360 = (x) => ((Math.round(x) % 360) + 360) % 360;

/**
 * FNV-1a over the node key → the seed hue of an otherwise empty sibling set,
 * so two groups opened side by side don't both start at red.
 * @param {string} key
 * @returns {number} 0..359
 */
function hashHue(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

/**
 * Place `m` new hues among fixed `anchors` so the smallest resulting gap is as
 * large as possible: each new hue goes into the gap that stays widest AFTER
 * taking it (`size / (assigned + 2)`) — the allocation that hurts the minimum
 * least — and each gap's tenants are then spread evenly inside it. With a
 * single anchor that degenerates to a perfectly even ring, which is what a
 * fresh sibling set (and a group's children around their parent's hue) gets.
 * @param {number[]} anchors  sorted, deduped, 0..359
 * @param {number} m
 * @returns {number[]} m hues, in allocation order
 */
function spreadInGaps(anchors, m) {
  if (m <= 0) return [];
  /** @type {{start: number, size: number, n: number}[]} */
  const gaps = [];
  if (anchors.length === 0) {
    gaps.push({ start: 0, size: 360, n: -1 }); // n=-1 → first tenant lands on 0
  } else if (anchors.length === 1) {
    gaps.push({ start: anchors[0] ?? 0, size: 360, n: 0 });
  } else {
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i] ?? 0;
      const b = anchors[(i + 1) % anchors.length] ?? 0;
      gaps.push({ start: a, size: i === anchors.length - 1 ? b + 360 - a : b - a, n: 0 });
    }
  }
  /** @type {{gap: number, rank: number}[]} */
  const slots = [];
  for (let t = 0; t < m; t++) {
    let best = 0;
    let bestScore = -Infinity;
    for (let j = 0; j < gaps.length; j++) {
      const g = gaps[j];
      if (!g) continue;
      const score = g.size / (g.n + 2);
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = j;
      }
    }
    const g = gaps[best];
    if (!g) break;
    slots.push({ gap: best, rank: g.n });
    g.n += 1;
  }
  return slots.map((s) => {
    const g = gaps[s.gap];
    if (!g) return 0;
    return norm360(g.start + (g.size * (s.rank + 1)) / (g.n + 1));
  });
}

/**
 * Assign hues to one sibling set, in place.
 * @param {string[]} keys
 * @param {number[]} pre  hues occupied in this set by something other than a sibling (the parent)
 * @param {Record<string, number>} map
 * @returns {boolean} true when at least one key was added
 */
function placeHues(keys, pre, map) {
  /** @type {number[]} */
  const used = [];
  for (const h of pre) used.push(norm360(h));
  /** @type {string[]} */
  const pending = [];
  for (const k of keys) {
    const h = map[k];
    if (h === undefined) pending.push(k);
    else used.push(norm360(h));
  }
  if (pending.length === 0) return false;
  const first = pending[0];
  if (used.length === 0 && first !== undefined) {
    const seed = hashHue(first);
    map[first] = seed;
    used.push(seed);
    pending.shift();
  }
  if (pending.length > 0) {
    const anchors = [...new Set(used)].sort((a, b) => a - b);
    const hues = spreadInGaps(anchors, pending.length);
    pending.forEach((k, i) => {
      let h = hues[i] ?? 0;
      // Only reachable when a sibling set is so large that even spacing rounds
      // to <1° — never let two siblings (or a child and its parent) collide.
      for (let guard = 0; guard < 360 && used.includes(h); guard++) h = (h + 1) % 360;
      map[k] = h;
      used.push(h);
    });
  }
  return true;
}

/**
 * Per-key hue map. Saved hues are kept verbatim — that is what makes the
 * colours learnable across sessions, live or offline — and only NEW keys are
 * placed, per sibling set (top level is one set; each group's children another,
 * with the parent's hue pre-occupied so no child matches its group).
 *
 * `changed` is true when the returned map differs from `saved` (a key was added
 * or the cap dropped a stale one) — i.e. exactly when the caller should persist.
 * @param {readonly Node[]} tree
 * @param {Record<string, number>} saved
 * @returns {{map: Record<string, number>, changed: boolean}}
 */
export function assignHues(tree, saved) {
  /** @type {Record<string, number>} */
  const map = {};
  for (const [k, v] of Object.entries(saved ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n)) map[k] = norm360(n);
  }
  let changed = false;
  const nodes = tree ?? [];
  if (placeHues(nodes.map((n) => n.key), [], map)) changed = true;
  for (const n of nodes) {
    if (n.kind !== "group") continue;
    const parent = map[n.key];
    const pre = parent === undefined ? [] : [parent];
    if (placeHues(n.children.map((c) => c.key), pre, map)) changed = true;
  }

  // No pruning here on purpose: the size cap is ONE rule and it lives in
  // store.js (huesSave / HUES_MAX_KEYS). Two caps with different victims — this
  // one dropped stale keys, that one drops oldest-first — would disagree about
  // which colour a snapshot boot is allowed to keep. Newly assigned keys land at
  // the tail of `map`, so store.js's oldest-first trim never evicts a live one.
  return { map, changed };
}

/**
 * @param {Record<string, number>} hues
 * @param {string} key
 * @returns {number} 0..359 — a stable hash hue when the key was never assigned
 */
function hueOf(hues, key) {
  const h = hues ? hues[key] : undefined;
  return h === undefined || !Number.isFinite(Number(h)) ? hashHue(key) : norm360(Number(h));
}

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

/**
 * Physical key positions (`KeyboardEvent.code`, never `.key`): the number row,
 * then the three letter rows left-to-right. 36 slots, reading order.
 * @type {readonly string[]}
 */
export const KEY_CODES = [
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((d) => `Digit${d}`),
  ...[..."QWERTYUIOPASDFGHJKLZXCVBNM"].map((c) => `Key${c}`),
];

/**
 * @param {string|null|undefined} code
 * @returns {string} the printed hint ("1", "Q"), "" for anything unknown
 */
export function keyLabel(code) {
  const s = String(code ?? "");
  if (/^Digit[0-9]$/.test(s)) return s.slice(5);
  if (/^Key[A-Z]$/.test(s)) return s.slice(3);
  return "";
}

/**
 * @param {number} i
 * @returns {string|null}
 */
function codeAt(i) {
  return KEY_CODES[i] ?? null;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const STOPWORD = /^(and|of|the|or)$/i;

/**
 * Two-letter stand-in glyph for categories nobody gave an emoji.
 * "Groceries" → "Gr", "Eating out" → "EO", "Fees & Charges" → "FC".
 * @param {string} text
 * @returns {string}
 */
function monogram(text) {
  const words = String(text).split(/[\s/,&+\-()]+/).filter((w) => w && !STOPWORD.test(w));
  const a = words[0];
  if (a === undefined) return "?";
  const b = words[1];
  if (b === undefined) {
    const r = a.slice(0, 2);
    return (r[0] ?? "").toUpperCase() + r.slice(1);
  }
  return ((a[0] ?? "") + (b[0] ?? "")).toUpperCase();
}

/**
 * Display parts of a node. Inside an open group the "Food & Drinks / Groceries"
 * convention is shortened to its last segment — the group is already on screen.
 * @param {{name?: unknown}} node
 * @param {boolean} inGroup
 * @returns {{emoji: string|null, text: string, mono: string}}
 */
export function labelOf(node, inGroup) {
  const { emoji, text } = splitEmoji(node?.name ?? "");
  let t = text;
  if (inGroup) {
    const i = t.lastIndexOf(" / ");
    if (i >= 0) t = t.slice(i + 3);
  }
  return { emoji, text: t, mono: emoji ? "" : monogram(t) };
}

/**
 * Column count that makes `n` tiles roughly square in a w×h box, so a level
 * fills the screen without ever scrolling.
 * @param {number} n
 * @param {number} w
 * @param {number} h
 * @returns {number} 1 for n<=1, else 2..8
 */
export function gridCols(n, w, h) {
  const count = Math.floor(Number(n));
  if (!Number.isFinite(count) || count <= 1) return 1;
  const bw = Number(w) > 0 && Number.isFinite(Number(w)) ? Number(w) : 360;
  const bh = Number(h) > 0 && Number.isFinite(Number(h)) ? Number(h) : 500;
  const cols = Math.max(2, Math.round(Math.sqrt((count * bw) / bh)));
  return Math.min(cols, count, 8);
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------

/**
 * @typedef {object} View
 * @property {Node[]} nodes  top-level tree
 * @property {GroupNode|null} group  the open group, if any
 * @property {number|null} guessId  the model's suggested category
 * @property {number[]} recentIds
 * @property {Record<string, number>} hues
 * @property {boolean} keyed  paint the hotkey hints (data-hot is emitted regardless)
 */

/**
 * The ★ and the recency dot are visual-only; a screen reader gets the same two
 * facts as words or it gets neither.
 * @param {Node} node
 * @param {View} view
 * @returns {{guess: boolean, recent: boolean}}
 */
function marksOf(node, view) {
  const catId = node.kind === "leaf" ? node.catId : null;
  return {
    guess: catId !== null && view.guessId != null && catId === view.guessId,
    recent: catId !== null && (view.recentIds ?? []).includes(catId),
  };
}

/**
 * @param {Node} node
 * @param {{emoji: string|null, text: string, mono: string}} lab
 * @param {{guess: boolean, recent: boolean}} [marks]
 * @returns {string} unescaped aria-label text
 */
function ariaOf(node, lab, marks) {
  let out = lab.text;
  if (node.kind === "group") {
    const k = node.children.length;
    out += ", " + k + (k === 1 ? " subcategory" : " subcategories");
  }
  if (marks?.guess) out += ", model guess";
  if (marks?.recent) out += ", recently used";
  return out;
}

/**
 * The one actionable element every non-wheel variant is built from.
 * @param {Node} node
 * @param {View} view
 * @param {{inGroup: boolean, code: string|null, extra?: string}} o
 * @returns {string}
 */
function tileHTML(node, view, o) {
  const lab = labelOf(node, o.inGroup);
  const isGroup = node.kind === "group";
  const marks = marksOf(node, view);
  let cls = "pk-tile";
  if (isGroup) cls += " pk-group";
  if (marks.guess) cls += " pk-guess";
  if (marks.recent) cls += " pk-recent";
  if (!lab.emoji) cls += " pk-mono";
  if (o.extra) cls += " " + o.extra;
  const clsHtml = esc(cls);
  const hotAttrHtml = o.code ? ` data-hot="${esc(o.code)}"` : "";
  const expandedHtml = isGroup ? ' aria-expanded="false"' : "";
  const hintHtml = view.keyed && o.code ? `<span class="pk-hot" aria-hidden="true">${esc(keyLabel(o.code))}</span>` : "";
  const iconHtml = lab.emoji ? `<span class="pk-emoji">${esc(lab.emoji)}</span>` : `<span class="pk-emoji pk-mono">${esc(lab.mono)}</span>`;
  return `<button type="button" class="${clsHtml}" data-key="${esc(node.key)}"${hotAttrHtml} data-h="${Number(hueOf(view.hues, node.key))}" aria-label="${esc(ariaOf(node, lab, marks))}"${expandedHtml}>${hintHtml}${iconHtml}<span class="pk-name"><bdi>${esc(lab.text)}</bdi></span></button>`;
}

/**
 * @param {GroupNode} group
 * @returns {string}
 */
function backTileHTML(group) {
  const lab = labelOf(group, false);
  return `<button type="button" class="pk-tile pk-back" data-back="1" aria-label="Back to groups"><span class="pk-hot" aria-hidden="true">Esc</span><span class="pk-emoji">←</span><span class="pk-name"><bdi>${esc(lab.text)}</bdi></span></button>`;
}

/**
 * Tiles — one screen per level; opening a group swaps the whole grid.
 * `data-count` is the tile count including the back tile; the UI feeds it to
 * gridCols() with the measured box.
 * @param {View} view
 * @returns {string}
 */
export function renderTiles(view) {
  const group = view.group;
  const level = group ? group.children : view.nodes;
  let tilesHtml = group ? backTileHTML(group) : "";
  level.forEach((node, i) => {
    tilesHtml += tileHTML(node, view, { inGroup: !!group, code: codeAt(i) });
  });
  const count = level.length + (group ? 1 : 0);
  return `<div class="pk pk-tiles" data-count="${Number(count)}">${tilesHtml}</div>`;
}

/**
 * Columns — groups always visible on the left, the open group's children right.
 * @param {View} view
 * @returns {string}
 */
export function renderCols(view) {
  const n = view.nodes.length;
  const group = view.group;
  let leftHtml = "";
  view.nodes.forEach((node, i) => {
    const extra = group && group.key === node.key ? "pk-sel" : "";
    leftHtml += tileHTML(node, view, { inGroup: false, code: codeAt(i), extra });
  });
  let rightHtml = "";
  let k = 0;
  if (group) {
    k = group.children.length;
    const k0 = Math.max(10, n);
    group.children.forEach((child, i) => {
      rightHtml += tileHTML(child, view, { inGroup: true, code: codeAt(k0 + i) });
    });
  } else {
    rightHtml = `<div class="pk-hint">Tap a group</div>`;
  }
  return `<div class="pk pk-cols"><div class="pk-left">${leftHtml}</div><div class="pk-right" data-count="${Number(k)}">${rightHtml}</div></div>`;
}

/**
 * Dock — thumb-reach strip; an open group raises its chips above the row and
 * takes the hotkeys, so the row can be re-tapped without a key collision.
 * @param {View} view
 * @returns {string}
 */
export function renderDock(view) {
  const group = view.group;
  let subHtml = "";
  if (group) {
    let chipsHtml = "";
    group.children.forEach((child, i) => {
      chipsHtml += tileHTML(child, view, { inGroup: true, code: codeAt(i) });
    });
    subHtml = `<div class="pk-dock-sub" data-count="${Number(group.children.length)}">${chipsHtml}</div>`;
  }
  let rowHtml = "";
  view.nodes.forEach((node, i) => {
    const extra = group ? (group.key === node.key ? "pk-sel" : "pk-dim") : "";
    rowHtml += tileHTML(node, view, { inGroup: false, code: group ? null : codeAt(i), extra });
  });
  return `<div class="pk pk-dock">${subHtml}<div class="pk-dock-row" data-count="${Number(view.nodes.length)}">${rowHtml}</div></div>`;
}

/** @param {number} x @returns {number} */
const r2 = (x) => Math.round(x * 100) / 100;
/** @param {number} x @returns {number} */
const r1 = (x) => Math.round(x * 10) / 10;

/**
 * Annulus wedge path data (no `<` on this line — the tripwire never sees it).
 * @param {number} a0 @param {number} a1 @param {number} r0 @param {number} rr1
 * @returns {string}
 */
function arcPath(a0, a1, r0, rr1) {
  /** @param {number} a @param {number} r @returns {[number, number]} */
  const p = (a, r) => [r2(Math.cos(a) * r), r2(Math.sin(a) * r)];
  const [x0, y0] = p(a0, rr1);
  const [x1, y1] = p(a1, rr1);
  const [x2, y2] = p(a1, r0);
  const [x3, y3] = p(a0, r0);
  const big = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0},${y0}A${rr1},${rr1} 0 ${big} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${big} 0 ${x3},${y3}Z`;
}

/**
 * One visually-hidden button per wedge — the SVG is aria-hidden, this list is
 * the whole AT + focus surface of the wheel.
 * @param {Node} node
 * @param {boolean} inGroup
 * @param {string|null} code
 * @param {View} view
 * @returns {string}
 */
function srButtonHTML(node, inGroup, code, view) {
  const lab = labelOf(node, inGroup);
  const marks = marksOf(node, view);
  let cls = "";
  if (marks.guess) cls += " pk-guess";
  if (marks.recent) cls += " pk-recent";
  const clsAttrHtml = cls ? ` class="${esc(cls.trim())}"` : "";
  const hotAttrHtml = code ? ` data-hot="${esc(code)}"` : "";
  const expandedHtml = node.kind === "group" ? ' aria-expanded="false"' : "";
  return `<button type="button"${clsAttrHtml} data-key="${esc(node.key)}"${hotAttrHtml} aria-label="${esc(ariaOf(node, lab, marks))}"${expandedHtml}><bdi>${esc(lab.text)}</bdi></button>`;
}

/**
 * Wheel — inner ring of top-level wedges, outer fan of the open group's
 * children, centre = back. Geometry and hit-testing are shared with the engine
 * through wheelGeometry()/wheelHit() so a redraw can never disagree with a hit.
 * @param {View} view
 * @returns {string}
 */
export function renderWheel(view) {
  const geom = wheelGeometry(view.nodes, view.group);
  const group = view.group;
  const n = view.nodes.length;
  const fs = Math.min(12, (60 / Math.max(1, n)) * 1.6 + 3);
  let innerRingHtml = "";
  let srHtml = "";
  geom.inner.forEach((w, i) => {
    const node = view.nodes[i];
    if (!node) return;
    const lab = labelOf(node, false);
    const code = codeAt(i);
    const marks = marksOf(node, view);
    let cls = "pk-wedge";
    if (group) cls += group.key === node.key ? " pk-sel" : " pk-dim";
    if (marks.guess) cls += " pk-guess";
    if (marks.recent) cls += " pk-recent";
    const clsHtml = esc(cls);
    const hotAttrHtml = code ? ` data-hot="${esc(code)}"` : "";
    const dHtml = arcPath(w.a - w.w / 2, w.a + w.w / 2, geom.R0, geom.R1);
    const rm = (geom.R0 + geom.R1) / 2;
    const gx = r1(Math.cos(w.a) * rm);
    const gy = r1(Math.sin(w.a) * rm);
    const glyphClsHtml = lab.emoji ? "pk-glyph" : "pk-glyph pk-mono";
    const gs = r1(lab.emoji ? fs : fs * 0.75);
    innerRingHtml += `<path class="${clsHtml}" data-key="${esc(node.key)}"${hotAttrHtml} data-h="${Number(hueOf(view.hues, node.key))}" d="${dHtml}"/>`;
    innerRingHtml += `<text class="${glyphClsHtml}" x="${Number(gx)}" y="${Number(gy)}" font-size="${Number(gs)}">${esc(lab.emoji || lab.mono)}</text>`;
    if (marks.guess) {
      const sy = r1(gy - gs * 0.85);
      innerRingHtml += `<text class="pk-star" x="${Number(gx)}" y="${Number(sy)}" font-size="${Number(r1(gs * 0.6))}">★</text>`;
    }
    if (view.keyed && code) {
      const kx = r1(Math.cos(w.a) * (geom.R1 - 5));
      const ky = r1(Math.sin(w.a) * (geom.R1 - 5));
      innerRingHtml += `<text class="pk-hot" x="${Number(kx)}" y="${Number(ky)}">${esc(keyLabel(code))}</text>`;
    }
    srHtml += srButtonHTML(node, false, code, view);
  });

  let outerRingHtml = "";
  const k0 = Math.max(10, n);
  geom.outer.forEach((w, i) => {
    const child = group ? group.children[i] : undefined;
    if (!child) return;
    const lab = labelOf(child, true);
    const code = codeAt(k0 + i);
    const marks = marksOf(child, view);
    let cls = "pk-wedge";
    if (marks.guess) cls += " pk-guess";
    if (marks.recent) cls += " pk-recent";
    const clsHtml = esc(cls);
    const hotAttrHtml = code ? ` data-hot="${esc(code)}"` : "";
    const dHtml = arcPath(w.a - w.w / 2, w.a + w.w / 2, geom.R1 + 2, geom.R2);
    const rm = (geom.R1 + geom.R2) / 2;
    const gx = r1(Math.cos(w.a) * rm);
    const gy = r1(Math.sin(w.a) * rm);
    const glyphClsHtml = lab.emoji ? "pk-glyph" : "pk-glyph pk-mono";
    const base = Math.min(11, w.w * 9 + 4);
    const gs = r1(lab.emoji ? base : base * 0.7);
    outerRingHtml += `<path class="${clsHtml}" data-key="${esc(child.key)}"${hotAttrHtml} data-h="${Number(hueOf(view.hues, child.key))}" d="${dHtml}"/>`;
    outerRingHtml += `<text class="${glyphClsHtml}" x="${Number(gx)}" y="${Number(gy)}" font-size="${Number(gs)}">${esc(lab.emoji || lab.mono)}</text>`;
    if (marks.guess) {
      const sy = r1(gy - gs * 0.85);
      outerRingHtml += `<text class="pk-star" x="${Number(gx)}" y="${Number(sy)}" font-size="${Number(r1(gs * 0.6))}">★</text>`;
    }
    if (view.keyed && code) {
      const kx = r1(Math.cos(w.a) * (geom.R2 - 5));
      const ky = r1(Math.sin(w.a) * (geom.R2 - 5));
      outerRingHtml += `<text class="pk-hot" x="${Number(kx)}" y="${Number(ky)}">${esc(keyLabel(code))}</text>`;
    }
    srHtml += srButtonHTML(child, true, code, view);
  });

  if (group) {
    srHtml += `<button type="button" data-back="1" aria-label="Back to groups">Back</button>`;
  }
  const c1 = group ? labelOf(group, false).text : "hold + drag";
  const c2 = group ? "tap centre = back" : "or just tap";
  return `<div class="pk pk-wheel"><svg viewBox="-102 -102 204 204" aria-hidden="true" focusable="false"><g class="pk-inner">${innerRingHtml}</g><g class="pk-outer">${outerRingHtml}</g><circle class="pk-center" r="18.5" data-back="1"/><text class="pk-c1" y="-3">${esc(c1)}</text><text class="pk-c2" y="5">${esc(c2)}</text></svg><div class="pk-sr">${srHtml}</div></div>`;
}

// ---------------------------------------------------------------------------
// Wheel geometry
// ---------------------------------------------------------------------------

/** @typedef {{key: string, a: number, w: number}} Wedge  a = centre angle (rad), w = angular width */
/** @typedef {{inner: Wedge[], outer: Wedge[], R0: number, R1: number, R2: number}} WheelGeometry */

/**
 * Wedge i is centred at -π/2 + i·(2π/n) (12 o'clock first, clockwise in SVG
 * coordinates). Children fan around their parent's angle, so opening a group
 * only redraws the outer ring — the pointer capture survives the gesture.
 * @param {readonly Node[]} nodes
 * @param {GroupNode|null} group
 * @returns {WheelGeometry}
 */
export function wheelGeometry(nodes, group) {
  const R0 = 20;
  const R1 = 56;
  const R2 = 98;
  const list = nodes ?? [];
  const n = list.length;
  /** @type {Wedge[]} */
  const inner = [];
  if (n > 0) {
    const w = (2 * Math.PI) / n;
    list.forEach((node, i) => inner.push({ key: node.key, a: -Math.PI / 2 + i * w, w }));
  }
  /** @type {Wedge[]} */
  const outer = [];
  if (group && group.children.length > 0) {
    const idx = list.findIndex((x) => x.key === group.key);
    const pa = (idx >= 0 ? inner[idx]?.a : undefined) ?? -Math.PI / 2;
    const k = group.children.length;
    const ww = Math.min(0.85, (2 * Math.PI) / k);
    group.children.forEach((c, i) => outer.push({ key: c.key, a: pa + (i - (k - 1) / 2) * ww, w: ww }));
  }
  return { inner, outer, R0, R1, R2 };
}

/**
 * @param {WheelGeometry} geom
 * @param {number} rad  distance from the centre in viewBox units
 * @param {number} ang  radians, atan2(dy, dx)
 * @returns {{center: true}|{key: string}|null}
 */
export function wheelHit(geom, rad, ang) {
  /** @param {number} d @returns {number} */
  const norm = (d) => Math.atan2(Math.sin(d), Math.cos(d));
  if (rad < geom.R0) return { center: true };
  if (rad < geom.R1) {
    for (const it of geom.inner) if (Math.abs(norm(ang - it.a)) <= it.w / 2) return { key: it.key };
    return null;
  }
  if (rad <= geom.R2 + 4) {
    for (const it of geom.outer) if (Math.abs(norm(ang - it.a)) <= it.w / 2) return { key: it.key };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Demo data — the onboarding "try it" panel before a real tree is loaded
//
// SIX top-level nodes (4 groups + 2 ungrouped) is not decoration: the try panel
// is a ~300px-tall box on an iPhone SE, and eight columns of `cols` there put
// every tile under the 44px floor, so the engine's fits() would reject the
// variant the user is being asked to evaluate. Names stay mixed emoji/plain so
// the monogram path is visible in the demo.
// ---------------------------------------------------------------------------

/** @type {readonly LeafCategory[]} */
export const DEMO_CATEGORIES = [
  { id: 9101, name: "🛒 Groceries", group: "🍽️ Food & Drinks" },
  { id: 9102, name: "🍕 Eating out", group: "🍽️ Food & Drinks" },
  { id: 9103, name: "☕ Coffee", group: "🍽️ Food & Drinks" },
  { id: 9104, name: "Delivery", group: "🍽️ Food & Drinks" },
  { id: 9105, name: "⛽ Fuel", group: "🚗 Transport" },
  { id: 9106, name: "🚌 Public transit", group: "🚗 Transport" },
  { id: 9107, name: "Parking", group: "🚗 Transport" },
  { id: 9108, name: "🚕 Taxi", group: "🚗 Transport" },
  { id: 9109, name: "🏠 Rent", group: "🏡 Home" },
  { id: 9110, name: "⚡ Electricity", group: "🏡 Home" },
  { id: 9111, name: "🌐 Internet", group: "🏡 Home" },
  { id: 9112, name: "Furniture", group: "🏡 Home" },
  { id: 9113, name: "📺 Streaming", group: "Leisure" },
  { id: 9114, name: "🎮 Games", group: "Leisure" },
  { id: 9115, name: "Concerts", group: "Leisure" },
  { id: 9116, name: "🎟️ Events", group: "Leisure" },
  { id: 9117, name: "💊 Health", group: null },
  { id: 9118, name: "Clothing", group: null },
];

/** @type {Node[]} */
export const DEMO_TREE = buildTree(DEMO_CATEGORIES);
