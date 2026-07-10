# Testing Shade Card Scanner on your phone

## Update: internet requirement (2026-07-10)

Shade detection now uses an AI service (Google Gemini) instead of running entirely on your phone, because real-world testing found the on-device approach couldn't read actual fabric labels reliably. This means:
- You need an internet connection **every time you scan a video**, not just the first visit.
- Frame extraction and PDF building still happen on your phone; only the "read the shade numbers" step goes over the internet.
- If detection fails (no internet, or the service is temporarily down), you'll see the same red error banner as other failures — just retry once you have a connection.

## First-time setup
1. Deploy this folder to Cloudflare Workers (or open the deployed URL if already live: https://shadecardscanner.jitai2410.workers.dev).
2. On your Android phone, open the URL in **Chrome** (not another browser — this app is built and tested against Chrome).
3. You need an internet connection every time you use the app now (see note above) — the video-processing tools (~15MB) still cache after the first visit and work offline, but the shade-detection step itself always needs a connection.

## Basic test
1. Film a short (under 1 minute) flip-through video of a few fabric shade cards, holding the phone steady and making sure the shade numbers are in focus and well-lit.
2. Open the app, tap **Select Fabric Video**, choose your video.
3. Watch the progress messages: "Extracting frames...", "Analyzing N frames...", "Building PDF...".
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
4. Advanced: visiting `/test-harness.html` on the deployed site shows PASS/FAIL for each required library, useful if the whole app fails to load.
