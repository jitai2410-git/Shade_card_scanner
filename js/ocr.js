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
