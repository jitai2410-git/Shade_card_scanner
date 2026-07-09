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
