/**
 * 自动更新
 * 启动时检查 Boss 电脑上有没有新版本
 * 有新版 → 弹窗提示 → 用户点确定 → 自动下载安装
 * 没有新版 → 完全静默
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { app, dialog, BrowserWindow } = require('electron');
const { execFile } = require('child_process');

const HOSTS = ['LAPTOP-8OOEUQFC', '10.254.52.165'];
const PORT = 9900;
const CURRENT_VERSION = app.getVersion();

function checkAndUpdate() {
  // 自动更新仅 Windows 支持（NSIS 安装包）
  if (process.platform !== 'win32') return;
  tryCheck(0);
}

function tryCheck(idx) {
  if (idx >= HOSTS.length) return;

  const req = http.get({
    hostname: HOSTS[idx],
    port: PORT,
    path: '/update/check',
    timeout: 5000,
  }, (res) => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      try {
        const info = JSON.parse(body);
        if (info.available && isNewer(info.version, CURRENT_VERSION)) {
          promptAndUpdate(HOSTS[idx], info);
        }
      } catch {}
    });
  });

  req.on('error', () => tryCheck(idx + 1));
  req.on('timeout', () => { req.destroy(); tryCheck(idx + 1); });
}

function isNewer(remote, local) {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

async function promptAndUpdate(host, info) {
  const win = BrowserWindow.getAllWindows()[0] || null;
  const result = await dialog.showMessageBox(win, {
    type: 'info',
    title: '发现新版本',
    message: `有新版本 v${info.version} 可用（当前 v${CURRENT_VERSION}）`,
    detail: '点击"更新"将自动下载并安装，安装完成后软件会自动重启。',
    buttons: ['更新', '稍后'],
    defaultId: 0,
  });

  if (result.response === 0) {
    download(host, info.filename);
  }
}

function download(host, filename) {
  const tmpDir = path.join(app.getPath('temp'), 'charon-update');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const destFile = path.join(tmpDir, filename);

  // 如果已经下载过同一个文件就直接安装
  if (fs.existsSync(destFile)) {
    install(destFile);
    return;
  }

  const file = fs.createWriteStream(destFile);

  const req = http.get({
    hostname: host,
    port: PORT,
    path: '/update/download',
    timeout: 120000,
  }, (res) => {
    if (res.statusCode !== 200) { file.close(); return; }
    res.pipe(file);
    file.on('finish', () => {
      file.close();
      install(destFile);
    });
  });

  req.on('error', () => { file.close(); });
  req.on('timeout', () => { req.destroy(); file.close(); });
}

function install(exePath) {
  // /S = 静默安装（NSIS 参数）
  execFile(exePath, ['/S'], { detached: true, stdio: 'ignore' });
  setTimeout(() => app.quit(), 2000);
}

module.exports = { checkAndUpdate };
