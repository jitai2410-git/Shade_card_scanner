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

## Phase 3 — Swatch crop + PDF generation

**Tested:** `test-phase3.html` run via Playwright against `fixtures/test-video.mp4`, full pipeline (extract → OCR → PDF) through `js/pdfGenerator.js`. Resulting PDF base64 extracted from the page's `#base64Out` textarea via `browser_evaluate` (saved directly to a file with the tool's `filename` option to avoid any manual-transcription risk on the ~45KB string), decoded to a real `.pdf` file, and parsed with `pdf-parse` via `tools/verify-phase3-pdf.js`.

**Result:** PASS

**Page count:** 1, **Labels found:** [701, 702, 703], **Image count:** 3

**Failures found:**

1. **`npm install --save-dev pdf-parse` (no version pin) installed `pdf-parse@2.4.5`, which has a completely different API** (a class-based `PDFParse` export) than the classic v1.x function API (`pdfParse(buffer) -> Promise<data>`) that the brief's `tools/verify-phase3-pdf.js` script (and the wider `pdf-parse` ecosystem's common usage) assumes. First run failed with `TypeError: pdfParse is not a function`. Diagnosed by inspecting `require('pdf-parse')`'s exported keys, which showed `PDFParse`, `Line`, `Table`, etc. — a v2 rewrite, not the v1 default export. **Fix:** pinned to `pdf-parse@1.1.1` (`npm uninstall pdf-parse && npm install --save-dev pdf-parse@1.1.1`), which restored the expected `pdfParse(buffer)` function signature; `tools/verify-phase3-pdf.js` then ran unmodified per the brief. `package.json`'s devDependency is pinned to `1.1.1` — anyone re-running `npm install` will get the same working API.

No issues were found in `js/pdfGenerator.js` or `test-phase3.html` themselves — the crop-then-embed pipeline, jsPDF's default Helvetica font (text extraction worked with no changes needed), and the 2-column grid layout all worked correctly on the first in-browser run once the verification tooling was fixed. Zero console errors or warnings across 59 browser console messages during the full pipeline run.

## Phase 4 — Full pipeline UI

**Tested:** index.html end-to-end via Playwright against fixtures/test-video.mp4 — file select, progress text, swatch grid rendering, PDF download trigger, verified with tools/verify-phase3-pdf.js against the resulting PDF.

**Result:** PASS

**Run details:** Served via `python -m http.server 8080`. Navigated to `http://localhost:8080/index.html`, clicked `#pickBtn`, uploaded `fixtures/test-video.mp4` (lowercase-drive-letter path required for Playwright's file-upload allowed-roots check on Windows) via `browser_file_upload`, waited for status text containing `Done —` (resolved well under the 45s timeout — full pipeline took ~4.5s wall time after ffmpeg core load). Snapshot confirmed: 3 swatch tiles in `#swatchGrid` labeled 701/702/703, `#downloadBtn` visible with text "Download PDF", `#errorBanner` not present/visible in the accessibility tree (still `display: none`). Status text read exactly `Done — 3 shades found: 701, 702, 703`.

Extracted `pdfResult.base64` (a top-level `const` in the non-module `app.js` script, reachable directly from `browser_evaluate`'s page-context expression — no need to expose it on `window`) via `browser_evaluate` with the `filename` option (same large-string-avoids-context trick as Phase 3), decoded to a `.pdf`, and ran `node tools/verify-phase3-pdf.js`:

```
Pages: 1
Text: "\n\n701702\n703"
Image count: 3
PASS: PDF is valid, contains labels [ '701', '702', '703' ] and 3 images
```

Console log during the run (via `SCSLogger`) showed the full traced pipeline: ffmpeg core load → frame extraction (4 frames found, matching Phase 1) → OCR per-frame (701/702/duplicate-702-skipped/703, matching Phase 2's dedup behavior exactly) → PDF assembly (3 shades added, `ShadeCard_<timestamp>.pdf`, 33685 bytes). Zero console errors besides one benign `404` for `icons/icon-192.png` (icon assets are not yet created — that's Task 5's `manifest.json`/icons scope, not this task's; the `<link rel="icon">` reference in `index.html` is per the brief's exact markup and does not affect functionality).

**Failures found:** none. The UI wiring, error-banner element (`#errorBanner`/`#errorText`/`#copyLogBtn`), and coarse progress reporting (frame-extraction percentage via `onProgress`, OCR/PDF stage text) all worked as specified on the first real end-to-end run — no code changes were needed beyond the brief's exact `app.js`/`index.html`/`css/style.css` listings. No finer-grained OCR progress threading was needed (brief Step 5(a) was not triggered). `hideError()` is called at the top of the `change` handler, so the error banner correctly resets between runs (brief Step 5(b) — verified by code inspection, not re-triggered in this run since the happy path never errors). `videoInput.value = ''` in the `finally` block is present and correct per the brief's Step 5(c) guidance (intentional, not a bug) — noted here rather than "fixed."

## Phase 5 — PWA layer

**Tested:** manifest.json JSON-validity (Node), icon file generation (Node, size sanity check), and in-browser via Playwright: SW registration, cache population (18 assets), and page render after the dev server was killed (offline proxy — see note below). Also ran a full pipeline regression (fixtures/test-video.mp4 → 3-shade PDF) with the SW active to confirm fetch interception doesn't break normal online operation.

**Asset list note:** the brief's example `sw.js` ASSETS list (18 entries) did not include `814.ffmpeg.js`, the UMD worker chunk that `js/frameExtractor.js` fetches at runtime via `FFmpegUtil.toBlobURL(...)` for the `classWorkerURL` workaround documented in Phase 0. Omitting it would mean the app can load `ffmpeg.js`/`ffmpeg-core.js`/`ffmpeg-core.wasm` offline but fail at `ffmpeg.load()` because the worker chunk fetch would hit the network and fail. Added `https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/814.ffmpeg.js` to the ASSETS list; the final count is still 18 (11 local assets + 7 CDN assets, one more CDN URL than the brief's list but the brief's local-asset count example matches).

**Node-level checks:**
```
node tools/generate-icons.js
Wrote icons/icon-192.png (192x192)
Wrote icons/icon-512.png (512x512)

node -e "... size sanity check ..."
icons/icon-192.png 5523 bytes OK
icons/icon-512.png 15518 bytes OK

node -e "JSON.parse(...); console.log('valid JSON')"
valid JSON
```

**Environment issue found and fixed (not a code bug):** the first Playwright verification pass returned a stale `{}` body for `manifest.json` and stale cache contents. Root-caused via `netstat`/`Get-CimInstance Win32_Process` to **five separate stray `python -m http.server 8080` processes** left running on port 8080 from earlier task sessions in this same environment, all bound simultaneously (Windows permitted the duplicate binds); the browser's requests were being served nondeterministically by whichever process's socket handled the connection, at least one of which was serving an older Task-0-era copy of the files. Fixed by killing all five processes (`Stop-Process -Force` on each PID) and starting exactly one fresh `python -m http.server 8080` from the project root, then clearing the browser's HTTP cache, Service Worker registrations, and Cache Storage via CDP/`caches.delete()` before re-running the checks. This was purely a leftover-process artifact of the test environment, not an issue in `manifest.json`, `sw.js`, or `index.html`.

**In-browser results (Playwright, single clean server, cleared SW/cache state first):**
- `fetch('./manifest.json').then(r => r.json())` → `{"name":"Shade Card Scanner","iconsCount":2}` — PASS.
- `navigator.serviceWorker.getRegistration()` (after ~3s wait) → `true` — PASS.
- `caches.open('shade-card-scanner-v1').then(c => c.keys()).then(k => k.length)` → `18` — PASS, matches `ASSETS.length`.
- Per-asset cache inspection: all 18 entries present, `status=200`, local assets `type=basic`, all 7 CDN assets `type=cors` (unpkg sends proper CORS headers, so responses are real, non-opaque, fully inspectable — no fallback to `fetch(url, {mode:'no-cors'})` + `cache.put()` was needed).
- Offline-render check: stopped the (single, confirmed-only) `python -m http.server 8080` process, confirmed via `netstat` the port had no listener, then navigated to `http://localhost:8080/index.html` again. Page loaded successfully; `document.title` → `"Shade Card Scanner"`, full DOM (heading, button, status line) rendered — proving the SW's cache-first `fetch` handler served every asset with zero live network access. Server was restarted afterward for the regression check.

**Regression check (SW active, server back up):** navigated to `index.html`, clicked "Select Fabric Video", uploaded `fixtures/test-video.mp4` via `browser_file_upload`, waited for `Done —` text. Result: status line read exactly `Done — 3 shades found: 701, 702, 703`, swatch grid showed 3 tiles (701/702/703), `Download PDF` button visible. Console messages: 60 total, 0 errors, 0 warnings — confirming the SW's cache-first fetch interception does not interfere with normal online operation (cache misses/first-loads still fall through to `fetch()` correctly).

**Note on Lighthouse:** No Lighthouse CLI is available in this environment; the offline-reload-after-server-kill check is used as the closest equivalent to Lighthouse's offline audit. Recommend the user also runs a real Lighthouse PWA audit from Chrome DevTools once deployed to Cloudflare Pages, documented in TESTING.md.

**Result:** PASS

**Failures found:** none in the PWA code itself. One environment artifact (stray duplicate `http.server` processes from prior sessions) caused an initial false-negative on the manifest fetch check; root-caused and resolved as described above, not a defect in `manifest.json`/`sw.js`/`index.html`.

## Phase 6 — Adversarial self-review

**Environment note:** before starting, found one stray `python -m http.server 8080` (PID 1244) left running from a prior session, bound to port 8080. Killed it and started exactly one fresh server from the project root before any testing, per the process documented in Phase 5. A second stray pair of servers (PIDs 10188/19244) reappeared partway through this phase's testing (likely spawned by an unrelated tool/session in the same environment) — found via `netstat`/`Get-CimInstance Win32_Process`, both stopped, single server confirmed listening before the offline-reload check.

| # | Check | Finding | Fix |
|---|-------|---------|-----|
| a | iOS Safari memory limits | Cannot test (no iOS device available); real risk for long videos | Documented as known limitation in `js/frameExtractor.js` (comment block above `extractFrames`) and `TESTING.md`'s "Known limitations" section; 5-min cap mitigates but does not eliminate the risk |
| b | Photo instead of video selected | Confirmed working on first real test. Uploaded `icons/icon-192.png` via Playwright `browser_file_upload` to `#videoInput`. The `file.type.startsWith('video/')` check in `app.js` fired correctly: error banner appeared with text `Selected file is "image/png", not a video. Please pick a video file.` No blank screen, no crash, `downloadBtn` stayed hidden. | None needed — working as designed |
| c | Zero shades detected | Confirmed working on first real test. Generated a 3s black synthetic video (`ffmpeg -f lavfi -i "color=c=black:s=640x480:d=3:r=30" ...`), uploaded via Playwright. Both extracted frames had OCR confidence 0 (correctly below the 70 threshold), 0 shades detected. Status text read exactly `No shade numbers were detected in this video. Try a clearer, closer, well-lit recording of the shade cards.` Verified in-browser via `browser_evaluate`: `downloadBtn.style.display` stayed `'none'` and `errorBanner.style.display` stayed `'none'` (soft "nothing found", not routed through the error path). Zero console errors. | None needed — working as designed |
| d | Non-consecutive duplicate shade numbers | Working as spec'd (consecutive-only dedup, confirmed by reading `js/ocr.js`'s `lastNumber` tracking logic) | Documented policy below, no code change |
| e | Pale/ivory low-contrast OCR | Generated a synthetic video: background `0xF5F5F0` (near-white), text "999" in `0xFFFFF0` (near-white, ~0.4% RGB difference from background) at 200pt. Ran through the real `extractFrames` → `detectShades` pipeline via Playwright. **Actual observed confidence: 95** (well above the 70 threshold) — Tesseract correctly recognized "999" and the frame was *not* skipped; PDF was generated with shade 999. This confirms the brief's anticipated scenario (ii): OCR confidence reflects glyph-shape/stroke certainty (a large, clean, well-formed synthetic glyph), not human-perceived color contrast — a flat-color synthetic test doesn't reproduce the JPEG compression noise, anti-aliasing, and lighting gradients of a real low-contrast phone photo that would actually degrade Tesseract's confidence. This is a real, documented limitation of confidence-based filtering, not a bug: it is *possible* for a genuinely hard-to-read-by-eye frame to still score high confidence, and vice versa. | Documented as a known limitation of confidence-based filtering below; no code change — forcing a fake low-confidence result to "pass" this check would misrepresent actual behavior |
| f | CDN unreachable on first visit | Found gap: blocking `<script>` tags mean a CDN failure prevents `app.js` (and its error-banner logic) from ever running, leaving a blank page. Verified real: temporarily pointed the `ffmpeg.js` `<script src>` in `index.html` at a nonexistent URL, cleared the Service Worker/Cache Storage (to bypass the SW's cache-first serving of the previously-cached, working `index.html`), and reloaded — page went to a blank `<body>` with only the (still-registering) SW backdrop, no visible error at all, confirming the gap. | Added the global `window.addEventListener('error', ..., true)` script-error handler (brief's exact code) as the first `<script>` in `<head>`, before the CDN `<script>` tags. Re-tested with the same broken-URL setup: page now renders "Could not load required libraries" with the failed URL shown, instead of blank. Reverted the broken URL back to the real `ffmpeg.js` CDN URL afterward and re-verified normal load still works. |

### Duplicate handling policy
Only *consecutive*-frame duplicates are deduped (per spec). If shade 701 appears at
frame 2 and again at frame 40 (non-consecutive), both are kept as separate entries in
the output. Rationale: the spec explicitly scopes dedup to consecutive frames only,
and collapsing all-time duplicates could silently drop a genuinely re-scanned or
re-shot shade. If this is undesired in practice, the fix is a one-line change in
js/ocr.js: track a `Set` of all seen numbers instead of just `lastNumber`.

### OCR confidence-filtering limitation (check e)
Tesseract's `data.confidence` score measures how certain the OCR engine is about
the *shape* of the glyphs it found, not how visually distinguishable those glyphs
are to a human eye. A large, clean, evenly-lit digit — even rendered in a color
very close to its background — can still score a high confidence if its edges are
crisp enough for the engine's internal classifier. Real-world low-contrast frames
(e.g. pale ivory fabric under uneven lighting, motion blur, JPEG compression
artifacts) are more likely to also have soft/blurry edges, which is what actually
drives confidence down in practice — the confidence threshold is a reasonable
proxy for "OCR trusts its own reading," not a guaranteed proxy for "a human would
find this legible." No code change made; documented here as a known characteristic
of confidence-based filtering.

**_headers file:** Not created. No custom response headers are required — the app uses the single-thread ffmpeg.wasm core specifically to avoid needing COOP/COEP (per the Phase 0 decision), and no finding in this phase (including the check-f CDN fix, which is a client-side script-error handler, not a header concern) surfaced any need for cache-control or other header tuning.

**Full regression re-run after fixes (Step 2):**

| Task | Check | Result |
|------|-------|--------|
| 1 | Frame extraction (via full pipeline against `fixtures/test-video.mp4`) | PASS |
| 2 | OCR shade detection + consecutive dedup (701/702/702-dup-skipped/703) | PASS |
| 3 | PDF generation (1 page, labels `[701, 702, 703]`, 3 images) — verified via `tools/verify-phase3-pdf.js` against a freshly re-extracted `pdfResult.base64` | PASS |
| 4 | Full pipeline UI (file select → progress text → swatch grid → download button), status text exactly `Done — 3 shades found: 701, 702, 703`, zero console errors | PASS |
| 5 | PWA layer: SW registration confirmed (`getRegistration()` truthy), cache populated with 18 assets, page still rendered correctly after killing the dev server entirely (offline reload) and restarted server afterward | PASS |

All five re-runs matched their original Task 1-5 DIAGNOSTICS.md results exactly (same shade numbers, same PDF byte size class, same asset count) — no regressions from the Step 1 fixes (the `index.html` script-error handler and the `js/frameExtractor.js` comment addition).

# Gemini Migration

Real-world testing on 2026-07-10 found the original Tesseract.js-based OCR (Phases 0-6 above) cannot read actual fabric catalogue labels — see design doc at docs/superpowers/specs/2026-07-10-gemini-shade-detection-design.md for full root-cause evidence. This section logs the migration to Gemini API-based detection.

## Phase 0 — Cloudflare Worker backend

**Tested:** `wrangler dev` locally serving both static assets and `/api/detect-shades`; real end-to-end request using frames extracted from `fixtures/test-video.mp4`, through the actual Worker code (not a direct Gemini curl); error-case handling (missing images, too-many-images).

**Result:** PASS

**Failures found:**

1. **Infinite reload loop with default `wrangler dev --local` persistence (root cause diagnosed and fixed).** With `assets.directory` set to `"./"` (the whole repo) in `wrangler.jsonc`, running `npx --prefix tools wrangler dev --port 8788 --local` from the repo root entered a continuous `⎔ Reloading local server...` loop (confirmed via log timestamps: dozens of reload cycles per minute) and never stabilized enough to serve a request — a plain `GET /` with a 10s timeout returned nothing, and a POST to `/api/detect-shades` hung indefinitely (netstat showed dozens of local TIME_WAIT connections to port 8788, one per reload cycle). Root cause: Miniflare's local persistence state (`.wrangler/state/v3/cache/miniflare-CacheObject/metadata.sqlite-shm`, etc.) is written inside the repo by default, and since the asset watcher watches the entire `assets.directory` tree (`.assetsignore` governs what gets *uploaded* on deploy, not what the dev-mode file watcher watches for live-reload), each write to `.wrangler/` retriggered the watcher, which reloaded the server, which rewrote the state file, ad infinitum. Confirmed by observing `.wrangler/state/v3/cache/miniflare-CacheObject/metadata.sqlite-shm` had a fresh mtime on every reload cycle.
   **Fix:** run with `--persist-to` pointed at a directory outside the repo (e.g. a scratch/temp directory), e.g.:
   ```
   npx --prefix tools wrangler dev --port 8788 --local --persist-to "<some-dir-outside-the-repo>"
   ```
   With this flag, reload count stabilized at 1 (the initial build) and stayed there under repeated checks over 30+ seconds of idle time, and both `GET /` and `POST /api/detect-shades` responded normally. This is a local-dev-only workaround; it does not affect `wrangler deploy` (Cloudflare's hosted Workers runtime does not use local Miniflare persistence). No code or config file needed to change — this is purely a local invocation flag. Recommendation: use `--persist-to <path outside the repo>` for all future local `wrangler dev` sessions on this project, since `assets.directory` is the whole repo.

**Real end-to-end test (Step 5):** frames extracted from `fixtures/test-video.mp4` via a real `@ffmpeg-installer/ffmpeg` binary (`fps=1/1.5,scale='min(960,iw)':-2`, 4 frames), POSTed as base64 JPEGs to `POST http://localhost:8788/api/detect-shades` through the actual Worker code path (not a direct Gemini curl). Real Gemini response received:
```
status 200
{
  "shades": [
    { "shadeNumber": "701", "imageIndex": 0 },
    { "shadeNumber": "702", "imageIndex": 1 },
    { "shadeNumber": "703", "imageIndex": 3 }
  ]
}
```
All three expected shade numbers (701/702/703) from the synthetic test video were correctly identified with valid in-range `imageIndex` values.

**Error-case tests (Step 6):**
```
--- Missing images array ---
HTTP/1.1 400 Bad Request
{"error":"Missing \"images\" array"}

--- Too many images (61) ---
HTTP/1.1 400 Bad Request
{"error":"Too many images: max 60 per request"}
```
Both returned correct 400 status and clear JSON error bodies, no crash or unhandled exception (confirmed via `curl -i`).

**Worker log during testing** (clean run, `--persist-to` fix applied):
```
[wrangler:info] Ready on http://127.0.0.1:8788
[wrangler:info] GET / 200 OK (14ms)
[wrangler:info] POST /api/detect-shades 200 OK (18887ms)
[wrangler:info] POST /api/detect-shades 400 Bad Request (7ms)
[wrangler:info] POST /api/detect-shades 400 Bad Request (6ms)
```
