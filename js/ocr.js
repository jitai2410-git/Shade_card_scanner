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
