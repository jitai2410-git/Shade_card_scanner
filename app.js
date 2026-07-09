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
  const TIMEOUT_MS = 10000;
  return new Promise((resolve, reject) => {
    const videoEl = document.createElement('video');
    videoEl.preload = 'metadata';

    const timer = setTimeout(() => {
      URL.revokeObjectURL(videoEl.src);
      reject(new Error(`Could not read this video's info within ${TIMEOUT_MS / 1000} seconds. The file may be corrupt or in an unsupported format.`));
    }, TIMEOUT_MS);

    videoEl.onloadedmetadata = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(videoEl.src);
      resolve(videoEl.duration);
    };
    videoEl.onerror = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(videoEl.src);
      reject(new Error('Could not read video metadata — is this a valid video file?'));
    };
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
