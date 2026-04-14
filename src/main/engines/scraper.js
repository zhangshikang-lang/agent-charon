/**
 * TikTok 达人邮箱爬取引擎
 * 从 tiktok-scraper.js 重构为 EventEmitter class
 * 所有配置从外部传入，无硬编码
 */
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { createDataSource } = require('./data-source');
const { findBrowserPath } = require('./browser-finder');
const { calculateQuote } = require('./pricing-engine');
const TikWMClient = require('./tikwm-client');

// Puppeteer（延迟加载）
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

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const FILTERED_DOMAINS = ['tiktok.com', 'bytedance.com', 'example.com', 'email.com', 'yourmail.com'];
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
];

// ============ 工具函数 ============

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function timestamp() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
function beijingDateKey() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); }
function isRealEmail(email) {
  return !FILTERED_DOMAINS.some(d => email.toLowerCase().endsWith('@' + d));
}

const DOMAIN_TYPO_MAP = {
  'gmail.con': 'gmail.com', 'gmail.cmo': 'gmail.com', 'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmali.com': 'gmail.com',
  'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'outlook.con': 'outlook.com', 'outloook.com': 'outlook.com', 'outlok.com': 'outlook.com',
  'hotmail.con': 'hotmail.com', 'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com',
  'yahoo.con': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com',
  'icloud.con': 'icloud.com', 'iclould.com': 'icloud.com',
  'protonmail.con': 'protonmail.com', 'protonmal.com': 'protonmail.com',
};

const { translateError } = require('./error-i18n');

// ============ 致命错误检测 ============

function isFatalError(err) {
  const msg = (err && err.message || String(err)).toLowerCase();
  return msg.includes('does not have permission') ||
         msg.includes('insufficient authentication') ||
         msg.includes('invalid_grant') ||
         msg.includes('token has been expired') ||
         msg.includes('enospc') ||
         err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOSPC';
}

function fixEmailTypo(email) {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const lower = domain.toLowerCase();
  return local + '@' + (DOMAIN_TYPO_MAP[lower] || domain);
}
function normalizeTikTokUrl(url) {
  url = url.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  try { const u = new URL(url); return `${u.origin}${u.pathname}`.replace(/\/$/, ''); }
  catch (e) { return url; }
}
function extractUsernameFromUrl(url) {
  const match = url.match(/tiktok\.com\/@([^\/\?#]+)/);
  return match ? match[1] : '';
}

/** 把 username 或不完整的输入归一化为完整 TikTok 链接 */
function normalizeTTLink(raw) {
  if (/tiktok\.com/i.test(raw)) return raw; // 已经是完整链接
  const username = raw.trim().replace(/^@/, '');
  return `https://www.tiktok.com/@${username}`;
}

// ============ Scraper 引擎类 ============

class Scraper extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.running = false;
    this._stopRequested = false;

    // 数据目录
    this.dataDir = path.join(app.getPath('userData'), 'scraper-data');
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

    this.scrapeLogPath = path.join(this.dataDir, 'scrape-log.json');
    this.progressPath = path.join(this.dataDir, 'scrape-progress.json');
    this.chromeProfileDir = path.join(this.dataDir, 'tiktok-chrome-profile');

    // 爬取参数
    const sc = config.scraper || {};
    this.dailyLimit = sc.dailyLimit || 1300;
    this.delayMin = sc.delayMin || 3000;
    this.delayMax = sc.delayMax || 8000;
    this.autoLoop = !!sc.autoLoop;
    this.pageTimeout = 30000;
    this.maxRetries = 2;

    // 报价引擎
    this.pricingEnabled = !!sc.enablePricing;
    this.defaultCategory = sc.defaultCategory || '普通';
    this.tikwmClient = this.pricingEnabled ? new TikWMClient({
      apiKey: sc.tikwmApiKey || '',
      freeBaseUrl: sc.tikwmFreeBaseUrl,
      paidBaseUrl: sc.tikwmPaidBaseUrl,
      log: (msg) => this.log(msg),
    }) : null;
    this.pricingTargetSamples = sc.pricingTargetSamples || 200;
  }

  log(msg) {
    const line = `[${timestamp()}] ${msg}`;
    this.emit('log', line);
  }

  // ============ 爬取日志持久化 ============

  loadScrapeLog() {
    try {
      if (fs.existsSync(this.scrapeLogPath)) return JSON.parse(fs.readFileSync(this.scrapeLogPath, 'utf-8'));
    } catch (e) { }
    return { scraped: {}, dailyCounts: {} };
  }

  saveScrapeLog(logData) {
    try {
      fs.writeFileSync(this.scrapeLogPath, JSON.stringify(logData, null, 2));
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
      fs.writeFileSync(this.progressPath, JSON.stringify(data, null, 2));
    } catch (e) {
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
    if (!fs.existsSync(this.chromeProfileDir)) {
      fs.mkdirSync(this.chromeProfileDir, { recursive: true });
    }
    const executablePath = findBrowserPath();
    if (!executablePath) {
      throw new Error('未找到 Chrome 或 Edge 浏览器，请安装 Google Chrome 或使用系统自带 Edge');
    }
    this.log(`使用浏览器: ${executablePath}`);

    const browser = await pup.launch({
      headless: 'new',
      executablePath,
      userDataDir: this.chromeProfileDir,
      defaultViewport: { width: 1920, height: 1080 },
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage', '--lang=en-US', '--window-size=1920,1080',
      ],
    });
    this.log('已启动 TikTok 爬取浏览器（无头模式）');
    return browser;
  }

  // ============ 单页爬取 ============

  async scrapeTikTokProfile(page, url) {
    const result = { username: '', email: null, bio: '', error: null, followers: 0, stats: null,
      authorRegion: '', videoDescs: [], hashtags: [] };
    try {
      url = normalizeTikTokUrl(url);
      result.username = extractUsernameFromUrl(url);

      await page.setUserAgent(USER_AGENTS[randomInt(0, USER_AGENTS.length - 1)]);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.pageTimeout });
      await sleep(randomInt(1500, 3000));

      // 策略1：内嵌 JSON
      const jsonData = await page.evaluate(() => {
        const script = document.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (script) { try { return JSON.parse(script.textContent); } catch (e) { return null; } }
        return null;
      });

      if (jsonData) {
        try {
          const userInfo = jsonData['__DEFAULT_SCOPE__']['webapp.user-detail']['userInfo'];
          const user = userInfo.user;
          const stats = userInfo.stats || {};
          result.username = user.uniqueId || result.username;
          result.bio = user.signature || '';
          result.followers = stats.followerCount || 0;
          result.stats = stats;
          result.authorRegion = user.region || '';

          // 提取视频描述和 hashtag（用于多信号投票）
          try {
            const itemModule = jsonData['__DEFAULT_SCOPE__']['webapp.user-detail'];
            const items = itemModule.itemList || [];
            for (const item of items) {
              if (item.desc) {
                result.videoDescs.push(item.desc);
                const tags = item.desc.match(/#[\w\u0080-\uFFFF]+/g);
                if (tags) result.hashtags.push(...tags.map(t => t.replace(/^#/, '')));
              }
              if (item.textExtra) {
                for (const te of item.textExtra) {
                  if (te.hashtagName) result.hashtags.push(te.hashtagName);
                }
              }
            }
          } catch (e) { /* itemList 可能不存在 */ }

          const emails = result.bio.match(EMAIL_REGEX);
          if (emails) {
            const real = emails.filter(isRealEmail);
            if (real.length > 0) { result.email = fixEmailTypo(real[0]); this.log(`   ✅ [JSON bio] ${result.email}`); return result; }
          }
          if (user.bioLink && user.bioLink.link) {
            const linkEmails = user.bioLink.link.match(EMAIL_REGEX);
            if (linkEmails) {
              const real = linkEmails.filter(isRealEmail);
              if (real.length > 0) { result.email = fixEmailTypo(real[0]); this.log(`   ✅ [JSON bioLink] ${result.email}`); return result; }
            }
          }
        } catch (e) { }
      }

      // 策略2：DOM bio
      const bioText = await page.evaluate(() => {
        const el = document.querySelector('[data-e2e="user-bio"]') || document.querySelector('h2[data-e2e="user-subtitle"]');
        return el ? el.textContent : '';
      });
      if (bioText) {
        result.bio = result.bio || bioText;
        const emails = bioText.match(EMAIL_REGEX);
        if (emails) {
          const real = emails.filter(isRealEmail);
          if (real.length > 0) { result.email = fixEmailTypo(real[0]); this.log(`   ✅ [DOM] ${result.email}`); return result; }
        }
      }

      // 策略3：全页文本
      const fullText = await page.evaluate(() => document.body.innerText);
      const allEmails = fullText.match(EMAIL_REGEX);
      if (allEmails) {
        const real = allEmails.filter(isRealEmail);
        if (real.length > 0) { result.email = fixEmailTypo(real[0]); this.log(`   ✅ [全文] ${result.email}`); return result; }
      }

      this.log(`   ⚠️ 无 email: @${result.username}`);
      return result;

    } catch (e) {
      result.error = e.message;
      this.log(`   ❌ 失败: ${translateError(e.message)}`);
      return result;
    }
  }

  // ============ 主爬取流程 ============

  async runScrape(loop = false) {
    this.log('');
    this.log('═'.repeat(50));
    this.log('  TikTok 达人邮箱爬取器');
    this.log(`  每日上限: ${this.dailyLimit}`);
    this.log('═'.repeat(50));

    const ds = createDataSource(this.config);
    await ds.init();

    const { links: rawQueue, hasHeader } = await ds.readQueue();
    const queue = rawQueue.map(normalizeTTLink);
    if (queue.length === 0) {
      this.log('📭 "待爬取" 为空');
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
    const maxThisRun = Math.min(this.dailyLimit, this.dailyLimit - todayCount);
    this.log(`📊 今日已爬: ${todayCount}，本次最多: ${maxThisRun}`);

    // 预清理队列头部已爬过的链接
    let skipCount = 0;
    for (let j = 0; j < queue.length; j++) {
      if (scrapeLog.scraped[queue[j]]) skipCount++;
      else break;
    }
    if (skipCount > 0) {
      this.log(`🧹 清理 ${skipCount} 个已处理链接...`);
      try {
        await ds.deleteFromQueue(skipCount, hasHeader);
      } catch (e) {
        this.log(`   ⚠️ 清理失败: ${translateError(e.message)}`);
        if (isFatalError(e)) {
          this.log(`❌ 致命错误：数据源不可写，自动停止`);
          this.emit('fatal-error', `数据写入失败: ${translateError(e.message)}`);
          return { queueRemaining: queue.length };
        }
      }
    }
    const startIdx = skipCount;

    let browser = await this.launchBrowser();

    const self = this;
    async function createPage(br) {
      const p = await br.newPage();
      await p.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      });
      return p;
    }

    let page = await createPage(browser);

    const stats = { found: 0, notFound: 0, failed: 0 };
    let processed = 0;

    try {
      for (let i = startIdx; i < queue.length && processed < maxThisRun; i++) {
        if (this._stopRequested) {
          this.log('⏹️ 用户停止，保存进度');
          break;
        }

        const url = queue[i];
        if (scrapeLog.scraped[url]) {
          try { await ds.deleteFirstQueueRow(hasHeader); }
          catch (e) {
            if (isFatalError(e)) {
              this.log(`❌ 致命错误：数据源不可写，自动停止`);
              this.emit('fatal-error', `数据写入失败: ${translateError(e.message)}`);
              this._stopRequested = true;
              break;
            }
          }
          await sleep(1500);
          continue;
        }

        this.log(`[${i + 1}/${queue.length}] @${extractUsernameFromUrl(url)}`);

        let scrapeResult = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
          scrapeResult = await this.scrapeTikTokProfile(page, url);
          if (!scrapeResult.error) break;

          // detached frame / 浏览器断连 → 重建 page 或整个浏览器
          const errMsg = scrapeResult.error || '';
          const isFatal = errMsg.includes('detached') || errMsg.includes('Session closed') || errMsg.includes('Connection closed');
          if (isFatal) {
            this.log(`   🔄 浏览器页面失效，重建中...`);
            try { await page.close(); } catch {}
            try {
              page = await createPage(browser);
            } catch {
              // 浏览器本身也挂了，重启
              this.log(`   🔄 浏览器已断开，重新启动...`);
              try { await browser.close(); } catch {}
              browser = await this.launchBrowser();
              page = await createPage(browser);
            }
          }

          if (attempt < this.maxRetries) {
            this.log(`   重试 ${attempt + 1}/${this.maxRetries}...`);
            await sleep(randomInt(5000, 10000));
          }
        }

        scrapeLog.scraped[url] = {
          username: scrapeResult.username,
          email: scrapeResult.email,
          bio: (scrapeResult.bio || '').substring(0, 200),
          error: scrapeResult.error,
          at: timestamp(),
        };

        if (scrapeResult.email) {
          stats.found++;

          // 报价分析（仅有邮箱且开启时）
          let offerPrice = '', priceCeiling = '', regionGroup = '', category = this.defaultCategory;
          if (this.pricingEnabled && this.tikwmClient) {
            try {
              this.log(`   💰 报价分析中...`);
              const videos = await this.tikwmClient.getUserVideos(scrapeResult.username);
              const { regionDistribution, totalSamples } = await this.tikwmClient.sampleAudienceRegions(
                scrapeResult.username, videos, this.pricingTargetSamples
              );
              const quote = calculateQuote({
                followers: scrapeResult.followers,
                videos,
                regionDistribution,
                totalSamples,
                category,
                authorRegion: scrapeResult.authorRegion,
                videoDescs: scrapeResult.videoDescs,
                bio: scrapeResult.bio,
                hashtags: scrapeResult.hashtags,
              });
              offerPrice = quote.offerPrice != null ? quote.offerPrice : '';
              priceCeiling = quote.priceCeiling != null ? quote.priceCeiling : '';
              regionGroup = quote.regionGroup || '';
              this.log(`   💰 报价: $${offerPrice} (ceiling: $${priceCeiling}) [${regionGroup}]`);
            } catch (e) {
              this.log(`   ⚠️ 报价分析失败: ${e.message}`);
            }
          }

          try {
            await ds.addToUnsent([[url, scrapeResult.username, scrapeResult.email,
              scrapeResult.followers || '', offerPrice, priceCeiling, regionGroup, category]]);
          }
          catch (e) {
            this.log(`   ⚠️ 写入失败: ${translateError(e.message)}`);
            if (isFatalError(e)) {
              this.log(`❌ 致命错误：数据源不可写，自动停止`);
              this.emit('fatal-error', `数据写入失败: ${translateError(e.message)}`);
              this._stopRequested = true;
              break;
            }
          }
        } else if (scrapeResult.error) {
          stats.failed++;
        } else {
          stats.notFound++;
          try { await ds.addToNoEmail([url]); }
          catch (e) { this.log(`   ⚠️ 写入无邮箱tab失败: ${e.message}`); }
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
        // progress 不再保存索引，scrapeLog 是唯一断点依据

        // 更新 UI 进度
        const hitRate = (stats.found + stats.notFound) > 0
          ? Math.round(stats.found / (stats.found + stats.notFound) * 100) : 0;
        this.emit('progress', {
          today: todayCount + processed,
          queue: queue.length - (i + 1),
          found: stats.found,
          failed: stats.failed,
          hitRate,
        });

        await sleep(randomInt(this.delayMin, this.delayMax));
      }
    } finally {
      try { await page.close(); } catch {}
      try { await browser.close(); } catch {}
    }

    this.log('');
    this.log('═'.repeat(50));
    this.log(`  爬取完成`);
    this.log(`  ✅ 找到 email: ${stats.found}`);
    this.log(`  ⚠️ 无 email:   ${stats.notFound}`);
    this.log(`  ❌ 爬取失败:   ${stats.failed}`);
    this.log('═'.repeat(50));

    return { queueRemaining: queue.length - (startIdx + processed), stats };
  }

  // ============ 启动 ============

  async start() {
    if (this.running) return;
    this.running = true;
    this._stopRequested = false;

    try {
      do {
        const result = await this.runScrape();

        // 每轮爬取完成后自动生成报表
        try { await this.generateReport(); }
        catch (e) { this.log(`⚠️ 报表生成失败: ${translateError(e.message)}`); }

        if (this._stopRequested) break;

        if (result.queueRemaining <= 0) {
          this.log('📭 待爬取队列已清空');
          break;
        }

        // 不循环则到此结束
        if (!this.autoLoop) {
          this.log('✅ 本次爬取完成（未开启自动循环）');
          break;
        }

        // 计算等待时间到次日 00:05 北京时间
        const now = new Date();
        const bjNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
        const bjTomorrow = new Date(bjNow);
        bjTomorrow.setDate(bjTomorrow.getDate() + 1);
        bjTomorrow.setHours(0, 5, 0, 0);
        const waitMs = bjTomorrow.getTime() - bjNow.getTime();
        const waitHours = (waitMs / 3600000).toFixed(1);

        this.log(`⏳ [自动循环] 今日配额用完，等待 ${waitHours} 小时后继续`);
        this.emit('progress', { waiting: true, waitHours });

        const interval = 30000;
        let waited = 0;
        while (waited < waitMs && !this._stopRequested) {
          await sleep(Math.min(interval, waitMs - waited));
          waited += interval;
        }

        if (this._stopRequested) break;
        this.log('⏰ 新的一天开始，继续爬取...');
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
    this.log('正在停止...');
  }

  getStatus() {
    return {
      running: this.running,
      stopping: this._stopRequested,
    };
  }

  // ============ 报表生成 ============

  async generateReport() {
    this.log('');
    this.log('📊 生成每日报表...');

    const XLSX = require('xlsx');

    // 从 scrape-log 按当天日期筛选（只出当天新爬到的有邮箱的记录）
    const scrapeLog = this.loadScrapeLog();
    const today = beijingDateKey(); // "2026-03-18"
    const todayEntries = [];

    for (const [url, entry] of Object.entries(scrapeLog.scraped || {})) {
      if (!entry.email || !entry.at) continue;
      const parts = entry.at.split(' ')[0].split('/');
      const normalized = parts.length === 3
        ? `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`
        : '';
      if (normalized === today) {
        todayEntries.push({ url, username: entry.username || '', email: entry.email });
      }
    }

    if (todayEntries.length === 0) {
      this.log(`⚠️ 今天 (${today}) 没有新爬到的邮箱，跳过报表`);
      return { skipped: true };
    }
    this.log(`   今天新爬到 ${todayEntries.length} 个有邮箱的达人`);

    const desktopPath = require('os').homedir() + '/Desktop/koc报表';
    const reportDir = (this.config.scraper && this.config.scraper.reportDir) || desktopPath;

    const backupDir = path.join(reportDir, '备份');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const bjTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const year = bjTime.getFullYear().toString().slice(2);
    const month = String(bjTime.getMonth() + 1).padStart(2, '0');
    const day = String(bjTime.getDate()).padStart(2, '0');
    const dateLabel = `${year}年${month}月${day}日`;

    // KOC 报表（27列）
    const KOC_HEADERS = [
      'kol_name', 'kol_type', 'project', 'source',
      'contact1', 'contact2', 'contact3', 'contact4',
      'region', 'language', 'gender',
      'tt_name', 'tt_link', 'tt_video_type', 'tt_price',
      'yt_name', 'yt_link', 'yt_video_type', 'yt_price',
      'ins_name', 'ins_link', 'ins_video_type', 'ins_price',
      'fb_name', 'fb_link', 'fb_video_type',
      'note',
    ];

    const project = (this.config.scraper && this.config.scraper.project) || 'blockblast';
    const kocRows = todayEntries.map(({ url, username, email }) => {
      const r = new Array(KOC_HEADERS.length).fill('');
      r[0] = username;        // kol_name
      r[1] = 'koc';           // kol_type
      r[2] = project;         // project
      r[3] = '本人';           // source
      r[4] = email;           // contact1
      r[9] = 'en';            // language
      r[11] = username;       // tt_name
      r[12] = url;            // tt_link
      return r;
    });

    const kocWb = XLSX.utils.book_new();
    const kocWs = XLSX.utils.aoa_to_sheet([KOC_HEADERS, ...kocRows]);
    XLSX.utils.book_append_sheet(kocWb, kocWs, 'Sheet1');
    const reportPath = path.join(reportDir, `${dateLabel}，koc sample.xlsx`);
    XLSX.writeFile(kocWb, reportPath);
    this.log(`   ✅ KOC 报表 (${todayEntries.length} 条): ${reportPath}`);

    // 备份（3列）
    const backupHeaders = ['username', 'link', 'email'];
    const backupRows = todayEntries.map(({ url, username, email }) => [username || '', url || '', email || '']);
    const backupWb = XLSX.utils.book_new();
    const backupWs = XLSX.utils.aoa_to_sheet([backupHeaders, ...backupRows]);
    XLSX.utils.book_append_sheet(backupWb, backupWs, 'Sheet1');
    const backupPath = path.join(backupDir, `${dateLabel}，达人备份.xlsx`);
    XLSX.writeFile(backupWb, backupPath);
    this.log(`   ✅ 备份 (${todayEntries.length} 条): ${backupPath}`);

    return { reportPath, backupPath, count: todayEntries.length };
  }
}

module.exports = Scraper;
