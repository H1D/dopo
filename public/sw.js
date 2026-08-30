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
 * - Install fetches with {redirect:"manual", cache:"reload"} and rejects
 *   anything that isn't a 200 with a sane content-type — an Access login page
 *   (text/html) must never be cached as app.js.
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
  "lib/store.js",
  "offline.html",
  "offline.css",
  "table.html",
  "table.js",
  "table.css",
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
      const res = await fetch(url, {
        redirect: "manual", // Access redirect -> opaqueredirect (status 0) -> install fails
        cache: "reload", // bypass HTTP cache so a stale login page can't sneak in
        credentials: "same-origin",
      });
      if (res.status !== 200) throw new Error(`precache ${url}: status ${res.status}`);
      if (!contentTypeOk(url, res)) {
        throw new Error(`precache ${url}: bad content-type ${res.headers.get("content-type")}`);
      }
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
    // Drop every non-current cache BEFORE claiming clients.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
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
        const cached = await caches.match(OFFLINE_PATH, { cacheName: CACHE }).catch(() => undefined);
        return cached || Response.error();
      }
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
