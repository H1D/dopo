// @ts-check
/**
 * dopo swipe mode — deck, gestures, apply queue, rewards.
 * Zero-backend build: Lunch Money + OpenRouter are called directly from the
 * browser via lib/ + data.js; tokens never leave this device.
 *
 * The module is import-safe without a DOM (bun tests import cardHTML from here);
 * everything that touches document/window lives inside main().
 */

// Pure template exports for tests (XSS property test imports cardHTML from app.js).
export {
  cardHTML, esc, splitEmoji, fmtAmount, fmtAmountText, fmtTxnDate, isConfident, CONFIDENT_AT,
} from "./lib/card.js";

import {
  LMError, applyCategories, getMe, getState, getTransaction, KEEPALIVE_MAX_ITEMS, CUTOFF_PRESETS,
} from "./lib/lm.js";
import { ORError, checkKey } from "./lib/classify.js";
import { FREE_KEY, FREE_MODELS, FREE_CONCURRENCY } from "./lib/freekey.js";
import {
  getTokens, setTokens, clearTokens,
  queueLoad, queueSave, queueMutate, keepaliveEligible, LS_KEYS,
  snapshotPrune,
  laterLoad, laterAdd, laterRemove,
  rulesLoad, ruleAdd, rulesSave,
  cutoffLoad, cutoffSave, fetchWindow,
  audioLoad, audioSave,
  onboardCursorLoad, onboardCursorSave, onboardCursorClear,
} from "./lib/store.js";
import {
  stepsFor, nextStep, prevStep, nextFieldState, FIELD_IDLE, canAdvance, orChoices,
} from "./lib/onboard.js";
import { replayQueue, isPoisonStatus, STUCK_AFTER_ATTEMPTS } from "./lib/sync.js";
import {
  assembleState, assembleFromSnapshot, attachSuggestions, classifyPass1, webCheck, merchantKeyOf,
} from "./data.js";
import {
  esc, splitEmoji, fmtAmountText, fmtTxnDate, isConfident as cardConfident, cardHTML, CONFIDENT_AT,
} from "./lib/card.js";
import { createDust, heft, referenceAmount, QUAKE_AT } from "./lib/dust.js";
import { createAudioBus, createSfx } from "./lib/sfx.js";
import { createMusic } from "./lib/music.js";

/** @typedef {import("./data.js").DeckTxn} Txn */
/** @typedef {import("./data.js").UISuggestion} UISuggestion */
/** @typedef {import("./data.js").Category} Category */
/** @typedef {import("./lib/lm.js").LMAccount} Account */
/** @typedef {import("./lib/store.js").QueueItem} QueueItem */
/** @typedef {import("./lib/rules.js").Rule} Rule */
/** @typedef {import("./lib/onboard.js").StepId} StepId */
/** @typedef {import("./lib/onboard.js").FieldState} FieldState */
/**
 * @typedef {object} UndoState
 * @property {"apply"|"park"} kind
 * @property {Txn} txn
 * @property {QueueItem} [item]
 * @property {boolean} [viaPicker]
 * @property {number} [startedAt]
 * @property {number|null} [pausedRemaining]
 * @property {ReturnType<typeof setTimeout>} [timer]
 */
/**
 * @typedef {object} DragCtx
 * @property {HTMLElement} el
 * @property {Txn} txn
 * @property {number} id
 * @property {number} startX
 * @property {number} startY
 * @property {number} width
 * @property {boolean} big
 * @property {boolean} tilt
 * @property {{t: number, x: number}[]} hist
 * @property {number} dx
 * @property {number} dy
 */
/** @typedef {{txn: Txn, onPick: (catId: number) => void, onCancel: () => void}} PickerCtx */

if (typeof document !== "undefined" && typeof window !== "undefined") main();

function main() {
  // ---------- constants ----------
  const SET_SIZE = 25;
  const UNDO_MS = 5000;
  const BIG_AMOUNT = 100; // >= 100 -> deliberate flick (1.5x thresholds)
  const FLUSH_AT = 10; // flushable items that trigger a flush
  const BACKOFF = [5000, 30000, 60000];
  const APPLY_CHUNK = 20; // bounds each recheck+PUT round trip
  const REFRESH_AWAY_MS = 60000;
  const REFRESH_EVERY_MS = 5 * 60 * 1000;
  const WEB_AUTO_CAP = 15; // unique merchants web-checked per session before the explicit button
  const WEB_COST = 0.0075; // ~$ per unique web-checked merchant (README cost table)
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- storage ----------
  // Queue format "dopo.queue.v1" UNCHANGED — items queued by the server-era app
  // replay through the new client (lib/store.js normalizes legacy items).
  // UI-preference keys stay app-local (same names as the server-era app).
  const LS = { recent: "dopo.recent.v1", acct: "dopo.acctfilter.v1", sug: "dopo.sugstamp.v1", badge: "dopo.badge.v1" };
  /** @param {string} key @param {unknown[]} fallback @returns {unknown[]} */
  const lsLoad = (key, fallback) => {
    // corrupted storage (partial write, extensions) must degrade to fallback, not brick boot
    try {
      const v = JSON.parse(localStorage.getItem(key) || "null");
      return Array.isArray(v) ? v : fallback;
    } catch { return fallback; }
  };
  let queue = queueLoad();
  /** @type {Txn[]} */
  let later = []; // full txn bodies (IndexedDB), pointers in localStorage; loaded in init
  let rules = rulesLoad();
  let cutoff = cutoffLoad(); // how far back the LM fetch window reaches
  let cutoffDirty = false; // changed in Settings; the deck is redealt on sheet close
  /** @type {number[]} */
  let recent = /** @type {number[]} */ (lsLoad(LS.recent, []).filter((id) => typeof id === "number")); // recently picked category ids
  /** @type {string[]} */
  let hiddenAccounts = /** @type {string[]} */ (lsLoad(LS.acct, []).filter((k) => typeof k === "string")); // account keys excluded from the deck
  let tokens = getTokens();
  let storageDegraded = false;
  const storageFailed = () => {
    // quota / private mode: durability is gone — compensate by flushing eagerly
    if (!storageDegraded) {
      storageDegraded = true;
      note("Device storage full — syncing immediately");
    }
    flush("storage-degraded");
  };
  /** @param {string} key @param {unknown} value */
  const lsSave = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { storageFailed(); }
  };

  /** Queue item identity is (id, ts) — object references go stale across fresh-read
   *  merges, so every cross-write lookup (inflight, undo finalize, make_rule attach)
   *  goes through this string key instead.
   *  @param {QueueItem} it */
  const keyOf = (it) => `${it.id}:${it.ts}`;
  /** Collapse duplicate ids — max ts wins (mirrors store.queueMutate's merge: two
   *  tabs queuing the same txn must never leave duplicate ids for one PUT body).
   *  @param {QueueItem[]} items @returns {QueueItem[]} */
  const collapseQueue = (items) => {
    /** @type {Map<number, QueueItem>} */
    const byId = new Map();
    for (const it of items) {
      const prev = byId.get(it.id);
      if (!prev || it.ts >= prev.ts) byId.set(it.id, it);
    }
    return [...byId.values()];
  };
  /** Decision-path queue write: SYNCHRONOUS fresh-read-merge (queueLoad → fn →
   *  queueSave), NO lock — async lock callbacks may never run during teardown
   *  (pagehide), and single-item appends/marks are conflict-free. The fresh read
   *  is the load-bearing part: it merges concurrent other-tab writes
   *  instead of clobbering them with our stale in-memory view. `fn` mutates the
   *  FRESH array; item mutations must look up by (id, ts). Slow multi-step paths
   *  (interactive flush persistence, replay) use store.queueMutate instead.
   *  Refreshes the in-memory `queue` view.
   *  @param {(q: QueueItem[]) => void} fn */
  function queueWriteSync(fn) {
    try {
      const fresh = queueLoad();
      fn(fresh);
      queue = collapseQueue(fresh);
      queueSave(queue);
    } catch { storageFailed(); }
  }

  // ---------- state ----------
  /** @type {Category[]} */
  let categories = [];
  /** @type {Map<number, Category>} */
  let catById = new Map();
  /** @type {Account[]} */
  let accounts = [];
  /** @type {Map<string, Account>} */
  let acctByKey = new Map();
  /** @type {Txn[]} */
  let allTxns = []; // last fetched uncategorized window (decorated)
  /** @type {Txn[]} */
  let backlog = []; // eligible, not yet dealt (sorted confidence desc)
  /** @type {Txn[]} */
  let set = []; // current set; set[0] is the top card
  let setDone = 0;
  let decisions = 0;
  let streak = 0;
  /** Tri-state replacing the old stateLoaded boolean: "live" = fresh fetch this
   *  session, "snapshot" = offline boot from the stored snapshot (deck works,
   *  network-adjacent features gated), "none" = nothing renderable yet. */
  /** @type {"none"|"live"|"snapshot"} */
  let loadState = "none";
  /** @type {number|null} */
  let snapshotFetchedAt = null; // fetchedAt of the snapshot we booted from (stale banner)
  /** @type {Error|null} */
  let stateError = null;
  let classifyRunning = false;
  let refreshing = false;
  /** @type {number|null} */
  let lastFetchTs = null; // timestamp of the last successful state fetch THIS session
  /** @type {Set<number>} */
  let snapshotIds = new Set(); // txn ids uncategorized in that snapshot
  let truncationNoted = false;
  /** @type {UndoState|null} */
  let undoState = null;
  /** @type {QueueItem|null} */
  let pendingFinalize = null; // queue item whose undo toast was cleared on hidden
  /** @type {PickerCtx|null} */
  let pickerCtx = null;
  /** @type {DragCtx|null} */
  let dragCtx = null;
  let lastHiddenAt = 0;
  let backoffIdx = 0;
  let bootReplaying = false; // boot replayQueue in flight — flush() must not race it
  /** @type {ReturnType<typeof setTimeout>|null} */
  let flushTimer = null;
  /** @type {Set<string>} */
  const inflight = new Set(); // "(id):(ts)" keys currently being flushed (keys, not refs — see keyOf)
  // connectivity reducer state (fetch outcomes are truth; events are probes)
  let lmFailStreak = 0; // consecutive LM-origin network-class failures
  let wasOffline = false; // last settled verdict, for transition detection
  /** @type {ReturnType<typeof setTimeout>|null} */
  let onlineResyncTimer = null; // debounces the one back-online flush+refresh
  let pendingSheetResync = false; // online resync arrived while a sheet was open
  /** @type {Map<string, number>} */
  const poisonAttempts = new Map(); // SESSION-ONLY rejected-PUT counter per (id,ts) key
  /** @type {Map<string, number>} */
  const webTransientFails = new Map(); // per-merchant transient web-check failures this session
  let lastPct = -1;
  let inboxCelebrated = false;
  let dealAnim = false; // next renderStack deals cards in with the drop+dust effect
  /** Id of the transaction that was on top at the last render. Compared by id
   *  rather than DOM identity because the top card is rebuilt in place when a
   *  late suggestion arrives — that must not read as a new card landing. */
  let lastTopId = "";
  /** Median absolute amount of the loaded deck; heft() scores against it. */
  let amountRef = 0;
  // ---- onboarding wizard (<dialog>) — see the "onboarding wizard" section
  let onboardingActive = false; // wizard open: deck torn down; refresh/flush/classify contained
  let obReturning = false; // Forget-tokens path: lm [+ or] only, primary "Done"
  /** @type {StepId[]} */
  let obSteps = [];
  /** @type {StepId} */
  let obStep = "welcome";
  /** @type {{lm: FieldState, or: FieldState}} */
  let obField = { lm: FIELD_IDLE, or: FIELD_IDLE };
  /** @type {{lm: boolean, or: boolean}} */
  let obDead = { lm: false, or: false }; // the saved token was just rejected: an empty field can't Continue past it
  /** @type {"free"|"none"|"own"|null} */
  let obChoice = null; // AI step radio; nothing pre-selected
  /** @type {ReturnType<typeof setTimeout>|null} */
  let obDebounce = null; // 600 ms after the last keystroke the field validates itself
  /** @type {{lm: Promise<void>|null, or: Promise<void>|null}} */
  const obCheck = { lm: null, or: null }; // in-flight validation per field — Continue awaits it
  let obContinuing = false; // Continue re-entrancy latch (blur-validate + tap + Enter can land together)
  /** @type {Promise<void>|null} */
  let loadInFlight = null; // wizard-side quiet deck fetch
  /** @type {string|null} */
  let loadInFlightFor = null; // the LM token loadInFlight was started under
  let fetchGen = 0; // bumped when the deck's identity changes (token change, wizard open): older fetches are stale
  /** @type {string|null} */
  let replayedFor = null; // LM token the persisted queue was last replayed under
  /** @type {Promise<void>|null} */
  let replayInFlight = null; // a second caller (wizard finish vs. AI step) joins it instead of racing
  /** @type {Set<"lm"|"or">} */
  const deadTokenNoted = new Set(); // dead tokens already routed to Settings this session
  // ---- shared free tier (lib/freekey.js): used only while the user has no key of their own
  /** @type {{daily: boolean, at: number}|null} */
  let freeQuotaHit = null; // last quota error (429/402) on the free key this session — drives the upgrade banner
  let freeCooldownUntil = 0; // no automatic free-key pass before this timestamp
  let freeCooldownMs = 0; // current backoff step (90s doubling, capped) — reset by any success
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let freeRetryTimer; // re-arms ensureClassified when the cooldown ends
  let freeTierDead = false; // the shared key itself was rejected (401): fall back to LM-only mode silently
  let freeModelIdx = 0; // which FREE_MODELS entry is serving; sticky once one works, advances on 429/404
  let orCreditNoted = false; // the user's own key answered 402 (out of credit) — noted once per session
  let sugToastShown = false; // "N suggestions ready" fires at most once per visit
  let badgeEnabled = false;
  try { badgeEnabled = localStorage.getItem(LS.badge) === "1"; } catch { /* default off */ }
  let audioPrefs = audioLoad(); // { music, sfx } — both strictly opt-in
  // pass-2 web-check session state
  let webChecksUsed = 0; // unique merchants spent this session
  let webExtraAllowance = 0; // granted by the explicit "Web-check N more" button
  /** @type {Set<string>} */
  const webDone = new Set(); // merchant keys attempted this session (success or gave up)
  /** @type {Set<string>} */
  const webInflight = new Set();
  // service worker update flow
  /** @type {ServiceWorker|null} */
  let updateReady = null; // waiting SW offered via the "New version" toast
  let updateToastPending = false; // toast suppressed by an open sheet / active drag
  let updateInitiated = false; // this tab tapped the toast
  let reloadLatch = false; // controllerchange must reload at most once

  // ---------- dom ----------
  /**
   * @param {string} sel
   * @returns {HTMLElement}
   */
  const $el = (sel) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLElement)) throw new Error(`missing element ${sel}`);
    return el;
  };
  /**
   * @param {string} sel
   * @returns {HTMLInputElement}
   */
  const $input = (sel) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLInputElement)) throw new Error(`missing input ${sel}`);
    return el;
  };
  /**
   * @param {string} sel
   * @returns {HTMLButtonElement}
   */
  const $btn = (sel) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLButtonElement)) throw new Error(`missing button ${sel}`);
    return el;
  };
  /**
   * @param {string} sel
   * @returns {HTMLCanvasElement}
   */
  const $canvas = (sel) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLCanvasElement)) throw new Error(`missing canvas ${sel}`);
    return el;
  };
  /**
   * @param {string} sel
   * @returns {HTMLDialogElement}
   */
  const $dialog = (sel) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLDialogElement)) throw new Error(`missing dialog ${sel}`);
    return el;
  };

  const els = {
    stack: $el("#stack"), progressFill: $el("#progressFill"), meter: $el("#meter"),
    streak: $el("#streak"), streakN: $el("#streakN"),
    laterChip: $btn("#laterChip"), laterN: $el("#laterN"),
    menuBtn: $btn("#menuBtn"), menuPop: $el("#menuPop"), menuRefresh: $btn("#menuRefresh"),
    btnPark: $btn("#btnPark"), btnPick: $btn("#btnPick"), btnAccept: $btn("#btnAccept"),
    note: $el("#note"),
    undoToast: $el("#undoToast"), undoText: $el("#undoText"), undoBtn: $btn("#undoBtn"), ruleChip: $btn("#ruleChip"),
    backdrop: $el("#sheetBackdrop"),
    pickSheet: $el("#pickSheet"), pickTitle: $el("#pickTitle"), pickBody: $el("#pickBody"), pickClose: $btn("#pickClose"),
    laterSheet: $el("#laterSheet"), laterBody: $el("#laterBody"), laterClose: $btn("#laterClose"),
    acctSheet: $el("#acctSheet"), acctBody: $el("#acctBody"), acctClose: $btn("#acctClose"),
    menuAccounts: $btn("#menuAccounts"),
    celebrate: $el("#celebrate"), celebrateEmoji: $el("#celebrateEmoji"),
    celebrateTitle: $el("#celebrateTitle"), celebrateSub: $el("#celebrateSub"), celebrateBtn: $btn("#celebrateBtn"),
    settingsSheet: $el("#settingsSheet"), settingsClose: $btn("#settingsClose"), settingsSave: $btn("#settingsSave"),
    lmTokenInput: $input("#lmTokenInput"), lmTokenHint: $el("#lmTokenHint"), lmTokenError: $el("#lmTokenError"),
    orTokenInput: $input("#orTokenInput"), orTokenHint: $el("#orTokenHint"), orTokenError: $el("#orTokenError"),
    budgetLine: $el("#budgetLine"), webCheckLine: $el("#webCheckLine"), forgetBtn: $btn("#forgetBtn"),
    cutoffRow: $el("#cutoffRow"), cutoffLine: $el("#cutoffLine"),
    rulesNote: $el("#rulesNote"), rulesList: $el("#rulesList"),
    badgeToggle: $input("#badgeToggle"), settingsError: $el("#settingsError"), menuSettings: $btn("#menuSettings"),
    musicToggle: $input("#musicToggle"), sfxToggle: $input("#sfxToggle"),
    obMusicToggle: $input("#obMusicToggle"), obSfxToggle: $input("#obSfxToggle"),
    musicChip: $btn("#musicChip"), musicPop: $el("#musicPop"),
    musicTitle: $el("#musicTitle"), musicAuthor: $el("#musicAuthor"),
    musicSkip: $btn("#musicSkip"), musicMute: $btn("#musicMute"), musicBan: $btn("#musicBan"),
    onboard: $dialog("#onboard"), obStepLabel: $el("#obStepLabel"), obDots: $el("#obDots"),
    obLmInput: $input("#obLmInput"), obLmShow: $btn("#obLmShow"), obLmHint: $el("#obLmHint"), obLmError: $el("#obLmError"),
    obAiGroup: $el("#obAiGroup"), obOrField: $el("#obOrField"),
    obOrInput: $input("#obOrInput"), obOrShow: $btn("#obOrShow"), obOrHint: $el("#obOrHint"), obOrError: $el("#obOrError"),
    obCount: $el("#obCount"), obCutoffRow: $el("#obCutoffRow"),
    obNote: $el("#obNote"), obBack: $btn("#obBack"), obSecondary: $btn("#obSecondary"), obNext: $btn("#obNext"),
    webBar: $el("#webBar"), webBarBtn: $btn("#webBarBtn"),
    connChip: $el("#connChip"), staleBanner: $el("#staleBanner"), stuckBanner: $btn("#stuckBanner"),
    upgradeBanner: $btn("#upgradeBanner"),
    updateToast: $el("#updateToast"), updateBtn: $btn("#updateBtn"),
    confetti: $canvas("#confetti"),
  };

  // ---------- helpers ----------
  /** @param {number|number[]} p */
  const haptic = (p) => { try { navigator.vibrate?.(p); } catch { /* additive only */ } };
  /** @param {number} v @param {number} lo @param {number} hi */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** @param {Txn} t */
  const isConfident = (t) => cardConfident(t, CONFIDENT_AT);
  /** @param {Txn} t */
  function confOf(t) {
    const s = t.suggestion;
    if (!s || s.suggested_category_id == null) return -1; // unsuggested last
    return s.source === "rule" ? 1.001 : (s.confidence ?? 0);
  }
  /** @param {Txn} a @param {Txn} b */
  function byConfDesc(a, b) {
    const d = confOf(b) - confOf(a);
    if (d) return d;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  }
  /** @param {Txn} t */
  const isBig = (t) => Math.abs(Number(t.amount)) >= BIG_AMOUNT;
  /** @param {Txn} t @returns {string|null} */
  const acctKeyOf = (t) => t.plaid_account_id != null ? `p${t.plaid_account_id}`
    : t.manual_account_id != null ? `m${t.manual_account_id}` : null;
  /** @param {Txn} t @returns {Account|null} */
  const acctOf = (t) => {
    const k = acctKeyOf(t);
    return (k && acctByKey.get(k)) || null;
  };

  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let noteTimer;
  /** @param {string} msg @param {number} [ms] */
  function note(msg, ms = 2500) {
    // the page toast sits under the wizard's backdrop: route into the dialog while it's up
    const target = onboardingActive ? els.obNote : els.note;
    els.note.hidden = true;
    els.obNote.hidden = true;
    els.obNote.textContent = ""; // #obNote hides by :empty, not [hidden]
    target.textContent = msg;
    target.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { target.hidden = true; if (target === els.obNote) target.textContent = ""; }, ms);
  }

  // ---------- deck (queue + Later excluded on EVERY build) ----------
  /** @param {Txn[]} txns @returns {Txn[]} */
  function eligible(txns) {
    const excluded = new Set(queue.map((i) => i.id));
    for (const t of later) excluded.add(t.id);
    const hidden = new Set(hiddenAccounts);
    return txns.filter((t) => {
      const k = acctKeyOf(t);
      return !excluded.has(t.id) && !(k && hidden.has(k));
    });
  }

  function dealSet() {
    set = backlog.slice(0, SET_SIZE);
    backlog = backlog.slice(SET_SIZE);
    setDone = 0;
  }

  /** Rebuild everything BEHIND the top card from fresh state; never remove set[0] —
   *  but DO swap it for the fresh object with the same id, so pass-1/web-check results
   *  land on the visible card (renderStack's idle sig-diff rebuilds it in place). */
  function reconcile() {
    let top = set.length ? set[0] : null;
    if (top) {
      const topId = top.id;
      top = allTxns.find((t) => t.id === topId) ?? top;
    }
    const rest = eligible(allTxns).filter((t) => !top || t.id !== top.id).sort(byConfDesc);
    if (top) {
      const room = Math.max(0, SET_SIZE - setDone - 1);
      set = [top, ...rest.slice(0, room)];
      backlog = rest.slice(room);
    } else {
      backlog = rest;
      dealSet();
      if (set.length) inboxCelebrated = false;
    }
    renderStack();
    updateMeters();
  }

  // ---------- data layer: state assembly ----------
  async function fetchState() {
    if (!tokens.lm) {
      const e = /** @type {Error & {noToken?: boolean}} */ (new Error("Add your Lunch Money token in Settings to load transactions"));
      e.noToken = true;
      throw e;
    }
    const gen = fetchGen;
    const data = await assembleState(tokens.lm, rules);
    if (gen !== fetchGen) {
      // the token changed (or the wizard tore the deck down) while paginating:
      // committing would deal another account's transactions under the new token
      const e = /** @type {Error & {stale?: boolean}} */ (new Error("Stale fetch discarded"));
      e.stale = true;
      throw e;
    }
    categories = data.categories;
    catById = new Map(categories.map((c) => [c.id, c]));
    accounts = data.accounts;
    acctByKey = new Map(accounts.map((a) => [a.key, a]));
    allTxns = data.transactions;
    // Reference for how heavy a landing feels. Recomputed per fetch so it
    // tracks whatever is actually in the deck rather than a hardcoded amount.
    amountRef = referenceAmount(allTxns);
    lastFetchTs = Date.now();
    snapshotIds = new Set(allTxns.map((t) => t.id));
    loadState = "live";
    snapshotFetchedAt = null; // leaves snapshot mode; stale banner clears via updateConnUI
    stateError = null;
    noteConnOutcome("lm", null);
    if (data.truncated && !truncationNoted) {
      truncationNoted = true;
      note(`Sorting the oldest ${allTxns.length}${data.total ? ` of ${data.total}` : ""} uncategorized`);
    }
  }

  // ---------- data layer: pass 1 (rules already attached during assembly) ----------
  /** The OpenRouter credentials pass 1 runs with: the user's own key, else the
   *  shared free key (lib/freekey.js), else null = LM-only mode. Pass 2 (web
   *  checks) reads `tokens.or` directly — it costs money, so it never runs free. */
  function orCreds() {
    if (tokens.or) return { key: tokens.or, free: false };
    if (FREE_KEY && !freeTierDead) return { key: FREE_KEY, free: true };
    return null;
  }
  const onFreeTier = () => !tokens.or && !!FREE_KEY && !freeTierDead;

  /** Quota error (429 / 402) on the shared free key. The cap is per OpenRouter
   *  account, i.e. shared by everyone on this key, so the honest reaction is:
   *  keep whatever came back, back off (90s doubling, 15 min cap — a per-day
   *  bucket only clears at midnight UTC, and 15-minute probes are cheap), and
   *  show the one banner that actually fixes it: bring your own key.
   *  @param {ORError} e */
  function onFreeQuota(e) {
    freeQuotaHit = { daily: e.dailyQuota, at: Date.now() };
    const cap = 15 * 60_000;
    freeCooldownMs = e.dailyQuota ? cap : Math.min(cap, freeCooldownMs ? freeCooldownMs * 2 : 90_000);
    freeCooldownUntil = Date.now() + freeCooldownMs;
    clearTimeout(freeRetryTimer);
    freeRetryTimer = setTimeout(() => ensureClassified(), freeCooldownMs + 500);
    updateUpgradeBanner();
  }

  async function ensureClassified() {
    // AUTOMATIC classification is live-mode + online only (snapshot decks already
    // carry cached suggestions; hammering a dead network helps nobody). Explicit
    // user actions reach the network via refresh()/maybeWebCheck(true) instead.
    if (classifyRunning || loadState !== "live" || connOffline() || onboardingActive) return;
    const unsuggested = [...set, ...backlog].filter((t) => !t.suggestion);
    if (!unsuggested.length) { maybeWebCheck(); return; }
    const creds = orCreds();
    if (!creds) { updateWebBar(); return; } // LM-only mode: bar offers the Settings path
    if (creds.free && Date.now() < freeCooldownUntil) { updateWebBar(); return; } // backing off after a free-tier quota hit
    classifyRunning = true;
    renderStack();
    let nextFreeModel = false; // this free model refused; try the next one right away
    try {
      await classifyPass1(creds.key, categories, unsuggested, absorbPass1Slice,
        creds.free ? { model: FREE_MODELS[freeModelIdx] ?? FREE_MODELS[0], concurrency: FREE_CONCURRENCY } : {});
      noteConnOutcome("or", null);
      if (creds.free) freeCooldownMs = 0; // a full pass got through: the next 429 starts the backoff over
    } catch (e) {
      noteConnOutcome("or", e);
      // Free models each sit on one upstream pool: a 429 is as often "that
      // provider is saturated" as "our account quota"; a 404 is "not on the
      // guardrail allowlist / no endpoint". Either way the next model in the
      // list may well answer — the banner is for when none of them do.
      if (creds.free && e instanceof ORError && (e.quotaExhausted || e.status === 404)) {
        if (freeModelIdx < FREE_MODELS.length - 1) {
          freeModelIdx++;
          nextFreeModel = true;
        } else {
          freeModelIdx = 0; // start from the preferred model again after the cooldown
          onFreeQuota(e); // absorbed batches are already on the cards; the banner says why the rest wait
        }
      } else if (creds.free && e instanceof ORError && e.tokenInvalid) {
        freeTierDead = true; // the shared key was revoked/rotated: LM-only mode, no Settings nag
        updateWebBar();
      } else if (!routeORError(e) && !connOffline()) {
        note("Classifier hiccup — will retry later");
      }
    } finally {
      classifyRunning = false;
      // reached the end while the user emptied the deck -> celebrate now
      if (loadState === "live" && !set.length && !backlog.length && decisions > 0) celebrateInboxZero();
      renderStack(); updateMeters();
      maybeWebCheck();
    }
    if (nextFreeModel) ensureClassified(); // bounded by FREE_MODELS.length — each step advances the index
  }

  /** Rebuild every suggestion from the CURRENT rules + caches. Rule-sourced ones are
   *  cleared first: attachSuggestions only ever writes a suggestion, so a deleted
   *  rule's verdict would otherwise linger on cards it no longer matches. */
  async function reattachSuggestions() {
    for (const t of allTxns) if (t.suggestion?.source === "rule") t.suggestion = null;
    await attachSuggestions(allTxns, rules); // never throws: cache misses degrade to null
    reconcile();
    ensureClassified(); // cards left bare go back to the model
  }

  /** @param {Map<number, UISuggestion>} sugs */
  function absorbPass1Slice(sugs) {
    if (!sugs.size) return;
    for (const t of allTxns) {
      const s = sugs.get(t.id);
      if (s && !t.suggestion) t.suggestion = s; // rules/web/cache win over a late pass-1 result
    }
    reconcile();
    maybeWebCheck();
  }

  // ---------- data layer: pass 2 (lazy web-check per unique merchant) ----------
  /** @param {Txn} t @returns {string|null} */
  function webCandidateKey(t) {
    const s = t.suggestion;
    if (!s || s.source === "rule" || s.source === "web") return null; // pass 1 must have run; web/rule are final
    if (s.suggested_category_id != null && (s.confidence ?? 0) >= CONFIDENT_AT) return null;
    return merchantKeyOf(t.merchant);
  }

  /** Unsure merchants in the CURRENT SET not yet attempted this session. @returns {Map<string, string>} */
  function pendingWebKeys() {
    /** @type {Map<string, string>} */
    const m = new Map();
    for (const t of set) {
      const key = webCandidateKey(t);
      if (key && !webDone.has(key) && !webInflight.has(key)) m.set(key, t.merchant);
    }
    return m;
  }

  const webBudget = () => Math.max(0, WEB_AUTO_CAP + webExtraAllowance - webChecksUsed - webInflight.size);

  /** @param {boolean} [force]  true = explicit user action ("Web-check N more"):
   *  always try the network, even when the reducer says offline */
  function maybeWebCheck(force = false) {
    if (!tokens.or || loadState !== "live" || (!force && connOffline())) { updateWebBar(); return; }
    const pending = pendingWebKeys();
    let budget = webBudget();
    for (const [key, merchant] of pending) {
      if (budget <= 0) break;
      budget--;
      runWebCheck(key, merchant);
    }
    updateWebBar();
  }

  /** @param {string} key @param {string} merchant */
  async function runWebCheck(key, merchant) {
    if (!tokens.or) return;
    webInflight.add(key);
    updateWebCheckLine();
    try {
      const sug = await webCheck(tokens.or, merchant, categories);
      noteConnOutcome("or", null);
      webDone.add(key);
      webChecksUsed++; // counted on completion; webInflight covers the in-flight window
      for (const t of allTxns) {
        if (merchantKeyOf(t.merchant) !== key) continue;
        if (t.suggestion?.source === "rule") continue; // rules stay on top
        t.suggestion = sug;
      }
      reconcile();
    } catch (e) {
      noteConnOutcome("or", e);
      // Budget honesty vs cost safety: only a DEFINITIVE rejection (4xx excl 429)
      // burns the merchant for the session immediately. Transient failures
      // (rejection, parse garbage, 5xx, 429) get up to 2 session retries — a bad
      // cell moment must not eat the auto budget — then we stop hammering.
      const definitive = e instanceof ORError && e.status >= 400 && e.status < 500 && e.status !== 429;
      if (definitive) {
        webDone.add(key);
      } else {
        const fails = (webTransientFails.get(key) ?? 0) + 1;
        webTransientFails.set(key, fails);
        if (fails >= 3) webDone.add(key); // first try + 2 retries: done for the session
      }
      if (!routeORError(e) && !connOffline()) note(`Web check failed for ${merchant || "merchant"}`);
    } finally {
      webInflight.delete(key);
      maybeWebCheck(); // freed capacity dispatches remaining pending keys
      updateWebCheckLine();
    }
  }

  /** Floating bar above the actions: LM-only hint, or the explicit over-cap web-check button. */
  function updateWebBar() {
    const bar = els.webBar;
    if (loadState !== "live") { bar.hidden = true; return; } // snapshot mode: no web spend UI
    if (!tokens.or) {
      // Free tier: pass 1 happens, pass 2 doesn't — hint only when an unsure card
      // would actually get a web check, and not on top of the upgrade banner.
      const free = onFreeTier();
      const wantsAI = !!tokens.lm && !(free && freeQuotaHit)
        && [...set, ...backlog].some((t) => (free ? false : !t.suggestion) || webCandidateKey(t));
      if (wantsAI) {
        els.webBarBtn.textContent = free
          ? "Your own OpenRouter key adds web checks for unsure merchants"
          : "Add an OpenRouter key in Settings to enable AI suggestions";
        bar.dataset.mode = "hint";
        bar.hidden = false;
      } else bar.hidden = true;
      return;
    }
    const extra = Math.max(0, pendingWebKeys().size - webBudget());
    if (extra > 0) {
      els.webBarBtn.textContent = `Web-check ${extra} more merchant${extra === 1 ? "" : "s"} (~$${(extra * WEB_COST).toFixed(2)})`;
      bar.dataset.mode = "webcheck";
      bar.hidden = false;
    } else {
      bar.hidden = true;
    }
  }

  async function refresh() {
    // Allowed in "snapshot" mode — refresh IS the recovery path out of an offline
    // boot (else a snapshot session strands forever); only "none" has nothing to refresh.
    if (refreshing || loadState === "none" || sheetOpenNow() || onboardingActive) return;
    refreshing = true;
    try {
      await flush("refresh");
      await fetchState();
      reconcile(); // behind the top card only
      ensureClassified();
    } catch (e) {
      if (!isNoTokenErr(e) && !isStaleErr(e)) noteConnOutcome("lm", e);
      routeLMError(e);
      // unrouted network errors: silent, next refresh will retry (recovery probe)
    } finally {
      refreshing = false;
    }
  }

  // ---------- connectivity reducer (fetch outcomes are truth; events are probes) ----------
  /** Local pre-fetch error (missing token): never a network outcome. @param {unknown} e */
  const isNoTokenErr = (e) => e instanceof Error && /** @type {Error & {noToken?: boolean}} */ (e).noToken === true;
  /** A fetch that outlived its token (fetchGen moved): local, silent, never a network outcome. @param {unknown} e */
  const isStaleErr = (e) => e instanceof Error && /** @type {Error & {stale?: boolean}} */ (e).stale === true;

  /** The settled verdict the UI and gates read. Two consecutive LM-origin failures
   *  OR the browser flatly saying so — a single blip must not paint the app offline. */
  const connOffline = () => navigator.onLine === false || lmFailStreak >= 2;

  /** Feed ONE fetch outcome into the reducer (only LM/OR API calls — never SW asset
   *  loads). A typed error carrying a real HTTP status means the server was REACHABLE
   *  (captive-portal 511 included) ⇒ counts as online evidence; only fetch rejection
   *  (TypeError) and parse garbage (SyntaxError / malformed-shape Errors — captive
   *  portals that 200 garbage) are offline candidates, and only LM-origin ones count
   *  toward the threshold: an OR-only outage must not paint the app offline.
   *  @param {"lm"|"or"} origin @param {unknown} err  null = success */
  function noteConnOutcome(origin, err) {
    if (err == null || err instanceof LMError || err instanceof ORError) lmFailStreak = 0;
    else if (origin === "lm") lmFailStreak++;
    connSettle();
  }

  /** Re-evaluate the verdict; on the offline→online transition cancel the paused
   *  backoff and run ONE debounced flush+refresh. Also the landing point for the
   *  event probes (online/offline/pageshow) — they only ever hint, never decide. */
  function connSettle() {
    const off = connOffline();
    if (wasOffline && !off) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      backoffIdx = 0;
      scheduleOnlineResync();
    }
    wasOffline = off;
    updateConnUI();
  }

  /** Debounced: a success outcome and an `online` event landing together must yield
   *  ONE resync (iOS fires `online` before DNS actually works — failures stay quiet). */
  function scheduleOnlineResync() {
    if (onlineResyncTimer) return;
    onlineResyncTimer = setTimeout(() => { onlineResyncTimer = null; runOnlineResync(); }, 400);
  }
  async function runOnlineResync() {
    try { await flush("online"); } catch { /* flush routes/backs off internally */ }
    if (onboardingActive) {
      pendingSheetResync = true; // re-armed when the wizard closes
      if ((obStep === "tune" || obStep === "done") && loadState !== "live") void obLoad({}); // "loads when you reconnect"
      const w = obFieldOf();
      if (w && obField[w].status === "netfail" && obField[w].value) void obValidate(w); // "checks it when you reconnect"
      return;
    }
    if (sheetOpenNow()) { pendingSheetResync = true; return; } // re-armed on sheet close
    refresh(); // quiet failure degrades back into the reducer/backoff
  }

  // ---------- apply queue ----------
  /** @param {QueueItem} it @returns {{id: number, category_id: number}} */
  const itemPayload = (it) => ({ id: it.id, category_id: it.category_id });

  /** A queued make_rule becomes a local rule once its decision actually applied.
   * @param {QueueItem[]} chunk @param {number[]} appliedIds */
  /** Rules created during boot replay predate the categories fetch; fill names in. */
  function backfillRuleNames() {
    let changed = false;
    for (const r of rules) {
      if (!r.category_name && catById.has(r.category_id)) {
        r.category_name = catById.get(r.category_id)?.name ?? "";
        changed = true;
      }
    }
    if (changed) { try { rulesSave(rules); } catch { /* cosmetic only */ } }
  }

  /** @param {import("./lib/store.js").QueueItem[]} chunk @param {number[]} appliedIds */
  function absorbMakeRules(chunk, appliedIds) {
    const applied = new Set(appliedIds);
    for (const it of chunk) {
      if (!it.make_rule || !applied.has(it.id)) continue;
      try {
        const full = ruleAdd({
          pattern: it.make_rule.pattern,
          match_type: it.make_rule.match_type,
          category_id: it.category_id,
          category_name: catById.get(it.category_id)?.name ?? "",
        });
        rules.push(full);
      } catch {
        storageFailed(); // the decision itself already applied; only the rule is lost
      }
    }
  }

  /** ONE membership recheck for the whole interactive flush (uncategorized window
   *  via getState + per-id getTransaction fallback; absence alone NEVER discards a
   *  decision — same rules lib/lm.js applies). Kept SEPARATE from the PUT stage so
   *  poison bisect can re-PUT already-validated items with recheck:"none" instead
   *  of re-paging the window per half. Cost: getState also fetches categories/
   *  accounts we discard — same accepted trade as lib/sync.js's replay recheck.
   *  @param {string} lmToken @param {QueueItem[]} batch
   *  @returns {Promise<{sendable: QueueItem[], skipped: number[]}>} */
  async function membershipRecheck(lmToken, batch) {
    const win = await getState(lmToken, fetchWindow());
    const open = new Set(win.transactions.map((t) => t.id));
    /** @type {QueueItem[]} */
    const sendable = [];
    /** @type {number[]} */
    const skipped = [];
    /** @type {QueueItem[]} */
    const misses = [];
    for (const it of batch) (open.has(it.id) ? sendable : misses).push(it);
    for (let i = 0; i < misses.length; i += 10) {
      const slice = misses.slice(i, i + 10);
      const current = await Promise.all(slice.map((it) =>
        getTransaction(lmToken, it.id).catch((e) => {
          if (e instanceof LMError && e.status === 404) return null; // deleted / re-pointed budget
          throw e;
        })));
      slice.forEach((it, j) => {
        const t = current[j];
        if (t && t.category_id === null) sendable.push(it); // merely outside the paged window
        else skipped.push(it.id); // categorized elsewhere, or gone
      });
    }
    return { sendable, skipped };
  }

  /** PUT one already-validated chunk (recheck:"none" — stage 1 vouched for every
   *  item), isolating poison request bodies by bisection: a 4xx excluding
   *  401/408/429 (lib/sync.js isPoisonStatus) splits the chunk until the failing
   *  item(s) stand alone. An isolated failure counts one SESSION-ONLY attempt; at
   *  STUCK_AFTER_ATTEMPTS the item is parked (flushable:false + stuck reason) and
   *  surfaced by updateStuckUI. 401 and transients (408/429/5xx/rejection) rethrow
   *  into the caller's ordinary routing/backoff — no attempt counted.
   *  @param {string} lmToken @param {QueueItem[]} chunk
   *  @returns {Promise<{applied: number[], parked: number[]}>} */
  async function putChunkIsolating(lmToken, chunk) {
    try {
      await applyCategories(lmToken, chunk.map(itemPayload), { recheck: "none" });
      return { applied: chunk.map((it) => it.id), parked: [] };
    } catch (e) {
      if (!(e instanceof LMError) || !isPoisonStatus(e.status)) throw e;
      const lone = chunk.length === 1 ? chunk[0] : undefined;
      if (lone) {
        const k = keyOf(lone);
        const attempts = (poisonAttempts.get(k) ?? 0) + 1;
        poisonAttempts.set(k, attempts);
        if (attempts < STUCK_AFTER_ATTEMPTS) return { applied: [], parked: [] }; // retried next flush
        const reason = `HTTP ${e.status}`;
        try {
          queue = await queueMutate((q) => {
            const f = q.find((x) => x.id === lone.id && x.ts === lone.ts);
            if (f) { f.flushable = false; f.stuck = reason; }
          });
        } catch { storageFailed(); }
        return { applied: [], parked: [lone.id] };
      }
      const mid = Math.ceil(chunk.length / 2);
      const a = await putChunkIsolating(lmToken, chunk.slice(0, mid));
      const b = await putChunkIsolating(lmToken, chunk.slice(mid));
      return { applied: [...a.applied, ...b.applied], parked: [...a.parked, ...b.parked] };
    }
  }

  /** @param {string} reason */
  async function flush(reason) {
    if (!tokens.lm) return;
    if (onboardingActive) return; // the wizard owns the network; only replayIfNeeded runs behind it
    if (bootReplaying) return; // replayQueue owns the queue right now; later triggers cover the rest
    if (reason === "hidden") { flushHidden(tokens.lm); return; }
    const lmToken = tokens.lm;
    // reconnects often drain via the 5-min probe, not the online event — the
    // "Synced" reassurance must fire for both
    const cameFromOffline = connOffline();
    const selected = queue.filter((it) => it.flushable && !it.stuck && !inflight.has(keyOf(it)));
    if (!selected.length) return;
    const prevSent = new Set(selected.filter((it) => it.sent).map((it) => it.id));
    const wantKeys = new Set(selected.map(keyOf));
    // inflight BEFORE the persistence attempt: a storage failure re-enters flush via
    // storageFailed(), and these keys are what makes that re-entry a no-op.
    for (const k of wantKeys) inflight.add(k);
    let batch = selected;
    try {
      // persist `sent` (queueMutate: slow-path lock + fresh-read merge) BEFORE the
      // request may reach Lunch Money; storage failure degrades durability only —
      // the flush itself proceeds (that IS the storage-degraded compensation).
      queue = await queueMutate((q) => { for (const it of q) if (wantKeys.has(keyOf(it))) it.sent = true; });
      batch = queue.filter((it) => wantKeys.has(keyOf(it)));
      for (const k of wantKeys) { // collapse may have dropped a duplicate-id loser
        if (!batch.some((it) => keyOf(it) === k)) inflight.delete(k);
      }
    } catch { storageFailed(); }

    // stage 1: ONE membership recheck for the whole flush (network, lock-free)
    /** @type {{sendable: QueueItem[], skipped: number[]}} */
    let checked;
    try {
      checked = await membershipRecheck(lmToken, batch);
    } catch (e) {
      for (const k of wantKeys) inflight.delete(k);
      noteConnOutcome("lm", e);
      // Routed errors (dead/missing token) keep the queue in localStorage but skip
      // the hot retry loop — retrying can't succeed until the user fixes the cause.
      if (routeLMError(e)) return;
      scheduleRetry();
      return;
    }
    if (checked.skipped.length) {
      // already categorized elsewhere / deleted: drop + prune, nothing to PUT.
      // Removal is by (id,ts) KEY, batch items only — a superseding same-id decision
      // another tab queued meanwhile survives for its own recheck verdict.
      const done = new Set(checked.skipped);
      const dropKeys = new Set(batch.filter((it) => done.has(it.id)).map(keyOf));
      try { queue = await queueMutate((q) => q.filter((it) => !dropKeys.has(keyOf(it)))); }
      catch { storageFailed(); }
      for (const it of batch) if (done.has(it.id)) inflight.delete(keyOf(it));
      snapshotPrune(checked.skipped).catch(() => { /* best-effort; redone next flush */ });
    }

    // stage 2: PUT in APPLY_CHUNK chunks (recheck:"none" — stage 1 validated),
    // poison-isolated; persistence per chunk via queueMutate, lock never across the PUT
    let appliedCount = 0;
    try {
      for (let i = 0; i < checked.sendable.length; i += APPLY_CHUNK) {
        const chunk = checked.sendable.slice(i, i + APPLY_CHUNK);
        const res = await putChunkIsolating(lmToken, chunk);
        const applied = new Set(res.applied);
        absorbMakeRules(chunk, res.applied);
        // remove by (id,ts) key — never delete a newer same-id entry we didn't send
        const appliedKeys = new Set(chunk.filter((it) => applied.has(it.id)).map(keyOf));
        try { queue = await queueMutate((q) => q.filter((it) => !appliedKeys.has(keyOf(it)))); }
        catch { storageFailed(); }
        for (const it of chunk) inflight.delete(keyOf(it));
        if (res.applied.length) snapshotPrune(res.applied).catch(() => { /* best-effort */ });
        appliedCount += res.applied.length;
      }
      noteConnOutcome("lm", null);
      backoffIdx = 0;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if ((reason === "online" || cameFromOffline) && appliedCount) note(`Synced ${appliedCount} ✓`);
      if (checked.skipped.length) absorbSkipped(checked.skipped, prevSent);
      updateConnUI();
    } catch (e) {
      for (const it of checked.sendable) inflight.delete(keyOf(it)); // clear in-flight on failure
      noteConnOutcome("lm", e);
      if (routeLMError(e)) return;
      scheduleRetry();
    }
  }

  /** Pagehide/hidden flush: NO network recheck, so eligibility is restricted to
   *  items decided against THIS session's snapshot AND only while that snapshot is
   *  fresh (<10 min — store.keepaliveEligible's freshness bound: a sheet left open
   *  all afternoon ages out and defers to the recheck-based replay), validated
   *  against it in memory. ONE keepalive PUT, ≤20 items. Older items stay queued
   *  for the replay on next open — an unvalidated stale PUT could clobber category
   *  work done elsewhere since. Snapshot-mode decisions carry snapshotTs:null, so
   *  this path is structurally unreachable for them.
   *  Sent-marking stays a SYNCHRONOUS unlocked fresh-read-merge (documented
   *  exception to the queueMutate rule): async lock callbacks may never run during
   *  pagehide teardown.
   *  @param {string} lmToken */
  function flushHidden(lmToken) {
    const eligibleKeys = new Set(
      keepaliveEligible(queue, lastFetchTs)
        .filter((it) => !inflight.has(keyOf(it)) && snapshotIds.has(it.id))
        .slice(0, KEEPALIVE_MAX_ITEMS)
        .map(keyOf),
    );
    if (!eligibleKeys.size) return;
    queueWriteSync((q) => { for (const it of q) if (eligibleKeys.has(keyOf(it))) it.sent = true; });
    const batch = queue.filter((it) => eligibleKeys.has(keyOf(it)));
    if (!batch.length) return;
    for (const it of batch) inflight.add(keyOf(it));
    applyCategories(lmToken, batch.map(itemPayload), { recheck: "none", keepalive: true })
      .then((res) => {
        const done = new Set([...res.applied, ...res.skipped]);
        absorbMakeRules(batch, res.applied);
        // remove by (id,ts) key — a newer same-id entry from another tab survives
        const doneKeys = new Set(batch.filter((it) => done.has(it.id)).map(keyOf));
        queueWriteSync((q2) => {
          for (let i = q2.length - 1; i >= 0; i--) {
            const it = q2[i];
            if (it && doneKeys.has(keyOf(it))) q2.splice(i, 1);
          }
        });
        for (const it of batch) inflight.delete(keyOf(it));
        snapshotPrune([...done]).catch(() => { /* teardown best-effort; redone next flush */ });
        updateConnUI();
      })
      .catch(() => {
        // page may already be gone; replay on next open covers it
        for (const it of batch) inflight.delete(keyOf(it));
      });
  }

  /** @param {number[]} ids @param {Set<number>} prevSent */
  function absorbSkipped(ids, prevSent) {
    let dropped = 0;
    let announce = 0;
    for (const id of ids) {
      if (!prevSent.has(id)) announce++; // suppress ids this client already sent once
      const iSet = set.findIndex((t, idx) => idx > 0 && t.id === id); // never the top card
      if (iSet > 0) { set.splice(iSet, 1); setDone++; dropped++; }
      else {
        const iB = backlog.findIndex((t) => t.id === id);
        if (iB >= 0) backlog.splice(iB, 1);
      }
    }
    if (dropped) { renderStack(); updateMeters(); }
    if (announce) note(`${announce} already done ✓`);
  }

  function scheduleRetry() {
    if (connOffline()) {
      // Offline: pause the backoff timer entirely (the online transition restarts
      // syncing) and suppress the toast — a nag per failed retry says nothing the
      // chip doesn't. The 5-min refresh interval and onVisible KEEP RUNNING as the
      // recovery probes; recovery never hinges on the unreliable `online` event.
      return;
    }
    const delay = BACKOFF[Math.min(backoffIdx, BACKOFF.length - 1)] ?? 60000;
    backoffIdx++;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushTimer = null; flush("retry"); }, delay);
    note("Sync failed — will retry");
  }

  function maybeThresholdFlush() {
    if (queue.filter((it) => it.flushable && !it.stuck && !inflight.has(keyOf(it))).length >= FLUSH_AT) flush("threshold");
  }

  // ---------- decisions ----------
  /** @param {Txn} txn @param {number} categoryId @param {boolean} viaPicker */
  function decideApply(txn, categoryId, viaPicker) {
    finalizeUndo(); // previous item becomes flushable first
    // snapshotTs: null in snapshot mode (lastFetchTs stays null there) — routes the
    // decision through the recheck-based replay only, never the keepalive flush.
    /** @type {QueueItem} */
    const item = { id: txn.id, category_id: categoryId, ts: Date.now(), snapshotTs: lastFetchTs, flushable: false, sent: false };
    queueWriteSync((q) => { q.push(item); }); // SYNCHRONOUS, before any animation
    updateConnUI(); // offline chip queue count
    afterDecision({ kind: "apply", txn, item, viaPicker });
  }

  /** @param {Txn} txn */
  function decidePark(txn) {
    finalizeUndo();
    later.push(txn);
    // pointer synchronously in localStorage, body async in IndexedDB (lib/store.js)
    try { laterAdd(txn); } catch { storageFailed(); }
    updateLaterChip();
    afterDecision({ kind: "park", txn });
  }

  /** @param {UndoState} u */
  function afterDecision(u) {
    backoffIdx = 0; // user action resets backoff
    decisions++;
    streak++;
    startUndo(u);
    updateStreakUI(true);
    haptic(12);
    fx()?.swipe(u.kind === "park" ? "park" : u.viaPicker ? "pick" : "accept");
    if (decisions % 10 === 0) { confetti(90); haptic([14, 50, 14]); fx()?.streak(); }
  }

  /** Remove the DECIDED card from data + move meters; call AFTER the queue push.
   *  Removes by identity, not position — undo/unpark can mutate the deck front mid-drag.
   *  @param {Txn} txn */
  function advance(txn) {
    const i = set.findIndex((t) => t.id === txn.id);
    if (i >= 0) set.splice(i, 1);
    setDone++;
    if (!set.length) {
      if (backlog.length) {
        celebrateSet();
        dealSet();
        dealAnim = true;
      } else if (loadState !== "none" && !classifyRunning) { // snapshot decks celebrate too (hedged copy)
        celebrateInboxZero();
      }
    }
    renderStack();
    updateMeters();
    ensureClassified();
  }

  // ---------- undo (event-driven flushability) ----------
  /** @param {UndoState} u */
  function startUndo(u) {
    undoState = u;
    u.startedAt = Date.now();
    u.pausedRemaining = null;
    u.timer = setTimeout(finalizeUndo, UNDO_MS);
    const cat = u.kind === "apply" && u.item ? catById.get(u.item.category_id) : null;
    const catBits = cat ? splitEmoji(cat.name) : null;
    els.undoText.textContent = u.kind === "park"
      ? `💤 ${u.txn.merchant || "card"} parked for later`
      : `${catBits?.emoji || "🏷"} ${u.txn.merchant || "card"} → ${catBits?.text || "?"}`;
    const merchant = (u.txn.merchant || "").trim();
    if (u.kind === "apply" && u.viaPicker && merchant) {
      els.ruleChip.hidden = false;
      els.ruleChip.disabled = false;
      els.ruleChip.classList.remove("saved");
      els.ruleChip.textContent = `Always: ${merchant} → ${catBits?.text || "?"}`;
    } else {
      els.ruleChip.hidden = true;
    }
    els.undoToast.hidden = false;
  }

  function hideUndoToast() { els.undoToast.hidden = true; }

  /** The sheet covers the toast; freezing the clock keeps "5s to undo" honest. */
  function pauseUndoClock() {
    if (!undoState || undoState.pausedRemaining != null) return;
    clearTimeout(undoState.timer);
    undoState.pausedRemaining = Math.max(800, UNDO_MS - (Date.now() - (undoState.startedAt ?? Date.now())));
  }
  function resumeUndoClock() {
    if (!undoState || undoState.pausedRemaining == null) return;
    undoState.startedAt = Date.now() - (UNDO_MS - undoState.pausedRemaining);
    undoState.timer = setTimeout(finalizeUndo, undoState.pausedRemaining);
    undoState.pausedRemaining = null;
  }

  /** Natural dismissal: the item becomes flushable NOW (event-driven, no parallel timers). */
  function finalizeUndo() {
    if (!undoState) return;
    clearTimeout(undoState.timer);
    const u = undoState;
    undoState = null;
    hideUndoToast();
    if (u.kind === "apply" && u.item) {
      // by (id,ts) on the fresh array — u.item may be a detached copy by now
      const { id, ts } = u.item;
      queueWriteSync((q) => {
        const f = q.find((it) => it.id === id && it.ts === ts);
        if (f) f.flushable = true;
      });
      maybeThresholdFlush();
    }
  }

  /** Hidden path: clear undo UI synchronously; item stays NON-flushable so the
   *  keepalive flush skips it (replay covers it if the page dies). */
  function clearUndoForHidden() {
    if (!undoState) return;
    clearTimeout(undoState.timer);
    const u = undoState;
    undoState = null;
    hideUndoToast();
    if (u.kind === "apply" && u.item) pendingFinalize = u.item;
  }

  /** Deck-front mutations during an active drag desync everything — abort the drag first. */
  function abortDrag() {
    if (!dragCtx) return;
    const c = dragCtx;
    endDrag(c);
    springBack(c.el);
  }

  function doUndo() {
    if (!undoState) return;
    abortDrag();
    clearTimeout(undoState.timer);
    const u = undoState;
    undoState = null;
    hideUndoToast();
    if (u.kind === "apply") {
      const item = u.item;
      if (item) {
        queueWriteSync((q) => {
          const i = q.findIndex((it) => it.id === item.id && it.ts === item.ts);
          if (i >= 0) q.splice(i, 1);
        });
      }
      updateConnUI(); // offline chip queue count
    } else {
      later = later.filter((t) => t.id !== u.txn.id);
      try { laterRemove(u.txn.id); } catch { /* pointer cleanup is best-effort */ }
      updateLaterChip();
    }
    set.unshift(u.txn); // reinsert at deck front
    inboxCelebrated = false;
    setDone = Math.max(0, setDone - 1);
    decisions = Math.max(0, decisions - 1);
    streak = Math.max(0, streak - 1);
    hideCelebrate(); // undo after a celebration dismisses it
    renderStack();
    updateMeters();
    updateStreakUI(false);
    haptic(8);
  }

  // ---------- card rendering ----------
  /** @param {Txn} t @returns {string} */
  const cardSig = (t) => {
    const s = t.suggestion;
    return s ? `${s.suggested_category_id}:${s.confidence}:${s.source}` : "none";
  };

  /** @param {Txn} t @returns {HTMLElement} */
  function buildCard(t) {
    const s = t.suggestion;
    const category = s && s.suggested_category_id != null ? catById.get(s.suggested_category_id) ?? null : null;
    const el = document.createElement("div");
    el.className = `card${isConfident(t) ? "" : " unsure"}`;
    el.dataset.id = String(t.id);
    el.dataset.sig = cardSig(t);
    el.innerHTML = cardHTML(t, { category, account: acctOf(t), confidentAt: CONFIDENT_AT });
    return el;
  }

  /** @param {string} cls @param {string} html @returns {HTMLElement} */
  function specialCard(cls, html) {
    const el = document.createElement("div");
    el.className = `card c0 ${cls}`;
    el.innerHTML = html;
    return el;
  }

  function renderStack() {
    const stack = els.stack;
    /** @type {Map<string, HTMLElement>} */
    const kept = new Map();
    for (const el of [...stack.children]) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.classList.contains("flying")) continue;
      if (el.dataset.id) kept.set(el.dataset.id, el); else el.remove(); // drop special cards
    }
    const want = set.slice(0, 3);
    for (const [id, el] of kept) {
      if (!want.some((t) => String(t.id) === id)) { el.remove(); kept.delete(id); }
    }

    if (!want.length) {
      for (const el of kept.values()) el.remove();
      if (loadState === "none" && !stateError) {
        stack.appendChild(specialCard("skeleton", `
          <div class="skel-emoji">🃏</div>
          <div class="skel-text">shuffling the deck…</div>
          <div class="skel-bar"></div>`));
      } else if (stateError) {
        const msgHtml = esc(stateError.message || "network error");
        stack.appendChild(specialCard("empty-card", `
          <div class="empty-emoji">📡</div>
          <div class="empty-title">Couldn't load</div>
          <div class="empty-sub">${msgHtml}</div>
          <button class="retry" type="button">Try again</button>`));
      } else if (classifyRunning) {
        stack.appendChild(specialCard("skeleton", `
          <div class="skel-emoji">✨</div>
          <div class="skel-text">warming up cards…</div>
          <div class="skel-bar"></div>`));
      } else {
        // snapshot mode can't know the server is empty — hedge instead of "sorted"
        const subHtml = later.length ? esc(`${later.length} parked for later`)
          : loadState === "snapshot" && queue.length ? esc(`All local cards sorted — ${queue.length} waiting to sync`)
          : "Nothing left to sort 🎉";
        stack.appendChild(specialCard("empty-card", `
          <div class="empty-emoji">🏆</div>
          <div class="empty-title">Inbox zero</div>
          <div class="empty-sub">${subHtml}</div>`));
      }
      lastTopId = ""; // deck emptied: whatever arrives next is a fresh landing
      updateActionButtons();
      return;
    }

    const dealing = dealAnim && !reducedMotion;
    dealAnim = false;
    /** @type {"deal"|"land"|null} which landing to sync the dust to, if any */
    let landed = null;
    want.forEach((t, i) => {
      let el = kept.get(String(t.id)) ?? null;
      // Refresh card content when a suggestion arrived. Peek cards always; the TOP
      // card only while idle (no drag, no picker, not lifted) — a lazy web-check
      // result must be able to land on the card the user is looking at.
      const topIdle = i === 0 && !dragCtx && !pickerCtx &&
        !!el && !el.classList.contains("lifted") && !el.classList.contains("flying");
      if (el && el.dataset.sig !== cardSig(t) && (i > 0 || topIdle)) { el.remove(); el = null; }
      if (!el) { el = buildCard(t); stack.appendChild(el); }
      el.classList.remove("c0", "c1", "c2");
      el.classList.add(`c${i}`);
      if (dealing) {
        const dealEl = el;
        dealEl.classList.add("dealing", `deal-${i}`);
        dealEl.addEventListener("animationend", () => dealEl.classList.remove("dealing", `deal-${i}`), { once: true });
        landed = "deal";
      }
      if (i === 0) {
        // A different transaction reached the front: hop it into place so every
        // swipe ends with a landing, not just a set load. Same id means the card
        // was only rebuilt (a suggestion arrived) — leave it alone.
        if (!dealing && String(t.id) !== lastTopId && !reducedMotion) {
          const landEl = el;
          landEl.classList.add("landing");
          landEl.addEventListener("animationend", () => landEl.classList.remove("landing"), { once: true });
          setTimeout(() => landEl.classList.remove("landing"), 600);
          landed = "land";
        }
        if (!el.dataset.dragBound) { attachDrag(el); el.dataset.dragBound = "1"; }
      }
    });
    lastTopId = String(want[0]?.id ?? "");
    // A deal drops the whole set, so it lands as heavily as its biggest card.
    const hefted = landed === "deal"
      ? Math.max(...want.map((t) => heft(t.amount, amountRef)))
      : heft(want[0]?.amount, amountRef);
    if (landed) {
      dust.blast(els.stack, landed, hefted);
      fx()?.thud(hefted);
      // same threshold as the visual quake — sound and shake are one event
      if (hefted >= QUAKE_AT) fx()?.rumble((hefted - QUAKE_AT) / (1 - QUAKE_AT));
    }
    updateActionButtons();
  }

  /* ---------- impact dust ----------
     Lives in lib/dust.js: sprite sheet baked at build time, three quality
     tiers, self-demoting when a landing blows its frame budget. */
  const dust = createDust({ reducedMotion, haptic });
  dust.preload();
  matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => dust.onThemeChange());

  /* ---------- audio ----------
     lib/sfx.js synthesizes the effects, lib/music.js runs the chiptune player.
     Strictly opt-in (both toggles default off) and additive-only: nothing in
     here may break a swipe — mirrors the haptic() contract. */
  /** @type {import("./lib/sfx.js").AudioBus|null} */
  let audioBus = null;
  /** @type {ReturnType<typeof createSfx>|null} */
  let sfxKit = null;
  /** @type {ReturnType<typeof createMusic>|null} */
  let music = null;
  function ensureAudio() {
    if (audioBus) return;
    try {
      audioBus = createAudioBus();
      sfxKit = createSfx(audioBus);
      music = createMusic({
        bus: audioBus,
        onTrackChange: renderMusicPop,
        anyAudioOn: () => audioPrefs.music || audioPrefs.sfx,
      });
    } catch { audioBus = null; /* additive only */ }
  }
  /** SFX facade — null unless the toggle is on, so call sites stay one-liners. */
  const fx = () => (audioPrefs.sfx ? sfxKit : null);
  /** @param {{title: string, author: string}|null} now */
  function renderMusicPop(now) {
    els.musicTitle.textContent = now ? now.title : "—";
    els.musicAuthor.textContent = now ? `by ${now.author}` : "";
  }
  function updateMusicChip() {
    els.musicChip.hidden = !audioPrefs.music;
    if (!audioPrefs.music && els.musicPop.matches(":popover-open")) els.musicPop.hidePopover();
  }
  // A closure, not inline: tsc pins `music` to its null initializer at this
  // point in the flow; inside a function it uses the declared type.
  const bootAudio = () => {
    if (!audioPrefs.music && !audioPrefs.sfx) return;
    ensureAudio();
    music?.prewarm(audioPrefs.music); // engine + first track warm before any gesture
  };
  bootAudio();
  updateMusicChip();
  // Autoplay policy: the context unlocks on the first natural interaction.
  // Consumed-once listeners are fine — later toggle clicks are gestures too.
  const audioUnlock = () => {
    if (!audioBus) return;
    if (audioPrefs.music) music?.gesture();
    else if (audioPrefs.sfx) void audioBus.ctx.resume().catch(() => { /* additive only */ });
  };
  window.addEventListener("pointerdown", audioUnlock, { once: true });
  window.addEventListener("keydown", audioUnlock, { once: true });

  function updateActionButtons() {
    const top = set[0] ?? null;
    const usable = !!top;
    els.btnAccept.disabled = !usable;
    els.btnPark.disabled = !usable;
    els.btnPick.disabled = !usable;
    const span = els.btnAccept.querySelector("span");
    if (span) span.textContent = top && !isConfident(top) ? "Choose" : "Sort it";
  }

  function updateMeters() {
    const total = setDone + set.length;
    const remaining = set.length + backlog.length;
    const pct = total ? Math.round((setDone / total) * 100) : (loadState !== "none" ? 100 : 0);
    if (pct !== lastPct) {
      lastPct = pct;
      els.progressFill.style.width = pct + "%";
      els.progressFill.classList.remove("bump");
      void els.progressFill.offsetWidth;
      els.progressFill.classList.add("bump");
      const bar = els.progressFill.parentElement;
      if (bar) {
        bar.setAttribute("aria-valuenow", String(pct));
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", "100");
        bar.setAttribute("aria-valuetext", `${setDone} of ${total} this set`);
      }
    }
    els.meter.textContent = loadState === "none"
      ? "loading…"
      : remaining
        ? `${setDone}/${total} this set · ${remaining} to go`
        : later.length ? `all sorted · ${later.length} in Later` : "all sorted";
  }

  /** @param {boolean} pulse */
  function updateStreakUI(pulse) {
    els.streakN.textContent = String(streak);
    els.streak.hidden = streak < 2;
    if (pulse && streak >= 2) {
      els.streak.classList.remove("pulse");
      void els.streak.offsetWidth;
      els.streak.classList.add("pulse");
    }
  }

  function updateLaterChip() {
    els.laterN.textContent = String(later.length);
    els.laterChip.hidden = !later.length;
  }

  // ---------- gestures ----------
  const topEl = () => {
    const el = els.stack.querySelector(".card.c0:not(.flying)");
    return el instanceof HTMLElement ? el : null;
  };

  /** @param {HTMLElement} el */
  function washFor(el) {
    /** @param {string} sel @returns {HTMLElement|null} */
    const q = (sel) => {
      const n = el.querySelector(sel);
      return n instanceof HTMLElement ? n : null;
    };
    return { wash: q(".wash"), right: q(".stamp-right"), left: q(".stamp-left") };
  }
  /** @param {HTMLElement} el @param {number} dx @param {number} threshold */
  function setDragVisual(el, dx, threshold) {
    const w = washFor(el);
    if (!w.wash || !w.right || !w.left) return;
    const p = clamp(Math.abs(dx) / threshold, 0, 1);
    const stampP = clamp((p - 0.55) / 0.45, 0, 1);
    if (dx > 0) {
      w.wash.style.background = "rgba(52, 211, 153, 1)";
      w.wash.style.opacity = String(p * 0.4);
      w.right.style.opacity = String(stampP);
      w.left.style.opacity = "0";
    } else if (dx < 0) {
      w.wash.style.background = "rgba(96, 125, 139, 1)"; // slate: reads as "shelve", not "nothing"
      w.wash.style.opacity = String(p * 0.5);
      w.left.style.opacity = String(stampP);
      w.right.style.opacity = "0";
    } else {
      w.wash.style.opacity = "0";
      w.right.style.opacity = "0";
      w.left.style.opacity = "0";
    }
  }
  /** @param {HTMLElement} el */
  function clearDragVisual(el) { setDragVisual(el, 0, 1); }

  /** @param {HTMLElement} el */
  function attachDrag(el) {
    el.addEventListener("pointerdown", onPointerDown);
  }

  /** @param {PointerEvent} e */
  function onPointerDown(e) {
    const el = e.currentTarget;
    if (!(el instanceof HTMLElement)) return;
    if (dragCtx || pickerCtx) return; // track ONE pointer, ignore others
    if (!el.classList.contains("c0") || el.classList.contains("flying") || el.classList.contains("lifted")) return;
    if (!e.isPrimary || e.button > 0) return;
    if (e.target instanceof Element && e.target.closest("button")) return; // cat chip / details live off the drag path
    const txn = set[0];
    if (!txn || String(txn.id) !== el.dataset.id) return;
    // A running animation outranks the inline transform we set while dragging,
    // so grabbing a card mid-landing must cancel the landing first.
    el.classList.remove("landing");
    dragCtx = {
      el, txn, id: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      width: el.offsetWidth || 320,
      big: isBig(txn),
      tilt: isConfident(txn), // NO tilt on unsure cards
      hist: [], dx: 0, dy: 0,
    };
    el.setPointerCapture(e.pointerId);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
  }

  /** @param {DragCtx} ctx */
  const dragThreshold = (ctx) => ctx.width * 0.4 * (ctx.big ? 1.5 : 1);

  /** @param {PointerEvent} e */
  function onPointerMove(e) {
    const ctx = dragCtx;
    if (!ctx || e.pointerId !== ctx.id) return;
    ctx.dx = e.clientX - ctx.startX;
    ctx.dy = e.clientY - ctx.startY;
    const now = performance.now();
    ctx.hist.push({ t: now, x: e.clientX });
    while (ctx.hist.length > 2 && now - (ctx.hist[0]?.t ?? now) > 110) ctx.hist.shift();
    const rot = ctx.tilt ? clamp(ctx.dx * 0.055, -14, 14) : 0;
    ctx.el.style.transform = `translate(${ctx.dx}px, ${ctx.dy * 0.15}px) rotate(${rot}deg)`;
    setDragVisual(ctx.el, ctx.dx, dragThreshold(ctx));
  }

  /** @param {DragCtx} ctx */
  function endDrag(ctx) {
    ctx.el.removeEventListener("pointermove", onPointerMove);
    ctx.el.removeEventListener("pointerup", onPointerUp);
    ctx.el.removeEventListener("pointercancel", onPointerCancel);
    try { ctx.el.releasePointerCapture(ctx.id); } catch { /* already released */ }
    dragCtx = null;
    maybeShowUpdateToast(); // a suppressed "New version" toast may surface now
  }

  /** @param {PointerEvent} e */
  function onPointerUp(e) {
    const ctx = dragCtx;
    if (!ctx || e.pointerId !== ctx.id) return;
    endDrag(ctx);
    let vx = 0;
    const a = ctx.hist[0];
    const b = ctx.hist[ctx.hist.length - 1];
    if (a && b && b.t > a.t) vx = (b.x - a.x) / (b.t - a.t);
    const threshold = dragThreshold(ctx);
    const flickV = 0.65 * (ctx.big ? 1.5 : 1);
    const commit = Math.abs(ctx.dx) >= threshold ||
      (Math.abs(vx) >= flickV && Math.sign(vx) === Math.sign(ctx.dx) && Math.abs(ctx.dx) > 24);
    if (commit && ctx.dx > 0) commitRight(ctx);
    else if (commit && ctx.dx < 0) commitLeft(ctx);
    else springBack(ctx.el);
  }

  /** @param {PointerEvent} e */
  function onPointerCancel(e) {
    const ctx = dragCtx;
    if (!ctx || e.pointerId !== ctx.id) return;
    endDrag(ctx);
    springBack(ctx.el); // zero state change
  }

  /** @param {HTMLElement} el */
  function springBack(el) {
    const from = el.style.transform;
    el.style.transform = "";
    clearDragVisual(el);
    if (from && from !== "none") {
      el.animate(
        [{ transform: from }, { transform: "translate(0px, 0px) rotate(0deg)" }],
        reducedMotion
          ? { duration: 110, easing: "ease-out" }
          : { duration: 480, easing: "cubic-bezier(.22, 1.6, .36, 1)" },
      );
    }
  }

  /** @param {DragCtx} ctx */
  function commitRight(ctx) {
    const sug = ctx.txn.suggestion;
    if (isConfident(ctx.txn) && sug && sug.suggested_category_id != null) {
      const w = washFor(ctx.el);
      if (w.right) w.right.style.opacity = "1";
      decideApply(ctx.txn, sug.suggested_category_id, false); // queue first…
      flyOutTop(ctx.el, +1); // …then animate
      advance(ctx.txn);
    } else {
      liftForPicker(ctx.el, ctx.txn); // unsure right-swipe = open picker
    }
  }

  /** @param {DragCtx} ctx */
  function commitLeft(ctx) {
    const w = washFor(ctx.el);
    if (w.left) w.left.style.opacity = "1";
    decidePark(ctx.txn);
    flyOutTop(ctx.el, -1);
    advance(ctx.txn);
  }

  /** @param {HTMLElement|null} el @param {number} dir */
  function flyOutTop(el, dir) {
    if (!el) { renderStack(); return; }
    el.classList.add("flying");
    el.style.zIndex = "10";
    const from = el.style.transform || "none";
    const tilt = el.classList.contains("unsure") ? 0 : dir * 20;
    const x = dir * (window.innerWidth * 0.9 + 220);
    const anim = el.animate(
      reducedMotion
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { transform: from, opacity: 1 },
            { transform: `translate(${x}px, -36px) rotate(${tilt}deg)`, opacity: 0.4 },
          ],
      { duration: reducedMotion ? 140 : 340, easing: "cubic-bezier(.3, .6, .4, 1)" },
    );
    const done = () => el.remove();
    anim.onfinish = done;
    anim.oncancel = done;
    setTimeout(done, 700); // safety net
  }

  /** Hold the card "lifted" while the picker is open; cancel springs it back, zero state change.
   *  @param {HTMLElement|null} el @param {Txn} txn */
  function liftForPicker(el, txn) {
    if (pickerCtx || !txn) return;
    if (el) {
      clearDragVisual(el);
      el.classList.add("lifted"); // transitions from the current drag transform
    }
    const liftPose = "translateY(-18px) scale(1.03)";
    openPicker(txn, {
      onPick(catId) {
        if (el) { el.style.transform = liftPose; el.classList.remove("lifted"); }
        decideApply(txn, catId, true);
        flyOutTop(el, +1);
        advance(txn);
      },
      onCancel() {
        if (el) {
          el.classList.remove("lifted");
          el.style.transform = liftPose;
          springBack(el);
        }
      },
    });
  }

  // ---------- action buttons (mirror every gesture) ----------
  function actAccept() {
    const txn = set[0];
    if (!txn || pickerCtx) return;
    const el = topEl();
    const sug = txn.suggestion;
    if (isConfident(txn) && sug && sug.suggested_category_id != null) {
      decideApply(txn, sug.suggested_category_id, false);
      flyOutTop(el, +1);
      advance(txn);
    } else {
      liftForPicker(el, txn);
    }
  }
  function actPark() {
    const txn = set[0];
    if (!txn || pickerCtx) return;
    decidePark(txn);
    flyOutTop(topEl(), -1);
    advance(txn);
  }
  function actPick() {
    const txn = set[0];
    if (!txn || pickerCtx) return;
    liftForPicker(topEl(), txn);
  }

  // ---------- sheets (shared open/close, history back, focus trap) ----------
  /** @type {HTMLElement|null} */
  let sheetReturnFocus = null;
  let sheetHistoryDepth = 0; // hardware back closes the sheet instead of exiting the PWA
  let ignoreNextPop = false;

  /** @param {HTMLElement} sheet */
  function openSheet(sheet) {
    abortDrag(); // a captured pointer must not commit an invisible decision under the backdrop
    pauseUndoClock();
    sheetReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    els.backdrop.hidden = false;
    els.backdrop.classList.remove("closing");
    sheet.hidden = false;
    try { history.pushState({ dopoSheet: true }, ""); sheetHistoryDepth++; } catch { /* sandboxed */ }
    requestAnimationFrame(() => {
      sheet.classList.add("open");
      const guess = sheet.querySelector(".cat-btn.guess");
      (guess instanceof HTMLElement ? guess : sheet).focus();
    });
  }
  /** Pop our history entry when the sheet closes through the UI (not the back button). */
  function consumeSheetHistory() {
    if (sheetHistoryDepth > 0) {
      sheetHistoryDepth--;
      ignoreNextPop = true;
      try { history.back(); } catch { /* sandboxed */ }
    }
  }
  /** @param {HTMLElement} sheet @param {{keepHistory?: boolean}} [opts]  keepHistory: the
   *  history entry is handed to what opens next (the wizard) instead of popped */
  function closeSheet(sheet, opts = {}) {
    if (!opts.keepHistory) consumeSheetHistory();
    sheet.classList.remove("open");
    els.backdrop.classList.add("closing");
    setTimeout(() => {
      sheet.hidden = true;
      if (!sheetOpenNow()) {
        els.backdrop.hidden = true;
        resumeUndoClock();
        sheetReturnFocus?.focus?.();
        sheetReturnFocus = null;
        maybeShowUpdateToast(); // a suppressed "New version" toast may surface now
        if (pendingSheetResync) { pendingSheetResync = false; scheduleOnlineResync(); } // sheet-blocked online refresh re-arms
      }
    }, reducedMotion ? 130 : 340);
  }
  const sheetOpenNow = () => !!pickerCtx || els.laterSheet.hidden === false ||
    els.acctSheet.hidden === false || els.settingsSheet.hidden === false;

  // ---------- picker bottom sheet ----------
  /** @param {Txn} txn @param {{onPick: (catId: number) => void, onCancel: () => void}} handlers */
  function openPicker(txn, handlers) {
    pickerCtx = { txn, ...handlers };
    const guessId = txn.suggestion?.suggested_category_id ?? null;
    els.pickTitle.textContent = txn.merchant ? `Sort: ${txn.merchant}` : "Pick a category";

    /** @param {Category} c @param {boolean} [inRecent] @returns {string} */
    const btn = (c, inRecent = false) => {
      const bits = splitEmoji(c.name);
      // the MODEL GUESS tag belongs to the grouped list only, not a duplicate on the recent chip
      const clsHtml = !inRecent && c.id === guessId ? " guess" : "";
      const emojiHtml = esc(bits.emoji || "🏷");
      return `<button type="button" class="cat-btn${clsHtml}" data-cat="${Number(c.id)}">
        <span class="cat-emoji">${emojiHtml}</span><span>${esc(bits.text)}</span></button>`;
    };

    let bodyHtml = "";
    const recents = recent.flatMap((id) => { const c = catById.get(id); return c ? [c] : []; }).slice(0, 8);
    if (recents.length) {
      const chipsHtml = recents.map((c) => btn(c, true)).join("");
      bodyHtml += `<div class="sheet-section">Recent</div><div class="recent-row">${chipsHtml}</div>`;
    }
    /** @type {Map<string, Category[]>} */
    const groups = new Map();
    for (const c of categories) {
      const g = c.group || "Other";
      const list = groups.get(g) ?? [];
      if (!list.length) groups.set(g, list);
      list.push(c);
    }
    for (const [g, cats] of groups) {
      const btnsHtml = cats.map((c) => btn(c)).join("");
      bodyHtml += `<div class="sheet-section">${esc(g)}</div>${btnsHtml}`;
    }
    els.pickBody.innerHTML = bodyHtml;
    openSheet(els.pickSheet);
    const guesses = els.pickBody.querySelectorAll(".cat-btn.guess");
    const guessEl = guesses[guesses.length - 1]; // the grouped-list one, not the recent chip
    if (guessEl) setTimeout(() => guessEl.scrollIntoView({ block: "center" }), 60);
  }

  /** @param {number|null} catId  null = cancel */
  function resolvePicker(catId) {
    const ctx = pickerCtx;
    if (!ctx) return;
    pickerCtx = null;
    closeSheet(els.pickSheet);
    if (catId != null) {
      recent = [catId, ...recent.filter((id) => id !== catId)];
      lsSave(LS.recent, recent.slice(0, 12));
      ctx.onPick(catId);
    } else {
      ctx.onCancel(); // spring back, no decision counted
    }
    flush("picker"); // picker close is a flush trigger (either way)
  }

  // ---------- Later sheet ----------
  function openLaterSheet() {
    /** @param {Txn} t @returns {string} */
    const itemHtml = (t) => `<div class="later-item">
        <div class="later-info">
          <div class="later-merchant">${esc(t.merchant || t.payee || "?")}</div>
          <div class="later-sub">${esc(fmtAmountText(t))} · ${esc(fmtTxnDate(t.date))}</div>
        </div>
        <button type="button" class="unpark-btn" data-unpark="${Number(t.id)}">Unpark</button>
      </div>`;
    const rowsHtml = later.map(itemHtml).join("");
    els.laterBody.innerHTML = later.length ? rowsHtml : '<div class="later-empty">Nothing parked 💤</div>';
    openSheet(els.laterSheet);
  }
  function closeLaterSheet() { closeSheet(els.laterSheet); }

  // ---------- accounts filter sheet ----------
  function openAcctSheet() {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const t of allTxns) {
      const k = acctKeyOf(t);
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    const rows = accounts
      .filter((a) => counts.get(a.key)) // only accounts with uncategorized txns
      .sort((a, b) => (counts.get(b.key) || 0) - (counts.get(a.key) || 0));
    /** @param {Account} a @returns {string} */
    const rowHtml = (a) => {
      const checkedHtml = hiddenAccounts.includes(a.key) ? "" : "checked";
      const maskHtml = a.mask ? ` <span class="acct-mask">··${esc(a.mask)}</span>` : "";
      return `<label class="acct-row">
        <input type="checkbox" data-acct="${esc(a.key)}" ${checkedHtml}>
        <span class="acct-name">${esc(a.name)}${maskHtml}</span>
        <span class="acct-sub">${esc(a.institution || "")}</span>
        <span class="acct-count">${Number(counts.get(a.key))}</span>
      </label>`;
    };
    const rowsHtml = rows.map(rowHtml).join("");
    els.acctBody.innerHTML = rows.length ? rowsHtml : '<div class="later-empty">No accounts with uncategorized transactions</div>';
    openSheet(els.acctSheet);
  }
  function closeAcctSheet() {
    closeSheet(els.acctSheet);
    // rebuild the deck under the new filter (explicit user action: full redeal is expected)
    backlog = eligible(allTxns).sort(byConfDesc);
    dealSet();
    dealAnim = true;
    renderStack();
    updateMeters();
    ensureClassified();
  }

  /** @param {number} id */
  function unpark(id) {
    const i = later.findIndex((t) => t.id === id);
    if (i < 0) return;
    abortDrag();
    const [txn] = later.splice(i, 1);
    try { laterRemove(id); } catch { /* pointer cleanup is best-effort */ }
    updateLaterChip();
    if (!txn) return;
    inboxCelebrated = false;
    set.unshift(txn); // deal with it next
    closeLaterSheet();
    renderStack();
    updateMeters();
  }

  // ---------- settings sheet ----------
  /** @param {"lm"|"or"} which @param {string|null} msg */
  function setFieldError(which, msg) {
    const errEl = which === "lm" ? els.lmTokenError : els.orTokenError;
    const input = which === "lm" ? els.lmTokenInput : els.orTokenInput;
    errEl.textContent = msg || "";
    errEl.hidden = !msg;
    input.classList.toggle("invalid", !!msg);
  }
  /** @param {string|null} msg */
  function setSettingsError(msg) {
    els.settingsError.textContent = msg || "";
    els.settingsError.hidden = !msg;
  }
  function clearSettingsErrors() {
    setFieldError("lm", null);
    setFieldError("or", null);
    setSettingsError(null);
  }

  function updateWebCheckLine() {
    if (els.settingsSheet.hidden) return;
    els.webCheckLine.textContent = tokens.or
      ? `Web checks this session: ${webChecksUsed} unique merchant${webChecksUsed === 1 ? "" : "s"} (~$${(webChecksUsed * WEB_COST).toFixed(2)})`
      : onFreeTier()
        ? "Web checks (pass 2) need your own OpenRouter key — the shared free key only does pass 1."
        : "Web checks (pass 2) need an OpenRouter key.";
    els.webCheckLine.hidden = false;
  }

  // ---------- settings: deck cutoff ----------
  /** Chips + optional "from <date>" line; Settings and the wizard's tune step share it.
   *  @param {HTMLElement} [container] @param {HTMLElement} [lineEl] */
  function renderCutoffRow(container = els.cutoffRow, /** @type {HTMLElement|null} */ lineEl = els.cutoffLine) {
    const btnHtml = (/** @type {{id: string, label: string}} */ p) =>
      `<button type="button" class="cutoff-chip${p.id === cutoff ? " on" : ""}"
        data-cutoff="${esc(p.id)}" aria-pressed="${p.id === cutoff ? "true" : "false"}">${esc(p.label)}</button>`;
    const chipsHtml = CUTOFF_PRESETS.map(btnHtml).join("");
    container.innerHTML = chipsHtml;
    if (!lineEl) return; // the wizard's count line names the start date itself
    const { startDate } = fetchWindow();
    lineEl.textContent = `Showing transactions from ${fmtTxnDate(startDate)} onwards.`;
  }

  /** @param {string} id */
  function pickCutoff(id) {
    if (id === cutoff) return;
    cutoff = /** @type {import("./lib/lm.js").CutoffId} */ (id);
    try { cutoffSave(id); } catch { storageFailed(); }
    cutoffDirty = true; // a full refetch mid-sheet would fight the open sheet — do it on close
    renderCutoffRow();
    haptic(8);
  }

  /** A changed cutoff means a different window entirely: refetch and redeal from
   *  scratch rather than reconcile(), which would preserve a top card that may now
   *  be out of range. */
  async function applyCutoffChange() {
    cutoffDirty = false;
    if (loadState === "none") { retryLoad(); return; }
    try {
      await fetchState();
    } catch (e) {
      if (!isNoTokenErr(e) && !isStaleErr(e)) noteConnOutcome("lm", e);
      routeLMError(e);
      return; // the old deck stays; the banner/chip already say why
    }
    backlog = eligible(allTxns).sort(byConfDesc);
    dealSet();
    inboxCelebrated = false;
    truncationNoted = false;
    dealAnim = true;
    renderStack();
    updateMeters();
    ensureClassified();
  }

  // ---------- settings: local rules ----------
  /** Rules are created from the undo toast ("Always: X → Y"); this is where they
   *  are reviewed and removed. */
  function renderRulesList() {
    if (!rules.length) {
      els.rulesNote.textContent = 'No rules yet — after sorting a card, tap “Always: … →” on the undo toast to make one.';
      els.rulesList.innerHTML = "";
      return;
    }
    els.rulesNote.textContent = "A rule sorts every matching merchant instantly, before the model is asked.";
    const rowHtml = (/** @type {Rule} */ r) => {
      const catName = r.category_name || catById.get(r.category_id)?.name || `category ${r.category_id}`;
      return `<div class="rule-row">
        <div class="rule-info">
          <div class="rule-pattern">${esc(r.pattern)}</div>
          <div class="rule-cat">→ ${esc(catName)}</div>
        </div>
        <button type="button" class="rule-del" data-rule-del="${Number(r.id)}"
          aria-label="Delete rule ${esc(r.pattern)}">Delete</button>
      </div>`;
    };
    els.rulesList.innerHTML = rules.map(rowHtml).join("");
  }

  /** @param {number} id */
  function deleteRule(id) {
    const next = rules.filter((r) => r.id !== id);
    if (next.length === rules.length) return;
    rules = next;
    try { rulesSave(rules); } catch { storageFailed(); }
    renderRulesList();
    // The deck carries rule-sourced suggestions for the pattern we just dropped;
    // rebuild them from the remaining rules + caches instead of leaving ghosts.
    void reattachSuggestions();
    note("Rule deleted");
  }

  let saveAnywayArmed = false; // second tap saves unverified after a network-class validation failure
  function disarmSaveAnyway() {
    saveAnywayArmed = false;
    els.settingsSave.textContent = "Save";
  }

  /** hidePopover() throws InvalidStateError when the popover is already closed,
   *  and every caller here closes the menu blind. */
  function closeMenu() {
    if (els.menuPop.matches(":popover-open")) els.menuPop.hidePopover();
  }

  /** The OR field's resting hint: the user's key, the shared free tier, or nothing.
   *  @param {boolean} [rejected]  the upstream just refused the user's key — say nothing */
  function paintOrHint(rejected = false) {
    if (rejected) { els.orTokenHint.hidden = true; return; }
    if (tokens.or) els.orTokenHint.textContent = "Configured ✓ — paste to replace";
    else if (onFreeTier()) els.orTokenHint.textContent = "Using the shared free key — a smaller model, a daily quota shared by everyone, no web checks";
    els.orTokenHint.hidden = !tokens.or && !onFreeTier();
  }

  /** @param {"lm"|"or"|null} deadField  names the token the upstream just rejected */
  function openSettingsSheet(deadField) {
    closeMenu();
    els.lmTokenInput.value = "";
    els.orTokenInput.value = "";
    disarmSaveAnyway();
    disarmForget(); // never reopen with the destructive button still armed
    clearSettingsErrors();
    els.lmTokenHint.textContent = "Configured ✓ — paste to replace";
    els.lmTokenHint.hidden = !tokens.lm || deadField === "lm";
    paintOrHint(deadField === "or");
    els.budgetLine.hidden = true;
    els.forgetBtn.hidden = !tokens.lm && !tokens.or;
    els.badgeToggle.checked = badgeEnabled;
    els.musicToggle.checked = audioPrefs.music;
    els.sfxToggle.checked = audioPrefs.sfx;
    renderCutoffRow();
    renderRulesList();
    if (deadField === "lm") setFieldError("lm", "This Lunch Money token stopped working — paste a fresh one.");
    if (deadField === "or") setFieldError("or", "This OpenRouter key stopped working — paste a fresh one.");
    openSheet(els.settingsSheet);
    updateWebCheckLine(); // after openSheet: the line only paints while the sheet is visible
    if (tokens.lm && deadField !== "lm") {
      // budget name display; a failure leaves the sheet perfectly usable
      getMe(tokens.lm).then((me) => {
        if (els.settingsSheet.hidden || !me.budget_name) return;
        els.budgetLine.innerHTML = `Budget: <b>${esc(me.budget_name)}</b>`;
        els.budgetLine.hidden = false;
      }).catch(() => { /* sheet stays usable for pasting tokens */ });
    }
  }
  /** @returns {boolean} true when a cutoff change already kicked off a refetch+redeal */
  function closeSettingsSheet() {
    disarmForget();
    closeSheet(els.settingsSheet);
    if (!cutoffDirty) return false;
    void applyCutoffChange();
    return true;
  }

  /** Live per-field validation; paints hint/error itself. "netfail" = the token
   *  wasn't REJECTED, we just couldn't reach the validator (offline / upstream
   *  down) — saveSettings offers "Save anyway" for that class only.
   * @param {"lm"|"or"} which @param {string} val @returns {Promise<"ok"|"bad"|"netfail">} */
  async function validateTokenField(which, val) {
    const input = which === "lm" ? els.lmTokenInput : els.orTokenInput;
    try {
      if (which === "lm") {
        const me = await getMe(val);
        if (input.value.trim() !== val) return "bad"; // field changed under us
        els.lmTokenHint.textContent = me.budget_name ? `Token OK ✓ — budget “${me.budget_name}”` : "Token OK ✓";
        els.lmTokenHint.hidden = false;
      } else {
        await checkKey(val);
        if (input.value.trim() !== val) return "bad";
        els.orTokenHint.textContent = "Key OK ✓";
        els.orTokenHint.hidden = false;
      }
      setFieldError(which, null);
      return "ok";
    } catch (e) {
      if (input.value.trim() !== val) return "bad";
      const rejected = which === "lm"
        ? (e instanceof LMError && e.tokenInvalid)
        : (e instanceof ORError && e.tokenInvalid);
      setFieldError(which, rejected
        ? (which === "lm" ? "Lunch Money rejected this token." : "OpenRouter rejected this key.")
        : "Couldn't verify — check your connection and try again.");
      return rejected ? "bad" : "netfail";
    }
  }

  async function saveSettings() {
    const lm = els.lmTokenInput.value.trim();
    const or = els.orTokenInput.value.trim();
    clearSettingsErrors();
    if (!lm && !or) {
      // Both inputs open blank by design, so "nothing pasted" means "tokens unchanged",
      // not "no tokens". The sheet also holds the badge toggle, the deck cutoff and the
      // rules list, so Save is the natural "I'm done" gesture — erroring here nagged for
      // tokens the app already had. closeSettingsSheet() still applies a dirty cutoff.
      if (!tokens.lm) { setSettingsError("Paste your Lunch Money token to get started."); return; }
      closeSettingsSheet();
      return;
    }
    els.settingsSave.disabled = true;
    els.settingsSave.textContent = "Checking…";
    try {
      // An armed "Save anyway" skips re-validation — the previous attempt already
      // told us the validators are unreachable; trying again is just a slower no.
      if (!saveAnywayArmed) {
        const [lmRes, orRes] = await Promise.all([
          lm ? validateTokenField("lm", lm) : Promise.resolve(/** @type {const} */ ("ok")),
          or ? validateTokenField("or", or) : Promise.resolve(/** @type {const} */ ("ok")),
        ]);
        if (lmRes === "bad" || orRes === "bad") return; // field errors already painted
        if (lmRes === "netfail" || orRes === "netfail") {
          // network-class failure only (token NOT rejected): offer an unverified save
          saveAnywayArmed = true;
          setSettingsError("Couldn't verify — you can save anyway and dopo will try the token when it can connect.");
          return;
        }
      }
      // MERGE semantics in store.setTokens: saving one token never drops the other
      if (!onTokensChanged({ ...(lm ? { lm } : {}), ...(or ? { or } : {}) })) {
        setSettingsError("Couldn't save — this device's storage may be full.");
        return;
      }
      saveAnywayArmed = false;
      els.lmTokenInput.value = "";
      els.orTokenInput.value = "";
      note("Saved ✓");
      const reloading = closeSettingsSheet();
      // let the close animation land, then (re)load with the new tokens — unless a
      // cutoff change is already refetching, in which case this would just double up
      setTimeout(() => {
        if (reloading) { updateWebBar(); return; }
        void replayIfNeeded().then(() => { // a new LM token: the persisted queue replays under it first
          if (loadState !== "none") { refresh(); updateWebBar(); } else retryLoad(); // snapshot takes the refresh() arm
        });
      }, reducedMotion ? 200 : 420);
    } catch (e) {
      setSettingsError((e instanceof Error && e.message) || "Couldn't save — try again.");
    } finally {
      els.settingsSave.disabled = false;
      els.settingsSave.textContent = saveAnywayArmed ? "Save anyway (couldn't verify)" : "Save";
    }
  }

  let forgetArmed = false; // second tap actually clears — the button sits right under Save
  function disarmForget() {
    forgetArmed = false;
    els.forgetBtn.textContent = "Forget tokens on this device";
    els.forgetBtn.classList.remove("armed");
  }

  /** "Forget tokens on this device" — clears tokens only; queue/rules/caches stay. */
  function onForgetTokens() {
    if (!forgetArmed) {
      forgetArmed = true;
      els.forgetBtn.textContent = "Tap again to forget — you'll have to paste them back";
      els.forgetBtn.classList.add("armed");
      return;
    }
    disarmForget();
    clearTokens(); // tokens AND the wizard cursor
    tokens = getTokens();
    replayedFor = null;
    cutoffDirty = false; // the wizard refetches on its own; no redeal owed on the next sheet close
    disarmSaveAnyway();
    els.lmTokenHint.hidden = true;
    paintOrHint(); // back on the shared free tier, if there is one
    els.budgetLine.hidden = true;
    els.forgetBtn.hidden = true;
    clearSettingsErrors();
    deadTokenNoted.clear();
    updateWebCheckLine();
    updateWebBar();
    updateUpgradeBanner();
    // The wizard takes the sheet's place — and its history entry: popping the sheet's
    // entry (history.back) and pushing the wizard's in the same tick would race.
    closeSheet(els.settingsSheet, { keepHistory: true });
    showOnboarding({ returning: true, adoptHistory: true });
    note("Tokens forgotten on this device");
  }

  // ---------- onboarding wizard (<dialog>: first run, interrupted setup, Forget tokens) ----------
  // Pure step/field logic lives in lib/onboard.js; this section is the DOM + the
  // containment: while the wizard is up the deck is torn down and every network-
  // adjacent loop (refresh, flush, classify, resync, update toast) waits.
  const hasFreeTier = () => !!FREE_KEY && !freeTierDead;
  /** @param {"lm"|"or"} which */
  const obInput = (which) => (which === "lm" ? els.obLmInput : els.obOrInput);
  /** A token on file lets an EMPTY field Continue (Back after saving) — unless the
   *  upstream just rejected that token. @param {"lm"|"or"} which */
  const obSaved = (which) => (which === "lm" ? !!tokens.lm : !!tokens.or) && !obDead[which];
  /** The field the current step validates, if any. */
  const obFieldOf = () => (obStep === "lm" ? "lm" : obStep === "or" && obChoice === "own" ? "or" : null);
  const obAdvance = () => canAdvance({
    stepId: obStep, steps: obSteps, returning: obReturning, choice: obChoice,
    field: obStep === "or" ? obField.or : obField.lm,
    saved: obSaved(obStep === "or" ? "or" : "lm"),
  });
  /** @param {"lm"|"or"} which */
  const obSavedHint = (which) => (obSaved(which)
    ? (which === "lm" ? "Connected ✓ — paste a different token to replace it" : "Key saved ✓ — paste a different key to replace it")
    : null);
  function obClearDebounce() {
    if (obDebounce) { clearTimeout(obDebounce); obDebounce = null; }
  }

  /** @param {{returning?: boolean, adoptHistory?: boolean}} [opts]
   *  returning: Forget-tokens path (lm [+ or]; no welcome/done). adoptHistory: the
   *  caller hands over an open sheet's history entry, so no pushState here. */
  function showOnboarding(opts = {}) {
    if (onboardingActive) return; // load-bearing: routeLMError re-enters on every failed retry
    onboardingActive = true;
    obReturning = opts.returning === true;
    obSteps = stepsFor({ returning: obReturning, hasFreeTier: hasFreeTier() });
    // Tear the deck down: whatever is loaded belongs to tokens that are gone or
    // unverified, and a live deck would keep pulling on the network behind the wizard.
    abortDrag();
    finalizeUndo();
    fetchGen++; // an in-flight fetch for the old deck must not land under the wizard
    loadState = "none";
    allTxns = []; set = []; backlog = [];
    snapshotIds.clear();
    lastFetchTs = null;
    snapshotFetchedAt = null;
    stateError = null;
    renderStack();
    updateMeters();
    updateConnUI();
    obChoice = null;
    obField = { lm: FIELD_IDLE, or: FIELD_IDLE };
    obDead = { lm: false, or: false };
    for (const which of /** @type {const} */ (["lm", "or"])) {
      obInput(which).value = "";
      obSetShown(which, false);
      obPaintField(which, null, null);
    }
    els.obNote.hidden = true;
    els.obNote.textContent = "";
    if (!opts.adoptHistory) {
      try { history.pushState({ dopoOb: true }, ""); sheetHistoryDepth++; } catch { /* sandboxed */ }
    }
    if (!els.onboard.open) els.onboard.showModal();
    obGoto(obStartStep());
  }

  /** Resume point: the cursor wins when it names a step of this run — but never
   *  "welcome" once a token exists, and never past "lm" without one. */
  function obStartStep() {
    const first = obSteps[0] ?? "welcome";
    if (obReturning) return first;
    const cursor = onboardCursorLoad();
    let start = cursor !== null && obSteps.includes(cursor) ? cursor : first;
    if (tokens.lm && start === "welcome") start = "lm";
    if (!tokens.lm && start !== "welcome" && start !== "lm") start = "lm";
    return start;
  }

  function hideOnboarding() {
    if (!onboardingActive) return;
    onboardingActive = false;
    obClearDebounce();
    consumeSheetHistory();
    if (els.onboard.open) els.onboard.close();
    els.obNote.hidden = true;
    els.obNote.textContent = "";
    maybeShowUpdateToast(); // a "New version" toast suppressed by the wizard may surface now
    if (pendingSheetResync) { pendingSheetResync = false; scheduleOnlineResync(); } // wizard-blocked online refresh re-arms
  }

  /** @param {StepId} id @param {{dead?: boolean}} [opts]  dead: the upstream just rejected the saved token */
  function obGoto(id, opts = {}) {
    obClearDebounce();
    obStep = id;
    try { onboardCursorSave(id); } catch { storageFailed(); }
    if (id === "lm" || id === "or") obEnterField(id, opts.dead === true);
    if (id === "or") renderAiChoices();
    obShowPanel(id);
    obRender();
    if (id === "tune") obRenderTune();
    if (id === "done") {
      // the sound toggles live here; paint the truth (a cursor resume must not show an
      // unchecked box for music that is actually on), and keep the quiet preload the
      // tune step would have kicked — a resume can land here directly
      els.obMusicToggle.checked = audioPrefs.music;
      els.obSfxToggle.checked = audioPrefs.sfx;
      if (loadState !== "live" && !loadInFlight && !stateError) void obLoad({});
    }
  }

  function obBack() {
    const p = prevStep(obSteps, obStep);
    if (p) obGoto(p);
  }

  /** Fresh field on entry (Back-after-save shows an empty box over the saved token).
   *  Offline seeds the netfail state so Continue reads "Try again / Continue anyway"
   *  before anything is typed.
   *  @param {"lm"|"or"} which @param {boolean} dead */
  function obEnterField(which, dead) {
    obInput(which).value = "";
    obField[which] = FIELD_IDLE;
    obDead[which] = obDead[which] || dead; // sticks until onTokensChanged saves a replacement
    if (dead && which === "or") obChoice = "own"; // the key field must be visible to take the replacement
    /** @type {string|null} */
    let error = null;
    if (dead) {
      error = which === "lm"
        ? "Lunch Money stopped accepting this token — paste a fresh one."
        : "OpenRouter stopped accepting this key — paste a fresh one.";
    }
    /** @type {string|null} */
    let hint = error ? null : obSavedHint(which);
    if (navigator.onLine === false) {
      // informational, not a rejection: it goes in the status hint, not the red error slot
      obField[which] = nextFieldState(obField[which], { type: "offline", value: "" });
      hint = "You're offline — paste it anyway and dopo checks it when you reconnect.";
    }
    obPaintField(which, hint, error);
  }

  /** @param {"lm"|"or"} which @param {string|null} hint @param {string|null} error */
  function obPaintField(which, hint, error) {
    const hintEl = which === "lm" ? els.obLmHint : els.obOrHint;
    const errEl = which === "lm" ? els.obLmError : els.obOrError;
    hintEl.textContent = hint || "";
    hintEl.hidden = !hint;
    errEl.textContent = error || "";
    errEl.hidden = !error;
    obInput(which).classList.toggle("invalid", !!error);
  }

  /** @param {"lm"|"or"} which @param {boolean} shown */
  function obSetShown(which, shown) {
    const btn = which === "lm" ? els.obLmShow : els.obOrShow;
    obInput(which).type = shown ? "text" : "password";
    btn.textContent = shown ? "Hide" : "Show";
    btn.setAttribute("aria-pressed", String(shown));
  }
  /** @param {"lm"|"or"} which */
  function obToggleShown(which) {
    obSetShown(which, obInput(which).type === "password");
    obInput(which).focus();
  }

  /** @param {StepId} id */
  function obShowPanel(id) {
    for (const p of els.onboard.querySelectorAll(".onboard-step")) {
      if (!(p instanceof HTMLElement)) continue;
      const on = p.dataset.step === id;
      p.classList.remove("ob-enter");
      p.hidden = !on;
      if (!on) continue;
      if (!reducedMotion) { void p.offsetWidth; p.classList.add("ob-enter"); } // reflow restarts the fade/slide
      const h = p.querySelector(".ob-title");
      if (h instanceof HTMLElement) {
        if (!h.id) h.id = `obTitle-${id}`;
        els.onboard.setAttribute("aria-labelledby", h.id);
        h.focus();
      }
    }
  }

  /** Chrome (label, dots, Back/Next/secondary) + the own-key field's visibility. */
  function obRender() {
    if (!onboardingActive) return;
    const adv = obAdvance();
    const n = obSteps.length;
    const i = Math.max(0, obSteps.indexOf(obStep));
    els.obStepLabel.hidden = n <= 1;
    els.obStepLabel.textContent = `Step ${i + 1} of ${n}`;
    els.obDots.hidden = n <= 1;
    els.obDots.textContent = "";
    for (let k = 0; k < n; k++) {
      const dot = document.createElement("span");
      dot.className = `dot${k < i ? " done" : k === i ? " on" : ""}`;
      els.obDots.appendChild(dot);
    }
    els.obBack.hidden = !adv.showBack;
    // A check in flight keeps Next tappable: blur-validate + tap arrive together, and
    // a disabled button would swallow the tap — obContinue waits for the check instead.
    const which = obFieldOf();
    const checking = which !== null && obField[which].status === "checking";
    els.obNext.textContent = adv.primary;
    els.obNext.disabled = !adv.canContinue && !checking;
    els.obNext.setAttribute("aria-busy", String(checking));
    els.obSecondary.hidden = adv.secondary === null;
    els.obSecondary.textContent = adv.secondary ?? "";
    els.obOrField.hidden = !(obStep === "or" && obChoice === "own");
  }

  /** The AI step's radio group, built with createElement — its copy is data, not markup. */
  function renderAiChoices() {
    const choices = orChoices(hasFreeTier());
    if (obChoice !== null && !choices.some((c) => c.id === obChoice)) obChoice = null; // free tier died mid-run
    els.obAiGroup.textContent = "";
    for (const c of choices) {
      const label = document.createElement("label");
      label.className = "ob-choice";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "obAi";
      radio.value = c.id;
      radio.checked = obChoice === c.id;
      if (c.id === "own") radio.setAttribute("aria-controls", "obOrField");
      const body = document.createElement("div");
      body.className = "ob-choice-body";
      const title = document.createElement("strong");
      title.className = "ob-choice-title";
      title.textContent = c.title;
      body.appendChild(title);
      if (c.lead) {
        const lead = document.createElement("p");
        lead.className = "ob-choice-lead";
        lead.textContent = c.lead;
        body.appendChild(lead);
      }
      if (c.bullets.length) {
        const ul = document.createElement("ul");
        ul.className = "ob-choice-bullets";
        for (const b of c.bullets) {
          const li = document.createElement("li");
          li.textContent = b;
          ul.appendChild(li);
        }
        body.appendChild(ul);
      }
      label.append(radio, body);
      els.obAiGroup.appendChild(label);
    }
  }

  /** @param {"lm"|"or"} which */
  function obOnInput(which) {
    const val = obInput(which).value.trim();
    const next = nextFieldState(obField[which], { type: "edit", value: val });
    if (next !== obField[which]) { obField[which] = next; obPaintField(which, null, null); }
    obClearDebounce();
    if (val) obDebounce = setTimeout(() => { obDebounce = null; void obValidate(which); }, 600);
    obRender();
  }
  /** @param {"lm"|"or"} which */
  function obOnBlur(which) {
    if (obInput(which).value.trim() && obField[which].status === "idle") void obValidate(which);
  }

  /** Validate the field's current value against its upstream and feed the outcome
   *  through nextFieldState (a stale answer — the user kept typing — is dropped there).
   *  Returns the in-flight promise when the same value is already being checked.
   *  @param {"lm"|"or"} which @returns {Promise<void>} */
  function obValidate(which) {
    const cur = obField[which];
    const val = obInput(which).value.trim();
    if (cur.status === "checking" && cur.value === val && obCheck[which]) return obCheck[which];
    const p = obValidateRun(which, val).finally(() => { if (obCheck[which] === p) obCheck[which] = null; });
    obCheck[which] = p;
    return p;
  }
  /** @param {"lm"|"or"} which @param {string} val */
  async function obValidateRun(which, val) {
    obClearDebounce();
    const cur = obField[which];
    if (!val) {
      // nothing to check; online, an empty field just means "keep the saved token"
      if (navigator.onLine !== false) { obField[which] = FIELD_IDLE; obPaintField(which, obSavedHint(which), null); }
      obRender();
      return;
    }
    if (cur.value === val && (cur.status === "ok" || cur.status === "armed")) return; // already known
    if (navigator.onLine === false) {
      obField[which] = nextFieldState(cur, { type: "offline", value: val });
      obPaintField(which, "You're offline — dopo checks it when you reconnect.", null);
      obRender();
      return;
    }
    obField[which] = nextFieldState(cur, { type: "check", value: val });
    obPaintField(which, null, null);
    obRender();
    /** @type {import("./lib/onboard.js").FieldEvent} */
    let ev;
    /** @type {string|null} */
    let hint = null;
    /** @type {string|null} */
    let error = null;
    try {
      if (which === "lm") {
        const me = await getMe(val);
        hint = me.budget_name ? `Connected ✓ — budget “${me.budget_name}”` : "Connected ✓";
      } else {
        await checkKey(val);
        hint = "Key OK ✓";
      }
      ev = { type: "ok", value: val };
    } catch (e) {
      const rejected = which === "lm"
        ? (e instanceof LMError && e.tokenInvalid)
        : (e instanceof ORError && e.tokenInvalid);
      ev = rejected ? { type: "bad", value: val } : { type: "netfail", value: val };
      error = rejected
        ? (which === "lm" ? "Lunch Money rejected this token." : "OpenRouter rejected this key.")
        : (which === "lm" ? "Couldn't reach Lunch Money." : "Couldn't reach OpenRouter.");
    }
    const next = nextFieldState(obField[which], ev);
    if (next === obField[which]) return; // stale: the field moved on while we waited
    obField[which] = next;
    obPaintField(which, hint, error);
    obRender();
  }

  /** Primary button: validate if needed, commit the step's token, advance. */
  async function obContinue() {
    if (!onboardingActive || obContinuing) return;
    obContinuing = true;
    try {
      const step = obStep;
      const which = obFieldOf();
      let adv = obAdvance();
      if (which && (adv.checkFirst || obField[which].status === "checking")) {
        await obValidate(which);
        if (!onboardingActive || obStep !== step) return; // hardware back / dead-token jump meanwhile
        adv = obAdvance();
      }
      if (!adv.canContinue) return;
      if (which) {
        const { status, value } = obField[which];
        if (value === "" && !obSaved(which)) return; // nothing pasted and nothing saved: the labels lie only if this is reachable
        if (value !== "" && status !== "ok" && status !== "armed") return; // bad / netfail: painted, labels say so
        if (value !== "" && !onTokensChanged(which === "lm" ? { lm: value } : { or: value })) {
          note("Couldn't save the token — this device's storage may be full", 5000);
          return;
        }
      } else if (step === "or" && tokens.or) {
        // free / none picked with an own key on file (Back after saving one): the
        // radio is the truth — drop the key rather than silently keep using it
        if (!onTokensChanged({ or: null })) { note("Couldn't update the key — this device's storage may be full", 5000); return; }
      }
      const n = nextStep(obSteps, step);
      if (step === "or" && n) void obLoad({}); // the tune step wants the count; a last step loads via obFinish
      if (n) obGoto(n); else void obFinish();
    } finally {
      obContinuing = false;
    }
  }

  /** Secondary button ("Continue anyway" after a netfail): commit unverified. */
  function obSecondaryTap() {
    const which = obFieldOf();
    if (!which) return;
    obField[which] = nextFieldState(obField[which], { type: "arm" });
    obRender();
    void obContinue();
  }

  /** The AI step's Continue and the tune step's own kick-off: replay the queue
   *  under the (possibly new) token, then fetch the deck quietly.
   *  @param {{force?: boolean}} opts */
  async function obLoad(opts) {
    await replayIfNeeded();
    if (!onboardingActive || obDead.lm) return; // the replay just found the token dead
    await loadDeckQuiet(opts);
  }

  /** Wizard-side deck fetch: state only — no deal, no animation, no classify; the
   *  tune step repaints its count line from the outcome. One in flight at a time,
   *  and a second live fetch only on `force` (cutoff change).
   *  @param {{force?: boolean}} [opts] @returns {Promise<void>} */
  function loadDeckQuiet(opts = {}) {
    if (loadInFlight) {
      if (loadInFlightFor === tokens.lm) return loadInFlight;
      return loadInFlight.then(() => loadDeckQuiet(opts)); // Back → new token → forward: the old fetch is stale, start over
    }
    if (!tokens.lm || (loadState === "live" && !opts.force)) return Promise.resolve();
    const run = async () => {
      const loadedCutoff = cutoff;
      try {
        await fetchState();
        backlog = eligible(allTxns).sort(byConfDesc);
      } catch (e) {
        if (isStaleErr(e)) return; // the chained load under the new token repaints
        if (!isNoTokenErr(e)) noteConnOutcome("lm", e);
        stateError = e instanceof Error ? e : new Error("Couldn't load");
        routeLMError(e); // dead token → back to the lm step
      } finally {
        loadInFlight = null;
        loadInFlightFor = null;
      }
      // chip tapped mid-fetch — but not on a token that just bounced us back to the lm step
      if (cutoff !== loadedCutoff && onboardingActive && !obDead.lm) { await loadDeckQuiet({ force: true }); return; }
      obRenderTune();
    };
    stateError = null;
    loadInFlightFor = tokens.lm;
    loadInFlight = run();
    obRenderTune(); // "Loading your transactions…" — after the flag is set, so it doesn't re-kick itself
    return loadInFlight;
  }

  /** Tune step: live count line + cutoff chips. Starts the load itself when
   *  nothing is loaded yet (cursor resume lands here directly). */
  function obRenderTune() {
    if (!onboardingActive || obStep !== "tune") return;
    renderCutoffRow(els.obCutoffRow, null);
    let msg;
    if (loadInFlight) msg = "Loading your transactions…";
    else if (loadState === "live" && !stateError) {
      const { startDate } = fetchWindow();
      msg = `${backlog.length} uncategorized transaction${backlog.length === 1 ? "" : "s"} since ${fmtTxnDate(startDate)}`;
    } else if (connOffline()) msg = "You're offline — dopo loads your transactions when you reconnect.";
    else if (stateError) msg = "Couldn't load yet — dopo retries when you start.";
    else { msg = "Loading your transactions…"; void obLoad({}); }
    els.obCount.textContent = msg;
  }

  /** Wizard cutoff chip: same persistence as Settings, but the refetch happens right
   *  away (there is no open deck to fight) — never through cutoffDirty. @param {string} id */
  function obPickCutoff(id) {
    if (id === cutoff) return;
    cutoff = /** @type {import("./lib/lm.js").CutoffId} */ (id);
    try { cutoffSave(id); } catch { storageFailed(); }
    renderCutoffRow(els.obCutoffRow, null);
    haptic(8);
    void obLoad({ force: true }); // replay-before-fetch, like every other wizard load
  }

  /** "Start sorting" / "Done": leave the wizard and put the deck on the table. */
  async function obFinish() {
    onboardCursorClear();
    hideOnboarding();
    if (loadInFlight) await loadInFlight; // tapped mid-load: let it land rather than double-fetch
    if (loadState === "none" || stateError) { await replayIfNeeded(); await retryLoad(); return; }
    dealSet();
    dealAnim = true;
    renderStack();
    updateMeters();
    backfillRuleNames();
    maybeSuggestionToast();
    ensureClassified();
    updateWebBar();
  }

  /** Persist a token change (merge) and re-derive everything keyed on it. Returns
   *  whether storage echoes the write — the wizard refuses to advance otherwise.
   *  @param {{lm?: string|null, or?: string|null}} partial @returns {boolean} */
  function onTokensChanged(partial) {
    const prev = tokens;
    try { setTokens(partial); } catch { storageFailed(); }
    tokens = getTokens();
    const echoed = (partial.lm === undefined || tokens.lm === (partial.lm || null))
      && (partial.or === undefined || tokens.or === (partial.or || null));
    if (partial.lm !== undefined) {
      obDead.lm = false;
      deadTokenNoted.delete("lm");
      if (tokens.lm !== prev.lm) {
        replayedFor = null; // the persisted queue must replay under the new token
        fetchGen++; // and a fetch still paginating under the old one must not commit
      }
    }
    if (partial.or !== undefined) {
      obDead.or = false;
      deadTokenNoted.delete("or");
      orCreditNoted = false;
      freeQuotaHit = null; // own key: the free quota no longer applies
      updateUpgradeBanner();
    }
    updateWebBar();
    return echoed;
  }

  /** Replay the persisted apply queue ONCE per LM token (boot, or a token change in
   *  Settings / the wizard) — lib/sync.js owns the lock scope, the single membership
   *  recheck, and poison isolation; app.js keeps only the UI routing. Items that had
   *  live undo toasts at death are included (replay marks everything flushable).
   *  Server-era items (snapshotTs null) replay through the same recheck.
   *  @returns {Promise<void>} */
  function replayIfNeeded() {
    if (replayInFlight) return replayInFlight.then(() => replayIfNeeded()); // token may have changed meanwhile
    if (!tokens.lm || replayedFor === tokens.lm) return Promise.resolve();
    replayedFor = tokens.lm;
    replayInFlight = replayRun(tokens.lm).finally(() => { replayInFlight = null; });
    return replayInFlight;
  }
  /** @param {string} lmToken */
  async function replayRun(lmToken) {
    queue = queueLoad();
    if (!queue.length) return;
    bootReplaying = true; // flush() no-ops meanwhile — an `online` event mid-replay
    // must not double-send the same items and mis-announce them as "already done"
    try {
      const res = await replayQueue(lmToken, {
        onApplied: () => { queue = queueLoad(); updateConnUI(); }, // live chip count per chunk
      });
      queue = queueLoad(); // replay removed/parked items under its own lock; our refs are stale by design
      rules = rulesLoad(); // make_rule absorption wrote through store.ruleAdd
      noteConnOutcome("lm", null);
      // sent:false skips are honest news (someone else — or another tab — got
      // there first); sent:true skips are our own earlier sends, kept silent.
      if (res.skippedUnsent.length) note(`${res.skippedUnsent.length} already categorized elsewhere ✓`);
    } catch (e) {
      queue = queueLoad(); // partial progress persisted before the throw
      rules = rulesLoad();
      noteConnOutcome("lm", e);
      routeLMError(e); // unrouted failures stay quiet — the next flush/refresh retries
    }
    bootReplaying = false;
    updateConnUI(); // stuck surface + chip recount after replay
  }

  // ---------- app badge ("remaining at last close", never background results) ----------
  /** @param {number} n */
  function setBadge(n) {
    const nav = /** @type {any} */ (navigator);
    try {
      if (n > 0) nav.setAppBadge?.(n)?.catch?.(() => {});
      else nav.clearAppBadge?.()?.catch?.(() => {});
    } catch { /* unsupported: silent no-op */ }
  }

  // ---------- "N suggestions ready" toast (localStorage stamp) ----------
  const readSugStamp = () => { try { return localStorage.getItem(LS.sug) || null; } catch { return null; } };
  function updateSugStamp() {
    // remember the newest suggestion we had on screen this visit
    let max = readSugStamp() || "";
    for (const t of allTxns) {
      const c = t.suggestion?.created_at;
      if (c && c > max) max = c;
    }
    if (max) { try { localStorage.setItem(LS.sug, max); } catch { /* toast is a bonus */ } }
  }
  function maybeSuggestionToast() {
    if (sugToastShown || loadState !== "live") return; // snapshot suggestions aren't news
    sugToastShown = true;
    const stamp = readSugStamp();
    if (stamp) {
      let fresh = 0;
      for (const t of allTxns) {
        const c = t.suggestion?.created_at;
        if (c && c > stamp) fresh++;
      }
      if (fresh) note(`✨ ${fresh} suggestion${fresh === 1 ? "" : "s"} ready`);
    }
    updateSugStamp(); // first visit just sets the baseline, no toast
  }

  // ---------- service worker update flow ----------
  function maybeShowUpdateToast() {
    if (!updateReady || updateInitiated) return;
    if (sheetOpenNow() || dragCtx || onboardingActive) { updateToastPending = true; return; } // suppressed, resurfaces later
    updateToastPending = false;
    els.updateToast.hidden = false;
  }

  /** @param {ServiceWorker} sw */
  function offerUpdate(sw) {
    updateReady = sw;
    maybeShowUpdateToast();
  }

  async function applyUpdate() {
    // Another tab may have already switched the controller; SKIP_WAITING would be a
    // no-op and controllerchange won't refire — just flush and reload directly.
    if (reloadLatch) {
      try { await flush("update"); } catch { /* queue survives in localStorage */ }
      location.reload();
      return;
    }
    if (!updateReady) return;
    els.updateBtn.disabled = true;
    try { await flush("update"); } catch { /* flush never throws, but belt & braces */ }
    // Even if the flush failed, the queue survives in localStorage and replays after reload.
    updateInitiated = true;
    els.updateToast.hidden = true;
    updateReady.postMessage({ type: "SKIP_WAITING" });
    els.updateBtn.disabled = false;
  }

  /** Non-initiating tab: reload when hidden, or when the window is unfocused and idle. */
  function deferReload() {
    if (document.hidden) { location.reload(); return; }
    let done = false;
    const go = () => { if (done) return; done = true; location.reload(); };
    document.addEventListener("visibilitychange", () => { if (document.hidden) go(); });
    const idleTick = () => {
      if (done) return;
      if (!document.hasFocus() && !sheetOpenNow() && !dragCtx && !undoState && !queue.length) go();
      else setTimeout(idleTick, 10000);
    };
    setTimeout(idleTick, 10000);
  }

  function setupServiceWorker() {
    if (!("serviceWorker" in navigator)) return; // registration itself lives in boot.js
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) { hadController = true; return; } // first install claiming clients: no reload
      if (reloadLatch) return; // once-latch
      reloadLatch = true;
      if (updateInitiated) location.reload();
      else deferReload();
    });
    navigator.serviceWorker.ready.then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) offerUpdate(sw);
        });
      });
    }).catch(() => { /* no SW support / registration failed: app works without it */ });
  }

  // ---------- celebrations & confetti ----------
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let celebrateTimer;
  /** @param {string} emoji @param {string} title @param {string} sub @param {{button?: boolean, autoMs?: number}} [opts] */
  function showCelebrate(emoji, title, sub, opts = {}) {
    els.celebrateEmoji.textContent = emoji;
    els.celebrateTitle.textContent = title;
    els.celebrateSub.textContent = sub;
    els.celebrateBtn.hidden = !opts.button;
    els.celebrate.hidden = false;
    clearTimeout(celebrateTimer);
    if (opts.autoMs) celebrateTimer = setTimeout(hideCelebrate, opts.autoMs);
  }
  function hideCelebrate() {
    clearTimeout(celebrateTimer);
    els.celebrate.hidden = true;
  }
  function celebrateSet() {
    confetti(130);
    haptic([16, 60, 16]);
    showCelebrate("✨", "Set sorted!", "Dealing the next hand…", { autoMs: 1600 });
  }
  function celebrateInboxZero() {
    if (inboxCelebrated) return;
    inboxCelebrated = true;
    confetti(190);
    haptic([20, 60, 20, 60, 40]);
    fx()?.fanfare();
    // snapshot mode can't claim the server inbox is clear — hedge, don't "Legend."
    const sub = later.length ? `${later.length} parked for later`
      : loadState === "snapshot" && queue.length ? `All local cards sorted — ${queue.length} waiting to sync`
      : "Every transaction sorted. Legend.";
    showCelebrate("🏆", "Inbox zero", sub, { button: true });
  }

  // canvas confetti, no lib
  const cctx = els.confetti.getContext("2d");
  /** @type {{x:number,y:number,vx:number,vy:number,w:number,h:number,rot:number,vr:number,color:string,life:number}[]} */
  let confettiParts = [];
  let confettiRAF = 0;
  /** @param {number} count */
  function confetti(count) {
    if (reducedMotion || !cctx) { // fades instead of physics
      const f = document.createElement("div");
      f.className = "flash";
      document.body.appendChild(f);
      setTimeout(() => f.remove(), 950);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    els.confetti.width = window.innerWidth * dpr;
    els.confetti.height = window.innerHeight * dpr;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = ["#2a6b64", "#34d399", "#f5b465", "#f87171", "#60a5fa", "#fbbf24"];
    for (let i = 0; i < count; i++) {
      confettiParts.push({
        x: window.innerWidth / 2 + (Math.random() - 0.5) * 140,
        y: window.innerHeight * 0.55,
        vx: (Math.random() - 0.5) * 16,
        vy: -7 - Math.random() * 11,
        w: 5 + Math.random() * 6,
        h: 3 + Math.random() * 5,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        color: colors[i % colors.length] ?? "#34d399",
        life: 0,
      });
    }
    els.confetti.classList.add("on");
    if (!confettiRAF) confettiRAF = requestAnimationFrame(confettiTick);
  }
  function confettiTick() {
    if (!cctx) return;
    cctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    confettiParts = confettiParts.filter((p) => p.y < window.innerHeight + 40 && p.life < 260);
    for (const p of confettiParts) {
      p.life++;
      p.vy += 0.34;
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.99;
      p.rot += p.vr;
      cctx.save();
      cctx.translate(p.x, p.y);
      cctx.rotate(p.rot);
      cctx.globalAlpha = Math.max(0, 1 - p.life / 260);
      cctx.fillStyle = p.color;
      cctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      cctx.restore();
    }
    if (confettiParts.length) confettiRAF = requestAnimationFrame(confettiTick);
    else { confettiRAF = 0; els.confetti.classList.remove("on"); }
  }

  // ---------- offline / sync status UI (S6) ----------
  /** @param {number} ts */
  function relAge(ts) {
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return `${days} days ago`;
  }

  /** One entry point for the passive status surfaces: offline chip, stale banner,
   *  stuck banner. Cheap — safe to call from every decision/flush/event path. */
  function updateConnUI() {
    if (connOffline()) {
      // stuck items won't sync by themselves — the stuck banner owns those
      els.connChip.textContent = `Offline · ${queue.filter((it) => !it.stuck).length} queued`;
      els.connChip.hidden = false;
    } else {
      els.connChip.hidden = true;
    }
    updateStaleBanner();
    updateStuckUI();
    updateUpgradeBanner();
  }

  /** Free-tier quota surface. Stays up for the session (a per-minute cap clears
   *  by itself, but it will hit again on the next pass — the shared key is the
   *  bottleneck, not the moment) until the user pastes their own key. */
  function updateUpgradeBanner() {
    if (!freeQuotaHit || tokens.or) { els.upgradeBanner.hidden = true; return; }
    els.upgradeBanner.textContent = freeQuotaHit.daily
      ? "Free AI quota used up for today — tap to add your own OpenRouter key"
      : "Free AI is rate-limited (shared by everyone) — tap to add your own key";
    els.upgradeBanner.hidden = false;
  }

  function updateStaleBanner() {
    if (loadState !== "snapshot" || snapshotFetchedAt == null) { els.staleBanner.hidden = true; return; }
    els.staleBanner.textContent = `Showing data from ${relAge(snapshotFetchedAt)} — will refresh when online`;
    els.staleBanner.hidden = false;
  }

  const stuckQueueItems = () => queue.filter((it) => !it.flushable && it.stuck);

  /** Poison items parked by the flush/replay: keep them visible until resolved. */
  function updateStuckUI() {
    const stuck = stuckQueueItems();
    if (!stuck.length) { els.stuckBanner.hidden = true; return; }
    const n = stuck.length;
    const hasBody = stuck.some((it) => allTxns.some((t) => t.id === it.id));
    els.stuckBanner.textContent = hasBody
      ? `${n} change${n === 1 ? "" : "s"} couldn't sync — tap to re-sort`
      : n === 1 ? "1 change couldn't sync — discard this change" : `${n} changes couldn't sync — tap to discard`;
    els.stuckBanner.hidden = false;
  }

  /** Re-sort when the txn body is still around (clearing the queue entry puts it
   *  back in the deck — eligible() stops excluding it); otherwise the only honest
   *  option left is discarding the change. Bodiless items survive a re-sort tap
   *  and get the discard copy on the next updateStuckUI pass. */
  function onStuckTap() {
    const stuck = stuckQueueItems();
    if (!stuck.length) return;
    const withBody = stuck.filter((it) => allTxns.some((t) => t.id === it.id));
    const clearing = withBody.length ? withBody : stuck;
    const keys = new Set(clearing.map(keyOf));
    queueWriteSync((q) => {
      for (let i = q.length - 1; i >= 0; i--) {
        const it = q[i];
        if (it && keys.has(keyOf(it))) q.splice(i, 1);
      }
    });
    if (withBody.length) {
      reconcile(); // the cleared txns re-enter the deck
      note("Back in the deck — sort again");
    } else {
      note(clearing.length === 1 ? "Change discarded" : "Changes discarded");
    }
    updateConnUI();
  }

  // ---------- error routing ----------
  /** LMError 401 -> Settings naming the dead token; missing token -> onboarding.
   *  (The old Access-expiry overlay is gone: API calls are cross-origin now, so a
   *  family-origin Access expiry can only surface on same-origin ASSET loads —
   *  never through these fetches. A generic "Lunch Money rejected the token" card
   *  covers the 401 path.) Returns true if handled.
   *  @param {unknown} e */
  function routeLMError(e) {
    if (isStaleErr(e)) return true; // superseded by a newer fetch — nothing to tell the user
    if (e instanceof Error && /** @type {Error & {noToken?: boolean}} */ (e).noToken) {
      if (!onboardingActive) showOnboarding(); // the wizard is already collecting it otherwise
      return true;
    }
    if (e instanceof LMError && e.tokenInvalid) {
      if (onboardingActive) {
        // the wizard names it in place — no Settings, no once-per-session latch
        if (!(obStep === "lm" && obDead.lm)) obGoto("lm", { dead: true });
        return true;
      }
      if (!deadTokenNoted.has("lm")) {
        deadTokenNoted.add("lm"); // once per session — don't reopen the sheet on every retry
        if (sheetOpenNow()) note("Lunch Money rejected the token — see Settings");
        else openSettingsSheet("lm");
      }
      return true;
    }
    return false;
  }

  /** @param {unknown} e */
  function routeORError(e) {
    if (e instanceof ORError && e.tokenInvalid) {
      if (onboardingActive) {
        if (obSteps.includes("or") && !(obStep === "or" && obDead.or)) obGoto("or", { dead: true });
        return true;
      }
      if (!deadTokenNoted.has("or")) {
        deadTokenNoted.add("or");
        if (sheetOpenNow()) note("OpenRouter key stopped working — see Settings");
        else openSettingsSheet("or");
      }
      return true;
    }
    if (e instanceof ORError && e.status === 402) {
      // the user's own key is out of credit (or its spend limit is hit): a
      // "hiccup" retry note would be a lie — nothing changes until they top up
      if (!orCreditNoted) {
        orCreditNoted = true;
        note("OpenRouter says your key is out of credit — top up or raise its limit", 5000);
      }
      return true;
    }
    return false;
  }

  // ---------- lifecycle ----------
  function onHidden() {
    lastHiddenAt = Date.now();
    dust.reset(); // rAF is throttled to a crawl when hidden; don't hold particles
    // 1) clear undo state SYNCHRONOUSLY — its item stays non-flushable
    clearUndoForHidden();
    // 2) keepalive flush of current-snapshot flushable items only; the rest stays
    //    in localStorage (recheck-based replay covers it on next open)
    flush("hidden");
    // 3) badge = remaining at close; suggestion stamp = seen through this visit.
    //    Both LIVE only — a snapshot deck's counts describe stale data.
    if (onboardingActive) return; // nothing dealt yet — the counts would describe a deck the user never saw
    if (badgeEnabled && loadState === "live") setBadge(set.length + backlog.length);
    if (loadState === "live") updateSugStamp();
  }
  function onVisible() {
    setBadge(0); // cleared on open — the badge means "remaining at last close"
    if (pendingFinalize) {
      const { id, ts } = pendingFinalize; // by (id,ts): the ref may be a detached copy
      pendingFinalize = null;
      queueWriteSync((q) => {
        const f = q.find((it) => it.id === id && it.ts === ts);
        if (f) f.flushable = true;
      });
      maybeThresholdFlush();
    }
    if (!onboardingActive && lastHiddenAt && Date.now() - lastHiddenAt > REFRESH_AWAY_MS) {
      // A resumed installed-PWA session counts as a fresh visit: re-arm the
      // "N suggestions ready" toast so cached results surface without a reload.
      sugToastShown = false;
      refresh().then(() => maybeSuggestionToast());
    }
  }

  // ---------- sound prefs (Settings + wizard) ----------
  /** @param {boolean} on  the toggle click is the audio unlock gesture */
  function setMusicPref(on) {
    audioPrefs = { ...audioPrefs, music: on };
    try { audioSave(audioPrefs); } catch { /* session-only then */ }
    els.musicToggle.checked = on;
    els.obMusicToggle.checked = on;
    updateMusicChip();
    if (on) {
      ensureAudio();
      music?.enable();
    } else {
      music?.disable();
      // suspend only when BOTH are off — the context is shared with SFX
      if (!audioPrefs.sfx) void audioBus?.ctx.suspend().catch(() => { /* additive only */ });
    }
  }
  /** @param {boolean} on */
  function setSfxPref(on) {
    audioPrefs = { ...audioPrefs, sfx: on };
    try { audioSave(audioPrefs); } catch { /* session-only then */ }
    els.sfxToggle.checked = on;
    els.obSfxToggle.checked = on;
    if (on) {
      ensureAudio();
      void audioBus?.ctx.resume().catch(() => { /* additive only */ }); // gesture
    } else if (!audioPrefs.music) {
      void audioBus?.ctx.suspend().catch(() => { /* additive only */ });
    }
  }

  // ---------- events ----------
  function bindUI() {
    els.btnAccept.addEventListener("click", actAccept);
    els.btnPark.addEventListener("click", actPark);
    els.btnPick.addEventListener("click", actPick);
    els.undoBtn.addEventListener("click", doUndo);

    els.ruleChip.addEventListener("click", () => {
      const u = undoState;
      if (!u || u.kind !== "apply" || !u.item) return;
      const merchant = (u.txn.merchant || "").trim();
      if (!merchant) return;
      // stays attached to the queue item: the rule is only saved once the decision sticks
      const mr = { pattern: merchant, match_type: /** @type {"contains"|"exact"} */ ("contains") };
      u.item.make_rule = mr; // display copy; the persisted item is looked up fresh by (id,ts)
      const { id, ts } = u.item;
      queueWriteSync((q) => {
        const f = q.find((it) => it.id === id && it.ts === ts);
        if (f) f.make_rule = mr;
      });
      els.ruleChip.textContent = "✓ Rule will be saved";
      els.ruleChip.classList.add("saved");
      els.ruleChip.disabled = true;
      haptic(10);
    });

    // taps inside cards (off the horizontal drag axis / excluded from drag start)
    els.stack.addEventListener("click", (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      if (t.closest(".cat-chip")) { actPick(); return; }
      const tog = t.closest(".details-toggle");
      if (tog) {
        const card = tog.closest(".card");
        if (card) {
          card.classList.toggle("details-open");
          tog.textContent = card.classList.contains("details-open") ? "hide details" : "ⓘ details";
        }
        return;
      }
      if (t.closest(".retry")) retryLoad();
    });

    els.pickClose.addEventListener("click", () => resolvePicker(null));
    els.pickBody.addEventListener("click", (e) => {
      const t = e.target instanceof Element ? e.target : null;
      const b = t?.closest("[data-cat]");
      if (b instanceof HTMLElement && b.dataset.cat) resolvePicker(Number(b.dataset.cat));
    });
    els.backdrop.addEventListener("click", () => {
      if (pickerCtx) resolvePicker(null);
      else if (els.laterSheet.hidden === false) closeLaterSheet();
      else if (els.settingsSheet.hidden === false) closeSettingsSheet();
      else if (els.acctSheet.hidden === false) closeAcctSheet();
    });

    els.menuSettings.addEventListener("click", () => { closeMenu(); openSettingsSheet(null); });
    els.settingsClose.addEventListener("click", () => closeSettingsSheet());
    els.settingsSave.addEventListener("click", saveSettings);
    els.cutoffRow.addEventListener("click", (e) => {
      const b = e.target instanceof Element ? e.target.closest("[data-cutoff]") : null;
      if (b instanceof HTMLElement && b.dataset.cutoff) pickCutoff(b.dataset.cutoff);
    });
    els.rulesList.addEventListener("click", (e) => {
      const b = e.target instanceof Element ? e.target.closest("[data-rule-del]") : null;
      if (b instanceof HTMLElement && b.dataset.ruleDel) deleteRule(Number(b.dataset.ruleDel));
    });
    els.forgetBtn.addEventListener("click", onForgetTokens);
    els.lmTokenInput.addEventListener("change", () => {
      disarmSaveAnyway(); // edited token: the unverified-save consent no longer applies
      const v = els.lmTokenInput.value.trim();
      if (v) validateTokenField("lm", v);
    });
    els.orTokenInput.addEventListener("change", () => {
      disarmSaveAnyway();
      const v = els.orTokenInput.value.trim();
      if (v) validateTokenField("or", v);
    });
    // ---- onboarding wizard
    els.onboard.addEventListener("cancel", (e) => e.preventDefault()); // Esc must not dismiss setup
    // Chrome's close watcher lets a repeated Esc bypass a cancelled `cancel`: reopen.
    els.onboard.addEventListener("close", () => { if (onboardingActive && !els.onboard.open) els.onboard.showModal(); });
    els.obNext.addEventListener("click", () => { void obContinue(); });
    els.obBack.addEventListener("click", obBack);
    els.obSecondary.addEventListener("click", obSecondaryTap);
    els.obLmInput.addEventListener("input", () => obOnInput("lm"));
    els.obOrInput.addEventListener("input", () => obOnInput("or"));
    els.obLmInput.addEventListener("blur", () => obOnBlur("lm"));
    els.obOrInput.addEventListener("blur", () => obOnBlur("or"));
    els.obLmShow.addEventListener("click", () => obToggleShown("lm"));
    els.obOrShow.addEventListener("click", () => obToggleShown("or"));
    els.obAiGroup.addEventListener("change", (e) => {
      const r = e.target instanceof HTMLInputElement ? e.target : null;
      if (!r || r.name !== "obAi") return;
      obChoice = r.value === "free" || r.value === "none" || r.value === "own"
        ? /** @type {"free"|"none"|"own"} */ (r.value) : null;
      obRender();
      if (obChoice === "own") els.obOrInput.focus();
    });
    els.obCutoffRow.addEventListener("click", (e) => {
      const b = e.target instanceof Element ? e.target.closest("[data-cutoff]") : null;
      if (b instanceof HTMLElement && b.dataset.cutoff) obPickCutoff(b.dataset.cutoff);
    });
    els.onboard.addEventListener("keydown", (e) => {
      // Enter in a token field = Continue (when enabled); radios keep their native keys
      if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement) || e.target.type === "radio") return;
      e.preventDefault();
      if (!els.obNext.disabled) void obContinue();
    });
    els.updateBtn.addEventListener("click", applyUpdate);
    els.webBarBtn.addEventListener("click", () => {
      if (els.webBar.dataset.mode === "hint") { openSettingsSheet(null); return; }
      // explicit spend consent: grant allowance for everything currently pending
      webExtraAllowance += Math.max(0, pendingWebKeys().size - webBudget());
      maybeWebCheck(true); // explicit user action: always try the network
    });
    els.stuckBanner.addEventListener("click", onStuckTap);
    els.upgradeBanner.addEventListener("click", () => openSettingsSheet(null));
    els.badgeToggle.addEventListener("change", async () => {
      badgeEnabled = els.badgeToggle.checked;
      try { localStorage.setItem(LS.badge, badgeEnabled ? "1" : "0"); } catch { /* session-only then */ }
      if (badgeEnabled) {
        // Notification permission unlocks setAppBadge on installed iOS; silent no-op elsewhere.
        try {
          if ("Notification" in window && Notification.permission === "default") {
            await Notification.requestPermission();
          }
        } catch { /* silent */ }
      } else {
        setBadge(0);
      }
    });
    // Sound toggles live in Settings AND on the wizard's last step; both drive the
    // same setters, and each mirrors the other so a reopened surface shows the truth.
    els.musicToggle.addEventListener("change", () => setMusicPref(els.musicToggle.checked));
    els.sfxToggle.addEventListener("change", () => setSfxPref(els.sfxToggle.checked));
    els.obMusicToggle.addEventListener("change", () => setMusicPref(els.obMusicToggle.checked));
    els.obSfxToggle.addEventListener("change", () => setSfxPref(els.obSfxToggle.checked));
    els.musicSkip.addEventListener("click", () => music?.skip());
    els.musicBan.addEventListener("click", () => music?.ban());
    els.musicMute.addEventListener("click", () => {
      if (!music) return;
      music.setMuted(!music.muted);
      els.musicMute.textContent = music.muted ? "🔊 Unmute" : "🔇 Mute";
    });

    els.menuAccounts.addEventListener("click", () => { closeMenu(); openAcctSheet(); });
    els.acctClose.addEventListener("click", closeAcctSheet);
    els.acctBody.addEventListener("change", (e) => {
      const cb = e.target instanceof HTMLInputElement ? e.target : null;
      if (!cb || !cb.dataset.acct) return;
      const key = cb.dataset.acct;
      hiddenAccounts = cb.checked ? hiddenAccounts.filter((k) => k !== key) : [...hiddenAccounts, key];
      lsSave(LS.acct, hiddenAccounts);
    });
    els.laterChip.addEventListener("click", openLaterSheet);
    els.laterClose.addEventListener("click", closeLaterSheet);
    els.laterBody.addEventListener("click", (e) => {
      const t = e.target instanceof Element ? e.target : null;
      const b = t?.closest("[data-unpark]");
      if (b instanceof HTMLElement && b.dataset.unpark) unpark(Number(b.dataset.unpark));
    });

    els.celebrate.addEventListener("click", (e) => {
      if (e.target === els.celebrate || e.target === els.celebrateBtn) hideCelebrate();
    });

    // Toggle, light dismiss and Esc all come free from popovertarget + popover="auto";
    // the old manual toggle and outside-click listener would fight them.
    els.menuRefresh.addEventListener("click", () => { closeMenu(); refresh(); });

    document.addEventListener("keydown", (e) => {
      if (onboardingActive) return; // the dialog's own handler owns Enter; card shortcuts must not fire behind it
      if (sheetOpenNow()) {
        const sheet = pickerCtx ? els.pickSheet
          : els.laterSheet.hidden === false ? els.laterSheet
          : els.settingsSheet.hidden === false ? els.settingsSheet
          : els.acctSheet;
        if (e.key === "Escape") {
          if (pickerCtx) resolvePicker(null);
          else if (els.laterSheet.hidden === false) closeLaterSheet();
          else if (els.settingsSheet.hidden === false) closeSettingsSheet();
          else closeAcctSheet();
          return;
        }
        if (e.key === "Tab") { // aria-modal: trap focus inside the sheet
          const focusables = [...sheet.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex='-1']")]
            .filter((n) => n instanceof HTMLElement);
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (!first || !last) return;
          if (e.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
            e.preventDefault(); last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
          } else if (!sheet.contains(document.activeElement)) {
            e.preventDefault(); first.focus();
          }
        }
        return;
      }
      if (!els.celebrate.hidden) { // cards behind the overlay must not take invisible decisions
        if (e.key === "Escape" || e.key === "Enter") hideCelebrate();
        else if (e.key === "u" || e.key === "U") doUndo(); // toast sits above the overlay
        return;
      }
      if (e.key === "ArrowRight") { e.preventDefault(); actAccept(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); actPark(); }
      else if (e.key === "Enter") {
        const t = e.target instanceof Element ? e.target : null;
        if (t?.closest("button, a, input, select, textarea")) return; // native click wins
        actPick();
      } else if (e.key === "u" || e.key === "U") doUndo();
    });

    window.addEventListener("popstate", () => {
      if (ignoreNextPop) { ignoreNextPop = false; return; }
      if (onboardingActive) {
        // hardware back = wizard Back; on the first step the entry is spent and the
        // wizard stays — the next back leaves the PWA, same as with no wizard
        if (sheetHistoryDepth > 0) {
          sheetHistoryDepth--;
          if (prevStep(obSteps, obStep)) {
            obBack();
            try { history.pushState({ dopoOb: true }, ""); sheetHistoryDepth++; } catch { /* sandboxed */ }
          }
        }
        return;
      }
      if (sheetHistoryDepth > 0) {
        sheetHistoryDepth--; // consumed by the back button itself
        if (pickerCtx) resolvePicker(null);
        else if (els.laterSheet.hidden === false) closeLaterSheet();
        else if (els.settingsSheet.hidden === false) closeSettingsSheet();
        else if (els.acctSheet.hidden === false) closeAcctSheet();
      }
    });

    window.addEventListener("pagehide", onHidden);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) onHidden(); else onVisible();
    });

    // connectivity events are HINTS: they recount the chip and trigger a probe;
    // the reducer's verdict only ever moves on real fetch outcomes.
    window.addEventListener("online", () => { connSettle(); scheduleOnlineResync(); });
    window.addEventListener("offline", connSettle);
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted) return; // fresh loads boot through init()
      // bfcache restore: another tab may have moved the queue while we were frozen
      queue = queueLoad();
      connSettle();
      scheduleOnlineResync(); // probe — the frozen tab's verdict is stale
      onVisible();
    });
    window.addEventListener("storage", (e) => {
      if (e.key !== null && e.key !== LS_KEYS.queue) return;
      queue = queueLoad(); // cross-tab queue move: refresh the in-memory view + counts
      updateConnUI();
    });
  }

  // ---------- boot ----------
  /** Offline boot: deck from the last saved snapshot. lastFetchTs stays null and
   *  snapshotIds stays empty ON PURPOSE — decisions made against stale data get
   *  snapshotTs:null, which routes them through the recheck-based replay only
   *  (the no-recheck keepalive flush is structurally unreachable for them).
   *  @param {NonNullable<Awaited<ReturnType<typeof assembleFromSnapshot>>>} snap */
  function enterSnapshotMode(snap) {
    categories = snap.categories;
    catById = new Map(categories.map((c) => [c.id, c]));
    accounts = snap.accounts;
    acctByKey = new Map(accounts.map((a) => [a.key, a]));
    allTxns = /** @type {Txn[]} */ (snap.transactions);
    loadState = "snapshot";
    snapshotFetchedAt = snap.fetchedAt;
    stateError = null;
    backfillRuleNames();
    backlog = eligible(allTxns).sort(byConfDesc);
    dealSet();
    dealAnim = true;
    renderStack();
    updateMeters();
    updateConnUI(); // stale banner + chip; the 5-min refresh interval is the way out
  }

  async function retryLoad() {
    stateError = null;
    renderStack();
    /** @type {unknown} */
    let failure = null;
    try {
      await fetchState();
    } catch (e) {
      failure = e ?? new Error("Couldn't load");
      if (!isNoTokenErr(e) && !isStaleErr(e)) noteConnOutcome("lm", e);
    }
    if (isStaleErr(failure)) return; // superseded by a newer fetch, which owns the outcome — nothing to render
    if (failure !== null) {
      const e = failure;
      // Routed failures (no token / dead token) keep current behavior — onboarding
      // or Settings explain them; a snapshot deck underneath would imply the token
      // still works. Everything else falls back to the offline snapshot.
      const routed = routeLMError(e);
      if (!routed) {
        let snap = null;
        try { snap = await assembleFromSnapshot(rules); } catch { snap = null; }
        if (snap) { enterSnapshotMode(snap); return; }
      }
      // The sheet/onboarding card explains the problem, but the deck must not stay
      // a silent skeleton behind it: render an actionable error card too, so
      // dismissing the sheet leaves a "Try again" path.
      stateError = e instanceof LMError && e.tokenInvalid
        ? new Error("Lunch Money rejected the token")
        : !routed && (connOffline() || !(e instanceof LMError))
          // network-class failure (rejection or captive-portal garbage): friendly
          // copy even before the streak crosses the chip threshold — never parser vomit
          ? new Error("You're offline — dopo needs one online visit to get your transactions")
          : e instanceof Error ? e : new Error("Couldn't load");
      renderStack();
      return;
    }
    backfillRuleNames(); // names for rules created during boot replay (catById was empty)
    maybeSuggestionToast(); // "N suggestions ready" since last visit
    backlog = eligible(allTxns).sort(byConfDesc);
    dealSet();
    dealAnim = true;
    renderStack();
    updateMeters();
    ensureClassified();
  }

  async function init() {
    bindUI();
    setupServiceWorker();
    setBadge(0); // badge means "remaining at last close" — clear on open
    // Best-effort eviction protection for the queue/snapshot (browser may ignore it).
    try { navigator.storage?.persist?.().catch(() => { /* advisory only */ }); } catch { /* unsupported */ }
    // Later pile: pointers in localStorage, bodies in IndexedDB; lib/store.js
    // migrates legacy full-txn entries and compacts evicted pointers itself.
    try {
      later = /** @type {Txn[]} */ (/** @type {unknown} */ (await laterLoad()));
    } catch { later = []; }
    updateLaterChip();
    updateStreakUI(false);
    renderStack(); // loading skeleton
    updateMeters();
    updateConnUI(); // last session's queue may already warrant the offline chip

    // The wizard runs for a first visit (no LM token) and for an interrupted setup
    // (cursor). It triggers the queue replay and the first fetch from its own steps;
    // the plain boot does 1) replay, 2) fetch state, 3) deal.
    if (!tokens.lm || onboardCursorLoad()) {
      showOnboarding();
    } else {
      await replayIfNeeded();
      await retryLoad();
    }

    setInterval(() => {
      // KEEPS RUNNING while offline — this interval and onVisible are the recovery
      // probes; the unreliable `online` event must never be the only way back.
      if (!document.hidden && !sheetOpenNow() && !dragCtx && !onboardingActive) refresh();
    }, REFRESH_EVERY_MS);
  }

  init();
}
