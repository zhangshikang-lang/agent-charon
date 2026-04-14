/**
 * 阿里企业邮箱群发引擎
 * 从 web-send.js 重构为 EventEmitter class
 * 所有配置从外部传入，无硬编码
 */
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { createDataSource } = require('./data-source');
const { findBrowserPath } = require('./browser-finder');
const { translateError } = require('./error-i18n');

let puppeteer = null;
function loadPuppeteer() {
  if (!puppeteer) puppeteer = require('puppeteer');
  return puppeteer;
}

// Mac 上浏览器快捷键用 Meta（Cmd），Windows/Linux 用 Control
const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

// ============ 工具函数 ============

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

function formatNumber(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

/** 模板变量替换 */
function applyTemplateVariables(tpl, data) {
  let { subject, body, bodyHtml } = tpl;
  const vars = {
    '{{username}}': data.username || '',
    '{{offer_price}}': data.offerPrice || '',
    '{{region}}': data.regionGroup || '',
    '{{followers}}': data.followers ? formatNumber(data.followers) : '',
  };
  for (const [key, val] of Object.entries(vars)) {
    subject = subject.replaceAll(key, val);
    body = body.replaceAll(key, val);
    if (bodyHtml) bodyHtml = bodyHtml.replaceAll(key, val);
  }
  return { subject, body, bodyHtml };
}

/** 检测模板是否包含变量占位符 */
function templateHasVariables(tpl) {
  const all = (tpl.subject || '') + (tpl.body || '') + (tpl.bodyHtml || '');
  return all.includes('{{');
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

function beijingDate() { return new Date(Date.now() + 8 * 3600 * 1000); }
function timestamp() {
  const d = beijingDate();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
function beijingDateKey() {
  const d = beijingDate();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function beijingNow() {
  const d = beijingDate();
  const h = d.getUTCHours(), m = d.getUTCMinutes(), sec = d.getUTCSeconds();
  return { hour: h, minute: m, second: sec, minuteOfDay: h * 60 + m };
}

// ============ Sender 引擎类 ============

class Sender extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.running = false;
    this._stopRequested = false;
    this._browser = null; // 浏览器复用

    // 数据目录
    this.dataDir = path.join(app.getPath('userData'), 'sender-data');
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

    this.sendLogPath = path.join(this.dataDir, 'send-log.json');
    this.chromeProfileDir = path.join(this.dataDir, 'chrome-profile');
    this.screenshotDir = path.join(this.dataDir, 'screenshots');
    if (!fs.existsSync(this.screenshotDir)) fs.mkdirSync(this.screenshotDir, { recursive: true });

    // 发送参数
    const sn = config.sender || {};
    this.loginEmail = sn.loginEmail || '';
    this.loginPassword = sn.loginPassword || '';
    this.accounts = (sn.accounts || []).filter(a => a.enabled);
    this.templates = (sn.templates || []).filter(t => t.enabled);
    this.batchSize = sn.batchSize || 25;
    this.dailyTotal = sn.dailyTotal || 500;
    this.autoLoop = !!sn.autoLoop;

    // 计算调度窗口（分钟）
    if (sn.scheduleEnabled && sn.scheduleStart && sn.scheduleEnd) {
      const [sh, sm] = sn.scheduleStart.split(':').map(Number);
      const [eh, em] = sn.scheduleEnd.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      this.scheduleWindow = startMin <= endMin
        ? endMin - startMin
        : 1440 - startMin + endMin;
      if (this.scheduleWindow <= 0) this.scheduleWindow = 1440;
    } else {
      this.scheduleWindow = 1440; // 无定时 = 24小时
    }

    // 自动计算批次和间隔
    this.totalBatches = Math.ceil(this.dailyTotal / this.batchSize);
    const minInterval = this.accounts.length > 1 ? 30 : 60;
    const idealInterval = Math.floor(this.scheduleWindow / Math.max(this.totalBatches, 1));
    this.intervalMinutes = Math.max(idealInterval, minInterval);

    // 如果最小间隔限制了实际可发批次
    const maxBatches = Math.floor(this.scheduleWindow / this.intervalMinutes);
    if (maxBatches < this.totalBatches) {
      this.totalBatches = maxBatches;
    }
  }

  log(msg) {
    const line = `[${timestamp()}] ${msg}`;
    this.emit('log', line);
  }

  // ============ 发送日志 ============

  loadSendLog() {
    try {
      if (fs.existsSync(this.sendLogPath)) return JSON.parse(fs.readFileSync(this.sendLogPath, 'utf-8'));
    } catch (e) { }
    return { sent: {}, dailyCounts: {} };
  }

  saveSendLog(logData) {
    try {
      fs.writeFileSync(this.sendLogPath, JSON.stringify(logData, null, 2));
    } catch (e) {
      this.log(`⚠️ 日志写入失败: ${translateError(e.message)}`);
      if (isFatalError(e)) {
        this.log(`❌ 致命错误：本地文件不可写，自动停止`);
        this.emit('fatal-error', `本地文件写入失败: ${translateError(e.message)}`);
        this._stopRequested = true;
      }
    }
  }

  // ============ 浏览器管理 ============

  async launchBrowser() {
    const pup = loadPuppeteer();
    if (!fs.existsSync(this.chromeProfileDir)) fs.mkdirSync(this.chromeProfileDir, { recursive: true });

    const executablePath = findBrowserPath();
    if (!executablePath) {
      throw new Error('未找到 Chrome 或 Edge 浏览器，请安装 Google Chrome 或使用系统自带 Edge');
    }
    this.log(`使用浏览器: ${executablePath}`);

    const browser = await pup.launch({
      headless: false,
      executablePath,
      userDataDir: this.chromeProfileDir,
      defaultViewport: { width: 1400, height: 900 },
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--lang=zh-CN',
      ],
    });
    this.log('已启动邮箱浏览器');
    return browser;
  }

  // ============ 登录检测 ============

  async isLoggedIn(page) {
    try {
      const url = page.url();
      if (url.includes('/auth/login')) return false;
      const text = await page.evaluate(() => document.body.innerText);
      return text.includes('写邮件') || text.includes('收件箱');
    } catch (e) { return false; }
  }

  async waitForLogin(page) {
    this.log('🔐 检查登录状态...');

    const currentUrl = page.url();
    if (currentUrl.includes('qiye.aliyun.com/alimail')) {
      if (await this.isLoggedIn(page)) {
        this.log('   ✅ 已登录');
        return true;
      }
    }

    try {
      await page.goto('https://qiye.aliyun.com/alimail', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    } catch (e) {
      this.log(`   导航提示: ${translateError(e.message)}`);
      await sleep(2000);
    }

    if (await this.isLoggedIn(page)) {
      this.log('   ✅ 已登录');
      return true;
    }

    this.log('   📌 请在弹出的浏览器窗口手动登录阿里企业邮箱');
    this.emit('login-required', '请在弹出的浏览器窗口登录阿里企业邮箱，登录后自动继续');

    for (let i = 0; i < 120; i++) { // 等6分钟
      await sleep(3000);
      if (this._stopRequested) return false;
      if (await this.isLoggedIn(page)) {
        this.log('   ✅ 登录成功!');
        return true;
      }
    }

    this.log('   ❌ 登录超时');
    return false;
  }

  // ============ 写邮件页面操作 ============

  async navigateToCompose(page) {
    this.log('   导航到写邮件页面...');
    await page.goto('https://qiye.aliyun.com/alimail/entries/v5.1/compose', {
      waitUntil: 'networkidle2', timeout: 30000,
    });
    await sleep(5000);

    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(el => ({
        class: el.className.substring(0, 80),
        id: el.id,
      }));
    });
    const hasInput = inputs.some(i => i.class.includes('ant-select') || i.id.includes('rc_select'));
    this.log(`   写邮件页面加载${hasInput ? '成功' : '失败'}`);
    return hasInput;
  }

  async switchSender(page, senderEmail) {
    this.log(`   切换发件人 → ${senderEmail}`);

    const currentInfo = await page.evaluate(() => {
      const NOISE = ['退信', 'mailer-daemon', 'mailsupport', 'postmaster', 'no-reply'];
      const allEls = Array.from(document.querySelectorAll('*'));
      const candidates = [];
      for (const el of allEls) {
        const text = (el.textContent || '').trim();
        const rect = el.getBoundingClientRect();
        if (text.includes('@') && rect.y > 700 && rect.height < 40 && rect.width > 50 && rect.width < 500 && text.length < 100) {
          const lower = text.toLowerCase();
          if (NOISE.some(n => lower.includes(n))) continue;
          candidates.push({ text: text.substring(0, 80), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName });
        }
      }
      return candidates.find(c => c.tag === 'BUTTON') || candidates[0] || null;
    });

    if (!currentInfo) { this.log('   ⚠️ 未找到发件人选择器'); return false; }
    if (currentInfo.text.includes(senderEmail)) { this.log('   ✅ 已是目标发件人'); return true; }

    await page.mouse.click(currentInfo.x, currentInfo.y);
    await sleep(1500);

    const menuItem = await page.evaluate((email) => {
      const allEls = Array.from(document.querySelectorAll('*'));
      for (const el of allEls) {
        const text = (el.textContent || '').trim();
        const rect = el.getBoundingClientRect();
        if ((text === email || (text.includes(email) && text.length < 80)) && rect.width > 0 && rect.height > 0 && rect.height < 40) {
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
      return null;
    }, senderEmail);

    if (!menuItem) {
      this.log(`   ⚠️ 未找到发件人选项: ${senderEmail}`);
      await page.mouse.click(400, 400);
      await sleep(500);
      return false;
    }

    await page.mouse.click(menuItem.x, menuItem.y);
    await sleep(1000);
    return true;
  }

  async fillRecipients(page, emails) {
    this.log(`   填写 ${emails.length} 个收件人...`);

    await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('*'));
      for (const el of allEls) {
        if (el.children.length === 0 && el.textContent.trim() === '收件人') {
          let row = el.parentElement;
          for (let d = 0; d < 5 && row; d++) {
            const editable = row.querySelector('[contenteditable="true"]');
            if (editable) { editable.click(); editable.focus(); return; }
            const input = row.querySelector('input:not([type="checkbox"])');
            if (input) { input.click(); input.focus(); return; }
            row = row.parentElement;
          }
          break;
        }
      }
    });
    await sleep(1000);

    for (let i = 0; i < emails.length; i++) {
      if (i > 0) {
        await page.evaluate(() => {
          const allEls = Array.from(document.querySelectorAll('*'));
          for (const el of allEls) {
            if (el.children.length === 0 && el.textContent.trim() === '收件人') {
              let row = el.parentElement;
              for (let d = 0; d < 5 && row; d++) {
                const editable = row.querySelector('[contenteditable="true"]');
                if (editable) { editable.click(); editable.focus(); return; }
                const input = row.querySelector('input:not([type="checkbox"]):not(#rc_select_0)');
                if (input) { input.click(); input.focus(); return; }
                row = row.parentElement;
              }
              break;
            }
          }
        });
        await sleep(300);
      }
      await page.keyboard.type(emails[i], { delay: 30 });
      await sleep(500);
      await page.keyboard.press('Enter');
      await sleep(600);
      if ((i + 1) % 5 === 0 || i === 0) this.log(`      已填写 ${i + 1}/${emails.length}`);
    }

    this.log('   收件人填写完成');
    return true;
  }

  async clickSeparateSend(page) {
    this.log('   点击分别发送...');
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('分别发送'));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) this.log('   ⚠️ 未找到分别发送按钮');
    await sleep(800);
    return clicked;
  }

  async insertTemplate(page, templateNum) {
    this.log(`   插入模板 tiktok建联 ${templateNum}...`);

    const btnPos = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('*'));
      for (const el of allEls) {
        if ((el.textContent || '').trim() === '插入模板' && el.children.length <= 2) {
          const rect = el.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
      const btn = document.querySelector('div#sqm_23');
      if (btn) { const rect = btn.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }
      return null;
    });

    if (!btnPos) { this.log('   ❌ 找不到插入模板按钮'); return false; }

    await page.mouse.click(btnPos.x, btnPos.y);
    await sleep(2000);

    const templateName = `tiktok建联 ${templateNum}`;
    const templatePos = await page.evaluate((name) => {
      const allEls = Array.from(document.querySelectorAll('*'));
      for (const el of allEls) {
        const text = (el.textContent || '').trim();
        if ((text === name || (text.includes(name) && text.length < 50)) && el.children.length <= 2) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
      return null;
    }, templateName);

    if (!templatePos) { this.log(`   ❌ 未找到模板: ${templateName}`); return false; }

    await page.mouse.click(templatePos.x, templatePos.y);
    await sleep(2000);

    // 处理确认弹窗
    const confirmBtn = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.ant-modal button, .ant-btn'));
      for (const b of btns) {
        const t = (b.textContent || '').trim();
        if (['确定', '确认', 'OK', '替换'].includes(t)) {
          const rect = b.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
      return null;
    });
    if (confirmBtn) { await page.mouse.click(confirmBtn.x, confirmBtn.y); await sleep(1000); }

    this.log('   ✅ 模板已插入');
    return true;
  }

  async manualFillSubjectAndBody(page, subject, body, bodyHtml) {
    this.log('   手动填写主题...');

    // 多策略查找主题输入框
    const subjectPos = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('*'));

      // 策略1: 通过"主题"/"主 题"标签定位同行 input
      for (const el of allEls) {
        const raw = (el.textContent || '').trim();
        const normalized = raw.replace(/\s+/g, '');
        if (normalized === '主题' && el.children.length === 0) {
          let row = el.parentElement;
          for (let d = 0; d < 8 && row; d++) {
            const inputs = row.querySelectorAll('input');
            for (const input of inputs) {
              const rect = input.getBoundingClientRect();
              if (rect.width > 100 && input.type !== 'checkbox' && input.type !== 'hidden' && input.type !== 'radio') {
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, method: 'label' };
              }
            }
            row = row.parentElement;
          }
          break;
        }
      }

      // 策略2: 通过 placeholder 查找
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const inp of inputs) {
        const ph = (inp.placeholder || '');
        if (ph.includes('主题') || ph.toLowerCase().includes('subject')) {
          const rect = inp.getBoundingClientRect();
          if (rect.width > 100) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, method: 'placeholder' };
        }
      }

      // 策略3: 找编辑器 iframe 上方最近的宽 input（收件人下方、正文上方）
      const iframe = document.querySelector('iframe.e_iframe, iframe[id*="editor"]');
      const iframeY = iframe ? iframe.getBoundingClientRect().y : 600;
      const wideInputs = inputs.filter(inp => {
        const rect = inp.getBoundingClientRect();
        return rect.width > 300 && rect.height >= 20 && rect.height < 60
          && rect.y > 50 && rect.y < iframeY
          && inp.type !== 'checkbox' && inp.type !== 'hidden' && inp.type !== 'radio';
      });
      if (wideInputs.length > 0) {
        const best = wideInputs[wideInputs.length - 1];
        const rect = best.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, method: 'position' };
      }

      return null;
    });

    if (subjectPos) {
      await page.mouse.click(subjectPos.x, subjectPos.y);
      await sleep(300);
      // Ctrl+A 选中已有内容再覆盖
      await page.keyboard.down(MOD_KEY);
      await page.keyboard.press('a');
      await page.keyboard.up(MOD_KEY);
      await sleep(100);
      await page.keyboard.type(subject, { delay: 10 });
      this.log(`   ✅ 主题已填写 (${subjectPos.method})`);
    } else {
      this.log('   ⚠️ 未找到主题输入框');
    }
    await sleep(500);

    this.log('   手动填写正文...');
    let editorFrame = null;
    const iframeEl = await page.$('iframe.e_iframe');
    if (iframeEl) editorFrame = await iframeEl.contentFrame();
    if (!editorFrame) {
      for (const frame of page.frames()) {
        try { if (await frame.$('body[contenteditable]')) { editorFrame = frame; break; } } catch (e) { }
      }
    }

    if (editorFrame) {
      if (bodyHtml) {
        // 富文本模式：直接写入 HTML
        await editorFrame.evaluate((html) => {
          const body = document.querySelector('body[contenteditable]') || document.body;
          body.innerHTML = html;
        }, bodyHtml);
        this.log('   ✅ 正文已填写（富文本）');
      } else {
        // 纯文本回退
        await editorFrame.click('body');
        await page.keyboard.down(MOD_KEY);
        await page.keyboard.press('Home');
        await page.keyboard.up(MOD_KEY);
        await sleep(300);
        await page.keyboard.type(body, { delay: 5 });
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        this.log('   ✅ 正文已填写');
      }
    }
    await sleep(500);
  }

  async clickSend(page) {
    this.log('   点击发送...');
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a, span')).find(b => (b.textContent || '').trim() === '发送');
      if (btn) btn.click();
    });
    await sleep(3000);

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.ant-modal button, .ant-confirm button, button'))
        .find(b => ['确定', '确定发送', '确认'].includes((b.textContent || '').trim()));
      if (btn) btn.click();
    });
    await sleep(3000);
    return true;
  }

  async checkSendResult(page) {
    const result = await page.evaluate(() => {
      const text = document.body.innerText || '';
      if (text.includes('发送成功') || text.includes('已发送')) return 'success';
      if (text.includes('发送失败') || text.includes('错误')) return 'fail';
      if (text.includes('收件箱') && !text.includes('写邮件页面')) return 'likely_success';
      return 'unknown';
    });
    return result;
  }

  // ============ 核心：写邮件并发送 ============

  async composeAndSend(page, opts) {
    const { emails, senderEmail, templateIdx, separateSend = true } = opts;
    this.log(`📝 写邮件: ${emails.length} 个收件人, 发件人 ${senderEmail || '默认'}`);

    if (!(await this.navigateToCompose(page))) {
      return { success: false, error: '无法打开写邮件页面' };
    }

    if (senderEmail) await this.switchSender(page, senderEmail);

    if (!(await this.fillRecipients(page, emails))) {
      return { success: false, error: '收件人填写失败' };
    }

    if (emails.length > 1 && separateSend) await this.clickSeparateSend(page);

    // 直接手动填写主题和正文（不依赖阿里邮箱模板）
    let usedTemplateName = '';
    if (this.templates.length > 0) {
      const tplIndex = templateIdx % this.templates.length;
      const tpl = this.templates[tplIndex];
      await this.manualFillSubjectAndBody(page, tpl.subject, tpl.body, tpl.bodyHtml);
      usedTemplateName = `模板 ${tplIndex + 1}`;
    } else {
      this.log('   ⚠️ 未配置邮件模板，请在设置中添加');
      return { success: false, error: '未配置邮件模板', template: '' };
    }

    // 截图留证
    try {
      await page.screenshot({ path: path.join(this.screenshotDir, `compose-${Date.now()}.png`), fullPage: true });
    } catch (e) { }

    await this.clickSend(page);

    const result = await this.checkSendResult(page);
    if (result === 'success' || result === 'likely_success') {
      this.log(`   ✅ 发送成功! (${emails.length} 封)`);
      return { success: true, template: usedTemplateName };
    } else if (result === 'fail') {
      this.log('   ❌ 发送失败');
      return { success: false, error: '发送失败', template: usedTemplateName };
    } else {
      this.log(`   ⚠️ 发送状态不确定，按成功处理`);
      return { success: true, uncertain: true, template: usedTemplateName };
    }
  }

  // ============ 单批次发送 ============

  async sendOneBatch(page, senderEmail, ds) {
    this.log(`📬 开始批次: ${senderEmail}`);

    const unsentRows = await ds.readUnsent();
    if (unsentRows.length === 0) {
      this.log('⚠️ 没有待发送的数据');
      return { sent: 0, error: '无数据' };
    }

    const sendLog = this.loadSendLog();
    const batch = [];
    for (const row of unsentRows) {
      if (batch.length >= this.batchSize) break;
      const email = (row[2] || '').trim(); // C列=email
      if (!email || !isValidEmail(email)) continue;
      if (sendLog.sent && sendLog.sent[email]) continue;
      batch.push({
        url: row[0] || '', username: row[1] || '', email,
        followers: row[3] || '', offerPrice: row[4] || '',
        priceCeiling: row[5] || '', regionGroup: row[6] || '', category: row[7] || '',
      });
    }

    if (batch.length === 0) {
      this.log('⚠️ 没有可发送的新邮箱');
      return { sent: 0, error: '无可发送邮箱' };
    }

    this.log(`📋 本批: ${batch.length} 个收件人`);

    const templateIdx = randomInt(0, Math.max(0, this.templates.length - 1));
    const tpl = this.templates.length > 0 ? this.templates[templateIdx % this.templates.length] : null;
    if (!tpl) {
      this.log('⚠️ 未配置邮件模板');
      return { sent: 0, error: '未配置邮件模板' };
    }
    const templateInfo = `模板 ${(templateIdx % this.templates.length) + 1}`;

    // 判断发送模式
    const sn = this.config.sender || {};
    const perRecipientMode = sn.perRecipientMode || 'auto';
    const usePerRecipient = perRecipientMode === 'always' ||
      (perRecipientMode === 'auto' && templateHasVariables(tpl));

    let totalSentInBatch = 0;

    if (usePerRecipient) {
      // ── 逐人发送模式 ──
      this.log('   📝 逐人发送模式（模板含变量）');
      for (const recipient of batch) {
        if (this._stopRequested) break;

        const personalized = applyTemplateVariables(tpl, recipient);

        if (!(await this.navigateToCompose(page))) {
          this.log(`   ⚠️ 跳过 ${recipient.email}: 无法打开写邮件页面`);
          continue;
        }
        if (senderEmail) await this.switchSender(page, senderEmail);
        if (!(await this.fillRecipients(page, [recipient.email]))) continue;
        await this.manualFillSubjectAndBody(page, personalized.subject, personalized.body, personalized.bodyHtml);

        try {
          await page.screenshot({ path: path.join(this.screenshotDir, `compose-${Date.now()}.png`), fullPage: true });
        } catch (_) { }

        await this.clickSend(page);
        const result = await this.checkSendResult(page);

        if (result === 'success' || result === 'likely_success' || result === 'unknown') {
          totalSentInBatch++;
          const now = timestamp();
          sendLog.sent = sendLog.sent || {};
          sendLog.sent[recipient.email] = { at: now, by: senderEmail, template: templateInfo };
          const dateKey = beijingDateKey();
          sendLog.dailyCounts = sendLog.dailyCounts || {};
          sendLog.dailyCounts[dateKey] = (sendLog.dailyCounts[dateKey] || 0) + 1;
          this.saveSendLog(sendLog);

          try {
            await ds.moveToSent([[recipient.url, recipient.username, recipient.email,
              now, senderEmail, templateInfo, recipient.offerPrice, recipient.priceCeiling]]);
            await ds.deleteUnsentByEmails([recipient.email]);
          } catch (e) {
            this.log(`   ⚠️ 数据源更新失败: ${translateError(e.message)}`);
            if (isFatalError(e)) {
              this.emit('fatal-error', `数据写入失败: ${translateError(e.message)}`);
              this._stopRequested = true;
              break;
            }
          }
          this.log(`   ✅ ${recipient.email} ($${recipient.offerPrice || '?'})`);
        } else {
          this.log(`   ❌ ${recipient.email} 发送失败`);
        }

        await sleep(randomInt(2000, 4000));
      }

      this.log(`✅ 批次完成: 逐人发送 ${totalSentInBatch}/${batch.length} 封`);
      return { sent: totalSentInBatch, error: null };

    } else {
      // ── 批量发送模式（原逻辑） ──
      const result = await this.composeAndSend(page, {
        emails: batch.map(b => b.email),
        senderEmail,
        templateIdx,
        separateSend: true,
      });

      if (result.success) {
        const now = timestamp();
        sendLog.sent = sendLog.sent || {};
        for (const b of batch) {
          sendLog.sent[b.email] = { at: now, by: senderEmail, template: templateInfo };
        }
        const dateKey = beijingDateKey();
        sendLog.dailyCounts = sendLog.dailyCounts || {};
        sendLog.dailyCounts[dateKey] = (sendLog.dailyCounts[dateKey] || 0) + batch.length;
        this.saveSendLog(sendLog);

        try {
          const sentRows = batch.map(b => [b.url, b.username, b.email, now, senderEmail, templateInfo, b.offerPrice, b.priceCeiling]);
          await ds.moveToSent(sentRows);
          await ds.deleteUnsentByEmails(batch.map(b => b.email));
          this.log(`   数据源已更新: +${batch.length} 已发送, -${batch.length} 未发送`);
        } catch (e) {
          this.log(`   ⚠️ 数据源更新失败: ${translateError(e.message)}`);
          if (isFatalError(e)) {
            this.log(`❌ 致命错误：数据源不可写，自动停止`);
            this.emit('fatal-error', `数据写入失败: ${translateError(e.message)}`);
            this._stopRequested = true;
            return { sent: batch.length, error: null, fatal: true };
          }
        }

        this.log(`✅ 批次完成: 发送 ${batch.length} 封`);
        return { sent: batch.length, error: null };
      } else {
        this.log(`❌ 批次失败: ${result.error}`);
        return { sent: 0, error: result.error };
      }
    }
  }

  // ============ 批次队列生成 ============

  generateBatchQueue() {
    // 所有账号轮流发，直到达到 totalBatches
    const queue = [];
    for (let i = 0; i < this.totalBatches; i++) {
      const account = this.accounts[i % this.accounts.length];
      queue.push({ email: account.email, batchNum: i + 1 });
    }
    return queue;
  }

  // ============ 主流程 ============

  async start() {
    if (this.running) return;
    if (this.accounts.length === 0) {
      this.emit('error', '未配置发件邮箱账号，请先在设置中添加');
      return;
    }

    this.running = true;
    this._stopRequested = false;

    try {
      // 浏览器复用：检查现有实例是否还活着
      let browser = this._browser;
      if (browser) {
        try { await browser.pages(); } catch { browser = null; this._browser = null; }
      }
      if (!browser) {
        browser = await this.launchBrowser();
        this._browser = browser;
      } else {
        this.log('复用已有浏览器实例');
      }
      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

      const loggedIn = await this.waitForLogin(page);
      if (!loggedIn) {
        this.emit('error', '登录失败，请在弹出的浏览器窗口手动登录后重试');
        this.running = false;
        return;
      }

      // 根据发送来源切换数据 sheet
      const sn = this.config.sender || {};
      const effectiveConfig = sn.source === 'ig'
        ? { ...this.config, dataSource: { ...this.config.dataSource, tabs: { queue: 'IG待爬取', unsent: 'IG未发送', sent: 'IG已发送' } } }
        : this.config;
      const ds = createDataSource(effectiveConfig);
      await ds.init();

      do {
        const batchQueue = this.generateBatchQueue();
        const actualDaily = this.totalBatches * this.batchSize;
        this.log('');
        this.log('═'.repeat(55));
        this.log('  邮件群发引擎');
        this.log(`  目标: ${this.dailyTotal} 封/天（实际 ${actualDaily} 封）`);
        this.log(`  ${this.accounts.length} 个账号轮发 | ${batchQueue.length} 批 × ${this.batchSize} 封`);
        this.log(`  间隔: ${this.intervalMinutes} 分钟`);
        if (this.autoLoop) this.log('  🔄 自动循环: 开启');
        this.log('═'.repeat(55));

        let totalSent = 0;
        let noData = false;

        for (let i = 0; i < batchQueue.length && !this._stopRequested; i++) {
          const slot = batchQueue[i];

          // 批次之间等待（第一批不等）
          if (i > 0) {
            const jitter = randomInt(
              Math.max(1, Math.floor(this.intervalMinutes * 0.8)),
              Math.ceil(this.intervalMinutes * 1.2)
            );
            this.log(`⏳ 等待 ${jitter} 分钟后发送下一批...`);

            const waitMs = jitter * 60 * 1000;
            const interval = 30000;
            let waited = 0;
            while (waited < waitMs && !this._stopRequested) {
              await sleep(Math.min(interval, waitMs - waited));
              waited += interval;
            }
            if (this._stopRequested) break;
          }

          this.log(`\n📮 第 ${i + 1}/${batchQueue.length} 批 | ${slot.email}`);

          try {
            if (!(await this.isLoggedIn(page))) {
              this.log('⚠️ 登录过期，重新登录...');
              if (!(await this.waitForLogin(page))) {
                this.log('❌ 重新登录失败，跳过本批');
                continue;
              }
            }

            const { sent, error } = await this.sendOneBatch(page, slot.email, ds);
            if (sent > 0) {
              totalSent += sent;
              this.emit('progress', { today: totalSent, account: slot.email });
            } else if (error === '无数据' || error === '无可发送邮箱') {
              this.log('📭 数据已发完');
              noData = true;
              break;
            }
          } catch (e) {
            this.log(`❌ 批次异常: ${translateError(e.message)}`);
          }
        }

        this.log(`\n🏁 本轮完毕: 成功 ${totalSent} 封`);

        if (this._stopRequested) break;

        // 不循环则结束
        if (!this.autoLoop) {
          this.log('✅ 发送完成（未开启自动循环）');
          break;
        }

        // 数据发完了也没必要循环
        if (noData) {
          this.log('📭 无待发数据，自动循环结束');
          break;
        }

        // 等到次日 00:05 北京时间
        const now = new Date();
        const bjNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
        const bjTomorrow = new Date(bjNow);
        bjTomorrow.setDate(bjTomorrow.getDate() + 1);
        bjTomorrow.setHours(0, 5, 0, 0);
        const waitMs = bjTomorrow.getTime() - bjNow.getTime();
        const waitHours = (waitMs / 3600000).toFixed(1);

        this.log(`⏳ [自动循环] 今日发送完毕，等待 ${waitHours} 小时后继续`);

        const interval = 30000;
        let waited = 0;
        while (waited < waitMs && !this._stopRequested) {
          await sleep(Math.min(interval, waitMs - waited));
          waited += interval;
        }
        if (this._stopRequested) break;
        this.log('⏰ 新的一天开始，继续发送...');
      } while (true);

      // 浏览器不关闭，保留复用
      this.log('浏览器保持运行，下次启动可复用');
      this.emit('done', {});
    } catch (e) {
      this.emit('error', translateError(e.message));
    } finally {
      this.running = false;
    }
  }

  stop() {
    this._stopRequested = true;
    this.log('正在停止...');
  }

  /** 彻底关闭浏览器（引擎销毁时调用） */
  async closeBrowser() {
    if (this._browser) {
      try { await this._browser.close(); } catch {}
      this._browser = null;
    }
  }

  getStatus() {
    return { running: this.running, stopping: this._stopRequested };
  }
}

module.exports = Sender;
