import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

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
  KEEPALIVE_SNAPSHOT_FRESH_MS,
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
  queueMutate,
  queueSave,
  resetStorageForTests,
  ruleAdd,
  rulesLoad,
  saveLaterIds,
  setTokens,
  snapshotClear,
  snapshotLoad,
  snapshotPrune,
  snapshotSave,
  sugClear,
  sugGet,
  sugGetMany,
  sugPut,
} from "../public/lib/store.js";

type QueueItem = ReturnType<typeof queueLoad>[number];

/** Minimal valid queue item; ts defaults to the id so identities stay distinct. */
const qi = (id: number, category_id: number, extra: Partial<QueueItem> = {}): QueueItem => ({
  id,
  category_id,
  ts: id,
  flushable: false,
  sent: false,
  snapshotTs: null,
  ...extra,
});

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
    const snapTs = 5000;
    const queue = [
      { id: 1, category_id: 9, ts: 1, flushable: true, sent: false, snapshotTs: snapTs }, // eligible
      { id: 2, category_id: 9, ts: 1, flushable: false, sent: false, snapshotTs: snapTs }, // undo pending
      { id: 3, category_id: 9, ts: 1, flushable: true, sent: false, snapshotTs: 4000 }, // older session
      { id: 4, category_id: 9, ts: 1, flushable: true, sent: false, snapshotTs: null }, // legacy = old session
    ];
    expect(keepaliveEligible(queue, snapTs, snapTs + 60_000).map((i) => i.id)).toEqual([1]);
    expect(keepaliveEligible(queue, null, snapTs)).toEqual([]); // no successful fetch this session
  });

  test("keepaliveEligible freshness bound: a >10-min-old snapshot ages out of keepalive", () => {
    const snapTs = 5000;
    const queue = [{ id: 1, category_id: 9, ts: 1, flushable: true, sent: false, snapshotTs: snapTs }];
    expect(keepaliveEligible(queue, snapTs, snapTs + KEEPALIVE_SNAPSHOT_FRESH_MS - 1).map((i) => i.id)).toEqual([1]);
    // at/beyond the bound the sheet sat open too long — defer to the recheck-based replay
    expect(keepaliveEligible(queue, snapTs, snapTs + KEEPALIVE_SNAPSHOT_FRESH_MS)).toEqual([]);
  });

  test("stuck reason (optional new field) round-trips; unknown fields still tolerated", () => {
    backing.set(LS_KEYS.queue, JSON.stringify([
      { id: 1, category_id: 2, ts: 3, flushable: false, sent: true, snapshotTs: null, stuck: "HTTP 422", mystery: 1 },
    ]));
    const q = queueLoad();
    expect(q[0]!.stuck).toBe("HTTP 422");
    queueSave(q);
    expect(queueLoad()[0]!.stuck).toBe("HTTP 422");
    expect(queueLoad()[0]!.flushable).toBe(false);
  });
});

describe("queueMutate — slow-path writes: fresh-read merge under (optional) web lock", () => {
  test("fn receives the FRESH queue, so a writer with a stale in-memory copy cannot clobber", async () => {
    queueSave([qi(1, 101)]);
    const staleView = queueLoad(); // writer A reads early…
    await queueMutate((q) => { q.push(qi(2, 102)); }); // …writer B lands an append…
    expect(staleView.length).toBe(1);
    await queueMutate((q) => {
      expect(q.map((i) => i.id)).toEqual([1, 2]); // …and A's fn still sees B's write
      q.push(qi(3, 103));
    });
    expect(queueLoad().map((i) => i.id)).toEqual([1, 2, 3]);
  });

  test("duplicate ids collapse on save — max ts wins (two tabs, same txn)", async () => {
    queueSave([qi(7, 101, { ts: 5 }), qi(8, 108)]);
    const saved = await queueMutate((q) => {
      q.push(qi(7, 202, { ts: 9 })); // newer decision for the same txn
      q.push(qi(8, 999, { ts: 1 })); // OLDER duplicate must lose
    });
    expect(saved.map((i) => [i.id, i.category_id])).toEqual([[7, 202], [8, 108]]);
    expect(queueLoad()).toEqual(saved);
  });

  test("fn may return a replacement array (filtering)", async () => {
    queueSave([qi(1, 101), qi(2, 102)]);
    const saved = await queueMutate((q) => q.filter((it) => it.id !== 1));
    expect(saved.map((i) => i.id)).toEqual([2]);
  });

  test("uses navigator.locks (name dopo.queue) when available", async () => {
    const events: string[] = [];
    const orig = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: {
        locks: {
          request: async (name: string, cb: () => unknown) => {
            events.push(`acquire:${name}`);
            try { return await cb(); } finally { events.push(`release:${name}`); }
          },
        },
      },
      configurable: true,
    });
    try {
      await queueMutate((q) => { q.push(qi(1, 101)); });
      expect(events).toEqual(["acquire:dopo.queue", "release:dopo.queue"]);
      expect(queueLoad().length).toBe(1);
    } finally {
      if (orig) Object.defineProperty(globalThis, "navigator", orig);
      else delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  test("propagates storage failure like queueSave (callers flush eagerly)", async () => {
    failWrites = true;
    await expect(queueMutate((q) => { q.push(qi(1, 101)); })).rejects.toThrow();
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
  test("legacy full-txn entries migrate: bodies preserved; NO pointer compaction on the memory fallback", async () => {
    backing.set(LS_KEYS.later, JSON.stringify([
      { id: 10, payee: "Old Format BV", amount: "1.00", date: "2026-01-01" },
      11, // pointer with no body anywhere — but IDB is unreachable here, so it must SURVIVE
    ]));
    const later = await laterLoad();
    expect(later.map((t) => t.id)).toEqual([10]);
    expect(later[0]!.payee).toBe("Old Format BV");
    // compaction is forbidden when later ops fell back to memory: "couldn't read a
    // body" is not "body confirmed gone". (Healthy-IDB compaction is tested below.)
    expect(loadLater().ids).toEqual([10, 11]);
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

  test("ruleAdd dedupes by (pattern case-insensitive, match_type, category_id)", () => {
    const first = ruleAdd({ pattern: "Albert Heijn", category_id: 101 });
    const dup = ruleAdd({ pattern: "albert heijn", category_id: 101 });
    expect(dup.id).toBe(first.id); // existing rule returned, nothing appended
    expect(rulesLoad().length).toBe(1);
    ruleAdd({ pattern: "albert heijn", category_id: 102 }); // different target -> new
    ruleAdd({ pattern: "albert heijn", match_type: "exact", category_id: 101 }); // different match -> new
    expect(rulesLoad().length).toBe(3);
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

// ---------------------------------------------------------------------------
// state snapshot
// ---------------------------------------------------------------------------

/** Raw LM-shaped txn for snapshot payloads. */
const rawTxn = (id: number, payee = `Payee ${id}`) => ({
  id,
  date: "2026-08-01",
  amount: "10.00",
  currency: "eur",
  payee,
  category_id: null,
  notes: null,
  status: "unreviewed",
  is_pending: false,
  plaid_account_id: null,
  manual_account_id: null,
});
const cat = (id: number, name = `Cat ${id}`) => ({ id, name, group: null });

describe("state snapshot — memory fallback path (bun has no indexedDB)", () => {
  beforeEach(() => resetStorageForTests());

  test("save/load round trip; null on miss; clear", async () => {
    expect(await snapshotLoad()).toBeNull();
    await snapshotSave(
      { categories: [cat(101)], accounts: [], transactions: [rawTxn(1), rawTxn(2)], truncated: true, total: 9 },
      1000,
    );
    const snap = await snapshotLoad();
    expect(snap).not.toBeNull();
    expect(snap!.transactions.map((t) => t.id)).toEqual([1, 2]);
    expect(snap!.categories).toEqual([cat(101)]);
    expect(snap!.fetchedAt).toBe(1000);
    expect(snap!.truncated).toBe(true);
    expect(snap!.total).toBe(9);
    await snapshotClear();
    expect(await snapshotLoad()).toBeNull();
  });

  test("skip-unchanged (same id-set + counts) still bumps fetchedAt, keeps the old payload", async () => {
    await snapshotSave({ categories: [cat(101)], accounts: [], transactions: [rawTxn(1, "Original BV"), rawTxn(2)] }, 1000);
    // same id-set, edited payee — the comparator deliberately misses in-place edits
    await snapshotSave({ categories: [cat(101)], accounts: [], transactions: [rawTxn(2), rawTxn(1, "Edited BV")] }, 2000);
    const snap = await snapshotLoad();
    expect(snap!.fetchedAt).toBe(2000); // the stale banner must never overstate age
    expect(snap!.transactions[0]!.payee).toBe("Original BV"); // payload write skipped
  });

  test("changed id-set replaces the payload", async () => {
    await snapshotSave({ categories: [], accounts: [], transactions: [rawTxn(1), rawTxn(2)] }, 1000);
    await snapshotSave({ categories: [], accounts: [], transactions: [rawTxn(2), rawTxn(3)] }, 2000);
    const snap = await snapshotLoad();
    expect(snap!.transactions.map((t) => t.id)).toEqual([2, 3]);
  });

  test("prune drops flushed ids; empty list is a no-op", async () => {
    await snapshotSave({ categories: [], accounts: [], transactions: [rawTxn(1), rawTxn(2), rawTxn(3)] }, 1000);
    await snapshotPrune([]);
    await snapshotPrune([1, 3, 99]);
    const snap = await snapshotLoad();
    expect(snap!.transactions.map((t) => t.id)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// IndexedDB-backed paths (fake-indexeddb): v1→v2 upgrade, snapshot persistence,
// upgrade-safety triple, compaction guard
// ---------------------------------------------------------------------------

/**
 * indexedDB whose open() forwards to fake-indexeddb but (a) fires onblocked and
 * (b) withholds onsuccess until release() — an old tab holding v1 open during
 * the v1→v2 rollout.
 */
class GatedIDBFactory {
  real = new IDBFactory();
  private released = false;
  private pending: (() => void)[] = [];
  release() {
    this.released = true;
    for (const f of this.pending) f();
    this.pending = [];
  }
  open(name: string, version?: number) {
    const realReq = this.real.open(name, version);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    let onsuccess: (() => void) | null = null;
    const proxy = {
      get result() { return realReq.result; },
      set onupgradeneeded(f: () => void) { realReq.onupgradeneeded = f; },
      set onerror(f: () => void) { realReq.onerror = f; },
      set onblocked(f: () => void) { queueMicrotask(() => f?.()); },
      set onsuccess(f: () => void) { onsuccess = f; },
    };
    realReq.onsuccess = () => {
      if (self.released) onsuccess?.();
      else self.pending.push(() => onsuccess?.());
    };
    return proxy;
  }
}

describe("IndexedDB-backed paths (fake-indexeddb)", () => {
  const g = globalThis as Record<string, unknown>;
  let savedIdb: PropertyDescriptor | undefined;
  beforeAll(() => {
    savedIdb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  });
  beforeEach(() => {
    g.indexedDB = new IDBFactory();
    resetStorageForTests();
  });
  afterAll(() => {
    if (savedIdb) Object.defineProperty(globalThis, "indexedDB", savedIdb);
    else delete g.indexedDB;
    resetStorageForTests();
  });

  const sug = (n: number) => ({ suggested_category_id: n, confidence: 0.9, reasoning: `r${n}` });

  /** Seed a v1 database exactly as the pre-snapshot schema created it. */
  async function seedV1() {
    const factory = g.indexedDB as IDBFactory;
    await new Promise<void>((resolve, reject) => {
      const req = factory.open("dopo", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const s = db.createObjectStore("suggestions", { keyPath: "key" });
        s.createIndex("ts", "ts");
        db.createObjectStore("later", { keyPath: "id" });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(["suggestions", "later"], "readwrite");
        tx.objectStore("suggestions").put({ key: "txn:1", value: sug(101), ts: 1 });
        tx.objectStore("later").put({ id: 5, payee: "Parked BV" });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  test("v1→v2 upgrade preserves suggestions + Later bodies; snapshot store works after", async () => {
    await seedV1();
    expect(await sugGet("txn:1")).toEqual(sug(101)); // triggers the v2 open + upgrade
    expect(await laterGet(5)).toEqual({ id: 5, payee: "Parked BV" });
    expect(cacheIsMemoryOnly()).toBe(false);
    await snapshotSave({ categories: [], accounts: [], transactions: [rawTxn(1)] }, 111);
    expect((await snapshotLoad())!.fetchedAt).toBe(111);
  });

  test("snapshot save/prune/load against real IDB; corrupted record loads as null", async () => {
    await snapshotSave(
      { categories: [cat(101)], accounts: [], transactions: [rawTxn(1), rawTxn(2), rawTxn(3)], truncated: true, total: 7 },
      1000,
    );
    await snapshotPrune([1, 3]);
    const snap = await snapshotLoad();
    expect(snap!.transactions.map((t) => t.id)).toEqual([2]);
    expect(snap!.truncated).toBe(true);
    expect(snap!.total).toBe(7);

    // corrupt the stored record out-of-band -> shape-validated load degrades to null
    const factory = g.indexedDB as IDBFactory;
    await new Promise<void>((resolve, reject) => {
      const req = factory.open("dopo", 2);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("snapshot", "readwrite");
        tx.objectStore("snapshot").put({ key: "state", categories: "nope" });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    expect(await snapshotLoad()).toBeNull();
  });

  test("healthy IDB: legacy Later migration compacts pointers (bodies moved into IDB)", async () => {
    backing.set(LS_KEYS.later, JSON.stringify([
      { id: 10, payee: "Old Format BV", amount: "1.00" },
      11, // no body anywhere and IDB IS reachable -> genuinely evicted -> compacted away
    ]));
    const later = await laterLoad();
    expect(later.map((t) => t.id)).toEqual([10]);
    expect(loadLater()).toEqual({ ids: [10], legacyTxns: [] });
    expect(await laterGet(10)).toEqual({ id: 10, payee: "Old Format BV", amount: "1.00" });
  });

  test("blocked upgrade: ops time out to memory WITHOUT latching memory-only or poisoning the open", async () => {
    const gated = new GatedIDBFactory();
    g.indexedDB = gated;
    resetStorageForTests();
    configureCache({ opTimeoutMs: 20 });

    await sugPut("k1", sug(1)); // open still blocked -> this call degrades to memory
    expect(cacheIsMemoryOnly()).toBe(false); // blocked ≠ broken: no session latch
    expect(await sugGet("k1")).toEqual(sug(1)); // served from the memory fallback meanwhile

    gated.release(); // the old tab closed; the SAME cached open promise resolves
    await new Promise((r) => setTimeout(r, 0));
    await sugPut("k2", sug(2)); // must land in the real DB now

    // Fresh module state pointed straight at the real backing store: k2 persisted
    // (the cached open promise was never poisoned), k1 stayed memory-only.
    resetStorageForTests();
    g.indexedDB = gated.real;
    expect(await sugGet("k2")).toEqual(sug(2));
    expect(await sugGet("k1")).toBeNull();
    expect(cacheIsMemoryOnly()).toBe(false);
  });

  test("compaction forbidden after a later op fell back (sticky flag): stalled IDB never wipes pointers", async () => {
    const gated = new GatedIDBFactory(); // never released -> every op times out
    g.indexedDB = gated;
    resetStorageForTests();
    configureCache({ opTimeoutMs: 10 });

    saveLaterIds([31, 32]);
    const bodies = await laterLoad(); // body reads time out -> nothing readable
    expect(bodies).toEqual([]);
    expect(loadLater().ids).toEqual([31, 32]); // pointers SURVIVE — pile not wiped
    expect(cacheIsMemoryOnly()).toBe(false);
  });
});
