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
 * True when the purchase moment falls on a different LOCAL calendar day than the booking
 * day Lunch Money holds — the card then shows the moment and files the booking day under details.
 * @param {unknown} date
 * @param {unknown} time
 * @returns {boolean}
 */
export function bookedApart(date, time) {
  const d = parseTxnDate(date);
  const w = time ? parseTxnDate(time) : null;
  if (!d || !w || !w.hasTime) return false;
  return d.at.getFullYear() !== w.at.getFullYear() || d.at.getMonth() !== w.at.getMonth() || d.at.getDate() !== w.at.getDate();
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
 * @property {unknown} [time]  purchase moment (see lm.slimTxn); the card shows it in place of the booking day
 * @property {unknown} [notes]
 * @property {CardSuggestion|null} [suggestion]
 */

/** @typedef {"idle"|"busy"|null} AskAi  null = no button; "busy" = the model is being asked now */

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
 * @param {{name: string, group?: string|null}|null} [opts.held]  the category Lunch Money holds
 *   on this row, shown as a footnote when the card suggests something else
 * @param {AskAi} [opts.askAi]  render the "Ask AI" button (pre-categorized / bare rows the model hasn't seen)
 * @param {number} [opts.confidentAt]
 * @returns {string}
 */
export function cardHTML(txn, { category = null, account = null, held = null, askAi = null, confidentAt = CONFIDENT_AT } = {}) {
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
  // a model verdict on a row Lunch Money already categorized only reaches the card
  // when it disagrees (data.js mergeAi) — say so, it is the whole point of the card
  const heldShown = !!held && !!s && s.source !== "rule" && s.source !== "lm";
  const badgeHtml = s?.source === "rule"
    ? '<span class="card-badge rule-badge">rule match</span>'
    : s?.source === "lm"
      ? '<span class="card-badge lm-badge">already categorized</span>'
      : heldShown && confident
        ? '<span class="card-badge disagree-badge">AI disagrees</span>'
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
  const heldBits = held ? splitEmoji(held.name) : null;
  const heldHtml = heldShown && heldBits
    ? `<div class="held-line">Lunch Money has: ${esc(heldBits.emoji ? heldBits.emoji + " " : "")}${esc(heldBits.text)}</div>`
    : "";
  const askHtml = askAi === "busy"
    ? '<button class="ask-ai" type="button" disabled aria-busy="true">✨ Asking AI…</button>'
    : askAi === "idle"
      ? '<button class="ask-ai" type="button">✨ Ask AI</button>'
      : "";
  const whenHtml = esc(fmtTxnDate(t.time || t.date));
  const bookedRowHtml = bookedApart(t.date, t.time) ? `<div><b>booked:</b> ${esc(fmtTxnDate(t.date))}</div>` : "";
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
      <div class="txn-date">${whenHtml}${acctHtml}</div>
      <div class="reason">${esc(s?.reasoning || "not classified yet")}</div>
      ${heldHtml}
      ${evidenceHtml}
      ${askHtml}
      <button class="details-toggle" type="button" aria-label="Details">ⓘ</button>
      <div class="details">
        <div><b>raw:</b> ${esc(t.payee || "—")}</div>
        ${bookedRowHtml}
        ${lookupRowHtml}
        ${notesRowHtml}
      </div>
      <div class="wash"></div>
      <div class="stamp stamp-right">${stampHtml}</div>
      <div class="stamp stamp-left">LATER</div>`;
}
