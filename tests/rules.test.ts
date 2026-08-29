import { describe, expect, test } from "bun:test";
import { isRule, matchRule, ruleSuggestion } from "../public/lib/rules.js";
import type { Rule } from "../public/lib/rules.js";

const rule = (id: number, pattern: string, match_type: "contains" | "exact", category_id = 101): Rule =>
  ({ id, pattern, match_type, category_id });

describe("matchRule", () => {
  test("longest pattern wins (old ORDER BY length(pattern) DESC)", () => {
    const rules = [
      rule(1, "albert heijn", "contains", 101),
      rule(2, "albert heijn to go", "contains", 102),
    ];
    expect(matchRule(rules, "ALBERT HEIJN TO GO 1573 AMSTERDAM")?.id).toBe(2);
    expect(matchRule(rules, "ALBERT HEIJN 1573 AMSTERDAM")?.id).toBe(1);
    // input order must not matter
    expect(matchRule([...rules].reverse(), "ALBERT HEIJN TO GO 1573 AMSTERDAM")?.id).toBe(2);
  });

  test("exact requires the whole merchant, contains substring-matches", () => {
    const rules = [rule(1, "NS Groep", "exact", 200)];
    expect(matchRule(rules, "ns groep")?.id).toBe(1); // case-insensitive
    expect(matchRule(rules, "NS Groep inzake NSR")).toBeNull();
    expect(matchRule([rule(2, "NS Groep", "contains", 200)], "NS Groep inzake NSR")?.id).toBe(2);
  });

  test("no match -> null; does not mutate input order", () => {
    const rules = [rule(1, "zzz-long-pattern", "contains"), rule(2, "aa", "contains")];
    const before = rules.map((r) => r.id);
    expect(matchRule(rules, "unrelated merchant")).toBeNull();
    expect(rules.map((r) => r.id)).toEqual(before);
  });
});

describe("ruleSuggestion", () => {
  test("keeps the Worker's persisted shape and wording", () => {
    expect(ruleSuggestion(rule(1, "albert heijn", "contains", 101))).toEqual({
      category_id: 101,
      confidence: 1,
      reasoning: 'rule: "albert heijn"',
      source: "rule",
    });
  });
});

describe("isRule (storage shape guard)", () => {
  test("accepts well-formed rules, rejects junk without throwing", () => {
    expect(isRule(rule(1, "x", "exact"))).toBe(true);
    expect(isRule(null)).toBe(false);
    expect(isRule({ id: "1", pattern: "x", match_type: "exact", category_id: 1 })).toBe(false);
    expect(isRule({ id: 1, pattern: "", match_type: "exact", category_id: 1 })).toBe(false);
    expect(isRule({ id: 1, pattern: "x", match_type: "regex", category_id: 1 })).toBe(false);
    expect(isRule({ id: 1, pattern: "x", match_type: "contains" })).toBe(false);
  });
});
