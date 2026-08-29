// table view — bulk categorize + local rules management.
// Zero backend: talks to Lunch Money directly with the token stored on this
// device (lib/store.js). AI suggestions live in swipe mode; this page is the
// manual bulk view.
//
// Offline-first: Apply lands every decision in the dopo.queue.v1 queue FIRST
// (durable on this device), then attempts an immediate replay (lib/sync.js).
// A network failure is a success state here — the change is saved and will
// sync later. Queued ids are excluded from the list so a pending decision
// never re-renders as uncategorized.
import { getState } from "./lib/lm.js";
import { getTokens, rulesLoad, rulesSave, queueLoad, queueMutate, LS_KEYS } from "./lib/store.js";
import { replayQueue } from "./lib/sync.js";
import { cleanMerchant } from "./lib/clean.js";

/** @typedef {import("./lib/lm.js").LMTransaction} Txn */
/** @typedef {import("./lib/store.js").QueueItem} QueueItem */
/** @typedef {{id: number, name: string, group: string|null}} LeafCategory */
/** Local rules carry an extra per-device flag: "already mirrored in the LM rules UI". */
/** @typedef {import("./lib/rules.js").Rule & { mirrored_in_lm?: boolean }} TableRule */

/** @type {{ transactions: Txn[], leaves: LeafCategory[], truncated: boolean, total: number|null }} */
let state = { transactions: [], leaves: [], truncated: false, total: null };
let loaded = false;

/** @param {string} sel @returns {HTMLElement} */
const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

/** @param {string} msg */
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3500);
}

/** @param {LeafCategory} c */
function catLabel(c) {
  return c.group ? `${c.group} / ${c.name}` : c.name;
}

/** @param {Txn} t */
function fmtAmount(t) {
  const n = Number(t.amount);
  const sign = n > 0 ? "−" : "+"; // LM: positive = outflow
  return `${sign}${Math.abs(n).toFixed(2)} ${String(t.currency || "").toUpperCase()}`;
}

function updateQueuedBanner() {
  const n = queueLoad().length;
  const el = $("#queued");
  el.hidden = !n;
  el.textContent = n ? `${n} queued — will sync` : "";
}

function render() {
  // Pending local decisions must not re-render as uncategorized.
  const queuedIds = new Set(queueLoad().map((q) => q.id));
  const transactions = state.transactions.filter((t) => !queuedIds.has(Number(t.id)));
  const truncNote = state.truncated ? ` (oldest ${transactions.length} of ${state.total ?? "more"})` : "";
  $("#summary").textContent = `${transactions.length} uncategorized${truncNote}`;

  if (!transactions.length) {
    $("#txns").outerHTML = '<div id="txns" class="empty">Nothing uncategorized 🎉</div>';
    renderRules();
    updateApply();
    return;
  }

  const optionsHtml = state.leaves
    .map((c) => `<option value="${Number(c.id)}">${esc(catLabel(c))}</option>`)
    .join("");
  const rowsHtml = transactions.map((t) => {
    const merchant = cleanMerchant(t.payee || "");
    return `<tr data-id="${Number(t.id)}">
      <td>${esc(t.date)}</td>
      <td class="amount">${esc(fmtAmount(t))}</td>
      <td><div class="merchant">${esc(merchant)}</div>
          <div class="raw" title="click to expand">${esc(t.payee || "")}</div></td>
      <td><select class="cat"><option value="">— pick category —</option>${optionsHtml}</select></td>
      <td><label class="mk"><input type="checkbox" class="mkrule"> rule</label></td>
    </tr>`;
  }).join("");

  $("#txns").outerHTML = `<table id="txns"><thead><tr>
    <th>Date</th><th>Amount</th><th>Payee</th><th>Category</th><th>Save as</th>
  </tr></thead><tbody>${rowsHtml}</tbody></table>`;

  for (const tr of document.querySelectorAll("#txns tbody tr")) {
    const sel = /** @type {HTMLSelectElement} */ (tr.querySelector("select.cat"));
    sel.addEventListener("change", updateApply);
    /** @type {HTMLElement} */ (tr.querySelector(".raw"))
      .addEventListener("click", (e) => /** @type {HTMLElement} */ (e.target).classList.toggle("open"));
  }
  renderRules();
  updateApply();
}

function renderRules() {
  const rules = /** @type {TableRule[]} */ (rulesLoad());
  if (!rules.length) {
    $("#rules").innerHTML = '<p class="rules-note">No local rules yet — tick "rule" when applying a category to create one.</p>';
    return;
  }
  const rulesRowsHtml = rules.map((r) => {
    const mirroredHtml = r.mirrored_in_lm
      ? "✓"
      : `<button data-mirror="${Number(r.id)}">mark done</button>`;
    return `<tr>
      <td>${esc(r.pattern)}</td><td>${esc(r.match_type)}</td>
      <td>${esc(r.category_name || r.category_id)}</td><td>${Number(r.hits || 0)}</td>
      <td>${mirroredHtml}</td>
      <td><button data-del="${Number(r.id)}">delete</button></td>
    </tr>`;
  }).join("");
  $("#rules").innerHTML = `<table><thead><tr>
      <th>Pattern</th><th>Match</th><th>Category</th><th>Hits</th><th>Mirrored in LM</th><th></th>
    </tr></thead><tbody>${rulesRowsHtml}</tbody></table>`;
  for (const b of document.querySelectorAll("[data-mirror]")) {
    b.addEventListener("click", () => {
      const id = Number(/** @type {HTMLElement} */ (b).dataset.mirror);
      rulesSave(/** @type {TableRule[]} */ (rulesLoad())
        .map((r) => (r.id === id ? { ...r, mirrored_in_lm: true } : r)));
      renderRules();
    });
  }
  for (const b of document.querySelectorAll("[data-del]")) {
    b.addEventListener("click", () => {
      const id = Number(/** @type {HTMLElement} */ (b).dataset.del);
      rulesSave(rulesLoad().filter((r) => r.id !== id));
      renderRules();
    });
  }
}

/** @returns {{ id: number, category_id: number, make_rule: boolean }[]} */
function selectedItems() {
  return [...document.querySelectorAll("#txns tbody tr")].flatMap((tr) => {
    const row = /** @type {HTMLElement} */ (tr);
    const category_id = Number(/** @type {HTMLSelectElement} */ (row.querySelector("select.cat")).value);
    if (!category_id) return [];
    const make_rule = /** @type {HTMLInputElement} */ (row.querySelector(".mkrule")).checked;
    return [{ id: Number(row.dataset.id), category_id, make_rule }];
  });
}

function updateApply() {
  const n = selectedItems().length;
  const btn = /** @type {HTMLButtonElement} */ ($("#apply"));
  btn.disabled = !n;
  btn.textContent = n ? `Apply ${n} to Lunch Money` : "Apply selected to Lunch Money";
}

/**
 * Rules absorbed from queued make_rule items (lib/sync.js ruleAdd) carry no
 * category_name — the dopo.queue.v1 make_rule shape can't hold one. Backfill
 * from the loaded leaves so the rules table shows names, not raw ids.
 */
function backfillRuleNames() {
  const catById = new Map(state.leaves.map((c) => [Number(c.id), c]));
  const rules = /** @type {TableRule[]} */ (rulesLoad());
  if (!rules.some((r) => !r.category_name && catById.has(r.category_id))) return;
  rulesSave(rules.map((r) => {
    const cat = r.category_name ? undefined : catById.get(r.category_id);
    return cat ? { ...r, category_name: catLabel(cat) } : r;
  }));
}

async function refresh() {
  const tokens = getTokens();
  if (!tokens.lm) return;
  const s = await getState(tokens.lm);
  state = {
    transactions: s.transactions,
    leaves: s.categories, // getState already returns flattened leaves
    truncated: s.truncated,
    total: s.total,
  };
  loaded = true;
  backfillRuleNames();
  render();
}

$("#apply").addEventListener("click", async () => {
  const items = selectedItems();
  if (!items.length) return;
  if (!confirm(`Write ${items.length} categor${items.length === 1 ? "y" : "ies"} to Lunch Money and mark reviewed?`)) return;
  const btn = /** @type {HTMLButtonElement} */ ($("#apply"));
  btn.disabled = true;
  btn.textContent = `Applying ${items.length}…`;

  // Queue-first: every decision is durable locally BEFORE any network I/O.
  // Replace-by-id — a fresh pick for the same txn supersedes an older queued one
  // (queueMutate's max-ts collapse backstops the cross-tab race).
  const now = Date.now();
  const byId = new Map(state.transactions.map((t) => [Number(t.id), t]));
  try {
    await queueMutate((queue) => {
      for (const { id, category_id, make_rule } of items) {
        const i = queue.findIndex((q) => q.id === id);
        if (i !== -1) queue.splice(i, 1);
        /** @type {QueueItem} */
        const item = { id, category_id, ts: now, flushable: true, sent: false, snapshotTs: null };
        const txn = byId.get(id);
        const pattern = make_rule && txn ? cleanMerchant(txn.payee || "") : "";
        if (pattern) item.make_rule = { pattern, match_type: "contains" };
        queue.push(item);
      }
    });
  } catch (e) {
    const err = /** @type {{ message?: string }} */ (e);
    toast(`Couldn't save on this device: ${err.message || String(e)}`);
    updateApply();
    return;
  }
  updateQueuedBanner();
  render(); // queued rows leave the list immediately — no conflicting re-selection

  btn.disabled = true;
  btn.textContent = `Syncing ${items.length}…`;
  try {
    const tokens = getTokens();
    if (!tokens.lm) throw new TypeError("no Lunch Money token on this device");
    const rulesBefore = rulesLoad().length;
    const r = await replayQueue(tokens.lm);
    // make_rule absorption happens inside replayQueue (deduped ruleAdd) — count
    // what actually landed via the local-rules length delta.
    const rulesMade = rulesLoad().length - rulesBefore;
    const skipped = r.skippedSent.length + r.skippedUnsent.length;
    const skippedNote = skipped ? `, skipped ${skipped} (already categorized elsewhere)` : "";
    toast(`Applied ${r.applied.length}${skippedNote}${rulesMade ? `, ${rulesMade} rule(s) saved` : ""}`);
    await refresh().catch(() => {}); // sync landed; a failed reload can wait
  } catch (e) {
    const err = /** @type {{ status?: number }} */ (e);
    // Offline-first: the decisions are already durable on this device, so a
    // network-class failure (fetch rejection / non-401 LM error / parse garbage)
    // is a success state, not an error.
    toast(err.status === 401
      ? "Lunch Money rejected the token — update it in swipe-mode Settings"
      : "Saved on this device — will sync");
  } finally {
    updateQueuedBanner();
    renderRules(); // replay may have absorbed make_rule items into local rules
    updateApply();
  }
});

/** @param {unknown} s */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch
  ));
}

// Another tab changed the queue — recount the banner and re-filter the list.
window.addEventListener("storage", (e) => {
  if (e.key !== null && e.key !== LS_KEYS.queue) return;
  updateQueuedBanner();
  if (loaded) render();
});

/**
 * Boot: quiet replay of any leftover queue (offline failures are normal), then
 * load. A network-class load failure shows the offline message — the table has
 * no snapshot rendering in v1.
 * @param {string} lmToken
 */
async function boot(lmToken) {
  if (queueLoad().length) {
    try {
      await replayQueue(lmToken);
    } catch {
      // offline is normal; the queued banner keeps the count visible
    }
    updateQueuedBanner();
  }
  try {
    await refresh();
  } catch (e) {
    const err = /** @type {{ status?: number, message?: string }} */ (e);
    if (err.status === 401) {
      toast("Lunch Money rejected the token — update it in swipe-mode Settings");
      return;
    }
    const n = queueLoad().length;
    const msg = n
      ? `Offline — your ${n} queued change${n === 1 ? "" : "s"} will sync when you're back`
      : "Offline — couldn't load transactions; they'll appear when you're back online";
    $("#txns").outerHTML = `<div id="txns" class="empty">${esc(msg)}</div>`;
    renderRules();
    toast(msg);
  }
}

const tokens = getTokens();
updateQueuedBanner();
if (!tokens.lm) {
  $("#txns").outerHTML = '<div id="txns" class="empty">No Lunch Money token on this device yet — add one in <a href="./">swipe mode</a> → Settings, then come back.</div>';
  renderRules();
} else {
  boot(tokens.lm);
}
