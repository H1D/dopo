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
 *
 * IndexedDB (bulk, async): suggestion cache + Later txn bodies, ~2000-entry LRU,
 * per-entry writes. Falls back to an in-memory Map (same API, session-only) when
 * IndexedDB is unavailable or breaks mid-flight — the app must never brick on storage.
 *
 * Everything is shape-validated on read (lsLoad-style): corrupted storage degrades
 * to the fallback value; read paths never throw. WRITE paths throw on quota /
 * private-mode failure so callers can switch to eager-flush mode.
 */

import { isRule } from "./rules.js";

export const LS_KEYS = {
  tokens: "dopo.tokens.v1",
  queue: "dopo.queue.v1",
  later: "dopo.later.v1",
  rules: "dopo.rules.v1",
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

/** "Forget tokens on this device" — clears tokens ONLY; queue/rules/caches stay. */
export function clearTokens() {
  lsRemove(LS_KEYS.tokens);
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
 * Items safe for the hidden/pagehide keepalive flush: flushable AND decided against
 * the CURRENT session's snapshot. Old-session items (including legacy null) stay
 * queued for the recheck-based replay on next open.
 * @param {QueueItem[]} queue
 * @param {number|null} currentSnapshotTs
 * @returns {QueueItem[]}
 */
export function keepaliveEligible(queue, currentSnapshotTs) {
  if (currentSnapshotTs === null) return [];
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
 * @param {{pattern: string, match_type?: "contains"|"exact", category_id: number, id?: number, category_name?: string}} rule
 * @returns {import("./rules.js").Rule}
 * @throws on storage failure
 */
export function ruleAdd(rule) {
  const existing = rulesLoad();
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
 * @returns {Promise<(Record<string, unknown> & {id: number})[]>}
 */
export async function laterLoad() {
  const { ids, legacyTxns } = loadLater();
  for (const t of legacyTxns) await laterPut(t);
  const bodies = await laterGetAll(ids);
  if (bodies.length !== ids.length || legacyTxns.length) {
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
const DB_VERSION = 1;
const SUG_STORE = "suggestions";
const LATER_STORE = "later";
/** ~2000 entries keeps the cache well under any browser quota while covering months. */
export const CACHE_MAX_ENTRIES = 2000;

let cacheMax = CACHE_MAX_ENTRIES;
/**
 * Test hook / tuning. @param {{maxEntries?: number}} opts
 */
export function configureCache(opts) {
  if (typeof opts.maxEntries === "number" && opts.maxEntries > 0) cacheMax = opts.maxEntries;
}

/** Session-only fallback. Map iteration order doubles as LRU order (touch = re-insert). */
const memSug = /** @type {Map<string, {value: unknown, ts: number}>} */ (new Map());
const memLater = /** @type {Map<number, Record<string, unknown> & {id: number}>} */ (new Map());
let memoryOnly = false;
/** @type {Promise<IDBDatabase|null>|null} */
let dbPromise = null;

/** @returns {boolean} true when suggestions/Later bodies live only in memory (UI hedges persistence wording) */
export function cacheIsMemoryOnly() {
  return memoryOnly;
}

/**
 * Open (once). Any failure flips the module into memory-only mode.
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
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        memoryOnly = true;
        resolve(null);
      };
      req.onblocked = () => {
        memoryOnly = true;
        resolve(null);
      };
    } catch {
      memoryOnly = true;
      resolve(null);
    }
  });
  return dbPromise;
}

/**
 * Run one small IDB transaction; on ANY failure degrade to memory-only and return null.
 * @template T
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>|null} fn
 * @returns {Promise<{ok: true, value: T|undefined}|null>} null ⇒ use the memory fallback
 */
async function idbOp(storeName, mode, fn) {
  const db = await openDb();
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
  } catch {
    memoryOnly = true;
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
  const db = await openDb();
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
  if (res === null) memLater.set(txn.id, txn);
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
  if (res === null) memLater.delete(id);
}
