/**
 * 数据接收器
 * Boss 电脑上运行的 HTTP 服务器，接收员工上报的邮件采集数据
 * 端口 9900，数据按员工邮箱分文件存储
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const PORT = 9900;
const DATA_DIR = path.join(app.getPath('userData'), 'received-data');
const UPDATE_DIR = path.join(app.getPath('userData'), 'update-server');
const RESULTS_DIR = path.join(app.getPath('userData'), 'analysis-results');

let server = null;

function start() {
  if (server) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPDATE_DIR)) fs.mkdirSync(UPDATE_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  server = http.createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 版本检查：返回 update-server 目录下最新安装包的版本号
    if (req.method === 'GET' && req.url === '/update/check') {
      const info = getLatestUpdate();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
      return;
    }

    // 下载安装包
    if (req.method === 'GET' && req.url === '/update/download') {
      const info = getLatestUpdate();
      if (!info.available) {
        res.writeHead(404);
        res.end('No update available');
        return;
      }
      const filePath = path.join(UPDATE_DIR, info.filename);
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${info.filename}"`,
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // 员工拉取自己的分析结果：GET /results?account=xxx@xxx.com
    if (req.method === 'GET' && req.url.startsWith('/results')) {
      const url = new URL(req.url, 'http://localhost');
      const account = (url.searchParams.get('account') || '').trim();
      if (!account) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing account' }));
        return;
      }
      const key = account.replace(/@/g, '_at_').replace(/\./g, '_');
      const resultFile = path.join(RESULTS_DIR, `${key}.json`);
      try {
        if (fs.existsSync(resultFile)) {
          const data = fs.readFileSync(resultFile, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(data);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ available: false }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/report') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const account = (data.account || 'unknown').replace(/@/g, '_at_').replace(/\./g, '_');
          const date = new Date().toISOString().slice(0, 10);
          const filename = `${account}_${date}.json`;
          const destFile = path.join(DATA_DIR, filename);

          // 追加模式：如果今天已有文件，合并数据
          let existing = [];
          try {
            if (fs.existsSync(destFile)) {
              existing = JSON.parse(fs.readFileSync(destFile, 'utf8'));
            }
          } catch {}

          const emails = data.emails || [];
          // 按 uid+folder 去重
          const seen = new Set(existing.map(e => `${e.uid}_${e.folder}`));
          const newEmails = emails.filter(e => !seen.has(`${e.uid}_${e.folder}`));
          existing.push(...newEmails);

          fs.writeFileSync(destFile, JSON.stringify(existing, null, 2));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, received: newEmails.length, total: existing.length }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else {
      // 健康检查
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'charon-receiver' }));
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[数据接收器] 监听端口 ${PORT}`);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`[数据接收器] 端口 ${PORT} 已被占用，跳过`);
      server = null;
    }
  });
}

function stop() {
  if (server) {
    server.close();
    server = null;
  }
}

function getDataDir() {
  return DATA_DIR;
}

function getLatestUpdate() {
  try {
    const files = fs.readdirSync(UPDATE_DIR).filter(f => f.endsWith('.exe') || f.endsWith('.dmg'));
    if (files.length === 0) return { available: false };

    // 从文件名提取版本号，如 "Agent Charon Setup 2.1.0.exe" → "2.1.0"
    const latest = files.sort().pop();
    const verMatch = latest.match(/(\d+\.\d+\.\d+)/);
    const version = verMatch ? verMatch[1] : '0.0.0';
    return { available: true, version, filename: latest };
  } catch {
    return { available: false };
  }
}

module.exports = { start, stop, getDataDir };
