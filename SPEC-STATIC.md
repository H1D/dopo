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
  suggestion cache + Later bodies + state snapshot in IndexedDB (~2000-entry LRU, per-entry writes).
- `lib/sync.js` — shared queue replay (boot replay + table apply): one membership recheck,
  chunked PUTs, poison-item isolation, make_rule absorption. Throws typed errors, never touches UI.
- `data.js` — orchestration: state assembly, rules-first classification, two-pass scheduling, cache.
- `app.js` (NEW NAME, was swipe.js) + `app.css` (was swipe.css) + `boot.js` (SW registration; NO inline
  scripts anywhere). New filenames are deliberate: old installed SWs precache /swipe.js//api.js
  cache-first; new names bypass the stale cache so the new app boots on the first post-cutover visit.
- `sw.js` (path unchanged — required for update detection): precache derived from
  `self.registration.scope`; `VERSION = "__DOPO_VERSION__"` placeholder stamped at deploy;
  exception-only offline fallback: on navigation fetch REJECTION (never on status/type)
  serve the cached shell mapped by pathname (scope root/index[.html] → index.html,
  table[.html] → table.html — hosts canonicalize .html URLs, accept both spellings —
  else offline.html, else Response.error()); install fetches FOLLOW redirects but
  accept only a same-origin 200 with a sane content-type (Cloudflare assets 307s
  .html paths; an Access chain ends off-origin and still fails install atomically); `/api` interception
  rules removed (there is no API); connect-src does not include foreign origins for the SW itself.

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
  equals the CURRENT session's last successful fetch AND that fetch is fresh (< 2× the refresh
  interval, i.e. 10 min — an online-boot-then-offline session must not keep arming no-recheck PUTs
  against an aging snapshot); validate against the in-memory snapshot synchronously, ONE keepalive
  PUT (≤20 items, <64KB). Items from older sessions stay queued for the recheck-based replay on next
  open. This is what makes "keepalive without recheck" safe: LM's PUT overwrites, so an unvalidated
  stale item could clobber a category set elsewhere since.

## Offline-first (vetted 2 rounds, 2 personas)

The app boots and works fully offline; every state change lands in durable local storage
synchronously/immediately and syncs upstream when connectivity allows. Lunch Money stays the
source of truth for transaction data; the device is the source of truth for pending decisions.

- **Queue write classes.** Decision-path writes (swipe decide, undo, finalize, pagehide
  sent-marking) are SYNCHRONOUS fresh-read-merge `queueLoad → modify → queueSave` — never behind
  an async lock (a blocked lock grant must not be able to lose a swipe; pagehide callbacks may
  never run). Slow multi-step read-modify-write paths (replay, table bulk push, flush persistence
  steps) go through `queueMutate(fn)` under `navigator.locks("dopo.queue")`; `fn` is synchronous;
  the lock is never held across network I/O; saves collapse duplicate ids (max ts wins). Item
  identity is `(id, ts)` — never object references.
- **Snapshot.** The last successful raw `LMState` is saved to IndexedDB after every fetch
  (skip-unchanged still bumps `fetchedAt`); on a network-class boot failure the deck renders from
  it in snapshot mode with a stale banner. In snapshot mode `lastFetchTs` stays null → decisions
  carry `snapshotTs: null` → they sync ONLY through the recheck-based replay, never keepalive.
  Applied/skipped ids are pruned from the snapshot after every successful flush so stale
  snapshots don't resurrect finished work. A 401 is never papered over with a snapshot.
- **Connectivity is derived from fetch outcomes**, not `online`/`offline` events: an
  `LMError`/OR error with a real HTTP status means the server is reachable; a fetch rejection or
  parse-garbage response (captive portal) counts toward offline (2 consecutive LM-origin failures
  or `navigator.onLine === false` shows the chip; any success clears it). The events and
  `navigator.onLine` only trigger probes. While offline the retry toast is suppressed and backoff
  pauses; the 5-minute refresh interval and the return-to-foreground path keep running as quiet
  recovery probes.
- **Poison isolation.** A chunk PUT failing with a 4xx other than 401/408/429 is bisected (PUT
  stage only — the membership recheck already ran); after 3 session attempts the item is parked
  `flushable:false, stuck:"<reason>"` and surfaced, so one bad item can't jam the queue. 408/429
  stay on the ordinary backoff path.
- **Replay honesty.** Recheck-skipped items that were never sent by this client
  (`sent:false`) are announced ("already categorized elsewhere"); `sent:true` skips are silent.
- **IDB v2 upgrade safety.** `onblocked` does not latch memory-only mode (per-op ~2s watchdog
  degrades single calls without poisoning the cached open); every open registers
  `onversionchange → close`; Later-pointer compaction is forbidden whenever bodies may have been
  written to the memory fallback — "IDB confirmed gone" ≠ "couldn't reach IDB".
- **Accepted trade-offs:** any replay (boot, or another tab's table apply) marks everything
  flushable, so decisions from a killed session sync without an undo window and a replay in a
  sibling tab can finalize this tab's live undo toast early; a transaction re-uncategorized remotely will accept a
  stale queued decision; the table view has no snapshot mode (shell + queued-count banner only);
  iOS standalone and Safari-tab containers are isolated — queue and chip counts don't span them;
  a sheet left open >10 min ages out keepalive eligibility (sync defers to replay); the snapshot
  comparator misses in-place edits on identical id-sets (next content change repairs); offline
  boot works from the second visit after a deploy (the new SW must activate first — do not "fix"
  with skipWaiting).

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
