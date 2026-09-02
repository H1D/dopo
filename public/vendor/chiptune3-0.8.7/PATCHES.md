# Vendored: chiptune3 0.8.7

- Upstream project: https://github.com/DrSnuggles/chiptune
- npm package: `chiptune3@0.8.7`
- Tarball: https://registry.npmjs.org/chiptune3/-/chiptune3-0.8.7.tgz
- License: MIT (X11); the compiled libopenmpt parts in `libopenmpt.worklet.js` are under the OpenMPT BSD license (see upstream `LICENSE`).

Files vendored verbatim from the tarball's `package/` directory, except for the
two patches below applied to `chiptune3.worklet.js`:

- `chiptune3.js` — main-thread player (unmodified)
- `chiptune3.worklet.js` — AudioWorklet processor (patched)
- `libopenmpt.worklet.js` — emscripten build of libopenmpt with embedded wasm (unmodified)

## Patch 1: free the module staging buffer (memory leak)

In `MPT.play()`, the full module file is copied into a `_malloc`'d buffer
(`ptrToFile`) and handed to `_openmpt_module_create_from_memory`, which makes
its own copy of the data. Upstream never frees `ptrToFile`, so every `play()`
leaks the entire module's byte size in wasm heap memory. The free sits BEFORE
the create-failure early return: whether create copied the data or rejected
the module, the staging buffer is dead.

```diff
 		this.modulePtr = libopenmpt._openmpt_module_create_from_memory(ptrToFile, byteArray.byteLength, 0, 0, 0)
+		libopenmpt._free(ptrToFile)	// dopo patch: create copied the data (or failed) — the staging buffer is dead either way

 		if(this.modulePtr === 0) {
 			// could not create module
 			this.port.postMessage({cmd:'err',val:'ptr'})
 			return
 		}
```

## Patch 2: fix no-op frees in stop() (field name mismatch)

`MPT.play()` allocates the render buffers as `this.leftPtr` / `this.rightPtr`,
but `MPT.stop()` frees `this.leftBufferPtr` / `this.rightBufferPtr` — fields
that are never assigned, so the frees are no-ops on `undefined` and the two
512-byte render buffers leak per play. Renamed the freed fields to match the
allocation sites.

```diff
-		if (this.leftBufferPtr != 0) {
-			libopenmpt._free(this.leftBufferPtr)
-			this.leftBufferPtr = 0
-		}
-		if (this.rightBufferPtr != 0) {
-			libopenmpt._free(this.rightBufferPtr)
-			this.rightBufferPtr = 0
-		}
+		if (this.leftPtr != 0) {
+			libopenmpt._free(this.leftPtr)
+			this.leftPtr = 0
+		}
+		if (this.rightPtr != 0) {
+			libopenmpt._free(this.rightPtr)
+			this.rightPtr = 0
+		}
```

## Re-vendoring

When updating to a newer upstream version, check whether upstream has fixed
these bugs; re-apply any still-needed patches and regenerate `vendor.lock`
(repo root) with the sha256 of the final, post-patch bytes.
