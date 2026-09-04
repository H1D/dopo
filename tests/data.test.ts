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

import { assembleFromSnapshot, assembleState, askable, mergeAi, merchantKeyOf, wantsAi } from "../public/data.js";
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

describe("attach order — an LM-held category", () => {
  test("rides along as a confident 'lm' suggestion; local rules beat it; unknown ids fall through to caches", async () => {
    await snapshotSave(
      {
        categories: [{ id: 101, name: "Groceries", group: null }, { id: 102, name: "Car", group: null }],
        accounts: [],
        transactions: [
          { ...rawTxn(1, "Ayvens"), category_id: 102 }, // LM rule set Car, still unreviewed
          { ...rawTxn(2, "Albert Heijn 1234"), category_id: 102 }, // a local rule disagrees
          { ...rawTxn(3, "Old Shop"), category_id: 999 }, // archived / unknown category -> not trusted
          rawTxn(4, "Nothing Known"),
        ],
        truncated: false,
        total: 4,
      },
      1,
    );
    await sugPut("txn:3", { suggested_category_id: 101, confidence: 0.4, reasoning: "ai says" });
    mock = new MockFetch().install();
    const res = await assembleFromSnapshot([
      { id: 1, pattern: "albert heijn", match_type: "contains", category_id: 101 },
    ]);
    const byId = new Map(res!.transactions.map((t) => [t.id, t]));
    expect(byId.get(1)!.suggestion).toMatchObject({ source: "lm", suggested_category_id: 102, confidence: 1 });
    expect(byId.get(2)!.suggestion).toMatchObject({ source: "rule", suggested_category_id: 101 });
    expect(byId.get(3)!.suggestion).toMatchObject({ source: "ai", suggested_category_id: 101 });
    expect(byId.get(4)!.suggestion).toBeNull();
  });
});

describe("mergeAi — a model verdict against what the card already holds", () => {
  const txn = (extra: Record<string, unknown> = {}) => ({ ...rawTxn(1, "Shop"), merchant: "Shop", suggestion: null, ...extra });
  const ai = (id: number | null, confidence: number) => ({ suggested_category_id: id, confidence, reasoning: "ai says", source: "ai" as const });
  const web = (id: number | null, confidence: number) => ({ suggested_category_id: id, confidence, reasoning: "web says", source: "web" as const });
  const rule = { suggested_category_id: 5, confidence: 1, reasoning: "rule", source: "rule" as const };
  const lm = { suggested_category_id: 102, confidence: 1, reasoning: "held", source: "lm" as const };

  test("a bare card takes whatever the model says, sure or not", () => {
    expect(mergeAi(txn(), ai(101, 0.9))).toMatchObject({ source: "ai", suggested_category_id: 101 });
    expect(mergeAi(txn(), ai(101, 0.2))).toMatchObject({ source: "ai", confidence: 0.2 });
    expect(mergeAi(txn(), ai(null, 0))).toMatchObject({ source: "ai", suggested_category_id: null });
  });

  test("a rule stays on top; a web verdict is never replaced by pass 1, but web replaces ai", () => {
    expect(mergeAi(txn({ suggestion: rule }), ai(101, 0.99))).toBe(rule);
    expect(mergeAi(txn({ suggestion: rule }), web(101, 0.99))).toBe(rule);
    const w = web(101, 0.9);
    expect(mergeAi(txn({ suggestion: w }), ai(103, 0.99))).toBe(w);
    expect(mergeAi(txn({ suggestion: ai(101, 0.3) }), web(103, 0.9))).toMatchObject({ source: "web", suggested_category_id: 103 });
  });

  test("on a row Lunch Money already categorized: agreement and an unsure verdict keep the held category (with the verdict in the reasoning); only a CONFIDENT disagreement takes the card", () => {
    const held = txn({ category_id: 102, suggestion: lm });
    const agree = mergeAi(held, ai(102, 0.4));
    expect(agree).toMatchObject({ source: "lm", suggested_category_id: 102, confidence: 1 });
    expect(agree.reasoning).toContain("AI agrees");
    const unsure = mergeAi(held, ai(101, 0.5));
    expect(unsure).toMatchObject({ source: "lm", suggested_category_id: 102, confidence: 1 });
    expect(unsure.reasoning).toContain("wasn't sure");
    expect(mergeAi(held, ai(null, 0)).source).toBe("lm");
    expect(mergeAi(held, ai(101, 0.7))).toMatchObject({ source: "ai", suggested_category_id: 101 }); // at the threshold: disagreement wins
    expect(mergeAi(held, web(101, 0.9))).toMatchObject({ source: "web", suggested_category_id: 101 });
  });

  test("the held category is only trusted when it is an assignable leaf", () => {
    const stale = txn({ category_id: 999, suggestion: null }); // archived / group id: attach gave it no lm suggestion
    expect(mergeAi(stale, ai(101, 0.2), (id) => id !== 999)).toMatchObject({ source: "ai", suggested_category_id: 101 });
    expect(mergeAi(stale, ai(999, 0.9), (id) => id !== 999)).toMatchObject({ source: "ai" }); // not re-dressed as "lm"
  });

  test("askable / wantsAi: bare or lm-only cards the model hasn't seen, gated per bucket for the automatic pass", () => {
    const ai = { uncategorized: true, unreviewed: false, reviewed: false };
    expect(askable(txn())).toBe(true);
    expect(askable(txn({ suggestion: lm, category_id: 102 }))).toBe(true);
    expect(askable(txn({ suggestion: lm, category_id: 102, aiChecked: true }))).toBe(false);
    expect(askable(txn({ suggestion: rule }))).toBe(false);
    expect(askable(txn({ suggestion: { ...lm, source: "ai" } }))).toBe(false);
    expect(wantsAi(txn(), ai)).toBe(true); // uncategorized bucket on
    expect(wantsAi(txn({ suggestion: lm, category_id: 102 }), ai)).toBe(false); // unreviewed bucket off
    expect(wantsAi(txn({ suggestion: lm, category_id: 102 }), { ...ai, unreviewed: true })).toBe(true);
    expect(wantsAi(txn({ status: "reviewed" }), ai)).toBe(false);
    expect(wantsAi(txn({ status: "reviewed" }), { ...ai, reviewed: true })).toBe(true);
  });
});

describe("attach — cached verdicts on LM-held rows", () => {
  test("a cached pass-1 / web verdict is weighed against the held category; aiChecked marks the row either way", async () => {
    await snapshotSave(
      {
        categories: [{ id: 101, name: "Groceries", group: null }, { id: 102, name: "Car", group: null }],
        accounts: [],
        transactions: [
          { ...rawTxn(1, "Agree Shop"), category_id: 102 },
          { ...rawTxn(2, "Unsure Shop"), category_id: 102 },
          { ...rawTxn(3, "Disagree Shop"), category_id: 102 },
          { ...rawTxn(4, "Web Shop"), category_id: 102 },
          { ...rawTxn(5, "Fresh Shop"), category_id: 102 },
        ],
        truncated: false,
        total: 5,
      },
      1,
    );
    await sugPut("txn:1", { suggested_category_id: 102, confidence: 0.3, reasoning: "ai" });
    await sugPut("txn:2", { suggested_category_id: 101, confidence: 0.4, reasoning: "ai" });
    await sugPut("txn:3", { suggested_category_id: 101, confidence: 0.95, reasoning: "ai" });
    await sugPut("m:" + merchantKeyOf(cleanMerchant("Web Shop")), { suggested_category_id: 101, confidence: 0.9, reasoning: "web", web: true });
    mock = new MockFetch().install();
    const res = await assembleFromSnapshot([]);
    const byId = new Map(res!.transactions.map((t) => [t.id, t]));
    expect(byId.get(1)!.suggestion).toMatchObject({ source: "lm", suggested_category_id: 102 });
    expect(byId.get(1)!.suggestion!.reasoning).toContain("AI agrees");
    expect(byId.get(2)!.suggestion).toMatchObject({ source: "lm", suggested_category_id: 102 });
    expect(byId.get(3)!.suggestion).toMatchObject({ source: "ai", suggested_category_id: 101 });
    expect(byId.get(4)!.suggestion).toMatchObject({ source: "web", suggested_category_id: 101 });
    expect(byId.get(5)!.suggestion).toMatchObject({ source: "lm", suggested_category_id: 102 });
    expect([1, 2, 3, 4].map((id) => byId.get(id)!.aiChecked)).toEqual([true, true, true, true]);
    expect(byId.get(5)!.aiChecked).toBe(false);
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
