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

  try {
    await ffmpeg.writeFile(inputName, await FFmpegUtil.fetchFile(file));

    const fps = 1 / intervalSec;
    const outPattern = 'frame_%04d.jpg';
    log(`extractFrames: running fps=${fps},scale=min(${maxWidth},iw):-2`);
    // -huffman 0 works around a confirmed bug in @ffmpeg/core@0.12.10's wasm build:
    // the mjpeg encoder's optimal-Huffman-table computation crashes with
    // "RuntimeError: memory access out of bounds" (reproduced even for a single
    // frame, single.jpg, with no -vf at all). The native CLI ffmpeg build does not
    // exhibit this — it's wasm-specific. Forcing default (non-optimal) Huffman
    // tables avoids the crashing code path entirely; JPEG output is still valid,
    // just marginally larger than with optimal tables.
    await ffmpeg.exec(['-i', inputName, '-vf', `fps=${fps},scale='min(${maxWidth},iw)':-2`, '-q:v', '3', '-huffman', '0', outPattern]);

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
  } finally {
    ffmpeg.terminate();
  }
};
