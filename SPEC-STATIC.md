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
  - Pass 1: batches of 8, concurrency 3, `reasoning: {effort:"low"}`, model `z-ai/glm-5.3-flash`
    (both overridable per call via `{model, concurrency}` — the free tier passes its own). A failed
    chunk never discards its siblings: the group runs `allSettled`, fulfilled chunks are reported
    through `onGroup`, then the first rejection is rethrown.
  - `ORError` getters: `tokenInvalid` (401), `rateLimited` (429), `quotaExhausted` (429|402),
    `dailyQuota` (429 whose body names a per-day bucket — best effort).
  - Pass 2: `webCheckMerchant(key, merchant, categories)` — model `z-ai/glm-5.3-flash:online`, ONE call
    per unique `cleanMerchant()` value, returns category+confidence+reasoning+`web:true`.
  - Headers: `"HTTP-Referer": location.origin` (the custom OpenRouter attribution header — NOT the
    forbidden `Referer`), `"X-Title": "dopo"`.
- `lib/rules.js`, `lib/clean.js` — ports of rule matching + payee cleaning (pure, fixture-tested).
- `lib/store.js` — storage: tokens + apply queue + Later pile pointers + device prefs (cutoff,
  audio, onboarding cursor, `dopo.picker.v1`, `dopo.hues.v1`) in localStorage;
  suggestion cache + Later bodies + state snapshot in IndexedDB (~2000-entry LRU, per-entry writes).
- `lib/sync.js` — shared queue replay (boot replay + back-online resync): one membership recheck,
  chunked PUTs, poison-item isolation, make_rule absorption. Throws typed errors, never touches UI.
- `data.js` — orchestration: state assembly, rules-first classification, two-pass scheduling, cache.
- `app.js` (NEW NAME, was swipe.js) + `app.css` (was swipe.css) + `boot.js` (SW registration; NO inline
  scripts anywhere). New filenames are deliberate: old installed SWs precache /swipe.js//api.js
  cache-first; new names bypass the stale cache so the new app boots on the first post-cutover visit.
- `sw.js` (path unchanged — required for update detection): precache derived from
  `self.registration.scope`; `VERSION = "__DOPO_VERSION__"` placeholder stamped at deploy;
  exception-only offline fallback: on navigation fetch REJECTION (never on status/type)
  serve the cached shell mapped by pathname (scope root/index[.html] → index.html —
  hosts canonicalize .html URLs, accept both spellings — else offline.html, else
  Response.error()); install fetches FOLLOW redirects but
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
- LM-ONLY MODE: with no OpenRouter key AND no shared free key the app fully works (rules + manual
  picking); classify surfaces "add an OpenRouter key in Settings to enable AI suggestions". Settings
  validates each token live (LM /v2/me, OR /api/v1/key), independently; either may be absent.

## Shared free tier (owner-approved, added post-v1)

- `lib/freekey.js` exports `FREE_KEY` (stamped at deploy from the `DOPO_FREE_KEY` env var by
  `scripts/stamp-sw.ts` — the `__DOPO_FREE_KEY__` placeholder reads as empty when served raw or
  stamped without the var = no shared tier; the reference instance holds it in a repository secret
  and the key value is folded into the SW version hash so a rotation re-busts the cache; GitHub push
  protection refuses the literal, which is the point), `FREE_MODELS` (ordered `:free` variants that support `response_format`; every free model
  has ONE upstream provider, so app.js walks the list on 429/404 — sticky once one answers, wraps
  back to the first after a cooldown) and `FREE_CONCURRENCY` (1). The key is public by
  construction, so it MUST live under an OpenRouter guardrail: allowlist exactly the `FREE_MODELS`
  entries, $0 budget (verified 2026-09-03: a paid model answers 404 "Model blocked by guardrail").
  Bounded to quota, never money. `tests/freekey.test.ts` pins the invariants (`:free` suffix, unique
  entries, concurrency 1, key shape); `tests/stamp-sw.test.ts` covers the stamp (empty env → empty
  key, key never in the source tree, key changes the version, malformed key fails).
- `app.js orCreds()`: the user's own key wins; else the free key; else LM-only. Pass 2 (web checks)
  reads `tokens.or` directly and NEVER runs on the free key (the `:online` variant costs money and
  would 402 against the $0 budget anyway).
- Quota (429/402) or 404 on the free key with every model in `FREE_MODELS` refusing: absorbed
  batches stay on the cards; `onFreeQuota` backs off
  (90 s doubling, capped at 15 min; a per-day bucket jumps straight to the cap — it only clears at
  midnight UTC), re-arms `ensureClassified` for when the cooldown ends, and shows the tappable
  **upgrade banner** (`#upgradeBanner`, opens Settings) with per-day vs rate-limited copy. The banner
  stays for the session until the user saves their own key. Any complete free pass resets the
  backoff step. OpenRouter free limits are per ACCOUNT (20/min; 50/day, 1000/day once the account
  has ever bought $10), shared by every dopo user on the key — hence concurrency 1 and the banner.
- 401 on the free key (revoked/rotated) flips `freeTierDead`: silent LM-only mode, no Settings nag
  (the nag is for the user's own dead key). 402 on the user's OWN key is noted once per session
  ("out of credit") instead of the generic retry note.
- Surfaces: the OR field hint reads "Using the shared free key — …" when no own key is set; the
  field sub-text and the onboarding wizard's `free` card disclose the trade (smaller model, shared
  daily quota, no web checks, free models may train on prompts); the web bar's free-tier hint mentions web checks
  only when an unsure card would get one, and never on top of the upgrade banner; the Settings
  web-check line says pass 2 needs your own key.

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
  never run). Slow multi-step read-modify-write paths (replay, flush persistence
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
- **Accepted trade-offs:** any replay (boot, or another tab's) marks everything
  flushable, so decisions from a killed session sync without an undo window and a replay in a
  sibling tab can finalize this tab's live undo toast early; a transaction re-uncategorized remotely will accept a
  stale queued decision; iOS standalone and Safari-tab containers are isolated — queue and chip counts don't span them;
  a sheet left open >10 min ages out keepalive eligibility (sync defers to replay); the snapshot
  comparator misses in-place edits on identical id-sets (next content change repairs); offline
  boot works from the second visit after a deploy (the new SW must activate first — do not "fix"
  with skipWaiting).

## Settings / onboarding

- Settings is a short menu of native `<details>` groups (`.settings-group`): **Lunch Money account**
  (LM token, budget name, "Forget tokens on this device" — clears tokens only), **AI suggestions**
  (OR key — the shared free tier fills in —, web-check session counter, the per-bucket "Ask AI
  automatically about" checkboxes), **What to sort** (cutoff chips, the per-bucket "Include"
  checkboxes, "Skip tagged" chips), **Category picker**, **Local rules**, **Badge & sound**. Both
  token fields are live-validated. Open/closed state is the user's within a session; app.js only
  forces a group open when it has something to show there (`openSettingsSheet(dead, {group})`: a
  dead LM token → account, a dead OR key / the AI hint bar / the upgrade banner → AI suggestions,
  the picker preview handing back → picker; no LM token at all → account).
- **Deck cutoff** (`dopo.cutoff.v1`, presets `1w`/`1m`/`3m`/`ytd`, default `ytd` = the pre-cutoff
  behaviour): `store.fetchWindow()` is the single source of the LM date window **and scope**, used by
  the deck fetch AND by every membership recheck so the two never page different ranges under
  different membership tests. Unknown ids fall back to the default rather than fetching an empty or
  unbounded range. Changing it is applied on sheet close (like the accounts filter) as a full refetch
  + redeal (`applyDeckChange`), not a `reconcile()` — the top card may no longer be in range.
- **Deck scope** (`dopo.scope.v1`; `store.scopeLoad/scopeSave`, per-field validated so a partial or
  older record degrades field by field): every transaction is in exactly one **bucket**
  (`lm.bucketOf`: `reviewed` when LM marked it reviewed, else `uncategorized` without a category,
  else `unreviewed` = categorized by LM's own rules / the bank feed but not reviewed).
  - `include` (default uncategorized ✓, unreviewed ✓, reviewed ✗ = what dopo always fetched) says
    which buckets the deck holds; `skipTags` (`{id, name}[]`, names kept so Settings renders
    offline) keeps any row carrying one of them out regardless. `lm.inScope(t, scope)` is the ONE
    membership test — the paged fetch, `applyCategories`' per-id fallback and `sync.js`'s replay
    recheck all use it, with pending rows always out. `isOpen` survives as `inScope` under the
    default scope. Reviewed rows in scope are sent through the same PUT (`status: "reviewed"`,
    re-filing them); the "someone got there first" skip is by construction unavailable for them.
  - `ai` (same defaults) says which buckets pass 1 runs on **unasked** (`data.wantsAi`). Every
    other card that the model could still add to (`data.askable`: bare, or holding only the
    LM category, and no verdict yet — `aiChecked`) shows an **"Ask AI"** button instead
    (`card.js` `askAi: "idle"|"busy"|null`), which runs pass 1 for that one row through the same
    `absorbPass1Slice`; no button on snapshot decks or without any OR credentials (a tap without
    a key opens the AI group of Settings).
  - **Second opinions** (`data.mergeAi`, pure): a fresh or cached model verdict on a row whose LM
    category is a trusted leaf only takes the card when it is CONFIDENT (`CONFIDENT_AT`) and
    DISAGREES — then the badge reads "AI disagrees" and a "Lunch Money has: …" footnote names the
    held category. Agreement or an unsure verdict keeps the `lm` suggestion (confidence 1, the
    one-swipe confirm) with the verdict named in the reasoning. Rules stay on top; a web verdict is
    never replaced by pass 1. `aiChecked` is set whenever a verdict exists for the row, so a
    verdict that lost to the held category is not re-asked.
  - Include / skip-tag changes are applied on sheet close like the cutoff (`deckDirty`); AI-flag
    changes just re-run `ensureClassified`. The wizard's tune step ("What to sort?") holds the
    same cutoff chips, include checkboxes and skip-tag chips and refetches right away; its count
    line reads "N transactions to sort since <date>". Tags come from `GET /v2/tags` (`lm.getTags`,
    archived ones dropped), fetched on Settings open / tune-step entry; a saved skip tag the fetch
    no longer returns stays as a chip so it can be switched off.
- **Local rules**: pattern → category, delete only (creation stays on the undo toast). Deleting one
  clears rule-sourced suggestions and re-attaches from the remaining rules + caches, so a deleted
  rule leaves no ghost verdict on a card.
- **Dates** render through `card.fmtTxnDate` — `Intl.DateTimeFormat` with an `undefined` locale, so
  day/month order follows the reader's own region. Bare `YYYY-MM-DD` is parsed as a LOCAL calendar
  day (`new Date("…")` is UTC midnight = the previous day west of Greenwich); the year is added only
  when it isn't the current one, and a time only when the source actually carries one.
- **Category picker** (`dopo.picker.v1`, variants `tiles`/`cols`/`dock`/`wheel`/`list`): which
  layout the category sheet uses. `pickerLoad()` returns `null` when unset so app.js can resolve the
  default per install — **`tiles` for fresh installs, `list` for installs that predate the feature**
  (detected by an already-stored LM token), then persist it so the one-time "new pickers" hint
  fires once. `list` is also the automatic fallback for trees too large for a non-scrolling layout.
  Settings has the same five chips plus a "Try" button.
  - **Wheel geometry**: at rest the inner ring is the whole disc (`R0..R_FULL` = 20..98 viewBox
    units); opening a group puts `pk-open` on the `<svg>` and CSS scales `g.pk-inner` by
    `innerScale` (56/98, 120 ms, none under reduced motion) so the fan takes 58..98. The inner
    paths are never rebuilt (pointer capture lives on the `<svg>`); `wheelGeometry()` is the one
    source for the hit band (`R1` = 98 at rest, 56 open), the demo finger's spot and the CSS factor.
    Because the hit geometry flips instantly while the ring shrinks, a group opened by the current
    gesture starts a **12 px dead zone** (`OPEN_SLOP`): inside it nothing is hovered and a
    pointerup leaves the fan open (tap-open); outside it normal drag-and-lift resumes. `wheelHit()`
    takes the hovered key for **angular hysteresis** (0.06 rad past a wedge's edge) so a finger on
    the seam of an even fan does not flip between two children — and pointerup hits with the same
    `keep`, so the commit is always what the lens shows.
  - **Lens**: the chip above the finger is a `popover="hint"` where the Popover API exists (top
    layer — above the sheet body's `overflow:hidden` and every stacking context — positioned fixed
    from viewport px; lift = 56 px + half its height). A hint light-dismisses on any outside
    pointerup or Escape, so `moveLens()` re-arms it every move (`manual` would be the stricter type;
    `hint` was the explicit ask). Without the API it stays the absolute chip inside the picker root.
- **Category hues** (`dopo.hues.v1`): the persisted per-category hue map, keys `c:<id>` for leaves
  and `g:<group name>` for groups, values integers 0..359. Hues are assigned once (largest angular
  gap among already-assigned siblings) and then **never change**, which is the whole point — colours
  are only learnable if they're stable across sessions, across live/offline boots, and across
  category additions. Read drops invalid entries individually (losing the map = recolouring
  everything); the map is capped at 512 keys, oldest first, and is never pruned against the current
  tree because a snapshot boot legitimately sees a subset of it. Like `dopo.picker.v1`, it is a
  device preference and **survives "Forget tokens"**.
- **Onboarding wizard** (`#onboard`, a `<dialog>` in the top layer; replaces the old onboarding
  card): 6 steps — welcome (what dopo does, the privacy line, an offline note) → lm (paste the LM
  token, live-validated) → or (a real radio group, `own` first: `free` when a shared key is
  configured, else `none`; `own` reveals a key field and a 3-step how-to) → tune ("What to sort?":
  cutoff chips always expanded as "Include transactions for", the per-bucket include checkboxes,
  the skip-tag chips, plus the live in-scope count) →
  picker (choose the category picker: five chips from `PICKER_META`, the chosen variant's blurb,
  and under them the picker itself, live — mounted on the user's own categories once the quiet deck
  load has landed (`obPreviewRefresh` swaps the demo tree out when it lands mid-step) and dealing
  their own transactions as samples; a pick only deals the next sample, nothing reaches Lunch Money.
  No self-playing demo and no "Try it" button — the earlier ghost-finger preview read as the app
  clicking itself. No nested dialog; the choice persists on selection and `canAdvance` always
  permits Continue) → done (gesture legend and the
  music/SFX toggles, which share the `setMusicPref`/`setSfxPref` setters with Settings and are
  repainted from `audioPrefs` on entry). Split so each step fits an iPhone SE without scrolling.
  Shown iff `!tokens.lm || cursor`; resumes at the persisted step, never at `welcome` once a token
  exists. Returning users (Forget tokens) skip to `["lm","or"]` when a shared free tier exists, else
  `["lm"]` alone — never silently defaulting a returning own-key user onto the shared key, and never
  re-asking for the picker (that preference already exists and outlives Forget tokens). The last
  step's primary button reads "Done" on the returning path, "Start sorting" on a first run.
  - **Resume cursor** `dopo.onboard.v1` holds the current step id, written on every step change and
    removed on finish or Forget tokens. Invariant: the wizard is showing iff `!tokens.lm || cursor`.
  - **Containment**: while the wizard is open (`onboardingActive`) it owns the top layer alone —
    Settings and other sheets cannot open over it, and the periodic refresh, visibility handlers,
    online resync, and `ensureClassified` all stand down until it closes. Token errors route into
    the wizard's own fields (`obGoto(step, {dead:true})`) instead of Settings.
  - Deck loading starts quietly once the `or` step commits (`loadDeckQuiet()` — no dealing,
    animation, or classification), so the done step's count is usually already populated by the
    time the user reaches it; dealing and classifying only happen once, at `obFinish()`.
  - History mirrors the sheet machinery: opening the wizard pushes one history entry; Back inside
    the wizard consumes it and steps backward (re-pushing to stay balanced); Back on the first step
    leaves the wizard open and falls through to leaving the PWA, same as any other sheet.

## CSP & XSS

- Meta CSP as the FIRST element in <head> of every HTML file (before any link/script). Baseline
  (offline.html keeps exactly this):
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self';
  connect-src 'self' https://api.lunchmoney.dev https://openrouter.ai; base-uri 'self';
  form-action 'none'; object-src 'none'` (frame-ancestors impossible via meta — never claimed).
- index.html diverges in exactly two directives (CI enforces per-file expectations, gate 2):
  connect-src additionally allows `https://dopo-music.artems.net` (the music CDN), and script-src is
  `'self' 'wasm-unsafe-eval'`. The wasm token is required because the vendored libopenmpt worklet
  compiles its embedded wasm synchronously (`new WebAssembly.Module`); unlike `unsafe-eval` it
  enables nothing but wasm compilation. It is the ONE permitted `unsafe-` token, directive-scoped —
  any other occurrence anywhere in the policy fails CI. CSP is never widened beyond this: if a
  future vendor needs blob:/eval, the vendored copy gets patched instead.
- ZERO inline <script>, <style>, or style= attributes in any HTML (externalize offline.html
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
- `table.html`/`table.js`/`table.css`: REMOVED. The bulk-select view never earned its keep next to
  swipe mode, and it was the app's only second page (a second precached shell, a second SW navigation
  mapping, and its own duplicated `esc`/`toast`/`fmtAmount`). Rules management moved into the Settings
  sheet; rules are still created from the undo toast's "Always: … →" chip.
- package.json: NO `dependencies` (hono gone); devDependencies only (wrangler for the Cloudflare deploy,
  typescript for checkJs, @types/bun). bun.lock regenerated accordingly.
- wrangler.jsonc: assets-only (no D1, no crons, no vars, no main).

## Deploy & versioning

- `scripts/stamp-sw.ts` (bun): copies public/ to dist/, replaces `__DOPO_VERSION__` with a content hash
  of the public files (+ the free key), and `__DOPO_FREE_KEY__` with `$DOPO_FREE_KEY`; FAILS if a
  placeholder is missing/left or the key is malformed. BOTH deploys use it:
  Pages workflow uploads dist/; Cloudflare deploy = `bun scripts/stamp-sw.ts && wrangler deploy` (wrangler
  assets dir pointed at dist/). CI checks the sw.js precache list matches the actual files in public/.
- Self-host section documents the stamp script; serving public/ raw works but SW cache-busting
  requires the stamp (README states this).

## CI (rewritten)

- bun test (lib fixtures: lm shapes incl. status:"reviewed" PUT body, rules, clean, cardHTML XSS,
  music shuffle-bag).
- tsc --noEmit --allowJs --checkJs over JSDoc-annotated public modules (sw.js and public/vendor
  excluded — vendor is upstream code, integrity-pinned instead).
- Greps: no inline script/style/style= in HTML; CSP meta is first in head AND matches the per-file
  expected policy (see CSP & XSS); esc() tripwire; fetch-context URLs outside
  {self, api.lunchmoney.dev, openrouter.ai, dopo-music.artems.net} forbidden (navigation hrefs
  allowlisted: my.lunchmoney.app, openrouter.ai, lunchmoney.app docs). Text gates skip
  public/vendor/**.
- Vendor integrity: every file under public/vendor/** must match its sha256 in vendor.lock (both
  directions). Vendored code runs next to the finance tokens; the hash pin replaces the text gates
  for that subtree, and re-vendoring produces a reviewable vendor.lock diff. Local patches to
  vendored files are documented in the vendor dir's PATCHES.md.
- Assert package.json has no `dependencies`. gitleaks. Pages artifact build from dist/.
- Actions pinned by commit SHA; permissions minimal (contents: read; pages: write + id-token: write
  on the deploy job only).

## Audio (chiptune music + SFX; owner-approved, added post-v1)

- Both settings toggles OFF by default; everything audio is additive-only (haptic() contract: any
  failure degrades to silence, never a broken swipe). Prefs in `dopo.audio.v1`.
- SFX: pure Web Audio synthesis in lib/sfx.js — zero assets, zero new origins. One shared
  AudioContext, two gain buses (music 0.4 / sfx 0.7), master compressor configured as a limiter.
- Music: lib/music.js + the vendored chiptune3/libopenmpt AudioWorklet player
  (public/vendor/chiptune3-<ver>/, integrity-pinned, local patches in PATCHES.md). Tracks are scene
  tracker modules served from the `dopo-music` R2 bucket at https://dopo-music.artems.net
  (CORS-restricted to the app origins, X-Robots-Tag: noindex). Track binaries NEVER enter this
  repo; attribution lives in music/manifest.json + MUSIC.md (takedown: GitHub issues).
- Shuffle-bag (lib/shuffle.js, pure + unit-tested) persists in `dopo.music.v1`: every track plays
  before repeats, walk survives sessions, each app open advances, reshuffle avoids immediate
  repeats, ban list is permanent.
- Cache taxonomy: `dopo-static-<hash>` (SW precache, purged per version) · `dopo-vendor`
  (persistent, SW vendor/ route, hardened fill identical to install, pruned of dead versions by
  music.js) · `dopo-music-v1` (persistent, page-level Cache API — the SW never intercepts the
  cross-origin music fetches; cache-on-play + prefetch next-in-bag). The SW activate purge deletes
  ONLY `dopo-static-*`.
- Autoplay policy: context unlocks on the first natural gesture; engine and first track are
  pre-warmed before it. Tab hidden = ctx.suspend (position preserved). iOS: `interrupted` state gets
  a one-shot pointerdown resume retry; the ring/silent switch muting Web Audio is a documented
  limitation (Settings sub-text + MUSIC.md), no silent-<audio> workaround shipped.

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
