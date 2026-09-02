// scripts/upload-music.ts — sync the curated music set to the dopo-music R2
// bucket. Run: `bun scripts/upload-music.ts [staging-dir]` (default
// ~/dopo-music-staging). Track binaries live ONLY in the staging dir and the
// bucket — never in this repo; the repo holds music/manifest.json (attribution
// metadata, the source of truth for what the bucket should contain).
//
// Auth: expects CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the env with
// R2 write access to the bucket (see MUSIC.md "Operations").
//
// Idempotent: a track already public at https://dopo-music.artems.net/<file>
// is skipped (HEAD 200) unless --force. The manifest uploads LAST so clients
// never see an entry whose file isn't there yet.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { $ } from "bun";

const BUCKET = "dopo-music";
const PUBLIC_BASE = "https://dopo-music.artems.net";
const MANIFEST_REPO = "music/manifest.json";

const args = process.argv.slice(2).filter((a) => a !== "--force");
const force = process.argv.includes("--force");
const staging = args[0] ?? join(homedir(), "dopo-music-staging");
const tracksDir = join(staging, "tracks");

type Entry = { id: string; file: string; title: string; author: string };
const manifest = JSON.parse(readFileSync(MANIFEST_REPO, "utf8")) as Entry[];
if (!Array.isArray(manifest) || !manifest.length) {
  console.error(`${MANIFEST_REPO}: empty or not an array`);
  process.exit(1);
}

if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set (R2 write scope)");
  process.exit(1);
}

let uploaded = 0, skipped = 0, missing = 0;
for (const e of manifest) {
  const local = join(tracksDir, e.file);
  if (!existsSync(local)) {
    console.error(`MISSING locally: ${e.file} (${e.title} — ${e.author})`);
    missing++;
    continue;
  }
  if (!force) {
    const head = await fetch(`${PUBLIC_BASE}/${e.file}`, { method: "HEAD" }).catch(() => null);
    if (head?.ok) { skipped++; continue; }
  }
  // Modules are binary blobs to the web; the exact subtype doesn't matter to
  // the player (it reads bytes), octet-stream keeps intermediaries honest.
  await $`bunx wrangler r2 object put ${`${BUCKET}/${e.file}`} --file ${local} --content-type application/octet-stream --remote`.quiet();
  uploaded++;
  console.log(`up: ${e.file}`);
}

if (missing) {
  console.error(`${missing} manifest entries missing from ${tracksDir} — manifest NOT uploaded`);
  process.exit(1);
}

await $`bunx wrangler r2 object put ${`${BUCKET}/manifest.json`} --file ${MANIFEST_REPO} --content-type application/json --remote`.quiet();
console.log(`manifest.json uploaded — ${uploaded} new, ${skipped} already present, ${manifest.length} total`);
