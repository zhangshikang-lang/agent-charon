/**
 * Build 完成后自动把安装包复制到 update-server 目录
 * 员工端下次启动就能检测到新版本并自动更新
 */
const path = require('path');
const fs = require('fs');

const DIST_DIR = path.join(__dirname, '..', 'dist', 'win');
const UPDATE_DIR = path.join(process.env.APPDATA, 'mark-42', 'update-server');

// 确保目标目录存在
if (!fs.existsSync(UPDATE_DIR)) fs.mkdirSync(UPDATE_DIR, { recursive: true });

// 找到刚 build 出来的安装包
const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.exe') && f.includes('Setup'));
if (files.length === 0) {
  console.log('[deploy] 没找到安装包，跳过');
  process.exit(0);
}

const latest = files.sort().pop();
const src = path.join(DIST_DIR, latest);
const dest = path.join(UPDATE_DIR, latest);

// 清理旧版本安装包
const oldFiles = fs.readdirSync(UPDATE_DIR).filter(f => f.endsWith('.exe'));
for (const old of oldFiles) {
  if (old !== latest) {
    fs.unlinkSync(path.join(UPDATE_DIR, old));
    console.log(`[deploy] 删除旧版: ${old}`);
  }
}

// 复制新安装包
if (!fs.existsSync(dest)) {
  fs.copyFileSync(src, dest);
  console.log(`[deploy] 已部署: ${latest} → ${UPDATE_DIR}`);
} else {
  console.log(`[deploy] ${latest} 已存在，跳过`);
}
