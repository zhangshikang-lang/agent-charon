/**
 * 更新流程端到端测试
 *
 * 做三件事：
 * 1. 在 update-server 放一个假的高版本 exe
 * 2. 启动 HTTP 服务器（模拟 data-receiver 的更新接口）
 * 3. 启动一个独立 Electron 窗口，模拟员工端检测更新
 *
 * 用法: electron scripts/test-update.js
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { app, dialog, BrowserWindow } = require('electron');

// ── 配置 ──
const FAKE_VERSION = '9.9.9';
const CURRENT_VERSION = '1.0.0'; // 假装员工端是旧版
const PORT = 9901; // 用不同端口，不和正式服务冲突
let UPDATE_DIR;

// ── Step 1: 创建假的高版本安装包 ──
function prepareFakeUpdate() {
  if (!fs.existsSync(UPDATE_DIR)) fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const fakeName = `Agent Charon Setup ${FAKE_VERSION}.exe`;
  const fakePath = path.join(UPDATE_DIR, fakeName);
  if (!fs.existsSync(fakePath)) {
    // 写一个 1KB 的假文件
    fs.writeFileSync(fakePath, Buffer.alloc(1024, 0x90));
    console.log(`[test] 创建假安装包: ${fakeName}`);
  }
  return { fakeName, fakePath };
}

// ── Step 2: 启动测试用 HTTP 服务器 ──
function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (req.method === 'GET' && req.url === '/update/check') {
        console.log('[test-server] 收到版本检查请求');
        const files = fs.readdirSync(UPDATE_DIR).filter(f => f.endsWith('.exe'));
        if (files.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ available: false }));
          return;
        }
        const latest = files.sort().pop();
        const verMatch = latest.match(/(\d+\.\d+\.\d+)/);
        const version = verMatch ? verMatch[1] : '0.0.0';
        const info = { available: true, version, filename: latest };
        console.log(`[test-server] 返回: ${JSON.stringify(info)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
        return;
      }

      if (req.method === 'GET' && req.url === '/update/download') {
        const files = fs.readdirSync(UPDATE_DIR).filter(f => f.endsWith('.exe'));
        const latest = files.sort().pop();
        if (!latest) { res.writeHead(404); res.end(); return; }
        const filePath = path.join(UPDATE_DIR, latest);
        const stat = fs.statSync(filePath);
        console.log(`[test-server] 开始下载: ${latest} (${stat.size} bytes)`);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${latest}"`,
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      res.writeHead(200);
      res.end('test-update-server');
    });

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[test-server] 启动在端口 ${PORT}`);
      resolve(server);
    });
  });
}

// ── Step 3: 模拟员工端检查更新 ──
function isNewer(remote, local) {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

async function simulateClientUpdate() {
  console.log(`[test-client] 当前版本: v${CURRENT_VERSION}`);
  console.log(`[test-client] 检查更新: http://127.0.0.1:${PORT}/update/check`);

  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/update/check',
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', async () => {
        try {
          const info = JSON.parse(body);
          console.log(`[test-client] 服务端返回: ${JSON.stringify(info)}`);

          if (info.available && isNewer(info.version, CURRENT_VERSION)) {
            console.log(`[test-client] 发现新版本 v${info.version}，弹窗提示...`);

            // 弹出和正式逻辑一模一样的弹窗
            const win = BrowserWindow.getAllWindows()[0] || null;
            const result = await dialog.showMessageBox(win, {
              type: 'info',
              title: '发现新版本',
              message: `有新版本 v${info.version} 可用（当前 v${CURRENT_VERSION}）`,
              detail: '点击"更新"将自动下载并安装，安装完成后软件会自动重启。\n\n⚠️ 这是测试模式，点击"更新"只会下载不会真的安装。',
              buttons: ['更新', '稍后'],
              defaultId: 0,
            });

            if (result.response === 0) {
              console.log('[test-client] 用户点击了"更新"，开始下载...');
              await testDownload();
            } else {
              console.log('[test-client] 用户点击了"稍后"');
            }
          } else {
            console.log('[test-client] 无可用更新');
          }
        } catch (e) {
          console.log(`[test-client] 解析失败: ${e.message}`);
        }
        resolve();
      });
    });

    req.on('error', (e) => {
      console.log(`[test-client] 连接失败: ${e.message}`);
      resolve();
    });
  });
}

function testDownload() {
  return new Promise((resolve) => {
    const tmpDir = path.join(app.getPath('temp'), 'charon-update-test');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const req = http.get({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/update/download',
      timeout: 30000,
    }, (res) => {
      const filename = 'test-download.exe';
      const destFile = path.join(tmpDir, filename);
      const file = fs.createWriteStream(destFile);
      res.pipe(file);
      file.on('finish', async () => {
        file.close();
        const stat = fs.statSync(destFile);
        console.log(`[test-client] 下载完成: ${destFile} (${stat.size} bytes)`);

        await dialog.showMessageBox(null, {
          type: 'info',
          title: '测试完成',
          message: '更新流程测试通过！',
          detail: `下载成功: ${stat.size} bytes\n保存位置: ${destFile}\n\n（测试模式不会执行安装）`,
          buttons: ['确定'],
        });

        // 清理测试下载
        try { fs.unlinkSync(destFile); } catch {}

        resolve();
      });
    });

    req.on('error', (e) => {
      console.log(`[test-client] 下载失败: ${e.message}`);
      resolve();
    });
  });
}

// ── 主流程 ──
app.whenReady().then(async () => {
  UPDATE_DIR = path.join(app.getPath('userData'), 'update-server');
  console.log('\n=== 更新流程端到端测试 ===\n');

  // Step 1
  const { fakeName } = prepareFakeUpdate();
  console.log(`[test] update-server 目录: ${UPDATE_DIR}`);
  console.log(`[test] 假安装包: ${fakeName}\n`);

  // Step 2
  const server = await startTestServer();

  // Step 3
  await simulateClientUpdate();

  // 清理
  server.close();
  console.log('\n[test] 测试结束');

  // 清理假的高版本安装包
  const fakePath = path.join(UPDATE_DIR, fakeName);
  try { fs.unlinkSync(fakePath); console.log(`[test] 已清理假安装包`); } catch {}

  app.quit();
});

app.on('window-all-closed', () => {});
