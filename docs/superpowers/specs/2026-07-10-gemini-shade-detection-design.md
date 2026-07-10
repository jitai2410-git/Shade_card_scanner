# Gemini-Based Shade Detection — Design

## Background

The shipped app (built and verified through 2026-07-09) uses Tesseract.js running entirely on-device to OCR shade numbers from extracted video frames. Real-world testing on 2026-07-10 with an actual fabric-catalogue WhatsApp video (478×850, 41s) found this fails completely: shade numbers are printed small (~12-15px tall) as part of a cluttered label (`SR.NO : 502` alongside Collection/Width/GSM/Composition text), not the large isolated digits the synthetic test video used. Confirmed via direct testing that even a human-legible, sharp, 4-6x-upscaled crop of the label still failed OCR under every Tesseract PSM mode tried — this is not a config/threshold problem, it's a fundamental limitation of segmentation-based OCR on this kind of image.

## Goal

Replace the on-device Tesseract OCR step with a call to Google's Gemini API (multimodal vision model), which reads text contextually rather than through character segmentation and should handle small/cluttered real-world labels far better. Keep everything else (video picking, frame extraction, PDF generation, PWA shell) unchanged.

## Constraints (confirmed with user)

- **Cost:** must never incur a bill. Google AI Studio's Gemini free tier requires no credit card and hard-caps at a daily request quota rather than billing overages — this is the only acceptable service type.
- **Privacy:** not a concern for this user; frames leaving the device to Google's servers is acceptable.
- **Online-only is acceptable** for the OCR step specifically. The app's offline-shell caching (manifest/service worker) stays as-is for the UI/static assets, but shade detection now requires an internet connection at the time of processing. This is a behavior change from the original "works fully offline" property and must be documented for the user (TESTING.md, and a UI-level note).
- **Expected volume:** ~80-100 catalogue videos/month currently (single user), possibly extending to public use later. Design must comfortably clear this with headroom for growth.

## Architecture Change

### What stays the same
- Video picking, duration check (5-min cap), memory protocol (revoke object URLs, process incrementally).
- Frame extraction via ffmpeg.wasm — same downscale-to-960px-max-width logic, same `-huffman 0` fix, same Worker-type workaround, same `try/finally` cleanup.
- PDF generation (`js/pdfGenerator.js`) — center-60% crop, 2-column A4 grid, `ShadeCard_<timestamp>.pdf` filename. Unchanged except it now receives `{number, frameIndex}` pairs from the new detection step instead of from Tesseract (see below — `confidence` field is dropped since Gemini doesn't return a comparable numeric score).
- PWA shell (manifest, service worker, icons) — app still installs and loads offline; only the shade-detection network call requires connectivity.
- Error banner + Copy debug log UI pattern — reused for network/API failures.

### What changes

**1. Frame extraction interval:** tightened from 1 frame/1.5s to 1 frame/0.5s. Rationale: since Gemini will see the *entire* video's frame set in one request (not per-window), sampling only needs to be dense enough that no moment is skipped — it no longer needs to land precisely on a single "good" instant per interval the way the old single-frame-per-window Tesseract approach did. 0.5s gives enough density to reliably catch both the "fabric shown" and "label flipped into view" moments of each product without exploding frame count. (Rejected: sending every native video frame (~30/sec) — for a 41s video that's ~1,230 images, which would overload phone memory during extraction and likely exceed the Gemini API's per-request size/token limits. Adjacent frames 1/30s apart are near-duplicates and add no information.)

**2. OCR replaced with a Gemini vision call.** All extracted frames from one video are sent together (batched if the frame count is large — see below) to Gemini with a prompt instructing it to: examine the sequence of frames (in order) from a fabric-catalogue flip-through video, identify each distinct 3-digit shade number printed on a label (commonly formatted as "SR.NO : NNN"), and for each distinct shade found, return the shade number plus the index of whichever frame in the batch best shows the *fabric* clearly (in focus, unobstructed, well-lit) for use as the swatch photo — which may differ from whichever frame best shows the *number*, since a product's video segment typically shows the fabric first and the label later. Response is structured JSON: an array of `{ "shadeNumber": "502", "swatchFrameIndex": 8 }` objects. Gemini is asked to deduplicate itself (return each distinct shade once) since it has full-sequence context, unlike the old per-frame Tesseract approach which needed explicit consecutive-frame dedup logic.

**Batching for long videos:** if the frame count for a video exceeds ~60, split into sequential batches of ~60 frames each (still comfortably within one video even at the 5-minute cap: 300s ÷ 0.5s = 600 frames ÷ 60 = ~10 batches worst case, though realistic catalogue videos are expected to be much shorter). Each batch is sent as a separate request; results are merged, then a final light dedup pass drops any shade number that appears in more than one batch (keeping the first occurrence) to handle products whose frames happen to straddle a batch boundary.

**3. New backend: a Cloudflare Worker function** (added to the same Cloudflare project already deployed) holds the Gemini API key as a secret and proxies requests — the key can never live in client-side code since the site's source is fully public. Client sends a batch of frame images (as base64 or multipart) to a new endpoint (e.g. `/api/detect-shades`); the Worker forwards them to the Gemini API with the server-held key, and relays the structured JSON response back to the client. No other server-side logic — this is a pure pass-through proxy, not a database or persistent backend.

**4. Client-side OCR module (`js/ocr.js`) is replaced** with a module that uploads the frame batch(es) to `/api/detect-shades` and returns the same `{number, frameIndex}` shape the rest of the pipeline (`app.js`, `js/pdfGenerator.js`) already expects, so downstream code needs minimal changes. The old consecutive-frame dedup logic is removed (superseded by Gemini's whole-sequence dedup); a final cross-batch dedup pass (see above) replaces it.

**5. Error handling:** if the network is unavailable or the Gemini/Worker call fails, show the existing red error banner with a clear message ("Couldn't reach the shade-detection service — check your internet connection and try again"). No retry-queueing or offline-then-later-sync — confirmed acceptable scope with the user; a failed attempt just needs to be manually retried once online.

## Data Flow

1. User picks video → duration check (unchanged).
2. `extractFrames()` — now samples every 0.5s instead of 1.5s (one-line constant change), same downscaling/memory protocol.
3. New `detectShadesViaGemini(frames)` — batches frames (≤60 per batch), POSTs each batch to `/api/detect-shades`, merges + dedups results, returns `Array<{number, frameIndex}>`.
4. `generateShadeCardPDF(frames, shades)` — unchanged logic, crops `frames[shade.frameIndex]` for each detected shade.
5. UI progress messages update to reflect "Uploading frames for detection..." / "Analyzing..." instead of "OCR: frame X/Y".

## Security

- `GEMINI_API_KEY` stored as a Cloudflare Worker secret (dashboard-managed in production), never present in any client-shipped file.
- Local development uses a `.dev.vars` file (Wrangler's standard convention), already added to `.gitignore` (confirmed not tracked by git).
- The Worker endpoint should do minimal validation (reject absurdly large payloads / non-image content) to avoid becoming an open proxy for arbitrary Gemini traffic, but no user-facing auth is needed at this single-user, low-volume stage.

## Out of Scope (for this design)

- Any UI for the user to review/correct AI-misread numbers before PDF generation (could be a future enhancement if misreads turn out to be common in practice; not built now).
- Multi-user auth/rate-limiting on the Worker endpoint (fine at current single-user/~100-video-per-month scale; would need revisiting if this "extends to public" as mentioned).
- Retry/offline-queueing for failed detection attempts.

## Open Questions for Implementation (not blocking design approval)

- Exact Gemini model name/version to call (a current "flash"-tier model, chosen at implementation time against Google's live model list, since names/versions change).
- Exact prompt wording (will be iterated against real test frames during implementation, same "build → test → diagnose → fix" discipline used for the rest of this project).
