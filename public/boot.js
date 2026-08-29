// @ts-check
/**
 * Service worker registration — the ONLY job of this file (no inline scripts
 * anywhere, per CSP). Registered after load so the SW never competes with first
 * paint; update/reload choreography lives in app.js (it needs deck state).
 *
 * The path is document-relative on purpose: the same bundle serves both
 * GitHub Pages (possibly under /dopo-classifier/) and the family origin.
 */
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* offline shell is a bonus, not a dependency */
    });
  });
}
