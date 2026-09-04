/**
 * Shared hostile-input corpus for the XSS property tests.
 *
 * Every suite that renders attacker-controlled strings into markup — card.js
 * (tests/xss.test.ts) and the category picker builders (tests/picker.test.ts) —
 * injects THIS list, so a payload class only has to be added once to be
 * checked everywhere. Keep the entries short and mechanical: each one targets a
 * distinct escape hazard (raw tag, attribute break-out with `"` or `'`,
 * pre-escaped text that must not be double-decoded, backtick/handler bait).
 */
export const PAYLOADS = [
  "<img src=x onerror=alert(1)>",
  '"><img src=x onerror="fetch(`//evil`)">',
  "'><svg onload=alert(1)>",
  "<script>alert(1)</script>",
  "&lt;fake-pre-escaped&gt;<b onmouseover=x>",
  "` onfocus=alert(1) autofocus x=`",
  '" onerror=alert(1) x="',
  "</bdi><img src=x onerror=alert(1)>",
] as const;
