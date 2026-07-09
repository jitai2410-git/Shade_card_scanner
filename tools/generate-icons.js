const { createCanvas } = require('canvas');
const fs = require('fs');

function makeIcon(size, outPath) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#e94560';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f1f1f1';
  ctx.font = `bold ${size * 0.28}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SC', size / 2, size / 2);
  fs.mkdirSync('icons', { recursive: true });
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  console.log(`Wrote ${outPath} (${size}x${size})`);
}

makeIcon(192, 'icons/icon-192.png');
makeIcon(512, 'icons/icon-512.png');
