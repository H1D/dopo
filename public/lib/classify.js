// @ts-check
/**
 * OpenRouter client — two-pass classification.
 * Pass 1: cheap batched classification (batches of 8, concurrency 3, low reasoning).
 * Pass 2: lazy per-merchant web check with the `:online` model variant.
 * The key is passed per call and never stored here.
 */

export const MODEL = "z-ai/glm-5.3-flash";
export const WEB_MODEL = `${MODEL}:online`;
export const BATCH_SIZE = 8;
export const CONCURRENCY = 3;

/** Typed upstream failure so callers can map status without parsing message strings. */
export class ORError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = "ORError";
    /** @type {number} */
    this.status = status;
  }
  /** @returns {boolean} */
  get tokenInvalid() {
    return this.status === 401;
  }
  /** 429: OpenRouter's request cap (per-minute or per-day on free models). @returns {boolean} */
  get rateLimited() {
    return this.status === 429;
  }
  /**
   * The account behind the key can't serve more requests right now: rate cap
   * (429) or no credit (402 — what a $0-budget guardrail returns). On the shared
   * free key both mean "quota", and the fix is the same: the user's own key.
   * @returns {boolean}
   */
  get quotaExhausted() {
    return this.status === 429 || this.status === 402;
  }
  /**
   * OpenRouter names the bucket in the 429 body ("free-models-per-day" vs
   * "...-per-min"). Best effort — unknown wording reads as the short kind.
   * @returns {boolean}
   */
  get dailyQuota() {
    return this.status === 429 && /per[-_ ]?day|daily/i.test(this.message);
  }
}

/**
 * Tunables for a pass-1 run. Defaults are the paid tier; the shared free key
 * passes its own model and a lower concurrency (see lib/freekey.js).
 * @typedef {object} ClassifyOpts
 * @property {string} [model]
 * @property {number} [concurrency]
 */

/**
 * @typedef {object} CategoryOption
 * @property {number} id
 * @property {string} name
 * @property {string|null} group
 */

/**
 * @typedef {object} TxnForLLM
 * @property {number} id
 * @property {string} merchant
 * @property {string} raw_payee
 * @property {string} amount
 * @property {string} currency
 * @property {string} date
 * @property {string|null} notes
 * @property {string|null} lookup
 */

/**
 * @typedef {object} Suggestion
 * @property {number} id
 * @property {number|null} category_id
 * @property {number} confidence
 * @property {string} reasoning
 * @property {string} [merchant]  echo of the input row's merchant (row-swap guard)
 */

/**
 * The app-facing suggestion shape (matches what the UI caches and renders).
 * @typedef {object} AppSuggestion
 * @property {number} id
 * @property {number|null} suggested_category_id
 * @property {number} confidence
 * @property {string} reasoning
 */

/**
 * @typedef {object} WebCheckResult
 * @property {string} key  the cache key this result belongs to
 * @property {string} merchant
 * @property {number|null} suggested_category_id
 * @property {number} confidence
 * @property {string} reasoning
 * @property {true} web
 */

/**
 * A transaction as the UI holds it (cleaned merchant already attached).
 * @typedef {object} TxnLike
 * @property {number} id
 * @property {string} [merchant]
 * @property {string|null} [payee]
 * @property {string} amount
 * @property {string} currency
 * @property {string} date
 * @property {string|null} [notes]
 */

/**
 * OpenRouter attribution headers. "HTTP-Referer" is OpenRouter's custom header
 * (NOT the forbidden `Referer`); guarded for non-browser test environments.
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
function orHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer":
      typeof location !== "undefined" && location.origin ? location.origin : "https://dopo.invalid",
    "X-Title": "dopo",
  };
}

/**
 * Live key validation for Settings: GET /api/v1/key.
 * Throws ORError with the upstream status on any failure (.status 401 = rejected key).
 * @param {string} apiKey
 * @returns {Promise<void>}
 */
export async function checkKey(apiKey) {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new ORError(res.status, `OpenRouter key check -> ${res.status}`);
}

/**
 * POST /api/v1/chat/completions and return the message content string.
 * @param {string} apiKey
 * @param {string} model
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function complete(apiKey, model, prompt) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: orHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 6000,
      // GLM cannot disable reasoning; low effort keeps latency sane
      reasoning: { effort: "low" },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ORError(res.status, `OpenRouter ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = /** @type {{choices?: {message?: {content?: string}}[]}} */ (await res.json());
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * @param {CategoryOption[]} categories
 * @returns {string}
 */
function categoryList(categories) {
  return categories.map((c) => `${c.id}: ${c.group ? `${c.group} / ` : ""}${c.name}`).join("\n");
}

/**
 * Pass 1 core loop: batches of 8, at most `concurrency` (default 3) requests in flight.
 * `onGroup` (optional) receives each completed concurrency group's suggestions,
 * so the UI can absorb results while later batches are still cooking. A failed
 * chunk does not discard its siblings: whatever else in the group succeeded is
 * still reported through `onGroup` before the first error is rethrown — on the
 * shared free key a mid-pass 429 is routine, and a paid-for or quota-costing
 * answer must not be thrown away.
 * @param {string} apiKey
 * @param {CategoryOption[]} categories
 * @param {TxnForLLM[]} txns
 * @param {(batch: Suggestion[]) => void} [onGroup]
 * @param {ClassifyOpts} [opts]
 * @returns {Promise<Suggestion[]>}
 */
export async function classifyBatch(apiKey, categories, txns, onGroup, opts = {}) {
  const model = opts.model ?? MODEL;
  const concurrency = Math.max(1, opts.concurrency ?? CONCURRENCY);
  /** @type {TxnForLLM[][]} */
  const chunks = [];
  for (let i = 0; i < txns.length; i += BATCH_SIZE) chunks.push(txns.slice(i, i + BATCH_SIZE));
  /** @type {Suggestion[]} */
  const out = [];
  for (let i = 0; i < chunks.length; i += concurrency) {
    const settled = await Promise.allSettled(
      chunks.slice(i, i + concurrency).map((chunk) => classifyChunk(apiKey, model, categories, chunk)),
    );
    const flat = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    out.push(...flat);
    if (onGroup && flat.length) onGroup(flat);
    const failed = settled.find((r) => r.status === "rejected");
    if (failed && failed.status === "rejected") throw failed.reason;
  }
  return out;
}

/**
 * @param {TxnLike} t
 * @returns {TxnForLLM}
 */
function txnForLLM(t) {
  return {
    id: t.id,
    merchant: t.merchant ?? "",
    raw_payee: (t.payee ?? "").slice(0, 200),
    amount: t.amount,
    currency: t.currency,
    date: t.date,
    notes: t.notes ?? null,
    lookup: null,
  };
}

/** @param {Suggestion} s @returns {AppSuggestion} */
function toAppSuggestion(s) {
  return { id: s.id, suggested_category_id: s.category_id, confidence: s.confidence, reasoning: s.reasoning };
}

/**
 * App-facing pass 1: takes UI transaction objects (cleaned merchant attached),
 * classifies them in batches of 8 / concurrency 3 (or `opts.model` /
 * `opts.concurrency`), and reports each finished group through `opts.onBatch`
 * so cards warm up incrementally.
 * @param {string} apiKey
 * @param {TxnLike[]} txns
 * @param {CategoryOption[]} categories
 * @param {ClassifyOpts & {onBatch?: (results: AppSuggestion[]) => void}} [opts]
 * @returns {Promise<AppSuggestion[]>}
 */
export async function classifyTransactions(apiKey, txns, categories, opts = {}) {
  const onBatch = opts.onBatch;
  const all = await classifyBatch(
    apiKey,
    categories,
    txns.map(txnForLLM),
    onBatch ? (batch) => onBatch(batch.map(toAppSuggestion)) : undefined,
    { model: opts.model, concurrency: opts.concurrency },
  );
  return all.map(toAppSuggestion);
}

/**
 * @param {string} apiKey
 * @param {string} model
 * @param {CategoryOption[]} categories
 * @param {TxnForLLM[]} txns
 * @returns {Promise<Suggestion[]>}
 */
async function classifyChunk(apiKey, model, categories, txns) {
  const prompt = `You categorize personal bank transactions for a household in the Netherlands (bank: ABN AMRO, currency mostly EUR). Payee strings are often noisy: payment service providers (Mollie, Zettle, SumUp, CCV), IBANs, dossier numbers. The "merchant" field is a cleaned-up guess; "raw_payee" is the original string; "lookup" is a web search snippet about the merchant when available. Positive amounts are money going out (expenses), negative amounts are money coming in.

Categories (id: group / name):
${categoryList(categories)}

Transactions:
${JSON.stringify(txns, null, 1)}

For EVERY transaction return the best category. Use null for category_id only if you genuinely cannot tell. In "merchant", copy that transaction's merchant field EXACTLY — it ties your answer to the right row. Respond with ONLY a JSON object of this exact shape:
{"suggestions": [{"id": <txn id>, "merchant": "<exact copy of that transaction's merchant field>", "category_id": <category id or null>, "confidence": <0..1>, "reasoning": "<one short sentence>"}]}`;

  const content = await complete(apiKey, model, prompt);
  /** @type {{suggestions?: Suggestion[]}} */
  let parsed;
  try {
    parsed = JSON.parse(extractJson(content));
  } catch {
    parsed = {};
  }
  const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

  const validIds = new Set(categories.map((c) => c.id));
  const byId = new Map(suggestions.filter((s) => s && typeof s.id === "number").map((s) => [s.id, s]));
  return txns.map((t) => {
    const s = byId.get(t.id);
    if (!s) return { id: t.id, category_id: null, confidence: 0, reasoning: "model returned no suggestion" };
    if (!echoMatches(s, t)) {
      return { id: t.id, category_id: null, confidence: 0, reasoning: "model mixed up rows in the batch; suggestion discarded" };
    }
    return {
      id: t.id,
      category_id: s.category_id !== null && validIds.has(s.category_id) ? s.category_id : null,
      confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0)),
      reasoning: String(s.reasoning ?? "").slice(0, 300),
    };
  });
}

/** @param {unknown} s @returns {string} case/whitespace-insensitive echo form */
function normEcho(s) {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Row-swap guard. Flash models occasionally duplicate one row's answer under a
 * neighbouring row's id when emitting batched JSON; the echoed merchant exposes
 * that, so a mismatch discards the suggestion (the txn falls through to pass 2)
 * instead of caching a confident lie. A missing/empty echo is accepted — no
 * echo is unverifiable, and rejecting it would zero out every suggestion from
 * a model that ignores the instruction. Matching raw_payee also passes: some
 * models echo the original string rather than the cleaned merchant.
 * @param {Suggestion} s
 * @param {TxnForLLM} t
 * @returns {boolean}
 */
function echoMatches(s, t) {
  if (typeof s.merchant !== "string" || !s.merchant.trim()) return true;
  const e = normEcho(s.merchant);
  return e === normEcho(t.merchant) || e === normEcho(t.raw_payee);
}

/**
 * Pass 2: ONE web-enabled call per unique cleaned merchant. The `:online` model
 * variant lets OpenRouter run the web search server-side; the browser itself only
 * ever talks to openrouter.ai (CSP holds). The caller caches the result under `key`.
 *
 * @param {string} apiKey
 * @param {string} key  unique merchant cache key (normalized cleanMerchant() value)
 * @param {string} merchant  display merchant string given to the model
 * @param {CategoryOption[]} categories
 * @returns {Promise<WebCheckResult>}
 */
export async function webCheckMerchant(apiKey, key, merchant, categories) {
  const prompt = `Identify this merchant and pick the best budget category. The merchant string comes from a Dutch (Netherlands) bank transaction; use the web to find what the business actually is.

Merchant: ${JSON.stringify(merchant || key)}

Categories (id: group / name):
${categoryList(categories)}

Respond with ONLY a JSON object of this exact shape:
{"category_id": <category id or null>, "confidence": <0..1>, "reasoning": "<one short sentence naming what the merchant is>"}`;

  const content = await complete(apiKey, WEB_MODEL, prompt);
  /** @type {{category_id?: number|null, confidence?: number, reasoning?: string}} */
  let parsed;
  try {
    parsed = JSON.parse(extractJson(content));
  } catch {
    parsed = {};
  }
  const validIds = new Set(categories.map((c) => c.id));
  const catId = typeof parsed.category_id === "number" && validIds.has(parsed.category_id) ? parsed.category_id : null;
  return {
    key,
    merchant,
    suggested_category_id: catId,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    reasoning: String(parsed.reasoning ?? "").slice(0, 300),
    web: true,
  };
}

/**
 * Models sometimes wrap JSON in markdown fences despite response_format.
 * @param {string} s
 * @returns {string}
 */
export function extractJson(s) {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1];
  const start = s.indexOf("{");
  return start >= 0 ? s.slice(start) : s;
}
