import { describe, expect, test } from "bun:test";
import {
  FIELD_IDLE,
  STEP_IDS,
  canAdvance,
  nextFieldState,
  nextStep,
  orChoices,
  parseStep,
  prevStep,
  stepsFor,
} from "../public/lib/onboard.js";

// ---------------------------------------------------------------------------
// parseStep
// ---------------------------------------------------------------------------

describe("parseStep", () => {
  test("every STEP_IDS value parses back to itself", () => {
    for (const id of STEP_IDS) expect(parseStep(id)).toBe(id);
  });

  test("picker is a real step id (a persisted cursor must resume there)", () => {
    expect(parseStep("picker")).toBe("picker");
    expect(STEP_IDS.indexOf("picker")).toBe(STEP_IDS.indexOf("done") - 1);
  });

  test("garbage — wrong type, unknown string, empty — parses to null", () => {
    expect(parseStep("bogus")).toBeNull();
    expect(parseStep("")).toBeNull();
    expect(parseStep(null)).toBeNull();
    expect(parseStep(undefined)).toBeNull();
    expect(parseStep(42)).toBeNull();
    expect(parseStep({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stepsFor
// ---------------------------------------------------------------------------

describe("stepsFor", () => {
  test("default (first run): all five steps in order, picker just before done", () => {
    expect(stepsFor({})).toEqual(["welcome", "lm", "or", "picker", "done"]);
  });

  test("returning users never see the picker step — the choice is a device pref that survives Forget tokens", () => {
    expect(stepsFor({ returning: true, hasFreeTier: true })).not.toContain("picker");
    expect(stepsFor({ returning: true, hasFreeTier: false })).not.toContain("picker");
  });

  test("returning + hasFreeTier: lm then or (must not silently land on the shared key)", () => {
    expect(stepsFor({ returning: true, hasFreeTier: true })).toEqual(["lm", "or"]);
  });

  test("returning without a free tier: lm only", () => {
    expect(stepsFor({ returning: true, hasFreeTier: false })).toEqual(["lm"]);
    expect(stepsFor({ returning: true })).toEqual(["lm"]);
  });
});

// ---------------------------------------------------------------------------
// nextStep / prevStep
// ---------------------------------------------------------------------------

describe("nextStep / prevStep bounds", () => {
  const steps = stepsFor({});

  test("nextStep walks the sequence and returns null past the end", () => {
    expect(nextStep(steps, "welcome")).toBe("lm");
    expect(nextStep(steps, "lm")).toBe("or");
    expect(nextStep(steps, "or")).toBe("picker");
    expect(nextStep(steps, "picker")).toBe("done");
    expect(nextStep(steps, "done")).toBeNull();
  });

  test("prevStep walks backward and returns null before the start", () => {
    expect(prevStep(steps, "done")).toBe("picker");
    expect(prevStep(steps, "picker")).toBe("or");
    expect(prevStep(steps, "or")).toBe("lm");
    expect(prevStep(steps, "lm")).toBe("welcome");
    expect(prevStep(steps, "welcome")).toBeNull();
  });

  test("unknown current step: both return null", () => {
    const shortSteps = stepsFor({ returning: true, hasFreeTier: false }); // ["lm"]
    expect(nextStep(shortSteps, "or")).toBeNull();
    expect(prevStep(shortSteps, "done")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nextFieldState — the field validation machine
// ---------------------------------------------------------------------------

describe("nextFieldState", () => {
  test("edit changes value and resets to idle from any status", () => {
    expect(nextFieldState(FIELD_IDLE, { type: "edit", value: "abc" })).toEqual({ status: "idle", value: "abc" });
    expect(nextFieldState({ status: "ok", value: "old" }, { type: "edit", value: "new" })).toEqual({
      status: "idle",
      value: "new",
    });
    expect(nextFieldState({ status: "netfail", value: "old" }, { type: "edit", value: "new" })).toEqual({
      status: "idle",
      value: "new",
    });
  });

  test("same-value edit is a no-op — returns the identical state (status untouched)", () => {
    const checking = { status: "checking" as const, value: "abc" };
    expect(nextFieldState(checking, { type: "edit", value: "abc" })).toBe(checking);
    const ok = { status: "ok" as const, value: "abc" };
    expect(nextFieldState(ok, { type: "edit", value: "abc" })).toBe(ok);
  });

  test("check moves to checking, keeping the value it's checking", () => {
    expect(nextFieldState(FIELD_IDLE, { type: "check", value: "tok" })).toEqual({ status: "checking", value: "tok" });
  });

  test("ok/bad/netfail apply when the value matches what's currently being checked", () => {
    const checking = { status: "checking" as const, value: "tok" };
    expect(nextFieldState(checking, { type: "ok", value: "tok" })).toEqual({ status: "ok", value: "tok" });
    expect(nextFieldState(checking, { type: "bad", value: "tok" })).toEqual({ status: "bad", value: "tok" });
    expect(nextFieldState(checking, { type: "netfail", value: "tok" })).toEqual({ status: "netfail", value: "tok" });
  });

  test("stale ok/bad/netfail results (value != cur.value) are ignored", () => {
    const checking = { status: "checking" as const, value: "tok2" }; // user kept typing
    expect(nextFieldState(checking, { type: "ok", value: "tok1" })).toBe(checking);
    expect(nextFieldState(checking, { type: "bad", value: "tok1" })).toBe(checking);
    expect(nextFieldState(checking, { type: "netfail", value: "tok1" })).toBe(checking);
  });

  test("arm only fires from netfail", () => {
    const netfail = { status: "netfail" as const, value: "tok" };
    expect(nextFieldState(netfail, { type: "arm" })).toEqual({ status: "armed", value: "tok" });
    // arm from any other status is a no-op
    expect(nextFieldState(FIELD_IDLE, { type: "arm" })).toBe(FIELD_IDLE);
    const ok = { status: "ok" as const, value: "tok" };
    expect(nextFieldState(ok, { type: "arm" })).toBe(ok);
    const checking = { status: "checking" as const, value: "tok" };
    expect(nextFieldState(checking, { type: "arm" })).toBe(checking);
    const bad = { status: "bad" as const, value: "tok" };
    expect(nextFieldState(bad, { type: "arm" })).toBe(bad);
  });

  test("offline seeds netfail up front (entering the step while navigator.onLine is false)", () => {
    expect(nextFieldState(FIELD_IDLE, { type: "offline", value: "tok" })).toEqual({ status: "netfail", value: "tok" });
  });
});

// ---------------------------------------------------------------------------
// canAdvance
// ---------------------------------------------------------------------------

describe("canAdvance", () => {
  const steps4 = stepsFor({});

  test("welcome: always continuable, primary is Connect Lunch Money, no Back", () => {
    const a = canAdvance({ stepId: "welcome", steps: steps4, field: FIELD_IDLE, saved: false, choice: null, returning: false });
    expect(a).toEqual({ canContinue: true, primary: "Connect Lunch Money", secondary: null, showBack: false, checkFirst: false });
  });

  test("lm: empty field, nothing saved -> cannot continue", () => {
    const a = canAdvance({ stepId: "lm", steps: steps4, field: FIELD_IDLE, saved: false, choice: null, returning: false });
    expect(a.canContinue).toBe(false);
    expect(a.showBack).toBe(true); // lm is index 1
  });

  test("Back-after-save: lm step with an EMPTY field but a saved token -> can continue, no re-check", () => {
    const a = canAdvance({ stepId: "lm", steps: steps4, field: FIELD_IDLE, saved: true, choice: null, returning: false });
    expect(a.canContinue).toBe(true);
    expect(a.checkFirst).toBe(false);
  });

  test("lm: non-empty, unchecked field -> continuable but must check first", () => {
    const a = canAdvance({
      stepId: "lm",
      steps: steps4,
      field: { status: "idle", value: "sk-lm-1" },
      saved: false,
      choice: null,
      returning: false,
    });
    expect(a.canContinue).toBe(true);
    expect(a.checkFirst).toBe(true);
  });

  test("lm: ok or armed field -> continuable, no re-check needed", () => {
    const ok = canAdvance({ stepId: "lm", steps: steps4, field: { status: "ok", value: "tok" }, saved: false, choice: null, returning: false });
    expect(ok.canContinue).toBe(true);
    expect(ok.checkFirst).toBe(false);
    const armed = canAdvance({ stepId: "lm", steps: steps4, field: { status: "armed", value: "tok" }, saved: false, choice: null, returning: false });
    expect(armed.canContinue).toBe(true);
    expect(armed.checkFirst).toBe(false);
  });

  test("lm: checking -> cannot continue, label 'Checking…'", () => {
    const a = canAdvance({ stepId: "lm", steps: steps4, field: { status: "checking", value: "tok" }, saved: false, choice: null, returning: false });
    expect(a.canContinue).toBe(false);
    expect(a.primary).toBe("Checking…");
  });

  test("lm: netfail -> primary 'Try again', secondary 'Continue anyway', continuable via the escape hatch", () => {
    const a = canAdvance({ stepId: "lm", steps: steps4, field: { status: "netfail", value: "tok" }, saved: false, choice: null, returning: false });
    expect(a.primary).toBe("Try again");
    expect(a.secondary).toBe("Continue anyway");
    expect(a.canContinue).toBe(true);
  });

  test("lm: netfail on an EMPTY field (offline step entry) -> nothing to try or continue with until pasted", () => {
    const a = canAdvance({ stepId: "lm", steps: steps4, field: { status: "netfail", value: "" }, saved: false, choice: null, returning: false });
    expect(a.canContinue).toBe(false);
    expect(a.secondary).toBeNull();
    expect(a.checkFirst).toBe(false);
    const b = canAdvance({ stepId: "lm", steps: steps4, field: { status: "netfail", value: "" }, saved: true, choice: null, returning: false });
    expect(b.canContinue).toBe(true); // Back-after-save while offline: the saved token carries
  });

  test("or: choice null -> cannot continue regardless of field state", () => {
    const a = canAdvance({ stepId: "or", steps: steps4, field: FIELD_IDLE, saved: false, choice: null, returning: false });
    expect(a.canContinue).toBe(false);
  });

  test("or: free or none choice -> always continuable, no field involved", () => {
    const free = canAdvance({ stepId: "or", steps: steps4, field: FIELD_IDLE, saved: false, choice: "free", returning: false });
    expect(free.canContinue).toBe(true);
    const none = canAdvance({ stepId: "or", steps: steps4, field: FIELD_IDLE, saved: false, choice: "none", returning: false });
    expect(none.canContinue).toBe(true);
  });

  test("or: own choice mirrors the lm field rules", () => {
    const empty = canAdvance({ stepId: "or", steps: steps4, field: FIELD_IDLE, saved: false, choice: "own", returning: false });
    expect(empty.canContinue).toBe(false);

    const savedEmpty = canAdvance({ stepId: "or", steps: steps4, field: FIELD_IDLE, saved: true, choice: "own", returning: false });
    expect(savedEmpty.canContinue).toBe(true);
    expect(savedEmpty.checkFirst).toBe(false);

    const netfail = canAdvance({
      stepId: "or",
      steps: steps4,
      field: { status: "netfail", value: "or-tok" },
      saved: false,
      choice: "own",
      returning: false,
    });
    expect(netfail.primary).toBe("Try again");
    expect(netfail.secondary).toBe("Continue anyway");
  });

  test("picker: always continuable, plain Continue, Back available, nothing to check", () => {
    const a = canAdvance({ stepId: "picker", steps: steps4, field: FIELD_IDLE, saved: false, choice: null, returning: false });
    expect(a).toEqual({ canContinue: true, primary: "Continue", secondary: null, showBack: true, checkFirst: false });
  });

  test("picker: a stale lm netfail state must NOT fall through to the field machine", () => {
    // the user hit a network failure on the lm step, armed past it, and walked on:
    // the field state is still netfail when the picker step renders.
    const a = canAdvance({
      stepId: "picker",
      steps: steps4,
      field: { status: "netfail", value: "lm-tok" },
      saved: true,
      choice: "own",
      returning: false,
    });
    expect(a.primary).toBe("Continue"); // not "Try again"
    expect(a.secondary).toBeNull(); // not "Continue anyway"
    expect(a.canContinue).toBe(true);
    expect(a.checkFirst).toBe(false);

    // same for a check still in flight — the picker step never says "Checking…"
    const checking = canAdvance({
      stepId: "picker",
      steps: steps4,
      field: { status: "checking", value: "lm-tok" },
      saved: false,
      choice: null,
      returning: false,
    });
    expect(checking.canContinue).toBe(true);
    expect(checking.primary).toBe("Continue");
  });

  test("checking label takes priority even on the last step", () => {
    const returningSteps = stepsFor({ returning: true, hasFreeTier: false }); // ["lm"]
    const a = canAdvance({
      stepId: "lm",
      steps: returningSteps,
      field: { status: "checking", value: "tok" },
      saved: false,
      choice: null,
      returning: true,
    });
    expect(a.primary).toBe("Checking…");
  });

  test("last step label: 'Done' when returning, 'Start sorting' on the done step of a first run", () => {
    const returningSteps = stepsFor({ returning: true, hasFreeTier: true }); // ["lm","or"]
    const lastOr = canAdvance({ stepId: "or", steps: returningSteps, field: FIELD_IDLE, saved: false, choice: "none", returning: true });
    expect(lastOr.primary).toBe("Done");

    const done = canAdvance({ stepId: "done", steps: steps4, field: FIELD_IDLE, saved: false, choice: null, returning: false });
    expect(done.primary).toBe("Start sorting");
  });

  test("non-last steps keep the plain 'Continue' label", () => {
    const a = canAdvance({ stepId: "or", steps: steps4, field: FIELD_IDLE, saved: false, choice: "free", returning: false });
    expect(a.primary).toBe("Continue");
  });

  test("showBack is false only on the first step of the active sequence", () => {
    expect(canAdvance({ stepId: "welcome", steps: steps4, field: FIELD_IDLE, saved: false, choice: null, returning: false }).showBack).toBe(false);
    expect(canAdvance({ stepId: "lm", steps: steps4, field: FIELD_IDLE, saved: false, choice: null, returning: false }).showBack).toBe(true);

    const returningSteps = stepsFor({ returning: true, hasFreeTier: false }); // ["lm"] — lm is first here
    expect(canAdvance({ stepId: "lm", steps: returningSteps, field: FIELD_IDLE, saved: false, choice: null, returning: true }).showBack).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// orChoices
// ---------------------------------------------------------------------------

describe("orChoices", () => {
  test("hasFreeTier=true: free + own, nothing pre-selected in the shape itself", () => {
    const choices = orChoices(true);
    expect(choices.map((c) => c.id)).toEqual(["free", "own"]);
    const free = choices[0]!;
    expect(free.title).toBeTruthy();
    expect(free.lead).toBeTruthy();
    expect(free.bullets.length).toBe(5);
  });

  test("hasFreeTier=false: none + own", () => {
    const choices = orChoices(false);
    expect(choices.map((c) => c.id)).toEqual(["none", "own"]);
    const none = choices[0]!;
    expect(none.bullets).toEqual([]);
  });

  test("own card: bullets include the per-500 cost line and the spend-limit advice", () => {
    const own = orChoices(true).find((c) => c.id === "own")!;
    expect(own.bullets.some((b) => /\$0\.06 per 500 transactions/.test(b))).toBe(true);
    expect(own.bullets.some((b) => /\$0\.0075/.test(b) && /15 per session/.test(b))).toBe(true);
    expect(own.bullets.some((b) => /dedicated key with a spend limit/.test(b))).toBe(true);
  });

  test("own card is present and identical in shape regardless of hasFreeTier", () => {
    const ownWithFree = orChoices(true).find((c) => c.id === "own");
    const ownWithout = orChoices(false).find((c) => c.id === "own");
    expect(ownWithFree).toEqual(ownWithout);
  });
});
