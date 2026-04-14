/**
 * Preload 脚本
 * 通过 contextBridge 安全地暴露 API 给 renderer
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 配置
  config: {
    get: (key) => ipcRenderer.invoke('config:get', key),
    set: (key, value) => ipcRenderer.invoke('config:set', key, value),
    getAll: () => ipcRenderer.invoke('config:getAll'),
  },

  // 文件对话框
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
    saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
    createExcel: (filePath) => ipcRenderer.invoke('dialog:createExcel', filePath),
  },

  // 爬取引擎
  scraper: {
    start: () => ipcRenderer.invoke('scraper:start'),
    stop: () => ipcRenderer.invoke('scraper:stop'),
    status: () => ipcRenderer.invoke('scraper:status'),
    onLog: (cb) => ipcRenderer.on('scraper:log', (_, msg) => cb(msg)),
    onProgress: (cb) => ipcRenderer.on('scraper:progress', (_, data) => cb(data)),
    onDone: (cb) => ipcRenderer.on('scraper:done', (_, data) => cb(data)),
    onError: (cb) => ipcRenderer.on('scraper:error', (_, err) => cb(err)),
  },

  // 报表
  report: {
    generate: () => ipcRenderer.invoke('report:generate'),
  },

  // 定时调度
  schedule: {
    status: () => ipcRenderer.invoke('schedule:status'),
    onUpdate: (cb) => ipcRenderer.on('schedule:update', (_, data) => cb(data)),
  },

  // 发送引擎
  sender: {
    start: () => ipcRenderer.invoke('sender:start'),
    stop: () => ipcRenderer.invoke('sender:stop'),
    status: () => ipcRenderer.invoke('sender:status'),
    test: () => ipcRenderer.invoke('sender:test'),
    onLog: (cb) => ipcRenderer.on('sender:log', (_, msg) => cb(msg)),
    onProgress: (cb) => ipcRenderer.on('sender:progress', (_, data) => cb(data)),
    onDone: (cb) => ipcRenderer.on('sender:done', (_, data) => cb(data)),
    onError: (cb) => ipcRenderer.on('sender:error', (_, err) => cb(err)),
  },

  // 导入 Excel
  import: {
    excel: () => ipcRenderer.invoke('import:excel'),
  },

  // 数据结构同步
  schema: {
    sync: () => ipcRenderer.invoke('schema:sync'),
  },

  // 分析结果
  analysis: {
    get: () => ipcRenderer.invoke('analysis:get'),
  },

  // 邮件数据采集
  mailCollector: {
    start:      () => ipcRenderer.invoke('mail-collector:start'),
    stop:       () => ipcRenderer.invoke('mail-collector:stop'),
    status:     () => ipcRenderer.invoke('mail-collector:status'),
    data:       () => ipcRenderer.invoke('mail-collector:data'),
    openDir:    () => ipcRenderer.invoke('mail-collector:open-dir'),
    onLog:      (cb) => ipcRenderer.on('mail-collector:log',      (_, msg)  => cb(msg)),
    onProgress: (cb) => ipcRenderer.on('mail-collector:progress', (_, data) => cb(data)),
    onDone:     (cb) => ipcRenderer.on('mail-collector:done',     (_, data) => cb(data)),
    onError:    (cb) => ipcRenderer.on('mail-collector:error',    (_, err)  => cb(err)),
  },

  // 打开外部链接/文件
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  },

  // 教程文档
  tutorial: {
    open: (filename) => ipcRenderer.invoke('tutorial:open', filename),
  },

  // IG 爬取引擎
  igScraper: {
    start:          () => ipcRenderer.invoke('ig-scraper:start'),
    stop:           () => ipcRenderer.invoke('ig-scraper:stop'),
    status:         () => ipcRenderer.invoke('ig-scraper:status'),
    login:          () => ipcRenderer.invoke('ig-scraper:login'),
    confirmLogin:   () => ipcRenderer.invoke('ig-scraper:confirm-login'),
    onLog:          (cb) => ipcRenderer.on('ig-scraper:log',            (_, msg)  => cb(msg)),
    onProgress:     (cb) => ipcRenderer.on('ig-scraper:progress',       (_, data) => cb(data)),
    onDone:         (cb) => ipcRenderer.on('ig-scraper:done',           (_, data) => cb(data)),
    onError:        (cb) => ipcRenderer.on('ig-scraper:error',          (_, err)  => cb(err)),
    onLoginRequired:(cb) => ipcRenderer.on('ig-scraper:login-required', (_, d)    => cb(d)),
  },

  // YT 联系方式爬取引擎
  ytContact: {
    start:      () => ipcRenderer.invoke('yt-contact:start'),
    stop:       () => ipcRenderer.invoke('yt-contact:stop'),
    status:     () => ipcRenderer.invoke('yt-contact:status'),
    onLog:      (cb) => ipcRenderer.on('yt-contact:log',      (_, msg)  => cb(msg)),
    onProgress: (cb) => ipcRenderer.on('yt-contact:progress', (_, data) => cb(data)),
    onDone:     (cb) => ipcRenderer.on('yt-contact:done',     (_, data) => cb(data)),
    onError:    (cb) => ipcRenderer.on('yt-contact:error',    (_, err)  => cb(err)),
  },
});
