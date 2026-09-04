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

/** Lunch Money dates are calendar days (`YYYY-MM-DD`); some feeds carry a full timestamp. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Intl.DateTimeFormat construction is the expensive part — one per option set. */
/** @type {Map<string, Intl.DateTimeFormat>} */
const dtfCache = new Map();
/** @param {Intl.DateTimeFormatOptions} opts @returns {Intl.DateTimeFormat} */
function dtf(opts) {
  const key = JSON.stringify(opts);
  let f = dtfCache.get(key);
  // `undefined` locale = the browser's own regional preference, which is the point:
  // the same day reads "31 August" in en-GB, "August 31" in en-US, "31 augustus" in nl.
  if (!f) { f = new Intl.DateTimeFormat(undefined, opts); dtfCache.set(key, f); }
  return f;
}

/**
 * Parse an LM transaction date. A bare `YYYY-MM-DD` is a calendar day and is built
 * in LOCAL time — `new Date("2026-08-31")` is UTC midnight, which renders as the
 * 30th for anyone west of Greenwich.
 * @param {unknown} date
 * @returns {{at: Date, hasTime: boolean}|null} null when unparseable
 */
export function parseTxnDate(date) {
  const s = String(date ?? "").trim();
  if (!s) return null;
  const m = DATE_ONLY.exec(s);
  if (!m) {
    const at = new Date(s);
    return Number.isNaN(at.getTime()) ? null : { at, hasTime: true };
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(y, mo - 1, d);
  // The Date constructor rolls "2026-13-45" over into 2027 rather than failing;
  // corrupt input must read as unparseable, not as a confidently wrong day.
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return null;
  return { at, hasTime: false };
}

/**
 * Day + month name in the reader's own locale ("31 August" / "August 31"), plus the
 * time when the source carries one and the year when it isn't the current one.
 * Unparseable input falls back to the raw string rather than "Invalid Date".
 * @param {unknown} date
 * @param {Date} [now]  today, for the "same year → drop the year" test
 * @returns {string}
 */
export function fmtTxnDate(date, now = new Date()) {
  const p = parseTxnDate(date);
  if (!p) return String(date ?? "");
  /** @type {Intl.DateTimeFormatOptions} */
  const opts = { day: "numeric", month: "long" };
  if (p.at.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  if (p.hasTime) { opts.hour = "numeric"; opts.minute = "2-digit"; }
  try {
    return dtf(opts).format(p.at);
  } catch {
    return String(date); // no Intl data for the requested fields
  }
}

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
    : s?.source === "lm"
      ? '<span class="card-badge lm-badge">already categorized</span>'
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
      <div class="txn-date">${esc(fmtTxnDate(t.date))}${acctHtml}</div>
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
