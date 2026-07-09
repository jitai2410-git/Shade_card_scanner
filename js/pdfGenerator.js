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
