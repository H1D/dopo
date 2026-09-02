"use strict";
/*
 * dopo service worker — static app. The rules below are safe both for a plain
 * static host and for an origin behind an auth proxy (e.g. Cloudflare Access),
 * which is why navigations are passed through untouched.
 *
 * Hard rules (each has bitten an Access-behind-SW app before):
 * - Navigations: return the network/preload response UNCHANGED, including
 *   opaqueredirect / status-0 (nav fetches use redirect mode "manual"; the
 *   browser follows the Access→IdP chain natively). The offline fallback is
 *   served ONLY when the fetch REJECTS — never based on status/ok/type.
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
  "lib/rules.js",
  "lib/clean.js",
  "lib/dust.js",
  "lib/music.js",
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
      await cache.put(url, res);
    }));
    // ANY miss above rejects waitUntil -> the whole install fails atomically;
    // the update lands on a later (authenticated) visit instead.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch { /* optional */ }
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
      try {
        // Return whatever resolves, UNCHANGED — opaqueredirect/status-0 included.
        // No status/ok/type inspection here, ever: an Access redirect must reach
        // the browser so it can follow the IdP chain natively.
        return (await event.preloadResponse) ?? (await fetch(req));
      } catch {
        // EXCEPTION-ONLY fallback: the fetch itself rejected (truly offline).
        // Map the REQUEST pathname (never the response) to a cached shell so the
        // app still boots offline; offline.html stays the last resort. Hosts
        // that canonicalize .html URLs mean users navigate to /, not /index.html
        // — accept both spellings (and a trailing slash).
        const root = scoped("./");
        let path = url.pathname;
        if (path.length > root.length && path.endsWith("/")) path = path.slice(0, -1);
        let shell;
        if (path === root || path + "/" === root || path === scoped("index.html") || path === scoped("index")) {
          shell = scoped("index.html");
        }
        const fromCache = (p) => caches.match(p, { cacheName: CACHE }).catch(() => undefined);
        const cached = (shell && (await fromCache(shell))) || (await fromCache(OFFLINE_PATH));
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
        await cache.put(url.pathname, res.clone());
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
