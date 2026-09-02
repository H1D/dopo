// @ts-check
/**
 * Shared free OpenRouter key — the "at least something" tier.
 *
 * When the user has not pasted their own OpenRouter key, dopo classifies with
 * this key and one of FREE_MODELS instead of doing nothing. Anyone can read this file,
 * so the key MUST be created under an OpenRouter guardrail that
 *   - allowlists ONLY `:free` models (every entry of FREE_MODELS), and
 *   - caps the budget at $0.
 * Then a scraped key can burn quota but never money.
 *
 * What the free tier gives up (all handled in app.js / classify.js):
 *   - a smaller free model instead of the paid MODEL;
 *   - OpenRouter's free-model quota is per ACCOUNT, shared by every dopo user
 *     on this key (20 req/min; 50 or 1000 req/day) — a 429 shows the upgrade
 *     banner and backs off;
 *   - no pass-2 web checks (the `:online` variant costs real money).
 *
 * The key itself never enters git: scripts/stamp-sw.ts replaces the
 * __DOPO_FREE_KEY__ placeholder below with the DOPO_FREE_KEY environment
 * variable at deploy time (the CI deploy job reads it from a repository
 * secret; GitHub push protection would refuse the literal anyway). Serving
 * public/ raw, or stamping without the variable, yields an empty key = no
 * shared tier (LM-only mode until the user pastes a key). Self-hosters set
 * DOPO_FREE_KEY to their own guardrailed key before stamping.
 */

const STAMPED_KEY = "__DOPO_FREE_KEY__";

/** OpenRouter key restricted to free models with a $0 budget. Empty = no shared tier. */
export const FREE_KEY = STAMPED_KEY.startsWith("__") ? "" : STAMPED_KEY;

/**
 * Pass-1 models used with FREE_KEY, in order of preference. Every free model
 * on OpenRouter sits on ONE upstream provider with a shared pool, so any of
 * them can be "temporarily rate-limited upstream" for hours; app.js walks
 * this list on a 429/404 and only shows the upgrade banner once all of them
 * refused. Each must be a `:free` variant that supports `response_format`
 * (checked against /api/v1/models/<id>/endpoints), and EACH must be on the
 * key's guardrail allowlist — a model missing there answers 404 and is
 * simply skipped.
 */
export const FREE_MODELS = [
  // probed 2026-09-03 with the real pass-1 prompt: correct, ~2s per batch
  "nvidia/nemotron-3-super-120b-a12b:free",
  // correct, ~8s per batch (reasons at length)
  "minimax/minimax-m2.7:free",
  // closest cousin of the paid model; its single provider 429'd for hours that day
  "z-ai/glm-5.2:free",
  "google/gemma-4-31b-it:free",
];

/** In-flight requests on the free key. The 20 req/min cap is shared account-wide. */
export const FREE_CONCURRENCY = 1;
