// @ts-check
/**
 * Extract a readable merchant name from messy Dutch bank payee strings, e.g.
 *   "To Van Dijk Incasso B.V. via Stichting Mollie Payments - 79bd... Dossier 123 ... - IBAN: NL51..."
 *   "BCK*ALBERT HEIJN 1573 AMSTERDAM NLD"
 *   "Zettle_*De Koffiezaak AMSTERDAM"
 *   "BEA, Apple Pay K-supermarket Kaisanie,PAS362 NR:39I30740, 19.05.26/16:41 Helsinki, Land: FIN"
 * Pure — fixture-tested against real payee shapes (tests/clean.test.ts).
 *
 * @param {string} payee
 * @returns {string}
 */
export function cleanMerchant(payee) {
  let s = payee.trim();

  // ABN AMRO card terminals: "BEA, Apple Pay <merchant>,PAS123 NR:ABC, 19.05.26/16:41 CITY, Land: FIN"
  // ("GEA, Betaalpas …" for ATMs). Merchant sits between the wallet and the card number; the
  // "city" slot is the fallback when the merchant slot is only a reference (OVpay check-ins).
  /** @type {string|null} */
  let beaCity = null;
  const bea = /^[BG]EA,\s*(?:apple pay|google pay|betaalpas|contactloos)?\s*(.*?),\s*PAS\d+\s+NR:\S+,\s*\d\d\.\d\d\.\d\d\/\d\d:\d\d\s*(.*?)(?:,\s*Land:\s*\w+)?\s*$/i.exec(s);
  if (bea) {
    s = bea[1] ?? "";
    beaCity = (bea[2] ?? "").trim() || null;
  }
  s = s.replace(/^(?:payment|refund|betaling|terugbetaling)\s+(?:to|from|aan|van)\s+/i, "");
  s = s.replace(/^(to|from|naar|van)\s+/i, "");
  // Pay.nl's own intermediary phrasing: "Stichting Pay.nl - Pay.nl inzake <merchant> / …"
  s = s.replace(/^stichting\s+pay\.?nl\s*-\s*pay\.?nl\s+inzake\s+/i, "");
  // PSP prefixes: "BCK*", "CCV*", "Zettle_*", "SumUp *", "PAY.nl*", "MSP*" etc.
  s = s.replace(/^(bck|ccv|zettle_?|sumup|paynl|pay\.nl|msp|mollie|stg|st)\s?\*\s?/i, "");
  // Keep what's before the PSP intermediary phrase
  s = s.replace(/\s+via\s+(stichting\s+)?(mollie|adyen|buckaroo|pay\.?nl|multisafepay|opp|online\s*payment)[\s\S]*$/i, "");
  // Drop trailing IBAN and everything after
  s = s.replace(/\s*-?\s*iban:?\s*[A-Z]{2}\d{2}[A-Z0-9]{4,}[\s\S]*$/i, "");
  // Drop dossier/kenmerk/factuur references and everything after
  s = s.replace(/\s+(dossier|kenmerk|factuur|referentie|ref\.?|klantnr)[:\s#]*\S+[\s\S]*$/i, "");
  // Drop long hex/numeric transaction references, UUIDs, and order/ticket codes
  // (8+ letters-and-digits with at least one digit: "9Z9RK99A9", "TM1234567", "CA1234567890")
  s = s.replace(/\s+[0-9a-f]{16,}\b/gi, " ");
  s = s.replace(/\s+\d{10,}\b/g, " ");
  s = s.replace(/\s*\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "");
  s = s.replace(/(^|[\s*])(?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/g, "$1");
  s = s.replace(/(?<=[A-Za-z0-9])\*(?=\s|$)/g, ""); // the star a dropped code hung off ("NL* ", "PATREON* ")
  // Numeric-only tokens of 5+ (dates "01/09/26", member numbers "1234-56789"); 4-digit store numbers stay
  s = s.replace(/(^|\s)[\d/.:-]{5,}(?=\s|$)/g, "$1");
  // Repeated segments and bare references between " / " or " - " ("The Movies / The Movies / RF-4597-2018")
  s = s.replace(/(?:\s+[/-]){2,}\s+/g, " - ");
  if (/\s[/-]\s/.test(s)) {
    /** @type {string[]} */ const parts = [];
    const seen = new Set();
    for (const raw of s.split(/\s+[/-]\s+/)) {
      const p = raw.trim();
      const k = p.toLowerCase();
      if (!p || seen.has(k) || /^[a-z]{0,3}-?[\d-]{6,}$/i.test(p)) continue;
      seen.add(k);
      parts.push(p);
    }
    if (parts.length) s = parts.join(" - ");
  }
  // Drop trailing country/city noise common in card payee strings
  s = s.replace(/\s+(NLD?|BEL|DEU|GBR|USA|FRA|ESP|ITA|IRL|LUX|FIN|CHE|AUT|SWE|DNK|NOR|POL|PRT|CZE|HUN|GRC|TUR|EST|LVA|LTU|ISL|CAN|AUS|JPN)$/i, "");
  s = s.replace(/\s{2,}/g, " ").replace(/^[\s\-,*:]+|[\s\-,*:]+$/g, "").trim();

  return s || beaCity || payee.trim();
}

/**
 * ABN AMRO card payees embed the purchase moment: "…, 19.05.26/16:41 Helsinki".
 * Returns it as a LOCAL wall-clock ISO string ("2026-05-19T16:41:00", no zone — the
 * bank prints the terminal's clock), or null when the payee carries none.
 * @param {unknown} payee
 * @returns {string|null}
 */
export function timeFromPayee(payee) {
  const m = /(\d\d)\.(\d\d)\.(\d\d)\/(\d\d):(\d\d)\b/.exec(String(payee ?? ""));
  if (!m) return null;
  const [d, mo, y, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `20${pad(y)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00`;
}
