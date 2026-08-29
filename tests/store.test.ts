import { beforeEach, describe, expect, test } from "bun:test";

// bun test has no window.localStorage — shim it BEFORE importing the module under test.
// (The IndexedDB side is deliberately NOT shimmed: bun's lack of indexedDB exercises
// the module's mandatory in-memory fallback path.)
const backing = new Map<string, string>();
let failWrites = false;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
  setItem: (k: string, v: string) => {
    if (failWrites) throw new Error("QuotaExceededError");
    backing.set(k, String(v));
  },
  removeItem: (k: string) => void backing.delete(k),
  clear: () => void backing.clear(),
};

import {
  LS_KEYS,
  cacheIsMemoryOnly,
  clearTokens,
  configureCache,
  getTokens,
  isSuggestion,
  keepaliveEligible,
  laterAdd,
  laterDelete,
  laterGet,
  laterGetAll,
  laterLoad,
  laterPut,
  laterRemove,
  loadLater,
  queueLoad,
  queueSave,
  ruleAdd,
  rulesLoad,
  saveLaterIds,
  setTokens,
  sugClear,
  sugGet,
  sugGetMany,
  sugPut,
} from "../public/lib/store.js";

beforeEach(() => {
  backing.clear();
  failWrites = false;
});

describe("apply queue — dopo.queue.v1 format UNCHANGED, back-compatible", () => {
  test("legacy server-era items (no snapshotTs) load with snapshotTs=null", () => {
    // exact shape the old swipe.js persisted
    backing.set(LS_KEYS.queue, JSON.stringify([
      { id: 42, category_id: 101, ts: 1700000000000, flushable: true, sent: false },
      { id: 43, category_id: 102, make_rule: { pattern: "albert heijn", match_type: "contains" }, ts: 1700000000001, flushable: false, sent: true },
    ]));
    const q = queueLoad();
    expect(q.length).toBe(2);
    expect(q[0]).toEqual({ id: 42, category_id: 101, ts: 1700000000000, flushable: true, sent: false, snapshotTs: null });
    expect(q[1]!.make_rule).toEqual({ pattern: "albert heijn", match_type: "contains" });
    expect(q[1]!.snapshotTs).toBeNull();
  });

  test("round-trips new items with snapshotTs; shape-invalid entries dropped on read", () => {
    const item = { id: 1, category_id: 2, ts: 3, flushable: true, sent: false, snapshotTs: 1234 };
    queueSave([item]);
    backing.set(LS_KEYS.queue, JSON.stringify([
      ...JSON.parse(backing.get(LS_KEYS.queue)!),
      { id: "nope" }, null, 7, { category_id: 9 },
    ]));
    expect(queueLoad()).toEqual([item]);
  });

  test("corrupted / non-array storage degrades to [] (never throws)", () => {
    backing.set(LS_KEYS.queue, "{not json");
    expect(queueLoad()).toEqual([]);
    backing.set(LS_KEYS.queue, JSON.stringify({ a: 1 }));
    expect(queueLoad()).toEqual([]);
  });

  test("queueSave THROWS on quota failure so callers can flush eagerly", () => {
    failWrites = true;
    expect(() => queueSave([])).toThrow();
  });

  test("keepaliveEligible: same-session snapshot AND flushable only; legacy items never", () => {
    const now = 5000;
    const queue = [
      { id: 1, category_id: 9, ts: 1, flushable: true, sent: false, snapshotTs: now }, // eligible
      { id: 2, category_id: 9, ts: 1, flushable: false, sent: false, snapshotTs: now }, // undo pending
      { id: 3, category_id: 9, ts: 1, flushable: true, sent: false, snapshotTs: 4000 }, // older session
      { id: 4, category_id: 9, ts: 1, flushable: true, sent: false, snapshotTs: null }, // legacy = old session
    ];
    expect(keepaliveEligible(queue, now).map((i) => i.id)).toEqual([1]);
    expect(keepaliveEligible(queue, null)).toEqual([]); // no successful fetch this session
  });
});

describe("tokens", () => {
  test("set/get round trip with shape validation", () => {
    setTokens({ lm: "lm-secret", or: null });
    expect(getTokens()).toEqual({ lm: "lm-secret", or: null });
    backing.set(LS_KEYS.tokens, JSON.stringify({ lm: 42, or: "" }));
    expect(getTokens()).toEqual({ lm: null, or: null });
    backing.set(LS_KEYS.tokens, "garbage{");
    expect(getTokens()).toEqual({ lm: null, or: null });
  });

  test("setTokens MERGES: saving only lm keeps the stored or key", () => {
    setTokens({ lm: "lm-1", or: "or-1" });
    setTokens({ lm: "lm-2" });
    expect(getTokens()).toEqual({ lm: "lm-2", or: "or-1" });
    setTokens({ or: "or-2" });
    expect(getTokens()).toEqual({ lm: "lm-2", or: "or-2" });
  });

  test("clearTokens clears tokens ONLY — queue and rules survive", () => {
    setTokens({ lm: "x", or: "y" });
    queueSave([{ id: 1, category_id: 2, ts: 3, flushable: true, sent: false, snapshotTs: null }]);
    clearTokens();
    expect(getTokens()).toEqual({ lm: null, or: null });
    expect(queueLoad().length).toBe(1);
  });
});

describe("Later pile — pointers in localStorage, bodies via laterLoad/Add/Remove", () => {
  test("legacy full-txn entries migrate: bodies preserved, pointers compacted to ids", async () => {
    backing.set(LS_KEYS.later, JSON.stringify([
      { id: 10, payee: "Old Format BV", amount: "1.00", date: "2026-01-01" },
      11, // pointer with no body anywhere -> dropped as evicted
    ]));
    const later = await laterLoad();
    expect(later.map((t) => t.id)).toEqual([10]);
    expect(later[0]!.payee).toBe("Old Format BV");
    // pointer list compacted to surviving ids only
    expect(loadLater()).toEqual({ ids: [10], legacyTxns: [] });
  });

  test("laterAdd/laterRemove keep pointer + body in sync", async () => {
    laterAdd({ id: 21, payee: "Parked BV", amount: "2.00" });
    laterAdd({ id: 22, payee: "Other BV", amount: "3.00" });
    laterAdd({ id: 21, payee: "Parked BV", amount: "2.00" }); // idempotent pointer
    expect(loadLater().ids).toEqual([21, 22]);
    expect((await laterLoad()).map((t) => t.id)).toEqual([21, 22]);

    laterRemove(21);
    expect(loadLater().ids).toEqual([22]);
    expect((await laterLoad()).map((t) => t.id)).toEqual([22]);
  });

  test("saveLaterIds filters non-numbers", () => {
    saveLaterIds([1, "x" as never, 2]);
    expect(loadLater().ids).toEqual([1, 2]);
  });
});

describe("rules storage", () => {
  test("ruleAdd assigns id/created_at; rulesLoad validates on read", async () => {
    const added = ruleAdd({ pattern: "albert heijn", category_id: 101 });
    expect(typeof added.id).toBe("number");
    expect(added.match_type).toBe("contains");
    const loaded = rulesLoad();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.pattern).toBe("albert heijn");

    // junk written by an old/corrupt client is dropped on read, not thrown
    backing.set(LS_KEYS.rules, JSON.stringify([...loaded, { pattern: "", category_id: 1 }, null]));
    expect(rulesLoad().length).toBe(1);
  });
});

describe("suggestion cache — in-memory fallback when IndexedDB is unavailable", () => {
  const sug = (n: number) => ({ suggested_category_id: n, confidence: 0.9, reasoning: `r${n}` });

  test("bun has no indexedDB -> fallback engages instead of crashing", async () => {
    await sugClear();
    await sugPut("m:albert heijn", { ...sug(101), web: true, created_at: "2026-01-01T00:00:00Z" });
    expect(cacheIsMemoryOnly()).toBe(true);
    expect(await sugGet("m:albert heijn")).toEqual({ ...sug(101), web: true, created_at: "2026-01-01T00:00:00Z" });
    expect(await sugGet("m:unknown")).toBeNull();
  });

  test("sugGetMany returns a Map of only the present, valid entries", async () => {
    await sugClear();
    await sugPut("txn:1", sug(101));
    await sugPut("txn:2", { totally: "wrong" });
    const m = await sugGetMany(["txn:1", "txn:2", "txn:3"]);
    expect([...m.keys()]).toEqual(["txn:1"]);
    expect(m.get("txn:1")).toEqual(sug(101));
  });

  test("shape-validated on read: junk values come back null", async () => {
    await sugClear();
    await sugPut("m:junk", { category_id: 101 }); // old/wrong shape
    expect(await sugGet("m:junk")).toBeNull();
    expect(isSuggestion({ suggested_category_id: null, confidence: null, reasoning: "" })).toBe(true);
    expect(isSuggestion({ suggested_category_id: "x", confidence: 0.2, reasoning: "" })).toBe(false);
    expect(isSuggestion({ confidence: 0.2, reasoning: "" })).toBe(false);
  });

  test("LRU: cap evicts oldest; a get() touch refreshes recency", async () => {
    await sugClear();
    configureCache({ maxEntries: 3 });
    await sugPut("a", sug(1));
    await sugPut("b", sug(2));
    await sugPut("c", sug(3));
    await sugGet("a"); // touch a — now b is the LRU
    await sugPut("d", sug(4));
    expect(await sugGet("b")).toBeNull(); // evicted
    expect(await sugGet("a")).toEqual(sug(1));
    expect(await sugGet("c")).toEqual(sug(3));
    expect(await sugGet("d")).toEqual(sug(4));
    configureCache({ maxEntries: 2000 });
  });
});

describe("Later bodies — fallback store primitives", () => {
  test("put/get/getAll/delete; missing bodies dropped, order preserved", async () => {
    const t1 = { id: 1, payee: "A", amount: "1.00" };
    const t2 = { id: 2, payee: "B", amount: "2.00" };
    await laterPut(t1);
    await laterPut(t2);
    expect(await laterGet(1)).toEqual(t1);
    expect(await laterGetAll([2, 99, 1])).toEqual([t2, t1]); // 99 evicted/missing -> dropped
    await laterDelete(1);
    expect(await laterGet(1)).toBeNull();
  });
});
