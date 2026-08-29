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
export { cardHTML, esc, splitEmoji, fmtAmount, fmtAmountText, isConfident, CONFIDENT_AT } from "./lib/card.js";

import { LMError, applyCategories, getMe, getState, getTransaction, KEEPALIVE_MAX_ITEMS } from "./lib/lm.js";
import { ORError, checkKey } from "./lib/classify.js";
import {
  getTokens, setTokens, clearTokens,
  queueLoad, queueSave, queueMutate, keepaliveEligible, LS_KEYS,
  snapshotPrune,
  laterLoad, laterAdd, laterRemove,
  rulesLoad, ruleAdd, rulesSave,
} from "./lib/store.js";
import { replayQueue, isPoisonStatus, STUCK_AFTER_ATTEMPTS } from "./lib/sync.js";
import { assembleState, assembleFromSnapshot, classifyPass1, webCheck, merchantKeyOf } from "./data.js";
import {
  esc, splitEmoji, fmtAmountText, isConfident as cardConfident, cardHTML, CONFIDENT_AT,
} from "./lib/card.js";

/** @typedef {import("./data.js").DeckTxn} Txn */
/** @typedef {import("./data.js").UISuggestion} UISuggestion */
/** @typedef {import("./data.js").Category} Category */
/** @typedef {import("./lib/lm.js").LMAccount} Account */
/** @typedef {import("./lib/store.js").QueueItem} QueueItem */
/** @typedef {import("./lib/rules.js").Rule} Rule */
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
   *  is the load-bearing part: it merges concurrent table-tab/other-tab writes
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
  let onboardingActive = false; // missing LM token -> "Connect Lunch Money" card
  /** @type {Set<"lm"|"or">} */
  const deadTokenNoted = new Set(); // dead tokens already routed to Settings this session
  let sugToastShown = false; // "N suggestions ready" fires at most once per visit
  let badgeEnabled = false;
  try { badgeEnabled = localStorage.getItem(LS.badge) === "1"; } catch { /* default off */ }
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
    badgeToggle: $input("#badgeToggle"), settingsError: $el("#settingsError"), menuSettings: $btn("#menuSettings"),
    onboardCard: $el("#onboardCard"), onboardOpen: $btn("#onboardOpen"),
    webBar: $el("#webBar"), webBarBtn: $btn("#webBarBtn"),
    connChip: $el("#connChip"), staleBanner: $el("#staleBanner"), stuckBanner: $btn("#stuckBanner"),
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
    els.note.textContent = msg;
    els.note.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { els.note.hidden = true; }, ms);
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
    const data = await assembleState(tokens.lm, rules);
    categories = data.categories;
    catById = new Map(categories.map((c) => [c.id, c]));
    accounts = data.accounts;
    acctByKey = new Map(accounts.map((a) => [a.key, a]));
    allTxns = data.transactions;
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
  async function ensureClassified() {
    // AUTOMATIC classification is live-mode + online only (snapshot decks already
    // carry cached suggestions; hammering a dead network helps nobody). Explicit
    // user actions reach the network via refresh()/maybeWebCheck(true) instead.
    if (classifyRunning || loadState !== "live" || connOffline()) return;
    const unsuggested = [...set, ...backlog].filter((t) => !t.suggestion);
    if (!unsuggested.length) { maybeWebCheck(); return; }
    if (!tokens.or) { updateWebBar(); return; } // LM-only mode: bar offers the Settings path
    classifyRunning = true;
    renderStack();
    try {
      await classifyPass1(tokens.or, categories, unsuggested, absorbPass1Slice);
      noteConnOutcome("or", null);
    } catch (e) {
      noteConnOutcome("or", e);
      if (!routeORError(e) && !connOffline()) note("Classifier hiccup — will retry later");
    } finally {
      classifyRunning = false;
      // reached the end while the user emptied the deck -> celebrate now
      if (loadState === "live" && !set.length && !backlog.length && decisions > 0) celebrateInboxZero();
      renderStack(); updateMeters();
      maybeWebCheck();
    }
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
      const wantsAI = !!tokens.lm && [...set, ...backlog].some((t) => !t.suggestion || webCandidateKey(t));
      if (wantsAI) {
        els.webBarBtn.textContent = "Add an OpenRouter key in Settings to enable AI suggestions";
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
    if (refreshing || loadState === "none" || sheetOpenNow()) return;
    refreshing = true;
    try {
      await flush("refresh");
      await fetchState();
      reconcile(); // behind the top card only
      ensureClassified();
    } catch (e) {
      if (!isNoTokenErr(e)) noteConnOutcome("lm", e);
      routeLMError(e);
      // unrouted network errors: silent, next refresh will retry (recovery probe)
    } finally {
      refreshing = false;
    }
  }

  // ---------- connectivity reducer (fetch outcomes are truth; events are probes) ----------
  /** Local pre-fetch error (missing token): never a network outcome. @param {unknown} e */
  const isNoTokenErr = (e) => e instanceof Error && /** @type {Error & {noToken?: boolean}} */ (e).noToken === true;

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
    const win = await getState(lmToken);
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
    if (decisions % 10 === 0) { confetti(90); haptic([14, 50, 14]); }
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
      updateActionButtons();
      return;
    }

    const dealing = dealAnim && !reducedMotion;
    dealAnim = false;
    want.forEach((t, i) => {
      let el = kept.get(String(t.id)) ?? null;
      // Refresh card content when a suggestion arrived. Peek cards always; the TOP
      // card only while idle (no drag, no picker, not lifted) — a lazy web-check
      // result must be able to land on the card the user is looking at.
      const topIdle = i === 0 && !dragCtx && !pickerCtx &&
        !!el && !el.classList.contains("lifted") && !el.classList.contains("flying");
      if (el && el.dataset.sig !== cardSig(t) && (i > 0 || topIdle)) { el.remove(); el = null; }
      if (!el) { el = buildCard(t); stack.appendChild(el); }
      const wasTop = el.classList.contains("c0");
      el.classList.remove("c0", "c1", "c2");
      el.classList.add(`c${i}`);
      if (dealing) {
        const dealEl = el;
        dealEl.classList.add("dealing", `deal-${i}`);
        dealEl.addEventListener("animationend", () => dealEl.classList.remove("dealing", `deal-${i}`), { once: true });
      }
      if (i === 0) {
        if (!dealing && !wasTop && !reducedMotion) {
          const settleEl = el;
          settleEl.classList.add("settling");
          setTimeout(() => settleEl.classList.remove("settling"), 500);
        }
        if (!el.dataset.dragBound) { attachDrag(el); el.dataset.dragBound = "1"; }
      }
    });
    if (dealing) dustBlast();
    updateActionButtons();
  }

  /** Impact dust when the deck lands — cards should feel heavy. */
  function dustBlast() {
    const stackR = els.stack.getBoundingClientRect();
    setTimeout(() => {
      haptic([18, 40, 10]);
      const dust = document.createElement("div");
      dust.className = "dust";
      dust.style.left = `${stackR.left + stackR.width / 2}px`;
      dust.style.top = `${stackR.bottom - 10}px`;
      for (let i = 0; i < 10; i++) {
        const p = document.createElement("i");
        const ang = Math.PI + (i / 9) * Math.PI; // fan out along the bottom edge
        p.style.setProperty("--dx", `${Math.cos(ang) * (30 + (i % 3) * 26)}px`);
        p.style.setProperty("--dy", `${-8 - (i % 4) * 7}px`);
        p.style.setProperty("--ds", `${0.5 + (i % 3) * 0.35}`);
        p.style.animationDelay = `${(i % 5) * 22}ms`;
        dust.appendChild(p);
      }
      document.body.appendChild(dust);
      setTimeout(() => dust.remove(), 900);
    }, 300); // sync with the drop keyframe's impact moment
  }

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
    el.classList.remove("settling");
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
  /** @param {HTMLElement} sheet */
  function closeSheet(sheet) {
    consumeSheetHistory();
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
          <div class="later-sub">${esc(fmtAmountText(t))} · ${esc(t.date || "")}</div>
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
      : "Web checks (pass 2) need an OpenRouter key.";
    els.webCheckLine.hidden = false;
  }

  let saveAnywayArmed = false; // second tap saves unverified after a network-class validation failure
  function disarmSaveAnyway() {
    saveAnywayArmed = false;
    els.settingsSave.textContent = "Save";
  }

  /** @param {"lm"|"or"|null} deadField  names the token the upstream just rejected */
  function openSettingsSheet(deadField) {
    els.menuPop.hidden = true;
    els.lmTokenInput.value = "";
    els.orTokenInput.value = "";
    disarmSaveAnyway();
    clearSettingsErrors();
    els.lmTokenHint.textContent = "Configured ✓ — paste to replace";
    els.lmTokenHint.hidden = !tokens.lm || deadField === "lm";
    els.orTokenHint.textContent = "Configured ✓ — paste to replace";
    els.orTokenHint.hidden = !tokens.or || deadField === "or";
    els.budgetLine.hidden = true;
    els.forgetBtn.hidden = !tokens.lm && !tokens.or;
    els.badgeToggle.checked = badgeEnabled;
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
  function closeSettingsSheet() { closeSheet(els.settingsSheet); }

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
    if (!lm && !or) { setSettingsError("Paste at least one token to save."); return; }
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
      try { setTokens({ ...(lm ? { lm } : {}), ...(or ? { or } : {}) }); } catch { storageFailed(); }
      tokens = getTokens();
      saveAnywayArmed = false;
      if (lm) deadTokenNoted.delete("lm");
      if (or) deadTokenNoted.delete("or");
      els.lmTokenInput.value = "";
      els.orTokenInput.value = "";
      note("Saved ✓");
      closeSettingsSheet();
      if (onboardingActive) hideOnboarding();
      // let the close animation land, then (re)load with the new tokens
      setTimeout(() => {
        if (loadState !== "none") { refresh(); updateWebBar(); } else retryLoad(); // snapshot takes the refresh() arm
      }, reducedMotion ? 200 : 420);
    } catch (e) {
      setSettingsError((e instanceof Error && e.message) || "Couldn't save — try again.");
    } finally {
      els.settingsSave.disabled = false;
      els.settingsSave.textContent = saveAnywayArmed ? "Save anyway (couldn't verify)" : "Save";
    }
  }

  /** "Forget tokens on this device" — clears tokens only; queue/rules/caches stay. */
  function onForgetTokens() {
    clearTokens();
    tokens = getTokens();
    disarmSaveAnyway();
    els.lmTokenHint.hidden = true;
    els.orTokenHint.hidden = true;
    els.budgetLine.hidden = true;
    els.forgetBtn.hidden = true;
    clearSettingsErrors();
    deadTokenNoted.clear();
    updateWebCheckLine();
    updateWebBar();
    note("Tokens forgotten on this device");
    showOnboarding();
  }

  // ---------- onboarding (missing LM token) ----------
  function showOnboarding() {
    if (onboardingActive) return;
    onboardingActive = true;
    els.onboardCard.hidden = false;
  }
  function hideOnboarding() {
    onboardingActive = false;
    els.onboardCard.hidden = true;
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
    if (sheetOpenNow() || dragCtx) { updateToastPending = true; return; } // suppressed, resurfaces later
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
    if (e instanceof Error && /** @type {Error & {noToken?: boolean}} */ (e).noToken) {
      showOnboarding();
      return true;
    }
    if (e instanceof LMError && e.tokenInvalid) {
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
      if (!deadTokenNoted.has("or")) {
        deadTokenNoted.add("or");
        if (sheetOpenNow()) note("OpenRouter key stopped working — see Settings");
        else openSettingsSheet("or");
      }
      return true;
    }
    return false;
  }

  // ---------- lifecycle ----------
  function onHidden() {
    lastHiddenAt = Date.now();
    // 1) clear undo state SYNCHRONOUSLY — its item stays non-flushable
    clearUndoForHidden();
    // 2) keepalive flush of current-snapshot flushable items only; the rest stays
    //    in localStorage (recheck-based replay covers it on next open)
    flush("hidden");
    // 3) badge = remaining at close; suggestion stamp = seen through this visit.
    //    Both LIVE only — a snapshot deck's counts describe stale data.
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
    if (lastHiddenAt && Date.now() - lastHiddenAt > REFRESH_AWAY_MS) {
      // A resumed installed-PWA session counts as a fresh visit: re-arm the
      // "N suggestions ready" toast so cached results surface without a reload.
      sugToastShown = false;
      refresh().then(() => maybeSuggestionToast());
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

    els.menuSettings.addEventListener("click", () => { els.menuPop.hidden = true; openSettingsSheet(null); });
    els.settingsClose.addEventListener("click", closeSettingsSheet);
    els.settingsSave.addEventListener("click", saveSettings);
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
    els.onboardOpen.addEventListener("click", () => openSettingsSheet(null));
    els.updateBtn.addEventListener("click", applyUpdate);
    els.webBarBtn.addEventListener("click", () => {
      if (els.webBar.dataset.mode === "hint") { openSettingsSheet(null); return; }
      // explicit spend consent: grant allowance for everything currently pending
      webExtraAllowance += Math.max(0, pendingWebKeys().size - webBudget());
      maybeWebCheck(true); // explicit user action: always try the network
    });
    els.stuckBanner.addEventListener("click", onStuckTap);
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

    els.menuAccounts.addEventListener("click", () => { els.menuPop.hidden = true; openAcctSheet(); });
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

    els.menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      els.menuPop.hidden = !els.menuPop.hidden;
    });
    document.addEventListener("click", (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!els.menuPop.hidden && !t?.closest(".menu")) els.menuPop.hidden = true;
    });
    els.menuRefresh.addEventListener("click", () => { els.menuPop.hidden = true; refresh(); });

    document.addEventListener("keydown", (e) => {
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
      if (!isNoTokenErr(e)) noteConnOutcome("lm", e);
    }
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
    if (onboardingActive) hideOnboarding(); // state loads fine now — the token works
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

    if (!tokens.lm) showOnboarding();

    // 1) replay the persisted queue first — lib/sync.js owns the lock scope, the
    //    single membership recheck, and poison isolation; app.js keeps only the UI
    //    routing. Items that had live undo toasts at death are included (replay
    //    marks everything flushable). Server-era items (snapshotTs null) replay
    //    through the same recheck.
    if (queue.length && tokens.lm) {
      bootReplaying = true; // flush() no-ops meanwhile — an `online` event mid-replay
      // must not double-send the same items and mis-announce them as "already done"
      try {
        const res = await replayQueue(tokens.lm, {
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

    // 2) fetch state, 3) deal
    await retryLoad();

    setInterval(() => {
      // KEEPS RUNNING while offline — this interval and onVisible are the recovery
      // probes; the unreliable `online` event must never be the only way back.
      if (!document.hidden && !sheetOpenNow() && !dragCtx) refresh();
    }, REFRESH_EVERY_MS);
  }

  init();
}
