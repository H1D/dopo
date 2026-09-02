// scripts/ci-checks.ts — static-tree CI gates. Run: `bun scripts/ci-checks.ts`
//
// Gates (all spec-mandated, see SPEC-STATIC.md "CI"):
//   1. HTML hygiene: zero <style>, zero style= attributes, zero inline on*=
//      handlers, every <script> tag has src= (no inline scripts).
//   2. CSP meta is the FIRST element inside <head> of every public/*.html, and
//      its content matches the per-file expectation (CSP_EXPECT): index.html
//      adds the music CDN to connect-src and 'wasm-unsafe-eval' (the one
//      permitted unsafe- token, directive-scoped) to script-src; offline.html
//      stays minimal.
//   3. esc() tripwire: on any HTML-ish JS line (opening tag or inner/outerHTML),
//      every ${...} interpolation must be `esc(...)`, `Number(...)`, or a bare
//      identifier ending in `Html` (pre-escaped fragment accumulator).
//   4. URL allowlist: fetch-context origins limited to self + api.lunchmoney.dev
//      + openrouter.ai + dopo-music.artems.net; navigation hrefs may additionally
//      use my.lunchmoney.app / lunchmoney.app; svg may reference the w3.org
//      xmlns. Nothing else, anywhere.
//   5. sw.js PRECACHE exactly matches the files present in public/ (minus sw.js;
//      vendor/ is exempt one-directionally — lazily cached by the sw vendor route).
//   6. sw.js still contains the __DOPO_VERSION__ placeholder (stamped only in dist/).
//   7. dust sprite frame/cell/timing constants agree across baker, sim and CSS.
//   8. package.json has no "dependencies" key (zero runtime deps).
//   9. public/vendor/** matches vendor.lock sha256s exactly (gates 3/4 don't
//      scan vendor code; the hash pin replaces them).
//
// Gates 3 + 4 skip public/vendor/** (see isVendored); gate 9 is their
// replacement for that subtree.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const failures: string[] = [];
const fail = (msg: string) => {
  failures.push(msg);
};

const PUB = "public";

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

const files = walk(PUB);
const read = (rel: string) => readFileSync(join(PUB, rel), "utf8");
const ext = (rel: string) => rel.slice(rel.lastIndexOf("."));

// ---- 1 + 2: HTML hygiene + CSP-first ---------------------------------------

// Per-file CSP expectations. index.html carries the app: its connect-src adds
// the music CDN and its script-src adds 'wasm-unsafe-eval' — the ONE unsafe-
// token this repo permits, because the vendored libopenmpt worklet compiles
// its embedded wasm with `new WebAssembly.Module` (sync). Unlike unsafe-eval
// it enables nothing but wasm compilation. offline.html runs no scripts and
// stays at the minimal policy — new capabilities never leak there.
const CSP_EXPECT: Record<string, { connect: string[]; script: string[] }> = {
  "index.html": {
    connect: ["'self'", "https://api.lunchmoney.dev", "https://openrouter.ai", "https://dopo-music.artems.net"],
    script: ["'self'", "'wasm-unsafe-eval'"],
  },
  "offline.html": {
    connect: ["'self'", "https://api.lunchmoney.dev", "https://openrouter.ai"],
    script: ["'self'"],
  },
};

for (const f of files.filter((f) => f.endsWith(".html"))) {
  const html = read(f);
  if (/<style[\s>]/i.test(html)) fail(`${f}: inline <style> block (externalize to a .css file)`);
  if (/<[^>]*\sstyle\s*=/i.test(html)) fail(`${f}: inline style= attribute`);
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) fail(`${f}: inline on*= event handler`);
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\bsrc\s*=/.test(tag[0])) fail(`${f}: inline <script> without src (${tag[0]})`);
  }
  const flat = html.replace(/\s+/g, " ");
  if (!/<head> ?<meta http-equiv="Content-Security-Policy"/i.test(flat)) {
    fail(`${f}: CSP meta is not the first element in <head>`);
  }
  // The CSP is the runtime backstop for the whole privacy claim: validate its
  // CONTENT, not just its position, against the per-file expectation above.
  const cspMatch = flat.match(/Content-Security-Policy" content="([^"]+)"/i);
  const expect = CSP_EXPECT[f];
  if (!cspMatch?.[1]) {
    fail(`${f}: CSP meta has no content attribute`);
  } else if (!expect) {
    fail(`${f}: no CSP expectation declared for this page — add it to CSP_EXPECT in ci-checks.ts`);
  } else {
    const csp = cspMatch[1];
    const directive = (name: string) =>
      csp.match(new RegExp(`${name} ([^;]+)`))?.[1]?.trim().split(/\s+/) ?? [];
    const connect = directive("connect-src").sort();
    if (JSON.stringify(connect) !== JSON.stringify([...expect.connect].sort())) {
      fail(`${f}: connect-src must be exactly {${expect.connect.join(", ")}}, got: ${connect.join(" ")}`);
    }
    // script-src is matched as an exact token SET (directive-scoped): a
    // wasm-unsafe-eval that drifts into any other directive, or any other
    // unsafe- token anywhere, still fails below.
    const script = directive("script-src").sort();
    if (JSON.stringify(script) !== JSON.stringify([...expect.script].sort())) {
      fail(`${f}: script-src must be exactly {${expect.script.join(" ")}}, got: ${script.join(" ")}`);
    }
    if (/[*]/.test(csp)) fail(`${f}: CSP contains a wildcard`);
    // Remove ONLY the vetted script-src directive value, then demand the rest
    // of the policy is unsafe-free — never a global string strip.
    const rest = csp.replace(/script-src [^;]+/, "script-src");
    if (/unsafe-/.test(rest)) fail(`${f}: CSP contains an unsafe- source outside the vetted script-src`);
  }
}

// ---- 3: esc() tripwire ------------------------------------------------------

function okInterp(expr: string): boolean {
  const e = expr.trim();
  if (!e) return true;
  if (/^["'][^"']*["']$/.test(e)) return true; // plain string literal
  if (/^`[^`$]*`$/.test(e)) return true; // template literal with no interpolation
  if (/^-?\d+(\.\d+)?$/.test(e)) return true; // number literal
  if (e.includes("esc(")) return true; // escaped (possibly inside a nested template)
  if (e.startsWith("Number(")) return true;
  if (/^[A-Za-z_$][\w$]*Html$/.test(e)) return true; // pre-escaped fragment accumulator
  const ternary = e.match(/^[^?]+\?(.+):(.+)$/s); // cond ? A : B — only branches reach output
  if (ternary) return okInterp(ternary[1] ?? "") && okInterp(ternary[2] ?? "");
  return false;
}

// Vendored third-party code (public/vendor/**) is exempt from the TEXT gates
// (esc tripwire, URL allowlist) — it's upstream code we neither wrote nor
// template HTML with — but NOT from integrity: gate 9 pins every vendor byte
// to vendor.lock, so "vendored verbatim + reviewed at vendor time" is enforced.
const isVendored = (rel: string) => rel.startsWith("vendor/");

for (const f of files.filter((f) => f.endsWith(".js") && f !== "sw.js" && !isVendored(f))) {
  const lines = read(f).split("\n");
  lines.forEach((line, i) => {
    if (!/<[a-z]|innerHTML|outerHTML/i.test(line)) return;
    for (const m of line.matchAll(/\$\{\s*([^}]*)\}/g)) {
      if (!okInterp(m[1] ?? "")) {
        fail(`${f}:${i + 1}: unescaped interpolation \${${(m[1] ?? "").trim()}} in HTML template — wrap in esc()/Number() or use a *Html variable`);
      }
    }
  });
}

// ---- 4: URL allowlist -------------------------------------------------------

const FETCH_ORIGINS = new Set(["api.lunchmoney.dev", "openrouter.ai", "dopo-music.artems.net"]);
const NAV_ORIGINS = new Set(["my.lunchmoney.app", "lunchmoney.app", "www.lunchmoney.app", "openrouter.ai"]);
const TEXT_EXT = new Set([".js", ".html", ".css", ".webmanifest", ".svg", ".json"]);

for (const f of files.filter((f) => TEXT_EXT.has(ext(f)) && !isVendored(f))) {
  const e = ext(f);
  read(f).split("\n").forEach((line, i) => {
    // protocol-relative URLs inside string literals would inherit https and bypass the
    // absolute-URL scan below — treat them the same
    for (const m of line.matchAll(/["'`]\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
      const domain = (m[1] ?? "").toLowerCase();
      if ((e === ".js" || e === ".html") && FETCH_ORIGINS.has(domain)) continue;
      fail(`${f}:${i + 1}: protocol-relative external URL //${domain}`);
    }
    for (const m of line.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const domain = (m[1] ?? "").toLowerCase();
      if (e === ".svg" && domain === "www.w3.org") continue; // xmlns
      if (domain.endsWith(".invalid")) continue; // RFC 2606 reserved — can never resolve (referer fallback)
      if ((e === ".js" || e === ".html") && FETCH_ORIGINS.has(domain)) continue;
      if (e === ".html" && NAV_ORIGINS.has(domain)) continue;
      if (e === ".js" && NAV_ORIGINS.has(domain) && /href/.test(line)) continue; // navigation link built in JS
      fail(`${f}:${i + 1}: forbidden external URL ${m[0]} (allowlist: self, api.lunchmoney.dev, openrouter.ai; nav hrefs: my.lunchmoney.app, lunchmoney.app)`);
    }
  });
}

// ---- 5 + 6: sw.js precache drift + version placeholder ----------------------

const sw = read("sw.js");
if (!sw.includes("__DOPO_VERSION__")) {
  fail("sw.js: __DOPO_VERSION__ placeholder missing (never commit a stamped sw.js)");
}
const precacheMatch = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
if (!precacheMatch) {
  fail("sw.js: PRECACHE array not found");
} else {
  const listed = new Set([...(precacheMatch[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""));
  const present = new Set(files.filter((f) => f !== "sw.js"));
  for (const p of listed) if (!present.has(p)) fail(`sw.js precaches "${p}" but public/${p} does not exist`);
  // ONE-directional vendor exemption: vendor files are lazily cached by the
  // sw.js vendor/ route (1.5MB of engine must not be forced onto visitors who
  // never enable music), but a stale vendor path LISTED in PRECACHE still
  // fails via the loop above.
  for (const p of present) if (!listed.has(p) && !isVendored(p)) fail(`public/${p} exists but is missing from sw.js PRECACHE`);
}

// ---- 7: dust sprite frame count is consistent ------------------------------
// The frame count lives in three places (the baker, the sim, and the CSS
// steps() timing). If they drift, the sheet plays at the wrong rate or shows
// blank cells — a silent, animation-only breakage no other check would catch.
{
  const baker = readFileSync("scripts/gen-dust-sprite.ts", "utf8");
  const frames = [
    ["scripts/gen-dust-sprite.ts", baker.match(/const FRAMES = (\d+)/)?.[1]],
    ["public/lib/dust.js", read("lib/dust.js").match(/const FRAMES = (\d+)/)?.[1]],
    ["public/app.css", read("app.css").match(/animation: dust-sheet var\(--dur\) steps\((\d+)\)/)?.[1]],
  ] as const;
  const missing = frames.filter(([, v]) => !v).map(([f]) => f);
  if (missing.length) {
    fail(`dust sprite: frame count not found in ${missing.join(", ")}`);
  } else if (new Set(frames.map(([, v]) => v)).size !== 1) {
    fail(`dust sprite: frame count disagrees — ${frames.map(([f, v]) => `${f}=${v}`).join(", ")}`);
  }
  const cell = [
    ["scripts/gen-dust-sprite.ts", baker.match(/const SIZE = (\d+)/)?.[1]],
    ["public/lib/dust.js", read("lib/dust.js").match(/const CELL = (\d+)/)?.[1]],
  ] as const;
  if (cell.every(([, v]) => v) && new Set(cell.map(([, v]) => v)).size !== 1) {
    fail(`dust sprite: cell size disagrees — ${cell.map(([f, v]) => `${f}=${v}`).join(", ")}`);
  }

  // dust.js schedules the puff as a fraction of each card animation's duration.
  // If CSS and JS disagree the dust fires before or after the card lands, which
  // reads as a random puff rather than an impact.
  const css = read("app.css");
  const js = read("lib/dust.js");
  const dealMs = js.match(/DEAL_MS = (\d+)/)?.[1];
  // LAND_MS may alias DEAL_MS: the promoted card falls with the same keyframes.
  const rawLand = js.match(/LAND_MS = (\d+|DEAL_MS)/)?.[1];
  const landMs = rawLand === "DEAL_MS" ? dealMs : rawLand;
  const durations = [
    // animation name is captured loosely — both rules may point at deal-drop
    ["deal", css.match(/\.card\.dealing \{ animation: [\w-]+ ([\d.]+)s/)?.[1], dealMs],
    ["land", css.match(/\.card\.landing \{ animation: [\w-]+ ([\d.]+)s/)?.[1], landMs],
  ] as const;
  for (const [name, cssSec, jsMs] of durations) {
    if (!cssSec || !jsMs) { fail(`dust timing: could not read the ${name} duration from app.css / lib/dust.js`); continue; }
    if (Math.round(parseFloat(cssSec) * 1000) !== Number(jsMs)) {
      fail(`dust timing: ${name} duration disagrees — app.css=${cssSec}s, lib/dust.js=${jsMs}ms`);
    }
  }
}

// ---- 8: zero runtime dependencies ------------------------------------------

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown>;
if ("dependencies" in pkg) {
  fail('package.json: "dependencies" key present — this project must have zero runtime deps');
}

// ---- 9: vendor integrity ----------------------------------------------------
// public/vendor/** is exempt from the text gates above (upstream code), so this
// is the control that replaces them: every vendored byte is pinned to a sha256
// in vendor.lock. Vendor JS runs in-page next to the finance tokens — an
// unpinned change there is invisible to review and CSP alone cannot stop
// exfiltration through an allowlisted origin. Re-vendoring = new files + new
// hashes + a reviewable vendor.lock diff.
{
  let lock: Record<string, unknown> = {};
  try {
    lock = JSON.parse(readFileSync("vendor.lock", "utf8")) as Record<string, unknown>;
  } catch {
    fail("vendor.lock: missing or unparsable at the repo root");
  }
  const vendorFiles = files.filter(isVendored).map((f) => `${PUB}/${f}`);
  const listed = new Set(Object.keys(lock));
  for (const rel of vendorFiles) {
    const want = lock[rel];
    if (typeof want !== "string") {
      fail(`${rel}: present in public/vendor but not pinned in vendor.lock`);
      continue;
    }
    const got = new Bun.CryptoHasher("sha256").update(readFileSync(rel)).digest("hex");
    if (got !== want) fail(`${rel}: sha256 mismatch — vendor.lock has ${want.slice(0, 12)}…, file is ${got.slice(0, 12)}…`);
    listed.delete(rel);
  }
  for (const rel of listed) fail(`vendor.lock pins "${rel}" but the file does not exist`);
}

// ----------------------------------------------------------------------------

if (failures.length) {
  console.error(`ci-checks: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`ci-checks: OK (${files.length} files in public/)`);
