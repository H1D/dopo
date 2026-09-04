import { test, expect } from "bun:test";
// Importable with no AudioContext in scope: sfx.js only touches Web Audio
// inside createAudioBus/createSfx, never at module load.
import { dropParams, SWIPE_HZ } from "../public/lib/sfx.js";
import { QUAKE_AT } from "../public/lib/dust.js";

const KINDS = ["accept", "pick", "park"] as const;

test("an ordinary transaction sounds exactly like it always did", () => {
  for (const kind of KINDS) {
    const p = dropParams(kind, 0);
    expect(p.hz).toBe(SWIPE_HZ[kind]);
    expect(p.ms).toBe(70);
    expect(p.thump).toBe(0);
    expect(p.rumble).toBe(0);
  }
});

test("weight only starts to bite above the floor", () => {
  // everything up to the floor is the untouched blip — most of the deck
  for (const w of [0, 0.1, 0.2, 0.3]) {
    expect(dropParams("accept", w)).toEqual(dropParams("accept", 0));
  }
  expect(dropParams("accept", 0.31).thump).toBeGreaterThan(0);
});

test("heavier drops lower, longer and with more thump", () => {
  const heavy = dropParams("accept", 0.6);
  const heavier = dropParams("accept", 0.9);
  expect(heavier.hz).toBeLessThan(heavy.hz);
  expect(heavier.ms).toBeGreaterThan(heavy.ms);
  expect(heavier.thump).toBeGreaterThan(heavy.thump);
});

test("the curve never doubles back over the whole range", () => {
  let prev = dropParams("park", 0);
  for (let w = 0.02; w <= 1.0001; w += 0.02) {
    const p = dropParams("park", w);
    expect(p.hz).toBeLessThanOrEqual(prev.hz);
    expect(p.ms).toBeGreaterThanOrEqual(prev.ms);
    expect(p.thump).toBeGreaterThanOrEqual(prev.thump);
    prev = p;
  }
});

test("the sub tail shares the screen shake's threshold", () => {
  expect(dropParams("accept", QUAKE_AT - 0.01).rumble).toBe(0);
  // audible the moment it exists — a tail fading in from zero is no threshold
  expect(dropParams("accept", QUAKE_AT).rumble).toBeGreaterThan(0.3);
  expect(dropParams("accept", 1).rumble).toBeCloseTo(1);
});

test("nothing runs away at the top of the range", () => {
  const max = dropParams("accept", 1);
  expect(max.hz).toBeCloseTo(SWIPE_HZ.accept * 0.65);
  expect(max.ms).toBeLessThanOrEqual(130); // + a 140ms drop layer stays < 300ms
  expect(max.thump).toBe(1);
});

test("garbage weights clamp instead of detuning the kit", () => {
  const floor = dropParams("pick", 0);
  const ceil = dropParams("pick", 1);
  for (const bad of [-5, -0.001, NaN]) {
    expect(dropParams("pick", bad)).toEqual(floor);
  }
  for (const big of [1.0001, 42, Infinity]) {
    // Infinity is not finite, so it clamps to the floor rather than the ceiling
    expect(dropParams("pick", big)).toEqual(Number.isFinite(big) ? ceil : floor);
  }
});

test("an unknown kind falls back to the middle pitch", () => {
  const p = dropParams("nonsense" as "pick", 0);
  expect(p.hz).toBe(SWIPE_HZ.pick);
});
