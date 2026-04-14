/**
 * IPC 事件注册
 * 连接 renderer UI 和主进程引擎
 */
const { ipcMain, dialog, BrowserWindow, app } = require('electron');
const { store, encryptPassword, decryptPassword } = require('./config');
const path = require('path');
const fs = require('fs');
const { translateError } = require('./engines/error-i18n');

// 引擎实例（懒加载）
let scraperInstance   = null;
let senderInstance    = null;
let igScraperInstance = null;
let mailCollectorInstance = null;
let ytContactInstance = null;

// 定时调度器
let scheduleTimer = null;

function getMainWindow() {
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 ? wins[0] : null;
}

function sendToRenderer(channel, data) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

function showFatalErrorDialog(engineName, errorMsg) {
  const win = getMainWindow();
  dialog.showMessageBox(win, {
    type: 'error',
    title: `${engineName} 致命错误`,
    message: `${engineName} 已自动停止`,
    detail: `错误原因：${errorMsg}\n\n请检查数据源权限或磁盘空间后重新启动。`,
    buttons: ['知道了'],
  });
}

// ========== 定时调度逻辑 ==========

function parseTime(timeStr) {
  // "08:00" → { hour: 8, minute: 0 }
  const [h, m] = (timeStr || '00:00').split(':').map(Number);
  return { hour: h, minute: m, total: h * 60 + m };
}

function nowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function isInTimeWindow(startStr, endStr) {
  const start = parseTime(startStr).total;
  const end = parseTime(endStr).total;
  const now = nowMinutes();

  if (start <= end) {
    // 同一天窗口，如 08:00 - 22:00
    return now >= start && now < end;
  } else {
    // 跨午夜窗口，如 18:00 - 10:00
    return now >= start || now < end;
  }
}

function startScraperEngine() {
  if (scraperInstance && scraperInstance.running) return;
  try {
    const Scraper = require('./engines/scraper');
    scraperInstance = new Scraper(store.store);
    scraperInstance.on('log', msg => sendToRenderer('scraper:log', msg));
    scraperInstance.on('progress', data => sendToRenderer('scraper:progress', data));
    scraperInstance.on('done', data => {
      sendToRenderer('scraper:done', data);
      sendToRenderer('schedule:update', getScheduleStatus());
    });
    scraperInstance.on('error', err => sendToRenderer('scraper:error', err));
    scraperInstance.on('fatal-error', err => {
      sendToRenderer('scraper:error', err);
      sendToRenderer('scraper:done', {});
      showFatalErrorDialog('TT 爬取引擎', err);
    });
    scraperInstance.start();
    sendToRenderer('scraper:log', '[定时] 到达开始时间，自动启动爬取');
    sendToRenderer('schedule:update', getScheduleStatus());
  } catch (e) {
    sendToRenderer('scraper:error', translateError(e.message));
  }
}

function stopScraperEngine() {
  if (scraperInstance && scraperInstance.running) {
    scraperInstance.stop();
    scraperInstance = null;
    sendToRenderer('scraper:log', '[定时] 到达结束时间，自动停止爬取');
    sendToRenderer('scraper:done', {});
    sendToRenderer('schedule:update', getScheduleStatus());
  }
}

function startSenderEngine() {
  if (senderInstance && senderInstance.running) return;
  try {
    const Sender = require('./engines/sender');
    senderInstance = new Sender(store.store);
    senderInstance.on('log', msg => sendToRenderer('sender:log', msg));
    senderInstance.on('progress', data => sendToRenderer('sender:progress', data));
    senderInstance.on('done', data => {
      sendToRenderer('sender:done', data);
      sendToRenderer('schedule:update', getScheduleStatus());
    });
    senderInstance.on('error', err => sendToRenderer('sender:error', err));
    senderInstance.on('fatal-error', err => {
      sendToRenderer('sender:error', err);
      sendToRenderer('sender:done', {});
      showFatalErrorDialog('邮件发送引擎', err);
    });
    senderInstance.start();
    sendToRenderer('sender:log', '[定时] 到达开始时间，自动启动发送');
    sendToRenderer('schedule:update', getScheduleStatus());
  } catch (e) {
    sendToRenderer('sender:error', translateError(e.message));
  }
}

function stopSenderEngine() {
  if (senderInstance && senderInstance.running) {
    senderInstance.stop();
    // 不 null 实例，保留浏览器引用供下次复用
    sendToRenderer('sender:log', '[定时] 到达结束时间，自动停止发送');
    sendToRenderer('sender:done', {});
    sendToRenderer('schedule:update', getScheduleStatus());
  }
}

function getScheduleStatus() {
  const sc = store.get('scraper') || {};
  const sn = store.get('sender') || {};
  return {
    scraperSchedule: sc.scheduleEnabled ? `${sc.scheduleStart || '08:00'} - ${sc.scheduleEnd || '22:00'}` : null,
    senderSchedule: sn.scheduleEnabled ? `${sn.scheduleStart || '18:00'} - ${sn.scheduleEnd || '10:00'}` : null,
  };
}

function checkSchedule() {
  const config = store.store;
  const sc = config.scraper || {};
  const sn = config.sender || {};

  // 爬取定时
  if (sc.scheduleEnabled) {
    if (isInTimeWindow(sc.scheduleStart, sc.scheduleEnd)) {
      startScraperEngine();
    } else {
      stopScraperEngine();
    }
  }

  // 发送定时
  if (sn.scheduleEnabled) {
    if (isInTimeWindow(sn.scheduleStart, sn.scheduleEnd)) {
      startSenderEngine();
    } else {
      stopSenderEngine();
    }
  }
}

function startScheduler() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  // 每 30 秒检查一次是否在时间窗口内
  scheduleTimer = setInterval(checkSchedule, 30000);
  // 立即检查一次
  checkSchedule();
}

function registerIPC() {
  // ========== 配置相关 ==========

  ipcMain.handle('config:get', (_, key) => {
    const val = store.get(key);
    if (key === 'sender.accounts') {
      return (val || []).map(a => ({ ...a, password: decryptPassword(a.password) }));
    }
    if (key === 'sender.loginPassword') {
      return decryptPassword(val);
    }
    return val;
  });

  ipcMain.handle('config:set', (_, key, value) => {
    if (key === 'sender.accounts') {
      value = value.map(a => ({ ...a, password: encryptPassword(a.password) }));
    }
    if (key === 'sender.loginPassword') {
      value = encryptPassword(value);
    }
    store.set(key, value);

    // 保存设置后刷新定时调度
    if (key === 'scraper' || key === 'sender') {
      startScheduler();
    }

    return true;
  });

  ipcMain.handle('config:getAll', () => {
    const all = store.store;
    if (all.sender && all.sender.accounts) {
      all.sender.accounts = all.sender.accounts.map(a => ({
        ...a, password: decryptPassword(a.password),
      }));
    }
    if (all.sender && all.sender.loginPassword) {
      all.sender.loginPassword = decryptPassword(all.sender.loginPassword);
    }
    return all;
  });

  // ========== 文件选择对话框 ==========

  ipcMain.handle('dialog:openFile', async (_, options) => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      filters: options.filters || [],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:saveFile', async (_, options) => {
    const result = await dialog.showSaveDialog(getMainWindow(), {
      filters: options.filters || [{ name: 'Excel', extensions: ['xlsx'] }],
      defaultPath: options.defaultPath || 'outreach-data.xlsx',
    });
    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle('dialog:createExcel', async (_, filePath) => {
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.utils.book_new();
      // TikTok tabs（带 TT 前缀）
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['link']]), 'TT待爬取');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['url', 'username', 'email']]), 'TT未发送');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['url', 'username', 'email', 'sent_at', 'sent_by', 'template_subject']]), 'TT已发送');
      // Instagram tabs
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['link']]), 'IG待爬取');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['url', 'username', 'email']]), 'IG未发送');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['url', 'username', 'email', 'sent_at', 'sent_by', 'template_subject']]), 'IG已发送');
      // YouTube tabs
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['link']]), 'YT待爬取');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['url', 'username', 'email']]), 'YT未发送');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['url', 'username', 'email', 'sent_at', 'sent_by', 'template_subject']]), 'YT已发送');
      XLSX.writeFile(wb, filePath);
      return { ok: true, path: filePath };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  // ========== 导入 Excel 到待爬取 ==========

  ipcMain.handle('import:excel', async () => {
    // 选文件
    const result = await dialog.showOpenDialog(getMainWindow(), {
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls', 'csv'] }],
      properties: ['openFile'],
    });
    if (result.canceled) return { canceled: true };
    const filePath = result.filePaths[0];

    try {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(filePath);
      const links = new Set();

      for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        if (!ws) continue;
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
        for (const row of data) {
          for (const cell of row) {
            if (!cell || typeof cell !== 'string') continue;
            const val = cell.trim();

            // 完整 TikTok 链接
            if (val.includes('tiktok.com/')) {
              links.add(val);
              continue;
            }

            // @username 格式 → 转完整链接
            const handleMatch = val.match(/^@([\w.]+)$/);
            if (handleMatch) {
              links.add('https://www.tiktok.com/@' + handleMatch[1]);
            }
          }
        }
      }

      if (links.size === 0) return { error: '未找到任何 TikTok 链接或 @用户名' };

      // 写入数据源的待爬取 tab
      const { createDataSource } = require('./engines/data-source');
      const ds = createDataSource(store.store);
      await ds.init();

      const rows = [...links].map(l => [l]);
      await ds.addToQueue(rows);

      return { ok: true, count: links.size, file: path.basename(filePath) };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  // ========== 数据结构同步（一键将表格更新到 MARK 42 最新结构） ==========

  // MARK 42 完整表格结构定义（后续加功能在这里加 tab 即可）
  const SCHEMA = {
    // 旧名 → 新名（兼容老用户）
    renames: [
      { from: '待爬取', to: 'TT待爬取' },
      { from: '未发送', to: 'TT未发送' },
      { from: '已发送', to: 'TT已发送' },
    ],
    // 所有需要的 tab 和表头
    tabs: [
      { name: 'TT待爬取', header: ['link'] },
      { name: 'TT未发送', header: ['url', 'username', 'email'] },
      { name: 'TT已发送', header: ['url', 'username', 'email', 'sent_at', 'sent_by', 'template_subject'] },
      { name: 'IG待爬取', header: ['link'] },
      { name: 'IG未发送', header: ['url', 'username', 'email'] },
      { name: 'IG已发送', header: ['url', 'username', 'email', 'sent_at', 'sent_by', 'template_subject'] },
      { name: 'YT待爬取', header: ['link'] },
      { name: 'YT未发送', header: ['url', 'username', 'email'] },
      { name: 'YT已发送', header: ['url', 'username', 'email', 'sent_at', 'sent_by', 'template_subject'] },
      { name: '已回复',   header: ['email', 'name', 'reply_count'] },
      { name: '退信',     header: ['date', 'subject'] },
    ],
  };

  ipcMain.handle('schema:sync', async () => {
    const dsType = store.get('dataSource.type');
    if (dsType === 'local-excel') {
      return syncExcelSchema();
    } else {
      return syncGSheetSchema();
    }
  });

  function syncExcelSchema() {
    try {
      const localPath = store.get('dataSource.localPath');
      if (!localPath) return { error: '未配置本地 Excel 文件路径，请先在设置中选择或创建数据文件' };

      const XLSX = require('xlsx');
      if (!fs.existsSync(localPath)) return { error: `文件不存在: ${localPath}` };

      const wb = XLSX.readFile(localPath);
      const changes = [];

      // 1. 重命名旧 tab（保留数据）
      for (const { from, to } of SCHEMA.renames) {
        const idx = wb.SheetNames.indexOf(from);
        if (idx !== -1 && !wb.SheetNames.includes(to)) {
          wb.SheetNames[idx] = to;
          wb.Sheets[to] = wb.Sheets[from];
          delete wb.Sheets[from];
          changes.push(`重命名: ${from} → ${to}`);
        }
      }

      // 2. 补充缺失的 tab（只加新的，不动已有的）
      for (const { name, header } of SCHEMA.tabs) {
        if (!wb.SheetNames.includes(name)) {
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header]), name);
          changes.push(`新增: ${name}`);
        }
      }

      if (changes.length === 0) {
        return { ok: true, changed: 0, msg: '数据文件已是最新结构，无需更新' };
      }

      XLSX.writeFile(wb, localPath);
      return { ok: true, changed: changes.length, msg: changes.join('；') };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  }

  async function syncGSheetSchema() {
    try {
      const sheetId = store.get('dataSource.sheetId');
      const credPath = store.get('dataSource.credentialsPath');
      if (!sheetId) return { error: '未配置 Google Sheet ID，请先填写并保存设置' };
      if (!credPath) return { error: '未配置 Google 凭证文件，请先选择并保存设置' };

      const { google } = require('googleapis');
      const auth = new google.auth.GoogleAuth({
        keyFile: credPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth });

      const meta = await sheets.spreadsheets.get({
        spreadsheetId: sheetId,
        fields: 'sheets.properties',
      });
      const existing = meta.data.sheets.map(s => ({
        title: s.properties.title,
        sheetId: s.properties.sheetId,
      }));
      const titles = new Set(existing.map(s => s.title));

      const requests = [];
      const addedTabs = [];
      const changes = [];

      // 1. 重命名旧 tab（保留数据）
      for (const { from, to } of SCHEMA.renames) {
        const sheet = existing.find(s => s.title === from);
        if (sheet && !titles.has(to)) {
          requests.push({
            updateSheetProperties: {
              properties: { sheetId: sheet.sheetId, title: to },
              fields: 'title',
            },
          });
          titles.add(to);
          changes.push(`重命名: ${from} → ${to}`);
        }
      }

      // 2. 补充缺失的 tab
      for (const { name } of SCHEMA.tabs) {
        if (!titles.has(name)) {
          requests.push({ addSheet: { properties: { title: name } } });
          addedTabs.push(name);
          changes.push(`新增: ${name}`);
        }
      }

      if (requests.length === 0) {
        return { ok: true, changed: 0, msg: 'Google Sheet 已是最新结构，无需更新' };
      }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { requests },
      });

      // 为新增的 tab 写入表头
      for (const { name, header } of SCHEMA.tabs) {
        if (addedTabs.includes(name)) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: `${name}!A:Z`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [header] },
          });
        }
      }

      return { ok: true, changed: changes.length, msg: changes.join('；') };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  }

  // ========== 爬取引擎 ==========

  ipcMain.handle('scraper:start', async () => {
    if (scraperInstance && scraperInstance.running) {
      return { error: '爬取正在运行中' };
    }
    try {
      const Scraper = require('./engines/scraper');
      scraperInstance = new Scraper(store.store);
      scraperInstance.on('log', msg => sendToRenderer('scraper:log', msg));
      scraperInstance.on('progress', data => sendToRenderer('scraper:progress', data));
      scraperInstance.on('done', data => sendToRenderer('scraper:done', data));
      scraperInstance.on('error', err => sendToRenderer('scraper:error', err));
      scraperInstance.on('fatal-error', err => {
        sendToRenderer('scraper:error', err);
        sendToRenderer('scraper:done', {});
        showFatalErrorDialog('TT 爬取引擎', err);
      });
      scraperInstance.start();
      return { ok: true };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  ipcMain.handle('scraper:stop', () => {
    if (scraperInstance) {
      scraperInstance.stop();
      scraperInstance = null;
    }
    return { ok: true };
  });

  ipcMain.handle('scraper:status', () => {
    if (!scraperInstance) return { running: false };
    return scraperInstance.getStatus();
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

  // ========== 发送引擎 ==========

  ipcMain.handle('sender:start', async () => {
    if (senderInstance && senderInstance.running) {
      return { error: '发送正在运行中' };
    }
    try {
      const Sender = require('./engines/sender');
      // 复用现有实例的浏览器
      const prevBrowser = senderInstance ? senderInstance._browser : null;
      senderInstance = new Sender(store.store);
      if (prevBrowser) senderInstance._browser = prevBrowser;
      senderInstance.on('log', msg => sendToRenderer('sender:log', msg));
      senderInstance.on('progress', data => sendToRenderer('sender:progress', data));
      senderInstance.on('done', data => sendToRenderer('sender:done', data));
      senderInstance.on('error', err => sendToRenderer('sender:error', err));
      senderInstance.on('fatal-error', err => {
        sendToRenderer('sender:error', err);
        sendToRenderer('sender:done', {});
        showFatalErrorDialog('邮件发送引擎', err);
      });
      senderInstance.start();
      return { ok: true };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  ipcMain.handle('sender:stop', () => {
    if (senderInstance) {
      senderInstance.stop();
      // 不 null 实例，保留浏览器引用供下次复用
    }
    return { ok: true };
  });

  ipcMain.handle('sender:status', () => {
    if (!senderInstance) return { running: false };
    return senderInstance.getStatus();
  });

  // ========== 发送测试（强制手动填写，不实际发送） ==========

  ipcMain.handle('sender:test', async () => {
    try {
      const Sender = require('./engines/sender');
      const config = store.store;
      const sn = config.sender || {};
      const loginEmail = sn.loginEmail || '';
      if (!loginEmail) return { error: '未配置登录邮箱，请先在设置中填写' };

      sendToRenderer('sender:log', '[测试] 发一封给自己...');

      const prevBrowser = senderInstance ? senderInstance._browser : null;
      const testSender = new Sender(config);
      if (prevBrowser) testSender._browser = prevBrowser;
      testSender.on('log', msg => sendToRenderer('sender:log', msg));

      let browser = testSender._browser;
      if (browser) {
        try { await browser.pages(); } catch { browser = null; testSender._browser = null; }
      }
      if (!browser) {
        browser = await testSender.launchBrowser();
        testSender._browser = browser;
      }
      if (senderInstance) senderInstance._browser = browser;

      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

      const loggedIn = await testSender.waitForLogin(page);
      if (!loggedIn) return { error: '登录失败，请在浏览器中手动登录' };

      // 走正常 composeAndSend 流程，发1封给自己
      const result = await testSender.composeAndSend(page, {
        emails: [loginEmail],
        templateIdx: 0,
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
    if (igScraperInstance && igScraperInstance.running) {
      return { error: 'IG 爬取正在运行中' };
    }
    try {
      const IGScraper = require('./engines/ig-scraper');
      igScraperInstance = new IGScraper(store.store);
      igScraperInstance.on('log',           msg  => sendToRenderer('ig-scraper:log', msg));
      igScraperInstance.on('progress',      data => sendToRenderer('ig-scraper:progress', data));
      igScraperInstance.on('done',          data => sendToRenderer('ig-scraper:done', data));
      igScraperInstance.on('error',         err  => sendToRenderer('ig-scraper:error', err));
      igScraperInstance.on('login-required',()   => sendToRenderer('ig-scraper:login-required', {}));
      igScraperInstance.on('fatal-error', err => {
        sendToRenderer('ig-scraper:error', err);
        sendToRenderer('ig-scraper:done', {});
        showFatalErrorDialog('IG 爬取引擎', err);
      });
      igScraperInstance.start();
      return { ok: true };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  ipcMain.handle('ig-scraper:stop', () => {
    if (igScraperInstance) igScraperInstance.stop();
    return { ok: true };
  });

  ipcMain.handle('ig-scraper:status', () => {
    if (!igScraperInstance) return { running: false };
    return igScraperInstance.getStatus();
  });

  // 打开有头浏览器让用户登录 IG
  ipcMain.handle('ig-scraper:login', async () => {
    try {
      const IGScraper = require('./engines/ig-scraper');
      // 如果没有实例就临时创建一个用于登录
      const scraper = igScraperInstance || new IGScraper(store.store);
      await scraper.launchBrowser(false).then(async browser => {
        scraper._loginBrowser = browser;
        const page = await browser.newPage();
        await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
        sendToRenderer('ig-scraper:log', '[登录] 浏览器已打开，请在窗口中完成 Instagram 登录');
      });
      if (!igScraperInstance) igScraperInstance = scraper;
      return { ok: true };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  // 用户在浏览器里完成登录后点击"完成"
  ipcMain.handle('ig-scraper:confirm-login', async () => {
    if (!igScraperInstance) return { error: '未启动登录流程' };
    const result = await igScraperInstance.confirmLogin();
    sendToRenderer('ig-scraper:log', result.ok
      ? '[登录] ✅ 登录成功，Cookie 已保存'
      : '[登录] ❌ 仍在登录页，请确认已完成登录');
    return result;
  });

  // ========== YT 联系方式爬取 ==========

  ipcMain.handle('yt-contact:start', async () => {
    if (ytContactInstance && ytContactInstance.running) {
      return { error: 'YT 爬取正在运行中' };
    }
    try {
      const YTContact = require('./engines/yt-contact');
      ytContactInstance = new YTContact(store.store);
      ytContactInstance.on('log',      msg  => sendToRenderer('yt-contact:log', msg));
      ytContactInstance.on('progress', data => sendToRenderer('yt-contact:progress', data));
      ytContactInstance.on('done',     data => sendToRenderer('yt-contact:done', data));
      ytContactInstance.on('error',    err  => sendToRenderer('yt-contact:error', err));
      ytContactInstance.on('fatal-error', err => {
        sendToRenderer('yt-contact:error', err);
        sendToRenderer('yt-contact:done', {});
        showFatalErrorDialog('YT 联系方式引擎', err);
      });
      ytContactInstance.start();
      return { ok: true };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  ipcMain.handle('yt-contact:stop', () => {
    if (ytContactInstance) ytContactInstance.stop();
    return { ok: true };
  });

  ipcMain.handle('yt-contact:status', () => {
    if (!ytContactInstance) return { running: false };
    return ytContactInstance.getStatus();
  });

  // ========== 邮件数据采集 ==========

  ipcMain.handle('mail-collector:start', async () => {
    if (mailCollectorInstance && mailCollectorInstance.running) {
      return { ok: true, status: mailCollectorInstance.getStatus() };
    }
    try {
      const MailCollector = require('./engines/mail-collector');
      mailCollectorInstance = new MailCollector(store.store);
      mailCollectorInstance.on('log', msg => sendToRenderer('mail-collector:log', msg));
      mailCollectorInstance.on('progress', data => sendToRenderer('mail-collector:progress', data));
      mailCollectorInstance.on('done', data => sendToRenderer('mail-collector:done', data));
      mailCollectorInstance.on('error', err => sendToRenderer('mail-collector:error', err));
      mailCollectorInstance.on('fatal-error', err => {
        sendToRenderer('mail-collector:error', err);
        sendToRenderer('mail-collector:done', {});
        showFatalErrorDialog('邮件采集引擎', err);
      });
      mailCollectorInstance.start();
      return { ok: true };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  ipcMain.handle('mail-collector:stop', () => {
    if (mailCollectorInstance) mailCollectorInstance.stop();
    return { ok: true };
  });

  ipcMain.handle('mail-collector:status', () => {
    if (!mailCollectorInstance) return { running: false };
    return mailCollectorInstance.getStatus();
  });

  ipcMain.handle('mail-collector:data', async () => {
    try {
      const MailCollector = require('./engines/mail-collector');
      return MailCollector.readCollectedData();
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  ipcMain.handle('mail-collector:open-dir', () => {
    const { shell } = require('electron');
    const dataDir = path.join(app.getPath('userData'), 'mail-data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    shell.openPath(dataDir);
    return { ok: true };
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

  // ========== 教程文档 ==========

  ipcMain.handle('tutorial:open', (_, filename) => {
    try {
      const { shell } = require('electron');
      const isDev = !app.isPackaged;
      const srcDir = isDev
        ? path.join(__dirname, '..', '..', 'resources')
        : path.join(process.resourcesPath, 'resources');
      const srcFile = path.join(srcDir, filename);
      const desktop = app.getPath('desktop');
      const destFile = path.join(desktop, filename);
      fs.copyFileSync(srcFile, destFile);
      shell.openPath(destFile);
      return { ok: true, path: destFile };
    } catch (e) {
      return { error: translateError(e.message) };
    }
  });

  // ========== 分析结果 ==========

  ipcMain.handle('analysis:get', () => {
    const { getLocalResults } = require('./fetch-results');
    return getLocalResults();
  });

  // ========== 定时调度 ==========

  ipcMain.handle('schedule:status', () => {
    return getScheduleStatus();
  });

  // 启动定时调度器
  startScheduler();
}

module.exports = { registerIPC };
