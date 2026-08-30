import { test, expect, afterEach } from "bun:test";
import { initialTier, DEAL_MS, DEAL_IMPACT, LAND_MS, LAND_IMPACT } from "../public/lib/dust.js";

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

test("a swipe landing puffs sooner than a dealt one", () => {
  // The post-swipe hop is shorter than the full deal, so its dust must fire
  // earlier — reusing the deal timing would puff after the card had settled.
  expect(LAND_MS * LAND_IMPACT).toBeLessThan(DEAL_MS * DEAL_IMPACT);
  expect(LAND_MS * LAND_IMPACT).toBeLessThan(LAND_MS);
});
