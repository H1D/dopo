// @ts-check
/**
 * data.js — orchestration between the UI (app.js) and the lib/ modules:
 * state assembly, rules-first suggestion attach, two-pass classification
 * scheduling, suggestion cache reads/writes. Import-safe without a DOM.
 */

import { getState } from "./lib/lm.js";
import { classifyTransactions, webCheckMerchant } from "./lib/classify.js";
import { matchRule, ruleSuggestion } from "./lib/rules.js";
import { cleanMerchant } from "./lib/clean.js";
import { sugGetMany, sugPut, isSuggestion } from "./lib/store.js";

/**
 * Suggestion as the UI consumes it (superset of the old server shape the deck
 * rendered: suggested_category_id + confidence + reasoning + source).
 * @typedef {object} UISuggestion
 * @property {number|null} suggested_category_id
 * @property {number|null} confidence  rules use 1
 * @property {string} reasoning
 * @property {"rule"|"ai"|"web"} source
 * @property {string} [lookup]
 * @property {string} [created_at]
 */

/** @typedef {import("./lib/lm.js").LMTransaction & {merchant: string, suggestion: UISuggestion|null}} DeckTxn */
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
 * Fetch + decorate the full app state: leaf categories, accounts, uncategorized
 * txns with cleaned merchant names and their best known suggestion attached
 * (rules first, then cached web-check per merchant, then cached pass-1 per txn).
 *
 * @param {string} token  Lunch Money token
 * @param {Rule[]} rules  local rules (lib/store.js rulesLoad())
 * @returns {Promise<{categories: Category[], accounts: Account[], transactions: DeckTxn[], truncated: boolean, total: number|null}>}
 */
export async function assembleState(token, rules) {
  const raw = await getState(token);
  /** @type {DeckTxn[]} */
  const txns = raw.transactions.map((t) => ({
    ...t,
    merchant: cleanMerchant(t.payee || ""),
    suggestion: null,
  }));
  await attachSuggestions(txns, rules);
  return {
    categories: raw.categories,
    accounts: raw.accounts,
    transactions: txns,
    truncated: raw.truncated,
    total: raw.total,
  };
}

/**
 * Rules-first attach; cache reads are a bonus — failures leave suggestion null.
 * Cache keys: `txn:<id>` (pass 1), `m:<merchant key>` (pass 2 / web).
 * @param {DeckTxn[]} txns
 * @param {Rule[]} rules
 * @returns {Promise<void>}
 */
export async function attachSuggestions(txns, rules) {
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
    const mk = merchantKeyOf(t.merchant);
    const web = mk ? cache.get("m:" + mk) : undefined;
    if (isSuggestion(web) && web.suggested_category_id != null) {
      t.suggestion = fromCache(web, "web");
      continue;
    }
    const ai = cache.get("txn:" + t.id);
    if (isSuggestion(ai)) t.suggestion = fromCache(ai, "ai");
  }
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
 * @returns {Promise<void>}
 */
export async function classifyPass1(orToken, categories, txns, onSlice) {
  await classifyTransactions(orToken, txns, categories, {
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
