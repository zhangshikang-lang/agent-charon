/**
 * Instagram 达人邮箱爬取引擎
 * 与 scraper.js (TikTok) 保持相同的 EventEmitter 接口
 */
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { createDataSource } = require('./data-source');
const { findBrowserPath } = require('./browser-finder');
const { translateError } = require('./error-i18n');
const { sleep, randomInt, timestamp, beijingDateKey, isFatalError } = require('./utils');
const { TABS } = require('./data-source');

let puppeteer = null;
let StealthPlugin = null;

function loadPuppeteer() {
  if (!puppeteer) {
    puppeteer = require('puppeteer-extra');
    StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  }
  return puppeteer;
}

// ============ 常量 ============

const IG_APP_ID = '936619743392459';
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const SKIP_DOMAINS = new Set(['instagram.com', 'facebook.com', 'meta.com', 'fbcdn.net',
  'cdninstagram.com', 'example.com', 'test.com', 'sentry.io']);

// ============ 工具函数 ============

function extractEmail(text, myEmails) {
  if (!text) return null;
  const hits = text.match(EMAIL_REGEX) || [];
  for (let e of hits) {
    e = e.replace(/^[^a-zA-Z0-9]+/, '');
    const lower = e.toLowerCase();
    const d = lower.split('@')[1];
    if (d && !SKIP_DOMAINS.has(d) && !myEmails.has(lower)) return lower;
  }
  return null;
}

function extractLinktree(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/(?:www\.)?linktr\.ee\/[^\s"'<>]+/i)
         || text.match(/linktr\.ee\/[^\s"'<>]+/i);
  if (!m) return null;
  const url = m[0].startsWith('http') ? m[0] : 'https://' + m[0];
  return url.replace(/\/$/, '');
}

function extractUsername(url) {
  const m = url.match(/instagram\.com\/([^\/\?#]+)/);
  return m ? m[1] : url;
}

/** 把 username 或不完整的输入归一化为完整 IG 链接 */
function normalizeIGLink(raw) {
  if (/instagram\.com/i.test(raw)) return raw; // 已经是完整链接
  const username = raw.trim().replace(/^@/, '');
  return `https://www.instagram.com/${username}`;
}

// ============ IGScraper 引擎类 ============

class IGScraper extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.running = false;
    this._stopRequested = false;

    this.dataDir = path.join(app.getPath('userData'), 'ig-scraper-data');
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

    this.scrapeLogPath = path.join(this.dataDir, 'ig-scrape-log.json');
    this.progressPath  = path.join(this.dataDir, 'ig-scrape-progress.json');
    this.chromeProfileDir = path.join(this.dataDir, 'ig-chrome-profile');

    const ig = config.igScraper || {};
    this.dailyLimit  = ig.dailyLimit  || 500;
    this.delayMin    = ig.delayMin    || 8000;
    this.delayMax    = ig.delayMax    || 15000;
    this.autoLoop    = !!ig.autoLoop;
    this.pageTimeout = 30000;
    this.maxRetries  = 2;

    // 自己账号的邮箱，用于过滤 IG API bug 污染
    const rawEmails = (ig.myEmails || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    this.myEmails = new Set(rawEmails);
  }

  log(msg) {
    this.emit('log', `[${timestamp()}] ${msg}`);
  }

  // ============ 日志持久化 ============

  loadScrapeLog() {
    try {
      if (fs.existsSync(this.scrapeLogPath)) return JSON.parse(fs.readFileSync(this.scrapeLogPath, 'utf-8'));
    } catch (e) { }
    return { scraped: {}, dailyCounts: {} };
  }

  saveScrapeLog(data) {
    try {
      fs.writeFileSync(this.scrapeLogPath, JSON.stringify(data, null, 2));
    } catch (e) {
      this.log(`⚠️ 日志写入失败: ${translateError(e.message)}`);
      if (isFatalError(e)) {
        this.log(`❌ 致命错误：本地文件不可写，自动停止`);
        this.emit('fatal-error', `本地文件写入失败: ${translateError(e.message)}`);
        this._stopRequested = true;
      }
    }
  }

  loadProgress() {
    try {
      if (fs.existsSync(this.progressPath)) return JSON.parse(fs.readFileSync(this.progressPath, 'utf-8'));
    } catch (e) { }
    return { lastIndex: 0, date: '' };
  }

  saveProgress(data) {
    try {
      fs.writeFileSync(this.progressPath, JSON.stringify(data));
    } catch (e) {
      if (isFatalError(e)) {
        this.log(`❌ 致命错误：本地文件不可写，自动停止`);
        this.emit('fatal-error', `本地文件写入失败: ${translateError(e.message)}`);
        this._stopRequested = true;
      }
    }
  }

  // ============ 浏览器（有头模式 + 实例复用） ============

  async launchBrowser() {
    const pup = loadPuppeteer();
    if (!fs.existsSync(this.chromeProfileDir)) fs.mkdirSync(this.chromeProfileDir, { recursive: true });

    const executablePath = findBrowserPath();
    if (!executablePath) throw new Error('未找到 Chrome 或 Edge，请安装后重试');
    this.log(`浏览器: ${executablePath}`);

    return await pup.launch({
      headless: false,
      executablePath,
      userDataDir: this.chromeProfileDir,
      defaultViewport: null,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,900',
      ],
    });
  }

  /** 获取或复用浏览器实例 */
  async getBrowser() {
    if (this._browser) {
      try { await this._browser.pages(); return this._browser; } catch { this._browser = null; }
    }
    this._browser = await this.launchBrowser();
    return this._browser;
  }

  // ============ 登录（打开浏览器让用户手动登录） ============

  async login() {
    this.log('🌐 打开浏览器，请在窗口中登录 Instagram...');
    const browser = await this.getBrowser();
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
    this.emit('login-opened');
  }

  async confirmLogin() {
    if (!this._browser) return { ok: false };
    try {
      const pages = await this._browser.pages();
      const page = pages[0];
      const url = page ? page.url() : '';
      if (url.includes('/accounts/login/')) {
        this.log('❌ 仍在登录页，请确认已完成登录');
        return { ok: false };
      }
      this.log('✅ 登录成功！Cookie 已保存，下次启动无需再登录');
    } catch (e) { /* ignore */ }
    // 不关浏览器，保持复用
    return { ok: true };
  }

  /** 获取当前浏览器实例（跨实例复用，同步） */
  getBrowserInstance() { return this._browser; }

  /** 设置浏览器实例（跨实例复用） */
  setBrowser(browser) { this._browser = browser; }

  /** 关闭浏览器（引擎销毁时调用） */
  async closeBrowser() {
    if (this._browser) {
      try { await this._browser.close(); } catch {}
      this._browser = null;
    }
  }

  // ============ Linktree ============

  async scrapeLinktree(page, url) {
    try {
      this.log(`   🔗 Linktree: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.pageTimeout });
      await sleep(2000);

      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      const email = extractEmail(bodyText, this.myEmails);
      if (email) return email;

      const fromLinks = await page.evaluate((skipDoms, myEmails) => {
        const RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        const skip = new Set(skipDoms);
        const mine = new Set(myEmails);
        for (const a of document.querySelectorAll('a[href]')) {
          const m = a.href.match(RE);
          if (m) for (const e of m) {
            const lower = e.toLowerCase();
            const d = lower.split('@')[1];
            if (d && !skip.has(d) && !mine.has(lower)) return lower;
          }
        }
        return null;
      }, [...SKIP_DOMAINS], [...this.myEmails]);

      return fromLinks;
    } catch (e) {
      this.log(`   ⚠️ Linktree 访问失败: ${translateError(e.message)}`);
      return null;
    }
  }

  // ============ 单页爬取 ============

  async scrapeProfile(page, url) {
    const user = extractUsername(url);
    const result = { username: user, url, email: null, bio: null, linktree: null, error: null };

    try {
      // 策略1: GraphQL API（登录后有效）
      const apiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${user}`;
      const res = await page.evaluate(async (apiUrl, appId) => {
        try {
          const r = await fetch(apiUrl, {
            headers: { 'X-IG-App-ID': appId, 'X-Requested-With': 'XMLHttpRequest' },
            credentials: 'include',
          });
          return { status: r.status, text: await r.text() };
        } catch (e) { return { status: 0, text: '' }; }
      }, apiUrl, IG_APP_ID);

      if (res.status === 200) {
        let data;
        try { data = JSON.parse(res.text); } catch { /* skip */ }
        const u = data?.data?.user;
        if (u) {
          const bio = u.biography || '';
          const externalUrl = u.external_url || '';
          result.bio = bio.slice(0, 200) || null;
          result.linktree = extractLinktree(bio) || extractLinktree(externalUrl) || null;

          const candidates = [u.business_email, u.public_email,
            extractEmail(bio, this.myEmails), extractEmail(externalUrl, this.myEmails)];
          for (const c of candidates) {
            const cl = c?.toLowerCase().trim();
            if (cl && !SKIP_DOMAINS.has(cl.split('@')[1]) && !this.myEmails.has(cl)) {
              result.email = cl;
              return result;
            }
          }

          // 无邮箱且无 Linktree，直接返回
          if (!result.linktree) return result;
          // 有 Linktree，稍后访问
          return result;
        }
      }

      // 策略2+3: 访问页面
      await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: this.pageTimeout });
      if (page.url().includes('/accounts/login/')) {
        result.error = 'LOGIN_REQUIRED';
        return result;
      }

      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      if (bodyText.includes("Sorry, this page isn't available")) {
        result.error = 'NOT_FOUND';
        return result;
      }

      if (!result.bio) result.bio = bodyText.slice(0, 200).trim();
      if (!result.linktree) result.linktree = extractLinktree(bodyText);

      // 内嵌 JSON
      const fromJson = await page.evaluate((skipDoms, myEmails) => {
        function deepFind(obj, key, d) {
          if (d > 10 || !obj || typeof obj !== 'object') return null;
          if (key in obj) return obj;
          for (const v of Object.values(obj)) { const f = deepFind(v, key, d + 1); if (f) return f; }
          return null;
        }
        const RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        const skip = new Set(skipDoms);
        const mine = new Set(myEmails);
        for (const s of document.querySelectorAll('script[type="application/json"]')) {
          let d; try { d = JSON.parse(s.textContent); } catch { continue; }
          const node = deepFind(d, 'biography', 0);
          if (!node) continue;
          for (const txt of [node.biography, node.external_url]) {
            const m = (txt || '').match(RE);
            if (m) for (const e of m) {
              const lower = e.toLowerCase();
              const dom = lower.split('@')[1];
              if (dom && !skip.has(dom) && !mine.has(lower)) return lower;
            }
          }
        }
        return null;
      }, [...SKIP_DOMAINS], [...this.myEmails]);

      if (fromJson) { result.email = fromJson; return result; }

      // 全文兜底
      const e = extractEmail(bodyText, this.myEmails);
      if (e) result.email = e;

    } catch (e) {
      result.error = e.message;
      this.log(`   ❌ 失败: ${translateError(e.message)}`);
    }

    return result;
  }

  // ============ 主爬取流程 ============

  async runScrape() {
    this.log('');
    this.log('═'.repeat(50));
    this.log('  Instagram 达人邮箱爬取器');
    this.log(`  每日上限: ${this.dailyLimit}`);
    this.log('═'.repeat(50));

    // 使用 IG 专属 tab
    const igConfig = {
      ...this.config,
      dataSource: {
        ...this.config.dataSource,
        tabs: { ...TABS.IG },
      },
    };
    const ds = createDataSource(igConfig);
    await ds.init();

    const { links: rawQueue, hasHeader } = await ds.readQueue();
    const queue = rawQueue.map(normalizeIGLink);
    if (queue.length === 0) {
      this.log('📭 "IG待爬取" 为空');
      return { queueRemaining: 0 };
    }
    this.log(`📋 待爬取队列: ${queue.length} 个链接`);

    const scrapeLog = this.loadScrapeLog();
    const today = beijingDateKey();
    const todayCount = scrapeLog.dailyCounts[today] || 0;
    if (todayCount >= this.dailyLimit) {
      this.log(`⚠️ 今日已爬 ${todayCount}，达到上限 ${this.dailyLimit}`);
      return { queueRemaining: queue.length };
    }
    const maxThisRun = this.dailyLimit - todayCount;
    this.log(`📊 今日已爬: ${todayCount}，本次最多: ${maxThisRun}`);

    // 保存旧记录快照，用于重复比对
    const oldScraped = { ...scrapeLog.scraped };

    const browser = await this.getBrowser();
    const pages = await browser.pages();
    let page = pages[0] || await browser.newPage();

    const stats = { found: 0, notFound: 0, failed: 0, linktree: 0 };
    let processed = 0;
    let loginFailCount = 0;

    try {
      for (let i = 0; i < queue.length && processed < maxThisRun; i++) {
        if (this._stopRequested) { this.log('⏹️ 用户停止'); break; }

        const url = queue[i];
        const isDup = !!oldScraped[url];
        if (isDup) this.log(`[${i + 1}/${queue.length}] @${extractUsername(url)} (重复，重新爬取)`);
        else this.log(`[${i + 1}/${queue.length}] @${extractUsername(url)}`);

        let r = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
          r = await this.scrapeProfile(page, url);
          if (!r.error || r.error === 'LOGIN_REQUIRED' || r.error === 'NOT_FOUND') break;
          // detached frame: page 已废弃，换新 page 再重试
          if (r.error.includes('detached') || r.error.includes('Detached')) {
            try {
              const freshPages = await browser.pages();
              page = freshPages[0] || await browser.newPage();
              this.log(`   🔄 页面已恢复，重试 ${attempt + 1}/${this.maxRetries}...`);
            } catch { /* browser 也挂了，下面重试会继续报错 */ }
            await sleep(randomInt(3000, 5000));
            continue;
          }
          if (attempt < this.maxRetries) {
            this.log(`   重试 ${attempt + 1}/${this.maxRetries}...`);
            await sleep(randomInt(5000, 10000));
          }
        }

        // 登录失效：在当前浏览器里等待用户登录
        if (r.error === 'LOGIN_REQUIRED') {
          loginFailCount++;
          if (loginFailCount >= 2) {
            this.log('🔐 检测到登录失效，请在弹出的浏览器窗口登录 Instagram...');
            this.emit('login-required');
            await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            // 等待用户登录，最多 5 分钟
            let loggedIn = false;
            for (let w = 0; w < 100 && !this._stopRequested; w++) {
              await sleep(3000);
              const currentUrl = page.url();
              if (!currentUrl.includes('/accounts/login')) { loggedIn = true; break; }
            }
            if (!loggedIn) {
              this.log('❌ 登录超时，停止爬取');
              break;
            }
            this.log('✅ 登录成功，继续爬取...');
            loginFailCount = 0;
            // 回退重试当前这个 URL
            i--;
            continue;
          }
        }

        // 有 Linktree 且无邮箱，访问 Linktree
        if (!r.email && r.linktree) {
          const ltEmail = await this.scrapeLinktree(page, r.linktree);
          if (ltEmail) { r.email = ltEmail; stats.linktree++; }
        }

        scrapeLog.scraped[url] = {
          username: r.username,
          email: r.email,
          bio: (r.bio || '').slice(0, 200),
          linktree: r.linktree,
          error: r.error,
          at: timestamp(),
        };

        const dupNote = (isDup && oldScraped[url].email === (r.email || '')) ? '是' : '否';

        if (r.email) {
          stats.found++;
          if (dupNote === '是') this.log(`   🔁 重复（数据一致）`);
          this.log(`   ✅ ${r.username} → ${r.email}${r.linktree ? ' [Linktree]' : ''}`);
          try { await ds.addToUnsent([[url, r.username, r.email, '', '', dupNote]]); }
          catch (e) {
            this.log(`   ⚠️ 写入失败: ${translateError(e.message)}`);
            if (isFatalError(e)) {
              this.log(`❌ 致命错误：数据源不可写，自动停止`);
              this.emit('fatal-error', `数据写入失败: ${translateError(e.message)}`);
              this._stopRequested = true;
              break;
            }
          }
        } else {
          if (r.error && r.error !== 'NOT_FOUND') {
            stats.failed++;
            this.log(`   ❌ ${r.username} — ${translateError(r.error)}`);
          } else {
            stats.notFound++;
            this.log(`   📭 ${r.username} — 无结果${r.linktree ? ' (Linktree无结果)' : ''}`);
          }
          try {
            await ds.addToNoResult([[url, r.username || '', '', (r.bio || '').slice(0, 200)]]);
          } catch (e) { this.log(`   ⚠️ 写入无结果tab失败: ${e.message}`); }
        }

        try { await ds.deleteFirstQueueRow(hasHeader); }
        catch (e) {
          if (isFatalError(e)) {
            this.log(`❌ 致命错误：数据源不可写，自动停止`);
            this.emit('fatal-error', `数据写入失败: ${translateError(e.message)}`);
            this._stopRequested = true;
            break;
          }
        }

        processed++;
        scrapeLog.dailyCounts[today] = todayCount + processed;
        this.saveScrapeLog(scrapeLog);
        this.saveProgress({ lastIndex: i + 1, date: today });

        const hitRate = (stats.found + stats.notFound) > 0
          ? Math.round(stats.found / (stats.found + stats.notFound) * 100) : 0;
        this.emit('progress', {
          today: todayCount + processed,
          queue: queue.length - (i + 1),
          found: stats.found,
          failed: stats.failed,
          hitRate,
          linktree: stats.linktree,
        });

        await sleep(randomInt(this.delayMin, this.delayMax));
      }
    } finally {
      // 浏览器保持运行，下次启动可复用
      this.log('浏览器保持运行，下次启动可复用');
    }

    this.log('');
    this.log('═'.repeat(50));
    this.log(`  爬取完成`);
    this.log(`  ✅ 找到 email: ${stats.found}（其中 Linktree: ${stats.linktree}）`);
    this.log(`  ⚠️ 无 email:   ${stats.notFound}`);
    this.log(`  ❌ 失败:       ${stats.failed}`);
    this.log('═'.repeat(50));

    return { queueRemaining: queue.length - processed, stats };
  }

  // ============ 启动 ============

  async start() {
    if (this.running) return;
    this.running = true;
    this._stopRequested = false;

    try {
      do {
        const result = await this.runScrape();
        if (this._stopRequested) break;

        if (result.queueRemaining <= 0) {
          this.log('📭 IG 待爬取队列已清空');
          break;
        }

        if (!this.autoLoop) {
          this.log('✅ 本次爬取完成（未开启自动循环）');
          break;
        }

        const now = new Date();
        const bjNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
        const bjTomorrow = new Date(bjNow);
        bjTomorrow.setDate(bjTomorrow.getDate() + 1);
        bjTomorrow.setHours(0, 5, 0, 0);
        const waitMs = bjTomorrow.getTime() - bjNow.getTime();
        this.log(`⏳ 今日配额已满，等待 ${(waitMs / 3600000).toFixed(1)} 小时后继续`);
        this.emit('progress', { waiting: true });

        let waited = 0;
        while (waited < waitMs && !this._stopRequested) {
          await sleep(Math.min(30000, waitMs - waited));
          waited += 30000;
        }
        if (this._stopRequested) break;
        this.log('⏰ 新的一天，继续爬取...');
      } while (true);

      this.emit('done', {});
    } catch (e) {
      const friendly = translateError(e.message);
      this.log(`❌ ${friendly}`);
      this.emit('error', friendly);
      this.emit('done', {});
    } finally {
      this.running = false;
    }
  }

  stop() {
    this._stopRequested = true;
    this.log('正在停止 IG 爬取...');
  }

  getStatus() {
    return { running: this.running, stopping: this._stopRequested };
  }
}

module.exports = IGScraper;
