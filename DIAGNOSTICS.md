# DIAGNOSTICS

## Phase 0 — Skeleton + dependency verification

**Tested:** tools/check-cdn.js (headless CDN reachability), test-harness.html (in-browser library load, via Playwright against `python -m http.server 8080`).

**Decision on SharedArrayBuffer/COOP-COEP:** Using `@ffmpeg/core@0.12.10` (single-thread UMD build), which does NOT require `SharedArrayBuffer`. Cloudflare Pages does not send COOP/COEP headers by default, and multi-thread ffmpeg.wasm cores fail without them. No `_headers` file is required for this reason. (A `_headers` file may still be added later for cache-control tuning, but not for cross-origin isolation.)

**Result:** PASS. `node tools/check-cdn.js` returns 6/6 `PASS 200` lines, exit code 0. `test-harness.html` loaded in a real Chromium browser via Playwright (served from `python -m http.server 8080`) reports 6/6 green PASS list items with zero uncaught console errors.

```
PASS 200 text/javascript; charset=utf-8 https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js
PASS 200 text/javascript; charset=utf-8 https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js
PASS 200 application/wasm https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm
PASS 200 text/javascript; charset=utf-8 https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js
PASS 200 text/javascript; charset=utf-8 https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js
PASS 200 text/javascript; charset=utf-8 https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js
```

Browser results (test-harness.html, 6/6 PASS):
- PASS — FFmpegWASM.FFmpeg
- PASS — FFmpegUtil.fetchFile
- PASS — FFmpegUtil.toBlobURL
- PASS — Tesseract.recognize
- PASS — jspdf.jsPDF
- PASS — ffmpeg.load() single-thread core

**Failures found (both real bugs in the pinned CDN packages, not environment issues — fixed and verified):**

1. **`@ffmpeg/util@0.12.2`'s UMD build is broken.** Loading `https://unpkg.com/@ffmpeg/util@0.12.2/dist/umd/index.js` in a browser throws `Uncaught ReferenceError: exports is not defined` — the published UMD bundle for this version references a bare `exports` global instead of using its own local module object, which doesn't exist outside a CommonJS/Node context. Root cause confirmed by fetching the file and inspecting the wrapper (`Object.defineProperty(exports,"__esModule"...)` referencing global `exports` directly). No newer version exists on npm to fix this (0.12.2 is the latest as of this check). **Fix:** pinned `@ffmpeg/util` down to **`0.12.1`** instead, which has a correct webpack-chunked UMD wrapper with no bare `exports` reference. Verified working (`FFmpegUtil.fetchFile`/`toBlobURL` both load and are callable) via an isolated Playwright test page before rolling the fix into `test-harness.html` and `tools/check-cdn.js`.

2. **`ffmpeg.load({ classWorkerURL })` forces `{ type: "module" }` for the internal `Worker`, which is incompatible with the classic UMD worker chunk it needs.** Without `classWorkerURL`, `@ffmpeg/ffmpeg@0.12.15`'s UMD build instantiates its worker directly from `https://unpkg.com/.../814.ffmpeg.js` (a cross-origin URL relative to the page), and Chromium's `Worker()` constructor unconditionally rejects a cross-origin script URL with `SecurityError: ... cannot be accessed from origin ...` — CORS headers do not override this, it's enforced regardless. The documented workaround is to fetch the worker chunk and load it via a same-origin `blob:` URL passed as `classWorkerURL`. However, doing that then fails differently: `Error: Cannot find module 'blob:...'`. Root cause, isolated by replicating the worker's message protocol manually and injecting debug logging into a copy of the chunk: when `classWorkerURL` is supplied, the library's `load()` method hardcodes `new Worker(url, { type: "module" })`. The UMD worker chunk (`814.ffmpeg.js`) is a classic script that calls `importScripts()` — which throws inside a module worker (`importScripts` is not available there) — so the code falls into a broken fallback path (`r(454)`, a webpack stub for an unresolved dynamic `import()` that unconditionally throws `Cannot find module '<url>'` regardless of input). Confirmed by manually constructing a plain classic-type `Worker` from the same blob URL and posting the same `LOAD` message: it succeeds. Also tried the `dist/esm/worker.js` + `dist/esm/ffmpeg-core.js` module-worker route instead of monkeypatching, but that has its own problems (relative `import` specifiers inside `worker.js` don't resolve against a `blob:` base, and even after rewriting them to absolute URLs, `import()`-ing the UMD `ffmpeg-core.js` as a module fails because it has no ES `default` export) — not pursued further since the classic-worker fix was simpler and verified. **Fix:** in `test-harness.html`, temporarily monkeypatch `window.Worker` for the duration of `ffmpeg.load()` to force `type: "classic"` regardless of what the library requests, then restore the original constructor in a `finally` block. Verified: `ffmpeg.load()` now resolves successfully and the harness reports PASS.

Neither fix required changing the pinned `@ffmpeg/ffmpeg@0.12.15` or `@ffmpeg/core@0.12.10` versions — both remain as specified in the plan. Only `@ffmpeg/util` was repinned (0.12.2 → 0.12.1) in both `test-harness.html` and `tools/check-cdn.js`, and the `Worker` monkeypatch was added around the `ffmpeg.load()` call in `test-harness.html`. Later tasks that call `ffmpeg.load()` in `app.js` (Task 4+) must reuse the same `classWorkerURL` blob + `Worker` type-forcing pattern, or they will hit the identical failure.

## Phase 1 — Video → frames

**Tested:**
- CLI proxy (`ffmpeg -vf "fps=1/1.5,scale='min(960,iw)':-2"` on fixtures/test-video.mp4, using the `@ffmpeg-installer/ffmpeg` N-92722 binary) → 4 frames, confirms filter graph is correct.
- In-browser (test-phase1.html via Playwright, same filter graph run through ffmpeg.wasm) → **PASS — 4 frames extracted**, 4 `<img>` thumbnails rendered, zero console errors after the fix below.

**Equivalence note:** ffmpeg.wasm 0.12.x wraps the same libavfilter as the CLI build, so the CLI run is a valid headless proxy for filter-graph correctness. The in-browser run is still required to catch WASM-specific issues (memory limits, API surface differences) that the CLI can't reveal — and it did catch one (see below).

**Result:** PASS (after fix)

**Failures found:**

1. **`@ffmpeg/core@0.12.10`'s wasm mjpeg encoder crashes with `RuntimeError: memory access out of bounds`.** First real in-browser run of `test-phase1.html` against `fixtures/test-video.mp4` failed with `FAIL — undefined` and a console error `RuntimeError: memory access out of bounds`. Diagnosed per the brief's Step 8 order: (a) `listDir` was not the issue — it's the correct API name for this ffmpeg.wasm version, confirmed by the crash happening before `listDir` is ever reached; (b) isolated with `browser_evaluate` calls directly against a fresh `FFmpeg()` instance, bypassing `frameExtractor.js`, to bisect which part of the pipeline crashes:
   - `-i input.mp4 -frames:v 1 single.png` (PNG output, no `-vf`) → **succeeded**, proving decode of the H.264/concat input and basic wasm memory/exec plumbing are fine.
   - `-i input.mp4 -frames:v 1 single.jpg` (mjpeg/JPEG output, no `-vf`, no scale, no fps filter at all) → **crashed identically**, proving the crash is not related to the `fps`/`scale` filter graph (ruling out brief's diagnosis path (b)) but is specific to the mjpeg encoder itself.
   - Root cause: `ffmpeg-core@0.12.10`'s built-in mjpeg encoder defaults to computing "optimal" Huffman tables, and that code path writes out of bounds in this wasm build (not exercised by the native CLI ffmpeg, which has a different runtime/threading model and does not crash on the identical filter graph — confirmed in Step 4).
   - **Fix:** added `-huffman 0` to the `ffmpeg.exec(...)` args in `js/frameExtractor.js`, forcing default (non-optimal, fixed) Huffman tables instead of computing optimal ones. This avoids the crashing code path entirely; JPEG output is still valid (verified: 4 frames, non-zero byte sizes, render as `<img>` thumbnails), just marginally larger than with optimal tables. Re-ran the full multi-frame filter graph (`fps=0.667,scale='min(960,iw)':-2` + `-huffman 0`) via `browser_evaluate` first to confirm 4 frames with no crash, then re-ran the real end-to-end UI flow (file input → `extractFrames` → thumbnails) via Playwright, which now reports `PASS — 4 frames extracted` with zero console errors.
   - This is a wasm-specific bug (category (c) is closest of the brief's three, though the actual mechanism is an encoder bug, not a frame-count/fps-interpretation mismatch) — logged here since later tasks reusing `frameExtractor.js`'s JPEG output path inherit this same fix; no other module currently calls `ffmpeg.exec` with mjpeg output.

## Phase 2 — OCR shade detection

**Tested:**
- Node proxy (`tesseract.js@5.1.1` against CLI-extracted fixture frames — `@ffmpeg-installer/ffmpeg` win32-x64 N-92722 binary, `-vf "fps=1/1.5,scale='min(960,iw)':-2" -q:v 3` against `fixtures/test-video.mp4`, no `-huffman 0` needed since the CLI encoder doesn't hit the wasm-only Huffman bug from Phase 1 — same whitelist/PSM11/regex/threshold config as `js/ocr.js`) → `frame_001.jpg conf=83 [701]`, `frame_002.jpg conf=87 [702]`, `frame_003.jpg conf=87 [702]`, `frame_004.jpg conf=94 [703]`, `FINAL: ["701","702","703"]`, exit code 0.
- In-browser (`test-phase2.html` via Playwright, full `extractFrames` → `detectShades` pipeline against `fixtures/test-video.mp4`, served via `python -m http.server 8080`) → `PASS — detected [701, 702, 703]`, with per-shade detail `701 (frame 0, confidence 84.0)`, `702 (frame 1, confidence 87.0)`, `703 (frame 3, confidence 93.0)`. Console log confirmed frame 2 (the duplicate `702`) was correctly deduplicated: `OCR: frame 3 matched 702, duplicate of previous frame, skipped`. Zero console errors or warnings across 55 messages.

**Result:** PASS

**Failures found:** none. The in-browser confidences (84/87/–/93, frame-2 skipped as dup) were close to but not identical to the Node proxy's confidences (83/87/87/94) — a small, expected variance from Tesseract's internal nondeterminism / minor JPEG re-encoding differences between ffmpeg.wasm and the native CLI ffmpeg build, not a functional discrepancy. Both runs cleared the 70-confidence threshold on all 4 frames and produced the identical final deduplicated shade sequence `[701, 702, 703]`, so no fix was required.
