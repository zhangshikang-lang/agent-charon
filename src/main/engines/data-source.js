/**
 * 数据源抽象层
 * 统一接口支持 Google Sheet 和 本地 Excel
 */
const { google } = require('googleapis');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// ============ 列定义 ============

const UNSENT_HEADERS = ['url', 'username', 'email', 'followers', 'offer_price', 'price_ceiling', 'region_group', 'category'];
const SENT_HEADERS = ['url', 'username', 'email', 'sent_at', 'sent_by', 'template_subject', 'offer_price', 'price_ceiling'];

/** 短行补空字符串到指定长度 */
function padRow(row, len) {
  const r = Array.isArray(row) ? [...row] : [];
  while (r.length < len) r.push('');
  return r;
}

// ============ 基类 ============

class DataSource {
  async readQueue() { throw new Error('未实现'); }
  async addToQueue(rows) { throw new Error('未实现'); }
  async addToUnsent(rows) { throw new Error('未实现'); }
  async readUnsent() { throw new Error('未实现'); }
  async moveToSent(rows) { throw new Error('未实现'); }
  async deleteFromQueue(count) { throw new Error('未实现'); }
  async getQueueCount() { throw new Error('未实现'); }
  async getUnsentCount() { throw new Error('未实现'); }
  async writeReplies(replies) { throw new Error('未实现'); }
  async writeBounces(bounces) { throw new Error('未实现'); }
}

// ============ Google Sheet 数据源 ============

class GoogleSheetSource extends DataSource {
  constructor(config) {
    super();
    this.sheetId = config.dataSource.sheetId;
    this.credentialsPath = config.dataSource.credentialsPath;
    this.tabs = config.dataSource.tabs || { queue: '待爬取', unsent: '未发送', sent: '已发送' };
    this.sheets = null;
    this._sheetIdCache = {};
  }

  async init() {
    const auth = new google.auth.GoogleAuth({
      keyFile: this.credentialsPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth });

    // 确保 tab 存在
    for (const tabName of Object.values(this.tabs)) {
      await this._ensureTab(tabName);
    }
  }

  async _ensureTab(tabName) {
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: this.sheetId,
      fields: 'sheets.properties',
    });
    const exists = meta.data.sheets.some(s => s.properties.title === tabName);
    if (!exists) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
      });
      if (tabName === this.tabs.unsent) {
        await this._append(tabName, [UNSENT_HEADERS]);
      }
      if (tabName === this.tabs.sent) {
        await this._append(tabName, [SENT_HEADERS]);
      }
      if (tabName === this.tabs.queue) {
        await this._append(tabName, [['link']]);
      }
    }
  }

  async _getTabSheetId(tabName) {
    if (this._sheetIdCache[tabName] !== undefined) return this._sheetIdCache[tabName];
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: this.sheetId,
      fields: 'sheets.properties',
    });
    const sheet = meta.data.sheets.find(s => s.properties.title === tabName);
    this._sheetIdCache[tabName] = sheet ? sheet.properties.sheetId : null;
    return this._sheetIdCache[tabName];
  }

  async _append(tabName, rows) {
    if (!rows.length) return;
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: `${tabName}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
  }

  async readQueue() {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${this.tabs.queue}!A:Z`,
    });
    const rows = res.data.values || [];
    const hasHeader = !!(rows[0] && rows[0][0] && rows[0][0].toLowerCase().includes('link'));
    const start = hasHeader ? 1 : 0;

    // 读取所有列所有行，扁平化提取 link
    const links = [];
    for (let i = start; i < rows.length; i++) {
      const row = rows[i] || [];
      for (const cell of row) {
        const val = (cell || '').trim();
        if (val && (val.startsWith('http') || val.startsWith('@'))) links.push(val);
      }
    }

    // 多列输入时，清空 sheet 重写为单列
    if (rows.length > start && rows[start] && rows[start].length > 1) {
      const clearRange = `${this.tabs.queue}!A:Z`;
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId: this.sheetId,
        range: clearRange,
      });
      const newData = hasHeader ? [['link'], ...links.map(l => [l])] : links.map(l => [l]);
      if (newData.length) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId,
          range: `${this.tabs.queue}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: newData },
        });
      }
    }

    return { links, hasHeader };
  }

  async addToQueue(rows) {
    await this._append(this.tabs.queue, rows);
  }

  async addToUnsent(rows) {
    await this._append(this.tabs.unsent, rows);
  }

  async addToNoEmail(links) {
    if (!links.length) return;
    const tabName = this.tabs.queue.replace(/待爬取$/, '无邮箱');
    await this._append(tabName, links.map(l => [l]));
  }

  async readUnsent() {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${this.tabs.unsent}!A:H`,
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) return [];
    return rows.slice(1).map(r => padRow(r, UNSENT_HEADERS.length));
  }

  async moveToSent(sentRows) {
    await this._append(this.tabs.sent, sentRows);
  }

  async deleteFromQueue(count, hasHeader = true) {
    const sheetId = await this._getTabSheetId(this.tabs.queue);
    if (sheetId === null) return;
    const startRow = hasHeader ? 1 : 0;
    const CHUNK = 50;
    let deleted = 0;
    while (deleted < count) {
      const batch = Math.min(CHUNK, count - deleted);
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: { sheetId, dimension: 'ROWS', startIndex: startRow, endIndex: startRow + batch },
            },
          }],
        },
      });
      deleted += batch;
      if (deleted < count) await new Promise(r => setTimeout(r, 2000));
    }
  }

  async deleteFirstQueueRow(hasHeader = true) {
    const sheetId = await this._getTabSheetId(this.tabs.queue);
    if (sheetId === null) return;
    const startRow = hasHeader ? 1 : 0;
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.sheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: startRow, endIndex: startRow + 1 },
          },
        }],
      },
    });
  }

  /**
   * 按 email 精确匹配删除未发送行（避免按行号删错）
   * @param {string[]} emails 要删除的 email 列表
   */
  async deleteUnsentByEmails(emails) {
    const sheetId = await this._getTabSheetId(this.tabs.unsent);
    if (sheetId === null) return;

    const emailSet = new Set(emails.map(e => e.toLowerCase().trim()));

    // 读取所有未发送数据，找到要删除的行号
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${this.tabs.unsent}!A:H`,
    });
    const rows = res.data.values || [];

    // 收集匹配行的索引（从后往前删，避免索引偏移）
    const deleteIndices = [];
    for (let i = 1; i < rows.length; i++) { // 跳过表头
      const rowEmail = (rows[i][2] || '').toLowerCase().trim();
      if (emailSet.has(rowEmail)) deleteIndices.push(i);
    }

    if (deleteIndices.length === 0) return;

    // 从后往前删除，每次一行，避免索引偏移
    const requests = deleteIndices.reverse().map(idx => ({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
      },
    }));

    // 分批发送（每批最多 50 个删除请求）
    const CHUNK = 50;
    for (let i = 0; i < requests.length; i += CHUNK) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: { requests: requests.slice(i, i + CHUNK) },
      });
      if (i + CHUNK < requests.length) await new Promise(r => setTimeout(r, 2000));
    }
  }

  async getQueueCount() {
    const { links } = await this.readQueue();
    return links.length;
  }

  async getUnsentCount() {
    const rows = await this.readUnsent();
    return rows.length;
  }

  async writeReplies(replies) {
    const tabName = '已回复';
    await this._ensureTab(tabName);

    // 清空旧数据
    const sheetId = await this._getTabSheetId(tabName);
    if (sheetId !== null) {
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId: this.sheetId,
        range: `${tabName}!A:C`,
      });
    }

    const rows = [
      ['email', 'name', 'reply_count'],
      ...replies.map(d => [d.email, d.name, d.count]),
    ];
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }

  async writeBounces(bounces) {
    const tabName = '退信';
    await this._ensureTab(tabName);

    const sheetId = await this._getTabSheetId(tabName);
    if (sheetId !== null) {
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId: this.sheetId,
        range: `${tabName}!A:B`,
      });
    }

    const rows = [
      ['date', 'subject'],
      ...bounces.map(b => [b.date, b.subject]),
    ];
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }
}

// ============ 本地 Excel 数据源 ============

class LocalExcelSource extends DataSource {
  constructor(config) {
    super();
    this.filePath = config.dataSource.localPath;
    this.tabs = config.dataSource.tabs || { queue: '待爬取', unsent: '未发送', sent: '已发送' };
    this._tmpPath = this.filePath.replace(/\.xlsx$/i, '.tmp.xlsx');
    this._mergeTimer = null;
  }

  _loadWorkbook() {
    // 如果有临时文件（上次写入时 Excel 锁住了），先尝试同步回去
    if (fs.existsSync(this._tmpPath) && fs.existsSync(this.filePath)) {
      const tmpTime = fs.statSync(this._tmpPath).mtimeMs;
      const srcTime = fs.statSync(this.filePath).mtimeMs;
      if (tmpTime >= srcTime) {
        // tmp 比源文件新，合并回去
        try {
          fs.copyFileSync(this._tmpPath, this.filePath);
          fs.unlinkSync(this._tmpPath);
        } catch (err) {
          if (err.code === 'EBUSY' || err.code === 'EPERM') {
            return XLSX.readFile(this._tmpPath);
          }
        }
      } else {
        // 源文件比 tmp 新（用户手动编辑过），丢弃过期的 tmp
        try { fs.unlinkSync(this._tmpPath); } catch {}
        console.log('[DataSource] 丢弃过期 tmp 文件（源文件更新）');
      }
    } else if (fs.existsSync(this._tmpPath)) {
      // 源文件不存在，直接用 tmp 恢复
      try {
        fs.renameSync(this._tmpPath, this.filePath);
      } catch {
        try {
          fs.copyFileSync(this._tmpPath, this.filePath);
          fs.unlinkSync(this._tmpPath);
        } catch {}
      }
    }

    if (!fs.existsSync(this.filePath)) {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['link']]), this.tabs.queue);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([UNSENT_HEADERS]), this.tabs.unsent);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([SENT_HEADERS]), this.tabs.sent);
      XLSX.writeFile(wb, this.filePath);
    }
    return XLSX.readFile(this.filePath);
  }

  /**
   * 保存工作簿，文件被锁时自动写入临时文件并启动自动合并轮询
   * @returns {boolean} true = 写入了临时文件（原文件被锁）
   */
  _saveWorkbook(wb) {
    try {
      XLSX.writeFile(wb, this.filePath);
      if (fs.existsSync(this._tmpPath)) {
        try { fs.unlinkSync(this._tmpPath); } catch {}
      }
      this._stopMergeTimer();
      return false;
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        XLSX.writeFile(wb, this._tmpPath);
        this._startMergeTimer();
        return true;
      }
      throw err;
    }
  }

  /** 启动轮询定时器，每 3 秒尝试把 tmp 合并回源文件 */
  _startMergeTimer() {
    if (this._mergeTimer) return; // 已经在跑了
    this._mergeTimer = setInterval(() => {
      if (!fs.existsSync(this._tmpPath)) {
        this._stopMergeTimer();
        return;
      }
      try {
        fs.copyFileSync(this._tmpPath, this.filePath);
        fs.unlinkSync(this._tmpPath);
        this._stopMergeTimer();
        console.log('[DataSource] tmp 文件已合并回源文件');
      } catch (err) {
        // 源文件还锁着，下次再试
      }
    }, 3000);
    this._mergeTimer.unref(); // 不阻止进程退出
  }

  _stopMergeTimer() {
    if (this._mergeTimer) {
      clearInterval(this._mergeTimer);
      this._mergeTimer = null;
    }
  }

  async init() {
    this._loadWorkbook(); // 确保文件存在
    // 如果启动时就有遗留 tmp 文件，立即启动合并轮询
    if (fs.existsSync(this._tmpPath)) {
      this._startMergeTimer();
    }
  }

  async readQueue() {
    const wb = this._loadWorkbook();
    const ws = wb.Sheets[this.tabs.queue];
    if (!ws) {
      const available = wb.SheetNames.join(', ');
      throw new Error(`找不到「${this.tabs.queue}」sheet，文件中只有: ${available}`);
    }
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const hasHeader = !!(data[0] && String(data[0][0]).toLowerCase().includes('link'));
    const start = hasHeader ? 1 : 0;

    // 读取所有列所有行，扁平化提取 link
    const links = [];
    for (let i = start; i < data.length; i++) {
      const row = data[i];
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const val = String(cell || '').trim();
        if (val && (val.startsWith('http') || val.startsWith('@'))) links.push(val);
      }
    }

    // 多列输入时，重写为单列格式以兼容逐行删除逻辑
    if (data.length > 0 && Array.isArray(data[start]) && data[start].length > 1) {
      const newData = hasHeader ? [['link']] : [];
      for (const l of links) newData.push([l]);
      wb.Sheets[this.tabs.queue] = XLSX.utils.aoa_to_sheet(newData);
      this._saveWorkbook(wb);
    }

    return { links, hasHeader };
  }

  async addToQueue(rows) {
    const wb = this._loadWorkbook();
    let ws = wb.Sheets[this.tabs.queue];
    if (!ws) {
      ws = XLSX.utils.aoa_to_sheet([['link']]);
      XLSX.utils.book_append_sheet(wb, ws, this.tabs.queue);
    }
    XLSX.utils.sheet_add_aoa(ws, rows, { origin: -1 });
    this._saveWorkbook(wb);
  }

  async addToUnsent(rows) {
    const wb = this._loadWorkbook();
    let ws = wb.Sheets[this.tabs.unsent];
    if (!ws) {
      ws = XLSX.utils.aoa_to_sheet([UNSENT_HEADERS]);
      XLSX.utils.book_append_sheet(wb, ws, this.tabs.unsent);
    }
    XLSX.utils.sheet_add_aoa(ws, rows, { origin: -1 });
    this._saveWorkbook(wb);
  }

  async addToNoEmail(links) {
    if (!links.length) return;
    const tabName = this.tabs.queue.replace(/待爬取$/, '无邮箱');
    const wb = this._loadWorkbook();
    let ws = wb.Sheets[tabName];
    if (!ws) {
      ws = XLSX.utils.aoa_to_sheet([['link']]);
      XLSX.utils.book_append_sheet(wb, ws, tabName);
    }
    XLSX.utils.sheet_add_aoa(ws, links.map(l => [l]), { origin: -1 });
    this._saveWorkbook(wb);
  }

  async readUnsent() {
    const wb = this._loadWorkbook();
    const ws = wb.Sheets[this.tabs.unsent];
    if (!ws) return [];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (data.length <= 1) return [];
    return data.slice(1).map(r => padRow(r, UNSENT_HEADERS.length));
  }

  async moveToSent(sentRows) {
    const wb = this._loadWorkbook();
    let ws = wb.Sheets[this.tabs.sent];
    if (!ws) {
      ws = XLSX.utils.aoa_to_sheet([SENT_HEADERS]);
      XLSX.utils.book_append_sheet(wb, ws, this.tabs.sent);
    }
    XLSX.utils.sheet_add_aoa(ws, sentRows, { origin: -1 });
    this._saveWorkbook(wb);
  }

  async deleteFromQueue(count) {
    const wb = this._loadWorkbook();
    const ws = wb.Sheets[this.tabs.queue];
    if (!ws) return;
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const hasHeader = !!(data[0] && String(data[0][0]).toLowerCase().includes('link'));
    const start = hasHeader ? 1 : 0;
    data.splice(start, count);
    const newWs = XLSX.utils.aoa_to_sheet(data);
    wb.Sheets[this.tabs.queue] = newWs;
    this._saveWorkbook(wb);
  }

  async deleteFirstQueueRow() {
    await this.deleteFromQueue(1);
  }

  /**
   * 按 email 精确匹配删除未发送行
   * @param {string[]} emails 要删除的 email 列表
   */
  async deleteUnsentByEmails(emails) {
    const wb = this._loadWorkbook();
    const ws = wb.Sheets[this.tabs.unsent];
    if (!ws) return;
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const emailSet = new Set(emails.map(e => e.toLowerCase().trim()));

    // 保留表头 + 不在删除列表中的行
    const filtered = [data[0]];
    for (let i = 1; i < data.length; i++) {
      const rowEmail = (String(data[i][2] || '')).toLowerCase().trim();
      if (!emailSet.has(rowEmail)) filtered.push(data[i]);
    }

    wb.Sheets[this.tabs.unsent] = XLSX.utils.aoa_to_sheet(filtered);
    this._saveWorkbook(wb);
  }

  async getQueueCount() {
    const { links } = await this.readQueue();
    return links.length;
  }

  async getUnsentCount() {
    const rows = await this.readUnsent();
    return rows.length;
  }

  async writeReplies(replies) {
    const tabName = '已回复';
    const wb = this._loadWorkbook();
    const rows = [
      ['email', 'name', 'reply_count'],
      ...replies.map(d => [d.email, d.name, d.count]),
    ];
    wb.Sheets[tabName] = XLSX.utils.aoa_to_sheet(rows);
    if (!wb.SheetNames.includes(tabName)) wb.SheetNames.push(tabName);
    this._saveWorkbook(wb);
  }

  async writeBounces(bounces) {
    const tabName = '退信';
    const wb = this._loadWorkbook();
    const rows = [
      ['date', 'subject'],
      ...bounces.map(b => [b.date, b.subject]),
    ];
    wb.Sheets[tabName] = XLSX.utils.aoa_to_sheet(rows);
    if (!wb.SheetNames.includes(tabName)) wb.SheetNames.push(tabName);
    this._saveWorkbook(wb);
  }
}

// ============ 工厂函数 ============

function createDataSource(config) {
  const type = config.dataSource && config.dataSource.type;
  if (type === 'local-excel') {
    return new LocalExcelSource(config);
  }
  return new GoogleSheetSource(config);
}

module.exports = { DataSource, GoogleSheetSource, LocalExcelSource, createDataSource, UNSENT_HEADERS, SENT_HEADERS };
