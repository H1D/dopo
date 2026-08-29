import { afterEach, describe, expect, test } from "bun:test";
import { MockFetch, json } from "./helpers/mock-fetch";
import categoriesFx from "./fixtures/lm/categories.json";
import accountsFx from "./fixtures/lm/accounts.json";
import pagesFx from "./fixtures/lm/transactions-2pages.json";
import endlessPageFx from "./fixtures/lm/transactions-endless-page.json";
import {
  LMError,
  applyCategories,
  getMe,
  getState,
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

  test("miss -> per-id GET: 404 skipped, still-uncategorized sent, categorized skipped", async () => {
    mock = new MockFetch()
      .route((url, init) => {
        if (url.includes("/v2/transactions?") && (!init?.method || init.method === "GET")) return json(windowPage);
        return null;
      })
      .route((url) => (url.endsWith("/v2/transactions/2") ? json({ error: "not found" }, 404) : null))
      .route((url) => (url.endsWith("/v2/transactions/3") ? json({ id: 3, category_id: null, is_pending: false }) : null))
      .route((url) => (url.endsWith("/v2/transactions/4") ? json({ id: 4, category_id: 200, is_pending: false }) : null))
      .route((url, init) => (init?.method === "PUT" && url.endsWith("/v2/transactions") ? json({}) : null))
      .install();

    const res = await applyCategories("tok", [
      { id: 1, category_id: 101 }, // in the window -> sent without per-id fetch
      { id: 2, category_id: 101 }, // 404 -> skipped (absence alone never bricks replay)
      { id: 3, category_id: 102 }, // outside window but still uncategorized -> sent
      { id: 4, category_id: 101 }, // categorized elsewhere since -> skipped
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
