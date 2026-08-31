import { describe, expect, test } from "bun:test";
import { fmtTxnDate, parseTxnDate } from "../public/lib/card.js";

/** What the runner's own locale renders for a set of Intl options — the assertions
 *  below check that fmtTxnDate PICKED these options, not that any one locale wins. */
const rendered = (d: Date, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, opts).format(d);

describe("parseTxnDate", () => {
  test("YYYY-MM-DD is a LOCAL calendar day, not UTC midnight", () => {
    // new Date("2026-08-31") is UTC midnight, which is 30 August for anyone
    // west of Greenwich. The whole point of the manual parse.
    const p = parseTxnDate("2026-08-31");
    expect(p?.at.getFullYear()).toBe(2026);
    expect(p?.at.getMonth()).toBe(7);
    expect(p?.at.getDate()).toBe(31);
    expect(p?.at.getHours()).toBe(0);
    expect(p?.hasTime).toBe(false);
  });

  test("a full timestamp is parsed as an instant and flagged hasTime", () => {
    const p = parseTxnDate("2026-08-31T14:32:00Z");
    expect(p?.hasTime).toBe(true);
    expect(p?.at.getTime()).toBe(Date.UTC(2026, 7, 31, 14, 32));
  });

  test("empty and unparseable input yield null", () => {
    expect(parseTxnDate("")).toBeNull();
    expect(parseTxnDate("   ")).toBeNull();
    expect(parseTxnDate(null)).toBeNull();
    expect(parseTxnDate(undefined)).toBeNull();
    expect(parseTxnDate("not a date")).toBeNull();
    expect(parseTxnDate("2026-13-45")).toBeNull();
  });
});

describe("fmtTxnDate", () => {
  const now = new Date(2026, 7, 31);

  test("same year: day + long month, no year, no time", () => {
    expect(fmtTxnDate("2026-08-31", now)).toBe(
      rendered(new Date(2026, 7, 31), { day: "numeric", month: "long" }),
    );
  });

  test("another year: the year is added back", () => {
    expect(fmtTxnDate("2025-12-24", now)).toBe(
      rendered(new Date(2025, 11, 24), { day: "numeric", month: "long", year: "numeric" }),
    );
  });

  test("a timestamped date renders the time too", () => {
    const at = new Date(Date.UTC(2026, 7, 31, 14, 32));
    expect(fmtTxnDate("2026-08-31T14:32:00Z", now)).toBe(
      rendered(at, { day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }),
    );
  });

  test("date-only input never invents a time", () => {
    expect(fmtTxnDate("2026-08-31", now)).not.toContain(":");
  });

  test("unparseable input falls through to the raw string, never 'Invalid Date'", () => {
    expect(fmtTxnDate("whenever", now)).toBe("whenever");
    expect(fmtTxnDate("", now)).toBe("");
    expect(fmtTxnDate(null, now)).toBe("");
    expect(fmtTxnDate(undefined, now)).toBe("");
  });
});
