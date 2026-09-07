"use strict";
/*
 * dopo service worker — static app. The rules below are safe for a plain
 * static host and do not break behind an auth proxy (e.g. Cloudflare Access):
 * the cache only ever holds verified same-origin assets, and once a version is
 * cached the origin is contacted only by the browser's own sw.js update check
 * — behind Access an expired session then pins the app to its cached version
 * (LM/OpenRouter traffic never touches the origin) until a login happens
 * elsewhere; nothing poisonous can be cached.
 *
 * Hard rules (each has bitten an Access-behind-SW app before):
 * - The app shell (index.html) is CACHE-FIRST from the CURRENT version's cache,
 *   exactly like app.js/app.css next to it. Network-first HTML + cache-first
 *   assets is a version skew machine: while a new SW sits waiting, a reload
 *   gets the NEW markup styled by the OLD stylesheet (a wizard with no styles,
 *   seen in the wild). A version now lands as a whole, when the next SW
 *   activates — the page's "New version" toast drives that.
 * - Navigations that miss the cache return the network response UNCHANGED,
 *   including opaqueredirect / status-0 (nav fetches use redirect mode
 *   "manual"; the browser follows an Access→IdP chain natively). The offline
 *   fallback is served ONLY when the fetch REJECTS — never based on
 *   status/ok/type.
 * - Install fetches with {redirect:"follow", cache:"reload"} and rejects
 *   anything that isn't a SAME-ORIGIN 200 with a sane content-type — an Access
 *   login chain ends off-origin and fails install; a login page (text/html)
 *   must never be cached as app.js. (Follow, not manual: static hosts
 *   canonicalize .html URLs with redirects — Cloudflare assets 307s them.)
 * - No skipWaiting() at install: only on an explicit SKIP_WAITING message
 *   (the page shows an "update ready" toast and sends it on user consent).
 *
 * Every cached URL is derived from self.registration.scope so the identical
 * file works at a domain root (dopo.artems.net/) and under a project subpath
 * (user.github.io/dopo-classifier/).
 */

const VERSION = "__DOPO_VERSION__"; // stamped by scripts/stamp-sw.ts at deploy
const CACHE = `dopo-static-${VERSION}`;

/** Resolve a scope-relative path to an absolute pathname on this origin. */
function scoped(path) {
  return new URL(path, self.registration.scope).pathname;
}

// Scope-relative precache list. CI (scripts/ci-checks.ts) fails the build if
// this list drifts from the files actually present in public/.
const PRECACHE = [
  "index.html",
  "app.js",
  "app.css",
  "boot.js",
  "data.js",
  "lib/card.js",
  "lib/lm.js",
  "lib/classify.js",
  "lib/freekey.js",
  "lib/rules.js",
  "lib/clean.js",
  "lib/dust.js",
  "lib/music.js",
  "lib/onboard.js",
  "lib/picker.js",
  "lib/pickerui.js",
  "lib/sfx.js",
  "lib/shuffle.js",
  "lib/store.js",
  "lib/sync.js",
  "offline.html",
  "offline.css",
  "manifest.webmanifest",
  "icon.svg",
  "dust.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
];

const OFFLINE_PATH = scoped("offline.html");
const PRECACHE_PATHS = new Set(PRECACHE.map(scoped));

/**
 * The precached shell a navigation pathname maps to, or null. Hosts that
 * canonicalize .html URLs mean users navigate to /, not /index.html — accept
 * both spellings (and a trailing slash).
 * @param {string} pathname
 * @returns {string|null}
 */
function shellFor(pathname) {
  const root = scoped("./");
  let path = pathname;
  if (path.length > root.length && path.endsWith("/")) path = path.slice(0, -1);
  if (path === root || path + "/" === root || path === scoped("index.html") || path === scoped("index")) {
    return scoped("index.html");
  }
  return null;
}

/** 200-only + content-type sanity: reject login HTML masquerading as assets. */
function contentTypeOk(path, res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (/\.m?js$/.test(path)) return /javascript|ecmascript/.test(ct);
  if (path.endsWith(".css")) return ct.includes("text/css");
  if (path.endsWith(".html")) return ct.includes("text/html");
  if (path.endsWith(".webmanifest")) return /manifest|json/.test(ct);
  if (path.endsWith(".svg")) return ct.includes("image/svg");
  if (path.endsWith(".png")) return ct.includes("image/png");
  return !ct.includes("text/html"); // unknown extension: anything but a login page
}

/**
 * A response that arrived via redirect (Workers Assets 307s /index.html to /)
 * keeps `redirected: true`, and the Cache API preserves that. Answering a
 * NAVIGATION (redirect mode "manual") with such a response is a network error
 * by spec — Chrome shows ERR_FAILED for every page load. Re-wrap the body into a
 * plain 200 so the cached shell is usable for any request mode.
 * @param {Response} res  a verified same-origin 200
 * @returns {Promise<Response>}
 */
async function cleanRedirect(res) {
  if (!res.redirected) return res;
  const body = await res.arrayBuffer();
  return new Response(body, { status: 200, statusText: "OK", headers: res.headers });
}

self.addEventListener("install", (event) => {
  // NO skipWaiting() here — only ever on an explicit client message.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (path) => {
      const url = scoped(path);
      // redirect:"follow", NOT "manual": static hosts canonicalize .html URLs
      // (Cloudflare assets 307s /index.html -> /), which would otherwise
      // fail every install. Safety is preserved by the checks below: the final
      // response must be a same-origin 200 with a sane content-type — an Access
      // login chain ends on *.cloudflareaccess.com and still fails atomically.
      const res = await fetch(url, {
        redirect: "follow",
        cache: "reload", // bypass HTTP cache so a stale login page can't sneak in
        credentials: "same-origin",
      });
      if (res.status !== 200) throw new Error(`precache ${url}: status ${res.status}`);
      if (res.url && new URL(res.url).origin !== self.location.origin) {
        throw new Error(`precache ${url}: redirected off-origin to ${res.url}`);
      }
      if (!contentTypeOk(url, res)) {
        throw new Error(`precache ${url}: bad content-type ${res.headers.get("content-type")}`);
      }
      // Key by the REQUESTED path (url), not the canonical res.url, so cache
      // lookups by precache path keep working on every host flavor.
      await cache.put(url, await cleanRedirect(res));
    }));
    // ANY miss above rejects waitUntil -> the whole install fails atomically;
    // the update lands on a later (authenticated) visit instead.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Navigation preload is deliberately OFF: the shell is answered from the
    // cache, so a parallel network fetch per navigation would only cost data.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch { /* optional */ }
    }
    // Drop stale VERSIONED caches before claiming clients — and ONLY those.
    // The origin's Cache Storage also holds two persistent caches this purge
    // must spare: "dopo-vendor" (the chiptune engine, filled by the vendor
    // route below) and "dopo-music-v1" (page-cached music tracks). Wiping
    // them on every deploy would re-download megabytes per version bump.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("dopo-static-") && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Foreign origins (api.lunchmoney.dev, openrouter.ai) are never intercepted:
  // token-bearing API traffic goes straight from the page to the network.
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const fromCache = (p) => caches.match(p, { cacheName: CACHE }).catch(() => undefined);
      // App shell, CACHE-FIRST from THIS version's cache: the markup must always
      // be the one app.js/app.css (served from the same cache) were written for.
      // Keyed by the REQUEST pathname, never the response.
      const shell = shellFor(url.pathname);
      const cachedShell = shell ? await fromCache(shell) : undefined;
      if (cachedShell) return cachedShell;
      try {
        // Return whatever resolves, UNCHANGED — opaqueredirect/status-0 included.
        // No status/ok/type inspection here, ever: an Access redirect must reach
        // the browser so it can follow the IdP chain natively.
        return await fetch(req);
      } catch {
        // EXCEPTION-ONLY fallback: the fetch itself rejected (truly offline) and
        // no shell was cached for this path; offline.html is the last resort.
        const cached = await fromCache(OFFLINE_PATH);
        return cached || Response.error();
      }
    })());
    return;
  }

  // Vendored chiptune engine: cache-first from a PERSISTENT cache that
  // survives version bumps (the files live in a release-versioned dir, so a
  // vendor upgrade changes the URL; lib/music.js prunes dead versions).
  // The fill applies the SAME hardening as install — behind Cloudflare Access
  // an expired session resolves subresource fetches as a 200 login page, and
  // a poisoned entry here would be served forever.
  if (req.method === "GET" && url.pathname.startsWith(scoped("vendor/"))) {
    event.respondWith((async () => {
      const cache = await caches.open("dopo-vendor");
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      const res = await fetch(url.pathname, {
        redirect: "follow",
        cache: "reload", // bypass HTTP cache so a stale login page can't sneak in
        credentials: "same-origin",
      });
      if (res.status === 200 &&
          (!res.url || new URL(res.url).origin === self.location.origin) &&
          contentTypeOk(url.pathname, res)) {
        await cache.put(url.pathname, await cleanRedirect(res.clone()));
      }
      return res;
    })());
    return;
  }

  // Precached statics: cache-first. Everything else falls through to the browser.
  if (req.method === "GET" && PRECACHE_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(url.pathname, { cacheName: CACHE });
      return cached || fetch(req);
    })());
  }
});
