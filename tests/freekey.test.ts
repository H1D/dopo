import { describe, expect, test } from "bun:test";
import { FREE_CONCURRENCY, FREE_KEY, FREE_MODELS } from "../public/lib/freekey.js";

/** The shared key is deliberately public — the guardrail (free-only allowlist,
 *  $0 budget) is what makes that safe, and these are the app-side invariants. */
describe("lib/freekey.js", () => {
  test("every FREE_MODELS entry is a :free variant (the only thing a $0-budget key can call)", () => {
    expect(FREE_MODELS.length).toBeGreaterThan(0);
    for (const m of FREE_MODELS) expect(m.endsWith(":free")).toBe(true);
    expect(new Set(FREE_MODELS).size).toBe(FREE_MODELS.length);
  });
  test("free-tier concurrency stays at 1 — the 20 req/min cap is shared account-wide", () => {
    expect(FREE_CONCURRENCY).toBe(1);
  });
  test("FREE_KEY is empty or an OpenRouter key", () => {
    const key: string = FREE_KEY; // widen the literal type — the test must hold for either value
    expect(key === "" || /^sk-or-v1-[0-9a-f]{64}$/.test(key)).toBe(true);
  });
});
