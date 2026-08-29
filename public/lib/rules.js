// @ts-check
/**
 * Local rule matching — pure port of the Worker's store.matchRule.
 * Rules now live on-device (see lib/store.js); matching stays free and offline.
 */

/**
 * @typedef {object} Rule
 * @property {number} id  client-assigned (Date.now()-ish), unique within the device
 * @property {string} pattern
 * @property {"contains"|"exact"} match_type
 * @property {number} category_id
 * @property {string} [category_name]
 * @property {number} [hits]
 * @property {string} [created_at]
 */

/**
 * Longest pattern wins — mirrors the old `ORDER BY length(pattern) DESC` so that
 * "albert heijn to go" beats "albert heijn". Case-insensitive; "exact" compares the
 * whole cleaned merchant, "contains" substring-matches it. Does not mutate `rules`.
 *
 * Accepts either the cleaned merchant string or a UI transaction object with a
 * `merchant` (preferred) / `payee` field attached.
 *
 * @param {Rule[]} rules
 * @param {string|{merchant?: string, payee?: string|null}} merchantOrTxn
 * @returns {Rule|null}
 */
export function matchRule(rules, merchantOrTxn) {
  const merchant =
    typeof merchantOrTxn === "string"
      ? merchantOrTxn
      : merchantOrTxn.merchant ?? merchantOrTxn.payee ?? "";
  const m = merchant.toLowerCase();
  if (!m) return null;
  const ordered = [...rules].sort((a, b) => b.pattern.length - a.pattern.length);
  for (const r of ordered) {
    const p = r.pattern.toLowerCase();
    if (r.match_type === "exact" ? m === p : m.includes(p)) return r;
  }
  return null;
}

/**
 * The suggestion a rule match produces — same shape/wording the Worker persisted
 * (`source: "rule"`, confidence 1, reasoning `rule: "<pattern>"`).
 *
 * @param {Rule} rule
 * @returns {{category_id: number, confidence: number, reasoning: string, source: "rule"}}
 */
export function ruleSuggestion(rule) {
  return {
    category_id: rule.category_id,
    confidence: 1,
    reasoning: `rule: "${rule.pattern}"`,
    source: "rule",
  };
}

/**
 * Shape guard for rules read back from storage (lsLoad-style: reject, don't throw).
 * @param {unknown} r
 * @returns {r is Rule}
 */
export function isRule(r) {
  if (typeof r !== "object" || r === null) return false;
  const o = /** @type {Record<string, unknown>} */ (r);
  return (
    typeof o.id === "number" &&
    typeof o.pattern === "string" &&
    o.pattern.length > 0 &&
    (o.match_type === "contains" || o.match_type === "exact") &&
    typeof o.category_id === "number"
  );
}
