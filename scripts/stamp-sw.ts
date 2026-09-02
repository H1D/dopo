#!/usr/bin/env bun
/**
 * Deploy stamping: copy public/ -> dist/, replacing the __DOPO_VERSION__ placeholder
 * with a content hash over the public/ files (computed BEFORE replacement, so the
 * stamp is deterministic for a given source tree), and the __DOPO_FREE_KEY__
 * placeholder (lib/freekey.js) with the DOPO_FREE_KEY environment variable — the
 * shared free-tier OpenRouter key, which never enters git. An unset/empty variable
 * stamps an empty key (= no shared tier). The key value is folded into the version
 * hash, so rotating it re-busts the service-worker cache like any content change.
 *
 * Fails hard when:
 *   - the placeholder is missing from the sw.js INPUT (cache-busting would silently die)
 *   - either placeholder is still present anywhere in the OUTPUT
 *   - DOPO_FREE_KEY is set but does not look like an OpenRouter key
 *
 * Usage: bun scripts/stamp-sw.ts [srcDir] [outDir]   (defaults: public dist)
 * Both deploys use this: the Pages workflow uploads dist/, family deploy is
 * `bun scripts/stamp-sw.ts && wrangler deploy` with assets pointed at dist/.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PLACEHOLDER = "__DOPO_VERSION__";
const KEY_PLACEHOLDER = "__DOPO_FREE_KEY__";
const freeKey = (process.env.DOPO_FREE_KEY ?? "").trim();
const TEXT_EXT = /\.(js|mjs|css|html|json|webmanifest|svg|txt|xml|md)$/i;

const srcDir = resolve(process.argv[2] ?? "public");
const outDir = resolve(process.argv[3] ?? "dist");

function fail(msg: string): never {
  console.error(`stamp-sw: ${msg}`);
  process.exit(1);
}

if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) fail(`source dir not found: ${srcDir}`);
if (resolve(outDir) === resolve(srcDir)) fail("output dir must differ from source dir");
if ((outDir + "/").startsWith(srcDir + "/")) fail("output dir must not live inside the source dir");
if (freeKey && !/^sk-or-v1-[0-9a-f]{64}$/.test(freeKey)) fail("DOPO_FREE_KEY is set but is not an OpenRouter key (sk-or-v1-<64 hex>)");

/** All files under dir, as sorted paths relative to dir. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

const files = listFiles(srcDir);
if (!files.length) fail(`source dir is empty: ${srcDir}`);

// 1. Guard: sw.js must exist at the source root and carry the placeholder.
const swRel = "sw.js";
if (!files.includes(swRel)) fail(`missing ${swRel} in ${srcDir}`);
const swSource = readFileSync(join(srcDir, swRel), "utf8");
if (!swSource.includes(PLACEHOLDER)) {
  fail(`${swRel} does not contain the ${PLACEHOLDER} placeholder — SW cache-busting would break`);
}

// 2. Content hash over ALL source files (paths + bytes), placeholder included,
//    plus the free key: a rotated key must reach clients like any other change.
const hash = createHash("sha256");
for (const rel of files) {
  hash.update(rel);
  hash.update("\0");
  hash.update(readFileSync(join(srcDir, rel)));
  hash.update("\0");
}
hash.update(freeKey);
const version = hash.digest("hex").slice(0, 12);

// 3. Copy + stamp.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(srcDir, outDir, { recursive: true });
let stamped = 0;
for (const rel of files) {
  if (!TEXT_EXT.test(rel)) continue;
  const p = join(outDir, rel);
  const text = readFileSync(p, "utf8");
  if (!text.includes(PLACEHOLDER) && !text.includes(KEY_PLACEHOLDER)) continue;
  writeFileSync(p, text.split(PLACEHOLDER).join(version).split(KEY_PLACEHOLDER).join(freeKey));
  stamped++;
}

// 4. Guard: no placeholder may survive into the output.
for (const rel of listFiles(outDir)) {
  if (!TEXT_EXT.test(rel)) continue;
  const text = readFileSync(join(outDir, rel), "utf8");
  for (const ph of [PLACEHOLDER, KEY_PLACEHOLDER]) {
    if (text.includes(ph)) fail(`placeholder ${ph} still present in output file ${rel}`);
  }
}

console.log(`stamp-sw: ${files.length} files -> ${outDir}, version ${version} (${stamped} file(s) stamped, free key ${freeKey ? "set" : "empty"})`);
