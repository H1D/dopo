import { afterEach, describe, expect, test } from "bun:test";
import { MockFetch, json } from "./helpers/mock-fetch";
import {
  BATCH_SIZE,
  CONCURRENCY,
  MODEL,
  ORError,
  WEB_MODEL,
  checkKey,
  classifyBatch,
  classifyTransactions,
  extractJson,
  webCheckMerchant,
} from "../public/lib/classify.js";

const CATS = [
  { id: 101, name: "🛒 Groceries", group: "🍎 Food" },
  { id: 102, name: "☕ Coffee & Snacks", group: "🍎 Food" },
  { id: 200, name: "🚆 Transport", group: null },
];

let mock: MockFetch;
afterEach(() => mock?.restore());

const txn = (id: number) => ({
  id,
  merchant: `Merchant ${id}`,
  raw_payee: `RAW*Merchant ${id}`,
  amount: "10.00",
  currency: "eur",
  date: "2026-01-01",
  notes: null,
  lookup: null,
});

/** Answer a pass-1 request with one suggestion per txn id found in the prompt. */
function pass1Response(body: { messages: { content: string }[] }, categoryId: number | null = 101) {
  const prompt = body.messages[0]!.content;
  const ids = [...prompt.matchAll(/"id": (\d+)/g)].map((m) => Number(m[1]));
  return json({
    choices: [{ message: { content: JSON.stringify({
      suggestions: ids.map((id) => ({ id, category_id: categoryId, confidence: 0.9, reasoning: `s${id}` })),
    }) } }],
  });
}

describe("classifyBatch — pass-1 request shaping", () => {
  test("batches of 8, model, low reasoning, attribution headers", async () => {
    mock = new MockFetch()
      .route((url, init) => (url.includes("/chat/completions") ? pass1Response(JSON.parse(init!.body as string)) : null))
      .install();

    const txns = Array.from({ length: 20 }, (_, i) => txn(i + 1));
    const out = await classifyBatch("or-key", CATS, txns);

    const calls = mock.callsTo("/chat/completions");
    expect(calls.length).toBe(3); // ceil(20/8)
    const sizes = calls.map((c) => [...(c.body as { messages: { content: string }[] }).messages[0]!.content.matchAll(/"id": (\d+)/g)].length);
    expect(sizes).toEqual([8, 8, 4]);

    for (const c of calls) {
      const body = c.body as Record<string, unknown>;
      expect(body.model).toBe(MODEL);
      expect(body.model).toBe("z-ai/glm-5.3-flash");
      expect(body.reasoning).toEqual({ effort: "low" });
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(c.headers.Authorization).toBe("Bearer or-key");
      // OpenRouter's custom attribution header (guarded for non-browser envs), never bare Referer
      expect(typeof c.headers["HTTP-Referer"]).toBe("string");
      expect(c.headers["HTTP-Referer"]!.length).toBeGreaterThan(0);
      expect(c.headers["X-Title"]).toBe("dopo");
      expect("Referer" in c.headers).toBe(false);
    }

    expect(out.length).toBe(20);
    expect(out[0]).toEqual({ id: 1, category_id: 101, confidence: 0.9, reasoning: "s1" });
  });

  test("at most 3 requests in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mock = new MockFetch()
      .route(async (url, init) => {
        if (!url.includes("/chat/completions")) return null;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return pass1Response(JSON.parse(init!.body as string));
      })
      .install();

    const txns = Array.from({ length: 4 * BATCH_SIZE }, (_, i) => txn(i + 1)); // 4 chunks
    await classifyBatch("or-key", CATS, txns);
    expect(maxInFlight).toBe(CONCURRENCY);
    expect(CONCURRENCY).toBe(3);
  });

  test("hallucinated category ids are nulled, confidence clamped, gaps filled", async () => {
    mock = new MockFetch()
      .route((url, init) => {
        if (!url.includes("/chat/completions")) return null;
        return json({
          choices: [{ message: { content: JSON.stringify({ suggestions: [
            { id: 1, category_id: 999999, confidence: 7, reasoning: "made-up category" },
            // id 2 intentionally missing
          ] }) } }],
        });
      })
      .install();
    const out = await classifyBatch("k", CATS, [txn(1), txn(2)]);
    expect(out[0]).toEqual({ id: 1, category_id: null, confidence: 1, reasoning: "made-up category" });
    expect(out[1]).toEqual({ id: 2, category_id: null, confidence: 0, reasoning: "model returned no suggestion" });
  });

  test("non-2xx throws ORError with status", async () => {
    mock = new MockFetch().route(() => json({ error: "rate limited" }, 429)).install();
    const err = await classifyBatch("k", CATS, [txn(1)]).catch((e) => e);
    expect(err).toBeInstanceOf(ORError);
    expect(err.status).toBe(429);
  });
});

describe("classifyTransactions — app-facing wrapper", () => {
  test("maps to suggested_category_id and streams onBatch groups", async () => {
    mock = new MockFetch()
      .route((url, init) => (url.includes("/chat/completions") ? pass1Response(JSON.parse(init!.body as string)) : null))
      .install();

    const uiTxns = Array.from({ length: 4 * BATCH_SIZE }, (_, i) => ({
      id: i + 1,
      merchant: `Merchant ${i + 1}`,
      payee: `RAW*Merchant ${i + 1}`,
      amount: "10.00",
      currency: "eur",
      date: "2026-01-01",
      notes: null,
    }));
    const batches: unknown[][] = [];
    const out = await classifyTransactions("or-key", uiTxns, CATS, { onBatch: (r) => batches.push(r) });

    expect(out.length).toBe(4 * BATCH_SIZE);
    expect(out[0]).toEqual({ id: 1, suggested_category_id: 101, confidence: 0.9, reasoning: "s1" });
    // 4 chunks / concurrency 3 -> two onBatch groups (3 chunks, then 1), streamed in order
    expect(batches.length).toBe(2);
    expect(batches[0]!.length).toBe(3 * BATCH_SIZE);
    expect(batches[1]!.length).toBe(BATCH_SIZE);
    expect((batches[0]![0] as Record<string, unknown>).suggested_category_id).toBe(101);
  });
});

describe("webCheckMerchant — pass-2", () => {
  test("one call, :online model variant, web:true result", async () => {
    mock = new MockFetch()
      .route((url) => (url.includes("/chat/completions")
        ? json({ choices: [{ message: { content: '{"category_id": 102, "confidence": 0.85, "reasoning": "specialty coffee bar in Amsterdam"}' } }] })
        : null))
      .install();

    const res = await webCheckMerchant("or-key", "de koffiezaak amsterdam", "De Koffiezaak AMSTERDAM", CATS);

    const calls = mock.callsTo("/chat/completions");
    expect(calls.length).toBe(1); // ONE call per unique merchant
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.model).toBe(WEB_MODEL);
    expect(body.model).toBe("z-ai/glm-5.3-flash:online");
    expect(calls[0]!.headers["X-Title"]).toBe("dopo");
    expect((calls[0]!.body as { messages: { content: string }[] }).messages[0]!.content).toContain("De Koffiezaak AMSTERDAM");

    expect(res).toEqual({
      key: "de koffiezaak amsterdam",
      merchant: "De Koffiezaak AMSTERDAM",
      suggested_category_id: 102,
      confidence: 0.85,
      reasoning: "specialty coffee bar in Amsterdam",
      web: true,
    });
  });

  test("invalid category from the model becomes null, still web:true", async () => {
    mock = new MockFetch()
      .route(() => json({ choices: [{ message: { content: '{"category_id": 4242, "confidence": 0.4, "reasoning": "?"}' } }] }))
      .install();
    const res = await webCheckMerchant("k", "mystery bv", "Mystery BV", CATS);
    expect(res.suggested_category_id).toBeNull();
    expect(res.web).toBe(true);
  });
});

describe("checkKey", () => {
  test("GET /api/v1/key; failure -> ORError", async () => {
    mock = new MockFetch().route((url) => (url.includes("/api/v1/key") ? json({}, 401) : null)).install();
    const err = await checkKey("dead").catch((e) => e);
    expect(err).toBeInstanceOf(ORError);
    expect(err.status).toBe(401);
    expect(err.tokenInvalid).toBe(true);
  });
});

describe("extractJson", () => {
  test("markdown fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}\n');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}\n');
  });
  test("leading prose", () => {
    expect(extractJson('Sure! Here you go: {"a":1}')).toBe('{"a":1}');
  });
  test("plain passthrough when no brace", () => {
    expect(extractJson("no json here")).toBe("no json here");
  });
});
