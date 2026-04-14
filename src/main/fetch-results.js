/**
 * 拉取分析结果
 * 员工端定时从 Boss 电脑获取自己的邮件分析报告
 * 结果存本地，供 UI 展示
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { store, decryptPassword } = require('./config');

const HOSTS = ['LAPTOP-8OOEUQFC', '10.254.52.165'];
const PORT = 9900;
const LOCAL_RESULT = path.join(app.getPath('userData'), 'my-analysis.json');

function fetchResults() {
  const config = store.store || {};
  const sn = config.sender || {};
  const account = sn.loginEmail;
  if (!account) return;

  tryFetch(0, account);
}

function tryFetch(idx, account) {
  if (idx >= HOSTS.length) return;

  const req = http.get({
    hostname: HOSTS[idx],
    port: PORT,
    path: `/results?account=${encodeURIComponent(account)}`,
    timeout: 5000,
  }, (res) => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.available !== false) {
          fs.writeFileSync(LOCAL_RESULT, JSON.stringify(data, null, 2));
        }
      } catch {}
    });
  });

  req.on('error', () => tryFetch(idx + 1, account));
  req.on('timeout', () => { req.destroy(); tryFetch(idx + 1, account); });
}

function getLocalResults() {
  try {
    if (fs.existsSync(LOCAL_RESULT)) {
      return JSON.parse(fs.readFileSync(LOCAL_RESULT, 'utf8'));
    }
  } catch {}
  return null;
}

module.exports = { fetchResults, getLocalResults };
