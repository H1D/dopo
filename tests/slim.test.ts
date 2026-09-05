import { describe, expect, test } from "bun:test";
import { slimTxn } from "../public/lib/lm.js";

const row = {
  id: 1, date: "2026-05-08", amount: "12.50", currency: "eur", payee: "SHOP", category_id: null, notes: null,
  status: "uncategorized", is_pending: false, plaid_account_id: 7, manual_account_id: null, tag_ids: [3],
};

describe("slimTxn", () => {
  test("lifts Plaid's datetime as `time` and drops the metadata blob", () => {
    const s = slimTxn({ ...row, plaid_metadata: { datetime: "2026-05-07T13:10:52Z", authorized_datetime: "2026-05-06T09:00:00Z", merchant_name: "x" } });
    expect(s.time).toBe("2026-05-07T13:10:52Z");
    expect("plaid_metadata" in s).toBe(false);
    expect(s.tag_ids).toEqual([3]);
  });
  test("authorized_datetime when datetime is missing; the ABN payee stamp when Plaid has neither", () => {
    expect(slimTxn({ ...row, plaid_metadata: { datetime: null, authorized_datetime: "2026-05-06T09:00:00Z" } }).time).toBe("2026-05-06T09:00:00Z");
    expect(slimTxn({ ...row, payee: "BEA, Apple Pay AH 8684,PAS362 NR:TL12Q3, 04.06.26/18:20 AMSTERDAM", plaid_metadata: null }).time).toBe("2026-06-04T18:20:00");
    expect(slimTxn({ ...row, plaid_metadata: {} }).time).toBeNull();
    expect(slimTxn(row).time).toBeNull();
  });
});
