/**
 * Renderer 主逻辑
 * 负责 UI 交互和与主进程通信
 */

// ============ 页面切换 ============

document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('page-' + tab.dataset.page).classList.add('active');
  });
});

// ============ 设置页 - 数据源切换 ============

document.getElementById('ds-type').addEventListener('change', (e) => {
  document.getElementById('ds-google').style.display = e.target.value === 'google-sheet' ? 'block' : 'none';
  document.getElementById('ds-local').style.display = e.target.value === 'local-excel' ? 'block' : 'none';
});

// ============ 设置页 - 文件选择 ============

document.getElementById('btn-pick-credentials').addEventListener('click', async () => {
  const path = await window.api.dialog.openFile({
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (path) document.getElementById('ds-credentials').value = path;
});

document.getElementById('btn-pick-excel').addEventListener('click', async () => {
  const path = await window.api.dialog.openFile({
    filters: [{ name: 'Excel', extensions: ['xlsx', 'xls', 'csv'] }],
  });
  if (path) document.getElementById('ds-local-path').value = path;
});

document.getElementById('btn-create-excel').addEventListener('click', async () => {
  const savePath = await window.api.dialog.saveFile({
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    defaultPath: 'outreach-data.xlsx',
  });
  if (!savePath) return;
  const result = await window.api.dialog.createExcel(savePath);
  if (result.ok) {
    document.getElementById('ds-local-path').value = result.path;
    addLog('[设置] 已创建数据文件: ' + result.path, 'success');
  } else {
    addLog('[错误] 创建文件失败: ' + result.error, 'error');
  }
});

document.getElementById('btn-sync-schema').addEventListener('click', async () => {
  const btn = document.getElementById('btn-sync-schema');
  btn.disabled = true;
  btn.textContent = '同步中...';
  const result = await window.api.schema.sync();
  btn.disabled = false;
  btn.textContent = '同步表格结构';
  if (result.ok) {
    addLog('[结构同步] ' + result.msg, result.changed > 0 ? 'success' : 'info');
  } else {
    addLog('[错误] 同步失败: ' + result.error, 'error');
  }
});

document.getElementById('btn-pick-report-dir').addEventListener('click', async () => {
  const path = await window.api.dialog.openDirectory();
  if (path) document.getElementById('scrape-report-dir').value = path;
});

// ============ 设置页 - 邮箱账号管理 ============

let accounts = [];

function renderAccounts() {
  const container = document.getElementById('accounts-list');
  container.innerHTML = '';
  accounts.forEach((acc, i) => {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `
      <input type="email" value="${esc(acc.email)}" placeholder="发件邮箱地址" data-idx="${i}" data-field="email">
      <input type="password" value="${esc(acc.password)}" placeholder="密码" data-idx="${i}" data-field="password">
      <label class="checkbox-label"><input type="checkbox" ${acc.enabled ? 'checked' : ''} data-idx="${i}" data-field="enabled"> 启用</label>
      <button class="btn-remove" data-idx="${i}">&times;</button>
    `;
    container.appendChild(div);
  });

  // 事件绑定
  container.querySelectorAll('input[data-field="email"], input[data-field="password"]').forEach(el => {
    el.addEventListener('input', (e) => {
      accounts[+e.target.dataset.idx][e.target.dataset.field] = e.target.value;
    });
  });
  container.querySelectorAll('input[data-field="enabled"]').forEach(el => {
    el.addEventListener('change', (e) => {
      accounts[+e.target.dataset.idx].enabled = e.target.checked;
      updateSendInterval();
    });
  });
  container.querySelectorAll('.btn-remove').forEach(el => {
    el.addEventListener('click', (e) => {
      accounts.splice(+e.target.dataset.idx, 1);
      renderAccounts();
      updateSendInterval();
    });
  });
}

document.getElementById('btn-add-account').addEventListener('click', () => {
  accounts.push({ email: '', password: '', enabled: true });
  renderAccounts();
  updateSendInterval();
});

// ============ 设置页 - 模板管理 ============

let templates = [];

function renderTemplates() {
  const container = document.getElementById('templates-list');
  container.innerHTML = '';
  templates.forEach((tpl, i) => {
    const div = document.createElement('div');
    div.className = 'template-item';
    div.innerHTML = `
      <div class="template-header">
        <span>模板 ${i + 1}</span>
        <div>
          <label class="checkbox-label" style="display:inline-flex"><input type="checkbox" ${tpl.enabled ? 'checked' : ''} data-idx="${i}" data-field="t-enabled"> 启用</label>
          <button class="btn-remove" data-idx="${i}" style="margin-left:8px">&times;</button>
        </div>
      </div>
      <div class="form-group">
        <label>邮件主题</label>
        <input type="text" value="${esc(tpl.subject)}" data-idx="${i}" data-field="t-subject" placeholder="邮件标题">
      </div>
      <div class="form-group">
        <label>邮件正文</label>
        <div class="rich-toolbar" data-idx="${i}">
          <button data-cmd="bold" title="加粗"><b>B</b></button>
          <button data-cmd="italic" title="斜体"><i>I</i></button>
          <button data-cmd="underline" title="下划线"><u>U</u></button>
          <span class="separator"></span>
          <input type="color" data-cmd="foreColor" value="#000000" title="文字颜色">
          <span class="separator"></span>
          <button data-cmd="createLink" title="插入链接">🔗</button>
          <button data-cmd="insertImage" title="插入图片">🖼</button>
        </div>
        <div class="rich-editor" contenteditable="true" data-idx="${i}" data-field="t-body" data-placeholder="邮件内容...支持格式化文字、从 Word/网页粘贴">${tpl.bodyHtml || esc(tpl.body) || ''}</div>
      </div>
    `;
    container.appendChild(div);
  });

  // 工具栏按钮事件
  container.querySelectorAll('.rich-toolbar').forEach(toolbar => {
    const idx = +toolbar.dataset.idx;
    const editor = container.querySelector(`.rich-editor[data-idx="${idx}"]`);

    toolbar.querySelectorAll('button[data-cmd]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 防止编辑器失焦
        const cmd = btn.dataset.cmd;
        if (cmd === 'createLink') {
          const url = prompt('输入链接地址:', 'https://');
          if (url) document.execCommand('createLink', false, url);
        } else if (cmd === 'insertImage') {
          const url = prompt('输入图片地址:');
          if (url) document.execCommand('insertImage', false, url);
        } else {
          document.execCommand(cmd, false, null);
        }
        syncEditorToTemplate(idx, editor);
      });
    });

    toolbar.querySelector('input[data-cmd="foreColor"]').addEventListener('input', (e) => {
      document.execCommand('foreColor', false, e.target.value);
      syncEditorToTemplate(idx, editor);
    });
  });

  // 编辑器内容变化同步
  container.querySelectorAll('.rich-editor').forEach(el => {
    el.addEventListener('input', () => {
      syncEditorToTemplate(+el.dataset.idx, el);
    });
  });

  container.querySelectorAll('input[data-field="t-subject"]').forEach(el => {
    el.addEventListener('input', (e) => { templates[+e.target.dataset.idx].subject = e.target.value; });
  });
  container.querySelectorAll('input[data-field="t-enabled"]').forEach(el => {
    el.addEventListener('change', (e) => { templates[+e.target.dataset.idx].enabled = e.target.checked; });
  });
  container.querySelectorAll('.btn-remove').forEach(el => {
    el.addEventListener('click', (e) => {
      templates.splice(+e.target.dataset.idx, 1);
      renderTemplates();
    });
  });
}

function syncEditorToTemplate(idx, editor) {
  templates[idx].bodyHtml = editor.innerHTML;
  templates[idx].body = editor.innerText;
}

document.getElementById('btn-add-template').addEventListener('click', () => {
  templates.push({ subject: '', body: '', bodyHtml: '', enabled: true });
  renderTemplates();
});

// ============ 设置页 - 保存 ============

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const config = {
    dataSource: {
      type: document.getElementById('ds-type').value,
      sheetId: document.getElementById('ds-sheet-id').value.trim(),
      credentialsPath: document.getElementById('ds-credentials').value.trim(),
      localPath: document.getElementById('ds-local-path').value.trim(),
    },
    scraper: {
      dailyLimit: +document.getElementById('scrape-daily-limit').value || 1300,
      delayMin: +document.getElementById('scrape-delay-min').value || 3000,
      delayMax: +document.getElementById('scrape-delay-max').value || 8000,
      reportDir: document.getElementById('scrape-report-dir').value.trim(),
      scheduleEnabled: document.getElementById('scrape-schedule-enabled').checked,
      scheduleStart: document.getElementById('scrape-schedule-start').value || '08:00',
      scheduleEnd: document.getElementById('scrape-schedule-end').value || '22:00',
    },
    sender: {
      loginEmail: document.getElementById('login-email').value.trim(),
      loginPassword: document.getElementById('login-password').value,
      accounts: accounts,
      templates: templates,
      dailyTotal: +document.getElementById('send-daily-total').value || 500,
      batchSize: +document.getElementById('send-batch-size').value || 25,
      scheduleEnabled: document.getElementById('send-schedule-enabled').checked,
      scheduleStart: document.getElementById('send-schedule-start').value || '00:00',
      scheduleEnd: document.getElementById('send-schedule-end').value || '00:00',
      source: document.querySelector('input[name="send-source"]:checked')?.value || 'tt',
    },
    setupDone: true,
  };

  // 分别保存各项
  await window.api.config.set('dataSource', config.dataSource);
  await window.api.config.set('scraper', config.scraper);
  await window.api.config.set('sender.loginEmail', config.sender.loginEmail);
  await window.api.config.set('sender.loginPassword', config.sender.loginPassword);
  await window.api.config.set('sender.accounts', config.sender.accounts);
  await window.api.config.set('sender.templates', config.sender.templates);
  await window.api.config.set('sender.dailyTotal', config.sender.dailyTotal);
  await window.api.config.set('sender.batchSize', config.sender.batchSize);
  await window.api.config.set('sender.scheduleEnabled', config.sender.scheduleEnabled);
  await window.api.config.set('sender.scheduleStart', config.sender.scheduleStart);
  await window.api.config.set('sender.scheduleEnd', config.sender.scheduleEnd);
  await window.api.config.set('sender.source', config.sender.source);
  await window.api.config.set('igScraper', {
    dailyLimit: +document.getElementById('ig-daily-limit').value || 500,
    delayMin:   +document.getElementById('ig-delay-min').value   || 8000,
    delayMax:   +document.getElementById('ig-delay-max').value   || 15000,
    myEmails:   document.getElementById('ig-my-emails').value.trim(),
  });
  await window.api.config.set('mailCollector', {
    imapUser: document.getElementById('collector-imap-user').value.trim(),
    imapPass: document.getElementById('collector-imap-pass').value,
    imapHost: document.getElementById('collector-imap-host').value.trim() || 'imap.qiye.aliyun.com',
    imapPort: +document.getElementById('collector-imap-port').value || 993,
  });
  await window.api.config.set('setupDone', true);

  const fb = document.getElementById('save-feedback');
  fb.textContent = '已保存';
  fb.classList.add('visible');
  setTimeout(() => fb.classList.remove('visible'), 2000);
});

// ============ 设置页 - 加载已有配置 ============

async function loadSettings() {
  const config = await window.api.config.getAll();

  // 数据源
  const ds = config.dataSource || {};
  document.getElementById('ds-type').value = ds.type || 'google-sheet';
  document.getElementById('ds-type').dispatchEvent(new Event('change'));
  document.getElementById('ds-sheet-id').value = ds.sheetId || '';
  document.getElementById('ds-credentials').value = ds.credentialsPath || '';
  document.getElementById('ds-local-path').value = ds.localPath || '';

  // 爬取参数
  const sc = config.scraper || {};
  document.getElementById('scrape-daily-limit').value = sc.dailyLimit || 1300;
  document.getElementById('scrape-delay-min').value = sc.delayMin || 3000;
  document.getElementById('scrape-delay-max').value = sc.delayMax || 8000;
  document.getElementById('scrape-report-dir').value = sc.reportDir || '';
  document.getElementById('scraper-limit').textContent = sc.dailyLimit || 1300;
  document.getElementById('scraper-loop').checked = sc.autoLoop !== false; // 默认勾选
  document.getElementById('scrape-schedule-enabled').checked = sc.scheduleEnabled || false;
  document.getElementById('scrape-schedule-start').value = sc.scheduleStart || '08:00';
  document.getElementById('scrape-schedule-end').value = sc.scheduleEnd || '22:00';

  // 邮箱
  const sn = config.sender || {};
  document.getElementById('login-email').value = sn.loginEmail || '';
  document.getElementById('login-password').value = sn.loginPassword || '';
  accounts = (sn.accounts || []).map(a => ({ ...a }));
  renderAccounts();

  // 模板
  templates = (sn.templates || []).map(t => ({ ...t }));
  renderTemplates();

  // 发送参数
  document.getElementById('send-daily-total').value = sn.dailyTotal || 500;
  document.getElementById('send-batch-size').value = sn.batchSize || 25;
  document.getElementById('sender-loop').checked = !!sn.autoLoop;
  document.getElementById('send-schedule-enabled').checked = sn.scheduleEnabled || false;
  document.getElementById('send-schedule-start').value = sn.scheduleStart || '00:00';
  document.getElementById('send-schedule-end').value = sn.scheduleEnd || '00:00';
  // 发送来源（TK / IG）
  const source = sn.source || 'tt';
  const srcEl = document.querySelector(`input[name="send-source"][value="${source}"]`);
  if (srcEl) srcEl.checked = true;

  // IG 爬取参数
  const ig = config.igScraper || {};
  document.getElementById('ig-daily-limit').value = ig.dailyLimit || 500;
  document.getElementById('ig-delay-min').value   = ig.delayMin   || 8000;
  document.getElementById('ig-delay-max').value   = ig.delayMax   || 15000;
  document.getElementById('ig-my-emails').value   = ig.myEmails   || '';
  document.getElementById('ig-scraper-limit').textContent = ig.dailyLimit || 500;
  document.getElementById('ig-scraper-loop').checked = !!ig.autoLoop;

  // 邮件采集配置
  const mc = config.mailCollector || {};
  document.getElementById('collector-imap-user').value = mc.imapUser || '';
  document.getElementById('collector-imap-pass').value = mc.imapPass || '';
  document.getElementById('collector-imap-host').value = mc.imapHost || 'imap.qiye.aliyun.com';
  document.getElementById('collector-imap-port').value = mc.imapPort || 993;

  // 自动计算发送间隔
  updateSendInterval();

  // 首次使用跳转到设置页
  if (!config.setupDone) {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-page="settings"]').classList.add('active');
    document.getElementById('page-settings').classList.add('active');
  }
}

// ============ 控制台 - 导入 Excel ============

document.getElementById('btn-import-excel').addEventListener('click', async () => {
  const btn = document.getElementById('btn-import-excel');
  btn.disabled = true;
  btn.textContent = '导入中...';
  addLog('[导入] 选择 Excel 文件...', '');

  const result = await window.api.import.excel();
  btn.disabled = false;
  btn.textContent = '导入 Excel';

  if (result.canceled) {
    addLog('[导入] 已取消', '');
  } else if (result.error) {
    addLog('[导入错误] ' + result.error, 'error');
  } else {
    addLog('[导入] ✅ 从 ' + result.file + ' 提取了 ' + result.count + ' 条链接，已写入待爬取', 'success');
  }
});

// ============ 控制台 - 爬取控制 ============

document.getElementById('btn-scraper-start').addEventListener('click', async () => {
  // 启动前保存 autoLoop 到配置
  const autoLoop = document.getElementById('scraper-loop').checked;
  await window.api.config.set('scraper.autoLoop', autoLoop);

  const result = await window.api.scraper.start();
  if (result.error) {
    addLog('[错误] ' + result.error, 'error');
    return;
  }
  document.getElementById('btn-scraper-start').disabled = true;
  document.getElementById('btn-scraper-stop').disabled = false;
  setStatus('scraper', 'running', '运行中');
});

document.getElementById('btn-scraper-stop').addEventListener('click', async () => {
  await window.api.scraper.stop();
  document.getElementById('btn-scraper-start').disabled = false;
  document.getElementById('btn-scraper-stop').disabled = true;
  setStatus('scraper', 'stopped', '已停止');
});

// ============ 控制台 - 生成报表 ============

document.getElementById('btn-generate-report').addEventListener('click', async () => {
  const btn = document.getElementById('btn-generate-report');
  btn.disabled = true;
  btn.textContent = '生成中...';
  addLog('[报表] 正在生成报表...', '');

  const result = await window.api.report.generate();
  btn.disabled = false;
  btn.textContent = '生成报表';

  if (result.error) {
    addLog('[报表错误] ' + result.error, 'error');
  } else if (result.skipped) {
    addLog('[报表] 跳过: ' + (result.reason === 'no reportDir' ? '未设置报表输出目录' : '无数据'), 'warning');
  } else {
    addLog('[报表] ✅ KOC 报表: ' + result.reportPath, 'success');
    addLog('[报表] ✅ 备份: ' + result.backupPath, 'success');
  }
});

// ============ 控制台 - 发送控制 ============

document.getElementById('btn-sender-start').addEventListener('click', async () => {
  // 启动前保存 autoLoop 和数据来源到配置
  const autoLoop = document.getElementById('sender-loop').checked;
  await window.api.config.set('sender.autoLoop', autoLoop);
  const source = document.querySelector('input[name="send-source"]:checked')?.value || 'tt';
  await window.api.config.set('sender.source', source);

  const result = await window.api.sender.start();
  if (result.error) {
    addLog('[错误] ' + result.error, 'error');
    return;
  }
  document.getElementById('btn-sender-start').disabled = true;
  document.getElementById('btn-sender-stop').disabled = false;
  setStatus('sender', 'running', '运行中');
});

document.getElementById('btn-sender-stop').addEventListener('click', async () => {
  await window.api.sender.stop();
  document.getElementById('btn-sender-start').disabled = false;
  document.getElementById('btn-sender-stop').disabled = true;
  setStatus('sender', 'stopped', '已停止');
});

document.getElementById('btn-sender-test').addEventListener('click', async () => {
  const btn = document.getElementById('btn-sender-test');
  btn.disabled = true;
  btn.textContent = '测试中...';
  addLog('[测试] 启动测试发送（填写主题+正文，不实际发送）...', 'info');
  const result = await window.api.sender.test();
  btn.disabled = false;
  btn.textContent = '测试发送';
  if (result.error) {
    addLog('[测试] 失败: ' + result.error, 'error');
  } else {
    addLog('[测试] 完成！请查看浏览器窗口确认主题和正文是否正确填写。', 'success');
  }
});

// ============ 日志 ============

const MAX_LOG_LINES = 2000;

function addLog(msg, type = '') {
  const container = document.getElementById('log-content');
  const div = document.createElement('div');
  div.className = 'log-line' + (type ? ` log-${type}` : '');
  div.textContent = msg;
  container.appendChild(div);

  // 限制行数
  while (container.children.length > MAX_LOG_LINES) {
    container.removeChild(container.firstChild);
  }

  // 自动滚到底部
  container.scrollTop = container.scrollHeight;
}

document.getElementById('btn-clear-logs').addEventListener('click', () => {
  document.getElementById('log-content').innerHTML = '';
});

// 监听引擎日志
window.api.scraper.onLog(msg => {
  addLog(msg, msg.includes('✅') ? 'success' : msg.includes('❌') ? 'error' : msg.includes('⚠') ? 'warning' : '');
  updateScraperStats(msg);
});

window.api.sender.onLog(msg => {
  addLog(msg, msg.includes('✅') ? 'success' : msg.includes('❌') ? 'error' : msg.includes('⚠') ? 'warning' : '');
});

window.api.scraper.onProgress(data => {
  if (data.today !== undefined) document.getElementById('scraper-today').textContent = data.today;
  if (data.queue !== undefined) document.getElementById('scraper-queue').textContent = data.queue;
  if (data.found !== undefined) document.getElementById('scraper-found').textContent = data.found;
  if (data.failed !== undefined) document.getElementById('scraper-failed').textContent = data.failed;
  if (data.hitRate !== undefined) document.getElementById('scraper-hitrate').textContent = data.hitRate + '%';
});

window.api.sender.onProgress(data => {
  if (data.today !== undefined) document.getElementById('sender-today').textContent = data.today;
  if (data.pending !== undefined) document.getElementById('sender-pending').textContent = data.pending;
  if (data.account !== undefined) document.getElementById('sender-account').textContent = data.account;
});

window.api.scraper.onDone(data => {
  document.getElementById('btn-scraper-start').disabled = false;
  document.getElementById('btn-scraper-stop').disabled = true;
  setStatus('scraper', 'stopped', '已完成');
  addLog('[爬取完成]', 'success');
});

window.api.sender.onDone(data => {
  document.getElementById('btn-sender-start').disabled = false;
  document.getElementById('btn-sender-stop').disabled = true;
  setStatus('sender', 'stopped', '已完成');
  addLog('[发送完成]', 'success');
});

window.api.scraper.onError(err => {
  setStatus('scraper', 'error', '出错');
  addLog('[爬取错误] ' + err, 'error');
  document.getElementById('btn-scraper-start').disabled = false;
  document.getElementById('btn-scraper-stop').disabled = true;
});

window.api.sender.onError(err => {
  setStatus('sender', 'error', '出错');
  addLog('[发送错误] ' + err, 'error');
  document.getElementById('btn-sender-start').disabled = false;
  document.getElementById('btn-sender-stop').disabled = true;
});

// ============ 工具函数 ============

function setStatus(engine, type, text) {
  const el = document.getElementById(`${engine}-status`);
  el.className = 'status-badge status-' + type;
  el.textContent = text;
}

function updateScraperStats(msg) {
  // 从日志消息中提取数字更新统计（简单模式）
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============ 定时调度状态 ============

window.api.schedule.onUpdate(data => {
  // 定时启动/停止时同步按钮状态
  window.api.scraper.status().then(s => {
    if (s.running) {
      document.getElementById('btn-scraper-start').disabled = true;
      document.getElementById('btn-scraper-stop').disabled = false;
      setStatus('scraper', 'running', data.scraperSchedule ? '定时运行中' : '运行中');
    } else {
      document.getElementById('btn-scraper-start').disabled = false;
      document.getElementById('btn-scraper-stop').disabled = true;
      setStatus('scraper', 'stopped', data.scraperSchedule ? '定时等待中' : '未运行');
    }
  });
  window.api.sender.status().then(s => {
    if (s.running) {
      document.getElementById('btn-sender-start').disabled = true;
      document.getElementById('btn-sender-stop').disabled = false;
      setStatus('sender', 'running', data.senderSchedule ? '定时运行中' : '运行中');
    } else {
      document.getElementById('btn-sender-start').disabled = false;
      document.getElementById('btn-sender-stop').disabled = true;
      setStatus('sender', 'stopped', data.senderSchedule ? '定时等待中' : '未运行');
    }
  });
});

// ============ 发送间隔自动计算 ============

function updateSendInterval() {
  const dailyTotal = +document.getElementById('send-daily-total').value || 500;
  const batchSize = +document.getElementById('send-batch-size').value || 25;
  const accountCount = accounts.filter(a => a.enabled).length || 1;
  const scheduleEnabled = document.getElementById('send-schedule-enabled').checked;

  let windowMinutes = 1440; // 默认24小时
  if (scheduleEnabled) {
    const start = document.getElementById('send-schedule-start').value || '00:00';
    const end = document.getElementById('send-schedule-end').value || '00:00';
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    windowMinutes = startMin <= endMin ? endMin - startMin : 1440 - startMin + endMin;
    if (windowMinutes <= 0) windowMinutes = 1440;
  }

  const totalBatches = Math.ceil(dailyTotal / batchSize);
  const minInterval = accountCount > 1 ? 30 : 60;
  const idealInterval = Math.floor(windowMinutes / Math.max(totalBatches, 1));
  const actualInterval = Math.max(idealInterval, minInterval);

  // 如果最小间隔限制了发送量，直接把总额改成最大值
  const maxBatches = Math.floor(windowMinutes / actualInterval);
  const maxTotal = maxBatches * batchSize;
  if (maxTotal < dailyTotal) {
    document.getElementById('send-daily-total').value = maxTotal;
  }

  document.getElementById('send-interval-display').value = `${actualInterval} 分钟`;
}

// 监听所有影响间隔计算的输入变化
['send-daily-total', 'send-batch-size'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateSendInterval);
});
['send-schedule-enabled'].forEach(id => {
  document.getElementById(id).addEventListener('change', updateSendInterval);
});
['send-schedule-start', 'send-schedule-end'].forEach(id => {
  document.getElementById(id).addEventListener('change', updateSendInterval);
});

// ============ IG 爬取控制 ============

document.getElementById('btn-ig-scraper-start').addEventListener('click', async () => {
  const autoLoop = document.getElementById('ig-scraper-loop').checked;
  await window.api.config.set('igScraper.autoLoop', autoLoop);

  const result = await window.api.igScraper.start();
  if (result.error) { addLog('[IG错误] ' + result.error, 'error'); return; }
  document.getElementById('btn-ig-scraper-start').disabled = true;
  document.getElementById('btn-ig-scraper-stop').disabled = false;
  setStatus('ig-scraper', 'running', '运行中');
});

document.getElementById('btn-ig-scraper-stop').addEventListener('click', async () => {
  await window.api.igScraper.stop();
  document.getElementById('btn-ig-scraper-start').disabled = false;
  document.getElementById('btn-ig-scraper-stop').disabled = true;
  setStatus('ig-scraper', 'stopped', '已停止');
});

document.getElementById('btn-ig-login').addEventListener('click', async () => {
  const btn = document.getElementById('btn-ig-login');
  btn.disabled = true;
  btn.textContent = '打开中...';
  addLog('[IG登录] 正在打开浏览器...', '');
  const result = await window.api.igScraper.login();
  btn.disabled = false;
  btn.textContent = 'IG 登录';
  if (result.error) {
    addLog('[IG登录] 失败: ' + result.error, 'error');
  } else {
    addLog('[IG登录] 浏览器已打开，请在窗口中完成登录，然后点击"完成登录"', 'info');
    document.getElementById('btn-ig-confirm-login').style.display = '';
  }
});

document.getElementById('btn-ig-confirm-login').addEventListener('click', async () => {
  const result = await window.api.igScraper.confirmLogin();
  document.getElementById('btn-ig-confirm-login').style.display = 'none';
  if (result.ok) {
    addLog('[IG登录] ✅ 登录成功，可以开始 IG 爬取', 'success');
  } else {
    addLog('[IG登录] ❌ 登录未完成，请重试', 'error');
  }
});

window.api.igScraper.onLog(msg => {
  addLog(msg, msg.includes('✅') ? 'success' : msg.includes('❌') ? 'error' : msg.includes('⚠') ? 'warning' : '');
});

window.api.igScraper.onProgress(data => {
  if (data.today    !== undefined) document.getElementById('ig-scraper-today').textContent    = data.today;
  if (data.queue    !== undefined) document.getElementById('ig-scraper-queue').textContent    = data.queue;
  if (data.found    !== undefined) document.getElementById('ig-scraper-found').textContent    = data.found;
  if (data.hitRate  !== undefined) document.getElementById('ig-scraper-hitrate').textContent  = data.hitRate + '%';
  if (data.linktree !== undefined) document.getElementById('ig-scraper-linktree').textContent = data.linktree;
});

window.api.igScraper.onDone(() => {
  document.getElementById('btn-ig-scraper-start').disabled = false;
  document.getElementById('btn-ig-scraper-stop').disabled = true;
  setStatus('ig-scraper', 'stopped', '已完成');
  addLog('[IG爬取完成]', 'success');
});

window.api.igScraper.onError(err => {
  setStatus('ig-scraper', 'error', '出错');
  addLog('[IG爬取错误] ' + err, 'error');
  document.getElementById('btn-ig-scraper-start').disabled = false;
  document.getElementById('btn-ig-scraper-stop').disabled = true;
});

window.api.igScraper.onLoginRequired(() => {
  setStatus('ig-scraper', 'stopped', '需要登录');
  addLog('[IG爬取] ⚠️ 检测到登录失效，请点击"IG 登录"重新登录', 'warning');
  document.getElementById('btn-ig-scraper-start').disabled = false;
  document.getElementById('btn-ig-scraper-stop').disabled = true;
});

// ============ YT 联系方式爬取 ============

document.getElementById('btn-yt-contact-start').addEventListener('click', async () => {
  const autoLoop = document.getElementById('yt-contact-loop').checked;
  await window.api.config.set('ytScraper.autoLoop', autoLoop);

  const result = await window.api.ytContact.start();
  if (result.error) { addLog('[YT错误] ' + result.error, 'error'); return; }
  document.getElementById('btn-yt-contact-start').disabled = true;
  document.getElementById('btn-yt-contact-stop').disabled = false;
  setStatus('yt-contact', 'running', '运行中');
});

document.getElementById('btn-yt-contact-stop').addEventListener('click', async () => {
  await window.api.ytContact.stop();
  document.getElementById('btn-yt-contact-start').disabled = false;
  document.getElementById('btn-yt-contact-stop').disabled = true;
  setStatus('yt-contact', 'stopped', '已停止');
});

window.api.ytContact.onLog(msg => {
  addLog(msg, msg.includes('✅') ? 'success' : msg.includes('❌') ? 'error' : msg.includes('⚠') ? 'warning' : '');
});

window.api.ytContact.onProgress(data => {
  if (data.today     !== undefined) document.getElementById('yt-contact-today').textContent   = data.today;
  if (data.queue     !== undefined) document.getElementById('yt-contact-queue').textContent   = data.queue;
  if (data.found     !== undefined) document.getElementById('yt-contact-found').textContent   = data.found;
  if (data.hitRate   !== undefined) document.getElementById('yt-contact-hitrate').textContent = data.hitRate + '%';
  if (data.failed    !== undefined) document.getElementById('yt-contact-failed').textContent  = data.failed;
});

window.api.ytContact.onDone(() => {
  document.getElementById('btn-yt-contact-start').disabled = false;
  document.getElementById('btn-yt-contact-stop').disabled = true;
  setStatus('yt-contact', 'stopped', '已完成');
  addLog('[YT爬取完成]', 'success');
});

window.api.ytContact.onError(err => {
  setStatus('yt-contact', 'error', '出错');
  addLog('[YT爬取错误] ' + err, 'error');
  document.getElementById('btn-yt-contact-start').disabled = false;
  document.getElementById('btn-yt-contact-stop').disabled = true;
});

// ============ 邮件数据采集 ============

document.getElementById('btn-collector-start').addEventListener('click', async () => {
  const result = await window.api.mailCollector.start();
  if (result.error) { addLog('[采集错误] ' + result.error, 'error'); return; }
  document.getElementById('btn-collector-start').disabled = true;
  document.getElementById('btn-collector-stop').disabled = false;
  setStatus('collector', 'running', '运行中');
});

document.getElementById('btn-collector-stop').addEventListener('click', async () => {
  await window.api.mailCollector.stop();
  document.getElementById('btn-collector-start').disabled = false;
  document.getElementById('btn-collector-stop').disabled = true;
  setStatus('collector', 'stopped', '已停止');
});

document.getElementById('btn-collector-open-dir').addEventListener('click', () => {
  window.api.mailCollector.openDir();
});

document.getElementById('btn-collector-refresh').addEventListener('click', async () => {
  const result = await window.api.mailCollector.data();
  renderCollectorData(result);
});

function renderCollectorData(result) {
  const container = document.getElementById('collector-data-list');
  if (result.error) {
    container.innerHTML = `<div class="lan-empty">加载失败: ${esc(result.error)}</div>`;
    return;
  }
  const emails = result.emails || [];
  if (emails.length === 0) {
    container.innerHTML = '<div class="lan-empty">暂无采集数据，启动采集后数据将显示在这里</div>';
    return;
  }
  // 只显示最近50条
  const recent = emails.slice(-50).reverse();
  container.innerHTML = recent.map(m => `
    <div class="collector-item">
      <span class="collector-item-from">${esc(m.from)}</span>
      <span class="collector-item-subject">${esc(m.subject)}</span>
      <span class="collector-item-date">${m.date || ''}</span>
    </div>
  `).join('');
}

// 采集引擎事件
window.api.mailCollector.onLog(msg => {
  addLog(msg, msg.includes('完成') || msg.includes('成功') ? 'success'
    : msg.includes('错误') || msg.includes('失败') ? 'error' : '');
});

window.api.mailCollector.onProgress(data => {
  if (data.inbox !== undefined) document.getElementById('collector-inbox').textContent = data.inbox;
  if (data.sent !== undefined) document.getElementById('collector-sent').textContent = data.sent;
  if (data.total !== undefined) document.getElementById('collector-total').textContent = data.total;
});

window.api.mailCollector.onDone(() => {
  document.getElementById('btn-collector-start').disabled = false;
  document.getElementById('btn-collector-stop').disabled = true;
  setStatus('collector', 'stopped', '已完成');
  addLog('[采集完成]', 'success');
  window.api.mailCollector.data().then(r => renderCollectorData(r));
});

window.api.mailCollector.onError(err => {
  setStatus('collector', 'error', '出错');
  addLog('[采集错误] ' + err, 'error');
  document.getElementById('btn-collector-start').disabled = false;
  document.getElementById('btn-collector-stop').disabled = true;
});

async function initCollector() {
  const status = await window.api.mailCollector.status();
  if (status.running) {
    document.getElementById('btn-collector-start').disabled = true;
    document.getElementById('btn-collector-stop').disabled = false;
    setStatus('collector', 'running', '运行中');
  }
  const result = await window.api.mailCollector.data();
  renderCollectorData(result);
}

// ============ 教程弹窗 ============

document.getElementById('btn-help-collector').addEventListener('click', async () => {
  const result = await window.api.tutorial.open('tutorial-mail-collector.html');
  if (result.error) addLog('[教程] 打开失败: ' + result.error, 'error');
});

// ============ 分析报告 ============

async function loadAnalysis() {
  const data = await window.api.analysis.get();
  renderAnalysis(data);
}

function renderAnalysis(data) {
  const container = document.getElementById('analysis-content');
  if (!data || !data.summary) {
    container.innerHTML = '<div class="lan-empty">暂无分析数据</div>';
    return;
  }

  const s = data.summary;
  let html = '';

  // 概览统计
  if (s.totalInbox !== undefined || s.totalSent !== undefined) {
    html += '<div class="stat-row">';
    if (s.totalInbox !== undefined) html += `<div class="stat"><span class="stat-value">${s.totalInbox}</span><span class="stat-label">收件总数</span></div>`;
    if (s.totalSent !== undefined) html += `<div class="stat"><span class="stat-value">${s.totalSent}</span><span class="stat-label">已发总数</span></div>`;
    if (s.replyRate !== undefined) html += `<div class="stat"><span class="stat-value">${s.replyRate}%</span><span class="stat-label">回复率</span></div>`;
    html += '</div>';
  }

  // 分类统计
  if (s.categories && s.categories.length > 0) {
    html += '<div style="margin-top:16px"><h3 style="font-size:14px;font-weight:600;margin-bottom:8px">回复分类</h3>';
    html += '<div class="analysis-categories">';
    s.categories.forEach(cat => {
      const pct = cat.percent || 0;
      html += `<div class="analysis-cat-row">
        <span class="analysis-cat-name">${esc(cat.name)}</span>
        <div class="analysis-cat-bar"><div class="analysis-cat-fill" style="width:${pct}%"></div></div>
        <span class="analysis-cat-num">${cat.count} (${pct}%)</span>
      </div>`;
    });
    html += '</div></div>';
  }

  // 更新时间
  if (data.updatedAt) {
    html += `<p class="hint" style="margin-top:12px">更新时间: ${data.updatedAt}</p>`;
  }

  container.innerHTML = html;
}

document.getElementById('btn-analysis-refresh').addEventListener('click', loadAnalysis);

// ============ 初始化 ============

loadSettings();
initCollector();
loadAnalysis();
