# dopo zero-backend — implementation spec (vetted 2 rounds)

Static PWA. Tokens never leave the browser. No server, no database, no operator-held data.
Same code serves two origins: GitHub Pages (public, possibly under /dopo-classifier/) and
dopo.artems.net (assets-only Worker; works equally behind an auth proxy). ES modules, no build step.

## Module layout (public/)

- `lib/lm.js` — Lunch Money v2 client (browser fetch, token argument).
  - `getState(token)`: categories + accounts + uncategorized txns; pages until `has_more` false,
    HARD CEILING 5 pages; returns `{truncated, total}` info so the UI can show "oldest N of M".
  - `applyCategories(token, updates, {recheck})`:
    - recheck mode "membership": fetch current uncategorized window once, membership test;
      **on miss, fall back to per-id `GET /v2/transactions/{id}`** — 404 ⇒ skipped, still-uncategorized
      ⇒ send, categorized ⇒ skipped. Absence alone NEVER discards a decision.
    - recheck mode "none" (hidden-flush only — see app.js rules below).
    - PUT body preserves the exact shape `{id, category_id, status: "reviewed"}` (fixture-tested).
  - Structured `LMError` with `.status`; 401 → distinct token-invalid signal.
- `lib/classify.js` — OpenRouter client.
  - Pass 1: batches of 8, concurrency 3, `reasoning: {effort:"low"}`, model `z-ai/glm-5.3-flash`.
  - Pass 2: `webCheckMerchant(key, merchant, categories)` — model `z-ai/glm-5.3-flash:online`, ONE call
    per unique `cleanMerchant()` value, returns category+confidence+reasoning+`web:true`.
  - Headers: `"HTTP-Referer": location.origin` (the custom OpenRouter attribution header — NOT the
    forbidden `Referer`), `"X-Title": "dopo"`.
- `lib/rules.js`, `lib/clean.js` — ports of rule matching + payee cleaning (pure, fixture-tested).
- `lib/store.js` — storage: tokens + apply queue + Later pile pointers in localStorage;
  suggestion cache + Later bodies in IndexedDB (~2000-entry LRU, per-entry writes).
- `data.js` — orchestration: state assembly, rules-first classification, two-pass scheduling, cache.
- `app.js` (NEW NAME, was swipe.js) + `app.css` (was swipe.css) + `boot.js` (SW registration; NO inline
  scripts anywhere). New filenames are deliberate: old installed SWs precache /swipe.js//api.js
  cache-first; new names bypass the stale cache so the new app boots on the first post-cutover visit.
- `sw.js` (path unchanged — required for update detection): precache derived from
  `self.registration.scope`; `VERSION = "__DOPO_VERSION__"` placeholder stamped at deploy;
  exception-only offline fallback (unchanged semantics); `/api` interception rules removed
  (there is no API); connect-src does not include foreign origins for the SW itself.

## Two-pass classification

- Pass 1 for all unsuggested txns (rules engine first, as today).
- Pass 2 fires LAZILY: when an unsure card (confidence <0.7 or null) is within the CURRENT SET
  (not "top of backlog" — confidence sorting clusters unsure at the back), web-check its unique
  merchant. Auto-cap 15 unique merchants per session; beyond that an explicit button
  "Web-check N more merchants (~$0.NN)". Results cached per merchant (IndexedDB) — cost is at most
  once per merchant while the cache persists (iOS may evict after 7 days of non-use; hedge wording).
- LM-ONLY MODE: with no OpenRouter key the app fully works (rules + manual picking); classify surfaces
  "add an OpenRouter key in Settings to enable AI suggestions". Settings validates each token live
  (LM /v2/me, OR /api/v1/key), independently; either may be absent.

## Apply queue semantics (client is now the only trust boundary)

- Decide → localStorage queue synchronously (format `dopo.queue.v1` UNCHANGED — old queued items must
  replay through the new client). Undo/flushable semantics unchanged.
- Items carry `snapshotTs` = timestamp of the last successful state fetch they were decided against.
- Normal flush: recheck mode "membership" (with per-id fallback) before PUT.
- Hidden/pagehide flush: NO network recheck — but eligibility is restricted to items whose `snapshotTs`
  equals the CURRENT session's last successful fetch; validate against the in-memory snapshot
  synchronously, ONE keepalive PUT (≤20 items, <64KB). Items from older sessions stay queued for the
  recheck-based replay on next open. This is what makes "keepalive without recheck" safe: LM's PUT
  overwrites, so an unvalidated stale item could clobber a category set elsewhere since.

## Settings / onboarding

- Settings: two password fields (LM required, OR optional), live validation per field, budget name
  display, **"Forget tokens on this device"** button (clears tokens only), web-check session counter.
- Onboarding card for missing LM token: link to the LM developers page and OR keys page with
  one-line instructions; recommends a dedicated OR key with a spend limit.

## CSP & XSS

- Meta CSP as the FIRST element in <head> of every HTML file (before any link/script):
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self';
  connect-src 'self' https://api.lunchmoney.dev https://openrouter.ai; base-uri 'self';
  form-action 'none'; object-src 'none'` (frame-ancestors impossible via meta — never claimed).
- ZERO inline <script>, <style>, or style= attributes in any HTML (externalize table.html/offline.html
  styles; boot.js replaces the inline SW registration).
- Card markup built through a PURE exported template function (`cardHTML(txn, ...)`) so bun tests can
  assert `<img onerror>` payloads in payee/notes/lookup come out escaped — a property test, not a grep.
- esc() grep tripwire in CI stays as defense-in-depth.

## Paths / multi-origin

- Every reference document-relative (`./app.css`, `register("sw.js")`, manifest `start_url "./"`,
  `scope "./"`, icons `./icon-*.png`). sw.js derives all cached URLs from registration scope.

## Deletions

- `src/`, `migrations/`, `SPEC-MULTITENANT.md`, `worker-configuration.d.ts`, `tests/access.test.ts`
  removed from the working tree (history retention accepted & documented).
- `table.html`/`table.js`: PORTED to lib/lm.js + lib/store.js (rules management + bulk view stay useful),
  styles externalized to `table.css`.
- package.json: NO `dependencies` (hono gone); devDependencies only (wrangler for the Cloudflare deploy,
  typescript for checkJs, @types/bun). bun.lock regenerated accordingly.
- wrangler.jsonc: assets-only (no D1, no crons, no vars, no main).

## Deploy & versioning

- `scripts/stamp-sw.ts` (bun): copies public/ to dist/, replaces `__DOPO_VERSION__` with a content hash
  of the public files, FAILS if the placeholder is missing/left. BOTH deploys use it:
  Pages workflow uploads dist/; Cloudflare deploy = `bun scripts/stamp-sw.ts && wrangler deploy` (wrangler
  assets dir pointed at dist/). CI checks the sw.js precache list matches the actual files in public/.
- Self-host section documents the stamp script; serving public/ raw works but SW cache-busting
  requires the stamp (README states this).

## CI (rewritten)

- bun test (lib fixtures: lm shapes incl. status:"reviewed" PUT body, rules, clean, cardHTML XSS).
- tsc --noEmit --allowJs --checkJs over JSDoc-annotated public modules.
- Greps: no inline script/style/style= in HTML; CSP meta is first in head; esc() tripwire;
  fetch-context URLs outside {self, api.lunchmoney.dev, openrouter.ai} forbidden (navigation hrefs
  allowlisted: my.lunchmoney.app, openrouter.ai, lunchmoney.app docs).
- Assert package.json has no `dependencies`. gitleaks. Pages artifact build from dist/.
- Actions pinned by commit SHA; permissions minimal (contents: read; pages: write + id-token: write
  on the deploy job only).

## Publishing (owner-approved: public repo + public URL)

- Create the public repo EMPTY; push exactly ONE ref (master); `git ls-remote` verification that no
  refs/t3/checkpoints/* or other refs leaked. NEVER --mirror/--all.
- Accepted documented history residue (non-secrets): a few dead infrastructure identifiers,
  committer email.
- README: honest privacy statement ("tokens go browser→LM/OpenRouter directly, never to the host; the
  host sees ordinary web metadata; you are trusting the served JS — open source, zero deps, zero
  third-party requests (CI-enforced); self-host or pin a commit to remove that trust"), SECURITY
  section (extension caveat: CSP does not bind extensions; revocation runbook; OR spend-limit key;
  LM token unscoped — treat like a bank password), cost table (~6¢/500 txns pass 1 + $0.0075 per unique
  web-checked merchant while cached), losses vs server variant (no background classification,
  per-device rules/progress), iOS: Add to Home Screen recommended for storage persistence.
- MIT LICENSE.
