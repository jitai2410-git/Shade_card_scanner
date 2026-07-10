# Gemini Shade Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the on-device Tesseract.js OCR step with a Google Gemini API vision call (proxied through a new Cloudflare Worker endpoint so the API key stays secret), because real-world testing proved Tesseract cannot read the small, cluttered printed labels on actual fabric catalogue videos.

**Architecture:** The existing static-site pipeline (video pick → ffmpeg.wasm frame extraction → PDF generation) is untouched. `js/ocr.js` is rewritten to batch-upload extracted frames to a new `/api/detect-shades` endpoint instead of running Tesseract locally. That endpoint is a Cloudflare Worker (`worker/index.js`) that holds the Gemini API key server-side, forwards the frame batch to Gemini with a prompt asking it to find every distinct shade number across the whole sequence (since a product's fabric and its label can appear several seconds apart), and returns structured JSON. The same repo now deploys as an explicit Cloudflare Worker-with-assets project (`wrangler.jsonc` + `.assetsignore`) rather than relying on Cloudflare's implicit static-site auto-detection.

**Tech Stack:**
- `wrangler@4.110.0` (installed as a project devDependency under `tools/`, confirmed working without requiring a Cloudflare login for local `wrangler dev`)
- Gemini API model `gemini-2.5-flash` via `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent` (confirmed available on the provided free-tier API key; confirmed correctly reads real shade-label text and correctly returns no match on label-free frames; confirmed correctly handles a batched multi-image request with structured JSON output)
- Everything else unchanged from the existing stack (ffmpeg.wasm, jsPDF, vanilla JS, no build step for the client)

## Global Constraints

- The **client-side app remains vanilla HTML/CSS/JS with no build step** — only the new `worker/index.js` is a separate deploy artifact (Cloudflare Worker runtime, not shipped to the browser).
- **No cost risk.** Gemini's free tier (used via an API key from Google AI Studio, already obtained) has no credit card attached and hard-caps rather than billing overages. Expected volume (~80-100 videos/month, roughly 1-3 requests per video after batching) is far under any free-tier daily limit.
- **`GEMINI_API_KEY` must never appear in any client-shipped file or git history.** Local dev uses `.dev.vars` (already created and confirmed gitignored). Production uses a Cloudflare Worker secret, set via the dashboard (not committed anywhere).
- **The app now requires internet connectivity for the detection step specifically.** Frame extraction and PDF building could theoretically stay offline-capable, but detection cannot. This is a confirmed, accepted behavior change from the original spec — update user-facing copy and `TESTING.md` accordingly, don't try to preserve a false "works offline" claim for this step.
- **Frame sampling interval changes from 1.5s to 0.5s** (see design doc rationale: since Gemini now sees the whole video's frame set at once, density matters more than precise per-window timing).
- **Batch size cap: 60 frames per Gemini request.** Videos producing more than 60 frames (at 0.5s intervals, that's videos longer than 30s) are split into sequential batches; results are merged with a final cross-batch dedup pass (keep first occurrence of any repeated shade number).
- **Deployed asset size:** `wrangler.jsonc` uses `assets.directory: "./"` (whole repo), so a `.assetsignore` file is **required** to exclude `worker/`, `docs/`, `fixtures/`, `tools/` (including its `node_modules`), `.superpowers/`, `.wrangler/`, `wrangler.jsonc`, `.dev.vars`, and other non-deployable paths — confirmed via direct testing that omitting this causes deploy failures (a single large file anywhere under the assets directory, even in an unrelated `node_modules`, fails the entire deploy with "Asset too large").
- Every phase must have a passing verification (local `wrangler dev` + real Gemini calls + Playwright, not assumptions) before moving to the next, logged in `DIAGNOSTICS.md`.

## Pre-flight findings (already verified, do not re-derive)

- `npm install --save-dev wrangler` installs cleanly (v4.110.0) and `npx wrangler dev` serves both static assets (via an `env.ASSETS.fetch(request)` binding) and a custom API route from the same Worker, locally, without requiring `wrangler login`.
- The provided Gemini API key is valid and `gemini-2.5-flash` is available on it.
- Direct test: sent the real frame containing "SR.NO : 502" (from the user's actual WhatsApp catalogue video, the exact frame Tesseract failed on with garbage output at 40% confidence) to Gemini with a simple prompt — **Gemini correctly returned "502"**.
- Direct test: sent a frame with no label text (just brand/collection text) — **Gemini correctly returned "NONE"**, no hallucination.
- Direct test: sent 6 real frames spanning the video in one batched request with the multi-image structured-JSON prompt (the actual prompt design used below) — **Gemini correctly returned all 6 distinct shade numbers present (502-507), independently cross-checked by viewing the source frames directly.** One minor imprecision was observed: the "best frame for the swatch photo" pick was occasionally off by one nearby product. This is a prompt-wording detail to iterate on during Task 2's verification, not a blocker to the approach.
- Direct test: `.assetsignore` correctly excludes listed paths from the deployed asset bundle — confirmed via `wrangler deploy --dry-run`, which reported a near-zero total upload size once `node_modules` and other scratch paths were excluded, despite the pre-filter file-scan count staying high (that count is just a directory scan, not what actually gets uploaded).
- Confirmed via `grep`: `app.js` and `js/pdfGenerator.js` never reference `shade.confidence` — only `js/ocr.js` used it internally. Dropping the `confidence` field from the new detection result shape is safe and requires no changes to those two files' logic.
- Current `js/ocr.js` and `js/frameExtractor.js` contents captured directly from the repo (reproduced in the tasks below) so diffs are exact, not guessed.

## File Structure

New files:
```
wrangler.jsonc           - Cloudflare Worker + static assets config
.assetsignore            - excludes non-deployable paths from the asset bundle
worker/index.js          - Worker fetch handler: routes /api/detect-shades to Gemini proxy, everything else to static assets
```

Modified files:
```
js/frameExtractor.js     - interval default 1.5 -> 0.5 (one line)
js/ocr.js                - completely rewritten: batches frames, POSTs to /api/detect-shades, merges + dedups across batches
app.js                   - status text updated ("Uploading frames..." / "Analyzing..." instead of "OCR: frame X/Y"); no logic changes needed (interface unchanged)
index.html               - remove tesseract.js CDN <script> tag; update the "needs internet" first-load message to mention shade detection specifically
sw.js                    - remove tesseract.js URL from the offline ASSETS cache list
test-harness.html        - remove the Tesseract dependency check; add a check that /api/detect-shades responds (structural check, not a real Gemini call)
DIAGNOSTICS.md           - new "Gemini Migration" section documenting this change, phase by phase
TESTING.md               - update to reflect: internet required for detection, new debug-log expectations
```

Unchanged (confirmed safe): `js/logger.js`, `js/pdfGenerator.js`, `css/style.css`, `manifest.json`, `icons/`, `fixtures/test-video.mp4`, `fixtures/make-test-video.sh`.

---

### Task 0: Cloudflare Worker backend — Gemini proxy endpoint

**Files:**
- Create: `wrangler.jsonc`
- Create: `.assetsignore`
- Create: `worker/index.js`
- Modify: `tools/package.json` (add `wrangler` as a devDependency, alongside the existing `canvas`/`pdf-parse`)
- Modify: `DIAGNOSTICS.md` (new "Gemini Migration" section, Phase 0 entry)

**Interfaces:**
- Produces: `POST /api/detect-shades` — request body `{ "images": ["<base64 jpeg>", ...] }` (1-60 entries), response body on success `{ "shades": [{ "shadeNumber": "502", "imageIndex": 2 }, ...] }` (imageIndex is 0-based within the submitted batch), response on failure `{ "error": "<message>" }` with a non-200 status. This exact contract is what Task 2's client code consumes.

- [ ] **Step 1: Add `wrangler` to `tools/package.json` devDependencies and install**

```bash
cd "c:\Users\Envy\Catalogue Price Web\tools"
npm install --save-dev wrangler --no-audit --no-fund
```
Expected: `tools/node_modules/.bin/wrangler` (or equivalent) exists; `npx --prefix tools wrangler --version` (run from repo root) prints `4.110.0` or later.

- [ ] **Step 2: Create `wrangler.jsonc` at the repo root**

```jsonc
{
  "name": "shadecardscanner",
  "main": "worker/index.js",
  "compatibility_date": "2026-07-10",
  "assets": {
    "directory": "./",
    "binding": "ASSETS"
  }
}
```

- [ ] **Step 3: Create `.assetsignore` at the repo root**

```
worker/
docs/
fixtures/
tools/
.superpowers/
.wrangler/
wrangler.jsonc
.assetsignore
.dev.vars
.dev.vars.*
.git/
.gitignore
node_modules/
DIAGNOSTICS.md
TESTING.md
```

- [ ] **Step 4: Create `worker/index.js`**

```js
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_IMAGES_PER_REQUEST = 60;
const SHADE_REGEX = /^[1-9]\d{2}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/detect-shades' && request.method === 'POST') {
      return handleDetectShades(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleDetectShades(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError('Invalid JSON body', 400);
  }

  const images = body.images;
  if (!Array.isArray(images) || images.length === 0) {
    return jsonError('Missing "images" array', 400);
  }
  if (images.length > MAX_IMAGES_PER_REQUEST) {
    return jsonError(`Too many images: max ${MAX_IMAGES_PER_REQUEST} per request`, 400);
  }
  for (const img of images) {
    if (typeof img !== 'string' || img.length === 0) {
      return jsonError('Each image must be a non-empty base64 string', 400);
    }
  }

  const parts = [{ text: buildPrompt(images.length) }];
  images.forEach((b64, i) => {
    parts.push({ text: `frame index ${i}:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
  });

  let geminiRes;
  try {
    geminiRes = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
  } catch (e) {
    return jsonError('Could not reach the shade-detection service. Check your internet connection.', 502);
  }

  if (!geminiRes.ok) {
    const text = await geminiRes.text().catch(() => '');
    return jsonError(`Shade-detection service error (${geminiRes.status}): ${text.slice(0, 300)}`, 502);
  }

  const data = await geminiRes.json();
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text || '';
  const shades = parseShadesResponse(text, images.length);

  return new Response(JSON.stringify({ shades }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildPrompt(frameCount) {
  return `You will see a numbered sequence of frames (frame index 0 to ${frameCount - 1}, in order) from a video where someone flips through a fabric swatch book. Each product shows its fabric first, then a printed label with "SR.NO : NNN" (a 3-digit number) appears later for that same product. Find every distinct SR.NO number visible anywhere in the sequence. For each one, report the number and the index of whichever frame in this sequence best shows the FABRIC of that same product clearly (in focus, unobstructed, well-lit) — not necessarily the frame with the number itself. Reply with ONLY a JSON array like [{"shadeNumber":"502","imageIndex":2}], no other text, no markdown formatting.`;
}

function parseShadesResponse(text, frameCount) {
  // Gemini sometimes wraps JSON in markdown code fences (confirmed in manual testing); strip them.
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set();
  const result = [];
  for (const item of parsed) {
    const number = String((item && item.shadeNumber) || '').trim();
    const imageIndex = Number(item && item.imageIndex);
    if (!SHADE_REGEX.test(number)) continue;
    if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= frameCount) continue;
    if (seen.has(number)) continue;
    seen.add(number);
    result.push({ shadeNumber: number, imageIndex });
  }
  return result;
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 5: Verify locally with `wrangler dev` + real frames + real Gemini calls**

From the repo root (so `.dev.vars` is picked up):
```bash
npx --prefix tools wrangler dev --port 8788 --local
```
In a separate terminal, extract a couple of real frames to test with (reuse the fixture video):
```bash
FF="<path to the @ffmpeg-installer/ffmpeg binary — reinstall in a scratch dir via `npm install @ffmpeg-installer/ffmpeg` if not already available>"
mkdir -p /tmp/wtest_frames
"$FF" -y -i "fixtures/test-video.mp4" -vf "fps=1/1.5,scale='min(960,iw)':-2" -q:v 3 /tmp/wtest_frames/frame_%04d.jpg
node -e "
const fs = require('fs');
const files = fs.readdirSync('/tmp/wtest_frames').filter(f=>f.endsWith('.jpg')).sort();
const images = files.map(f => fs.readFileSync('/tmp/wtest_frames/'+f).toString('base64'));
fetch('http://localhost:8788/api/detect-shades', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({images})
}).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2)));
"
```
Expected: a JSON response like `{"shades":[{"shadeNumber":"701","imageIndex":0},{"shadeNumber":"702","imageIndex":1},{"shadeNumber":"703","imageIndex":2}]}` (or similar — the synthetic test video's drawtext digits are large and unambiguous, so this should read cleanly). This is the first real test of the full request/response cycle through the actual Worker code (not just a raw curl to Gemini as in pre-flight).

- [ ] **Step 6: Test error cases**

```bash
# Missing images array
curl -s -X POST http://localhost:8788/api/detect-shades -H "Content-Type: application/json" -d '{}'
# Expected: {"error":"Missing \"images\" array"} with 400 status — check with -i for status code

# Too many images
node -e "console.log(JSON.stringify({images: Array(61).fill('AAAA')}))" > /tmp/toomany.json
curl -s -X POST http://localhost:8788/api/detect-shades -H "Content-Type: application/json" -d @/tmp/toomany.json
# Expected: {"error":"Too many images: max 60 per request"}
```
Expected: both return clear JSON error messages with appropriate 400 status codes (verify with `curl -i`), not a crash or an unhandled exception.

- [ ] **Step 7: If Step 5 or 6 fail, diagnose**

Check in order: (a) `.dev.vars` not being picked up — confirm `wrangler dev` is run from the repo root where `.dev.vars` lives, and confirm via a temporary `console.log(!!env.GEMINI_API_KEY)` (removed before finishing) that the binding is populated; (b) Gemini response shape different from pre-flight testing — log the raw `data` object and compare against the pre-flight `curl` output structure; (c) markdown-fence-stripping regex not matching actual output — log `text` before `parseShadesResponse` runs. Fix, re-test until Step 5 and 6 both pass.

- [ ] **Step 8: Append Phase 0 (Gemini Migration) result to `DIAGNOSTICS.md`**

Add a new top-level section (don't touch the existing Phase 0-6 sections from the original build):
```markdown
# Gemini Migration

Real-world testing on 2026-07-10 found the original Tesseract.js-based OCR (Phases 0-6 above) cannot read actual fabric catalogue labels — see design doc at docs/superpowers/specs/2026-07-10-gemini-shade-detection-design.md for full root-cause evidence. This section logs the migration to Gemini API-based detection.

## Phase 0 — Cloudflare Worker backend

**Tested:** `wrangler dev` locally serving both static assets and `/api/detect-shades`; real end-to-end request using frames extracted from `fixtures/test-video.mp4`, through the actual Worker code (not a direct Gemini curl); error-case handling (missing images, too-many-images).

**Result:** [PASS/FAIL — fill in after Step 5-6]
**Failures found:** [none, or list with root cause + fix]
```

- [ ] **Step 9: Commit**

```bash
git add wrangler.jsonc .assetsignore worker/index.js tools/package.json tools/package-lock.json DIAGNOSTICS.md
git commit -m "Add Cloudflare Worker Gemini proxy endpoint for shade detection"
```

---

### Task 1: Frame extraction interval change

**Files:**
- Modify: `js/frameExtractor.js`
- Modify: `DIAGNOSTICS.md` (append)

**Interfaces:**
- No signature change: `window.extractFrames(file, opts)` still accepts an optional `intervalSec` override; only the *default* changes.

- [ ] **Step 1: Change the default interval**

In `js/frameExtractor.js`, line 7:
```js
// Before:
const { intervalSec = 1.5, maxWidth = 960, onProgress = () => {} } = opts;
// After:
const { intervalSec = 0.5, maxWidth = 960, onProgress = () => {} } = opts;
```
This is the only change to this file. Do not touch the Worker-monkeypatch, `-huffman 0`, or cleanup logic — all verified working, out of scope here.

- [ ] **Step 2: Verify frame count against the synthetic fixture**

```bash
FF="<path to @ffmpeg-installer/ffmpeg binary>"
mkdir -p /tmp/interval_check && rm -f /tmp/interval_check/*
"$FF" -y -i "fixtures/test-video.mp4" -vf "fps=1/0.5,scale='min(960,iw)':-2" -q:v 3 -huffman 0 /tmp/interval_check/frame_%04d.jpg
ls /tmp/interval_check | wc -l
```
Expected: `12` (the 6-second fixture at 1 frame/0.5s = 12 frames; this is the CLI proxy confirming the filter math, same equivalence argument as the original Task 1).

- [ ] **Step 3: Verify in-browser via Playwright against `test-phase1.html`**

Serve locally (from now on, use `wrangler dev`, not `python -m http.server`, since later tasks need the `/api/detect-shades` route too — but `test-phase1.html` only exercises `extractFrames`, which doesn't need the API, so either server works for this specific step; using `wrangler dev` now establishes the habit for later tasks):
```bash
npx --prefix tools wrangler dev --port 8788 --local
```
Navigate to `http://localhost:8788/test-phase1.html` via Playwright, upload `fixtures/test-video.mp4` (lowercase drive-letter path), wait for PASS/FAIL.
Expected: `PASS — 12 frames extracted` (updated from the original `4 frames` at the old 1.5s interval), 12 thumbnails, zero console errors.

- [ ] **Step 4: If it fails, diagnose**

This is a one-line constant change to an already-verified extraction pipeline — a failure here most likely means something about the interval math interacts badly with `ffmpeg`'s `fps` filter at this specific value, or a timing/rounding issue. Compare the CLI proxy count (Step 2) against the browser result; if they match but differ from the expected 12, recompute the expected count from the fixture's actual duration (`ffmpeg -i fixtures/test-video.mp4` reports `Duration: 00:00:06.00`) — 6.00s / 0.5s = 12 exactly, no rounding ambiguity expected. Fix, re-test.

- [ ] **Step 5: Append result to `DIAGNOSTICS.md`**

```markdown
## Phase 1 — Frame extraction interval change (1.5s -> 0.5s)

**Tested:** CLI proxy (fps=1/0.5 filter on fixtures/test-video.mp4) -> 12 frames. In-browser (test-phase1.html via Playwright, served via `wrangler dev`) -> [fill in actual result].

**Result:** [PASS/FAIL]
**Failures found:** [none, or list]
```

- [ ] **Step 6: Commit**

```bash
git add js/frameExtractor.js DIAGNOSTICS.md
git commit -m "Increase frame sampling density from 1.5s to 0.5s intervals"
```

---

### Task 2: Gemini-based detection client (`js/ocr.js` rewrite)

**Files:**
- Modify: `js/ocr.js` (complete rewrite)
- Modify: `DIAGNOSTICS.md` (append)

**Interfaces:**
- Consumes: `POST /api/detect-shades` (Task 0's contract).
- Produces: `window.detectShades(frames) -> Promise<Array<{number: string, frameIndex: number}>>` — same function name and same consumer-facing shape as before, **minus the `confidence` field** (confirmed safe: no other file reads it). `frameIndex` is the *global* index into the full `frames` array passed in, even though batching internally splits requests — this is what `pdfGenerator.js` and `app.js` already expect.

- [ ] **Step 1: Replace `js/ocr.js` entirely**

```js
window.detectShades = async function detectShades(frames) {
  const log = window.SCSLogger.log;
  const BATCH_SIZE = 60;
  const allShades = [];
  const seenNumbers = new Set();

  for (let batchStart = 0; batchStart < frames.length; batchStart += BATCH_SIZE) {
    const batch = frames.slice(batchStart, batchStart + BATCH_SIZE);
    log(`detectShades: sending batch starting at frame ${batchStart} (${batch.length} frames)`);

    const images = await Promise.all(batch.map(f => blobToBase64(f.blob)));

    let json;
    try {
      const res = await fetch('/api/detect-shades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Detection service returned ${res.status}`);
      }
      json = await res.json();
    } catch (err) {
      log(`detectShades: batch at ${batchStart} failed: ${err.message}`);
      throw err;
    }

    const batchShades = json.shades || [];
    log(`detectShades: batch at ${batchStart} found ${batchShades.length} shades`);
    for (const shade of batchShades) {
      if (seenNumbers.has(shade.shadeNumber)) {
        log(`detectShades: ${shade.shadeNumber} already seen in an earlier batch, skipped`);
        continue;
      }
      seenNumbers.add(shade.shadeNumber);
      allShades.push({
        number: shade.shadeNumber,
        frameIndex: batchStart + shade.imageIndex,
      });
    }
  }

  log(`detectShades: done, ${allShades.length} unique shades across ${frames.length} frames`);
  return allShades;
};

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
```

- [ ] **Step 2: Create `test-phase2-gemini.html`** (new test page; the original `test-phase2.html` tested Tesseract specifically and is superseded, but leave it in place as historical/on-device debug reference per the project's "never delete working debug tools" convention — just don't wire it into `index.html`)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Phase 2 Test — Gemini Detection</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 1rem; }
  #status { font-weight: bold; }
  .pass { color: #0a7d2c; } .fail { color: #c0272d; }
  li { font-family: monospace; }
</style>
</head>
<body>
<h1>Phase 2 Test — Gemini Detection</h1>
<input type="file" id="fileInput" accept="video/*">
<p id="status">Pick fixtures/test-video.mp4, or a real catalogue video</p>
<ul id="results"></ul>

<script src="https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js"></script>
<script src="https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js"></script>
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
    status.textContent = `Detecting shades across ${frames.length} frames...`;
    const shades = await window.detectShades(frames);
    status.textContent = `Done — detected [${shades.map(s => s.number).join(', ')}]`;
    status.className = 'pass';
    for (const s of shades) {
      const li = document.createElement('li');
      li.textContent = `${s.number} (frame ${s.frameIndex})`;
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

- [ ] **Step 3: Verify against the synthetic fixture via `wrangler dev` + Playwright**

```bash
npx --prefix tools wrangler dev --port 8788 --local
```
Navigate to `http://localhost:8788/test-phase2-gemini.html`, upload `fixtures/test-video.mp4`, wait for status text.
Expected: `Done — detected [701, 702, 703]` (matching the original spec's synthetic-video expectation, now via Gemini instead of Tesseract).

- [ ] **Step 4: Verify against the real catalogue video**

Upload the real WhatsApp video used during root-cause diagnosis (path on this machine: `C:\Users\Envy\Desktop\WhatsApp Video 2026-07-10 at 12.28.32.mp4` — if unavailable in a later session, ask the user for a real catalogue video to test with; this step is not meaningfully verifiable with only the synthetic fixture, since the whole point of this migration is fixing real-world accuracy).
Expected: at minimum, shades `502`, `503`, `504`, `505`, `506`, `507` are detected (all six independently confirmed present in the source video during design pre-flight). Exact frame indices chosen for each may vary run-to-run since it's a live model call — that's fine, just confirm the shade numbers themselves are correct and no obviously-wrong numbers appear.

- [ ] **Step 5: If either verification fails, diagnose**

Check in order: (a) network tab / `browser_network_requests` — did the `/api/detect-shades` call actually reach the Worker (404 means routing issue in `worker/index.js`, check the pathname match); (b) Worker-side error — check `wrangler dev`'s terminal output for a thrown exception during the request; (c) parsing failure — Gemini's response format drifted from pre-flight testing (unlikely but possible) — temporarily log the raw Gemini response text server-side (removed before finishing) to compare against the pre-flight `curl` output shape. Fix, re-test until Step 3 and 4 both pass.

- [ ] **Step 6: Append result to `DIAGNOSTICS.md`**

```markdown
## Phase 2 — Gemini-based detection client

**Tested:** test-phase2-gemini.html via Playwright, served via `wrangler dev`, against both fixtures/test-video.mp4 (expect [701,702,703]) and a real catalogue video (expect at least [502,503,504,505,506,507]).

**Result:** [PASS/FAIL for each]
**Failures found:** [none, or list]
**Note on swatch-frame precision:** [record whether the imageIndex/frameIndex picks looked visually correct for the real video, or whether the prompt needs further tuning — this was flagged as an open item during design]
```

- [ ] **Step 7: Commit**

```bash
git add js/ocr.js test-phase2-gemini.html DIAGNOSTICS.md
git commit -m "Replace Tesseract OCR client with Gemini-based batched detection"
```

---

### Task 3: Wire into the full app, remove old OCR stack

**Files:**
- Modify: `index.html` (remove tesseract.js script tag, update first-load message)
- Modify: `sw.js` (remove tesseract.js from ASSETS cache list)
- Modify: `test-harness.html` (remove Tesseract check, add `/api/detect-shades` structural check)
- Modify: `app.js` (status text only)
- Modify: `DIAGNOSTICS.md` (append)

**Interfaces:**
- No new interfaces; this task wires already-verified pieces (Tasks 0-2) into the shipped app and removes now-dead dependencies.

- [ ] **Step 1: Remove the Tesseract CDN script tag from `index.html`**

Delete this line (currently present among the CDN `<script>` tags):
```html
<script src="https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js"></script>
```
Update the existing first-load message (around the global script-error handler added in the original Task 6) from mentioning "OCR/PDF tools" generically to being accurate about what's downloaded now — change:
```
'<p>This app needs an internet connection the first time you use it (to download OCR/PDF tools). '
```
to:
```
'<p>This app needs an internet connection every time you scan a video (frame extraction and PDF tools download once and work offline, but shade detection happens online via an AI service). '
```

- [ ] **Step 2: Remove tesseract.js from `sw.js`'s `ASSETS` list**

Delete this line from the `ASSETS` array:
```js
'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js',
```
Bump the cache name so returning users get the updated asset list instead of a stale cache:
```js
// Before:
const CACHE_NAME = 'shade-card-scanner-v1';
// After:
const CACHE_NAME = 'shade-card-scanner-v2';
```

- [ ] **Step 3: Update `test-harness.html`**

Remove the Tesseract `<script>` tag and its check:
```html
<script src="https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js"></script>
```
```js
check('Tesseract.recognize', () => typeof Tesseract !== 'undefined' && typeof Tesseract.recognize === 'function');
```
Add a structural check for the new endpoint (deliberately sends an invalid tiny request — this checks the route exists and responds, not that Gemini itself works, since that's already covered by Task 2's real tests):
```js
(async () => {
  try {
    const res = await fetch('/api/detect-shades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: [] }),
    });
    const ok = res.status === 400; // empty images array should be rejected with 400
    report('/api/detect-shades route reachable', ok, ok ? '' : `unexpected status ${res.status}`);
  } catch (e) {
    report('/api/detect-shades route reachable', false, e.message);
  }
})();
```

- [ ] **Step 4: Update `app.js` status text**

Around the existing pipeline (find the line `status.textContent = \`OCR: frame 1/${frames.length}...\`;`):
```js
// Before:
status.textContent = `OCR: frame 1/${frames.length}...`;
const shades = await window.detectShades(frames);
// detectShades logs its own progress via SCSLogger; mirror coarse progress here
setProgress(80);

// After:
status.textContent = `Analyzing ${frames.length} frames...`;
const shades = await window.detectShades(frames);
// detectShades logs its own progress via SCSLogger; mirror coarse progress here
setProgress(80);
```
No other changes to `app.js` — the `detectShades(frames)` call signature and the `shades` array shape consumed by `renderSwatches` and `generateShadeCardPDF` are unchanged (confirmed in pre-flight: neither references `confidence`).

- [ ] **Step 5: Full end-to-end verification via `wrangler dev` + Playwright**

```bash
npx --prefix tools wrangler dev --port 8788 --local
```
Navigate to `http://localhost:8788/index.html`:
1. Upload `fixtures/test-video.mp4` — expect `Done — 3 shades found: 701, 702, 703`, 3 swatch tiles, working download button, no error banner. Verify the downloaded PDF the same way as the original Task 4 (extract base64, decode, `node tools/verify-phase3-pdf.js`).
2. Upload the real catalogue video (Desktop path from Task 2 Step 4) — expect `Done — N shades found: ...` including at least 502-507, swatch tiles rendered, PDF downloadable and verifiable.
3. Confirm `test-harness.html` shows all checks passing (including the new `/api/detect-shades route reachable` check) with tesseract.js's check removed, not just skipped-and-ignored.

- [ ] **Step 6: If it fails, diagnose**

Most likely failure points at this integration stage: (a) `sw.js` serving a stale cached `index.html` that still references the removed tesseract.js tag — confirm the `CACHE_NAME` bump from Step 2 actually took effect (check via `browser_evaluate`: `caches.keys()` should show only the new `v2` cache name after a hard reload); (b) status text change breaking an assumption elsewhere — grep the whole repo for any other reference to the exact old string; (c) real-video test flaking due to a live network call to Gemini — retry once before concluding it's a real bug, and note in DIAGNOSTICS.md if a transient failure occurred (live external API calls aren't as deterministic as the fully-local original pipeline; document this reality rather than hiding it).

- [ ] **Step 7: Append result to `DIAGNOSTICS.md`**

```markdown
## Phase 3 — Full pipeline wired to Gemini detection

**Tested:** index.html end-to-end via Playwright (served via `wrangler dev`) against both fixtures/test-video.mp4 and a real catalogue video. test-harness.html re-verified with Tesseract check removed and /api/detect-shades check added.

**Result:** [PASS/FAIL]
**Failures found:** [none, or list]
```

- [ ] **Step 8: Commit**

```bash
git add index.html sw.js test-harness.html app.js DIAGNOSTICS.md
git commit -m "Wire Gemini-based detection into full app, remove Tesseract dependency"
```

---

### Task 4: Deploy and verify production

**Files:**
- Modify: `TESTING.md` (update for online-required detection step)
- Modify: `DIAGNOSTICS.md` (final Gemini Migration summary)

**Interfaces:** None new — this task deploys and verifies what Tasks 0-3 already built and locally verified.

- [ ] **Step 1: Update `TESTING.md`**

Add a note near the top (don't rewrite the whole document, just amend it) clarifying the connectivity requirement changed:
```markdown
## Update: internet requirement (2026-07-10)

Shade detection now uses an AI service (Google Gemini) instead of running entirely on your phone. This means:
- You need an internet connection every time you scan a video, not just the first visit.
- Frame extraction and PDF building still happen on your phone; only the "read the shade numbers" step goes over the internet.
- If detection fails (no internet, or the service is temporarily down), you'll see the same red error banner as other failures — just retry once you have a connection.
```
Also update the "Known limitations" list: remove or amend anything implying full offline capability for the whole pipeline.

- [ ] **Step 2: Push to git**

```bash
git push
```

- [ ] **Step 3: Set the production secret**

This step requires manual action in the Cloudflare dashboard (no CLI credentials available in this environment): navigate to the Cloudflare dashboard → Workers & Pages → the `shadecardscanner` project → Settings → Variables and Secrets → Add → name `GEMINI_API_KEY`, type "Secret", paste the same key from `.dev.vars` → Save and deploy. Confirm the next deployment (triggered by the Step 2 push, or a manual retry if needed) succeeds — check the build log doesn't repeat the earlier "Asset too large" failure (the `.assetsignore` from Task 0 should prevent this; if it recurs, that's a real regression to diagnose, not a coincidence).

- [ ] **Step 4: Verify the live deployment end-to-end**

Once deployed, use Playwright against the real production URL (`https://shadecardscanner.jitai2410.workers.dev`):
1. Navigate to `/test-harness.html` — confirm all checks pass, including `/api/detect-shades route reachable` (this specifically proves the production secret is wired correctly, since a missing/wrong secret would make Gemini calls fail, though this particular check only tests routing — also do a real detection call, see next step).
2. Navigate to `/`, upload `fixtures/test-video.mp4` (or, if testing directly against the live URL from this machine, the real catalogue video) via Playwright, confirm the full pipeline completes successfully in production, not just locally.

- [ ] **Step 5: If production fails but local passed, diagnose**

Check in order: (a) secret not actually set, or set with trailing whitespace/newline — re-check the dashboard value character-by-character against `.dev.vars`; (b) `.assetsignore` behaving differently in Cloudflare's actual build environment vs local `wrangler dev`/`deploy --dry-run` — check the live build log for the same "Total Upload" size sanity check used in pre-flight; (c) CORS or routing difference between local and production Workers runtime — check `browser_network_requests` against the live site for the exact failure mode. Fix, redeploy, re-verify.

- [ ] **Step 6: Final `DIAGNOSTICS.md` summary**

Append a closing summary to the "Gemini Migration" section:
```markdown
## Migration complete

All phases (0-3 above) passed local verification via `wrangler dev`. Production deployment verified at https://shadecardscanner.jitai2410.workers.dev on [date] — test-harness.html all-green, full pipeline confirmed working against [fixtures/test-video.mp4 and/or the real catalogue video] on the live URL.

**Known residual risk:** the Gemini API is a live external service — unlike the original fully-local pipeline, production behavior can vary run-to-run and is subject to Google's own uptime/quota. This is an accepted tradeoff (see design doc) for solving the real-world OCR accuracy problem that the fully-local approach could not.
```

- [ ] **Step 7: Commit and push final docs**

```bash
git add TESTING.md DIAGNOSTICS.md
git commit -m "Update docs for Gemini migration; confirm production deployment"
git push
```
