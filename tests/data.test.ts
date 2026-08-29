import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MockFetch, json } from "./helpers/mock-fetch";
import categoriesFx from "./fixtures/lm/categories.json";
import accountsFx from "./fixtures/lm/accounts.json";
import pagesFx from "./fixtures/lm/transactions-2pages.json";

// bun test has no window.localStorage — shim it for the modules under test.
// (No indexedDB: the snapshot lives on store.js's in-memory fallback here.)
const backing = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => void backing.clear(),
};

import { assembleFromSnapshot, assembleState, merchantKeyOf } from "../public/data.js";
import { cleanMerchant } from "../public/lib/clean.js";
import { resetStorageForTests, snapshotLoad, snapshotSave, sugPut } from "../public/lib/store.js";

let mock: MockFetch;
beforeEach(() => {
  backing.clear();
  resetStorageForTests();
});
afterEach(() => mock?.restore());

function routeState() {
  const pages = pagesFx as { transactions: unknown[]; has_more: boolean }[];
  mock = new MockFetch()
    .route((url) => (url.includes("/v2/categories") ? json(categoriesFx) : null))
    .route((url) => (url.includes("/v2/plaid_accounts") ? json({ plaid_accounts: accountsFx.plaid_accounts }) : null))
    .route((url) => (url.includes("/v2/manual_accounts") ? json({ manual_accounts: accountsFx.manual_accounts }) : null))
    .route((url) => {
      if (!url.includes("/v2/transactions?")) return null;
      const served = mock.callsTo("/v2/transactions?").length - 1; // this call included
      return json(pages[Math.min(served, pages.length - 1)]);
    })
    .install();
}

/** Raw LM-shaped txn for seeding snapshots directly. */
const rawTxn = (id: number, payee: string) => ({
  id,
  date: "2026-08-01",
  amount: "9.99",
  currency: "eur",
  payee,
  category_id: null,
  notes: null,
  status: "unreviewed",
  is_pending: false,
  plaid_account_id: null,
  manual_account_id: null,
});

describe("assembleState — snapshot persistence", () => {
  test("saves the RAW state (undecorated) after a successful fetch", async () => {
    routeState();
    const state = await assembleState("tok", []);
    expect(state.transactions.map((t) => t.id)).toEqual([1, 2, 5]);

    const snap = await snapshotLoad();
    expect(snap).not.toBeNull();
    expect(snap!.transactions.map((t) => t.id)).toEqual([1, 2, 5]);
    // raw: no decoration leaked into the snapshot
    expect("merchant" in snap!.transactions[0]!).toBe(false);
    expect("suggestion" in snap!.transactions[0]!).toBe(false);
    expect(snap!.categories.map((c) => c.id)).toEqual([101, 102, 200]);
    expect(snap!.accounts.length).toBe(2);
    expect(typeof snap!.fetchedAt).toBe("number");
    expect(snap!.truncated).toBe(false);
  });
});

describe("assembleFromSnapshot — offline boot assembly", () => {
  test("null when no snapshot exists", async () => {
    mock = new MockFetch().install();
    expect(await assembleFromSnapshot([])).toBeNull();
    expect(mock.calls.length).toBe(0);
  });

  test("decorates in the live order (rule → cached web → cached ai); stale + fetchedAt; zero network", async () => {
    await snapshotSave(
      {
        categories: [{ id: 101, name: "Groceries", group: null }],
        accounts: [],
        transactions: [rawTxn(1, "Albert Heijn 1234 AMSTERDAM"), rawTxn(2, "Bol.com bestelling"), rawTxn(3, "Mystery Shop")],
        truncated: true,
        total: 42,
      },
      777,
    );
    // txn 2: BOTH a cached web result and a cached ai result — web must win
    const webKey = merchantKeyOf(cleanMerchant("Bol.com bestelling"));
    await sugPut("m:" + webKey, { suggested_category_id: 55, confidence: 0.8, reasoning: "web says", web: true, created_at: "2026-01-01T00:00:00Z" });
    await sugPut("txn:2", { suggested_category_id: 66, confidence: 0.5, reasoning: "ai says" });
    // txn 3: ai only
    await sugPut("txn:3", { suggested_category_id: 77, confidence: 0.4, reasoning: "ai says" });

    mock = new MockFetch().install(); // no routes: any fetch would 599
    const res = await assembleFromSnapshot([
      { id: 1, pattern: "albert heijn", match_type: "contains", category_id: 101 },
    ]);

    expect(res).not.toBeNull();
    expect(res!.stale).toBe(true);
    expect(res!.fetchedAt).toBe(777);
    expect(res!.truncated).toBe(true);
    expect(res!.total).toBe(42);
    expect(res!.categories).toEqual([{ id: 101, name: "Groceries", group: null }]);
    expect(mock.calls.length).toBe(0); // fully offline

    const byId = new Map(res!.transactions.map((t) => [t.id, t]));
    expect(typeof byId.get(1)!.merchant).toBe("string"); // cleaned merchant attached
    expect(byId.get(1)!.suggestion).toMatchObject({ source: "rule", suggested_category_id: 101, confidence: 1 });
    expect(byId.get(2)!.suggestion).toMatchObject({ source: "web", suggested_category_id: 55 });
    expect(byId.get(3)!.suggestion).toMatchObject({ source: "ai", suggested_category_id: 77 });
  });
});
