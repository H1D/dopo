# Music

dopo's optional background music (off by default — Settings → Sound) is
keygen/cracktro-era and demoscene chiptune: tracker modules (MOD/XM/IT/S3M)
written by scene musicians, played in the browser with
[libopenmpt](https://lib.openmpt.org/) via the vendored
[chiptune3](https://github.com/DrSnuggles/chiptune) player.

## Attribution

Every track is the work of its author. dopo displays "Title — Author" in the
♪ mini-player whenever a track plays, and the full catalog with per-track
source links lives in [`music/manifest.json`](music/manifest.json). The track
files themselves are not part of this repository; they are served from a
separate music host (`dopo-music.artems.net`, marked `noindex`).

These works circulate in the scene tradition of free listening and sharing;
they are used here non-commercially, with attribution, in a hobby tool. No
ownership is claimed over any track.

## Takedown

If you are the author (or rights holder) of a track and want it removed:
[open an issue](https://github.com/H1D/dopo/issues) naming the track. It will
be removed promptly, no questions asked — removal means deletion from the
music host and from `music/manifest.json`, after which no client can fetch it
(clients honor the manifest; a banned/absent track never plays again).

## Known playback limitations

- iPhone: the ring/silent hardware switch mutes Web Audio entirely — set it
  to ring to hear anything.
- Safari (non-installed, tab usage): storage eviction can purge cached tracks
  after ~7 days of not visiting; installed-PWA usage is unaffected.

## Operations (owner notes)

- Bucket: R2 `dopo-music`, public domain `dopo-music.artems.net`, CORS
  restricted to the app origins, `X-Robots-Tag: noindex` via zone transform
  rule.
- Upload/sync: `bun scripts/upload-music.ts [staging-dir]` with
  `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` (R2-write scoped token) in
  the env. The manifest uploads last; the repo copy of
  `music/manifest.json` is the source of truth.
- Removing a track: delete the R2 object, drop its manifest entry, re-upload
  the manifest (`bun scripts/upload-music.ts` does this automatically).
