# dopo

Swipe your [Lunch Money](https://lunchmoney.app) transactions into categories. A static PWA with a
mobile-first, game-like review UI: one card at a time, swipe right to accept the model's suggestion,
left to park, tap to override. GLM-5.3-flash (via OpenRouter, bring your own key) does the guessing;
you stay the judge.

**Use it now: [dopo.artems.net](https://dopo.artems.net)** — no signup; paste your two tokens and swipe.

There is no backend. The whole app is a folder of vanilla ES modules served as static files. Your
Lunch Money token and OpenRouter key live in your browser's storage and are sent by your browser
directly to `api.lunchmoney.dev` and `openrouter.ai` — nowhere else.

## Privacy, honestly

- Your tokens go browser → Lunch Money / OpenRouter directly. They are **never sent to the host**
  serving this page, because there is nothing there to send them to — it's a static file server.
- The host still sees ordinary web metadata (your IP, user agent, when you loaded the page). That is
  true of any website.
- You are trusting the JavaScript being served to you. Mitigations: the code is open source with
  **zero runtime dependencies and no third-party requests beyond the two APIs you explicitly
  connect** (Lunch Money and OpenRouter) — no trackers, analytics, CDNs, or fonts. This is enforced
  in depth: the Content-Security-Policy in every page pins `connect-src` to exactly those two
  origins (the runtime guarantee), and CI validates both the CSP content and the source code's URL
  surface. If that trust is still too much, **self-host it or pin a commit** and serve it yourself;
  then no one can change the code out from under you.

## Security

- **Lunch Money tokens are unscoped.** A LM API token can read and write everything in your budget.
  Treat it like a bank password: only paste it into origins you trust, and revoke it when in doubt.
- **Use a dedicated OpenRouter key with a spend limit.** Create a separate key just for dopo and cap
  it (a few dollars covers months of use). Worst case is bounded.
- **Browser extensions can read page storage.** A CSP protects against injected third-party content,
  but it does not bind extensions you install — an extension with page access can read your tokens
  on any site, including this one. Don't run extensions you don't trust on the browser profile that
  holds financial tokens.
- **Revocation runbook** (lost device, suspected compromise, or just done with the app):
  1. Revoke the LM token at [my.lunchmoney.app/developers](https://my.lunchmoney.app/developers).
  2. Revoke or rotate the OpenRouter key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys).
  3. If you still have the device: Settings → **Forget tokens on this device**.

  Revoking upstream is the real kill switch — step 3 is just hygiene.

## What it costs

You pay OpenRouter directly; dopo adds no margin because dopo has no operator.

| Step | When it runs | Cost |
| --- | --- | --- |
| Pass 1 — batch classification | every unsuggested transaction, batches of 8 | ~$0.06 per 500 transactions |
| Pass 2 — web check | once per **unique** merchant the model was unsure about (auto-capped at 15 per session, more behind an explicit button) | $0.0075 per merchant, cached — you pay at most once per merchant while the cache persists |

No OpenRouter key? The app still fully works with local rules + manual picking; you just get no AI
suggestions.

## What you give up vs. a server variant

- **No background classification.** Suggestions are computed while the app is open. Open the app,
  give it a few seconds, start swiping.
- **Rules, progress, and the suggestion cache are per device.** Nothing syncs between your phone and
  laptop (your *decisions* land in Lunch Money, so the transaction state itself is shared).
- On iOS, Safari may evict site data (including the merchant cache) after ~7 days of non-use —
  see below.

## Offline first

dopo works without a connection. The app shell is cached by the service worker, the deck renders
from the last fetched snapshot (with a banner showing its age), and every swipe is saved on the
device the moment you make it — then synced to Lunch Money when you're back online. An
"Offline · N queued" chip shows what's waiting; before anything queued is written upstream, dopo
re-checks that each transaction is still uncategorized, so a decision made offline never
overwrites categorization done elsewhere in the meantime. AI suggestions need the network and
pause while offline; sorting by hand keeps working.

## iOS: Add to Home Screen

Install the app (Share → **Add to Home Screen**). Installed PWAs get durable storage (dopo also
requests `navigator.storage.persist()` at boot); a plain Safari tab's storage can be evicted after
7 days without a visit — and that eviction removes *everything together*: tokens, local rules,
merchant cache, the offline snapshot, any not-yet-synced queue, and the service worker itself, so
offline boot is impossible afterward anyway. Everything already synced is in Lunch Money either
way — eviction costs you convenience (and any unsynced queue), not your budget data. Note the
installed app and Safari use separate storage: a token pasted in Safari doesn't exist in the
installed app, and queued changes sync per container.

## Self-hosting

Any static file host works: GitHub Pages, Cloudflare, Netlify, nginx, `python -m http.server`. The
app is path-relative and runs at a domain root or under a subdirectory unchanged.

```bash
bun scripts/stamp-sw.ts   # copies public/ -> dist/, stamps the SW version
# serve dist/
```

Serving `public/` raw works too, but the service worker version placeholder is only replaced by the
stamp script — without it, updates won't invalidate the offline cache. Use `dist/`.

`bun test && bun scripts/ci-checks.ts` runs the same gates as CI (XSS property tests, CSP/inline
checks, external-URL allowlist, SW precache drift).

### Family instance (optional Access)

The reference private deployment serves the same `dist/` from an assets-only Cloudflare Worker at a
custom domain, behind Cloudflare Access:

```bash
bun scripts/stamp-sw.ts && bunx wrangler deploy
```

The reference instance auto-deploys: every commit on `master` ships through the CI deploy job
once all gates pass (`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repository secrets).

Access is optional — the app holds no server-side data to protect, so a public static host is just
as safe. The service worker is written to be Access-safe if you do put it behind one (install-time
content-type guards, redirect-transparent navigations, exception-only offline fallback).

## Development

`bun install`, then serve `public/` with any static server. No build step, no bundler, zero runtime
dependencies. Behavioral contracts live in `SPEC.md` (swipe UX) and `SPEC-STATIC.md` (architecture,
apply-queue semantics, CSP, CI gates).

## License

[MIT](LICENSE)
