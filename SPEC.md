# dopo swipe mode — implementation spec (v2.1, vetted 2 rounds)

Mobile-first, game-like, one-transaction-at-a-time review UI replacing the table as the
default view. The table lives on at `/table.html` (rules management). Vanilla JS, no build step.

## Files & ownership

- `public/index.html`, `public/swipe.css`, `public/swipe.js` — the swipe experience (Agent A).
  `index.html` MUST include `<link rel="manifest" href="/manifest.webmanifest">`,
  `<meta name="theme-color">`, `<script src="/api.js">` before `swipe.js`, and a menu link to `/table.html`.
- `public/api.js` — shared fetch wrapper (Agent A): JSON fetch + Cloudflare Access expiry
  detection (response is a redirect to `*.cloudflareaccess.com` or content-type is not JSON →
  throw `AuthExpiredError`; caller keeps queue and does `location.reload()` full navigation to re-auth).
- `public/manifest.webmanifest`, `public/icon.svg` (+ PNG fallbacks if trivially generatable) — Agent B.
- `public/table.html` menu link back to `/` — Agent B. Do not otherwise touch table files.
- Server code (`src/`) is FROZEN for this feature. Coordination notes, if needed: `COORDINATION.md`.

## Existing API (do not change)

- `GET /api/state?start&end` → `{range, categories:[{id,name,group}], rules, transactions:[{id, date, amount, currency, payee, notes, merchant, suggestion|null, ...}]}`
  amount is a string; positive = money OUT, negative = money IN. `suggestion = {suggested_category_id, confidence, reasoning, lookup, source: 'rule'|'llm', merchant}`.
- `POST /api/classify {limit}` → `{classified, via_rules, via_llm, cached, remaining, ...}` — classifies up to `limit` unsuggested txns (oldest first), caches in D1.
- `POST /api/apply {items:[{id, category_id, make_rule?:{pattern,match_type}}]}` → `{applied:[ids], skipped:[ids], rules_created}` — server re-checks each txn is still uncategorized; replay-safe.

## Deck & card

- Deck of uncategorized transactions, dealt in sets of ~25. Within a set, order by confidence desc
  (suggested cards first; unsuggested last). Global backlog meter secondary; per-set progress primary.
- Card content: leading emoji of suggested category (parse from category name) + category NAME in text,
  merchant (big), amount (green IN / red OUT, sign per convention above), date, model reasoning line.
  Raw payee + lookup snippet collapsed behind a tap (tap target off the horizontal drag axis).
  Confidence ring decorative only.
- Card states:
  - confident: `suggestion.category_id != null && confidence >= 0.7` (or `source == 'rule'`).
  - unsure: null category OR confidence < 0.7 → amber frame, "unsure" badge, NO drag tilt.
- Next cards peek behind the top card (2 visible layers is enough).

## Gestures (Pointer Events)

- `touch-action: pan-y` on card; `setPointerCapture` on pointerdown; track ONE pointerId, ignore others.
- `pointercancel` or release below threshold → spring back, zero state change.
- Commit at release only: distance ≥ 40% card width OR release velocity flick.
- Amounts ≥ 100 EUR: raise commit threshold ~1.5× (deliberate flick).
- Confident card: swipe right = accept suggestion; swipe left = park to Later; tap category chip = override picker.
- Unsure card: swipe right = OPEN PICKER (pre-highlight model guess if any); swipe left = park.
  While the picker is open after an unsure right-swipe, the card holds a "lifted" state;
  dismissing the picker without choosing springs it back — no decision counted. Same for override path.
- Every gesture mirrored as visible buttons (✓ / Later / Override) for desktop + a11y; buttons keyboard-focusable.

## Picker (bottom sheet)

- Bottom sheet, thumb-zone friendly, grouped categories, model guess pre-highlighted, recent picks surfaced.
- After picking a category: optional explicit confirm chip "Always: <merchant> → <category>" = save-as-rule
  (sends `make_rule {pattern: merchant, match_type:'contains'}`). Rule creation lives ONLY here.

## Decisions, rewards

- accept / override / park ALL count as decisions: streak++, progress++, confetti every 10 decisions,
  set-complete mini-celebration each 25, inbox-zero celebration when active deck empty
  ("Inbox zero — N parked for later" if Later non-empty). Canvas confetti ~40 lines, no library.
- Haptics `navigator.vibrate?.(..)` additive only. Springy physics via CSS transitions/WAAPI.

## Apply queue (the load-bearing part)

- On accept/override: push `{id, category_id, make_rule?, ts}` to a localStorage-backed queue SYNCHRONOUSLY,
  then animate. Queue survives tab death.
- Undo (5s, bottom-anchored toast, fat target): an item is flushable ONLY after its undo toast is
  dismissed (event-driven flag on the item — not parallel timers). Undo = remove from queue +
  reinsert card at deck front + decrement progress/streak (park-undo: remove from Later + reinsert).
  Undo after a celebration dismisses the celebration overlay.
- Flush triggers: ≥10 flushable items, picker close, and pagehide/visibilitychange(hidden).
  On hidden: flush all FLUSHABLE items via `fetch(..., {keepalive:true})`; items with a live undo
  toast stay in localStorage (replay covers them if the page dies).
- On 2xx: dequeue every id present in `applied` + `skipped`. Network error / non-2xx: keep queued,
  capped exponential backoff 5s → 30s → 60s, reset on success or user action.
- Mark items in-flight when a flush starts; in-flight items are skipped by other flushes; clear on failure.
- `skipped` ids from LIVE flushes → absorb gracefully: drop card silently if still in deck,
  toast "N already done ✓" (counts toward shared progress). `skipped` from the ON-LOAD replay → swallow
  silently (they were the user's own past work). Suppress "already done" for ids this client sent.

## Deck lifecycle

- Load: replay localStorage queue first → `GET /api/state` → deal. Deck NEVER includes ids present in
  the queue or the Later pile (applies to every rebuild).
- Classification is just-in-time: if any dealt cards lack suggestions, run `POST /api/classify` —
  FIRST call `{limit:4}` (deal as soon as it returns), then loop `{limit:16}` in background until
  `remaining == 0`, re-merging suggestions into undealt cards. Empty deck + call in flight →
  lightweight "warming up cards…" skeleton card (never a blocking screen).
- Refresh (visibilitychange→visible after >60s away, and every 5 min): flush first, then re-fetch state,
  reconcile BEHIND the top card only — never mutate/remove the card under the user's thumb; a stale top
  card resolves through the skipped path on apply.
- Later pile: visible chip/tab with count; parked cards viewable and un-parkable; parking is client-side
  (localStorage), not persisted server-side.

## Non-goals

- No framework, no build step, no server changes, no service worker (Access cookie + SW = pain; PWA is
  manifest-only install).
- CI typechecks `src/` only; `public/` JS is not type-checked (deliberate).
