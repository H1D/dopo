// @ts-check
/**
 * dopo card template — PURE string builders, no DOM access.
 * Imported by app.js for rendering and by tests (XSS fixtures) without a DOM.
 * Every interpolation of transaction/category/account data goes through esc().
 */

export const CONFIDENT_AT = 0.7;

/**
 * HTML-escape untrusted text.
 * @param {unknown} s
 * @returns {string}
 */
export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch
));

/**
 * Split a leading emoji off a category name: "🍕 Food" -> {emoji:"🍕", text:"Food"}.
 * @param {unknown} name
 * @returns {{emoji: string|null, text: string}}
 */
export function splitEmoji(name) {
  const m = String(name).match(/^\s*((?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:[️⃣]|‍(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}))*)\s*(.*)$/u);
  if (m && m[1] && m[2]) return { emoji: m[1], text: m[2] };
  return { emoji: null, text: String(name).trim() };
}

/**
 * LM sign convention: positive = money OUT.
 * @param {{amount?: unknown, currency?: unknown}} t
 * @returns {{sign: string, abs: string, cur: string, dir: "in"|"out"}}
 */
export function fmtAmount(t) {
  const n = Number(t.amount);
  const sign = n > 0 ? "−" : "+";
  return { sign, abs: Math.abs(n).toFixed(2), cur: String(t.currency || "").toUpperCase(), dir: n > 0 ? "out" : "in" };
}

/**
 * @param {{amount?: unknown, currency?: unknown}} t
 * @returns {string}
 */
export const fmtAmountText = (t) => { const a = fmtAmount(t); return `${a.sign}${a.abs} ${a.cur}`; };

/**
 * Loose suggestion shape as rendered on a card.
 * @typedef {object} CardSuggestion
 * @property {number|null} [suggested_category_id]
 * @property {number|null} [confidence]
 * @property {string} [reasoning]
 * @property {string} [source]
 * @property {string} [lookup]
 */

/**
 * Loose transaction shape as rendered on a card.
 * @typedef {object} CardTxn
 * @property {unknown} [merchant]
 * @property {unknown} [payee]
 * @property {unknown} [amount]
 * @property {unknown} [currency]
 * @property {unknown} [date]
 * @property {unknown} [notes]
 * @property {CardSuggestion|null} [suggestion]
 */

/**
 * Confident = rule match, or model/web confidence at/above threshold.
 * @param {CardTxn} t
 * @param {number} [confidentAt]
 * @returns {boolean}
 */
export function isConfident(t, confidentAt = CONFIDENT_AT) {
  const s = t.suggestion;
  return !!(s && s.suggested_category_id != null && (s.source === "rule" || (s.confidence ?? 0) >= confidentAt));
}

/**
 * Inner HTML of a swipe card. Pure: txn + resolved category/account in, string out.
 * @param {CardTxn} txn
 * @param {object} [opts]
 * @param {{name: string, group?: string|null}|null} [opts.category]  resolved suggested category
 * @param {{name: string, mask?: string|null}|null} [opts.account]  resolved account
 * @param {number} [opts.confidentAt]
 * @returns {string}
 */
export function cardHTML(txn, { category = null, account = null, confidentAt = CONFIDENT_AT } = {}) {
  const t = txn;
  const s = t.suggestion;
  const cat = s && s.suggested_category_id != null ? category : null;
  const catBits = cat ? splitEmoji(cat.name) : null;
  const confident = isConfident(t, confidentAt);
  const unsure = !confident;
  const conf = s ? (s.source === "rule" ? 1 : (s.confidence ?? 0)) : 0;
  const C = 2 * Math.PI * 50;
  const a = fmtAmount(t);

  // Pre-escaped fragments (*Html) — the esc() CI tripwire allows only these,
  // esc(...)/Number(...) calls, and literals inside HTML template lines.
  const badgeHtml = s?.source === "rule"
    ? '<span class="card-badge rule-badge">rule match</span>'
    : s?.source === "web"
      ? '<span class="card-badge web-badge">🌐 web-checked</span>'
      : unsure ? '<span class="card-badge unsure-badge">unsure</span>' : "";
  const heroHtml = esc(catBits?.emoji || (cat ? "🧾" : "❓"));
  const chipHtml = cat && catBits ? esc(catBits.text) : "tap to pick a category";
  const groupHtml = cat?.group ? `<div class="cat-group">${esc(cat.group)}</div>` : "";
  const unsureHtml = confident ? "" : '<div class="unsure-hint">🤔 not sure — swipe right to choose</div>';
  const acctHtml = account
    ? ` · 💳 ${esc(account.name)}${account.mask ? " ··" + esc(account.mask) : ""}`
    : "";
  const evidenceHtml = s?.lookup ? `<div class="evidence">🔎 ${esc(s.lookup)}</div>` : "";
  const lookupRowHtml = s?.lookup ? `<div><b>lookup:</b> ${esc(s.lookup)}</div>` : "";
  const notesRowHtml = t.notes ? `<div><b>notes:</b> ${esc(t.notes)}</div>` : "";
  const stampHtml = confident ? "SORTED ✓" : "CHOOSE";

  return `
      ${badgeHtml}
      <div class="hero">
        <div class="hero-ring">
          <svg viewBox="0 0 108 108" width="108" height="108" aria-hidden="true">
            <circle class="ring-bg" cx="54" cy="54" r="50" fill="none" stroke-width="5"></circle>
            <circle class="ring-fg" cx="54" cy="54" r="50" fill="none" stroke-width="5"
              stroke-dasharray="${Number((conf * C).toFixed(1))} ${Number(C.toFixed(1))}"></circle>
          </svg>
          <div class="hero-emoji">${heroHtml}</div>
        </div>
        <button class="cat-chip" type="button">${chipHtml}</button>
        ${groupHtml}
        ${unsureHtml}
      </div>
      <div class="merchant">${esc(t.merchant || t.payee || "Unknown")}</div>
      <div class="amount ${esc(a.dir)}">${esc(a.sign)}${esc(a.abs)}<span class="cur">${esc(a.cur)}</span></div>
      <div class="txn-date">${esc(t.date || "")}${acctHtml}</div>
      <div class="reason">${esc(s?.reasoning || "not classified yet")}</div>
      ${evidenceHtml}
      <button class="details-toggle" type="button">ⓘ details</button>
      <div class="details">
        <div><b>raw:</b> ${esc(t.payee || "—")}</div>
        ${lookupRowHtml}
        ${notesRowHtml}
      </div>
      <div class="wash"></div>
      <div class="stamp stamp-right">${stampHtml}</div>
      <div class="stamp stamp-left">LATER</div>`;
}
