const fs = require('fs');
const pdfParse = require('pdf-parse');

async function main() {
  const base64Path = process.argv[2];
  if (!base64Path) {
    console.error('Usage: node verify-phase3-pdf.js <path-to-base64-txt>');
    process.exit(1);
  }
  const base64 = fs.readFileSync(base64Path, 'utf8').trim();
  const buffer = Buffer.from(base64, 'base64');
  const outPath = base64Path.replace(/\.txt$/, '.pdf');
  fs.writeFileSync(outPath, buffer);

  const data = await pdfParse(buffer);
  console.log('Pages:', data.numpages);
  console.log('Text:', JSON.stringify(data.text));

  const expected = ['701', '702', '703'];
  const missing = expected.filter(n => !data.text.includes(n));

  const imageMatches = buffer.toString('latin1').match(/\/Subtype\s*\/Image/g);
  const imageCount = imageMatches ? imageMatches.length : 0;
  console.log('Image count:', imageCount);

  if (data.numpages < 1) { console.error('FAIL: no pages'); process.exit(1); }
  if (missing.length > 0) { console.error('FAIL: missing labels', missing); process.exit(1); }
  if (imageCount < 3) { console.error('FAIL: expected at least 3 images, found', imageCount); process.exit(1); }

  console.log('PASS: PDF is valid, contains labels', expected, 'and', imageCount, 'images');
  process.exit(0);
}

main();
