window.detectShades = async function detectShades(frames) {
  const log = window.SCSLogger.log;
  const results = [];
  let lastNumber = null;

  const worker = await Tesseract.createWorker('eng');
  try {
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '11',
    });

    for (let i = 0; i < frames.length; i++) {
      log(`OCR: frame ${i + 1}/${frames.length}`);
      let data;
      try {
        const res = await worker.recognize(frames[i].blob);
        data = res.data;
      } catch (err) {
        log(`OCR: frame ${i + 1} failed: ${err.message}`);
        lastNumber = null;
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
  } finally {
    await worker.terminate();
  }

  log(`OCR: done, ${results.length} unique shades detected`);
  return results;
};
