import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MockFetch, json } from "./helpers/mock-fetch";
import categoriesFx from "./fixtures/lm/categories.json";
import accountsFx from "./fixtures/lm/accounts.json";

// bun test has no window.localStorage — shim it for the modules under test.
// (No indexedDB either: store.js runs on its mandatory memory fallback here.)
const backing = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => void backing.clear(),
};

import { LMError } from "../public/lib/lm.js";
import {
  STUCK_AFTER_ATTEMPTS,
  isPoisonStatus,
  replayQueue,
  resetSyncSessionForTests,
} from "../public/lib/sync.js";
import {
  queueLoad,
  queueSave,
  resetStorageForTests,
  ruleAdd,
  rulesLoad,
  snapshotLoad,
  snapshotSave,
} from "../public/lib/store.js";

type QueueItem = ReturnType<typeof queueLoad>[number];

const qi = (id: number, category_id: number, extra: Partial<QueueItem> = {}): QueueItem => ({
  id,
  category_id,
  ts: id,
  flushable: false,
  sent: false,
  snapshotTs: null,
  ...extra,
});

/** A txn as the unreviewed window serves it. */
const winTxn = (id: number) => ({
  id,
  date: "2026-08-01",
  amount: "10.00",
  currency: "eur",
  payee: `Payee ${id}`,
  category_id: null,
  notes: null,
  status: "unreviewed",
  is_pending: false,
  plaid_account_id: 11,
  manual_account_id: null,
});

let mock: MockFetch;
beforeEach(() => {
  backing.clear();
  resetStorageForTests();
  resetSyncSessionForTests();
});
afterEach(() => mock?.restore());

/**
 * Standard replay routes: the getState trio + the unreviewed window, per-id
 * fallback GETs, and a PUT whose status can depend on the body (poison tests).
 */
function routeReplay(opts: {
  window: number[];
  /** per-id GET answers; status defaults to "reviewed" once a category is set, "unreviewed" otherwise */
  perId?: Record<number, { category_id: number | null; status?: "reviewed" | "unreviewed" } | 404>;
  putStatus?: (body: { transactions: { id: number }[] }) => number;
}) {
  mock = new MockFetch()
    .route((url) => (url.includes("/v2/categories") ? json(categoriesFx) : null))
    .route((url) => (url.includes("/v2/plaid_accounts") ? json({ plaid_accounts: accountsFx.plaid_accounts }) : null))
    .route((url) => (url.includes("/v2/manual_accounts") ? json({ manual_accounts: accountsFx.manual_accounts }) : null))
    .route((url, init) => {
      if (url.includes("/v2/transactions?") && (!init?.method || init.method === "GET")) {
        return json({ transactions: opts.window.map(winTxn), has_more: false });
      }
      return null;
    })
    .route((url) => {
      const m = url.match(/\/v2\/transactions\/(\d+)$/);
      if (!m) return null;
      const spec = opts.perId?.[Number(m[1])];
      if (spec === undefined || spec === 404) return json({ error: "not found" }, 404);
      const status = spec.status ?? (spec.category_id === null ? "unreviewed" : "reviewed");
      return json({ id: Number(m[1]), category_id: spec.category_id, status, is_pending: false });
    })
    .route((url, init) => {
      if (init?.method === "PUT" && url.endsWith("/v2/transactions")) {
        const body = JSON.parse(init.body as string) as { transactions: { id: number }[] };
        const status = opts.putStatus ? opts.putStatus(body) : 200;
        return status === 200 ? json({}) : json({ error: `rejected` }, status);
      }
      return null;
    })
    .install();
}

describe("isPoisonStatus", () => {
  test("4xx excluding 401 (auth), 408 (timeout), 429 (rate limit)", () => {
    expect(isPoisonStatus(400)).toBe(true);
    expect(isPoisonStatus(404)).toBe(true);
    expect(isPoisonStatus(422)).toBe(true);
    expect(isPoisonStatus(401)).toBe(false);
    expect(isPoisonStatus(408)).toBe(false);
    expect(isPoisonStatus(429)).toBe(false);
    expect(isPoisonStatus(500)).toBe(false);
    expect(isPoisonStatus(200)).toBe(false);
  });
});

describe("replayQueue — contract", () => {
  test("applies via recheck, partitions skips by pre-replay sent flag, absorbs make_rule, empties the queue", async () => {
    queueSave([
      qi(1, 101), // in the window -> applied (flushable:false: boot replay marks it)
      qi(2, 102, { make_rule: { pattern: "albert heijn", match_type: "contains" } }), // applied + rule
      qi(3, 101), // reviewed elsewhere, never sent from here -> skippedUnsent (announce)
      qi(4, 101, { sent: true }), // 404 upstream, already sent once -> skippedSent (silent)
      qi(5, 103), // outside the window but still unreviewed -> applied
    ]);
    routeReplay({ window: [1, 2], perId: { 3: { category_id: 200 }, 4: 404, 5: { category_id: null } } });

    const seen: number[][] = [];
    const res = await replayQueue("tok", { onApplied: (ids) => seen.push(ids) });

    expect(res.applied.toSorted((a, b) => a - b)).toEqual([1, 2, 5]);
    expect(res.skippedUnsent).toEqual([3]);
    expect(res.skippedSent).toEqual([4]);
    expect(res.stuck).toEqual([]);
    expect(queueLoad()).toEqual([]); // applied AND skipped both leave the queue
    expect(seen.flat().toSorted((a, b) => a - b)).toEqual([1, 2, 5]);

    // make_rule absorbed into local rules with the decided category
    const rules = rulesLoad();
    expect(rules.length).toBe(1);
    expect(rules[0]).toMatchObject({ pattern: "albert heijn", match_type: "contains", category_id: 102 });

    // ONE window recheck for the whole replay; per-id fallback only for misses
    expect(mock.callsTo("/v2/transactions?").length).toBe(1);
    expect(mock.callsTo("/v2/transactions/3").length).toBe(1);
    expect(mock.callsTo("/v2/transactions/4").length).toBe(1);
    expect(mock.callsTo("/v2/transactions/5").length).toBe(1);

    // one PUT, exact per-item shape, no recheck skips inside it
    const puts = mock.calls.filter((c) => c.method === "PUT");
    expect(puts.length).toBe(1);
    expect(puts[0]!.body).toEqual({
      transactions: [
        { id: 1, category_id: 101, status: "reviewed" },
        { id: 2, category_id: 102, status: "reviewed" },
        { id: 5, category_id: 103, status: "reviewed" },
      ],
    });
  });

  test("make_rule absorption dedupes against existing rules", async () => {
    ruleAdd({ pattern: "albert heijn", category_id: 102 });
    queueSave([qi(2, 102, { make_rule: { pattern: "Albert Heijn", match_type: "contains" } })]);
    routeReplay({ window: [2] });
    await replayQueue("tok");
    expect(rulesLoad().length).toBe(1); // no duplicate rule
  });

  test("duplicate ids collapse before the PUT — max ts wins", async () => {
    queueSave([qi(7, 101, { ts: 1 }), qi(7, 202, { ts: 9 })]); // two tabs, same txn
    routeReplay({ window: [7] });
    const res = await replayQueue("tok");
    expect(res.applied).toEqual([7]);
    const put = mock.calls.find((c) => c.method === "PUT");
    expect(put!.body).toEqual({ transactions: [{ id: 7, category_id: 202, status: "reviewed" }] });
  });

  test("empty queue: resolves without any network traffic", async () => {
    mock = new MockFetch().install();
    const res = await replayQueue("tok");
    expect(res).toEqual({ applied: [], skippedSent: [], skippedUnsent: [], stuck: [] });
    expect(mock.calls.length).toBe(0);
  });

  test("prunes applied + skipped ids from the snapshot", async () => {
    await snapshotSave(
      { categories: [], accounts: [], transactions: [winTxn(1), winTxn(3), winTxn(8)] },
      1000,
    );
    queueSave([qi(1, 101), qi(3, 101)]); // 1 applied, 3 skipped (categorized elsewhere)
    routeReplay({ window: [1], perId: { 3: { category_id: 200 } } });
    await replayQueue("tok");
    const snap = await snapshotLoad();
    expect(snap!.transactions.map((t) => t.id)).toEqual([8]); // untouched card survives
  });
});

describe("replayQueue — typed errors pass through, queue survives", () => {
  test("401 surfaces as LMError (dead token is routed by the caller, never papered over)", async () => {
    queueSave([qi(1, 101)]);
    mock = new MockFetch().route(() => json({ error: "bad token" }, 401)).install();
    const err = await replayQueue("dead").catch((e) => e);
    expect(err).toBeInstanceOf(LMError);
    expect(err.status).toBe(401);
    expect(queueLoad().length).toBe(1); // decision still safe in localStorage
  });

  test("network rejection (TypeError) passes through untouched", async () => {
    queueSave([qi(1, 101)]);
    mock = new MockFetch().route(() => { throw new TypeError("fetch failed"); }).install();
    const err = await replayQueue("tok").catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(queueLoad().length).toBe(1);
  });

  test("5xx on the PUT is NOT poison: propagates for ordinary backoff", async () => {
    queueSave([qi(1, 101)]);
    routeReplay({ window: [1], putStatus: () => 503 });
    const err = await replayQueue("tok").catch((e) => e);
    expect(err).toBeInstanceOf(LMError);
    expect(err.status).toBe(503);
    const q = queueLoad();
    expect(q.length).toBe(1);
    expect(q[0]!.sent).toBe(true); // sent marked before the PUT — silent skip next time
  });
});

describe("replayQueue — poison-item isolation (bisect the PUT stage only)", () => {
  test("bisect isolates the poison item; healthy neighbours still apply; 3 session attempts park it", async () => {
    const routes = () =>
      routeReplay({
        window: [11, 12, 13],
        putStatus: (body) => (body.transactions.some((t) => t.id === 12) ? 422 : 200),
      });

    queueSave([qi(11, 101), qi(12, 102), qi(13, 103)]);
    routes();
    const res1 = await replayQueue("tok");
    expect(res1.applied.toSorted((a, b) => a - b)).toEqual([11, 13]);
    expect(res1.stuck).toEqual([]);
    let q = queueLoad();
    expect(q.map((i) => i.id)).toEqual([12]); // attempt 1: stays queued for retry
    expect(q[0]!.flushable).toBe(true);
    expect(q[0]!.sent).toBe(true);
    mock.restore();

    routes(); // attempt 2
    expect((await replayQueue("tok")).stuck).toEqual([]);
    mock.restore();

    routes(); // attempt 3 -> parked
    const res3 = await replayQueue("tok");
    expect(res3.stuck).toEqual([12]);
    q = queueLoad();
    expect(q[0]!.flushable).toBe(false);
    expect(q[0]!.stuck).toBe("HTTP 422");
    mock.restore();

    // same session, next replay: parked item is skipped WITHOUT any network traffic
    mock = new MockFetch().install();
    const res4 = await replayQueue("tok");
    expect(res4.stuck).toEqual([12]);
    expect(res4.applied).toEqual([]);
    expect(mock.calls.length).toBe(0);
    mock.restore();

    // fresh session (counter is session-only): the item is retried from scratch
    resetSyncSessionForTests();
    routes();
    const res5 = await replayQueue("tok");
    expect(res5.stuck).toEqual([]); // back to attempt 1
    q = queueLoad();
    expect(q[0]!.flushable).toBe(true);
    expect(q[0]!.stuck).toBeUndefined();
  });

  test("408/429 are transient, not poison: propagate without consuming attempts", async () => {
    queueSave([qi(1, 101)]);
    routeReplay({ window: [1], putStatus: () => 429 });
    const err = await replayQueue("tok").catch((e) => e);
    expect(err).toBeInstanceOf(LMError);
    expect(err.status).toBe(429);
    // still flushable after STUCK_AFTER_ATTEMPTS repeats — no attempt was counted
    for (let i = 0; i < STUCK_AFTER_ATTEMPTS; i++) {
      mock.restore();
      routeReplay({ window: [1], putStatus: () => 429 });
      await replayQueue("tok").catch(() => {});
    }
    expect(queueLoad()[0]!.flushable).toBe(true);
  });
});

describe("replayQueue — lock scope", () => {
  test("the dopo.queue lock is NEVER held across network I/O", async () => {
    let lockDepth = 0;
    let acquisitions = 0;
    const violations: string[] = [];
    const orig = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: {
        locks: {
          request: async (_name: string, cb: () => unknown) => {
            lockDepth++;
            acquisitions++;
            try { return await cb(); } finally { lockDepth--; }
          },
        },
      },
      configurable: true,
    });
    try {
      queueSave([qi(1, 101), qi(3, 101, { sent: true })]);
      routeReplay({ window: [1], perId: { 3: { category_id: 200 } } });
      // record any fetch that happens while the lock is held
      const inner = globalThis.fetch;
      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        if (lockDepth > 0) violations.push(String(args[0]));
        return inner(...args);
      }) as typeof fetch;
      try {
        const res = await replayQueue("tok");
        expect(res.applied).toEqual([1]);
        expect(res.skippedSent).toEqual([3]);
      } finally {
        globalThis.fetch = inner;
      }
      expect(violations).toEqual([]);
      // mark-flushable, remove-skips, mark-sent, remove-applied — all locked steps
      expect(acquisitions).toBeGreaterThanOrEqual(4);
    } finally {
      if (orig) Object.defineProperty(globalThis, "navigator", orig);
      else delete (globalThis as Record<string, unknown>).navigator;
    }
  });
});
