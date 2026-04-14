/**
 * YouTube 达人联系方式爬取引擎
 * Bio 外链递归爬取：YT About → Linktree/Beacons/Carrd → 子页面
 * 提取邮箱、WhatsApp、Discord、Instagram、Twitter、Telegram、Facebook
 * EventEmitter 接口，与 scraper.js / ig-scraper.js 一致
 */
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { createDataSource } = require('./data-source');
const { findBrowserPath } = require('./browser-finder');
const { translateError } = require('./error-i18n');

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

const SKIP_EMAIL_DOMAINS = new Set([
  'youtube.com', 'google.com', 'gstatic.com', 'googleapis.com',
  'example.com', 'test.com', 'sentry.io', 'w3.org',
]);

// bio-link 聚合服务域名
const BIO_LINK_DOMAINS = new Set([
  'linktr.ee', 'beacons.ai', 'carrd.co', 'koji.to', 'lnk.bio',
  'linkin.bio', 'tap.bio', 'campsite.bio', 'bio.link', 'hoo.be',
  'linkbio.co', 'solo.to', 'msha.ke', 'withkoji.com', 'snipfeed.co',
]);

// 跳过的链接域名（不跟踪）
const SKIP_DOMAINS = new Set([
  'youtube.com', 'youtu.be', 'google.com', 'goo.gl',
  'amazon.com', 'amzn.to', 'shopee.com', 'lazada.com',
  'apple.com', 'spotify.com', 'music.apple.com',
  'play.google.com', 'apps.apple.com',
]);

// 社交媒体域名（访问主页提取 bio 里的 bio-link）
const SOCIAL_DOMAINS = new Set([
  'tiktok.com', 'instagram.com', 'twitter.com', 'x.com',
]);

function isSocialProfile(url) {
  const d = getDomain(url);
  return [...SOCIAL_DOMAINS].some(s => d === s || d.endsWith('.' + s));
}

const PAGE_TIMEOUT = 10000;
const BIO_LINKS_LIMIT = 8; // About 页最多提取几个外链

// ============ 工具函数 ============

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function timestamp() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
function beijingDateKey() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); }

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function isBioLinkService(url) {
  return BIO_LINK_DOMAINS.has(getDomain(url));
}

function isSkipDomain(url) {
  const d = getDomain(url);
  return SKIP_DOMAINS.has(d) || d.endsWith('.google.com');
}

// 垃圾邮箱：网站运营方/隐私政策/系统邮箱域名
const JUNK_EMAIL_DOMAINS = new Set([
  'gdprlocal.com', 'linktr.ee', 'beacons.ai', 'carrd.co',
  'cloudflare.com', 'cloudflare.net', 'sentry.io',
  'wixpress.com', 'squarespace.com', 'shopify.com',
  'godaddy.com', 'namecheap.com', 'wordpress.com', 'wordpress.org',
  'github.com', 'gitlab.com', 'bitbucket.org',
]);

// 垃圾邮箱：通用职能前缀（非达人本人）
const JUNK_EMAIL_PREFIXES = new Set([
  'privacy', 'legal', 'abuse', 'noreply', 'no-reply', 'no.reply',
  'support', 'help', 'info', 'contact', 'admin', 'administrator',
  'webmaster', 'postmaster', 'hostmaster', 'mailer-daemon',
  'dpo', 'dmca', 'compliance', 'security', 'billing',
  'feedback', 'newsletter', 'unsubscribe', 'donotreply',
]);

function isJunkEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain) return true;
  if (JUNK_EMAIL_DOMAINS.has(domain)) return true;
  if (JUNK_EMAIL_PREFIXES.has(local)) return true;
  return false;
}

/** 从文本中提取邮箱（去重、过滤平台域名+垃圾邮箱） */
function extractEmails(text) {
  if (!text) return [];
  return [...new Set(
    (text.match(EMAIL_REGEX) || [])
      .map(e => e.toLowerCase())
      .filter(e => !SKIP_EMAIL_DOMAINS.has(e.split('@')[1]))
      .filter(e => !isJunkEmail(e))
  )];
}

/** 从 URL 提取 YouTube 用户名 */
function extractYTUsername(url) {
  const m = url.match(/youtube\.com\/@([^\/\?#]+)/)
         || url.match(/youtube\.com\/channel\/([^\/\?#]+)/)
         || url.match(/youtube\.com\/c\/([^\/\?#]+)/);
  return m ? m[1] : url;
}

/** 归一化 YT 链接为频道 About 页 */
function normalizeYTLink(raw) {
  raw = raw.trim();
  if (/youtube\.com\/@/.test(raw)) {
    const username = raw.match(/@([^\/\?#]+)/)[1];
    return `https://www.youtube.com/@${username}/about`;
  }
  if (/youtube\.com\/channel\//.test(raw)) {
    const id = raw.match(/channel\/([^\/\?#]+)/)[1];
    return `https://www.youtube.com/channel/${id}/about`;
  }
  if (/youtube\.com\/c\//.test(raw)) {
    const name = raw.match(/\/c\/([^\/\?#]+)/)[1];
    return `https://www.youtube.com/c/${name}/about`;
  }
  // 裸用户名
  if (!raw.includes('/')) return `https://www.youtube.com/@${raw.replace(/^@/, '')}/about`;
  return raw;
}

// ============ 致命错误检测 ============

function isFatalError(err) {
  const msg = (err && err.message || String(err)).toLowerCase();
  return msg.includes('does not have permission') ||
         msg.includes('enospc') ||
         err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOSPC';
}

// ============ YTContact 引擎类 ============

class YTContact extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.running = false;
    this._stopRequested = false;

    this.dataDir = path.join(app.getPath('userData'), 'yt-contact-data');
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

    this.scrapeLogPath = path.join(this.dataDir, 'yt-contact-log.json');

    const yt = config.ytScraper || {};
    this.dailyLimit = yt.dailyLimit || 500;
    this.delayMin   = yt.delayMin  || 5000;
    this.delayMax   = yt.delayMax  || 12000;
    this.autoLoop   = !!yt.autoLoop;
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
        this.emit('fatal-error', `本地文件写入失败: ${translateError(e.message)}`);
        this._stopRequested = true;
      }
    }
  }

  // ============ 浏览器 ============

  async launchBrowser() {
    const pup = loadPuppeteer();
    const chromeProfileDir = path.join(this.dataDir, 'yt-chrome-profile');
    if (!fs.existsSync(chromeProfileDir)) fs.mkdirSync(chromeProfileDir, { recursive: true });

    const executablePath = findBrowserPath();
    if (!executablePath) throw new Error('未找到 Chrome 或 Edge，请安装后重试');
    this.log(`浏览器: ${executablePath}`);

    return await pup.launch({
      headless: true,
      executablePath,
      userDataDir: chromeProfileDir,
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

  // ============ YT About 页提取 bio 链接 ============

  async extractBioLinks(page, aboutUrl) {
    await page.goto(aboutUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);

    // YT About 页的外链在 "Links" 区域，提取所有非 youtube 的 <a> href
    const links = await page.evaluate((skipList) => {
      const skip = new Set(skipList);
      const results = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        if (!href || !href.startsWith('http')) continue;
        // YouTube 重定向链接
        let url = href;
        try {
          const u = new URL(href);
          if (u.hostname === 'www.youtube.com' && u.pathname === '/redirect') {
            url = u.searchParams.get('q') || href;
          }
        } catch {}
        let domain;
        try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
        if (skip.has(domain) || domain.endsWith('.google.com')) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        results.push(url);
      }
      return results;
    }, [...SKIP_DOMAINS]);

    return links.slice(0, BIO_LINKS_LIMIT);
  }

  // ============ 页面邮箱提取辅助 ============

  async _getPageEmails(page) {
    const text = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      const mailtos = [...document.querySelectorAll('a[href^="mailto:"]')]
        .map(a => a.href.replace('mailto:', '').split('?')[0]);
      return body + '\n' + mailtos.join('\n');
    });
    return extractEmails(text);
  }

  // ============ bio-link 页面爬取（点击按钮揭示邮箱） ============

  async scrapeBioLinkPage(page, url) {
    try {
      this.log(`   🔗 ${url} (bio-link)`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2500);

      // 1. 页面明文邮箱
      let emails = await this._getPageEmails(page);
      if (emails.length) return emails;

      // 2. 点击含 email 关键词的按钮（Linktree "Business Email" 等）
      const EMAIL_BTN_KEYWORDS = ['email', 'mail', 'contact', 'inquir', 'booking'];
      const btnTexts = await page.evaluate((keywords) => {
        const els = [...document.querySelectorAll('a, button, [role="button"], [role="link"]')];
        return els
          .map(el => (el.textContent || '').trim())
          .filter(t => t.length > 0 && t.length < 60 && keywords.some(k => t.toLowerCase().includes(k)));
      }, EMAIL_BTN_KEYWORDS);

      for (const btnText of btnTexts) {
        try {
          const beforeUrl = page.url();
          await page.evaluate((target) => {
            const els = [...document.querySelectorAll('a, button, [role="button"], [role="link"]')];
            const el = els.find(e => (e.textContent || '').trim() === target);
            if (el) el.click();
          }, btnText);
          this.log(`   🖱️ 点击: "${btnText}"`);
          await sleep(2000);

          emails = await this._getPageEmails(page);
          if (emails.length) return emails;

          // 如果发生了页面跳转，返回原页面继续尝试
          if (page.url() !== beforeUrl) {
            await page.goBack({ timeout: 5000 }).catch(() => {});
            await sleep(1000);
          }
        } catch { /* 继续尝试下一个按钮 */ }
      }

      return [];
    } catch (e) {
      this.log(`   ⚠️ bio-link 访问失败: ${translateError(e.message)}`);
      return [];
    }
  }

  // ============ 社交媒体主页爬取（提取 bio 里的 bio-link） ============

  async scrapeSocialProfile(page, url) {
    try {
      this.log(`   🔗 ${url} (social)`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(3000); // JS 渲染等待

      // 1. bio 里直接有邮箱
      let emails = await this._getPageEmails(page);
      if (emails.length) return emails;

      // 2. 提取页面上的 bio-link URL（<a> 标签 + bio 文本里的裸 URL）
      const BIO_LINK_LIST = [...BIO_LINK_DOMAINS];
      const bioLinkUrls = await page.evaluate((bioDomains) => {
        const results = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.href;
          if (!href || seen.has(href)) continue;
          seen.add(href);
          let domain;
          try { domain = new URL(href).hostname.replace(/^www\./, ''); } catch { continue; }
          if (bioDomains.includes(domain)) results.push(href);
        }
        // bio 文本里可能有裸 URL（如 "linktr.ee/xxx"）
        const text = document.body?.innerText || '';
        const urlPatterns = text.match(/(?:linktr\.ee|beacons\.ai|bio\.link|lnk\.bio|solo\.to|hoo\.be)\/[^\s,;)]+/gi);
        if (urlPatterns) {
          for (const m of urlPatterns) {
            const full = 'https://' + m;
            if (!seen.has(full)) { seen.add(full); results.push(full); }
          }
        }
        return results;
      }, BIO_LINK_LIST);

      this.log(`   📎 social bio 发现 ${bioLinkUrls.length} 个 bio-link`);
      for (const link of bioLinkUrls.slice(0, 3)) {
        await sleep(randomInt(1000, 2000));
        emails = await this.scrapeBioLinkPage(page, link);
        if (emails.length) return emails;
      }

      return [];
    } catch (e) {
      this.log(`   ⚠️ social 访问失败: ${translateError(e.message)}`);
      return [];
    }
  }

  // ============ 普通网站爬取（跟进联系页面） ============

  async scrapeWebsite(page, url) {
    try {
      this.log(`   🔗 ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await sleep(1500);

      // 1. 首页直接找
      let emails = await this._getPageEmails(page);
      if (emails.length) return emails;

      // 2. 扫页面上所有链接，分成 bio-link、社交主页、同域联系页
      const BIO_LINK_LIST = [...BIO_LINK_DOMAINS];
      const SOCIAL_LIST = [...SOCIAL_DOMAINS];
      const CONTACT_KEYWORDS = ['contact', 'about', 'connect', 'reach'];
      const { bioLinks, socialUrls, contactUrls } = await page.evaluate((bioDomains, socialDomains, keywords, baseUrl) => {
        const base = new URL(baseUrl);
        const bio = [], social = [], contact = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.href;
          if (!href || !href.startsWith('http') || seen.has(href)) continue;
          seen.add(href);
          let domain;
          try { domain = new URL(href).hostname.replace(/^www\./, ''); } catch { continue; }
          if (bioDomains.includes(domain)) { bio.push(href); continue; }
          if (socialDomains.some(s => domain === s || domain.endsWith('.' + s))) { social.push(href); continue; }
          if (domain !== base.hostname) continue;
          const text = (a.textContent || '').toLowerCase();
          const hrefLower = href.toLowerCase();
          if (keywords.some(k => text.includes(k) || hrefLower.includes(k))) contact.push(href);
        }
        return { bioLinks: bio, socialUrls: social, contactUrls: contact };
      }, BIO_LINK_LIST, SOCIAL_LIST, CONTACT_KEYWORDS, url);

      // 2a. 优先跟进 bio-link（如页面上有 linktr.ee 链接）
      for (const link of bioLinks.slice(0, 3)) {
        await sleep(randomInt(1000, 2000));
        emails = await this.scrapeBioLinkPage(page, link);
        if (emails.length) return emails;
      }

      // 2b. 跟进社交媒体主页（TikTok/IG），提取 bio 里的 bio-link
      for (const link of socialUrls.slice(0, 2)) {
        await sleep(randomInt(1500, 3000));
        emails = await this.scrapeSocialProfile(page, link);
        if (emails.length) return emails;
      }

      // 2c. 再跟进同域联系页面
      for (const contactUrl of contactUrls.slice(0, 3)) {
        try {
          this.log(`   📄 ${contactUrl}`);
          await page.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
          await sleep(1500);
          emails = await this._getPageEmails(page);
          if (emails.length) return emails;
        } catch { /* 继续 */ }
      }

      return [];
    } catch (e) {
      this.log(`   ⚠️ 访问失败: ${translateError(e.message)}`);
      return [];
    }
  }

  // ============ 单频道完整爬取 ============

  async scrapeChannel(page, aboutUrl) {
    const username = extractYTUsername(aboutUrl);
    const result = { username, url: aboutUrl, emails: [], error: null };

    try {
      // 1. 访问 About 页，从 bio 文本直接提邮箱
      this.log(`   📺 访问 About 页...`);
      await page.goto(aboutUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000);

      const aboutText = await page.evaluate(() => document.body?.innerText || '');
      if (aboutText.includes('This page isn') || aboutText.includes('此频道不存在')) {
        result.error = 'NOT_FOUND';
        return result;
      }

      result.emails = extractEmails(aboutText);
      if (result.emails.length) return result; // bio 里有邮箱，直接返回

      // 2. bio 没邮箱，提取外链，分三类处理
      const bioLinks = await this.extractBioLinks(page, aboutUrl);
      const bioLinkUrls = bioLinks.filter(isBioLinkService);
      const socialUrls = bioLinks.filter(isSocialProfile);
      const websiteUrls = bioLinks.filter(u => !isBioLinkService(u) && !isSocialProfile(u));
      this.log(`   📎 发现 ${bioLinks.length} 个外链 (bio-link: ${bioLinkUrls.length}, social: ${socialUrls.length}, 网站: ${websiteUrls.length})`);

      // 2a. 优先爬 bio-link 服务（Linktree 等），会点击按钮揭示邮箱
      for (const link of bioLinkUrls) {
        if (this._stopRequested) break;
        await sleep(randomInt(1500, 3000));
        const emails = await this.scrapeBioLinkPage(page, link);
        if (emails.length) {
          result.emails.push(...emails);
          result.emails = [...new Set(result.emails)];
          return result;
        }
      }

      // 2b. 爬普通网站（跟进页面上的 bio-link / 社交链接 / 联系页）
      for (const link of websiteUrls) {
        if (this._stopRequested) break;
        await sleep(randomInt(1500, 3000));
        const emails = await this.scrapeWebsite(page, link);
        if (emails.length) {
          result.emails.push(...emails);
          result.emails = [...new Set(result.emails)];
          return result;
        }
      }

      // 2c. 爬社交媒体主页（TikTok/IG），提取 bio 里的 bio-link
      for (const link of socialUrls.slice(0, 2)) {
        if (this._stopRequested) break;
        await sleep(randomInt(1500, 3000));
        const emails = await this.scrapeSocialProfile(page, link);
        if (emails.length) {
          result.emails.push(...emails);
          result.emails = [...new Set(result.emails)];
          return result;
        }
      }

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
    this.log('  YouTube 达人联系方式爬取');
    this.log(`  每日上限: ${this.dailyLimit}`);
    this.log('═'.repeat(50));

    const ytConfig = {
      ...this.config,
      dataSource: {
        ...this.config.dataSource,
        tabs: { queue: 'YT待爬取', unsent: 'YT未发送', sent: 'YT已发送' },
      },
    };
    const ds = createDataSource(ytConfig);
    await ds.init();

    const { links: rawQueue, hasHeader } = await ds.readQueue();
    const queue = rawQueue.map(normalizeYTLink);
    if (queue.length === 0) {
      this.log('📭 "YT待爬取" 为空');
      return { queueRemaining: 0 };
    }
    this.log(`📋 待爬取队列: ${queue.length} 个频道`);

    const scrapeLog = this.loadScrapeLog();
    const today = beijingDateKey();
    const todayCount = scrapeLog.dailyCounts[today] || 0;
    if (todayCount >= this.dailyLimit) {
      this.log(`⚠️ 今日已爬 ${todayCount}，达到上限 ${this.dailyLimit}`);
      return { queueRemaining: queue.length };
    }
    const maxThisRun = this.dailyLimit - todayCount;
    this.log(`📊 今日已爬: ${todayCount}，本次最多: ${maxThisRun}`);

    const browser = await this.launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    const stats = { found: 0, noContact: 0, failed: 0 };
    let processed = 0;

    try {
      for (let i = 0; i < queue.length && processed < maxThisRun; i++) {
        if (this._stopRequested) { this.log('⏹️ 用户停止'); break; }

        const aboutUrl = queue[i];
        const originalUrl = rawQueue[i];
        if (scrapeLog.scraped[originalUrl]) {
          try { await ds.deleteFirstQueueRow(hasHeader); } catch (e) {
            if (isFatalError(e)) {
              this.emit('fatal-error', `数据写入失败: ${translateError(e.message)}`);
              this._stopRequested = true;
              break;
            }
          }
          await sleep(500);
          continue;
        }

        const username = extractYTUsername(aboutUrl);
        this.log(`[${i + 1}/${queue.length}] @${username}`);

        const r = await this.scrapeChannel(page, aboutUrl);

        scrapeLog.scraped[originalUrl] = {
          username: r.username,
          emails: r.emails,
          error: r.error,
          at: timestamp(),
        };

        const emails = r.emails;
        if (emails.length) {
          stats.found++;
          this.log(`   ✅ ${r.username} → ${emails.join(', ')}`);

          const row = [originalUrl, r.username, emails.join(', ')];
          try { await ds.addToUnsent([row]); } catch (e) {
            this.log(`   ⚠️ 写入失败: ${translateError(e.message)}`);
            if (isFatalError(e)) {
              this.emit('fatal-error', `数据写入失败: ${translateError(e.message)}`);
              this._stopRequested = true;
              break;
            }
          }
        } else if (r.error && r.error !== 'NOT_FOUND') {
          stats.failed++;
          this.log(`   ❌ ${r.username} — ${translateError(r.error)}`);
        } else {
          stats.noContact++;
          this.log(`   📭 ${r.username} — 无联系方式`);
          try { await ds.addToNoEmail([originalUrl]); } catch (e) { /* ignore */ }
        }

        try { await ds.deleteFirstQueueRow(hasHeader); } catch (e) {
          if (isFatalError(e)) {
            this.emit('fatal-error', `数据写入失败: ${translateError(e.message)}`);
            this._stopRequested = true;
            break;
          }
        }

        processed++;
        scrapeLog.dailyCounts[today] = todayCount + processed;
        this.saveScrapeLog(scrapeLog);

        const total = stats.found + stats.noContact;
        const hitRate = total > 0 ? Math.round(stats.found / total * 100) : 0;
        this.emit('progress', {
          today: todayCount + processed,
          queue: queue.length - (i + 1),
          found: stats.found,
          noContact: stats.noContact,
          failed: stats.failed,
          hitRate,
        });

        await sleep(randomInt(this.delayMin, this.delayMax));
      }
    } finally {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
    }

    this.log('');
    this.log('═'.repeat(50));
    this.log(`  爬取完成`);
    this.log(`  ✅ 找到联系方式: ${stats.found}`);
    this.log(`  📭 无联系方式:   ${stats.noContact}`);
    this.log(`  ❌ 失败:         ${stats.failed}`);
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
          this.log('📭 YT 待爬取队列已清空');
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
    this.log('正在停止 YT 爬取...');
  }

  getStatus() {
    return { running: this.running, stopping: this._stopRequested };
  }
}

module.exports = YTContact;
