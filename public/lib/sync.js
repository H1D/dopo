// @ts-check
/**
 * Queue replay against Lunch Money — the recheck-based path every decision not
 * covered by the same-session keepalive flush goes through (boot replay, the
 * back-online resync). Storage via lib/store.js, network via lib/lm.js; NEVER touches
 * DOM/UI. THROWS typed errors — LMError passes through untouched (the caller
 * keeps its routeLMError routing), fetch rejections (TypeError) likewise.
 *
 * Lock discipline (see "queue write classes" in SPEC-STATIC): the dopo.queue
 * lock is held for load+mark-flushable and for each merge-persist step, and
 * RELEASED across all network I/O in between.
 */

import { LMError, applyCategories, getState, getTransaction } from "./lm.js";
import { fetchWindow, queueMutate, ruleAdd, snapshotPrune } from "./store.js";

/** @typedef {import("./store.js").QueueItem} QueueItem */
/**
 * @typedef {object} ReplayResult
 * @property {number[]} applied       PUT and accepted upstream
 * @property {number[]} skippedSent   recheck skips this client already sent once (announce silently)
 * @property {number[]} skippedUnsent recheck skips never sent from here — "already categorized elsewhere"
 * @property {number[]} stuck         parked flushable:false after repeated poison rejections
 */

/** PUT chunk size — matches lib/lm.js's internal batching, so each chunk is one PUT. */
const PUT_CHUNK = 500;
/** Poison items are parked (flushable:false + stuck reason) after this many failed isolated PUTs. */
export const STUCK_AFTER_ATTEMPTS = 3;

/**
 * SESSION-ONLY failure counter per item identity "id:ts". Deliberately not
 * persisted: a fresh session retries previously-stuck items from scratch.
 * @type {Map<string, number>}
 */
const putFailures = new Map();

/** Test hook: forget the session-only poison attempt counters. */
export function resetSyncSessionForTests() {
  putFailures.clear();
}

/**
 * 4xx that marks a request body as poison. 401 routes as dead token, 408/429 are
 * transient (ordinary backoff, no attempt counted) — everything else 4xx is a
 * deterministic rejection of the payload itself.
 * @param {number} status
 * @returns {boolean}
 */
export function isPoisonStatus(status) {
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

/** @param {unknown} e @returns {e is LMError} */
function isPoisonError(e) {
  return e instanceof LMError && isPoisonStatus(e.status);
}

/** Item identity is (id, ts) — STRING keys, never object references. @param {QueueItem} it */
const keyOf = (it) => `${it.id}:${it.ts}`;

/** @param {QueueItem} it @returns {import("./lm.js").CategoryUpdate} */
const payloadOf = (it) => ({ id: it.id, category_id: it.category_id });

/**
 * Replay every queued decision:
 *  1. LOCK: mark all items flushable (boot replay finalizes any pending undo —
 *     accepted trade-off), except items past the session attempt cap (stay parked).
 *  2. no lock: ONE membership recheck for the whole replay (window + per-id
 *     fallback — absence from the window alone NEVER discards a decision).
 *  3. LOCK: drop recheck skips from the queue; prune them from the snapshot.
 *  4. per PUT chunk: LOCK mark sent:true → PUT (recheck:"none", no lock) →
 *     LOCK remove applied + absorb make_rule (deduped ruleAdd) + onApplied +
 *     snapshotPrune. Chunk PUTs rejected with a poison 4xx are bisected — PUT
 *     stage only, the recheck already validated the items.
 *
 * @param {string} token
 * @param {{onApplied?: (ids: number[]) => void}} [opts] called per successful chunk
 * @returns {Promise<ReplayResult>}
 */
export async function replayQueue(token, opts = {}) {
  /** @type {ReplayResult} */
  const result = { applied: [], skippedSent: [], skippedUnsent: [], stuck: [] };

  const marked = await queueMutate((q) => {
    for (const it of q) {
      if ((putFailures.get(keyOf(it)) ?? 0) >= STUCK_AFTER_ATTEMPTS) {
        it.flushable = false;
        if (!it.stuck) it.stuck = "retry limit reached";
        continue;
      }
      it.flushable = true;
      delete it.stuck; // a fresh replay retries; the reason is stale now
    }
  });
  const replaySet = marked.filter((it) => it.flushable);
  for (const it of marked) if (!it.flushable && it.stuck) result.stuck.push(it.id);
  if (!replaySet.length) return result;

  // Pre-replay sent flags decide the skip announcement class (sent:false skips
  // are news to the user; sent:true skips are this client's own past work).
  /** @type {Map<string, boolean>} */
  const preSent = new Map();
  for (const it of replaySet) preSent.set(keyOf(it), it.sent);

  const { safe, skipped } = await recheckMembership(token, replaySet);

  if (skipped.length) {
    const gone = new Set(skipped.map(keyOf));
    await queueMutate((q) => q.filter((it) => !gone.has(keyOf(it))));
    for (const it of skipped) {
      (preSent.get(keyOf(it)) ? result.skippedSent : result.skippedUnsent).push(it.id);
    }
    await snapshotPrune(skipped.map((it) => it.id));
  }

  for (let i = 0; i < safe.length; i += PUT_CHUNK) {
    await putChunk(token, safe.slice(i, i + PUT_CHUNK), result, opts.onApplied);
  }
  return result;
}

/**
 * ONE membership recheck for the whole replay: current uncategorized window
 * (getState — categories/accounts ride along; the price of reusing lm.js as-is),
 * then per-id fallback for misses in small parallel batches:
 *   404                 → skipped (deleted, or token re-pointed at another budget)
 *   still uncategorized → safe    (merely outside the paged window / date range)
 *   categorized         → skipped (someone or something got there first)
 * @param {string} token
 * @param {QueueItem[]} items
 * @returns {Promise<{safe: QueueItem[], skipped: QueueItem[]}>}
 */
async function recheckMembership(token, items) {
  const state = await getState(token, fetchWindow());
  const open = new Set(state.transactions.map((t) => t.id));
  /** @type {QueueItem[]} */
  const safe = [];
  /** @type {QueueItem[]} */
  const skipped = [];
  /** @type {QueueItem[]} */
  const misses = [];
  for (const it of items) (open.has(it.id) ? safe : misses).push(it);
  for (let i = 0; i < misses.length; i += 10) {
    const batch = misses.slice(i, i + 10);
    const current = await Promise.all(
      batch.map((it) =>
        getTransaction(token, it.id).catch((e) => {
          if (e instanceof LMError && e.status === 404) return null;
          throw e;
        }),
      ),
    );
    batch.forEach((it, j) => {
      const t = current[j];
      if (t && t.category_id === null) safe.push(it);
      else skipped.push(it);
    });
  }
  return { safe, skipped };
}

/**
 * One PUT chunk with crash-safe persistence: sent:true lands in storage BEFORE
 * the request may reach Lunch Money, so a crash mid-PUT degrades to a silent
 * recheck-skip on the next replay instead of an "already done" announcement.
 * @param {string} token
 * @param {QueueItem[]} chunk
 * @param {ReplayResult} result
 * @param {((ids: number[]) => void)|undefined} onApplied
 */
async function putChunk(token, chunk, result, onApplied) {
  const keys = new Set(chunk.map(keyOf));
  await queueMutate((q) => {
    for (const it of q) if (keys.has(keyOf(it))) it.sent = true;
  });
  try {
    await applyCategories(token, chunk.map(payloadOf), { recheck: "none" });
  } catch (e) {
    if (!isPoisonError(e)) throw e;
    await bisectPut(token, chunk, result, onApplied);
    return;
  }
  await settleApplied(chunk, result, onApplied);
}

/**
 * Poison isolation for a chunk whose PUT was rejected with a deterministic 4xx.
 * The membership recheck already validated every item once, so halves retry the
 * PUT STAGE ONLY (recheck:"none"). Isolated single-item failures increment the
 * session counter; at the cap the item is parked flushable:false + stuck.
 * Non-poison errors (network, 5xx, 401/408/429) propagate typed, as always.
 * @param {string} token
 * @param {QueueItem[]} items  the group that just failed as a whole
 * @param {ReplayResult} result
 * @param {((ids: number[]) => void)|undefined} onApplied
 */
async function bisectPut(token, items, result, onApplied) {
  const it = items.length === 1 ? items[0] : undefined;
  if (it) {
    try {
      await applyCategories(token, [payloadOf(it)], { recheck: "none" });
    } catch (e) {
      if (!isPoisonError(e)) throw e;
      const k = keyOf(it);
      const n = (putFailures.get(k) ?? 0) + 1;
      putFailures.set(k, n);
      if (n >= STUCK_AFTER_ATTEMPTS) {
        const reason = `HTTP ${e.status}`;
        await queueMutate((q) => {
          for (const cur of q) {
            if (keyOf(cur) === k) {
              cur.flushable = false;
              cur.stuck = reason;
            }
          }
        });
        result.stuck.push(it.id);
      }
      // below the cap: stays queued (sent:true, flushable:true) for the next run
      return;
    }
    await settleApplied([it], result, onApplied);
    return;
  }
  const mid = Math.ceil(items.length / 2);
  for (const half of [items.slice(0, mid), items.slice(mid)]) {
    if (half.length === 1) {
      await bisectPut(token, half, result, onApplied);
      continue;
    }
    try {
      await applyCategories(token, half.map(payloadOf), { recheck: "none" });
    } catch (e) {
      if (!isPoisonError(e)) throw e;
      await bisectPut(token, half, result, onApplied);
      continue;
    }
    await settleApplied(half, result, onApplied);
  }
}

/**
 * Merge-persist for items whose PUT succeeded: remove from the queue by (id, ts),
 * absorb make_rule into local rules (ruleAdd dedupes), notify, prune snapshot.
 * @param {QueueItem[]} items
 * @param {ReplayResult} result
 * @param {((ids: number[]) => void)|undefined} onApplied
 */
async function settleApplied(items, result, onApplied) {
  const done = new Set(items.map(keyOf));
  await queueMutate((q) => q.filter((it) => !done.has(keyOf(it))));
  for (const it of items) {
    if (!it.make_rule) continue;
    try {
      ruleAdd({
        pattern: it.make_rule.pattern,
        match_type: it.make_rule.match_type,
        category_id: it.category_id,
      });
    } catch {
      /* rule absorption is best-effort; the decision itself already applied */
    }
  }
  const ids = items.map((it) => it.id);
  result.applied.push(...ids);
  try {
    if (onApplied) onApplied(ids);
  } catch {
    /* an observer must not break the replay */
  }
  await snapshotPrune(ids);
}
