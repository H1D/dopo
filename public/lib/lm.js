// @ts-check
/**
 * Lunch Money v2 client — browser fetch, token passed per call, zero storage.
 * The token never leaves the device except toward api.lunchmoney.dev itself.
 */

const BASE = "https://api.lunchmoney.dev/v2";

/** HARD ceiling on transaction pages per state fetch (and per membership recheck). */
export const MAX_PAGES = 5;
const PAGE_LIMIT = 1000;
/** Hidden-flush keepalive PUTs must stay one small request (spec: ≤20 items, <64KB). */
export const KEEPALIVE_MAX_ITEMS = 20;

/**
 * Typed upstream failure so callers can map status without parsing message strings.
 * `.status === 401` is the distinct token-invalid signal.
 */
export class LMError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = "LMError";
    /** @type {number} */
    this.status = status;
  }
  /** @returns {boolean} */
  get tokenInvalid() {
    return this.status === 401;
  }
}

/**
 * @typedef {object} LMTransaction
 * @property {number} id
 * @property {string} date
 * @property {string} amount
 * @property {string} currency
 * @property {string|null} payee
 * @property {number|null} category_id
 * @property {string|null} notes
 * @property {string} status
 * @property {boolean} is_pending
 * @property {number|null} plaid_account_id
 * @property {number|null} manual_account_id
 */

/**
 * @typedef {object} LMCategory
 * @property {number} id
 * @property {string} name
 * @property {boolean} is_group
 * @property {number|null} group_id
 * @property {LMCategory[]} [children]
 */

/**
 * @typedef {object} LMAccount
 * @property {string} key  'p<id>' plaid | 'm<id>' manual — matches txn plaid_account_id/manual_account_id
 * @property {number} id
 * @property {"plaid"|"manual"} kind
 * @property {string} name
 * @property {string|null} institution
 * @property {string|null} mask
 * @property {string|null} type
 */

/**
 * @typedef {object} LeafCategory
 * @property {number} id
 * @property {string} name
 * @property {string|null} group
 */

/**
 * @typedef {object} LMState
 * @property {LeafCategory[]} categories  flat assignable leaves with group attached —
 *   the same shape the old /api/state served, which the UI renders directly
 * @property {LMAccount[]} accounts
 * @property {LMTransaction[]} transactions  unreviewed, non-pending (see isOpen)
 * @property {boolean} truncated  true when the 5-page ceiling was hit with more pages behind it
 * @property {number|null} total  total unreviewed count when known (API-reported when
 *   truncated; equals transactions.length otherwise; null when the API gives no total)
 */

/**
 * @typedef {object} CategoryUpdate
 * @property {number} id
 * @property {number} category_id
 */

/**
 * Low-level fetch wrapper. Throws LMError with the upstream status on any non-2xx.
 * @param {string} token
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function lm(token, path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init ? init.headers : undefined),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LMError(
      res.status,
      `Lunch Money ${init && init.method ? init.method : "GET"} ${path} -> ${res.status}: ${body.slice(0, 500)}`,
    );
  }
  return res.json();
}

/**
 * Live token validation: GET /v2/me. Throws LMError(401) on a bad token.
 * @param {string} token
 * @returns {Promise<{account_id: number, budget_name: string|null}>}
 */
export async function getMe(token) {
  const data = /** @type {Record<string, unknown>} */ (await lm(token, "/me"));
  // Tolerate the profile being nested under `user` across API revisions.
  const src =
    typeof data.user === "object" && data.user !== null
      ? /** @type {Record<string, unknown>} */ (data.user)
      : data;
  const accountId = typeof src.account_id === "number" ? src.account_id : null;
  if (accountId === null) throw new LMError(502, "GET /v2/me: response missing account_id");
  return {
    account_id: accountId,
    budget_name: typeof src.budget_name === "string" ? src.budget_name : null,
  };
}

/**
 * Leaf categories (assignable to transactions), with their group name attached.
 * @param {LMCategory[]} cats
 * @returns {LeafCategory[]}
 */
export function leafCategories(cats) {
  /** @type {LeafCategory[]} */
  const leaves = [];
  for (const c of cats) {
    if (c.is_group) {
      for (const child of c.children ?? []) leaves.push({ id: child.id, name: child.name, group: c.name });
    } else {
      leaves.push({ id: c.id, name: c.name, group: null });
    }
  }
  return leaves;
}

/**
 * How far back the deck reaches. Ids are persisted (lib/store.js `dopo.cutoff.v1`),
 * so renaming one silently resets that device to the default — add, don't rename.
 * @typedef {"1w"|"1m"|"3m"|"ytd"} CutoffId
 * @type {readonly {id: CutoffId, label: string}[]}
 */
export const CUTOFF_PRESETS = /** @type {const} */ ([
  { id: "1w", label: "Last week" },
  { id: "1m", label: "Last month" },
  { id: "3m", label: "Last 3 months" },
  { id: "ytd", label: "This year" },
]);

/** Jan 1 of the current year — what dopo has always fetched. */
export const DEFAULT_CUTOFF = /** @type {CutoffId} */ ("ytd");

/**
 * Subtract whole months from a UTC date, clamping the day to the target month's
 * length so "31 May minus 3 months" is 28/29 Feb, not 3 March.
 * @param {Date} from
 * @param {number} months
 * @returns {Date}
 */
function minusMonths(from, months) {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(from.getUTCDate(), lastDay)));
}

/**
 * The fetch window for a cutoff preset, ending today (UTC). Unknown ids — a
 * downgraded build, or storage written by a newer one — fall back to the default
 * rather than fetching an empty or unbounded range.
 * @param {string} [preset]
 * @param {Date} [now]
 * @returns {{start: string, end: string}}
 */
export function cutoffRange(preset = DEFAULT_CUTOFF, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = today.toISOString().slice(0, 10);
  /** @param {Date} d */
  const day = (d) => d.toISOString().slice(0, 10);
  switch (preset) {
    case "1w": {
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - 7);
      return { start: day(start), end };
    }
    case "1m":
      return { start: day(minusMonths(today, 1)), end };
    case "3m":
      return { start: day(minusMonths(today, 3)), end };
    default:
      return { start: `${today.getUTCFullYear()}-01-01`, end };
  }
}

/**
 * Jan 1 of the current year through today (UTC) — same window the Worker used.
 * @returns {{start: string, end: string}}
 */
export function defaultRange() {
  return cutoffRange(DEFAULT_CUTOFF);
}

/**
 * Deck membership: a transaction is "open" (still dopo's to sort) until Lunch
 * Money marks it reviewed. Already-categorized rows (LM rules, bank feeds) stay
 * in — the existing category rides along as a confirm-or-change suggestion.
 * Pending rows are skipped: their payee/amount can still change.
 * @param {Partial<LMTransaction>|null|undefined} t
 * @returns {boolean}
 */
export function isOpen(t) {
  return !!t && t.status !== "reviewed" && !t.is_pending;
}

/**
 * One paged sweep of unreviewed, non-pending transactions in the range.
 * Pages until `has_more` is false, HARD CEILING `maxPages`.
 * @param {string} token
 * @param {string} start
 * @param {string} end
 * @param {number} maxPages
 * @returns {Promise<{transactions: LMTransaction[], truncated: boolean, total: number|null}>}
 */
async function fetchUnreviewed(token, start, end, maxPages) {
  /** @type {LMTransaction[]} */
  const out = [];
  let offset = 0;
  let truncated = false;
  /** @type {number|null} */
  let apiTotal = null;
  for (let pages = 0; ; pages++) {
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    /** @type {{transactions: LMTransaction[], has_more: boolean, total?: number}} */
    const page = await lm(
      token,
      `/transactions?start_date=${start}&end_date=${end}&limit=${PAGE_LIMIT}&offset=${offset}`,
    );
    const txns = Array.isArray(page.transactions) ? page.transactions : [];
    out.push(...txns.filter(isOpen));
    if (typeof page.total === "number") apiTotal = page.total;
    if (!page.has_more) break;
    offset += txns.length;
  }
  return { transactions: out, truncated, total: truncated ? apiTotal : out.length };
}

/**
 * GET /v2/plaid_accounts + /v2/manual_accounts, normalized to one keyed list.
 * @param {string} token
 * @returns {Promise<LMAccount[]>}
 */
export async function getAccounts(token) {
  const [plaid, manual] = await Promise.all([
    lm(token, "/plaid_accounts"),
    lm(token, "/manual_accounts"),
  ]);
  /**
   * @param {{id: number, name: string, display_name?: string|null, institution_name?: string|null, mask?: string|null, type?: string|null}} a
   * @param {"plaid"|"manual"} kind
   * @returns {LMAccount}
   */
  const map = (a, kind) => ({
    key: `${kind === "plaid" ? "p" : "m"}${a.id}`,
    id: a.id,
    kind,
    name: a.display_name || a.name,
    institution: a.institution_name ?? null,
    mask: a.mask ?? null,
    type: a.type ?? null,
  });
  return [
    ...(plaid.plaid_accounts ?? []).map((/** @type {any} */ a) => map(a, "plaid")),
    ...(manual.manual_accounts ?? []).map((/** @type {any} */ a) => map(a, "manual")),
  ];
}

/**
 * Categories + accounts + unreviewed transactions in one call.
 * Transaction paging stops at the 5-page hard ceiling; `truncated`/`total` let the
 * UI say "oldest N of M" instead of silently pretending the window is complete.
 * @param {string} token
 * @param {{startDate?: string, endDate?: string, maxPages?: number}} [opts]
 * @returns {Promise<LMState>}
 */
export async function getState(token, opts = {}) {
  const range = defaultRange();
  const start = opts.startDate ?? range.start;
  const end = opts.endDate ?? range.end;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const [cats, accounts, txns] = await Promise.all([
    lm(token, "/categories"),
    getAccounts(token),
    fetchUnreviewed(token, start, end, maxPages),
  ]);
  return {
    categories: leafCategories(Array.isArray(cats.categories) ? cats.categories : []),
    accounts,
    transactions: txns.transactions,
    truncated: txns.truncated,
    total: txns.total,
  };
}

/**
 * GET /v2/transactions/{id}.
 * @param {string} token
 * @param {number} id
 * @returns {Promise<LMTransaction>}
 */
export async function getTransaction(token, id) {
  return lm(token, `/transactions/${id}`);
}

/**
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(arr, size) {
  /** @type {T[][]} */
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Bulk-set categories and mark reviewed.
 *
 * recheck "membership" (default — the only safe mode for normal flushes):
 *   fetches the current unreviewed window ONCE and membership-tests each update.
 *   On a miss it falls back to per-id GET /v2/transactions/{id}:
 *     404                 -> skipped (deleted, or token re-pointed at another budget)
 *     still unreviewed    -> sent   (merely outside the paged window / date range)
 *     reviewed            -> skipped (someone or something got there first)
 *   Absence from the window alone NEVER discards a decision.
 *
 * recheck "none" (hidden-flush only): no network recheck; the caller must have
 *   validated eligibility against its in-memory snapshot (same-session snapshotTs).
 *
 * PUT body per item is exactly {id, category_id, status: "reviewed"}.
 * With `keepalive: true` the whole flush is ONE keepalive PUT capped at 20 items.
 *
 * @param {string} token
 * @param {CategoryUpdate[]} updates
 * @param {{recheck?: "membership"|"none", keepalive?: boolean, startDate?: string, endDate?: string, maxPages?: number}} [opts]
 * @returns {Promise<{applied: number[], skipped: number[]}>}
 */
export async function applyCategories(token, updates, opts = {}) {
  const recheck = opts.recheck ?? "membership";
  /** @type {number[]} */
  const applied = [];
  /** @type {number[]} */
  const skipped = [];
  /** @type {CategoryUpdate[]} */
  let safe = [];

  if (recheck === "membership") {
    const range = defaultRange();
    const window = await fetchUnreviewed(
      token,
      opts.startDate ?? range.start,
      opts.endDate ?? range.end,
      opts.maxPages ?? MAX_PAGES,
    );
    const open = new Set(window.transactions.map((t) => t.id));
    /** @type {CategoryUpdate[]} */
    const misses = [];
    for (const u of updates) {
      if (open.has(u.id)) safe.push(u);
      else misses.push(u);
    }
    // Per-id fallback for misses, in small parallel batches.
    for (const batch of chunk(misses, 10)) {
      const current = await Promise.all(
        batch.map((u) =>
          getTransaction(token, u.id).catch((e) => {
            if (e instanceof LMError && e.status === 404) return null;
            throw e;
          }),
        ),
      );
      batch.forEach((u, i) => {
        const t = current[i];
        if (isOpen(t)) safe.push(u);
        else skipped.push(u.id);
      });
    }
  } else {
    safe = updates.slice();
  }

  if (!safe.length) return { applied, skipped };

  if (opts.keepalive) {
    if (safe.length > KEEPALIVE_MAX_ITEMS) {
      throw new Error(`keepalive flush must be one small PUT (<=${KEEPALIVE_MAX_ITEMS} items, got ${safe.length})`);
    }
    await putTransactions(token, safe, true);
    applied.push(...safe.map((u) => u.id));
    return { applied, skipped };
  }

  for (const batch of chunk(safe, 500)) {
    await putTransactions(token, batch, false);
    applied.push(...batch.map((u) => u.id));
  }
  return { applied, skipped };
}

/**
 * PUT /v2/transactions — the per-item body shape is load-bearing and fixture-tested.
 * @param {string} token
 * @param {CategoryUpdate[]} batch
 * @param {boolean} keepalive
 * @returns {Promise<void>}
 */
async function putTransactions(token, batch, keepalive) {
  await lm(token, "/transactions", {
    method: "PUT",
    keepalive,
    body: JSON.stringify({
      transactions: batch.map((u) => ({ id: u.id, category_id: u.category_id, status: "reviewed" })),
    }),
  });
}
