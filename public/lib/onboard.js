// @ts-check
/**
 * Onboarding wizard — pure step/field-state machine, no DOM, no network, no
 * storage. app.js (owner C) drives the dialog off this; lib/store.js owns the
 * `dopo.onboard.v1` cursor persistence, and index.html (owner B) owns the ids.
 */

/** @typedef {"welcome"|"lm"|"or"|"done"} StepId */
export const STEP_IDS = /** @type {const} */ (["welcome", "lm", "or", "done"]);

/**
 * @param {unknown} v
 * @returns {StepId|null}
 */
export function parseStep(v) {
  return typeof v === "string" && (/** @type {readonly string[]} */ (STEP_IDS)).includes(v)
    ? /** @type {StepId} */ (v)
    : null;
}

/**
 * The step sequence for a session. First-run is always all four steps; the
 * returning path (Forget tokens) skips straight to re-entering credentials —
 * `or` only reappears when a shared free tier exists, because the user may
 * have had their own key before and must not be silently defaulted onto the
 * shared one.
 * @param {{returning?: boolean, hasFreeTier?: boolean}} o
 * @returns {StepId[]}
 */
export function stepsFor(o) {
  if (o.returning) return o.hasFreeTier ? ["lm", "or"] : ["lm"];
  return ["welcome", "lm", "or", "done"];
}

/**
 * @param {StepId[]} steps
 * @param {StepId} cur
 * @returns {StepId|null}
 */
export function nextStep(steps, cur) {
  const i = steps.indexOf(cur);
  if (i === -1) return null;
  const n = steps[i + 1];
  return n === undefined ? null : n;
}

/**
 * @param {StepId[]} steps
 * @param {StepId} cur
 * @returns {StepId|null}
 */
export function prevStep(steps, cur) {
  const i = steps.indexOf(cur);
  if (i <= 0) return null;
  const p = steps[i - 1];
  return p === undefined ? null : p;
}

/** @typedef {"idle"|"checking"|"ok"|"bad"|"netfail"|"armed"} FieldStatus */
/** @typedef {{status: FieldStatus, value: string}} FieldState  value = the string the status is about */
/**
 * @typedef {{type:"edit", value:string}|{type:"check", value:string}|{type:"ok", value:string}
 *   |{type:"bad", value:string}|{type:"netfail", value:string}|{type:"arm"}|{type:"offline", value:string}} FieldEvent
 */

export const FIELD_IDLE = /** @type {FieldState} */ ({ status: "idle", value: "" });

/**
 * The lm/or field validation machine, shared by the two token fields. A
 * result (ok/bad/netfail) that doesn't match the field's CURRENT value is a
 * stale async response — the user kept typing after the check fired — and is
 * ignored rather than overwriting what they're looking at now. `arm` (the
 * "Continue anyway" escape hatch) only fires from netfail, so it can never
 * paper over a check that's still in flight or a token the API rejected
 * outright. `offline` is how a step entered with `navigator.onLine === false`
 * seeds the up-front netfail state.
 * @param {FieldState} cur
 * @param {FieldEvent} ev
 * @returns {FieldState}
 */
export function nextFieldState(cur, ev) {
  switch (ev.type) {
    case "edit":
      return ev.value === cur.value ? cur : { status: "idle", value: ev.value };
    case "check":
      return { status: "checking", value: ev.value };
    case "ok":
    case "bad":
    case "netfail":
      return ev.value === cur.value ? { status: ev.type, value: ev.value } : cur;
    case "arm":
      return cur.status === "netfail" ? { status: "armed", value: cur.value } : cur;
    case "offline":
      return { status: "netfail", value: ev.value };
    default:
      return cur;
  }
}

/** @typedef {{canContinue:boolean, primary:string, secondary:string|null, showBack:boolean, checkFirst:boolean}} Advance */

/**
 * @param {StepId[]} steps
 * @param {StepId} stepId
 * @param {boolean} returning
 * @returns {string}
 */
function continueLabel(steps, stepId, returning) {
  const isLast = steps.length > 0 && steps[steps.length - 1] === stepId;
  if (!isLast) return "Continue";
  return returning ? "Done" : "Start sorting";
}

/**
 * Whether a token field (lm, or the "own" branch of or) permits Continue, and
 * what state it's in. A saved token with an empty field counts as "already
 * connected" (the Back-after-save case): re-entering the step shows an empty
 * password box, but there's nothing to validate until the user types.
 * @param {FieldState} field
 * @param {boolean} saved
 * @returns {{canContinue: boolean, checkFirst: boolean}}
 */
function fieldAdvance(field, saved) {
  const canContinue = field.value !== "" || saved;
  const checkFirst = field.status !== "ok" && field.status !== "armed" && field.value !== "";
  return { canContinue, checkFirst };
}

/**
 * @param {{stepId:StepId, steps:StepId[], field:FieldState, saved:boolean, choice:"free"|"none"|"own"|null,
 *   returning:boolean}} a
 * @returns {Advance}
 */
export function canAdvance(a) {
  const { stepId, steps, field, saved, choice, returning } = a;
  const showBack = steps.indexOf(stepId) > 0;
  const primary = continueLabel(steps, stepId, returning);

  if (stepId === "welcome") {
    return { canContinue: true, primary: "Connect Lunch Money", secondary: null, showBack, checkFirst: false };
  }

  if (stepId === "done") {
    return { canContinue: true, primary, secondary: null, showBack, checkFirst: false };
  }

  // lm, and the "own" branch of or, share the field machine.
  const usesField = stepId === "lm" || (stepId === "or" && choice === "own");

  if (stepId === "or" && !usesField) {
    if (choice === null) return { canContinue: false, primary, secondary: null, showBack, checkFirst: false };
    // free / none: nothing to validate.
    return { canContinue: true, primary, secondary: null, showBack, checkFirst: false };
  }

  const { canContinue, checkFirst } = fieldAdvance(field, saved);
  if (field.status === "checking") {
    return { canContinue: false, primary: "Checking…", secondary: null, showBack, checkFirst: false };
  }
  if (field.status === "netfail") {
    // Entering the step offline seeds netfail on an EMPTY field — nothing to try or
    // to continue with until something is pasted (or a token is already saved).
    return { canContinue, primary: "Try again", secondary: canContinue ? "Continue anyway" : null, showBack, checkFirst: canContinue };
  }
  return { canContinue, primary, secondary: null, showBack, checkFirst };
}

/**
 * @param {boolean} hasFreeTier
 * @returns {{id:"free"|"none"|"own", title:string, lead:string, bullets:string[]}[]}
 */
export function orChoices(hasFreeTier) {
  /** @type {{id:"free"|"none"|"own", title:string, lead:string, bullets:string[]}[]} */
  const out = [];
  if (hasFreeTier) {
    out.push({
      id: "free",
      title: "Free, nothing to set up",
      lead: "dopo's shared key does the guessing.",
      bullets: [
        "runs through dopo's shared key, not yours",
        "smaller model",
        "daily quota shared by everyone",
        "no web checks",
        "free models may train on transaction text",
      ],
    });
  } else {
    out.push({
      id: "none",
      title: "No AI for now",
      lead: "Sort by hand; add a key later in Settings.",
      bullets: [],
    });
  }
  out.push({
    id: "own",
    title: "My own key",
    lead: "",
    bullets: [
      "About $0.06 per 500 transactions, plus $0.0075 each time it double-checks a merchant on the web (max 15 per session).",
      "Use a dedicated key with a spend limit.",
    ],
  });
  return out;
}
