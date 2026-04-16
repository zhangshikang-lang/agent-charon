/**
 * IPC — 引擎生命周期管理
 * 4 个引擎的 start/stop/status + 报表 + 发送测试 + IG 登录
 */
const { ipcMain } = require('electron');

function register(ctx) {
  const { store, sendToRenderer, wireEngineEvents, translateError, engines } = ctx;

  // ========== TT 爬取引擎 ==========

  ipcMain.handle('scraper:start', async () => {
    if (engines.scraper && engines.scraper.running) {
      return { error: '爬取正在运行中' };
    }
    try {
      const Scraper = require('./engines/scraper');
      engines.scraper = new Scraper(store.store);
      wireEngineEvents(engines.scraper, 'scraper', 'TT 爬取引擎');
      engines.scraper.start();
      return { ok: true };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  ipcMain.handle('scraper:stop', () => {
    if (engines.scraper) {
      engines.scraper.stop();
      engines.scraper = null;
    }
    return { ok: true };
  });

  ipcMain.handle('scraper:status', () => {
    if (!engines.scraper) return { running: false };
    return engines.scraper.getStatus();
  });

  // ========== 报表生成 ==========

  ipcMain.handle('report:generate', async () => {
    try {
      const Scraper = require('./engines/scraper');
      const reporter = new Scraper(store.store);
      reporter.on('log', msg => sendToRenderer('scraper:log', msg));
      const result = await reporter.generateReport();
      return result;
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  // ========== 邮件发送引擎 ==========

  ipcMain.handle('sender:start', async () => {
    if (engines.sender && engines.sender.running) {
      return { error: '发送正在运行中' };
    }
    try {
      const Sender = require('./engines/sender');
      // 复用现有实例的浏览器
      const prevBrowser = engines.sender ? engines.sender.getBrowser() : null;
      engines.sender = new Sender(store.store);
      if (prevBrowser) engines.sender.setBrowser(prevBrowser);
      wireEngineEvents(engines.sender, 'sender', '邮件发送引擎');
      engines.sender.start();
      return { ok: true };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  ipcMain.handle('sender:stop', () => {
    if (engines.sender) {
      engines.sender.stop();
      // 不 null 实例，保留浏览器引用供下次复用
    }
    return { ok: true };
  });

  ipcMain.handle('sender:status', () => {
    if (!engines.sender) return { running: false };
    return engines.sender.getStatus();
  });

  // ========== 发送测试 ==========

  ipcMain.handle('sender:test', async () => {
    try {
      const Sender = require('./engines/sender');
      const config = store.store;
      const sn = config.sender || {};
      const loginEmail = sn.loginEmail || '';
      if (!loginEmail) return { error: '未配置登录邮箱，请先在设置中填写' };

      sendToRenderer('sender:log', '[测试] 发一封给自己...');

      const prevBrowser = engines.sender ? engines.sender.getBrowser() : null;
      const testSender = new Sender(config);
      if (prevBrowser) testSender.setBrowser(prevBrowser);
      testSender.on('log', msg => sendToRenderer('sender:log', msg));

      let browser = testSender.getBrowser();
      if (browser) {
        try { await browser.pages(); } catch { browser = null; testSender.setBrowser(null); }
      }
      if (!browser) {
        browser = await testSender.launchBrowser();
        testSender.setBrowser(browser);
      }
      if (engines.sender) engines.sender.setBrowser(browser);

      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

      const loggedIn = await testSender.waitForLogin(page);
      if (!loggedIn) return { error: '登录失败，请在浏览器中手动登录' };

      // 走正常 composeAndSend 流程，发1封给自己
      const templates = (sn.templates || []).filter(t => t.enabled);
      const tpl = templates[0] || { subject: '测试邮件', body: '这是一封测试邮件', bodyHtml: '' };
      const result = await testSender.composeAndSend(page, {
        emails: [loginEmail],
        subject: tpl.subject,
        body: tpl.body,
        bodyHtml: tpl.bodyHtml || '',
        templateName: '测试',
        separateSend: false,
      });

      sendToRenderer('sender:log', `[测试] 完成: ${result.success ? '发送成功' : '发送失败'}, 模板: ${result.template || '无'}`);
      return { ok: result.success, template: result.template, error: result.error };
    } catch (e) {
      sendToRenderer('sender:log', `[测试] 错误: ${translateError(e.message)}`);
      return { error: translateError(e.message) };
    }
  });

  // ========== IG 爬取引擎 ==========

  ipcMain.handle('ig-scraper:start', async () => {
    if (engines.igScraper && engines.igScraper.running) {
      return { error: 'IG 爬取正在运行中' };
    }
    try {
      const IGScraper = require('./engines/ig-scraper');
      // 复用已有实例的浏览器
      const prevBrowser = engines.igScraper ? engines.igScraper.getBrowserInstance() : null;
      engines.igScraper = new IGScraper(store.store);
      if (prevBrowser) engines.igScraper.setBrowser(prevBrowser);
      wireEngineEvents(engines.igScraper, 'ig-scraper', 'IG 爬取引擎');
      engines.igScraper.on('login-required', () => sendToRenderer('ig-scraper:login-required', {}));
      engines.igScraper.start();
      return { ok: true };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  ipcMain.handle('ig-scraper:stop', () => {
    if (engines.igScraper) engines.igScraper.stop();
    return { ok: true };
  });

  ipcMain.handle('ig-scraper:status', () => {
    if (!engines.igScraper) return { running: false };
    return engines.igScraper.getStatus();
  });

  // 打开有头浏览器让用户登录 IG
  ipcMain.handle('ig-scraper:login', async () => {
    try {
      const IGScraper = require('./engines/ig-scraper');
      if (!engines.igScraper) engines.igScraper = new IGScraper(store.store);
      await engines.igScraper.login();
      sendToRenderer('ig-scraper:log', '[登录] 浏览器已打开，请在窗口中完成 Instagram 登录');
      return { ok: true };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  // 用户在浏览器里完成登录后点击"完成"
  ipcMain.handle('ig-scraper:confirm-login', async () => {
    if (!engines.igScraper) return { error: '未启动登录流程' };
    const result = await engines.igScraper.confirmLogin();
    sendToRenderer('ig-scraper:log', result.ok
      ? '[登录] ✅ 登录成功，Cookie 已保存'
      : '[登录] ❌ 仍在登录页，请确认已完成登录');
    return result;
  });

  // ========== YT 联系方式爬取 ==========

  ipcMain.handle('yt-contact:start', async () => {
    if (engines.ytContact && engines.ytContact.running) {
      return { error: 'YT 爬取正在运行中' };
    }
    try {
      const YTContact = require('./engines/yt-contact');
      engines.ytContact = new YTContact(store.store);
      wireEngineEvents(engines.ytContact, 'yt-contact', 'YT 联系方式引擎');
      engines.ytContact.start();
      return { ok: true };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  ipcMain.handle('yt-contact:stop', () => {
    if (engines.ytContact) engines.ytContact.stop();
    return { ok: true };
  });

  ipcMain.handle('yt-contact:status', () => {
    if (!engines.ytContact) return { running: false };
    return engines.ytContact.getStatus();
  });

  // ========== 通用 shell ==========

  ipcMain.handle('shell:openExternal', (_, url) => {
    const { shell } = require('electron');
    shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('shell:openPath', (_, p) => {
    const { shell } = require('electron');
    shell.openPath(p);
    return { ok: true };
  });
}

module.exports = { register };
