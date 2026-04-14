/**
 * 邮件扫描引擎
 * 扫描 IMAP 收件箱，提取回复者 + 检测退信
 * 从 scan-replies.js 和 check-bounces.js 合并移植
 */
const EventEmitter = require('events');
const tls = require('tls');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { createDataSource } = require('./data-source');
const { translateError } = require('./error-i18n');

const EXCLUDED_DOMAINS = [
  'hungrystudio.com', 'notice.hungrystudio.com',
  'aliyun.com', 'alimail.com', 'taobao.com',
  'mailer-daemon', 'postmaster',
  'apple.com', 'id.apple.com', 'insideapple.apple.com',
  'openai.com', 'email.openai.com',
  'notion.so', 'mail.notion.so',
  'cursor.com', 'mail.cursor.com',
  'apify.com', 'modash.io', 'influencity.com',
  'dingtalk.com', 'hr.dingtalk.com', 'eversign.com',
  'noreply', 'no-reply', 'donotreply',
];

const BOUNCE_SENDERS = ['mailer-daemon', 'postmaster'];
const BOUNCE_SUBJECTS = ['退信', 'undeliver', 'failure notice', 'delivery status notification'];

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

function isExternalEmail(email) {
  const lower = email.toLowerCase();
  return !EXCLUDED_DOMAINS.some(d => lower.endsWith('@' + d) || lower.includes(d));
}

function isBounce(fromAddresses, subject) {
  const fromLower = fromAddresses.join(',').toLowerCase();
  const subjLower = (subject || '').toLowerCase();
  return BOUNCE_SENDERS.some(s => fromLower.includes(s)) ||
         BOUNCE_SUBJECTS.some(s => subjLower.includes(s));
}

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

class MailScanner extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.running = false;
    this._stopRequested = false;

    // 从 sender 配置读取 IMAP 凭证
    const sn = config.sender || {};
    this.imapUser = sn.loginEmail || '';
    this.imapPass = sn.loginPassword || '';

    // 结果保存目录
    this.dataDir = path.join(app.getPath('userData'), 'scanner-data');
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  }

  log(msg) { this.emit('log', `[邮件扫描] ${msg}`); }

  async scanInbox() {
    if (!this.imapUser || !this.imapPass) {
      throw new Error('未配置登录邮箱/密码，请在设置中填写');
    }

    this.log('连接 IMAP 服务器...');

    const socket = await new Promise((resolve, reject) => {
      const s = tls.connect(993, 'imap.qiye.aliyun.com', { rejectUnauthorized: false }, () => resolve(s));
      s.on('error', reject);
    });

    await new Promise(r => socket.once('data', () => r()));

    // 登录（密码中的特殊字符需要引号保护）
    const escapedPass = this.imapPass.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let res = await imapCommand(socket, 'a1', `LOGIN "${this.imapUser}" "${escapedPass}"`);
    if (!res.includes('a1 OK')) {
      socket.destroy();
      throw new Error('IMAP 登录失败，请检查邮箱密码');
    }
    this.log('IMAP 登录成功');

    res = await imapCommand(socket, 'a2', 'SELECT INBOX');
    const existsMatch = res.match(/\* (\d+) EXISTS/);
    const total = existsMatch ? parseInt(existsMatch[1]) : 0;
    this.log(`收件箱共 ${total} 封邮件`);

    const replies = new Map(); // email -> { name, email, count }
    const bounces = [];
    const batchSize = 200;

    for (let start = 1; start <= total && !this._stopRequested; start += batchSize) {
      const end = Math.min(start + batchSize - 1, total);
      this.log(`扫描 ${start}-${end} / ${total}`);
      this.emit('progress', { scanned: end, total });

      res = await imapCommand(socket, `f${start}`, `FETCH ${start}:${end} (ENVELOPE)`);

      const lines = res.split('\n');
      for (const line of lines) {
        const envMatch = line.match(/ENVELOPE \(([^)]*"[^)]*)\)/);
        if (!envMatch) continue;

        // 提取发件人
        let fromEmails = [];
        let fromName = '';

        // 格式1: "name" <email>
        const fromMatches = [...line.matchAll(/"([^"]*)" <([^>]+)>/g)];
        for (const m of fromMatches) {
          fromName = m[1];
          fromEmails.push(m[2].toLowerCase());
        }

        // 格式2: ("name" NIL "user" "domain")
        if (fromEmails.length === 0) {
          const nilMatches = [...line.matchAll(/\("([^"]*)" NIL "([^"]*)" "([^"]*)"\)/g)];
          for (const m of nilMatches) {
            fromName = m[1];
            fromEmails.push((m[2] + '@' + m[3]).toLowerCase());
          }
        }

        // 提取主题（简单匹配）
        const subjMatch = line.match(/"([^"]*)" \(\(/);
        const subject = subjMatch ? decodeMimeName(subjMatch[1]) : '';

        // 检测退信
        if (isBounce(fromEmails, subject)) {
          bounces.push({ date: new Date().toISOString().substring(0, 16), subject });
          continue;
        }

        // 记录回复者
        for (const email of fromEmails) {
          if (isExternalEmail(email)) {
            const decoded = decodeMimeName(fromName);
            if (!replies.has(email)) {
              replies.set(email, { name: decoded, email, count: 0 });
            }
            replies.get(email).count++;
            break;
          }
        }
      }
    }

    try {
      await imapCommand(socket, 'a9', 'LOGOUT');
    } catch {}
    socket.destroy();

    const replyList = [...replies.values()].sort((a, b) => b.count - a.count);
    this.log(`扫描完成: ${replyList.length} 个回复者, ${bounces.length} 封退信`);

    return { replies: replyList, bounces };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this._stopRequested = false;

    try {
      const { replies, bounces } = await this.scanInbox();

      if (this._stopRequested) {
        this.emit('done', { replies: 0, bounces: 0 });
        return;
      }

      // 保存结果到本地 JSON
      const resultPath = path.join(this.dataDir, 'last-scan.json');
      fs.writeFileSync(resultPath, JSON.stringify({ replies, bounces, scannedAt: new Date().toISOString() }, null, 2));

      // 写入数据源
      try {
        const ds = createDataSource(this.config);
        await ds.init();
        if (replies.length > 0) {
          await ds.writeReplies(replies);
          this.log(`已写入 ${replies.length} 条回复数据`);
        }
        if (bounces.length > 0) {
          await ds.writeBounces(bounces);
          this.log(`已写入 ${bounces.length} 条退信数据`);
        }
      } catch (e) {
        this.log(`⚠️ 写入数据源失败: ${translateError(e.message)}`);
        const msg = (e.message || '').toLowerCase();
        if (msg.includes('does not have permission') || msg.includes('insufficient authentication') ||
            msg.includes('invalid_grant') || e.code === 'EPERM' || e.code === 'EACCES') {
          this.emit('fatal-error', `数据写入失败: ${translateError(e.message)}`);
        }
      }

      // 输出前10
      if (replies.length > 0) {
        this.log('--- 回复排行（前10）---');
        replies.slice(0, 10).forEach(d => this.log(`  ${d.email} (${d.count}封) ${d.name}`));
      }
      if (bounces.length > 0) {
        this.log(`--- 退信 ${bounces.length} 封 ---`);
        bounces.slice(0, 5).forEach(b => this.log(`  ${b.subject}`));
      }

      this.emit('progress', { replies: replies.length, bounces: bounces.length });
      this.emit('done', { replies: replies.length, bounces: bounces.length });
    } catch (e) {
      this.emit('error', translateError(e.message));
    } finally {
      this.running = false;
    }
  }

  stop() {
    this._stopRequested = true;
    this.log('正在停止扫描...');
  }

  getStatus() {
    return { running: this.running, stopping: this._stopRequested };
  }
}

module.exports = MailScanner;
