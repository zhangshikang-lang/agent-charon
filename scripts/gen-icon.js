/**
 * 生成 Omar 42 应用图标
 * 深蓝渐变背景 + 金色 O42 + 圆角矩形
 */
const Jimp = require('jimp');
const path = require('path');
const pngToIco = require('png-to-ico');
const fs = require('fs');

const SIZE = 512;
const OUT_PNG = path.join(__dirname, '..', 'build', 'icon.png');
const OUT_ICO = path.join(__dirname, '..', 'build', 'icon.ico');

async function main() {
  const img = new Jimp(SIZE, SIZE, 0x00000000);

  // 圆角矩形背景
  const radius = 80;
  const pad = 8;
  for (let y = pad; y < SIZE - pad; y++) {
    for (let x = pad; x < SIZE - pad; x++) {
      const dx = Math.min(x - pad, SIZE - pad - 1 - x);
      const dy = Math.min(y - pad, SIZE - pad - 1 - y);

      // 圆角检测
      if (dx < radius && dy < radius) {
        const dist = Math.sqrt((radius - dx) ** 2 + (radius - dy) ** 2);
        if (dist > radius) continue;
      }

      // 渐变背景：从深蓝 (#0a0e27) 到靛蓝 (#1a1f4e)
      const t = y / SIZE;
      const r = Math.round(10 + t * 16);
      const g = Math.round(14 + t * 17);
      const b = Math.round(39 + t * 39);
      const color = Jimp.rgbaToInt(r, g, b, 255);
      img.setPixelColor(color, x, y);
    }
  }

  // 装饰: 外圈光环
  const cx = SIZE / 2, cy = SIZE / 2;
  const ringR = 200;
  const ringW = 3;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (Math.abs(dist - ringR) < ringW) {
        const alpha = Math.max(0, 1 - Math.abs(dist - ringR) / ringW);
        const a = Math.round(alpha * 80);
        const existing = img.getPixelColor(x, y);
        if (existing !== 0x00000000) {
          // 叠加金色光环
          const gold = Jimp.rgbaToInt(200, 170, 80, a);
          img.setPixelColor(blendColor(existing, gold), x, y);
        }
      }
    }
  }

  // 装饰: 内部六边形网格（微弱）
  for (let y = 60; y < SIZE - 60; y += 40) {
    for (let x = 60; x < SIZE - 60; x += 46) {
      const offsetY = ((x / 46) | 0) % 2 === 0 ? 0 : 20;
      const py = y + offsetY;
      if (py < 60 || py >= SIZE - 60) continue;
      const dist = Math.sqrt((x - cx) ** 2 + (py - cy) ** 2);
      if (dist > 190 || dist < 100) continue;
      // 小点
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = x + dx, ppy = py + dy;
          if (px >= 0 && px < SIZE && ppy >= 0 && ppy < SIZE) {
            const existing = img.getPixelColor(px, ppy);
            if (existing !== 0x00000000) {
              const dot = Jimp.rgbaToInt(100, 140, 200, 30);
              img.setPixelColor(blendColor(existing, dot), px, ppy);
            }
          }
        }
      }
    }
  }

  // 写文字 "O42" — 使用内置字体
  const font64 = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const font32 = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);

  // 大号 "O42"
  const text = 'O42';
  const tw = Jimp.measureText(font64, text);
  const th = Jimp.measureTextHeight(font64, text, SIZE);

  // 先画到临时图，再叠加成金色
  const textImg = new Jimp(SIZE, SIZE, 0x00000000);
  textImg.print(font64, (SIZE - tw) / 2, (SIZE - th) / 2 - 30, text);

  // 给文字染金色
  textImg.scan(0, 0, SIZE, SIZE, function (x, y, idx) {
    const a = this.bitmap.data[idx + 3];
    if (a > 0) {
      // 金色渐变: #D4A843 到 #F0D48A
      const t = x / SIZE;
      this.bitmap.data[idx] = Math.round(212 + t * 28);     // R
      this.bitmap.data[idx + 1] = Math.round(168 + t * 44); // G
      this.bitmap.data[idx + 2] = Math.round(67 + t * 71);  // B
    }
  });
  img.composite(textImg, 0, 0);

  // 副标题 "OMAR"
  const sub = 'OMAR';
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

  // 保存 PNG
  const buildDir = path.dirname(OUT_PNG);
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
  await img.writeAsync(OUT_PNG);
  console.log('PNG saved:', OUT_PNG);

  // 生成 ICO（含多尺寸）
  // 先生成 256x256 版本
  const img256 = img.clone().resize(256, 256);
  const png256 = path.join(buildDir, 'icon-256.png');
  await img256.writeAsync(png256);

  const icoBuf = await pngToIco([fs.readFileSync(OUT_PNG), fs.readFileSync(png256)]);
  fs.writeFileSync(OUT_ICO, icoBuf);
  console.log('ICO saved:', OUT_ICO);

  // 清理临时文件
  fs.unlinkSync(png256);
}

function blendColor(base, overlay) {
  const br = (base >> 24) & 0xFF;
  const bg = (base >> 16) & 0xFF;
  const bb = (base >> 8) & 0xFF;
  const or = (overlay >> 24) & 0xFF;
  const og = (overlay >> 16) & 0xFF;
  const ob = (overlay >> 8) & 0xFF;
  const oa = ((overlay) & 0xFF) / 255;
  const r = Math.round(br * (1 - oa) + or * oa);
  const g = Math.round(bg * (1 - oa) + og * oa);
  const b = Math.round(bb * (1 - oa) + ob * oa);
  return Jimp.rgbaToInt(r, g, b, 255);
}

main().catch(e => { console.error(e); process.exit(1); });
