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
