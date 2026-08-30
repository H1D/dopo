import { test, expect, afterEach } from "bun:test";
import {
  initialTier, DEAL_MS, DEAL_IMPACT, LAND_MS, LAND_IMPACT,
  heft, referenceAmount, QUAKE_AT,
} from "../public/lib/dust.js";

/** Swap in a fake navigator; initialTier reads it at call time. */
const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
function withNavigator(fake: unknown) {
  Object.defineProperty(globalThis, "navigator", { value: fake, configurable: true, writable: true });
}
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "navigator", original);
});

test("capable device gets the full effect", () => {
  withNavigator({ hardwareConcurrency: 8, deviceMemory: 8 });
  expect(initialTier()).toBe(2);
});

test("Save-Data means the user asked us to do less", () => {
  withNavigator({ hardwareConcurrency: 8, deviceMemory: 8, connection: { saveData: true } });
  expect(initialTier()).toBe(1);
});

test("tiny-memory devices skip the canvas sim", () => {
  withNavigator({ hardwareConcurrency: 8, deviceMemory: 2 });
  expect(initialTier()).toBe(1);
});

test("dual-core devices skip the canvas sim", () => {
  withNavigator({ hardwareConcurrency: 2, deviceMemory: 8 });
  expect(initialTier()).toBe(1);
});

/** Safari reports neither hint. Guessing from absent values would wrongly
 *  demote every iPhone — the runtime frame-budget check covers those instead. */
test("missing hints do not demote", () => {
  withNavigator({});
  expect(initialTier()).toBe(2);
});

test("impact fires while the drop is still animating", () => {
  // The dust is scheduled at DEAL_MS * DEAL_IMPACT; if that ever lands at or
  // past the end of the drop, the puff would appear after the card settled.
  expect(DEAL_MS * DEAL_IMPACT).toBeLessThan(DEAL_MS);
  expect(DEAL_MS * DEAL_IMPACT).toBeGreaterThan(0);
});

/* ---------- heft: how big a transaction feels ---------- */

test("reference is the deck's median absolute amount", () => {
  expect(referenceAmount([{ amount: "-10" }, { amount: "20" }, { amount: "-30" }])).toBe(20);
  expect(referenceAmount([{ amount: "10" }, { amount: "30" }])).toBe(20); // even -> mean of middle
});

test("reference ignores junk and unparseable amounts", () => {
  expect(referenceAmount([{ amount: "0" }, { amount: "abc" }, { amount: null }, { amount: "40" }])).toBe(40);
  expect(referenceAmount([])).toBe(0);
  expect(referenceAmount([{ amount: "not-a-number" }])).toBe(0);
});

test("a typical transaction lands at baseline weight", () => {
  expect(heft("20", 20)).toBe(0);
  expect(heft("-8", 20)).toBe(0); // below the median is still just a landing
});

test("heft rises with size and saturates at 8x the median", () => {
  const mid = heft("60", 20);   // 3x
  const big = heft("160", 20);  // 8x
  expect(mid).toBeGreaterThan(0);
  expect(mid).toBeLessThan(1);
  expect(big).toBe(1);
  expect(heft("100000", 20)).toBe(1); // clamped, no runaway
});

test("sign is ignored — a big refund lands as hard as a big spend", () => {
  expect(heft("-160", 20)).toBe(heft("160", 20));
});

test("only genuinely large transactions cross the shake threshold", () => {
  expect(heft("40", 20)).toBeLessThan(QUAKE_AT);   // 2x median: no shake
  expect(heft("120", 20)).toBeGreaterThan(QUAKE_AT); // 6x median: shake
});

/** Guards the relative design: the same amount must feel different to a big
 *  spender than to a small one, and a currency with a different scale (JPY,
 *  say) must not shake on every card. */
test("heft is relative to the deck, not to an absolute amount", () => {
  expect(heft("100", 10)).toBeGreaterThan(heft("100", 90));
  expect(heft("5000", 5000)).toBe(0);
});

test("a missing or empty deck reference never shakes", () => {
  expect(heft("999999", 0)).toBe(0);
  expect(heft("999999", NaN)).toBe(0);
});

test("a swipe landing puffs sooner than a dealt one", () => {
  // The post-swipe hop is shorter than the full deal, so its dust must fire
  // earlier — reusing the deal timing would puff after the card had settled.
  expect(LAND_MS * LAND_IMPACT).toBeLessThan(DEAL_MS * DEAL_IMPACT);
  expect(LAND_MS * LAND_IMPACT).toBeLessThan(LAND_MS);
});
