// table view — bulk categorize + local rules management.
// Zero backend: talks to Lunch Money directly with the token stored on this
// device (lib/store.js). AI suggestions live in swipe mode; this page is the
// manual bulk view.
import { getState, applyCategories } from "./lib/lm.js";
import { getTokens, rulesLoad, rulesSave } from "./lib/store.js";
import { cleanMerchant } from "./lib/clean.js";

/** @typedef {import("./lib/lm.js").LMTransaction} Txn */
/** @typedef {{id: number, name: string, group: string|null}} LeafCategory */
/** Local rules carry an extra per-device flag: "already mirrored in the LM rules UI". */
/** @typedef {import("./lib/rules.js").Rule & { mirrored_in_lm?: boolean }} TableRule */

/** @type {{ transactions: Txn[], leaves: LeafCategory[], truncated: boolean, total: number|null }} */
let state = { transactions: [], leaves: [], truncated: false, total: null };

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

function render() {
  const { transactions } = state;
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
  render();
}

/** @param {{ id: number, category_id: number }[]} items @returns {number} */
function createRulesFor(items) {
  const byId = new Map(state.transactions.map((t) => [Number(t.id), t]));
  const catById = new Map(state.leaves.map((c) => [Number(c.id), c]));
  const existing = /** @type {TableRule[]} */ (rulesLoad());
  /** @type {TableRule[]} */
  const added = [];
  for (const item of items) {
    const txn = byId.get(item.id);
    const cat = catById.get(item.category_id);
    const pattern = txn ? cleanMerchant(txn.payee || "") : "";
    if (!txn || !cat || !pattern) continue;
    if (existing.some((r) => r.pattern === pattern) || added.some((r) => r.pattern === pattern)) continue;
    added.push({
      id: Date.now() + added.length,
      pattern,
      match_type: "contains",
      category_id: item.category_id,
      category_name: catLabel(cat),
      hits: 0,
      created_at: new Date().toISOString(),
      mirrored_in_lm: false,
    });
  }
  if (added.length) rulesSave([...existing, ...added]);
  return added.length;
}

$("#apply").addEventListener("click", async () => {
  const items = selectedItems();
  if (!items.length) return;
  if (!confirm(`Write ${items.length} categor${items.length === 1 ? "y" : "ies"} to Lunch Money and mark reviewed?`)) return;
  const btn = /** @type {HTMLButtonElement} */ ($("#apply"));
  btn.disabled = true;
  btn.textContent = `Applying ${items.length}…`;
  try {
    const tokens = getTokens();
    if (!tokens.lm) throw new Error("no Lunch Money token on this device");
    const updates = items.map(({ id, category_id }) => ({ id, category_id }));
    const r = await applyCategories(tokens.lm, updates, { recheck: "membership" });
    const rulesMade = createRulesFor(items.filter((i) => i.make_rule));
    const skippedNote = r.skipped.length ? `, skipped ${r.skipped.length} (already categorized elsewhere)` : "";
    toast(`Applied ${r.applied.length}${skippedNote}${rulesMade ? `, ${rulesMade} rule(s) saved` : ""}`);
    await refresh();
  } catch (e) {
    const err = /** @type {{ status?: number, message?: string }} */ (e);
    toast(err.status === 401
      ? "Lunch Money rejected the token — update it in swipe-mode Settings"
      : `Apply failed: ${err.message || String(e)}`);
    btn.disabled = false;
  }
});

/** @param {unknown} s */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch
  ));
}

const tokens = getTokens();
if (!tokens.lm) {
  $("#txns").outerHTML = '<div id="txns" class="empty">No Lunch Money token on this device yet — add one in <a href="./">swipe mode</a> → Settings, then come back.</div>';
  renderRules();
} else {
  refresh().catch((e) => {
    const err = /** @type {{ status?: number, message?: string }} */ (e);
    toast(err.status === 401
      ? "Lunch Money rejected the token — update it in swipe-mode Settings"
      : `Load failed: ${err.message || String(e)}`);
  });
}
