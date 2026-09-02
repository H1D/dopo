import { describe, expect, test } from "bun:test";
import {
  advance,
  applyBan,
  buildBag,
  currentTrack,
  emptyState,
  normalizeState,
  peekNext,
} from "../public/lib/shuffle.js";

const IDS = ["a", "b", "c", "d", "e"];

type MusicState = import("../public/lib/shuffle.js").MusicState;

/** Deterministic rng: walks the given sequence, then repeats the last value. */
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)] ?? 0;
};

describe("buildBag", () => {
  test("contains every eligible id exactly once", () => {
    const bag = buildBag(IDS, ["b"], Math.random);
    expect([...bag].sort()).toEqual(["a", "c", "d", "e"]);
  });

  test("never opens with avoidFirst when another track exists", () => {
    for (let i = 0; i < 200; i++) {
      expect(buildBag(IDS, [], Math.random, "c")[0]).not.toBe("c");
    }
  });

  test("single-track bag may repeat — avoidFirst cannot apply", () => {
    expect(buildBag(["a"], [], Math.random, "a")).toEqual(["a"]);
  });

  test("all banned yields an empty bag", () => {
    expect(buildBag(IDS, IDS, Math.random)).toEqual([]);
  });
});

describe("advance", () => {
  test("walks the bag one track per call", () => {
    let s: MusicState = { bag: ["c", "a", "b"], pos: -1, banned: [] };
    s = advance(s, IDS, Math.random);
    expect(currentTrack(s)).toBe("c");
    s = advance(s, IDS, Math.random);
    expect(currentTrack(s)).toBe("a");
    expect(peekNext(s)).toBe("b");
  });

  test("every track plays once before any repeats, across reshuffles", () => {
    let s = emptyState();
    const rng = Math.random;
    for (let round = 0; round < 3; round++) {
      const seen = new Set<string>();
      for (let i = 0; i < IDS.length; i++) {
        s = advance(s, IDS, rng);
        seen.add(currentTrack(s) ?? "");
      }
      expect([...seen].sort()).toEqual([...IDS].sort());
    }
  });

  test("reshuffle avoids an immediate repeat of the last track", () => {
    for (let i = 0; i < 100; i++) {
      let s: MusicState = { bag: ["a", "b", "c", "d", "e"], pos: 4, banned: [] };
      const last = currentTrack(s);
      s = advance(s, IDS, Math.random);
      expect(currentTrack(s)).not.toBe(last);
    }
  });

  test("new manifest ids join at the reshuffle", () => {
    let s: MusicState = { bag: ["a", "b"], pos: 1, banned: [] };
    s = advance(s, ["a", "b", "z"], Math.random);
    expect(s.bag).toContain("z");
    expect(s.bag).toHaveLength(3);
  });

  test("empty eligible set stays silent, not crashing", () => {
    const s = advance(emptyState(), [], Math.random);
    expect(currentTrack(s)).toBeNull();
    expect(peekNext(s)).toBeNull();
  });
});

describe("applyBan", () => {
  test("banned track leaves bag and future bags", () => {
    let s: MusicState = { bag: ["a", "b", "c"], pos: 0, banned: [] };
    s = applyBan(s, "b");
    expect(s.bag).toEqual(["a", "c"]);
    for (let i = 0; i < 50; i++) {
      s = advance(s, IDS, Math.random);
      expect(currentTrack(s)).not.toBe("b");
    }
  });

  test("banning the current track keeps the walk aligned", () => {
    let s: MusicState = { bag: ["a", "b", "c"], pos: 1, banned: [] };
    s = applyBan(s, "b");
    // next advance lands on "c", exactly where the walk was headed
    s = advance(s, IDS, seq(0));
    expect(currentTrack(s)).toBe("c");
  });

  test("ban is idempotent", () => {
    const s = applyBan(applyBan({ bag: ["a", "b"], pos: 0, banned: [] as string[] }, "b"), "b");
    expect(s.banned).toEqual(["b"]);
  });

  test("banning everything leaves a coherent empty state", () => {
    let s: MusicState = { bag: ["a"], pos: 0, banned: [] };
    s = applyBan(s, "a");
    expect(currentTrack(s)).toBeNull();
    s = advance(s, ["a"], Math.random);
    expect(currentTrack(s)).toBeNull();
  });
});

describe("normalizeState", () => {
  test("corrupted storage degrades to empty", () => {
    for (const raw of [null, 42, "x", [], { bag: "no", pos: "x", banned: 7 }]) {
      const s = normalizeState(raw, IDS);
      expect(s.bag).toEqual([]);
      expect(s.pos).toBe(-1);
      expect(s.banned).toEqual([]);
    }
  });

  test("round-trips valid state", () => {
    const s = normalizeState({ bag: ["b", "a"], pos: 1, banned: ["c"] }, IDS);
    expect(s).toEqual({ bag: ["b", "a"], pos: 1, banned: ["c"] });
  });

  test("drops ids that left the manifest and clamps pos", () => {
    const s = normalizeState({ bag: ["gone", "a", "gone2"], pos: 2, banned: ["gone3", "c"] }, IDS);
    expect(s.bag).toEqual(["a"]);
    expect(s.pos).toBe(0);
    expect(s.banned).toEqual(["c"]);
  });

  test("banned ids never survive inside the bag", () => {
    const s = normalizeState({ bag: ["a", "b"], pos: 0, banned: ["a"] }, IDS);
    expect(s.bag).toEqual(["b"]);
  });

  test("dedupes storage-corrupted double entries", () => {
    const s = normalizeState({ bag: ["a", "a", "b"], pos: 0, banned: [] }, IDS);
    expect(s.bag).toEqual(["a", "b"]);
  });
});
