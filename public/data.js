// @ts-check
/**
 * data.js — orchestration between the UI (app.js) and the lib/ modules:
 * state assembly, rules-first suggestion attach, two-pass classification
 * scheduling, suggestion cache reads/writes. Import-safe without a DOM.
 */

import { getState, bucketOf } from "./lib/lm.js";
import { classifyTransactions, webCheckMerchant } from "./lib/classify.js";
import { matchRule, ruleSuggestion } from "./lib/rules.js";
import { cleanMerchant } from "./lib/clean.js";
import { CONFIDENT_AT } from "./lib/card.js";
import { snapshotLoad, snapshotSave, sugGetMany, sugPut, isSuggestion, fetchWindow } from "./lib/store.js";

/**
 * Suggestion as the UI consumes it (superset of the old server shape the deck
 * rendered: suggested_category_id + confidence + reasoning + source).
 * @typedef {object} UISuggestion
 * @property {number|null} suggested_category_id
 * @property {number|null} confidence  rules and existing LM categories use 1
 * @property {string} reasoning
 * @property {"rule"|"lm"|"ai"|"web"} source  "lm" = the category Lunch Money already holds (confirm or change)
 * @property {string} [lookup]
 * @property {string} [created_at]
 */

/**
 * @typedef {import("./lib/lm.js").LMTransaction & {merchant: string, suggestion: UISuggestion|null, aiChecked?: boolean}} DeckTxn
 *   aiChecked: a pass-1 / web verdict exists for this row (cached or fresh) — the
 *   model is never asked twice for one row in a session, even when its verdict
 *   lost to the category Lunch Money already holds (see mergeAi).
 */
/** @typedef {import("./lib/lm.js").LMAccount} Account */
/** @typedef {import("./lib/lm.js").LeafCategory} Category */
/** @typedef {import("./lib/rules.js").Rule} Rule */

/**
 * @param {string} merchant
 * @returns {string|null} normalized unique-merchant key ("" -> null)
 */
export function merchantKeyOf(merchant) {
  const k = merchant.trim().toLowerCase();
  return k || null;
}

/**
 * @param {{suggested_category_id: number|null, confidence: number|null, reasoning: string, created_at?: unknown}} c
 * @param {"ai"|"web"} source
 * @returns {UISuggestion}
 */
function fromCache(c, source) {
  /** @type {UISuggestion} */
  const s = {
    suggested_category_id: c.suggested_category_id,
    confidence: c.confidence ?? null,
    reasoning: c.reasoning,
    source,
  };
  if (typeof c.created_at === "string") s.created_at = c.created_at;
  return s;
}

/**
 * Fetch + decorate the full app state: leaf categories, accounts, unreviewed
 * txns with cleaned merchant names and their best known suggestion attached
 * (rules first, then the category Lunch Money already holds, then cached
 * web-check per merchant, then cached pass-1 per txn).
 *
 * @param {string} token  Lunch Money token
 * @param {Rule[]} rules  local rules (lib/store.js rulesLoad())
 * @returns {Promise<{categories: Category[], accounts: Account[], transactions: DeckTxn[], truncated: boolean, total: number|null}>}
 */
export async function assembleState(token, rules) {
  const raw = await getState(token, fetchWindow());
  // Offline fallback: persist the RAW state (before decoration) after every
  // successful fetch. Best-effort — snapshotSave never throws.
  // fire-and-forget: never-throwing best-effort write, and a multi-MB IDB clone
  // must not sit on the first-render latency path
  void snapshotSave(raw);
  /** @type {DeckTxn[]} */
  const txns = raw.transactions.map((t) => ({
    ...t,
    merchant: cleanMerchant(t.payee || ""),
    suggestion: null,
    aiChecked: false,
  }));
  await attachSuggestions(txns, rules, raw.categories);
  return {
    categories: raw.categories,
    accounts: raw.accounts,
    transactions: txns,
    truncated: raw.truncated,
    total: raw.total,
  };
}

/**
 * Offline boot path: rebuild the deck from the last saved snapshot, decorated in
 * the SAME order as the live path (rules → LM category → cached web → cached ai). The caller
 * renders it with a stale banner; `fetchedAt` feeds the relative age.
 * @param {Rule[]} rules
 * @returns {Promise<{categories: Category[], accounts: Account[], transactions: DeckTxn[], truncated: boolean, total: number|null, stale: true, fetchedAt: number}|null>}
 *   null when no snapshot exists (first run / cleared / corrupted).
 */
export async function assembleFromSnapshot(rules) {
  const snap = await snapshotLoad();
  if (!snap) return null;
  /** @type {DeckTxn[]} */
  const txns = snap.transactions.map((t) => ({
    ...t,
    merchant: cleanMerchant(t.payee || ""),
    suggestion: null,
    aiChecked: false,
  }));
  await attachSuggestions(txns, rules, snap.categories);
  return {
    categories: snap.categories,
    accounts: snap.accounts,
    transactions: txns,
    truncated: snap.truncated,
    total: snap.total,
    stale: true,
    fetchedAt: snap.fetchedAt,
  };
}

/**
 * Rules-first attach; cache reads are a bonus — failures leave suggestion null.
 * A category Lunch Money already holds (its own rules, the bank feed) comes right
 * after local rules, as a confident confirm-or-change suggestion — but only when
 * it is one of the assignable leaves we know, so a swipe never re-applies an
 * archived or group id. With no `categories` given, any id is trusted. A cached
 * model verdict on such a row is weighed against it (mergeAi) rather than
 * ignored: the point of asking the model about a pre-categorized row is a second
 * opinion.
 * Cache keys: `txn:<id>` (pass 1), `m:<merchant key>` (pass 2 / web).
 * @param {DeckTxn[]} txns
 * @param {Rule[]} rules
 * @param {Pick<Category, "id">[]} [categories]  assignable leaves (lm.js leafCategories)
 * @returns {Promise<void>}
 */
export async function attachSuggestions(txns, rules, categories) {
  const leafIds = categories ? new Set(categories.map((c) => c.id)) : null;
  /** @param {number} id */
  const isLeaf = (id) => !leafIds || leafIds.has(id);
  /** @type {Map<string, unknown>} */
  let cache = new Map();
  try {
    const mKeys = [...new Set(txns.map((t) => merchantKeyOf(t.merchant)).flatMap((k) => (k ? ["m:" + k] : [])))];
    const tKeys = txns.map((t) => "txn:" + t.id);
    cache = await sugGetMany([...mKeys, ...tKeys]);
  } catch {
    /* cache unavailable: rules still apply, pass 1 will cover the rest */
  }
  for (const t of txns) {
    const rule = matchRule(rules, t.merchant);
    if (rule) {
      const rs = ruleSuggestion(rule);
      t.suggestion = {
        suggested_category_id: rs.category_id,
        confidence: rs.confidence,
        reasoning: rs.reasoning,
        source: "rule",
      };
      continue;
    }
    if (t.category_id != null && isLeaf(t.category_id)) t.suggestion = lmSuggestion(t.category_id);
    const mk = merchantKeyOf(t.merchant);
    const web = mk ? cache.get("m:" + mk) : undefined;
    const ai = cache.get("txn:" + t.id);
    // web beats pass 1 (mergeAi keeps a web verdict over an ai one), so apply ai first
    if (isSuggestion(ai)) { t.aiChecked = true; t.suggestion = mergeAi(t, fromCache(ai, "ai"), isLeaf); }
    if (isSuggestion(web) && web.suggested_category_id != null) {
      t.aiChecked = true;
      t.suggestion = mergeAi(t, fromCache(web, "web"), isLeaf);
    }
  }
}

/**
 * The category Lunch Money already holds, as a card suggestion. Confidence 1 so
 * a right swipe confirms it (PUT with the same id + status "reviewed").
 * @param {number} categoryId
 * @param {"agrees"|"unsure"} [verdict]  what the model made of it, when asked
 * @returns {UISuggestion}
 */
function lmSuggestion(categoryId, verdict) {
  const reasoning = verdict === "agrees"
    ? "already categorized in Lunch Money, and AI agrees — swipe right to confirm"
    : verdict === "unsure"
      ? "already categorized in Lunch Money; AI wasn't sure either — swipe right to keep it, or pick another"
      : "already categorized in Lunch Money — swipe right to confirm, or pick another";
  return { suggested_category_id: categoryId, confidence: 1, reasoning, source: "lm" };
}

/**
 * Fold a fresh model verdict (pass 1 or web) into a row. Pure: returns the
 * suggestion the row should hold, never mutates.
 *   - a local rule stays on top, always;
 *   - a web verdict is final: a later pass-1 result never replaces it;
 *   - on a row Lunch Money already categorized (a trusted leaf), the model is a
 *     second opinion: it only takes the card when it is CONFIDENT and DISAGREES.
 *     Agreement or an unsure verdict keeps the held category, with the reasoning
 *     saying which — the swipe-right confirm stays a one-move card.
 * @param {DeckTxn} t
 * @param {UISuggestion} next  source "ai" | "web"
 * @param {(id: number) => boolean} [isLeaf]  trust test for t.category_id (default: trust)
 * @returns {UISuggestion}
 */
export function mergeAi(t, next, isLeaf = () => true) {
  const cur = t.suggestion;
  if (cur?.source === "rule") return cur;
  if (cur?.source === "web" && next.source === "ai") return cur;
  const held = t.category_id != null && isLeaf(t.category_id) ? t.category_id : null;
  if (held !== null) {
    if (next.suggested_category_id === held) return lmSuggestion(held, "agrees");
    if (next.suggested_category_id == null || (next.confidence ?? 0) < CONFIDENT_AT) return lmSuggestion(held, "unsure");
  }
  return next;
}

/**
 * Whether pass 1 should be run on this row unasked: its bucket is switched on
 * for automatic AI, and the model hasn't spoken yet — a bare card, or one still
 * showing only the category Lunch Money holds.
 * @param {DeckTxn} t
 * @param {Record<import("./lib/lm.js").Bucket, boolean>} ai  the "automatically ask AI about" flags
 * @returns {boolean}
 */
export function wantsAi(t, ai) {
  if (!ai[bucketOf(t)]) return false;
  return askable(t);
}

/**
 * Whether the model could still add something to this row: no verdict yet, and
 * nothing but a bare card or Lunch Money's own category on it. Rule matches and
 * existing verdicts are final.
 * @param {DeckTxn} t
 * @returns {boolean}
 */
export function askable(t) {
  if (t.aiChecked) return false;
  const s = t.suggestion;
  return !s || s.source === "lm";
}

/**
 * Pass 1 over the given (unsuggested) txns. lib/classify.js batches 8 per request
 * with 3 in flight and reports each finished concurrency group; we cache every
 * result per txn (`txn:<id>`) and forward a Map<txnId, UISuggestion> to the UI so
 * cards warm up incrementally.
 *
 * @param {string} orToken
 * @param {Category[]} categories
 * @param {DeckTxn[]} txns
 * @param {(sugs: Map<number, UISuggestion>) => void} onSlice
 * @param {{model?: string, concurrency?: number}} [opts]  free-tier overrides (lib/freekey.js)
 * @returns {Promise<void>}
 */
export async function classifyPass1(orToken, categories, txns, onSlice, opts = {}) {
  await classifyTransactions(orToken, txns, categories, {
    model: opts.model,
    concurrency: opts.concurrency,
    onBatch: (results) => {
      const now = new Date().toISOString();
      /** @type {Map<number, UISuggestion>} */
      const out = new Map();
      for (const s of results) {
        const cached = {
          suggested_category_id: s.suggested_category_id,
          confidence: s.confidence,
          reasoning: s.reasoning,
          created_at: now,
        };
        sugPut("txn:" + s.id, cached).catch(() => { /* cache write is best-effort */ });
        out.set(s.id, fromCache(cached, "ai"));
      }
      onSlice(out);
    },
  });
}

/**
 * Pass 2 for ONE unique merchant: web-enabled model call, result cached per
 * merchant (`m:<key>`) so the cost is paid at most once while the cache
 * persists. Returns the UISuggestion to attach to every txn of that merchant.
 *
 * @param {string} orToken
 * @param {string} merchant  cleaned merchant display name
 * @param {Category[]} categories
 * @returns {Promise<UISuggestion>}
 */
export async function webCheck(orToken, merchant, categories) {
  const key = merchantKeyOf(merchant) ?? merchant;
  const r = await webCheckMerchant(orToken, key, merchant, categories);
  const created_at = new Date().toISOString();
  sugPut("m:" + key, {
    suggested_category_id: r.suggested_category_id,
    confidence: r.confidence,
    reasoning: r.reasoning,
    web: true,
    created_at,
  }).catch(() => { /* cache write is best-effort */ });
  return {
    suggested_category_id: r.suggested_category_id,
    confidence: r.confidence,
    reasoning: r.reasoning,
    source: "web",
    created_at,
  };
}
