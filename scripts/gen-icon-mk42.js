const Jimp = require('jimp');
const pngToIco = require('png-to-ico');
const fs = require('fs');
const path = require('path');

const SIZE = 512;

async function main() {
  const img = new Jimp(SIZE, SIZE, 0x00000000);

  const radius = 80, pad = 8;
  for (let y = pad; y < SIZE - pad; y++) {
    for (let x = pad; x < SIZE - pad; x++) {
      const dx = Math.min(x - pad, SIZE - pad - 1 - x);
      const dy = Math.min(y - pad, SIZE - pad - 1 - y);
      if (dx < radius && dy < radius) {
        if (Math.sqrt((radius - dx) ** 2 + (radius - dy) ** 2) > radius) continue;
      }
      const t = y / SIZE;
      const r = Math.round(10 + t * 16);
      const g = Math.round(14 + t * 17);
      const b = Math.round(39 + t * 39);
      img.setPixelColor(Jimp.rgbaToInt(r, g, b, 255), x, y);
    }
  }

  // 光环
  const cx = SIZE / 2, cy = SIZE / 2, ringR = 200, ringW = 3;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (Math.abs(dist - ringR) < ringW) {
        const alpha = Math.max(0, 1 - Math.abs(dist - ringR) / ringW);
        const a = Math.round(alpha * 80);
        const existing = img.getPixelColor(x, y);
        if (existing !== 0x00000000) {
          img.setPixelColor(blend(existing, Jimp.rgbaToInt(200, 170, 80, a)), x, y);
        }
      }
    }
  }

  // 六边形网格
  for (let y = 60; y < SIZE - 60; y += 40) {
    for (let x = 60; x < SIZE - 60; x += 46) {
      const oy = ((x / 46) | 0) % 2 === 0 ? 0 : 20;
      const py = y + oy;
      if (py < 60 || py >= SIZE - 60) continue;
      const dist = Math.sqrt((x - cx) ** 2 + (py - cy) ** 2);
      if (dist > 190 || dist < 100) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = x + dx, ppy = py + dy;
          if (px >= 0 && px < SIZE && ppy >= 0 && ppy < SIZE) {
            const e = img.getPixelColor(px, ppy);
            if (e !== 0x00000000) img.setPixelColor(blend(e, Jimp.rgbaToInt(100, 140, 200, 30)), px, ppy);
          }
        }
      }
    }
  }

  const font64 = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const font32 = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);

  // MK42
  const text = 'MK42';
  const tw = Jimp.measureText(font64, text);
  const th = Jimp.measureTextHeight(font64, text, SIZE);
  const textImg = new Jimp(SIZE, SIZE, 0x00000000);
  textImg.print(font64, (SIZE - tw) / 2, (SIZE - th) / 2 - 30, text);
  textImg.scan(0, 0, SIZE, SIZE, function (x, y, idx) {
    const a = this.bitmap.data[idx + 3];
    if (a > 0) {
      const t = x / SIZE;
      this.bitmap.data[idx] = Math.round(212 + t * 28);
      this.bitmap.data[idx + 1] = Math.round(168 + t * 44);
      this.bitmap.data[idx + 2] = Math.round(67 + t * 71);
    }
  });
  img.composite(textImg, 0, 0);

  // MARK
  const sub = 'MARK';
  const sw = Jimp.measureText(font32, sub);
  const subImg = new Jimp(SIZE, SIZE, 0x00000000);
  subImg.print(font32, (SIZE - sw) / 2, (SIZE + th) / 2 - 10, sub);
  subImg.scan(0, 0, SIZE, SIZE, function (x, y, idx) {
    const a = this.bitmap.data[idx + 3];
    if (a > 0) {
      this.bitmap.data[idx] = 180;
      this.bitmap.data[idx + 1] = 190;
      this.bitmap.data[idx + 2] = 220;
      this.bitmap.data[idx + 3] = Math.round(a * 0.8);
    }
  });
  img.composite(subImg, 0, 0);

  const buildDir = path.join(__dirname, '..', 'build');
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
  const pngPath = path.join(buildDir, 'icon.png');
  await img.writeAsync(pngPath);

  const img256 = img.clone().resize(256, 256);
  const buf256 = await img256.getBufferAsync(Jimp.MIME_PNG);
  const ico = await pngToIco(buf256);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log('done');
}

function blend(base, overlay) {
  const br = (base >> 24) & 0xFF, bg = (base >> 16) & 0xFF, bb = (base >> 8) & 0xFF;
  const or = (overlay >> 24) & 0xFF, og = (overlay >> 16) & 0xFF, ob = (overlay >> 8) & 0xFF;
  const oa = (overlay & 0xFF) / 255;
  return Jimp.rgbaToInt(
    Math.round(br * (1 - oa) + or * oa),
    Math.round(bg * (1 - oa) + og * oa),
    Math.round(bb * (1 - oa) + ob * oa), 255);
}

main().catch(e => { console.error(e); process.exit(1); });
