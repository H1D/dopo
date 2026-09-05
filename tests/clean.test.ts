import { describe, expect, test } from "bun:test";
import { cleanMerchant, timeFromPayee } from "../public/lib/clean.js";

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

describe("cleanMerchant — real payee shapes seen 2026-09 (ABN card terminals, PSPs, marketplaces)", () => {
  test("ABN 'BEA, Apple Pay' terminal string: merchant between the wallet and the card number", () => {
    expect(cleanMerchant("BEA, Apple Pay K-supermarket Kaisanie,PAS362 NR:39I30740, 19.05.26/16:41 Helsinki, Land: FIN"))
      .toBe("K-supermarket Kaisanie");
    expect(cleanMerchant("BEA, Apple Pay CCV*HOCKEY VERENIGING,PAS362 NR:CT123456, 02.06.26/19:05 AMSTELVEEN")).toBe("HOCKEY VERENIGING");
    expect(cleanMerchant("GEA, Betaalpas Geldmaat Maalderij 31,PAS362 NR:123456, 03.06.26/10:12 Amstelveen")).toBe("Geldmaat Maalderij 31");
  });

  test("ABN terminal string whose merchant slot is only a reference falls back to the city slot", () => {
    expect(cleanMerchant("BEA, Betaalpas NLOVDRJZ9X96APW5EY,PAS366 NR:PT30AA5F, 18.05.26/07:48 www.ovpay.nl")).toBe("www.ovpay.nl");
  });

  test("Pay.nl intermediary phrasing with repeated segments and a trailing RF reference", () => {
    expect(cleanMerchant("Payment from Stichting Pay.nl - Pay.nl inzake The Movies / The Movies / The Movies / RF-4597-2018-9350"))
      .toBe("The Movies");
  });

  test("marketplace order codes and extra country codes", () => {
    expect(cleanMerchant("WWW.AMAZON.* 9Z9RK99A9 LUXEMBOURG LUX")).toBe("WWW.AMAZON.* LUXEMBOURG");
    expect(cleanMerchant("AMZN MKTP NL*NA99L9HQ9 LUXEMBOURG LUX")).toBe("AMZN MKTP NL LUXEMBOURG");
    expect(cleanMerchant("NINTENDO CA1234567890 FRANKFURT AM DEU")).toBe("NINTENDO FRANKFURT AM");
  });

  test("membership rows: numeric ids and date ranges between dashes collapse", () => {
    expect(cleanMerchant("Special Sports Amstelveen B.V. - 1234-56789 01/06/26 - 30/06/26 Flex Membership"))
      .toBe("Special Sports Amstelveen B.V. - Flex Membership");
  });

  test("UUID transfer references drop; 4-digit store numbers stay", () => {
    expect(cleanMerchant("To EUR MB:b99d999f-999d-999e-be9d-99999999999a")).toBe("EUR MB");
    expect(cleanMerchant("BEA, Apple Pay AH 8684,PAS362 NR:TL12Q3, 04.06.26/18:20 AMSTERDAM")).toBe("AH 8684");
  });
});

describe("timeFromPayee", () => {
  test("lifts the dd.mm.yy/hh:mm stamp as a LOCAL wall-clock ISO string", () => {
    expect(timeFromPayee("BEA, Apple Pay K-supermarket Kaisanie,PAS362 NR:39I30740, 19.05.26/16:41 Helsinki, Land: FIN"))
      .toBe("2026-05-19T16:41:00");
  });
  test("null when absent or out of range", () => {
    expect(timeFromPayee("ALBERT HEIJN 1573 AMSTERDAM NLD")).toBeNull();
    expect(timeFromPayee("x 19.13.26/16:41")).toBeNull();
    expect(timeFromPayee("x 19.05.26/25:41")).toBeNull();
    expect(timeFromPayee(null)).toBeNull();
  });
});
