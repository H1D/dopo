// @ts-check
/**
 * Extract a readable merchant name from messy Dutch bank payee strings, e.g.
 *   "To Van Dijk Incasso B.V. via Stichting Mollie Payments - 79bd... Dossier 123 ... - IBAN: NL51..."
 *   "BCK*ALBERT HEIJN 1573 AMSTERDAM NLD"
 *   "Zettle_*De Koffiezaak AMSTERDAM"
 * Pure port of the Worker's enrich.cleanMerchant — fixture-tested to stay in lockstep.
 *
 * @param {string} payee
 * @returns {string}
 */
export function cleanMerchant(payee) {
  let s = payee.trim();

  s = s.replace(/^(to|from|naar|van)\s+/i, "");
  // PSP prefixes: "BCK*", "CCV*", "Zettle_*", "SumUp *", "PAY.nl*", "MSP*" etc.
  s = s.replace(/^(bck|ccv|zettle_?|sumup|paynl|pay\.nl|msp|mollie|stg|st)\s?\*\s?/i, "");
  // Keep what's before the PSP intermediary phrase
  s = s.replace(/\s+via\s+(stichting\s+)?(mollie|adyen|buckaroo|pay\.?nl|multisafepay|opp|online\s*payment)[\s\S]*$/i, "");
  // Drop trailing IBAN and everything after
  s = s.replace(/\s*-?\s*iban:?\s*[A-Z]{2}\d{2}[A-Z0-9]{4,}[\s\S]*$/i, "");
  // Drop dossier/kenmerk/factuur references and everything after
  s = s.replace(/\s+(dossier|kenmerk|factuur|referentie|ref\.?|klantnr)[:\s#]*\S+[\s\S]*$/i, "");
  // Drop long hex/numeric transaction references
  s = s.replace(/\s+[0-9a-f]{16,}\b/gi, " ");
  s = s.replace(/\s+\d{10,}\b/g, " ");
  // Drop trailing country/city noise common in card payee strings
  s = s.replace(/\s+(NLD?|BEL|DEU|GBR|USA|FRA|ESP|ITA)$/i, "");
  s = s.replace(/\s{2,}/g, " ").replace(/[\s\-,]+$/, "").trim();

  return s || payee.trim();
}
