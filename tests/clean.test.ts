import { describe, expect, test } from "bun:test";
import { cleanMerchant } from "../public/lib/clean.js";

/**
 * Real messy payee shapes from the family's ABN AMRO feed (as documented in
 * src/enrich.ts and surfaced raw in the card's details panel).
 */
describe("cleanMerchant", () => {
  test("Mollie PSP intermediary with dossier + IBAN tail", () => {
    expect(
      cleanMerchant(
        "To Van Dijk Incasso B.V. via Stichting Mollie Payments - 79bd8a3f2c Dossier 1234567 - IBAN: NL51INGB0001234567",
      ),
    ).toBe("Van Dijk Incasso B.V.");
  });

  test("card PSP prefix + trailing country code", () => {
    expect(cleanMerchant("BCK*ALBERT HEIJN 1573 AMSTERDAM NLD")).toBe("ALBERT HEIJN 1573 AMSTERDAM");
  });

  test("Zettle underscore-star prefix", () => {
    expect(cleanMerchant("Zettle_*De Koffiezaak AMSTERDAM")).toBe("De Koffiezaak AMSTERDAM");
  });

  test("SumUp prefix with space, short NL country tail", () => {
    expect(cleanMerchant("SumUp *Bakkerij Jansen AMSTERDAM NL")).toBe("Bakkerij Jansen AMSTERDAM");
  });

  test("CCV terminal prefix", () => {
    expect(cleanMerchant("CCV*STATION AMSTERDAM")).toBe("STATION AMSTERDAM");
  });

  test("IBAN tail then kenmerk reference", () => {
    expect(cleanMerchant("Gemeente Amsterdam Kenmerk: 12345678 IBAN: NL02ABNA0123456789")).toBe(
      "Gemeente Amsterdam",
    );
  });

  test("long numeric transaction reference", () => {
    expect(cleanMerchant("NS GROEP INZAKE NSR 1234567890123456")).toBe("NS GROEP INZAKE NSR");
  });

  test("dutch direction prefixes", () => {
    expect(cleanMerchant("van Albert Heijn")).toBe("Albert Heijn");
    expect(cleanMerchant("Naar Spaarrekening")).toBe("Spaarrekening");
  });

  test("falls back to the trimmed original when cleaning empties the string", () => {
    expect(cleanMerchant("IBAN: NL51INGB0001234567")).toBe("IBAN: NL51INGB0001234567");
  });

  test("collapses whitespace and trailing separators", () => {
    expect(cleanMerchant("  Cafe  De  Zon -, ")).toBe("Cafe De Zon");
  });
});
