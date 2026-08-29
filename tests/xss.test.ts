import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * XSS property test for the card template (spec "CSP & XSS"): card markup must be
 * built by a PURE exported template function `cardHTML(txn, ...)` so this suite can
 * assert that attacker-controlled payee/notes/lookup strings come out escaped —
 * a property test over payload x field, not a grep.
 *
 * The pure template lives in public/lib/card.js (re-exported through app.js's
 * module graph). We import card.js directly: app.js touches the DOM at module
 * scope and cannot load under bun. If NEITHER exists yet (agent B mid-flight),
 * the suite SKIPS with a TODO — the skip guard is the cutover tripwire.
 */

const cardPath = fileURLToPath(new URL("../public/lib/card.js", import.meta.url));
const appPath = fileURLToPath(new URL("../public/app.js", import.meta.url));
const sourcePath = existsSync(cardPath) ? cardPath : existsSync(appPath) ? appPath : null;

const PAYLOADS = [
  "<img src=x onerror=alert(1)>",
  '"><img src=x onerror="fetch(`//evil`)">',
  "'><svg onload=alert(1)>",
  "<script>alert(1)</script>",
  "&lt;fake-pre-escaped&gt;<b onmouseover=x>",
  "` onfocus=alert(1) autofocus x=`",
];

// every user-influencable text field cardHTML renders
const FIELDS = ["payee", "merchant", "notes", "lookup", "reasoning", "catName", "acctName"] as const;

function build(field: string, payload: string) {
  const txn: Record<string, unknown> = {
    id: 1,
    date: "2026-01-01",
    amount: "12.50",
    currency: "eur",
    payee: "Safe Payee",
    merchant: "Safe Merchant",
    notes: "safe notes",
    suggestion: {
      suggested_category_id: 101,
      confidence: 0.9,
      reasoning: "safe reasoning",
      lookup: "safe lookup",
      source: "ai",
    },
  };
  const category: Record<string, unknown> = { id: 101, name: "🛒 Groceries", group: "🍎 Food" };
  const account: Record<string, unknown> = { key: "p11", name: "Checking", mask: "1234" };
  const s = txn.suggestion as Record<string, unknown>;
  if (field === "lookup" || field === "reasoning") s[field] = payload;
  else if (field === "catName") category.name = payload;
  else if (field === "acctName") account.name = payload;
  else txn[field] = payload;
  return { txn, category, account };
}

describe("cardHTML XSS property test", () => {
  if (!sourcePath) {
    // TODO(agent B): neither public/lib/card.js nor public/app.js exists yet.
    // Once the pure cardHTML export lands, this suite runs automatically.
    test.skip("SKIPPED: cardHTML module not created yet (agent B)", () => {});
    return;
  }

  test("hostile payloads in every text field come out escaped", async () => {
    const mod = (await import(sourcePath)) as Record<string, unknown>;
    const cardHTML = mod.cardHTML;
    if (typeof cardHTML !== "function") {
      throw new Error(`${sourcePath} does not export cardHTML — required by SPEC-STATIC.md 'CSP & XSS'`);
    }

    const render = (t: unknown, o: unknown) => {
      const html = (cardHTML as (t: unknown, o: unknown) => unknown)(t, o);
      expect(typeof html).toBe("string");
      return html as string;
    };
    // number of RAW opened tags in the markup — payload injection must never grow it
    const tagCount = (s: string) => (s.match(/<[a-zA-Z/!]/g) || []).length;

    for (const field of FIELDS) {
      const safe = build(field, "SAFE-BASELINE");
      const baseline = render(safe.txn, { category: safe.category, account: safe.account });
      for (const payload of PAYLOADS) {
        const { txn, category, account } = build(field, payload);
        const out = render(txn, { category, account });
        // Property 1: hostile markup adds ZERO raw tags — every '<' from input
        // data is entity-escaped (the template's own <svg> etc. stay constant).
        expect(tagCount(out)).toBe(tagCount(baseline));
        // Property 2: no payload element or event handler materializes.
        expect(out).not.toContain("<img");
        expect(out).not.toContain("<script");
        expect(out).not.toMatch(/<[^>]*\son(error|load|mouseover|focus)\s*=/i);
        if (payload.includes("<")) expect(out).not.toContain(payload);
      }
    }
  });
});
