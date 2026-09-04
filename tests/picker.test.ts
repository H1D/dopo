import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PAYLOADS } from "./payloads";
import {
  DEMO_CATEGORIES,
  DEMO_TREE,
  KEY_CODES,
  MAX_LEVEL,
  PICKER_IDS,
  PICKER_META,
  assignHues,
  buildTree,
  findNode,
  gridCols,
  keyLabel,
  labelOf,
  maxLevel,
  parsePicker,
  renderCols,
  renderDock,
  renderTiles,
  renderWheel,
  wheelGeometry,
  wheelHit,
} from "../public/lib/picker.js";

/**
 * Unit tests for the PURE picker library (public/lib/picker.js). The DOM engine
 * (lib/pickerui.js) and the glue are covered elsewhere — everything here runs
 * without a document, which is why the builders return strings.
 */

type Cat = { id: number; name: string; group: string | null };
type PNode = ReturnType<typeof buildTree>[number];
type PGroup = Extract<PNode, { kind: "group" }>;
type View = Parameters<typeof renderTiles>[0];

const isGroup = (n: PNode): n is PGroup => n.kind === "group";

function view(nodes: PNode[], over: Partial<View> = {}): View {
  return {
    nodes,
    group: null,
    guessId: null,
    recentIds: [],
    hues: assignHues(nodes, {}).map,
    keyed: true,
    ...over,
  };
}

/** n top-level nodes, the first of which is a group with `kids` children. */
function mixedTree(n: number, kids: number): PNode[] {
  const cats: Cat[] = [];
  let id = 1000;
  for (let k = 0; k < kids; k++) cats.push({ id: id++, name: `Sub ${k}`, group: "Group A" });
  for (let i = 1; i < n; i++) cats.push({ id: id++, name: `Top ${i}`, group: null });
  return buildTree(cats);
}

const flatTree = (n: number): PNode[] =>
  buildTree(Array.from({ length: n }, (_, i) => ({ id: 100 + i, name: `Cat ${i}`, group: null })));

/** smallest circular distance between any two hues, in degrees */
function minGap(hues: number[]): number {
  const s = [...hues].sort((a, b) => a - b);
  if (s.length < 2) return 360;
  let m = Infinity;
  for (let i = 0; i < s.length; i++) {
    const a = s[i] ?? 0;
    const b = i === s.length - 1 ? (s[0] ?? 0) + 360 : (s[i + 1] ?? 0);
    m = Math.min(m, b - a);
  }
  return m;
}

/** attribute values by name — the leading space keeps `d=` out of `expanded=` */
const attrs = (html: string, name: string): string[] =>
  [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1] ?? "");

/** blank every quoted attribute value; what is left is the raw tag skeleton */
const skeleton = (html: string) => html.replace(/="[^"]*"/g, '=""');

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

describe("picker ids", () => {
  test("PICKER_IDS is the five shipped variants, list included", () => {
    expect([...PICKER_IDS]).toEqual(["tiles", "cols", "dock", "wheel", "list"]);
  });

  test("PICKER_META covers every id exactly once, with a title and a blurb", () => {
    expect(PICKER_META.map((m) => m.id)).toEqual([...PICKER_IDS]);
    expect(PICKER_META.map((m) => m.title)).toEqual(["Tiles", "Columns", "Dock", "Wheel", "List"]);
    for (const m of PICKER_META) expect(m.blurb.length).toBeGreaterThan(3);
    expect(PICKER_META.find((m) => m.id === "list")?.blurb).toBe("Classic scrolling list");
  });

  test("parsePicker round-trips every id and rejects garbage", () => {
    for (const id of PICKER_IDS) expect(parsePicker(id)).toBe(id);
    expect(parsePicker("bogus")).toBeNull();
    expect(parsePicker("")).toBeNull();
    expect(parsePicker(null)).toBeNull();
    expect(parsePicker(undefined)).toBeNull();
    expect(parsePicker(3)).toBeNull();
    expect(parsePicker({ id: "tiles" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildTree / findNode / maxLevel
// ---------------------------------------------------------------------------

describe("buildTree", () => {
  test("empty input yields an empty tree", () => {
    expect(buildTree([])).toEqual([]);
  });

  test("ungrouped categories become top-level leaves keyed by id", () => {
    const tree = buildTree([
      { id: 7, name: "💵 Income", group: null },
      { id: 8, name: "Transfer", group: null },
    ]);
    expect(tree).toEqual([
      { kind: "leaf", key: "c:7", name: "💵 Income", catId: 7 },
      { kind: "leaf", key: "c:8", name: "Transfer", catId: 8 },
    ]);
  });

  test("a group is created once, keyed by name, and sits where its first leaf was", () => {
    const tree = buildTree([
      { id: 1, name: "Income", group: null },
      { id: 2, name: "Groceries", group: "Food" },
      { id: 3, name: "Rent", group: "Home" },
      { id: 4, name: "Eating out", group: "Food" },
      { id: 5, name: "Transfer", group: null },
    ]);
    expect(tree.map((n) => n.key)).toEqual(["c:1", "g:Food", "g:Home", "c:5"]);
    const food = tree[1];
    expect(food && isGroup(food) && food.children.map((c) => c.key)).toEqual(["c:2", "c:4"]);
    expect(food && isGroup(food) && food.name).toBe("Food");
  });

  test("blank group names are treated as ungrouped", () => {
    const tree = buildTree([{ id: 1, name: "Odd", group: "   " }]);
    expect(tree.map((n) => n.kind)).toEqual(["leaf"]);
  });

  test("DEMO_TREE is 4 groups + 2 ungrouped over 18 leaves, mixed emoji/plain", () => {
    expect(DEMO_CATEGORIES.length).toBe(18);
    // six top-level nodes: more than that does not fit the onboarding try panel
    expect(DEMO_TREE.length).toBe(6);
    expect(DEMO_TREE.filter(isGroup).length).toBe(4);
    const names = DEMO_CATEGORIES.map((c) => c.name);
    expect(names.some((n) => labelOf({ name: n }, false).emoji)).toBe(true);
    expect(names.some((n) => !labelOf({ name: n }, false).emoji)).toBe(true);
  });
});

describe("findNode", () => {
  const tree = mixedTree(4, 3);

  test("finds top-level nodes and group children", () => {
    expect(findNode(tree, "g:Group A")?.key).toBe("g:Group A");
    expect(findNode(tree, "c:1002")?.key).toBe("c:1002");
    expect(findNode(tree, tree[1]?.key ?? "")?.kind).toBe("leaf");
  });

  test("unknown keys are null", () => {
    expect(findNode(tree, "c:999999")).toBeNull();
    expect(findNode([], "c:1")).toBeNull();
  });
});

describe("maxLevel", () => {
  test("MAX_LEVEL is 40", () => {
    expect(MAX_LEVEL).toBe(40);
  });

  test("is the largest single screen: top-level count vs any group's children", () => {
    expect(maxLevel([])).toBe(0);
    expect(maxLevel(flatTree(9))).toBe(9);
    expect(maxLevel(mixedTree(3, 26))).toBe(26);
    expect(maxLevel(mixedTree(30, 4))).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// assignHues
// ---------------------------------------------------------------------------

describe("assignHues", () => {
  test("saved hues are kept verbatim and nothing is re-assigned", () => {
    const tree = flatTree(4);
    const saved = { "c:100": 12, "c:101": 300 };
    const { map, changed } = assignHues(tree, saved);
    expect(map["c:100"]).toBe(12);
    expect(map["c:101"]).toBe(300);
    expect(changed).toBe(true);
    const again = assignHues(tree, map);
    expect(again.map).toEqual(map);
    expect(again.changed).toBe(false);
  });

  test("inserting a new sibling leaves every existing hue untouched", () => {
    const before = assignHues(flatTree(6), {}).map;
    const grown = buildTree([
      ...Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, name: `Cat ${i}`, group: null })),
      { id: 999, name: "Brand new", group: null },
    ]);
    const after = assignHues(grown, before);
    for (const [k, v] of Object.entries(before)) expect(after.map[k]).toBe(v);
    expect(after.map["c:999"]).toBeDefined();
    expect(after.changed).toBe(true);
  });

  test("siblings of a fresh set are spread around the circle", () => {
    for (let n = 2; n <= 12; n++) {
      const tree = flatTree(n);
      const { map } = assignHues(tree, {});
      const hues = tree.map((node) => map[node.key] ?? -1);
      expect(hues.every((h) => Number.isInteger(h) && h >= 0 && h < 360)).toBe(true);
      expect(minGap(hues)).toBeGreaterThanOrEqual(360 / n - 1);
    }
  });

  test("children are spread around their parent's hue and never equal it", () => {
    for (const k of [1, 2, 3, 5, 8, 12, 26]) {
      const tree = mixedTree(3, k);
      const group = tree.find(isGroup);
      expect(group).toBeDefined();
      if (!group) continue;
      const { map } = assignHues(tree, {});
      const parent = map[group.key] ?? -1;
      const kids = group.children.map((c) => map[c.key] ?? -1);
      for (const h of kids) expect(h).not.toBe(parent);
      expect(minGap([parent, ...kids])).toBeGreaterThanOrEqual(360 / (k + 1) - 1);
    }
  });

  test("is deterministic and independent of a previous run's object identity", () => {
    const a = assignHues(mixedTree(5, 7), {});
    const b = assignHues(mixedTree(5, 7), {});
    expect(a.map).toEqual(b.map);
    expect(a.changed).toBe(true);
  });

  test("hostile saved values are normalised, not trusted", () => {
    const tree = flatTree(2);
    const { map } = assignHues(tree, { "c:100": -30, "c:101": 725.4 } as Record<string, number>);
    expect(map["c:100"]).toBe(330);
    expect(map["c:101"]).toBe(5);
  });

  test("no size cap here — store.js huesSave owns the one trim rule", () => {
    const saved: Record<string, number> = {};
    for (let i = 0; i < 600; i++) saved[`old:${i}`] = i % 360;
    const tree = flatTree(5);
    const { map, changed } = assignHues(tree, saved);
    // every saved key survives: a snapshot boot sees a SUBSET of the tree, so
    // "not in this tree" is not evidence a colour is stale
    expect(map["old:0"]).toBe(0);
    expect(map["old:599"]).toBe(599 % 360);
    for (const node of tree) expect(map[node.key]).toBeDefined();
    expect(changed).toBe(true);
    // newly assigned keys land at the TAIL, so huesSave's oldest-first cap
    // (tests/store.test.ts) can never evict one of them
    const keys = Object.keys(map);
    for (const node of tree) expect(keys.indexOf(node.key)).toBeGreaterThan(599);
  });
});

// ---------------------------------------------------------------------------
// Keys + labels + grid
// ---------------------------------------------------------------------------

describe("hotkeys", () => {
  test("KEY_CODES is the 36 physical positions in reading order", () => {
    expect(KEY_CODES.length).toBe(36);
    expect(new Set(KEY_CODES).size).toBe(36);
    expect(KEY_CODES[0]).toBe("Digit1");
    expect(KEY_CODES[9]).toBe("Digit0");
    expect(KEY_CODES[10]).toBe("KeyQ");
    expect(KEY_CODES[19]).toBe("KeyP");
    expect(KEY_CODES[20]).toBe("KeyA");
    expect(KEY_CODES[28]).toBe("KeyL");
    expect(KEY_CODES[29]).toBe("KeyZ");
    expect(KEY_CODES[35]).toBe("KeyM");
  });

  test("keyLabel prints the cap, empty for anything else", () => {
    expect(keyLabel("Digit1")).toBe("1");
    expect(keyLabel("Digit0")).toBe("0");
    expect(keyLabel("KeyQ")).toBe("Q");
    expect(keyLabel("KeyM")).toBe("M");
    expect(keyLabel("Escape")).toBe("");
    expect(keyLabel("")).toBe("");
    expect(keyLabel(null)).toBe("");
    expect(keyLabel(undefined)).toBe("");
    for (const code of KEY_CODES) expect(keyLabel(code)).toHaveLength(1);
  });
});

describe("labelOf", () => {
  test("splits a leading emoji off the name", () => {
    expect(labelOf({ name: "🛒 Groceries" }, false)).toEqual({ emoji: "🛒", text: "Groceries", mono: "" });
  });

  test("no emoji → two-letter monogram", () => {
    expect(labelOf({ name: "Groceries" }, false).mono).toBe("Gr");
    expect(labelOf({ name: "Eating out" }, false).mono).toBe("EO");
    expect(labelOf({ name: "Fees & Charges" }, false).mono).toBe("FC");
    expect(labelOf({ name: "3D printing" }, false).mono).toBe("3P");
    expect(labelOf({ name: "Gifts and Donations" }, false).mono).toBe("GD");
    expect(labelOf({ name: "Kids (tutors)" }, false).mono).toBe("KT");
    expect(labelOf({ name: "   " }, false).mono).toBe("?");
  });

  test('"A / B" is shortened to its last segment only inside a group', () => {
    const n = { name: "☕ Food & Drinks / Eating out" };
    expect(labelOf(n, true).text).toBe("Eating out");
    expect(labelOf(n, false).text).toBe("Food & Drinks / Eating out");
    expect(labelOf({ name: "Utilities / Water / Cold" }, true).text).toBe("Cold");
    expect(labelOf({ name: "A/B" }, true).text).toBe("A/B"); // needs the spaces
  });
});

describe("gridCols", () => {
  test("degenerate levels get a single column", () => {
    expect(gridCols(0, 360, 500)).toBe(1);
    expect(gridCols(1, 360, 500)).toBe(1);
  });

  test("stays within 2..8 and never exceeds the tile count", () => {
    for (const n of [2, 3, 5, 9, 18, 26, 40, 200]) {
      for (const w of [280, 360, 430, 1024]) {
        for (const h of [300, 500, 620, 900]) {
          const cols = gridCols(n, w, h);
          expect(Number.isInteger(cols)).toBe(true);
          expect(cols).toBeGreaterThanOrEqual(2);
          expect(cols).toBeLessThanOrEqual(8);
          expect(cols).toBeLessThanOrEqual(n);
        }
      }
    }
  });

  test("wider boxes get more columns; garbage dimensions fall back", () => {
    expect(gridCols(12, 900, 300)).toBeGreaterThan(gridCols(12, 300, 900));
    expect(gridCols(12, 0, 0)).toBe(gridCols(12, 360, 500));
    expect(gridCols(12, NaN, NaN)).toBe(gridCols(12, 360, 500));
  });
});

// ---------------------------------------------------------------------------
// Builders — structure
// ---------------------------------------------------------------------------

describe("renderTiles", () => {
  const tree = mixedTree(5, 4);
  const group = tree.find(isGroup) as PGroup;

  test("top level: one tile per node, counted for the CSS grid", () => {
    const html = renderTiles(view(tree));
    expect(html.startsWith('<div class="pk pk-tiles" data-count="5">')).toBe(true);
    expect(attrs(html, "data-key")).toEqual(tree.map((n) => n.key));
    expect(html).toContain('aria-label="Group A, 4 subcategories"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("pk-back");
  });

  test("inside a group: a back tile plus the children, count includes the back tile", () => {
    const html = renderTiles(view(tree, { group }));
    expect(html).toContain('data-count="5"');
    expect(html).toContain('<button type="button" class="pk-tile pk-back" data-back="1" aria-label="Back to groups">');
    expect(attrs(html, "data-key")).toEqual(group.children.map((c) => c.key));
  });

  test("guess and recent are marked, hints obey view.keyed", () => {
    const first = tree[0];
    const leaf = group.children[0];
    expect(first && leaf).toBeTruthy();
    if (!leaf) return;
    const html = renderTiles(view(tree, { group, guessId: leaf.catId, recentIds: [group.children[1]?.catId ?? -1] }));
    expect(html).toContain("pk-tile pk-guess");
    expect(html).toContain("pk-tile pk-recent");
    expect(html).toContain('<span class="pk-hot" aria-hidden="true">1</span>');
    const quiet = renderTiles(view(tree, { group, keyed: false }));
    expect(quiet).toContain('data-hot="Digit1"'); // the key still WORKS
    expect(quiet).not.toContain('<span class="pk-hot" aria-hidden="true">1</span>');
  });

  test("hue comes from the map, as a plain integer attribute", () => {
    const hues = assignHues(tree, {}).map;
    const html = renderTiles(view(tree, { hues }));
    for (const h of attrs(html, "data-h")) {
      expect(Number.isInteger(Number(h))).toBe(true);
      expect(Number(h)).toBeGreaterThanOrEqual(0);
      expect(Number(h)).toBeLessThan(360);
    }
    expect(html).toContain(`data-h="${hues[tree[0]?.key ?? ""]}"`);
  });
});

describe("renderCols", () => {
  const tree = mixedTree(4, 3);
  const group = tree.find(isGroup) as PGroup;

  test("no group open: left pane only, right pane hints", () => {
    const html = renderCols(view(tree));
    expect(html).toContain('<div class="pk pk-cols">');
    expect(html).toContain('<div class="pk-right" data-count="0">');
    expect(html).toContain('<div class="pk-hint">Tap a group</div>');
    expect(html).not.toContain("pk-sel");
  });

  test("open group: selected on the left, children on the right", () => {
    const html = renderCols(view(tree, { group }));
    const left = html.split('<div class="pk-right"')[0] ?? "";
    expect(left).toMatch(/class="pk-tile pk-group[^"]*pk-sel"[^>]*data-key="g:Group A"/);
    expect(left.match(/pk-sel/g)?.length).toBe(1);
    expect(html).toContain('<div class="pk-right" data-count="3">');
    const right = html.split('<div class="pk-right"')[1] ?? "";
    expect(attrs(right, "data-key")).toEqual(group.children.map((c) => c.key));
    expect(attrs(right, "data-hot")).toEqual(KEY_CODES.slice(10, 13)); // KEY_CODES[max(10, n)]
  });
});

describe("renderDock", () => {
  const tree = mixedTree(6, 5);
  const group = tree.find(isGroup) as PGroup;

  test("closed: a single row, hotkeys on the row", () => {
    const html = renderDock(view(tree));
    expect(html).toContain('<div class="pk pk-dock">');
    expect(html).toContain('<div class="pk-dock-row" data-count="6">');
    expect(html).not.toContain("pk-dock-sub");
    expect(attrs(html, "data-hot").length).toBe(6);
  });

  test("open: children own every hotkey, the row is sel/dim only", () => {
    const html = renderDock(view(tree, { group }));
    expect(html).toContain('<div class="pk-dock-sub" data-count="5">');
    const row = html.split('<div class="pk-dock-row"')[1] ?? "";
    expect(row).not.toContain("data-hot");
    expect(row).toContain("pk-sel");
    expect(row).toContain("pk-dim");
    const sub = (html.split('<div class="pk-dock-row"')[0] ?? "");
    expect(attrs(sub, "data-hot")).toEqual(KEY_CODES.slice(0, 5));
  });
});

describe("renderWheel", () => {
  const tree = mixedTree(6, 4);
  const group = tree.find(isGroup) as PGroup;

  test("an aria-hidden svg plus a screen-reader button per wedge", () => {
    const html = renderWheel(view(tree));
    expect(html).toContain('<svg viewBox="-102 -102 204 204" aria-hidden="true" focusable="false">');
    expect(html).not.toContain("xmlns");
    expect(html).not.toContain("http");
    expect(html).toContain('<circle class="pk-center" r="18.5" data-back="1"/>');
    expect(html).toContain("hold + drag");
    expect(html).toContain("or just tap");
    const sr = html.split('<div class="pk-sr">')[1] ?? "";
    expect(attrs(sr, "data-key")).toEqual(tree.map((n) => n.key));
    expect(sr).not.toContain("data-back");
  });

  test("open group: outer wedges, dimmed siblings, centre says back", () => {
    const html = renderWheel(view(tree, { group }));
    const svg = html.split('<div class="pk-sr">')[0] ?? "";
    expect(svg).toContain("pk-wedge pk-sel");
    expect(svg).toContain("pk-wedge pk-dim");
    expect(html).toContain("tap centre = back");
    expect(html).toContain("Group A");
    const sr = html.split('<div class="pk-sr">')[1] ?? "";
    expect(attrs(sr, "data-key").length).toBe(tree.length + group.children.length);
    expect(sr).toContain('<button type="button" data-back="1" aria-label="Back to groups">Back</button>');
  });

  test("every path carries a hue and a d, and no d leaks a raw brace", () => {
    const html = renderWheel(view(tree, { group }));
    const ds = attrs(html, "d");
    expect(ds.length).toBe(tree.length + group.children.length);
    for (const d of ds) expect(d).toMatch(/^M-?[\d.]+,-?[\d.]+A/);
  });
});

describe("hotkey assignment", () => {
  const variants = { tiles: renderTiles, cols: renderCols, dock: renderDock, wheel: renderWheel };

  test("no variant ever paints the same physical key twice", () => {
    for (const n of [1, 7, 18, 40]) {
      const tree = mixedTree(n, 26);
      const group = tree.find(isGroup) as PGroup;
      for (const [name, render] of Object.entries(variants)) {
        for (const open of [null, group]) {
          const html = render(view(tree, { group: open }));
          // the wheel mirrors its wedges into a visually-hidden button list on
          // purpose (the svg is aria-hidden) — each surface is checked alone
          const parts = name === "wheel" ? html.split('<div class="pk-sr">') : [html];
          for (const part of parts) {
            const hot = attrs(part, "data-hot");
            expect(new Set(hot).size).toBe(hot.length);
            for (const code of hot) expect(KEY_CODES).toContain(code);
          }
          const keys = attrs(parts[0] ?? "", "data-key");
          expect(new Set(keys).size).toBe(keys.length);
        }
      }
    }
  });

  test("levels bigger than KEY_CODES simply run out of hints", () => {
    const html = renderTiles(view(flatTree(40)));
    expect(attrs(html, "data-key").length).toBe(40);
    expect(attrs(html, "data-hot").length).toBe(36);
  });
});

// ---------------------------------------------------------------------------
// Wheel geometry
// ---------------------------------------------------------------------------

describe("wheelGeometry", () => {
  test("inner ring covers the circle, first wedge at 12 o'clock", () => {
    const tree = mixedTree(6, 4);
    const geom = wheelGeometry(tree, null);
    expect(geom.inner.length).toBe(6);
    expect(geom.outer.length).toBe(0);
    expect(geom.R0).toBe(20);
    expect(geom.R1).toBe(56);
    expect(geom.R2).toBe(98);
    expect(geom.inner[0]?.a).toBeCloseTo(-Math.PI / 2, 10);
    for (const w of geom.inner) expect(w.w).toBeCloseTo((2 * Math.PI) / 6, 10);
    expect(geom.inner.map((w) => w.key)).toEqual(tree.map((n) => n.key));
  });

  test("children fan around the parent, width capped at 0.85 rad", () => {
    const tree = mixedTree(6, 4);
    const group = tree.find(isGroup) as PGroup;
    const geom = wheelGeometry(tree, group);
    expect(geom.outer.length).toBe(4);
    for (const w of geom.outer) expect(w.w).toBeCloseTo(Math.min(0.85, (2 * Math.PI) / 4), 10);
    const parentA = geom.inner[0]?.a ?? 0;
    const mid = (geom.outer[0]?.a ?? 0) / 2 + (geom.outer[3]?.a ?? 0) / 2;
    expect(mid).toBeCloseTo(parentA, 10);
    const wide = wheelGeometry(mixedTree(3, 20), mixedTree(3, 20).find(isGroup) as PGroup);
    for (const w of wide.outer) expect(w.w).toBeCloseTo((2 * Math.PI) / 20, 10);
  });

  test("empty tree is safe", () => {
    const geom = wheelGeometry([], null);
    expect(geom.inner).toEqual([]);
    expect(geom.outer).toEqual([]);
  });
});

describe("wheelHit", () => {
  const tree = mixedTree(6, 4);
  const group = tree.find(isGroup) as PGroup;
  const geom = wheelGeometry(tree, group);

  test("the hub is back", () => {
    expect(wheelHit(geom, 0, 0)).toEqual({ center: true });
    expect(wheelHit(geom, 19.9, 2)).toEqual({ center: true });
  });

  test("the inner ring hits the wedge under the angle", () => {
    for (const [i, w] of geom.inner.entries()) {
      expect(wheelHit(geom, 38, w.a)).toEqual({ key: w.key });
      expect(wheelHit(geom, 38, w.a + w.w * 0.45)).toEqual({ key: geom.inner[i]?.key ?? "" });
    }
  });

  test("the outer ring hits the open group's children", () => {
    for (const w of geom.outer) expect(wheelHit(geom, 77, w.a)).toEqual({ key: w.key });
    expect(wheelHit(geom, 100, geom.outer[0]?.a ?? 0)).toEqual({ key: geom.outer[0]?.key ?? "" });
  });

  test("gaps and overshoot are misses, not the nearest wedge", () => {
    const away = (geom.outer[0]?.a ?? 0) + Math.PI;
    expect(wheelHit(geom, 77, away)).toBeNull();
    expect(wheelHit(geom, 140, 0)).toBeNull();
    expect(wheelHit(wheelGeometry(tree, null), 77, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// XSS
// ---------------------------------------------------------------------------

describe("builder XSS property test", () => {
  const builders = { tiles: renderTiles, cols: renderCols, dock: renderDock, wheel: renderWheel };
  const tagCount = (s: string) => (s.match(/<[a-zA-Z/!]/g) || []).length;
  const quoteCount = (s: string) => (s.match(/"/g) || []).length;

  const treeFor = (s: string) =>
    buildTree([
      { id: 1, name: s, group: s },
      { id: 2, name: "Safe child", group: s },
      { id: 3, name: s, group: null },
      { id: 4, name: `🛒 ${s}`, group: null },
    ]);

  test("hostile category and group names never reach the markup unescaped", () => {
    for (const [name, render] of Object.entries(builders)) {
      const baseTree = treeFor("SAFE-BASELINE");
      const baseGroup = baseTree.find(isGroup) as PGroup;
      for (const openBase of [null, baseGroup]) {
        const baseline = render(view(baseTree, { group: openBase, guessId: 1, recentIds: [3] }));
        for (const payload of PAYLOADS) {
          const tree = treeFor(payload);
          const group = tree.find(isGroup) as PGroup;
          const open = openBase === null ? null : group;
          const out = render(view(tree, { group: open, guessId: 1, recentIds: [3] }));
          const where = `${name}${open ? " (group open)" : ""} / ${payload}`;

          // 1. injection adds no raw tag and no raw attribute delimiter
          expect(`${where}: ${tagCount(out)}`).toBe(`${where}: ${tagCount(baseline)}`);
          expect(`${where}: ${quoteCount(out)}`).toBe(`${where}: ${quoteCount(baseline)}`);
          // 2. nothing executable materialises
          // (attribute VALUES are blanked first: `data-key="&lt;img onerror=…"`
          // is inert, and quoteCount above already proves nothing escapes them)
          const bare = skeleton(out);
          expect(bare).not.toContain("<script");
          expect(bare).not.toContain("<img");
          expect(bare).not.toContain("<b ");
          expect(bare).not.toMatch(/<[^>]*\son(error|load|mouseover|focus|click)\s*=/i);
          expect(out).not.toMatch(/<(script|img|iframe|svg on)/i);
          // 3. the payload itself never appears verbatim
          if (/[<>"']/.test(payload)) expect(out).not.toContain(payload);
        }
      }
    }
  });

  test("picker.js contains no URL of any kind (ci-checks gate 4 / no xmlns)", () => {
    const src = readFileSync(fileURLToPath(new URL("../public/lib/picker.js", import.meta.url)), "utf8");
    expect(src).not.toContain("http");
    expect(src).not.toContain("xmlns");
  });
});
