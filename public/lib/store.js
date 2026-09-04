// @ts-check
/**
 * On-device storage.
 *
 * localStorage (small, synchronous, survives most evictions):
 *   - tokens               dopo.tokens.v1
 *   - apply queue          dopo.queue.v1   (format UNCHANGED from the server era —
 *                          old queued items must replay through the new client)
 *   - Later pile POINTERS  dopo.later.v1   (ids; legacy full-txn entries still accepted)
 *   - rules                dopo.rules.v1
 *   - deck cutoff preset   dopo.cutoff.v1
 *   - audio prefs          dopo.audio.v1
 *   - music shuffle bag    dopo.music.v1
 *   - onboarding cursor    dopo.onboard.v1 (wizard step id; cleared with the tokens)
 *   - category picker      dopo.picker.v1  (variant id; a device preference — SURVIVES
 *                          clearTokens, so re-pasting a token never resets the UI)
 *   - category hues        dopo.hues.v1    (key -> hue 0..359; what makes category
 *                          colours learnable, so it survives clearTokens too)
 *
 * IndexedDB (bulk, async): suggestion cache + Later txn bodies (~2000-entry LRU,
 * per-entry writes) + the offline state snapshot. Falls back to in-memory Maps
 * (same API, session-only) when IndexedDB is unavailable or breaks mid-flight —
 * the app must never brick on storage.
 *
 * Everything is shape-validated on read (lsLoad-style): corrupted storage degrades
 * to the fallback value; read paths never throw. WRITE paths throw on quota /
 * private-mode failure so callers can switch to eager-flush mode.
 */

import { isRule } from "./rules.js";
import { CUTOFF_PRESETS, DEFAULT_CUTOFF, cutoffRange } from "./lm.js";
import { parseStep } from "./onboard.js";
import { parsePicker } from "./picker.js";

export const LS_KEYS = {
  tokens: "dopo.tokens.v1",
  queue: "dopo.queue.v1",
  later: "dopo.later.v1",
  rules: "dopo.rules.v1",
  cutoff: "dopo.cutoff.v1",
  audio: "dopo.audio.v1",
  music: "dopo.music.v1",
  onboard: "dopo.onboard.v1",
  picker: "dopo.picker.v1",
  hues: "dopo.hues.v1",
};

// ---------------------------------------------------------------------------
// localStorage primitives
// ---------------------------------------------------------------------------

/**
 * @param {string} key
 * @returns {unknown}
 */
function lsGet(key) {
  // corrupted storage (partial write, extensions) must degrade, not brick boot
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {unknown} value
 * @throws when the write failed (quota / private mode) — callers compensate by
 *   flushing eagerly, exactly like the old storageDegraded path.
 */
function lsSet(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

/** @param {string} key */
function lsRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to remove / no storage */
  }
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Tokens
 * @property {string|null} lm  Lunch Money API token (required for the app to work)
 * @property {string|null} or  OpenRouter key (optional — LM-only mode without it)
 */

/** @returns {Tokens} */
export function getTokens() {
  const v = lsGet(LS_KEYS.tokens);
  if (typeof v !== "object" || v === null) return { lm: null, or: null };
  const o = /** @type {Record<string, unknown>} */ (v);
  return {
    lm: typeof o.lm === "string" && o.lm ? o.lm : null,
    or: typeof o.or === "string" && o.or ? o.or : null,
  };
}

/**
 * MERGE semantics: only the fields present are replaced, so saving a new LM token
 * never silently drops the stored OpenRouter key (and vice versa).
 * @param {{lm?: string|null, or?: string|null}} partial
 */
export function setTokens(partial) {
  const cur = getTokens();
  lsSet(LS_KEYS.tokens, {
    lm: partial.lm !== undefined ? partial.lm : cur.lm,
    or: partial.or !== undefined ? partial.or : cur.or,
  });
}

/** "Forget tokens on this device" — clears tokens ONLY; queue/rules/caches stay.
 *  The onboarding cursor goes with them: without tokens the wizard restarts from
 *  its returning path, and a stale "done" cursor would resume past the token step. */
export function clearTokens() {
  lsRemove(LS_KEYS.tokens);
  lsRemove(LS_KEYS.onboard);
}

// ---------------------------------------------------------------------------
// apply queue — format dopo.queue.v1, UNCHANGED and back-compatible
// ---------------------------------------------------------------------------

/**
 * @typedef {object} QueueItem
 * @property {number} id
 * @property {number} category_id
 * @property {{pattern: string, match_type: "contains"|"exact"}} [make_rule]
 * @property {number} ts
 * @property {boolean} flushable
 * @property {boolean} sent
 * @property {number|null} snapshotTs  timestamp of the last successful state fetch the
 *   decision was made against. Legacy items (server era) lack it — normalized to null,
 *   which never equals a live snapshot: they are "old session" and only ever flush
 *   through the recheck-based replay path, never the keepalive hidden flush.
 * @property {string} [stuck]  reason a poison item was parked with flushable:false
 *   after repeated rejected PUTs (lib/sync.js). Optional — absent on healthy items,
 *   so the dopo.queue.v1 format stays back-compatible.
 */

/** @returns {QueueItem[]} */
export function queueLoad() {
  const v = lsGet(LS_KEYS.queue);
  if (!Array.isArray(v)) return [];
  /** @type {QueueItem[]} */
  const out = [];
  for (const it of v) {
    if (typeof it !== "object" || it === null) continue;
    const o = /** @type {Record<string, unknown>} */ (it);
    if (typeof o.id !== "number" || typeof o.category_id !== "number") continue;
    /** @type {QueueItem} */
    const item = {
      id: o.id,
      category_id: o.category_id,
      ts: typeof o.ts === "number" ? o.ts : 0,
      flushable: o.flushable === true,
      sent: o.sent === true,
      snapshotTs: typeof o.snapshotTs === "number" ? o.snapshotTs : null,
    };
    if (typeof o.stuck === "string") item.stuck = o.stuck;
    if (
      typeof o.make_rule === "object" &&
      o.make_rule !== null &&
      typeof (/** @type {Record<string, unknown>} */ (o.make_rule).pattern) === "string"
    ) {
      const mr = /** @type {Record<string, unknown>} */ (o.make_rule);
      item.make_rule = {
        pattern: /** @type {string} */ (mr.pattern),
        match_type: mr.match_type === "exact" ? "exact" : "contains",
      };
    }
    out.push(item);
  }
  return out;
}

/**
 * @param {QueueItem[]} queue
 * @throws on storage failure (quota / private mode)
 */
export function queueSave(queue) {
  lsSet(LS_KEYS.queue, queue);
}

/**
 * Collapse duplicate ids — max ts wins. Two tabs queuing the same txn with
 * different categories must never produce one PUT body with duplicate ids.
 * First-occurrence order per id is preserved.
 * @param {QueueItem[]} items
 * @returns {QueueItem[]}
 */
function queueCollapse(items) {
  /** @type {Map<number, QueueItem>} */
  const byId = new Map();
  for (const it of items) {
    const prev = byId.get(it.id);
    if (!prev || it.ts >= prev.ts) byId.set(it.id, it);
  }
  return [...byId.values()];
}

/**
 * Slow-path queue writes (replay, interactive-flush persistence steps) —
 * multi-step read-modify-write under `navigator.locks` "dopo.queue".
 * Decision-path writes (decide/undo/pagehide) stay synchronous inline merges and
 * must NOT come through here (async lock callbacks may never run in teardown).
 *
 * `fn` MUST be synchronous (no awaits between load and save — the no-locks
 * fallback would reintroduce the clobber otherwise). It receives the FRESH
 * queue; return a replacement array, or mutate in place and return undefined.
 * Item identity is (id, ts): mutate by lookup on the fresh array, never through
 * stale object references. Fallback without navigator.locks (older Safari, bun
 * tests): run fn unlocked but still fresh-read-merged.
 *
 * NEVER hold this lock across network I/O — lock per persistence step.
 *
 * @param {(queue: QueueItem[]) => QueueItem[]|void} fn
 * @returns {Promise<QueueItem[]>} the collapsed queue as saved
 * @throws on storage failure (quota / private mode), like queueSave
 */
export async function queueMutate(fn) {
  const run = () => {
    const fresh = queueLoad();
    const ret = fn(fresh);
    const next = queueCollapse(Array.isArray(ret) ? ret : fresh);
    queueSave(next);
    return next;
  };
  const hasLocks =
    typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function";
  if (hasLocks) return navigator.locks.request("dopo.queue", async () => run());
  return run();
}

/** Snapshot freshness bound for the keepalive flush: 2 * the 5-min refresh cadence. */
export const KEEPALIVE_SNAPSHOT_FRESH_MS = 10 * 60 * 1000;

/**
 * Items safe for the hidden/pagehide keepalive flush: flushable AND decided against
 * the CURRENT session's snapshot AND that snapshot is fresh (< 10 min old — a sheet
 * left open all afternoon must not skip the recheck on stale eligibility).
 * Old-session items (including legacy null) stay queued for the recheck-based
 * replay on next open.
 * @param {QueueItem[]} queue
 * @param {number|null} currentSnapshotTs
 * @param {number} [now]
 * @returns {QueueItem[]}
 */
export function keepaliveEligible(queue, currentSnapshotTs, now = Date.now()) {
  if (currentSnapshotTs === null) return [];
  if (now - currentSnapshotTs >= KEEPALIVE_SNAPSHOT_FRESH_MS) return [];
  return queue.filter((it) => it.flushable && it.snapshotTs === currentSnapshotTs);
}

// ---------------------------------------------------------------------------
// rules — per-device, matched by lib/rules.js
// ---------------------------------------------------------------------------

/** @returns {import("./rules.js").Rule[]} */
export function rulesLoad() {
  const v = lsGet(LS_KEYS.rules);
  if (!Array.isArray(v)) return [];
  return v.filter(isRule);
}

/**
 * @param {import("./rules.js").Rule[]} rules
 * @throws on storage failure
 */
export function rulesSave(rules) {
  lsSet(LS_KEYS.rules, rules.filter(isRule));
}

/**
 * Append one rule; assigns a device-unique id + created_at when absent.
 * Dedupes by (pattern case-insensitive, match_type, category_id): replaying the
 * same make_rule twice (or from two tabs) returns the EXISTING rule, no write.
 * @param {{pattern: string, match_type?: "contains"|"exact", category_id: number, id?: number, category_name?: string}} rule
 * @returns {import("./rules.js").Rule}
 * @throws on storage failure
 */
export function ruleAdd(rule) {
  const existing = rulesLoad();
  const mt = rule.match_type === "exact" ? "exact" : "contains";
  const dup = existing.find(
    (r) =>
      r.pattern.toLowerCase() === rule.pattern.toLowerCase() &&
      r.match_type === mt &&
      r.category_id === rule.category_id,
  );
  if (dup) return dup;
  /** @type {import("./rules.js").Rule} */
  const full = {
    id: typeof rule.id === "number" ? rule.id : Date.now() + Math.floor(Math.random() * 1000),
    pattern: rule.pattern,
    match_type: rule.match_type === "exact" ? "exact" : "contains",
    category_id: rule.category_id,
    ...(rule.category_name ? { category_name: rule.category_name } : {}),
    hits: 0,
    created_at: new Date().toISOString(),
  };
  rulesSave([...existing, full]);
  return full;
}

// ---------------------------------------------------------------------------
// deck cutoff — how far back the Lunch Money fetch window reaches
// ---------------------------------------------------------------------------

/** @returns {import("./lm.js").CutoffId} */
export function cutoffLoad() {
  const v = lsGet(LS_KEYS.cutoff);
  return CUTOFF_PRESETS.some((p) => p.id === v)
    ? /** @type {import("./lm.js").CutoffId} */ (v)
    : DEFAULT_CUTOFF;
}

/**
 * @param {string} id  ignored (default kept) when it isn't a known preset
 * @throws on storage failure
 */
export function cutoffSave(id) {
  lsSet(LS_KEYS.cutoff, CUTOFF_PRESETS.some((p) => p.id === id) ? id : DEFAULT_CUTOFF);
}

// ---------------------------------------------------------------------------
// onboarding cursor — which wizard step to resume at (app.js decides whether
// the wizard shows at all: `!tokens.lm || cursor`)
// ---------------------------------------------------------------------------

/** @returns {import("./onboard.js").StepId|null}  unknown / corrupted → null (no resume) */
export function onboardCursorLoad() {
  return parseStep(lsGet(LS_KEYS.onboard));
}

/**
 * @param {string} id  an unknown step id CLEARS the cursor instead of persisting
 *   garbage — resuming nowhere beats resuming at a step that no longer exists
 * @throws on storage failure
 */
export function onboardCursorSave(id) {
  const step = parseStep(id);
  if (step === null) { lsRemove(LS_KEYS.onboard); return; }
  lsSet(LS_KEYS.onboard, step);
}

export function onboardCursorClear() {
  lsRemove(LS_KEYS.onboard);
}

// ---------------------------------------------------------------------------
// category picker — which picker variant, and the persisted per-category hues.
// Both are DEVICE PREFERENCES, not credentials: clearTokens() deliberately
// leaves them alone. Re-pasting a token must not reshuffle every colour the
// user has learned, nor silently move them back to a different picker.
// ---------------------------------------------------------------------------

/**
 * @returns {import("./picker.js").PickerId|null}  null when unset or corrupted —
 *   the caller resolves the default (new installs `tiles`, pre-feature installs
 *   `list`), which needs to distinguish "never chose" from "chose".
 */
export function pickerLoad() {
  return parsePicker(lsGet(LS_KEYS.picker));
}

/**
 * @param {string} id  an unknown variant CLEARS the preference rather than
 *   persisting garbage that would read back as null on every boot anyway
 * @throws on storage failure
 */
export function pickerSave(id) {
  const v = parsePicker(id);
  if (v === null) { lsRemove(LS_KEYS.picker); return; }
  lsSet(LS_KEYS.picker, v);
}

/** Hue map cap: enough for any realistic category tree, bounded so a long-lived
 *  install can't grow the entry without limit (see huesSave). */
export const HUES_MAX_KEYS = 512;

/**
 * Persisted hues, keyed by node key (`c:<id>` / `g:<group name>`).
 * @returns {Record<string, number>}  values are integers 0..359; entries that
 *   aren't drop out individually — one bad entry must not cost the whole map,
 *   because losing the map means every colour the user learned changes.
 */
export function huesLoad() {
  const v = lsGet(LS_KEYS.hues);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, raw] of Object.entries(/** @type {Record<string, unknown>} */ (v))) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 359) continue;
    out[k] = raw;
  }
  return out;
}

/**
 * @param {Record<string, number>} map  non-finite / non-number values are dropped;
 *   finite ones are rounded and WRAPPED into 0..359 rather than dropped — a hue is
 *   an angle, and dropping a key would silently recolour that category on the next
 *   load, which is exactly the thing this map exists to prevent. Over the cap the
 *   OLDEST insertion-order keys go first (a snapshot boot sees a subset of the
 *   tree, so pruning by "not in the current tree" would be wrong).
 * @throws on storage failure — callers may degrade to in-memory hues
 */
export function huesSave(map) {
  /** @type {Record<string, number>} */
  const clean = {};
  if (typeof map === "object" && map !== null) {
    for (const [k, raw] of Object.entries(map)) {
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      clean[k] = ((Math.round(raw) % 360) + 360) % 360;
    }
  }
  const keys = Object.keys(clean);
  if (keys.length > HUES_MAX_KEYS) {
    for (const k of keys.slice(0, keys.length - HUES_MAX_KEYS)) delete clean[k];
  }
  lsSet(LS_KEYS.hues, clean);
}

// ---------------------------------------------------------------------------
// audio — chiptune music + sound effects, both opt-in
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AudioPrefs
 * @property {boolean} music  background chiptune enabled
 * @property {boolean} sfx    synthesized sound effects enabled
 */

/** @returns {AudioPrefs} both OFF by default — audio is strictly opt-in */
export function audioLoad() {
  const v = lsGet(LS_KEYS.audio);
  const o = typeof v === "object" && v !== null ? /** @type {Record<string, unknown>} */ (v) : {};
  return { music: o.music === true, sfx: o.sfx === true };
}

/**
 * @param {AudioPrefs} prefs
 * @throws on storage failure — callers degrade to session-only prefs
 */
export function audioSave(prefs) {
  lsSet(LS_KEYS.audio, { music: prefs.music === true, sfx: prefs.sfx === true });
}

/**
 * Raw persisted shuffle-bag state; lib/shuffle.js normalizeState() owns the
 * shape validation because it also reconciles against the live manifest.
 * @returns {unknown}
 */
export function musicStateLoad() {
  return lsGet(LS_KEYS.music);
}

/**
 * @param {import("./shuffle.js").MusicState} state
 * @throws on storage failure — the bag then simply restarts next session
 */
export function musicStateSave(state) {
  lsSet(LS_KEYS.music, state);
}

/**
 * The stored window, in `getState`/`applyCategories` opts shape. Every LM fetch —
 * the deck AND every membership recheck — goes through this so they page the SAME
 * range. A recheck narrower than the decisions it validates is still correct (misses
 * fall back to per-id GETs, see lib/lm.js applyCategories) but costs a round trip
 * each, so they must not drift apart.
 * @returns {{startDate: string, endDate: string}}
 */
export function fetchWindow() {
  const { start, end } = cutoffRange(cutoffLoad());
  return { startDate: start, endDate: end };
}

// ---------------------------------------------------------------------------
// Later pile — pointers in localStorage, bodies in IndexedDB
// ---------------------------------------------------------------------------

/**
 * Low-level pointer read (exported for tests/migration).
 * @returns {{ids: number[], legacyTxns: (Record<string, unknown> & {id: number})[]}}
 *   `legacyTxns`: full txn objects from the pre-static format, surfaced so their
 *   bodies can migrate into IndexedDB.
 */
export function loadLater() {
  const v = lsGet(LS_KEYS.later);
  if (!Array.isArray(v)) return { ids: [], legacyTxns: [] };
  /** @type {number[]} */
  const ids = [];
  /** @type {(Record<string, unknown> & {id: number})[]} */
  const legacyTxns = [];
  for (const it of v) {
    if (typeof it === "number") ids.push(it);
    else if (typeof it === "object" && it !== null && typeof (/** @type {Record<string, unknown>} */ (it).id) === "number") {
      const o = /** @type {Record<string, unknown> & {id: number}} */ (it);
      ids.push(o.id);
      legacyTxns.push(o);
    }
  }
  return { ids, legacyTxns };
}

/**
 * @param {number[]} ids
 * @throws on storage failure
 */
export function saveLaterIds(ids) {
  lsSet(LS_KEYS.later, ids.filter((id) => typeof id === "number"));
}

/**
 * Full Later pile: pointers from localStorage, bodies from IndexedDB.
 * Legacy full-txn entries are migrated (bodies moved to IndexedDB, pointers kept).
 * Bodies evicted by the browser are dropped along with their pointers — losing a
 * parked card body is survivable; a phantom pointer is not.
 *
 * Pointer compaction is FORBIDDEN when any later op fell back to memory this
 * session (memory-only mode included): a body that merely couldn't be READ is not
 * a body that is gone, and compacting on it would wipe the pile.
 * @returns {Promise<(Record<string, unknown> & {id: number})[]>}
 */
export async function laterLoad() {
  const { ids, legacyTxns } = loadLater();
  for (const t of legacyTxns) await laterPut(t);
  const bodies = await laterGetAll(ids);
  // evaluate AFTER the reads/migration above — they may have tripped the flag
  const canCompact = !memoryOnly && !laterFellBack;
  if (canCompact && (bodies.length !== ids.length || legacyTxns.length)) {
    try {
      saveLaterIds(bodies.map((t) => t.id));
    } catch {
      /* pointer compaction is best-effort */
    }
  }
  return bodies;
}

/**
 * Park a txn: pointer synchronously (throws on quota so the caller can react),
 * body write is async best-effort.
 * @param {Record<string, unknown> & {id: number}} txn
 * @throws on pointer storage failure
 */
export function laterAdd(txn) {
  if (typeof txn !== "object" || txn === null || typeof txn.id !== "number") return;
  const { ids } = loadLater();
  if (!ids.includes(txn.id)) saveLaterIds([...ids, txn.id]);
  void laterPut(txn).catch(() => {});
}

/**
 * Unpark: pointer removed synchronously, body delete async best-effort.
 * @param {number} id
 * @throws on pointer storage failure
 */
export function laterRemove(id) {
  const { ids } = loadLater();
  if (ids.includes(id)) saveLaterIds(ids.filter((x) => x !== id));
  void laterDelete(id).catch(() => {});
}

// ---------------------------------------------------------------------------
// IndexedDB: suggestion cache (LRU) + Later bodies, with in-memory fallback
// ---------------------------------------------------------------------------

const DB_NAME = "dopo";
// v2 adds the offline state snapshot store; v1 stores carry over untouched.
const DB_VERSION = 2;
const SUG_STORE = "suggestions";
const LATER_STORE = "later";
const SNAP_STORE = "snapshot";
const SNAP_KEY = "state";
// Tiny sidecar bumped instead of re-putting the multi-MB state record when the
// content is unchanged (IDB structured-clones the whole value on every put).
const SNAP_META_KEY = "state-meta";
/** ~2000 entries keeps the cache well under any browser quota while covering months. */
export const CACHE_MAX_ENTRIES = 2000;
/** Per-op watchdog: a v1→v2 upgrade blocked by another open tab must degrade the
 *  CALL, not the session — see dbForOp(). */
const OP_TIMEOUT_MS = 2000;

let cacheMax = CACHE_MAX_ENTRIES;
let opTimeoutMs = OP_TIMEOUT_MS;
/**
 * Test hook / tuning. @param {{maxEntries?: number, opTimeoutMs?: number}} opts
 */
export function configureCache(opts) {
  if (typeof opts.maxEntries === "number" && opts.maxEntries > 0) cacheMax = opts.maxEntries;
  if (typeof opts.opTimeoutMs === "number" && opts.opTimeoutMs > 0) opTimeoutMs = opts.opTimeoutMs;
}

/** Session-only fallback. Map iteration order doubles as LRU order (touch = re-insert). */
const memSug = /** @type {Map<string, {value: unknown, ts: number}>} */ (new Map());
const memLater = /** @type {Map<number, Record<string, unknown> & {id: number}>} */ (new Map());
/** @type {(Record<string, unknown> & {transactions: unknown[]})|null} in-memory snapshot record */
let memSnap = null;
let memoryOnly = false;
/**
 * Sticky session flag: some later-store op already fell back to memory this
 * session (timeout OR memory-only). While set, laterLoad's pointer compaction is
 * FORBIDDEN — "couldn't reach IDB" must never be treated as "IDB confirmed gone",
 * or a transient stall wipes the Later pile.
 */
let laterFellBack = false;
/** @type {Promise<IDBDatabase|null>|null} */
let dbPromise = null;

/** @returns {boolean} true when suggestions/Later bodies live only in memory (UI hedges persistence wording) */
export function cacheIsMemoryOnly() {
  return memoryOnly;
}

/** Test hook: back to a pristine module state (fresh open, empty fallbacks, defaults). */
export function resetStorageForTests() {
  memoryOnly = false;
  laterFellBack = false;
  dbPromise = null;
  memSug.clear();
  memLater.clear();
  memSnap = null;
  cacheMax = CACHE_MAX_ENTRIES;
  opTimeoutMs = OP_TIMEOUT_MS;
}

/**
 * Open (once). Open errors flip the module into memory-only mode; a BLOCKED open
 * does NOT — the promise simply stays pending (see dbForOp's per-call timeout).
 * @returns {Promise<IDBDatabase|null>}
 */
function openDb() {
  if (memoryOnly) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    memoryOnly = true;
    return Promise.resolve(null);
  }
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SUG_STORE)) {
          const s = db.createObjectStore(SUG_STORE, { keyPath: "key" });
          s.createIndex("ts", "ts");
        }
        if (!db.objectStoreNames.contains(LATER_STORE)) {
          db.createObjectStore(LATER_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(SNAP_STORE)) {
          db.createObjectStore(SNAP_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab is upgrading to a newer version: close so IT can proceed;
        // this tab reopens lazily on its next op.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        memoryOnly = true;
        resolve(null);
      };
      req.onblocked = () => {
        // Deliberately NO memory-only latch and NO resolve(null): blocked means an
        // old tab still holds v1 open. The promise stays cached and PENDING; each
        // op times out individually and uses the real DB once the open resolves.
      };
    } catch {
      memoryOnly = true;
      resolve(null);
    }
  });
  return dbPromise;
}

/**
 * openDb raced against the per-call watchdog. A timeout degrades THIS call to the
 * memory path (returns null) without poisoning the cached open promise and without
 * latching memory-only mode.
 * @returns {Promise<IDBDatabase|null>}
 */
async function dbForOp() {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  try {
    return await Promise.race([
      openDb(),
      new Promise((/** @type {(v: null) => void} */ resolve) => {
        timer = setTimeout(() => resolve(null), opTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one small IDB transaction; a timed-out open degrades just this call, a real
 * transaction failure degrades the session to memory-only. Returns null either way.
 * @template T
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>|null} fn
 * @returns {Promise<{ok: true, value: T|undefined}|null>} null ⇒ use the memory fallback
 */
async function idbOp(storeName, mode, fn) {
  const db = await dbForOp();
  if (!db) return null;
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      const req = fn(tx.objectStore(storeName));
      if (!req) {
        tx.oncomplete = () => resolve({ ok: true, value: undefined });
        return;
      }
      req.onsuccess = () => resolve({ ok: true, value: req.result });
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    // A connection closed under us by onversionchange (sibling tab upgrading)
    // throws InvalidStateError at db.transaction — that's "reopen next call"
    // (dbPromise is already nulled), not "storage is broken": same policy as a
    // blocked open. Everything else latches the session to memory-only.
    if (!(e instanceof DOMException && e.name === "InvalidStateError")) memoryOnly = true;
    return null;
  }
}

/**
 * Shape guard for cached suggestion values — the shape the UI caches for rule/ai/web
 * results alike: {suggested_category_id, confidence, reasoning, created_at?, web?}.
 * @param {unknown} v
 * @returns {v is {suggested_category_id: number|null, confidence: number|null, reasoning: string}}
 */
export function isSuggestion(v) {
  if (typeof v !== "object" || v === null) return false;
  const o = /** @type {Record<string, unknown>} */ (v);
  return (
    "suggested_category_id" in o &&
    (o.suggested_category_id === null || typeof o.suggested_category_id === "number") &&
    (o.confidence === null || o.confidence === undefined || typeof o.confidence === "number") &&
    typeof o.reasoning === "string"
  );
}

/**
 * Read one cached entry; bumps its LRU timestamp. Shape-validated on read: records
 * that fail `validate` (default: isSuggestion) are dropped and null is returned.
 * @param {string} key  e.g. `txn:123` (pass 1) or `m:albert heijn` (web check)
 * @param {(v: unknown) => boolean} [validate]
 * @returns {Promise<unknown|null>}
 */
export async function sugGet(key, validate = isSuggestion) {
  const res = await idbOp(SUG_STORE, "readonly", (s) => s.get(key));
  if (res !== null) {
    const rec = /** @type {{key?: unknown, value?: unknown, ts?: unknown}|undefined} */ (res.value);
    if (!rec || typeof rec.key !== "string" || !validate(rec.value)) {
      if (rec) await idbOp(SUG_STORE, "readwrite", (s) => s.delete(key));
      return null;
    }
    // LRU touch (per-entry write; best-effort)
    await idbOp(SUG_STORE, "readwrite", (s) => s.put({ key, value: rec.value, ts: Date.now() }));
    return rec.value;
  }
  // memory fallback
  const hit = memSug.get(key);
  if (!hit || !validate(hit.value)) {
    memSug.delete(key);
    return null;
  }
  memSug.delete(key); // re-insert = move to LRU tail
  memSug.set(key, { value: hit.value, ts: Date.now() });
  return hit.value;
}

/**
 * Batch read for state assembly: returns a Map of key -> validated value.
 * Missing/invalid entries are simply absent from the Map.
 * @param {string[]} keys
 * @param {(v: unknown) => boolean} [validate]
 * @returns {Promise<Map<string, unknown>>}
 */
export async function sugGetMany(keys, validate = isSuggestion) {
  /** @type {Map<string, unknown>} */
  const out = new Map();
  for (const key of keys) {
    const v = await sugGet(key, validate);
    if (v !== null) out.set(key, v);
  }
  return out;
}

/**
 * Write one cached entry (per-entry write), then prune LRU overflow past the cap.
 * @param {string} key
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function sugPut(key, value) {
  const res = await idbOp(SUG_STORE, "readwrite", (s) => s.put({ key, value, ts: Date.now() }));
  if (res !== null) {
    await pruneIdb();
    return;
  }
  memSug.delete(key);
  memSug.set(key, { value, ts: Date.now() });
  while (memSug.size > cacheMax) {
    const oldest = memSug.keys().next();
    if (oldest.done) break;
    memSug.delete(oldest.value);
  }
}

/**
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function sugDelete(key) {
  const res = await idbOp(SUG_STORE, "readwrite", (s) => s.delete(key));
  if (res === null) memSug.delete(key);
}

/** @returns {Promise<void>} */
export async function sugClear() {
  const res = await idbOp(SUG_STORE, "readwrite", (s) => s.clear());
  if (res === null) memSug.clear();
}

/** Delete oldest entries until the store is back under the cap. */
async function pruneIdb() {
  const countRes = await idbOp(SUG_STORE, "readonly", (s) => s.count());
  if (countRes === null || typeof countRes.value !== "number") return;
  let excess = countRes.value - cacheMax;
  if (excess <= 0) return;
  const db = await dbForOp();
  if (!db) return;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SUG_STORE, "readwrite");
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve(undefined);
      const cursorReq = tx.objectStore(SUG_STORE).index("ts").openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || excess <= 0) return;
        cursor.delete();
        excess--;
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  } catch {
    /* prune is best-effort; next write retries */
  }
}

/**
 * Store a Later txn body (bodies live here; pointers in localStorage).
 * @param {Record<string, unknown> & {id: number}} txn
 * @returns {Promise<void>}
 */
export async function laterPut(txn) {
  if (typeof txn !== "object" || txn === null || typeof txn.id !== "number") return;
  const res = await idbOp(LATER_STORE, "readwrite", (s) => s.put(txn));
  if (res === null) {
    laterFellBack = true;
    memLater.set(txn.id, txn);
  }
}

/**
 * @param {number} id
 * @returns {Promise<(Record<string, unknown> & {id: number})|null>}
 */
export async function laterGet(id) {
  const res = await idbOp(LATER_STORE, "readonly", (s) => s.get(id));
  if (res !== null) {
    const rec = /** @type {(Record<string, unknown> & {id: number})|undefined} */ (res.value);
    return rec && typeof rec.id === "number" ? rec : null;
  }
  laterFellBack = true;
  return memLater.get(id) ?? null;
}

/**
 * Bodies for the given pointers, in pointer order; missing/evicted bodies dropped.
 * @param {number[]} ids
 * @returns {Promise<(Record<string, unknown> & {id: number})[]>}
 */
export async function laterGetAll(ids) {
  /** @type {(Record<string, unknown> & {id: number})[]} */
  const out = [];
  for (const id of ids) {
    const t = await laterGet(id);
    if (t) out.push(t);
  }
  return out;
}

/**
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function laterDelete(id) {
  const res = await idbOp(LATER_STORE, "readwrite", (s) => s.delete(id));
  if (res === null) {
    laterFellBack = true;
    memLater.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Offline state snapshot — one record, the raw last-good getState result
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Snapshot
 * @property {import("./lm.js").LeafCategory[]} categories
 * @property {import("./lm.js").LMAccount[]} accounts
 * @property {import("./lm.js").LMTransaction[]} transactions  RAW (undecorated)
 * @property {number} fetchedAt
 * @property {boolean} truncated
 * @property {number|null} total
 */

/**
 * Container-level shape guard (lsLoad-style): the arrays are trusted deep, like
 * every other read path; txn entries are id-filtered on load.
 * @param {unknown} v
 * @returns {v is Record<string, unknown> & {categories: unknown[], accounts: unknown[], transactions: unknown[], fetchedAt: number}}
 */
function isSnapshotRecord(v) {
  if (typeof v !== "object" || v === null) return false;
  const o = /** @type {Record<string, unknown>} */ (v);
  return (
    Array.isArray(o.categories) &&
    Array.isArray(o.accounts) &&
    Array.isArray(o.transactions) &&
    typeof o.fetchedAt === "number"
  );
}

/**
 * Same content as the stored record? Txn id-set + category/account counts only —
 * in-place payee/amount edits on an identical id-set are missed (accepted,
 * documented in SPEC-STATIC).
 * @param {unknown} prev
 * @param {{categories: unknown[], accounts: unknown[], transactions: {id: number}[]}} next
 * @returns {prev is Record<string, unknown> & {transactions: unknown[]}}
 */
function sameSnapshotContent(prev, next) {
  if (!isSnapshotRecord(prev)) return false;
  if (prev.categories.length !== next.categories.length) return false;
  if (prev.accounts.length !== next.accounts.length) return false;
  if (prev.transactions.length !== next.transactions.length) return false;
  const ids = new Set(
    prev.transactions.map((t) => (typeof t === "object" && t !== null ? /** @type {{id?: unknown}} */ (t).id : null)),
  );
  return next.transactions.every((t) => ids.has(t.id));
}

/**
 * Save the raw state for offline boot. Best-effort: NEVER throws/rejects.
 * When content is unchanged (see comparator) the full payload write is skipped
 * but the stored fetchedAt is still bumped — the stale banner must never
 * overstate the snapshot's age.
 * @param {{categories: import("./lm.js").LeafCategory[], accounts: import("./lm.js").LMAccount[], transactions: import("./lm.js").LMTransaction[], truncated?: boolean, total?: number|null}} state
 * @param {number} [now]
 * @returns {Promise<void>}
 */
export async function snapshotSave(state, now = Date.now()) {
  try {
    const rec = {
      key: SNAP_KEY,
      categories: Array.isArray(state.categories) ? state.categories : [],
      accounts: Array.isArray(state.accounts) ? state.accounts : [],
      transactions: Array.isArray(state.transactions) ? state.transactions : [],
      fetchedAt: now,
      truncated: state.truncated === true,
      total: typeof state.total === "number" ? state.total : null,
    };
    const db = await dbForOp();
    if (!db) {
      memSnap = sameSnapshotContent(memSnap, rec) ? { ...memSnap, fetchedAt: now } : rec;
      return;
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAP_STORE, "readwrite");
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      const store = tx.objectStore(SNAP_STORE);
      const get = store.get(SNAP_KEY);
      get.onsuccess = () => {
        const prev = get.result;
        // unchanged content: bump the sidecar only — never re-clone the big record
        if (sameSnapshotContent(prev, rec)) store.put({ key: SNAP_META_KEY, fetchedAt: now });
        else store.put(rec);
      };
      get.onerror = () => reject(get.error);
    });
  } catch {
    /* snapshot is best-effort; the live path never depends on it */
  }
}

/**
 * @returns {Promise<Snapshot|null>} null on miss or corruption — the caller falls
 *   back to the ordinary error/onboarding path.
 */
export async function snapshotLoad() {
  try {
    const res = await idbOp(SNAP_STORE, "readonly", (s) => s.get(SNAP_KEY));
    const rec = res !== null ? res.value : memSnap;
    if (!isSnapshotRecord(rec)) return null;
    // fetchedAt = the later of the record itself and the skip-unchanged sidecar
    let metaAt = 0;
    if (res !== null) {
      const meta = await idbOp(SNAP_STORE, "readonly", (s) => s.get(SNAP_META_KEY));
      const m = meta !== null ? /** @type {{fetchedAt?: unknown}|undefined} */ (meta.value) : undefined;
      if (m && typeof m.fetchedAt === "number") metaAt = m.fetchedAt;
    }
    const txns = /** @type {import("./lm.js").LMTransaction[]} */ (
      rec.transactions.filter((t) => typeof t === "object" && t !== null && typeof (/** @type {{id?: unknown}} */ (t).id) === "number")
    );
    return {
      categories: /** @type {import("./lm.js").LeafCategory[]} */ (rec.categories),
      accounts: /** @type {import("./lm.js").LMAccount[]} */ (rec.accounts),
      transactions: txns,
      fetchedAt: Math.max(rec.fetchedAt, metaAt),
      truncated: rec.truncated === true,
      total: typeof rec.total === "number" ? rec.total : null,
    };
  } catch {
    return null;
  }
}

/**
 * Drop flushed txns from the snapshot so an offline boot right after a sync does
 * not resurrect already-categorized cards. ONE readwrite transaction (get →
 * filter → put): an aborted tx rolls back wholly — worst case a lost prune,
 * redone after the next flush. Best-effort: never throws.
 * @param {number[]} ids
 * @returns {Promise<void>}
 */
export async function snapshotPrune(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const drop = new Set(ids);
  /** @param {unknown} t */
  const keep = (t) =>
    !(typeof t === "object" && t !== null && drop.has(/** @type {number} */ (/** @type {{id?: unknown}} */ (t).id)));
  try {
    const db = await dbForOp();
    if (!db) {
      if (memSnap) memSnap = { ...memSnap, transactions: memSnap.transactions.filter(keep) };
      return;
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAP_STORE, "readwrite");
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      const store = tx.objectStore(SNAP_STORE);
      const get = store.get(SNAP_KEY);
      get.onsuccess = () => {
        const rec = get.result;
        if (!isSnapshotRecord(rec)) return; // nothing to prune
        store.put({ ...rec, transactions: rec.transactions.filter(keep) });
      };
      get.onerror = () => reject(get.error);
    });
  } catch {
    /* best-effort */
  }
}

/** @returns {Promise<void>} */
export async function snapshotClear() {
  memSnap = null;
  await idbOp(SNAP_STORE, "readwrite", (s) => s.delete(SNAP_KEY));
  await idbOp(SNAP_STORE, "readwrite", (s) => s.delete(SNAP_META_KEY));
}
