import { afterEach, describe, expect, test } from "bun:test";
import { MockFetch, json } from "./helpers/mock-fetch";
import categoriesFx from "./fixtures/lm/categories.json";
import accountsFx from "./fixtures/lm/accounts.json";
import pagesFx from "./fixtures/lm/transactions-2pages.json";
import endlessPageFx from "./fixtures/lm/transactions-endless-page.json";
import {
  BUCKETS,
  CUTOFF_PRESETS,
  DEFAULT_CUTOFF,
  DEFAULT_SCOPE,
  LMError,
  applyCategories,
  bucketOf,
  cutoffRange,
  defaultRange,
  getMe,
  getState,
  getTags,
  inScope,
  isOpen,
} from "../public/lib/lm.js";

let mock: MockFetch;
afterEach(() => mock?.restore());

/** Standard routes: categories, both account endpoints, paged transactions. */
function routeState(pages: { transactions: unknown[]; has_more: boolean; total?: number }[]) {
  mock = new MockFetch()
    .route((url) => (url.includes("/v2/categories") ? json(categoriesFx) : null))
    .route((url) => (url.includes("/v2/plaid_accounts") ? json({ plaid_accounts: accountsFx.plaid_accounts }) : null))
    .route((url) => (url.includes("/v2/manual_accounts") ? json({ manual_accounts: accountsFx.manual_accounts }) : null))
    .route((url) => {
      const m = url.match(/\/v2\/transactions\?.*offset=(\d+)/);
      if (!m) return null;
      const served = mock.callsTo("/v2/transactions?").length - 1; // this call included
      return json(pages[Math.min(served, pages.length - 1)]);
    })
    .install();
}

describe("getState", () => {
  test("pages until has_more=false, merges + filters, not truncated", async () => {
    routeState(pagesFx as never);
    const state = await getState("tok-1");

    // pending + already-categorized filtered out; both pages merged
    expect(state.transactions.map((t) => t.id)).toEqual([1, 2, 5]);
    expect(state.truncated).toBe(false);
    expect(state.total).toBe(3);

    // pagination advanced by served page length
    const txnCalls = mock.callsTo("/v2/transactions?");
    expect(txnCalls.every((c) => c.url.includes("include_metadata=true"))).toBe(true); // slimTxn lifts the moment, drops the blob
    expect(txnCalls.length).toBe(2);
    expect(txnCalls[0]!.url).toContain("offset=0");
    expect(txnCalls[1]!.url).toContain("offset=4");
    expect(txnCalls[0]!.url).toContain("limit=1000");

    // token travels as a bearer header on every call
    for (const c of mock.calls) {
      expect((c.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    }

    // categories come back FLAT (leaves with group attached — the old /api/state shape)
    expect(state.categories.map((c) => c.id)).toEqual([101, 102, 200]);
    expect(state.categories[0]).toEqual({ id: 101, name: "🛒 Groceries", group: "🍎 Food" });
    expect(state.categories[2]!.group).toBeNull();
    expect(state.accounts.map((a) => a.key).sort()).toEqual(["m7", "p11"]);
    expect(state.accounts.find((a) => a.key === "p11")?.name).toBe("ABN AMRO Betaalrekening");
  });

  test("membership = unreviewed + not pending: an LM-categorized row stays in, reviewed / pending rows drop", async () => {
    const row = (id: number, extra: Record<string, unknown>) => ({
      id, date: "2026-08-24", amount: "440.89", currency: "eur", payee: "Ayvens", category_id: null, notes: null,
      status: "unreviewed", is_pending: false, plaid_account_id: 11, manual_account_id: null, ...extra,
    });
    mock = new MockFetch()
      .route((url) => (url.includes("/v2/categories") ? json(categoriesFx) : null))
      .route((url) => (url.includes("/v2/plaid_accounts") ? json({ plaid_accounts: accountsFx.plaid_accounts }) : null))
      .route((url) => (url.includes("/v2/manual_accounts") ? json({ manual_accounts: accountsFx.manual_accounts }) : null))
      .route((url) => (url.includes("/v2/transactions?")
        ? json({
          transactions: [
            row(1, { category_id: 101 }), // categorized by an LM rule, not yet reviewed -> in
            row(2, { category_id: 101, status: "reviewed" }), // reviewed -> out
            row(3, { status: "reviewed" }), // reviewed without a category (odd, but LM allows it) -> out
            row(4, { is_pending: true }), // pending -> out
            row(5, {}), // plain unreviewed -> in
          ],
          has_more: false,
        })
        : null))
      .install();
    const state = await getState("tok-1");
    expect(state.transactions.map((t) => t.id)).toEqual([1, 5]);
    expect(state.transactions[0]!.category_id).toBe(101); // the existing category rides along
    expect(state.total).toBe(2);
  });

  test("hard 5-page ceiling: stops fetching, reports truncated + API total", async () => {
    routeState(Array(10).fill(endlessPageFx) as never);
    const state = await getState("tok-1");

    expect(mock.callsTo("/v2/transactions?").length).toBe(5); // CEILING, not 10
    expect(state.truncated).toBe(true);
    expect(state.total).toBe(12345); // API-reported, for "oldest N of M"
    expect(state.transactions.length).toBe(10); // 2 per page x 5 pages
  });

  test("401 surfaces as LMError with .status and tokenInvalid", async () => {
    mock = new MockFetch().route(() => json({ error: "bad token" }, 401)).install();
    const err = await getState("dead-token").catch((e) => e);
    expect(err).toBeInstanceOf(LMError);
    expect(err.status).toBe(401);
    expect(err.tokenInvalid).toBe(true);
  });
});

describe("bucketOf / inScope — deck membership", () => {
  const row = (extra: Record<string, unknown>) => ({ id: 1, status: "unreviewed", category_id: null, is_pending: false, ...extra });

  test("every row lands in exactly one of the three buckets; reviewed wins over the category test", () => {
    expect(BUCKETS).toEqual(["uncategorized", "unreviewed", "reviewed"]);
    expect(bucketOf(row({}))).toBe("uncategorized");
    expect(bucketOf(row({ category_id: 101 }))).toBe("unreviewed");
    expect(bucketOf(row({ category_id: 101, status: "reviewed" }))).toBe("reviewed");
    expect(bucketOf(row({ status: "reviewed" }))).toBe("reviewed"); // reviewed without a category (LM allows it)
    expect(bucketOf(row({ status: "delete_pending" }))).toBe("uncategorized"); // not reviewed -> by category
  });

  test("the default scope is what dopo always fetched: not reviewed, not pending", () => {
    expect(inScope(row({}))).toBe(true);
    expect(inScope(row({ category_id: 101 }))).toBe(true);
    expect(inScope(row({ status: "reviewed", category_id: 101 }))).toBe(false);
    expect(inScope(row({ is_pending: true }))).toBe(false);
    expect(inScope(null)).toBe(false);
    expect(inScope(undefined)).toBe(false);
    expect(isOpen(row({ category_id: 101 }))).toBe(true); // the legacy name = default scope
    expect(isOpen(row({ status: "reviewed" }))).toBe(false);
  });

  test("include flags switch buckets on and off; pending stays out regardless", () => {
    const onlyReviewed = { include: { uncategorized: false, unreviewed: false, reviewed: true }, skipTagIds: [] };
    expect(inScope(row({}), onlyReviewed)).toBe(false);
    expect(inScope(row({ category_id: 101 }), onlyReviewed)).toBe(false);
    expect(inScope(row({ category_id: 101, status: "reviewed" }), onlyReviewed)).toBe(true);
    expect(inScope(row({ category_id: 101, status: "reviewed", is_pending: true }), onlyReviewed)).toBe(false);
  });

  test("a skip tag keeps a row out whatever its bucket; rows without tag_ids are unaffected", () => {
    const scope = { ...DEFAULT_SCOPE, skipTagIds: [7] };
    expect(inScope(row({ tag_ids: [7] }), scope)).toBe(false);
    expect(inScope(row({ tag_ids: [3, 7] }), scope)).toBe(false);
    expect(inScope(row({ tag_ids: [3] }), scope)).toBe(true);
    expect(inScope(row({ tag_ids: [] }), scope)).toBe(true);
    expect(inScope(row({}), scope)).toBe(true);
    expect(inScope(row({ tag_ids: [7] }))).toBe(true); // no skip tags configured
  });

  test("getState pages under the given scope: reviewed rows in, tagged rows out", async () => {
    const row2 = (id: number, extra: Record<string, unknown>) => ({
      id, date: "2026-08-24", amount: "1.00", currency: "eur", payee: "x", category_id: null, notes: null,
      status: "unreviewed", is_pending: false, plaid_account_id: 11, manual_account_id: null, ...extra,
    });
    mock = new MockFetch()
      .route((url) => (url.includes("/v2/categories") ? json(categoriesFx) : null))
      .route((url) => (url.includes("/v2/plaid_accounts") ? json({ plaid_accounts: accountsFx.plaid_accounts }) : null))
      .route((url) => (url.includes("/v2/manual_accounts") ? json({ manual_accounts: accountsFx.manual_accounts }) : null))
      .route((url) => (url.includes("/v2/transactions?")
        ? json({
          transactions: [
            row2(1, {}), // uncategorized -> out under this scope
            row2(2, { category_id: 101 }), // categorized, unreviewed -> in
            row2(3, { category_id: 101, status: "reviewed" }), // reviewed -> in
            row2(4, { category_id: 101, status: "reviewed", tag_ids: [7] }), // reviewed but skip-tagged -> out
            row2(5, { category_id: 101, tag_ids: [8] }), // other tag -> in
          ],
          has_more: false,
        })
        : null))
      .install();
    const state = await getState("tok-1", {
      scope: { include: { uncategorized: false, unreviewed: true, reviewed: true }, skipTagIds: [7] },
    });
    expect(state.transactions.map((t) => t.id)).toEqual([2, 3, 5]);
    expect(state.total).toBe(3);
  });

  test("applyCategories rechecks under the same scope: a reviewed row is SENT when reviewed rows are in scope", async () => {
    mock = new MockFetch()
      .route((url, init) => (url.includes("/v2/transactions?") && (!init?.method || init.method === "GET")
        ? json({ transactions: [], has_more: false }) : null))
      .route((url) => (url.endsWith("/v2/transactions/4") ? json({ id: 4, category_id: 200, status: "reviewed", is_pending: false }) : null))
      .route((url) => (url.endsWith("/v2/transactions/5") ? json({ id: 5, category_id: 200, status: "reviewed", is_pending: false, tag_ids: [7] }) : null))
      .route((url, init) => (init?.method === "PUT" && url.endsWith("/v2/transactions") ? json({}) : null))
      .install();
    const res = await applyCategories("tok", [
      { id: 4, category_id: 101 }, // reviewed, and reviewed rows are in scope -> sent
      { id: 5, category_id: 101 }, // reviewed but carries a skip tag -> skipped
    ], { scope: { include: { uncategorized: true, unreviewed: true, reviewed: true }, skipTagIds: [7] } });
    expect(res.applied).toEqual([4]);
    expect(res.skipped).toEqual([5]);
  });
});

describe("getTags", () => {
  test("id + name only, archived tags dropped, garbage ignored", async () => {
    mock = new MockFetch()
      .route((url) => (url.endsWith("/v2/tags")
        ? json({ tags: [
          { id: 1, name: "ignore", description: "", text_color: "333", background_color: "FFF", archived: false },
          { id: 2, name: "old", archived: true },
          { id: "3", name: "bad id" },
          { id: 4 },
          null,
        ] })
        : null))
      .install();
    expect(await getTags("tok")).toEqual([{ id: 1, name: "ignore" }]);
    expect((mock.calls[0]!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  test("an unexpected body reads as no tags", async () => {
    mock = new MockFetch().route((url) => (url.endsWith("/v2/tags") ? json({ nope: 1 }) : null)).install();
    expect(await getTags("tok")).toEqual([]);
  });
});

describe("getMe", () => {
  test("tolerates the profile nested under `user`", async () => {
    mock = new MockFetch()
      .route((url) => (url.includes("/v2/me") ? json({ user: { account_id: 86, budget_name: "Fam" } }) : null))
      .install();
    expect(await getMe("t")).toEqual({ account_id: 86, budget_name: "Fam" });
  });
});

describe("applyCategories — membership recheck with per-id fallback", () => {
  const windowPage = {
    transactions: [
      { id: 1, date: "2026-01-03", amount: "12.50", currency: "eur", payee: "x", category_id: null, notes: null, status: "unreviewed", is_pending: false, plaid_account_id: 11, manual_account_id: null },
    ],
    has_more: false,
  };

  test("miss -> per-id GET: 404 skipped, still-unreviewed sent, reviewed skipped", async () => {
    mock = new MockFetch()
      .route((url, init) => {
        if (url.includes("/v2/transactions?") && (!init?.method || init.method === "GET")) return json(windowPage);
        return null;
      })
      .route((url) => (url.endsWith("/v2/transactions/2") ? json({ error: "not found" }, 404) : null))
      .route((url) => (url.endsWith("/v2/transactions/3") ? json({ id: 3, category_id: 200, status: "unreviewed", is_pending: false }) : null))
      .route((url) => (url.endsWith("/v2/transactions/4") ? json({ id: 4, category_id: 200, status: "reviewed", is_pending: false }) : null))
      .route((url, init) => (init?.method === "PUT" && url.endsWith("/v2/transactions") ? json({}) : null))
      .install();

    const res = await applyCategories("tok", [
      { id: 1, category_id: 101 }, // in the window -> sent without per-id fetch
      { id: 2, category_id: 101 }, // 404 -> skipped (absence alone never bricks replay)
      { id: 3, category_id: 102 }, // outside window, LM-categorized but still unreviewed -> sent
      { id: 4, category_id: 101 }, // reviewed elsewhere since -> skipped
    ]);

    expect(res.applied.sort()).toEqual([1, 3]);
    expect(res.skipped.sort()).toEqual([2, 4]);

    // window fetched ONCE; per-id fallback only for the three misses
    expect(mock.callsTo("/v2/transactions?").length).toBe(1);
    expect(mock.callsTo("/v2/transactions/2").length).toBe(1);
    expect(mock.callsTo("/v2/transactions/3").length).toBe(1);
    expect(mock.callsTo("/v2/transactions/4").length).toBe(1);

    // PUT body preserves the EXACT per-item shape {id, category_id, status:"reviewed"}
    const put = mock.calls.find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    expect(put!.body).toEqual({
      transactions: [
        { id: 1, category_id: 101, status: "reviewed" },
        { id: 3, category_id: 102, status: "reviewed" },
      ],
    });
    for (const t of (put!.body as { transactions: Record<string, unknown>[] }).transactions) {
      expect(Object.keys(t).sort()).toEqual(["category_id", "id", "status"]);
      expect(t.status).toBe("reviewed");
    }
  });

  test("all updates skipped -> no PUT at all", async () => {
    mock = new MockFetch()
      .route((url) => (url.includes("/v2/transactions?") ? json({ transactions: [], has_more: false }) : null))
      .route((url) => (url.endsWith("/v2/transactions/9") ? json({ error: "gone" }, 404) : null))
      .install();
    const res = await applyCategories("tok", [{ id: 9, category_id: 101 }]);
    expect(res).toEqual({ applied: [], skipped: [9] });
    expect(mock.calls.filter((c) => c.method === "PUT").length).toBe(0);
  });
});

describe("applyCategories — hidden-flush mode (recheck none, keepalive)", () => {
  test("no recheck traffic; ONE keepalive PUT with the exact body shape", async () => {
    mock = new MockFetch()
      .route((url, init) => (init?.method === "PUT" && url.endsWith("/v2/transactions") ? json({}) : null))
      .install();

    const res = await applyCategories("tok", [
      { id: 7, category_id: 101 },
      { id: 8, category_id: 200 },
    ], { recheck: "none", keepalive: true });

    expect(res.applied).toEqual([7, 8]);
    expect(mock.calls.length).toBe(1); // NO recheck fetches
    const put = mock.calls[0]!;
    expect(put.method).toBe("PUT");
    expect(put.init?.keepalive).toBe(true);
    expect(put.body).toEqual({
      transactions: [
        { id: 7, category_id: 101, status: "reviewed" },
        { id: 8, category_id: 200, status: "reviewed" },
      ],
    });
  });

  test("keepalive batch capped at 20 items", async () => {
    mock = new MockFetch().install();
    const updates = Array.from({ length: 21 }, (_, i) => ({ id: i + 1, category_id: 101 }));
    await expect(applyCategories("tok", updates, { recheck: "none", keepalive: true })).rejects.toThrow(/20/);
    expect(mock.calls.length).toBe(0); // nothing partially sent
  });
});

describe("cutoffRange — the deck's fetch window", () => {
  // A Tuesday in the middle of a month, deliberately not near any boundary.
  const now = new Date(Date.UTC(2026, 7, 18)); // 18 Aug 2026

  test("every preset ends today and starts on or before it", () => {
    for (const p of CUTOFF_PRESETS) {
      const r = cutoffRange(p.id, now);
      expect(r.end).toBe("2026-08-18");
      expect(r.start <= r.end).toBe(true);
      expect(r).toEqual({ start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), end: r.end });
    }
  });

  test("1w / 1m / 3m / ytd land on the expected day", () => {
    expect(cutoffRange("1w", now).start).toBe("2026-08-11");
    expect(cutoffRange("1m", now).start).toBe("2026-07-18");
    expect(cutoffRange("3m", now).start).toBe("2026-05-18");
    expect(cutoffRange("ytd", now).start).toBe("2026-01-01");
  });

  test("month subtraction clamps instead of rolling into the next month", () => {
    const may31 = new Date(Date.UTC(2026, 4, 31));
    // naive setUTCMonth(-3) gives 31 Feb -> 3 March; the clamp gives 28 Feb
    expect(cutoffRange("3m", may31).start).toBe("2026-02-28");
    const mar31Leap = new Date(Date.UTC(2028, 2, 31));
    expect(cutoffRange("1m", mar31Leap).start).toBe("2028-02-29");
  });

  test("3m crosses the year boundary rather than clamping to Jan 1", () => {
    const jan10 = new Date(Date.UTC(2026, 0, 10));
    expect(cutoffRange("3m", jan10)).toEqual({ start: "2025-10-10", end: "2026-01-10" });
  });

  test("an unknown or missing preset falls back to the default window", () => {
    const ytd = cutoffRange("ytd", now);
    expect(cutoffRange("nonsense", now)).toEqual(ytd);
    expect(cutoffRange(undefined, now)).toEqual(ytd);
    expect(DEFAULT_CUTOFF).toBe("ytd");
  });

  test("defaultRange stays the ytd window (the pre-cutoff behaviour)", () => {
    const d = defaultRange();
    const y = new Date().getUTCFullYear();
    expect(d.start).toBe(`${y}-01-01`);
    expect(d.end).toBe(new Date().toISOString().slice(0, 10));
  });
});
