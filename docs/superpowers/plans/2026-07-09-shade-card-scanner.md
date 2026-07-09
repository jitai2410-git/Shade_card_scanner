# Shade Card Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a PWA where a user picks a fabric flip-through video, the app extracts frames, OCRs 3-digit shade numbers, and generates a downloadable PDF shade card — all client-side, deployable as static files to Cloudflare Pages.

**Architecture:** Vanilla HTML/CSS/JS, no build step. Three CDN libraries (`@ffmpeg/ffmpeg` for frame extraction, `Tesseract.js` for OCR, `jsPDF` for PDF output) are orchestrated by plain ES modules loaded via `<script>` tags. Each pipeline stage (extract → OCR → crop/PDF) is a standalone module with its own dedicated test page so it can be verified in isolation before wiring into `index.html`. A service worker adds offline PWA capability last, after the pipeline is proven to work online.

**Tech Stack:**
- `@ffmpeg/ffmpeg@0.12.15` + `@ffmpeg/core@0.12.10` (single-thread, no SharedArrayBuffer) + `@ffmpeg/util@0.12.1`
- `tesseract.js@5.1.1`
- `jspdf@2.5.2`
- All via `unpkg.com` CDN, pinned exact versions
- Node.js (already installed, v24) used only for build-time test tooling (never shipped to the browser)
- `@ffmpeg-installer/ffmpeg` npm package used locally to generate the synthetic test video (gives us a real `ffmpeg` binary without a system install)
- Playwright MCP browser tools used for in-browser verification (frame extraction, OCR, PDF generation all require real browser APIs — `Blob`, `Canvas`, WASM — that don't exist in plain Node)

## Global Constraints

- Vanilla HTML/CSS/JS only. No frameworks (React/Vue/etc), no bundler, no build step. Every file must run as-is when served as static files.
- Every external dependency loaded via CDN `<script>` tag with an exact pinned version in the URL (no `@latest`, no bare `^`/`~` ranges).
- Must work on Cloudflare Pages with **no custom response headers required** — confirmed by using the single-thread ffmpeg core (`@ffmpeg/core@0.12.10`, not `core-mt`), which does not need `SharedArrayBuffer`/COOP/COEP.
- Target device: Android Chrome, mid-range phone. UI must be mobile-first (large tap targets, single-column layout, no hover-only affordances).
- Frame extraction: 1 frame every 1.5s, downscaled to max 960px width.
- OCR: digit whitelist `0123456789`, PSM "sparse text" (mode 11), 3-digit detection regex `\b[1-9]\d{2}\b`, confidence threshold ≥ 70.
- Dedup: same number appearing in consecutive frames → keep first occurrence only.
- PDF: crop center 60% of frame as swatch, 2-column grid, A4, filename `ShadeCard_<timestamp>.pdf`.
- Memory protocol: process one frame at a time, revoke object URLs after use, release canvases, warn if video > 5 minutes.
- Every async step wrapped in error handling; visible error banner with a "Copy debug log" button dumping the last 100 ring-buffer log lines to clipboard.
- Every phase must have a passing verification before moving to the next. Failures, root causes, and fixes are logged in `DIAGNOSTICS.md` as they happen — not written retroactively.

## Pre-flight findings (already verified, do not re-derive)

These were checked directly against this machine and the live CDN before writing this plan:

- `node --version` → v24.16.0 available. `ffmpeg` CLI is **not** on PATH, but `npm install @ffmpeg-installer/ffmpeg` provides a working static binary at `node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe` — confirmed working (`ffmpeg version N-92722-gf22fcd4483`, built with `--enable-libfreetype --enable-fontconfig`, so `drawtext` works).
- All 5 CDN URLs below returned HTTP 200 with correct JS content-type via `curl`.
- UMD globals confirmed by inspecting the actual served files (not assumed from docs):
  - `@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js` → exposes `window.FFmpegWASM.FFmpeg`
  - `@ffmpeg/util@0.12.1/dist/umd/index.js` → exposes `window.FFmpegUtil` (`.fetchFile`, `.toBlobURL`)
  - `jspdf@2.5.2/dist/jspdf.umd.min.js` → exposes `window.jspdf.jsPDF`
  - `tesseract.js@5.1.1/dist/tesseract.min.js` → exposes `window.Tesseract`
- Synthetic test video build confirmed end-to-end: 3× `color=` lavfi source + `drawtext` (using `C:/Windows/Fonts/arial.ttf`) + concat demuxer → 6.00s, 25KB `test-video.mp4`, verified via `ffmpeg -i` duration output.
- Frame extraction filter confirmed: `-vf "fps=1/1.5,scale='min(960,iw)':-2"` on the 6s test video produces **exactly 4 frames** (0s, 1.5s, 3s, 4.5s) — this is the expected proxy result for Phase 1's verification.
- OCR proxy-tested with `tesseract.js` in Node against those exact 4 frames using the whitelist+PSM11 config: results were `701 (conf 83)`, `702 (conf 87)`, `702 (conf 87, dup frame)`, `703 (conf 94)` — all above the 70 threshold, and the dedup rule collapses the repeated `702` correctly. This confirms the OCR config works before it's built into Phase 2.
- Not a git repository yet (`git init` is step 1 of Task 0).

## Post-Task-0 correction (read before starting Task 1)

Task 0's real in-browser verification (not assumed — actually run) found two upstream bugs in the originally-pinned versions above. Both are fixed and the fixes are already reflected in every code block in this plan file (you're reading the corrected version):

1. **`@ffmpeg/util` is pinned to `0.12.1`, not `0.12.2`.** The `0.12.2` UMD build throws `Uncaught ReferenceError: exports is not defined` in a browser (broken UMD wrapper). `0.12.1` works correctly and is otherwise API-compatible (`fetchFile`, `toBlobURL`).
2. **`ffmpeg.load()` requires a `Worker`-type-forcing workaround.** `@ffmpeg/ffmpeg@0.12.15`'s `load()` needs a `classWorkerURL` (a same-origin `blob:` URL, since `Worker()` rejects cross-origin script URLs outright) — but when `classWorkerURL` is supplied, the library hardcodes `new Worker(url, { type: "module" })`, which is incompatible with the classic-script UMD worker chunk (it calls `importScripts()`, unavailable in module workers) and fails with `Cannot find module '...'`. The verified fix, already used in `test-harness.html` and required in `js/frameExtractor.js` (Task 1): fetch `https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/814.ffmpeg.js` as a blob URL for `classWorkerURL`, and temporarily monkeypatch `window.Worker` to force `type: 'classic'` for the duration of the `ffmpeg.load()` call, restoring the original constructor in a `finally` block:

```js
const OrigWorker = window.Worker;
window.Worker = function (url, opts) {
  return new OrigWorker(url, Object.assign({}, opts, { type: 'classic' }));
};
window.Worker.prototype = OrigWorker.prototype;
try {
  const classWorkerURL = await FFmpegUtil.toBlobURL(
    'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/814.ffmpeg.js', 'text/javascript');
  await ffmpeg.load({ coreURL, wasmURL, classWorkerURL });
} finally {
  window.Worker = OrigWorker;
}
```

Task 1's `js/frameExtractor.js` code block below already includes this pattern.

## File Structure

Production files (deployed to Cloudflare Pages root):
```
index.html              - main app shell + UI
app.js                  - orchestrates the pipeline, wires UI to modules
manifest.json           - PWA manifest
sw.js                   - service worker (offline caching)
css/style.css           - mobile-first styles
js/logger.js            - ring-buffer debug logger (used by every other module)
js/frameExtractor.js    - ffmpeg.wasm video->frames
js/ocr.js               - Tesseract OCR + detection/dedup
js/pdfGenerator.js      - crop + jsPDF assembly
icons/icon-192.png      - PWA icon (generated once, committed as static asset)
icons/icon-512.png      - PWA icon (generated once, committed as static asset)
_headers                - Cloudflare Pages headers file (created only if needed; see Task 0)
test-harness.html       - CDN dependency smoke test (kept for on-device debugging)
test-phase1.html        - frame extraction test page
test-phase2.html        - OCR test page
test-phase3.html        - PDF generation test page
```

Dev/test-only files (not linked from `index.html`, harmless if deployed but not required):
```
fixtures/make-test-video.sh   - regenerates the synthetic 701/702/703 test video
fixtures/test-video.mp4       - committed synthetic test video (~25KB)
tools/check-cdn.js            - Node script, verifies CDN URLs return 200 (Task 0 verification)
tools/verify-phase3-pdf.js    - Node script, parses generated PDF with pdf-parse (Task 3 verification)
DIAGNOSTICS.md                - phase-by-phase test log (created in Task 0, appended every task)
TESTING.md                    - on-device testing guide for the user (written in Task 6)
```

---

### Task 0: Repo init, skeleton, and dependency verification

**Files:**
- Create: `index.html`, `app.js`, `manifest.json` (placeholder, filled in Task 5), `sw.js` (placeholder, filled in Task 5)
- Create: `test-harness.html`
- Create: `tools/check-cdn.js`
- Create: `DIAGNOSTICS.md`
- Create: `.gitignore`

**Interfaces:**
- Produces: the 4 pinned CDN `<script>` URLs (below) that every later task's HTML pages will reuse verbatim.

- [ ] **Step 1: Init git repo**

```bash
cd "c:\Users\Envy\Catalogue Price Web"
git init
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
*.log
```

- [ ] **Step 3: Create minimal `index.html` skeleton (filled in fully in Task 4)**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Shade Card Scanner</title>
<link rel="manifest" href="manifest.json">
</head>
<body>
<h1>Shade Card Scanner</h1>
<p>Under construction — see test-harness.html for dependency status.</p>
</body>
</html>
```

- [ ] **Step 4: Create empty `app.js`, `manifest.json`, `sw.js` placeholders**

`app.js`:
```js
// Filled in Task 4
```

`manifest.json`:
```json
{}
```

`sw.js`:
```js
// Filled in Task 5
```

- [ ] **Step 5: Create `test-harness.html`**

This page loads each CDN library and reports PASS/FAIL per library, on-screen and in console. This is the exact set of pinned URLs every other phase's test page reuses.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dependency Test Harness</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 1rem; }
  .pass { color: #0a7d2c; }
  .fail { color: #c0272d; }
  li { margin: 0.5rem 0; font-size: 1.1rem; }
</style>
</head>
<body>
<h1>Dependency Test Harness</h1>
<ul id="results"></ul>

<script src="https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js"></script>
<script src="https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js"></script>
<script src="https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js"></script>
<script src="https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js"></script>
<script>
const results = document.getElementById('results');

function report(name, ok, detail) {
  const li = document.createElement('li');
  li.className = ok ? 'pass' : 'fail';
  li.textContent = `${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ': ' + detail : ''}`;
  results.appendChild(li);
  console.log(`[test-harness] ${ok ? 'PASS' : 'FAIL'} ${name}`, detail || '');
}

function check(name, fn) {
  try {
    const ok = !!fn();
    report(name, ok, ok ? '' : 'value was falsy');
  } catch (e) {
    report(name, false, e.message);
  }
}

check('FFmpegWASM.FFmpeg', () => typeof FFmpegWASM !== 'undefined' && typeof FFmpegWASM.FFmpeg === 'function');
check('FFmpegUtil.fetchFile', () => typeof FFmpegUtil !== 'undefined' && typeof FFmpegUtil.fetchFile === 'function');
check('FFmpegUtil.toBlobURL', () => typeof FFmpegUtil !== 'undefined' && typeof FFmpegUtil.toBlobURL === 'function');
check('Tesseract.recognize', () => typeof Tesseract !== 'undefined' && typeof Tesseract.recognize === 'function');
check('jspdf.jsPDF', () => typeof jspdf !== 'undefined' && typeof jspdf.jsPDF === 'function');

// Also attempt to actually load the ffmpeg core, since that's the most likely runtime failure
(async () => {
  try {
    const ffmpeg = new FFmpegWASM.FFmpeg();
    const coreURL = await FFmpegUtil.toBlobURL('https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js', 'text/javascript');
    const wasmURL = await FFmpegUtil.toBlobURL('https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm', 'application/wasm');
    await ffmpeg.load({ coreURL, wasmURL });
    report('ffmpeg.load() single-thread core', true);
  } catch (e) {
    report('ffmpeg.load() single-thread core', false, e.message);
  }
})();
</script>
</body>
</html>
```

- [ ] **Step 6: Create `tools/check-cdn.js` — headless CDN reachability check**

```js
const urls = [
  'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js',
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js',
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm',
  'https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js',
  'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js',
  'https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js',
];

async function main() {
  let allOk = true;
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'GET' });
      const ct = res.headers.get('content-type') || '';
      const ok = res.status === 200;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${res.status} ${ct} ${url}`);
      if (!ok) allOk = false;
    } catch (e) {
      console.log(`FAIL ERR ${url}: ${e.message}`);
      allOk = false;
    }
  }
  process.exit(allOk ? 0 : 1);
}

main();
```

- [ ] **Step 7: Run the CDN check**

Run: `node tools/check-cdn.js`
Expected: 6 lines all starting `PASS 200`, exit code 0.

- [ ] **Step 8: Run test-harness.html in a real browser via Playwright**

Serve the directory (Python is available):
```bash
python -m http.server 8080
```
Then, in a separate step, use the `mcp__playwright__browser_navigate` tool to open `http://localhost:8080/test-harness.html`, then `mcp__playwright__browser_snapshot` (or `browser_console_messages`) to confirm all 6 checks report PASS, including the async `ffmpeg.load()` check (wait ~5-10s for the WASM download before snapshotting).

Expected: page shows 6 green PASS lines, no red FAIL lines, no uncaught console errors.

- [ ] **Step 9: If `ffmpeg.load()` fails, diagnose**

Most likely causes to check in order: (a) wasm content-type not `application/wasm` from unpkg — re-check with `curl -I`; (b) version mismatch between `@ffmpeg/ffmpeg` and `@ffmpeg/core` — check the ffmpeg.wasm GitHub releases page for the compatibility table for 0.12.x and adjust the pinned core version; (c) `toBlobURL` failing due to CORS — unpkg sends `Access-Control-Allow-Origin: *` so this is unlikely but verify with `curl -I` on the wasm URL. Log whichever it is, the fix, and re-run Step 8 until it passes.

- [ ] **Step 10: Create `DIAGNOSTICS.md` and log Phase 0 result**

```markdown
# DIAGNOSTICS

## Phase 0 — Skeleton + dependency verification

**Tested:** tools/check-cdn.js (headless CDN reachability), test-harness.html (in-browser library load, via Playwright against `python -m http.server 8080`).

**Decision on SharedArrayBuffer/COOP-COEP:** Using `@ffmpeg/core@0.12.10` (single-thread UMD build), which does NOT require `SharedArrayBuffer`. Cloudflare Pages does not send COOP/COEP headers by default, and multi-thread ffmpeg.wasm cores fail without them. No `_headers` file is required for this reason. (A `_headers` file may still be added later for cache-control tuning, but not for cross-origin isolation.)

**Result:** [PASS/FAIL — fill in after running Step 8]
**Failures found:** [none, or list with root cause + fix]
```

- [ ] **Step 11: Commit**

```bash
git add index.html app.js manifest.json sw.js test-harness.html tools/check-cdn.js DIAGNOSTICS.md .gitignore
git commit -m "Phase 0: skeleton + dependency verification"
```

---

### Task 1: Video → frames

**Files:**
- Create: `js/logger.js`
- Create: `js/frameExtractor.js`
- Create: `fixtures/make-test-video.sh`
- Create: `fixtures/test-video.mp4` (binary, generated by the script)
- Create: `test-phase1.html`
- Modify: `DIAGNOSTICS.md` (append Phase 1 section)

**Interfaces:**
- Consumes: `FFmpegWASM.FFmpeg`, `FFmpegUtil.fetchFile`, `FFmpegUtil.toBlobURL` globals (Task 0).
- Produces: `js/logger.js` exports `window.SCSLogger` with `.log(msg)`, `.getLines()` (array of last 100 entries), `.clear()` — used by every later module for the debug ring buffer.
- Produces: `js/frameExtractor.js` exports `window.extractFrames(file, {intervalSec, maxWidth, onProgress}) -> Promise<Array<{name, blob, url}>>`. `onProgress(current, total)` is called after each frame is extracted. Caller is responsible for calling `URL.revokeObjectURL(url)` on each frame when done (memory protocol).

- [ ] **Step 1: Create `js/logger.js` (ring buffer, needed by every module going forward)**

```js
window.SCSLogger = (function () {
  const MAX_LINES = 100;
  let lines = [];

  function log(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    lines.push(entry);
    if (lines.length > MAX_LINES) lines.shift();
    console.log(entry);
  }

  function getLines() {
    return lines.slice();
  }

  function clear() {
    lines = [];
  }

  return { log, getLines, clear };
})();
```

- [ ] **Step 2: Create `fixtures/make-test-video.sh` (reproducible synthetic test video generator)**

This uses the confirmed-working `@ffmpeg-installer/ffmpeg` binary. It takes the ffmpeg binary path as `$1` so it works on any machine.

```bash
#!/usr/bin/env bash
set -e
FF="${1:?Usage: make-test-video.sh <path-to-ffmpeg-binary>}"
OUT_DIR="$(dirname "$0")"
TMP="$OUT_DIR/.tmp-video-build"
mkdir -p "$TMP"

make_segment() {
  local color="$1" text="$2" out="$3"
  "$FF" -y -f lavfi -i "color=c=${color}:s=640x480:d=2:r=30" \
    -vf "drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='${text}':fontsize=200:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
    -pix_fmt yuv420p "$out"
}

make_segment blue  701 "$TMP/seg1.mp4"
make_segment green 702 "$TMP/seg2.mp4"
make_segment red   703 "$TMP/seg3.mp4"

printf "file '%s'\nfile '%s'\nfile '%s'\n" "$TMP/seg1.mp4" "$TMP/seg2.mp4" "$TMP/seg3.mp4" > "$TMP/concat.txt"
"$FF" -y -f concat -safe 0 -i "$TMP/concat.txt" -c copy "$OUT_DIR/test-video.mp4"

echo "Wrote $OUT_DIR/test-video.mp4"
"$FF" -i "$OUT_DIR/test-video.mp4" 2>&1 | grep Duration
```

- [ ] **Step 3: Run it to generate the fixture**

```bash
chmod +x fixtures/make-test-video.sh
mkdir -p /tmp/ffmpegtest_task1 && cd /tmp/ffmpegtest_task1 && npm init -y >/dev/null && npm install @ffmpeg-installer/ffmpeg --no-audit --no-fund
FF_BIN=$(node -e "console.log(require('@ffmpeg-installer/ffmpeg').path)")
cd "c:\Users\Envy\Catalogue Price Web"
bash fixtures/make-test-video.sh "$FF_BIN"
```
Expected: `fixtures/test-video.mp4` exists, `Duration: 00:00:06.00` printed.

- [ ] **Step 4: Node CLI proxy test — confirm extraction filter produces the expected frame count**

Since ffmpeg.wasm runs only in-browser, this CLI run is the headless proxy for the exact same filter graph the browser code will use.

```bash
mkdir -p /tmp/scs_frames_check && rm -f /tmp/scs_frames_check/*
"$FF_BIN" -y -i fixtures/test-video.mp4 -vf "fps=1/1.5,scale='min(960,iw)':-2" -q:v 3 /tmp/scs_frames_check/frame_%04d.jpg
ls /tmp/scs_frames_check | wc -l
```
Expected: `4` (confirmed already in pre-flight; this step re-confirms against the committed fixture).

- [ ] **Step 5: Create `js/frameExtractor.js`**

```js
window.extractFrames = async function extractFrames(file, opts = {}) {
  const { intervalSec = 1.5, maxWidth = 960, onProgress = () => {} } = opts;
  const log = window.SCSLogger.log;

  log(`extractFrames: loading ffmpeg core for file ${file.name} (${file.size} bytes)`);
  const ffmpeg = new FFmpegWASM.FFmpeg();
  ffmpeg.on('log', ({ message }) => log(`ffmpeg: ${message}`));

  const coreURL = await FFmpegUtil.toBlobURL(
    'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js', 'text/javascript');
  const wasmURL = await FFmpegUtil.toBlobURL(
    'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm', 'application/wasm');
  const classWorkerURL = await FFmpegUtil.toBlobURL(
    'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/814.ffmpeg.js', 'text/javascript');

  // Workaround for a confirmed bug in @ffmpeg/ffmpeg@0.12.15's UMD build (found
  // and verified in Task 0): when classWorkerURL is supplied, load() hardcodes
  // `new Worker(url, { type: "module" })`, but the UMD worker chunk is a classic
  // script that calls importScripts() — incompatible with module workers. Force
  // classic type for the duration of load(), then restore the real constructor.
  const OrigWorker = window.Worker;
  window.Worker = function (url, opts) {
    return new OrigWorker(url, Object.assign({}, opts, { type: 'classic' }));
  };
  window.Worker.prototype = OrigWorker.prototype;
  try {
    await ffmpeg.load({ coreURL, wasmURL, classWorkerURL });
  } finally {
    window.Worker = OrigWorker;
  }

  const ext = (file.name.match(/\.\w+$/) || ['.mp4'])[0];
  const inputName = `input${ext}`;
  await ffmpeg.writeFile(inputName, await FFmpegUtil.fetchFile(file));

  const fps = 1 / intervalSec;
  const outPattern = 'frame_%04d.jpg';
  log(`extractFrames: running fps=${fps},scale=min(${maxWidth},iw):-2`);
  await ffmpeg.exec(['-i', inputName, '-vf', `fps=${fps},scale='min(${maxWidth},iw)':-2`, '-q:v', '3', outPattern]);

  const dirEntries = await ffmpeg.listDir('/');
  const frameNames = dirEntries
    .filter(f => !f.isDir && f.name.startsWith('frame_') && f.name.endsWith('.jpg'))
    .map(f => f.name)
    .sort();

  log(`extractFrames: found ${frameNames.length} frames`);

  const frames = [];
  for (let i = 0; i < frameNames.length; i++) {
    const name = frameNames[i];
    const data = await ffmpeg.readFile(name);
    const blob = new Blob([data.buffer], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    frames.push({ name, blob, url });
    await ffmpeg.deleteFile(name);
    onProgress(i + 1, frameNames.length);
  }
  await ffmpeg.deleteFile(inputName);
  log(`extractFrames: done, ${frames.length} frames returned`);
  return frames;
};
```

- [ ] **Step 6: Create `test-phase1.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Phase 1 Test — Frame Extraction</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 1rem; }
  #thumbs img { width: 120px; margin: 4px; border: 1px solid #ccc; }
  #status { font-weight: bold; }
  .pass { color: #0a7d2c; } .fail { color: #c0272d; }
</style>
</head>
<body>
<h1>Phase 1 Test — Frame Extraction</h1>
<input type="file" id="fileInput" accept="video/*">
<p id="status">Pick a video file (or use fixtures/test-video.mp4)</p>
<div id="thumbs"></div>

<script src="https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js"></script>
<script src="https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js"></script>
<script src="js/logger.js"></script>
<script src="js/frameExtractor.js"></script>
<script>
document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('status');
  const thumbs = document.getElementById('thumbs');
  thumbs.innerHTML = '';
  status.textContent = 'Extracting...';
  status.className = '';
  try {
    const frames = await window.extractFrames(file, {
      onProgress: (cur, total) => { status.textContent = `Extracting frame ${cur}/${total}`; }
    });
    status.textContent = `PASS — ${frames.length} frames extracted`;
    status.className = 'pass';
    for (const f of frames) {
      const img = document.createElement('img');
      img.src = f.url;
      thumbs.appendChild(img);
    }
    window.__testFrameCount = frames.length; // for automated inspection
  } catch (err) {
    status.textContent = `FAIL — ${err.message}`;
    status.className = 'fail';
    console.error(err);
  }
});
</script>
</body>
</html>
```

- [ ] **Step 7: Run in-browser test via Playwright**

With `python -m http.server 8080` running from the project root, use `mcp__playwright__browser_navigate` to `http://localhost:8080/test-phase1.html`, then `mcp__playwright__browser_file_upload` to select `fixtures/test-video.mp4` into the file input, then wait (`browser_wait_for` on text "PASS" or "FAIL", timeout ~30s to allow WASM download+decode), then `browser_snapshot` to read the status text and confirm 4 thumbnails render.

Expected: status text `PASS — 4 frames extracted`, 4 `<img>` thumbnails visible, no console errors.

- [ ] **Step 8: If it fails, diagnose**

Check in order: (a) `listDir` API name mismatch for this ffmpeg.wasm version — if so, log the actual method name from `console.log(ffmpeg)` and fix; (b) scale filter syntax rejected by the wasm build — test the exact same `-vf` string with the CLI ffmpeg from Step 4, which is the proxy; if CLI passes but wasm fails, check for known 0.12.x filter differences in the ffmpeg.wasm issue tracker; (c) frame count off from CLI proxy — compare wasm's `fps` interpretation vs CLI. Fix, re-run Step 7, until PASS.

- [ ] **Step 9: Append Phase 1 result to `DIAGNOSTICS.md`**

```markdown
## Phase 1 — Video → frames

**Tested:**
- CLI proxy (`ffmpeg -vf "fps=1/1.5,scale='min(960,iw)':-2"` on fixtures/test-video.mp4) → 4 frames, confirms filter graph is correct.
- In-browser (test-phase1.html via Playwright, same filter graph run through ffmpeg.wasm) → [fill in actual result]

**Equivalence note:** ffmpeg.wasm 0.12.x wraps the same libavfilter as the CLI build, so the CLI run is a valid headless proxy for filter-graph correctness. The in-browser run is still required to catch WASM-specific issues (memory limits, API surface differences) that the CLI can't reveal.

**Result:** [PASS/FAIL]
**Failures found:** [none, or list with root cause + fix]
```

- [ ] **Step 10: Commit**

```bash
git add js/logger.js js/frameExtractor.js fixtures/ test-phase1.html DIAGNOSTICS.md
git commit -m "Phase 1: video to frames extraction"
```

---

### Task 2: OCR shade detection

**Files:**
- Create: `js/ocr.js`
- Create: `test-phase2.html`
- Modify: `DIAGNOSTICS.md` (append Phase 2 section)

**Interfaces:**
- Consumes: `window.extractFrames` (Task 1), `window.SCSLogger` (Task 1), `window.Tesseract` global (Task 0).
- Produces: `js/ocr.js` exports `window.detectShades(frames) -> Promise<Array<{number: string, frameIndex: number, confidence: number}>>` where `frames` is the array returned by `extractFrames`. Output is already deduplicated (consecutive-frame repeats collapsed to first occurrence) and confidence-filtered. Later tasks (Task 3) consume the `number` and `frameIndex` fields — `frameIndex` indexes back into the original `frames` array so the swatch crop knows which frame to use.

- [ ] **Step 1: Node proxy test — confirm the OCR config against the Phase 1 fixture frames**

This validates the exact Tesseract config (whitelist + PSM11 + regex + threshold) before it's wired into browser code. Already run once during plan pre-flight with this result: `701(83), 702(87), 702(87,dup), 703(94)` — this step reproduces it as a committed, re-runnable test.

```bash
mkdir -p /tmp/scs_ocr_check && cd /tmp/scs_ocr_check
npm init -y >/dev/null 2>&1
npm install tesseract.js@5.1.1 --no-audit --no-fund
cp /tmp/scs_frames_check/*.jpg frames_input/ 2>/dev/null || (mkdir frames_input && cp /tmp/scs_frames_check/*.jpg frames_input/)
```

```js
// ocrproxy.js
const Tesseract = require('tesseract.js');
const fs = require('fs');
async function run() {
  const files = fs.readdirSync('frames_input').filter(f => f.endsWith('.jpg')).sort();
  const found = [];
  for (const f of files) {
    const { data } = await Tesseract.recognize(`frames_input/${f}`, 'eng', {
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '11',
    });
    const matches = (data.text.match(/\b[1-9]\d{2}\b/g) || []);
    console.log(f, 'conf=', data.confidence, 'matches=', matches);
    if (data.confidence >= 70) found.push(...matches);
  }
  const deduped = [];
  for (const n of found) if (deduped[deduped.length - 1] !== n) deduped.push(n);
  console.log('FINAL:', JSON.stringify(deduped));
  process.exit(JSON.stringify(deduped) === JSON.stringify(['701','702','703']) ? 0 : 1);
}
run();
```

Run: `node ocrproxy.js`
Expected: `FINAL: ["701","702","703"]`, exit code 0.

- [ ] **Step 2: Create `js/ocr.js`**

```js
window.detectShades = async function detectShades(frames) {
  const log = window.SCSLogger.log;
  const results = [];
  let lastNumber = null;

  for (let i = 0; i < frames.length; i++) {
    log(`OCR: frame ${i + 1}/${frames.length}`);
    let data;
    try {
      const res = await Tesseract.recognize(frames[i].blob, 'eng', {
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: '11',
      });
      data = res.data;
    } catch (err) {
      log(`OCR: frame ${i + 1} failed: ${err.message}`);
      continue;
    }

    if (data.confidence < 70) {
      log(`OCR: frame ${i + 1} confidence ${data.confidence} below threshold, skipped`);
      lastNumber = null; // a low-confidence frame breaks "consecutive" runs
      continue;
    }

    const matches = data.text.match(/\b[1-9]\d{2}\b/g) || [];
    if (matches.length === 0) {
      lastNumber = null;
      continue;
    }

    const number = matches[0];
    if (number === lastNumber) {
      log(`OCR: frame ${i + 1} matched ${number}, duplicate of previous frame, skipped`);
    } else {
      log(`OCR: frame ${i + 1} matched ${number}, confidence ${data.confidence}`);
      results.push({ number, frameIndex: i, confidence: data.confidence });
    }
    lastNumber = number;
  }

  log(`OCR: done, ${results.length} unique shades detected`);
  return results;
};
```

- [ ] **Step 3: Create `test-phase2.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Phase 2 Test — OCR</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 1rem; }
  #status { font-weight: bold; }
  .pass { color: #0a7d2c; } .fail { color: #c0272d; }
  li { font-family: monospace; }
</style>
</head>
<body>
<h1>Phase 2 Test — OCR</h1>
<input type="file" id="fileInput" accept="video/*">
<p id="status">Pick fixtures/test-video.mp4</p>
<ul id="results"></ul>

<script src="https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js"></script>
<script src="https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js"></script>
<script src="https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js"></script>
<script src="js/logger.js"></script>
<script src="js/frameExtractor.js"></script>
<script src="js/ocr.js"></script>
<script>
document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('status');
  const list = document.getElementById('results');
  list.innerHTML = '';
  status.textContent = 'Extracting frames...';
  try {
    const frames = await window.extractFrames(file);
    status.textContent = 'Running OCR...';
    const shades = await window.detectShades(frames);
    const numbers = shades.map(s => s.number);
    const expected = JSON.stringify(['701', '702', '703']);
    const ok = JSON.stringify(numbers) === expected;
    status.textContent = `${ok ? 'PASS' : 'FAIL'} — detected [${numbers.join(', ')}]`;
    status.className = ok ? 'pass' : 'fail';
    for (const s of shades) {
      const li = document.createElement('li');
      li.textContent = `${s.number} (frame ${s.frameIndex}, confidence ${s.confidence.toFixed(1)})`;
      list.appendChild(li);
    }
    window.__testShades = shades;
  } catch (err) {
    status.textContent = `FAIL — ${err.message}`;
    status.className = 'fail';
    console.error(err);
  }
});
</script>
</body>
</html>
```

- [ ] **Step 4: Run in-browser test via Playwright**

Navigate to `http://localhost:8080/test-phase2.html`, upload `fixtures/test-video.mp4`, wait for status text matching `PASS` or `FAIL` (timeout ~45s — OCR is slow), snapshot.

Expected: `PASS — detected [701, 702, 703]`.

- [ ] **Step 5: If it fails, diagnose**

If the browser result differs from the Node proxy result from Step 1: (a) check `Tesseract.recognize` is being passed a `Blob` correctly (browser API) vs a file path (Node) — Tesseract.js supports both but confirm no silent failure; (b) check worker script loading — Tesseract.js in-browser needs to fetch its worker/lang-data from CDN too, confirm those requests succeed in `browser_network_requests`; (c) if confidence scores differ from the Node proxy, the JPEG re-encoding through ffmpeg.wasm may differ slightly from the CLI proxy — inspect a thumbnail from test-phase1.html to confirm frames look identical. Fix, re-run Step 4 until PASS.

- [ ] **Step 6: Append Phase 2 result to `DIAGNOSTICS.md`**

```markdown
## Phase 2 — OCR shade detection

**Tested:**
- Node proxy (tesseract.js@5.1.1 against CLI-extracted fixture frames, same whitelist/PSM11/regex/threshold config) → [701, 702, 703], exit 0.
- In-browser (test-phase2.html via Playwright, full extractFrames -> detectShades pipeline against fixtures/test-video.mp4) → [fill in actual result]

**Result:** [PASS/FAIL]
**Failures found:** [none, or list with root cause + fix]
```

- [ ] **Step 7: Commit**

```bash
git add js/ocr.js test-phase2.html DIAGNOSTICS.md
git commit -m "Phase 2: OCR shade detection"
```

---

### Task 3: Swatch crop + PDF generation

**Files:**
- Create: `js/pdfGenerator.js`
- Create: `test-phase3.html`
- Create: `tools/verify-phase3-pdf.js`
- Modify: `DIAGNOSTICS.md` (append Phase 3 section)

**Interfaces:**
- Consumes: `frames` array (Task 1) and `shades` array (Task 2, each `{number, frameIndex, confidence}`).
- Produces: `js/pdfGenerator.js` exports `window.generateShadeCardPDF(frames, shades) -> Promise<{blob: Blob, filename: string, base64: string}>`. The `base64` field exists specifically so the Playwright test can pull the PDF bytes out of the browser without dealing with download-handling — later reused by Task 4's UI as a normal blob download.

- [ ] **Step 1: Install pdf-parse for verification tooling**

```bash
cd "c:\Users\Envy\Catalogue Price Web"
npm init -y
npm install --save-dev pdf-parse
```

- [ ] **Step 2: Create `js/pdfGenerator.js`**

```js
window.generateShadeCardPDF = async function generateShadeCardPDF(frames, shades) {
  const log = window.SCSLogger.log;
  const { jsPDF } = jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  const pageWidth = 210, pageHeight = 297, margin = 15;
  const colWidth = (pageWidth - margin * 2) / 2;
  const rowHeight = 60;
  const swatchSize = 40;

  let col = 0, row = 0;

  for (let i = 0; i < shades.length; i++) {
    const shade = shades[i];
    const frame = frames[shade.frameIndex];
    log(`PDF: adding shade ${shade.number} (${i + 1}/${shades.length})`);

    const cropDataUrl = await cropCenter(frame.url, 0.6);

    const x = margin + col * colWidth;
    const y = margin + row * rowHeight;
    doc.addImage(cropDataUrl, 'JPEG', x, y, swatchSize, swatchSize);
    doc.setFontSize(14);
    doc.text(shade.number, x + swatchSize + 5, y + swatchSize / 2);

    col++;
    if (col >= 2) { col = 0; row++; }
    if (margin + (row + 1) * rowHeight > pageHeight - margin && (col !== 0 || i < shades.length - 1)) {
      if (col === 0) { doc.addPage(); row = 0; }
    }
  }

  const filename = `ShadeCard_${Date.now()}.pdf`;
  const blob = doc.output('blob');
  const base64 = doc.output('datauristring').split(',')[1];
  log(`PDF: generated ${filename}, ${blob.size} bytes`);
  return { blob, filename, base64 };
};

function cropCenter(imageUrl, fraction) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cropW = img.width * fraction;
      const cropH = img.height * fraction;
      const sx = (img.width - cropW) / 2;
      const sy = (img.height - cropH) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = cropW;
      canvas.height = cropH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
      canvas.width = 0; canvas.height = 0; // release
    };
    img.onerror = reject;
    img.src = imageUrl;
  });
}
```

- [ ] **Step 3: Create `test-phase3.html`**

This page runs the full extract → OCR → PDF pipeline and prints the PDF's base64 to the page in a `<textarea>` (so Playwright can read it out via `browser_evaluate` or snapshot text), plus offers a normal download link for manual testing.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Phase 3 Test — PDF Generation</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 1rem; }
  #status { font-weight: bold; }
  .pass { color: #0a7d2c; } .fail { color: #c0272d; }
</style>
</head>
<body>
<h1>Phase 3 Test — PDF Generation</h1>
<input type="file" id="fileInput" accept="video/*">
<p id="status">Pick fixtures/test-video.mp4</p>
<a id="downloadLink" style="display:none">Download PDF</a>
<textarea id="base64Out" style="display:none"></textarea>

<script src="https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js"></script>
<script src="https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js"></script>
<script src="https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js"></script>
<script src="https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js"></script>
<script src="js/logger.js"></script>
<script src="js/frameExtractor.js"></script>
<script src="js/ocr.js"></script>
<script src="js/pdfGenerator.js"></script>
<script>
document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('status');
  status.textContent = 'Extracting frames...';
  try {
    const frames = await window.extractFrames(file);
    status.textContent = 'Running OCR...';
    const shades = await window.detectShades(frames);
    status.textContent = 'Building PDF...';
    const { blob, filename, base64 } = await window.generateShadeCardPDF(frames, shades);

    const link = document.getElementById('downloadLink');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.textContent = `Download ${filename}`;
    link.style.display = 'block';

    const out = document.getElementById('base64Out');
    out.value = base64;
    out.style.display = 'block';

    status.textContent = `PASS — PDF built with ${shades.length} shades: [${shades.map(s => s.number).join(', ')}]`;
    status.className = 'pass';
    window.__testPdfBase64 = base64;
    window.__testShadeNumbers = shades.map(s => s.number);
  } catch (err) {
    status.textContent = `FAIL — ${err.message}`;
    status.className = 'fail';
    console.error(err);
  }
});
</script>
</body>
</html>
```

- [ ] **Step 4: Create `tools/verify-phase3-pdf.js` — Node PDF structural verification**

```js
const fs = require('fs');
const pdfParse = require('pdf-parse');

async function main() {
  const base64Path = process.argv[2];
  if (!base64Path) {
    console.error('Usage: node verify-phase3-pdf.js <path-to-base64-txt>');
    process.exit(1);
  }
  const base64 = fs.readFileSync(base64Path, 'utf8').trim();
  const buffer = Buffer.from(base64, 'base64');
  const outPath = base64Path.replace(/\.txt$/, '.pdf');
  fs.writeFileSync(outPath, buffer);

  const data = await pdfParse(buffer);
  console.log('Pages:', data.numpages);
  console.log('Text:', JSON.stringify(data.text));

  const expected = ['701', '702', '703'];
  const missing = expected.filter(n => !data.text.includes(n));

  if (data.numpages < 1) { console.error('FAIL: no pages'); process.exit(1); }
  if (missing.length > 0) { console.error('FAIL: missing labels', missing); process.exit(1); }

  console.log('PASS: PDF is valid, contains labels', expected);
  process.exit(0);
}

main();
```

- [ ] **Step 5: Run in-browser via Playwright, then verify with Node**

Navigate to `http://localhost:8080/test-phase3.html`, upload `fixtures/test-video.mp4`, wait for status `PASS`/`FAIL` (timeout ~45s), then use `mcp__playwright__browser_evaluate` to read `document.getElementById('base64Out').value` and write it to a local file (e.g. via the evaluate return value captured by the harness, then `Write` tool to save it as `/tmp/phase3-out.txt`).

Run: `node tools/verify-phase3-pdf.js /tmp/phase3-out.txt`
Expected: `Pages: 1` (or more), text contains `701`, `702`, `703`, exit code 0.

Also confirm the PDF contains 3 images: `pdf-parse` doesn't report image count directly, so additionally check `buffer.toString('latin1').match(/\/Subtype\s*\/Image/g).length >= 3` in the same script as a supplementary assertion.

- [ ] **Step 6: If it fails, diagnose**

Check in order: (a) `doc.addImage` with a data URL from canvas — confirm the JPEG data URL is well-formed by logging its length/prefix; (b) crop math producing 0-size canvas if frame image hasn't finished loading — confirm `img.onload` fires before crop runs; (c) pdf-parse not finding text if jsPDF embeds it as a font subset in a way pdf-parse's default text extraction misses — if so, switch jsPDF to a standard font (`doc.setFont('helvetica')`) explicitly. Fix, re-run Step 5 until PASS.

- [ ] **Step 7: Append Phase 3 result to `DIAGNOSTICS.md`**

```markdown
## Phase 3 — Swatch crop + PDF generation

**Tested:** test-phase3.html run via Playwright against fixtures/test-video.mp4, full pipeline through PDF. Resulting PDF base64 extracted from the page, decoded to a real .pdf file, and parsed with `pdf-parse` via tools/verify-phase3-pdf.js.

**Result:** [PASS/FAIL]
**Page count:** [n], **Labels found:** [701, 702, 703], **Image count:** [n]
**Failures found:** [none, or list with root cause + fix]
```

- [ ] **Step 8: Commit**

```bash
git add js/pdfGenerator.js test-phase3.html tools/verify-phase3-pdf.js package.json DIAGNOSTICS.md
git commit -m "Phase 3: swatch crop + PDF generation"
```

---

### Task 4: Full pipeline UI

**Files:**
- Modify: `index.html` (full rewrite)
- Modify: `app.js` (full implementation)
- Create: `css/style.css`
- Modify: `DIAGNOSTICS.md` (append Phase 4 section)

**Interfaces:**
- Consumes: `extractFrames`, `detectShades`, `generateShadeCardPDF`, `SCSLogger` (Tasks 1-3).
- Produces: nothing new consumed by later tasks except the DOM structure Task 5's service worker cache list depends on (exact filenames below).

- [ ] **Step 1: Create `css/style.css`**

```css
:root {
  --bg: #1a1a2e;
  --accent: #e94560;
  --text: #f1f1f1;
  --card-bg: #16213e;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  padding: 1rem;
}
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
button {
  display: block;
  width: 100%;
  padding: 1rem;
  font-size: 1.1rem;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: white;
  margin: 0.5rem 0;
}
button:disabled { opacity: 0.5; }
#status {
  background: var(--card-bg);
  padding: 0.75rem;
  border-radius: 8px;
  margin: 0.5rem 0;
  min-height: 1.5em;
}
#progressBar {
  width: 100%; height: 8px; background: #333; border-radius: 4px; overflow: hidden; margin: 0.5rem 0;
}
#progressFill { height: 100%; width: 0%; background: var(--accent); transition: width 0.2s; }
#swatchGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 8px;
  margin: 1rem 0;
}
.swatch { background: var(--card-bg); border-radius: 8px; padding: 4px; text-align: center; }
.swatch img { width: 100%; border-radius: 4px; }
.swatch .num { font-size: 0.9rem; margin-top: 4px; }
#errorBanner {
  display: none;
  background: #c0272d;
  color: white;
  padding: 1rem;
  border-radius: 8px;
  margin: 0.5rem 0;
}
#errorBanner button { background: white; color: #c0272d; }
```

- [ ] **Step 2: Rewrite `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#1a1a2e">
<title>Shade Card Scanner</title>
<link rel="manifest" href="manifest.json">
<link rel="icon" href="icons/icon-192.png">
<link rel="stylesheet" href="css/style.css">
</head>
<body>
<h1>Shade Card Scanner</h1>

<input type="file" id="videoInput" accept="video/*" style="display:none">
<button id="pickBtn">Select Fabric Video</button>

<div id="progressBar"><div id="progressFill"></div></div>
<div id="status">Pick a video to begin.</div>

<div id="swatchGrid"></div>

<button id="downloadBtn" style="display:none">Download PDF</button>

<div id="errorBanner">
  <p id="errorText"></p>
  <button id="copyLogBtn">Copy debug log</button>
</div>

<script src="https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js"></script>
<script src="https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js"></script>
<script src="https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js"></script>
<script src="https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js"></script>
<script src="js/logger.js"></script>
<script src="js/frameExtractor.js"></script>
<script src="js/ocr.js"></script>
<script src="js/pdfGenerator.js"></script>
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Implement `app.js`**

```js
const log = window.SCSLogger.log;

const pickBtn = document.getElementById('pickBtn');
const videoInput = document.getElementById('videoInput');
const status = document.getElementById('status');
const progressFill = document.getElementById('progressFill');
const swatchGrid = document.getElementById('swatchGrid');
const downloadBtn = document.getElementById('downloadBtn');
const errorBanner = document.getElementById('errorBanner');
const errorText = document.getElementById('errorText');
const copyLogBtn = document.getElementById('copyLogBtn');

const MAX_VIDEO_SECONDS = 5 * 60;
let currentFrameUrls = [];
let pdfResult = null;

pickBtn.addEventListener('click', () => videoInput.click());

copyLogBtn.addEventListener('click', async () => {
  const text = window.SCSLogger.getLines().join('\n');
  try {
    await navigator.clipboard.writeText(text);
    copyLogBtn.textContent = 'Copied!';
    setTimeout(() => { copyLogBtn.textContent = 'Copy debug log'; }, 2000);
  } catch (e) {
    log(`Clipboard copy failed: ${e.message}`);
  }
});

function showError(message) {
  log(`ERROR: ${message}`);
  errorText.textContent = message;
  errorBanner.style.display = 'block';
}

function hideError() {
  errorBanner.style.display = 'none';
}

function setProgress(pct) {
  progressFill.style.width = `${pct}%`;
}

function releaseFrames() {
  for (const url of currentFrameUrls) URL.revokeObjectURL(url);
  currentFrameUrls = [];
}

function renderSwatches(frames, shades) {
  swatchGrid.innerHTML = '';
  for (const shade of shades) {
    const frame = frames[shade.frameIndex];
    const div = document.createElement('div');
    div.className = 'swatch';
    const img = document.createElement('img');
    img.src = frame.url;
    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = shade.number;
    div.appendChild(img);
    div.appendChild(num);
    swatchGrid.appendChild(div);
  }
}

function checkVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const videoEl = document.createElement('video');
    videoEl.preload = 'metadata';
    videoEl.onloadedmetadata = () => {
      URL.revokeObjectURL(videoEl.src);
      resolve(videoEl.duration);
    };
    videoEl.onerror = () => reject(new Error('Could not read video metadata — is this a valid video file?'));
    videoEl.src = URL.createObjectURL(file);
  });
}

videoInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  hideError();
  releaseFrames();
  swatchGrid.innerHTML = '';
  downloadBtn.style.display = 'none';
  pdfResult = null;
  setProgress(0);
  pickBtn.disabled = true;

  try {
    if (!file.type.startsWith('video/')) {
      throw new Error(`Selected file is "${file.type || 'unknown type'}", not a video. Please pick a video file.`);
    }

    let duration;
    try {
      duration = await checkVideoDuration(file);
    } catch (err) {
      throw new Error(`This doesn't look like a playable video: ${err.message}`);
    }
    if (duration > MAX_VIDEO_SECONDS) {
      throw new Error(`Video is ${(duration / 60).toFixed(1)} minutes long. Please use a video under 5 minutes to avoid running out of memory on this device.`);
    }

    status.textContent = 'Extracting frames...';
    const frames = await window.extractFrames(file, {
      onProgress: (cur, total) => {
        status.textContent = `Extracting frames ${cur}/${total}`;
        setProgress((cur / total) * 40);
      }
    });
    currentFrameUrls = frames.map(f => f.url);

    status.textContent = `OCR: frame 1/${frames.length}...`;
    const originalLog = log;
    let ocrDone = 0;
    const shades = await window.detectShades(frames);
    // detectShades logs its own progress via SCSLogger; mirror coarse progress here
    setProgress(80);

    if (shades.length === 0) {
      status.textContent = 'No shade numbers were detected in this video. Try a clearer, closer, well-lit recording of the shade cards.';
      pickBtn.disabled = false;
      return;
    }

    renderSwatches(frames, shades);
    status.textContent = 'Building PDF...';
    pdfResult = await window.generateShadeCardPDF(frames, shades);
    setProgress(100);

    status.textContent = `Done — ${shades.length} shades found: ${shades.map(s => s.number).join(', ')}`;
    downloadBtn.style.display = 'block';
  } catch (err) {
    showError(err.message || String(err));
    status.textContent = 'Failed. See error above.';
  } finally {
    pickBtn.disabled = false;
    videoInput.value = '';
  }
});

downloadBtn.addEventListener('click', () => {
  if (!pdfResult) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(pdfResult.blob);
  a.download = pdfResult.filename;
  a.click();
  URL.revokeObjectURL(a.href);
});
```

- [ ] **Step 4: E2E Playwright test against the real UI**

Navigate to `http://localhost:8080/index.html`, use `browser_file_upload` on the (now-visible-via-JS-click) `#videoInput` with `fixtures/test-video.mp4`, wait for status text containing `Done —` (timeout ~45s), snapshot to confirm: 3 swatch tiles in `#swatchGrid` with labels 701/702/703, `#downloadBtn` visible, `#errorBanner` NOT visible.

Then click `#downloadBtn` and confirm (via `browser_network_requests` or a click-triggered blob URL check) that a download was initiated — or, simpler, re-use the same base64-extraction trick as Task 3 by temporarily exposing `pdfResult.base64` on `window` for the test to read, then run `tools/verify-phase3-pdf.js` against it again as the final end-to-end assertion.

- [ ] **Step 5: If it fails, diagnose**

Common failure points at integration time: (a) `detectShades`'s internal per-frame progress not reflected in UI — acceptable, UI only needs coarse progress per the spec's example strings ("OCR frame 3..."); if the test expects finer-grained text, adjust `js/ocr.js` to accept an `onProgress` callback and thread it through (mirrors `extractFrames`'s pattern) — only do this if Step 4 actually requires it, don't over-build; (b) error banner not resetting between runs — confirm `hideError()` is called at the top of the change handler; (c) `videoInput.value = ''` in `finally` preventing re-selecting the same file for a second test run — this is correct behavior, note it in DIAGNOSTICS rather than "fixing" it away.

- [ ] **Step 6: Append Phase 4 result to `DIAGNOSTICS.md`**

```markdown
## Phase 4 — Full pipeline UI

**Tested:** index.html end-to-end via Playwright against fixtures/test-video.mp4 — file select, progress text, swatch grid rendering, PDF download trigger, verified with tools/verify-phase3-pdf.js against the resulting PDF.

**Result:** [PASS/FAIL]
**Failures found:** [none, or list with root cause + fix]
```

- [ ] **Step 7: Commit**

```bash
git add index.html app.js css/style.css DIAGNOSTICS.md
git commit -m "Phase 4: full pipeline UI"
```

---

### Task 5: PWA layer

**Files:**
- Create: `tools/generate-icons.js`
- Create: `icons/icon-192.png`, `icons/icon-512.png` (generated binaries)
- Modify: `manifest.json`
- Modify: `sw.js`
- Modify: `index.html` (add SW registration)
- Modify: `DIAGNOSTICS.md` (append Phase 5 section)

**Interfaces:**
- Consumes: the exact file list from Tasks 0-4 (every local asset must be enumerated in `sw.js`'s cache list).
- Produces: nothing consumed by later tasks (this is the last functional layer before the adversarial review).

- [ ] **Step 1: Generate icons using Node's `canvas` package (already verified installable in pre-flight)**

```bash
cd "c:\Users\Envy\Catalogue Price Web"
npm install --save-dev canvas
```

`tools/generate-icons.js`:
```js
const { createCanvas } = require('canvas');
const fs = require('fs');

function makeIcon(size, outPath) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#e94560';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f1f1f1';
  ctx.font = `bold ${size * 0.28}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SC', size / 2, size / 2);
  fs.mkdirSync('icons', { recursive: true });
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  console.log(`Wrote ${outPath} (${size}x${size})`);
}

makeIcon(192, 'icons/icon-192.png');
makeIcon(512, 'icons/icon-512.png');
```

Run: `node tools/generate-icons.js`
Expected: `icons/icon-192.png` and `icons/icon-512.png` exist.

Verify: `node -e "const fs=require('fs'); ['icons/icon-192.png','icons/icon-512.png'].forEach(f => { const s = fs.statSync(f); if (s.size < 100) throw new Error(f + ' too small'); console.log(f, s.size, 'bytes OK'); })"`

- [ ] **Step 2: Write `manifest.json`**

```json
{
  "name": "Shade Card Scanner",
  "short_name": "ShadeCard",
  "description": "Scan a fabric flip-through video and generate a shade number PDF card.",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#1a1a2e",
  "theme_color": "#1a1a2e",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

Verify it's valid JSON: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('valid JSON')"`

- [ ] **Step 3: Write `sw.js`**

Caches local assets and the pinned CDN URLs for offline use.

```js
const CACHE_NAME = 'shade-card-scanner-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './css/style.css',
  './js/logger.js',
  './js/frameExtractor.js',
  './js/ocr.js',
  './js/pdfGenerator.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js',
  'https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js',
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js',
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm',
  'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js',
  'https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS.map((url) =>
        cache.add(url).catch((err) => console.warn('SW cache failed for', url, err))
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
```

- [ ] **Step 4: Register the service worker in `index.html`**

Add before the closing `</body>`, after `app.js`:
```html
<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(
      () => window.SCSLogger.log('Service worker registered'),
      (err) => window.SCSLogger.log(`Service worker registration failed: ${err.message}`)
    );
  });
}
</script>
```

- [ ] **Step 5: Verify via Playwright — manifest, SW registration, offline reload**

1. Navigate to `http://localhost:8080/index.html`.
2. `browser_evaluate`: `fetch('./manifest.json').then(r => r.json())` — confirm it parses and has `name`, `icons`.
3. `browser_evaluate`: `navigator.serviceWorker.getRegistration().then(r => !!r)` — confirm truthy (wait a couple seconds after load first).
4. `browser_evaluate`: `caches.open('shade-card-scanner-v1').then(c => c.keys()).then(keys => keys.length)` — confirm it matches the `ASSETS` count (18).
5. Use `mcp__playwright__browser_network_request` or the browser's offline emulation (if exposed by the Playwright MCP tools; otherwise set `navigator.serviceWorker` cache-only by killing the http server process, then reload the page) — confirm the page still renders (title "Shade Card Scanner" visible) with the server stopped.

Expected: manifest parses, SW registered, all 18 assets cached, page renders after the local server is killed (proving it's served from cache, not network).

- [ ] **Step 6: If it fails, diagnose**

Check in order: (a) opaque cross-origin responses from unpkg — `cache.add()` on a cross-origin URL can fail silently or store an opaque response; if offline reload fails specifically on a CDN-sourced script, verify with `response.type === 'opaque'` and confirm opaque responses are still usable from cache (they are, for `<script src>` purposes) — if `cache.add()` itself throws, switch to manual `fetch(url, {mode: 'no-cors'})` + `cache.put()`; (b) `start_url` mismatch causing SW scope issues — confirm `sw.js` is served from the root so its scope covers everything; (c) stale cache from a previous SW version during iteration — bump `CACHE_NAME` and hard-reload. Fix, re-run Step 5 until PASS.

- [ ] **Step 7: Append Phase 5 result to `DIAGNOSTICS.md`**

```markdown
## Phase 5 — PWA layer

**Tested:** manifest.json JSON-validity (Node), icon file generation (Node, size sanity check), and in-browser via Playwright: SW registration, cache population (18 assets), and page render after the dev server was killed (offline proxy — see note below).

**Note on Lighthouse:** No Lighthouse CLI is available in this environment; the offline-reload-after-server-kill check is used as the closest equivalent to Lighthouse's offline audit. Recommend the user also runs a real Lighthouse PWA audit from Chrome DevTools once deployed to Cloudflare Pages, documented in TESTING.md.

**Result:** [PASS/FAIL]
**Failures found:** [none, or list with root cause + fix]
```

- [ ] **Step 8: Commit**

```bash
git add manifest.json sw.js index.html icons/ tools/generate-icons.js package.json DIAGNOSTICS.md
git commit -m "Phase 5: PWA layer (manifest, service worker, icons)"
```

---

### Task 6: Adversarial self-review and final deliverables

**Files:**
- Modify: `app.js`, `js/ocr.js`, `js/frameExtractor.js` (fixes from review findings)
- Create: `TESTING.md`
- Create: `_headers` (only if a finding requires it — see Step 1f)
- Modify: `DIAGNOSTICS.md` (append Phase 6 section)

**Interfaces:**
- Consumes: everything from Tasks 0-5.
- Produces: final deliverables listed at the end of this plan.

- [ ] **Step 1: Work through each adversarial check, fix what's broken, and note what's a documented limitation**

**(a) iOS Safari memory limits with ffmpeg.wasm.** This cannot be tested in this environment (no iOS device/simulator, and the spec targets Android Chrome primarily). Action: document as a known limitation rather than silently ignoring it. Add a comment block at the top of `js/frameExtractor.js`:
```js
// KNOWN LIMITATION: iOS Safari (all browsers on iOS use WebKit) has historically
// killed WASM-heavy tabs around 300-400MB memory use. ffmpeg.wasm decoding long
// or high-resolution videos can hit this. This app targets Android Chrome per spec;
// iOS users should keep videos short (well under the 5-minute cap enforced in app.js)
// and close other tabs. Not fixable from JS — no graceful recovery from a WebKit tab kill.
```
Also add this note to `TESTING.md` (Step 4 below).

**(b) User selects a photo instead of a video.** Already handled in `app.js` Step 3 (Task 4) via `if (!file.type.startsWith('video/'))`. Verify this actually fires: use Playwright to upload a non-video file (e.g. reuse `icons/icon-192.png` as the "wrong file" test input) via `browser_file_upload` on `#videoInput`, confirm the error banner shows text mentioning "not a video".

**(c) Zero shades detected.** Already handled in `app.js` (the `if (shades.length === 0)` branch) — but verify it's a friendly message, not a blank screen, and that it doesn't also show the (incorrect) success download button. Check: `downloadBtn.style.display` must stay `'none'` in this branch — confirm this in the code (it does, since `downloadBtn.style.display = 'block'` only runs after the zero-shades early return). Test with a synthetic blank/black video:
```bash
"$FF_BIN" -y -f lavfi -i "color=c=black:s=640x480:d=3:r=30" -pix_fmt yuv420p /tmp/blank-video.mp4
```
Upload via Playwright, confirm status text is the friendly "No shade numbers were detected..." message and no error banner appears (this is a soft "nothing found" case, not a hard error).

**(d) Duplicate shade numbers in non-consecutive frames (e.g., 701 reappears at the end).** By design (per the spec's explicit dedup rule: "same number in consecutive frames → keep first occurrence only"), non-consecutive repeats are NOT deduped — each occurrence is treated as a separate detected shade and will appear twice in the PDF. This is the correct, spec-compliant behavior (a real flip-through might legitimately revisit a shade, or the user filmed two different physical cards with the same number range). Document this explicitly rather than silently "fixing" it into a behavior the spec didn't ask for:
```markdown
### Duplicate handling policy
Only *consecutive*-frame duplicates are deduped (per spec). If shade 701 appears at
frame 2 and again at frame 40 (non-consecutive), both are kept as separate entries in
the output. Rationale: the spec explicitly scopes dedup to consecutive frames only,
and collapsing all-time duplicates could silently drop a genuinely re-scanned or
re-shot shade. If this is undesired in practice, the fix is a one-line change in
js/ocr.js: track a `Set` of all seen numbers instead of just `lastNumber`.
```
Add this to `DIAGNOSTICS.md` Phase 6 section, not as a code change.

**(e) Pale/ivory fabric frames where OCR confidence is low.** The confidence >= 70 skip logic already exists in `js/ocr.js`. Verify it with a synthetic low-contrast frame (white text on near-white background):
```bash
"$FF_BIN" -y -f lavfi -i "color=c=0xF5F5F0:s=640x480:d=2:r=30" -vf "drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='999':fontsize=200:fontcolor=0xFFFFF0:x=(w-text_w)/2:y=(h-text_h)/2" -pix_fmt yuv420p /tmp/lowcontrast.mp4
```
Run through the Node OCR proxy pattern from Task 2 Step 1 (or directly via test-phase2.html) and confirm either (i) confidence is reported below 70 and the frame is skipped, or (ii) if Tesseract's confidence happens to stay high despite low contrast, this is noted as a real limitation of confidence-based filtering (OCR confidence reflects glyph-shape certainty, not human-perceived contrast) — do not force a fake failure to satisfy the spec if the actual behavior is reasonable.

**(f) CDN down / offline on first visit (before SW has cached anything).** Verify: with the dev server running, block requests to `unpkg.com` (Playwright can do this via route interception if available in the MCP tools; otherwise simulate by temporarily pointing one `<script src>` at a deliberately broken URL in a throwaway copy of `index.html`) and confirm the page doesn't just hang silently. Since library loads happen via blocking `<script>` tags before `app.js` runs, a CDN failure here means `app.js` never executes and no error banner can show (the banner logic lives in JS that didn't load). This is a real gap — fix it: add a plain inline `<script>` before the CDN `<script>` tags in `index.html` that starts a timeout, and a `window.onerror`/global check after them:
```html
<script>
  window.addEventListener('error', function (e) {
    if (e.target && e.target.tagName === 'SCRIPT') {
      document.body.innerHTML = '<div style="padding:2rem;font-family:sans-serif;color:#c0272d">' +
        '<h2>Could not load required libraries</h2>' +
        '<p>This app needs an internet connection the first time you use it (to download OCR/PDF tools). ' +
        'Please check your connection and reload. If this keeps happening, the issue may be with unpkg.com being unreachable from your network.</p>' +
        '<p style="font-family:monospace;font-size:0.8rem">Failed: ' + (e.target.src || 'unknown script') + '</p></div>';
    }
  }, true);
</script>
```
Place this as the very first `<script>` in `<head>` or top of `<body>`, before the CDN tags. Verify with Playwright by pointing `test-harness.html`'s ffmpeg script tag at a 404 URL temporarily and confirming the friendly message renders instead of a blank page; then revert.

- [ ] **Step 2: Run the full existing test suite one more time after all Step 1 fixes**

Re-run Task 1 Step 7, Task 2 Step 4, Task 3 Step 5, Task 4 Step 4, Task 5 Step 5 in sequence against the running dev server to confirm nothing regressed from the Step 1 changes.

Expected: all still PASS.

- [ ] **Step 3: Append Phase 6 findings to `DIAGNOSTICS.md`**

```markdown
## Phase 6 — Adversarial self-review

| # | Check | Finding | Fix |
|---|-------|---------|-----|
| a | iOS Safari memory limits | Cannot test (no iOS device available); real risk for long videos | Documented as known limitation in frameExtractor.js and TESTING.md; 5-min cap mitigates |
| b | Photo instead of video selected | [fill in: confirmed working / found bug + fix] | |
| c | Zero shades detected | [fill in] | |
| d | Non-consecutive duplicate shade numbers | Working as spec'd (consecutive-only dedup) | Documented policy, no code change |
| e | Pale/ivory low-contrast OCR | [fill in actual confidence score observed] | |
| f | CDN unreachable on first visit | Found gap: blocking script failure left blank page | Added global script-error handler with friendly fallback message |

**Full regression re-run after fixes:** [PASS/FAIL for each of Tasks 1-5's tests]
```

- [ ] **Step 4: Write `TESTING.md`**

```markdown
# Testing Shade Card Scanner on your phone

## First-time setup
1. Deploy this folder to Cloudflare Pages (or open the deployed URL if already live).
2. On your Android phone, open the URL in **Chrome** (not another browser — this app is built and tested against Chrome).
3. You need an internet connection the first time you visit, so the app can download its OCR/PDF tools (~15MB total). After that first visit, it works offline.

## Basic test
1. Film a short (under 1 minute) flip-through video of a few fabric shade cards, holding the phone steady and making sure the shade numbers are in focus and well-lit.
2. Open the app, tap **Select Fabric Video**, choose your video.
3. Watch the progress messages: "Extracting frames...", "OCR: frame X/Y...", "Building PDF...".
4. Confirm the shade swatches that appear on screen match what's in your video, with correct numbers underneath.
5. Tap **Download PDF** and open it — confirm each shade has an image and a number, 2 per row.

## Things to specifically try
- A video with poor lighting or blurry numbers — the app should either detect fewer shades or skip unclear ones, not crash.
- Selecting a photo instead of a video — you should see a clear error message, not a blank screen or crash.
- A video where no shade numbers are visible at all — you should see a friendly "no shades detected" message.
- Turning on airplane mode after your first successful visit, then reopening the app — it should still load and work (frame extraction/OCR/PDF all run on-device, no upload happens).

## Known limitations
- **iOS (iPhone) is not officially supported.** This app is built and tested for Android Chrome. iOS Safari has historically restricted memory for this kind of in-browser video processing and may close the tab on longer videos. If you try it on iPhone, keep videos very short.
- Videos over 5 minutes are rejected with a warning, to avoid running out of memory on the device.
- If a shade number appears twice in your video in two different, non-adjacent moments (e.g., you circle back and re-film shade 701 at the end), it will appear twice in the PDF — this is intentional, not a bug.

## If something goes wrong
1. When an error appears, you'll see a red banner with a **Copy debug log** button. Tap it.
2. Paste what was copied into a message to whoever is supporting this app, along with:
   - What you were trying to do
   - What phone/Android version and Chrome version you're using (Chrome menu → Settings → About Chrome)
   - Roughly how long your video was
3. If the app itself won't load at all (blank white page, no button), that's likely a network issue reaching the CDN — try again with a strong wifi/data connection, and mention this specifically.
```

- [ ] **Step 5: Confirm `test-harness.html` is still present and functional as an on-device debug tool**

No action needed if Tasks 0-6 didn't delete it — just confirm with `ls test-harness.html` and note in `TESTING.md`'s "If something goes wrong" section that it exists as an advanced diagnostic (add one line: `- Advanced: visiting /test-harness.html on the deployed site shows PASS/FAIL for each required library, useful if the whole app fails to load.`).

- [ ] **Step 6: Decide on `_headers` file**

Per Task 0's decision, no COOP/COEP headers are required (single-thread ffmpeg core). If Step 1(f) or any other finding surfaced an actual need for cache-control tuning on CDN-cached assets, add a minimal `_headers` file; otherwise explicitly state in `DIAGNOSTICS.md` that none was needed, so this isn't mistaken for an oversight:
```markdown
**_headers file:** Not created. No custom response headers are required — the app uses the single-thread ffmpeg.wasm core specifically to avoid needing COOP/COEP, and no other header requirement surfaced during testing.
```

- [ ] **Step 7: Final commit**

```bash
git add app.js js/ TESTING.md DIAGNOSTICS.md
git commit -m "Phase 6: adversarial self-review fixes and final documentation"
```

---

## Final Deliverables Checklist

- [ ] Working folder deployable to Cloudflare Pages as-is (drag-and-drop the whole directory, or connect via git)
- [ ] `DIAGNOSTICS.md` — complete phase-by-phase log
- [ ] `TESTING.md` — on-device testing guide
- [ ] `test-harness.html` present and working for future on-device debugging
- [ ] `_headers` present only if actually needed (documented either way)
