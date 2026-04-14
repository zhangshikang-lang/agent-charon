/**
 * 配置管理模块
 * 用 JSON 文件持久化配置到 AppData
 * 注意：getStore() 必须在 app.whenReady() 之后调用
 */
const path = require('path');
const fs = require('fs');

let _configFile = null;

const DEFAULTS = {
  dataSource: {
    type: 'google-sheet',
    sheetId: '',
    credentialsPath: '',
    localPath: '',
    tabs: { queue: 'TT待爬取', unsent: 'TT未发送', sent: 'TT已发送' },
  },
  scraper: {
    dailyLimit: 1300,
    delayMin: 3000,
    delayMax: 8000,
    reportDir: '',
    enablePricing: false,
    tikwmApiKey: '',
    tikwmFreeBaseUrl: 'https://www.tikwm.com/api',
    tikwmPaidBaseUrl: 'https://api.tikwmapi.com',
    defaultCategory: '普通',
    pricingTargetSamples: 200,
  },
  sender: {
    loginEmail: '',
    loginPassword: '',
    accounts: [],
    templates: [],
    batchSize: 25,
    batchesPerAccount: 6,
    jitterMinutes: 10,
    scheduleStart: 1080,
    scheduleWindow: 960,
    source: 'tt',
    perRecipientMode: 'auto',
  },
  setupDone: false,
};

function getConfigPath() {
  if (!_configFile) {
    const { app } = require('electron');
    _configFile = path.join(app.getPath('userData'), 'config.json');
  }
  return _configFile;
}

function loadConfig() {
  try {
    const fp = getConfigPath();
    if (fs.existsSync(fp)) {
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      const config = deepMerge(DEFAULTS, data);
      if (migrateCredentials(config)) saveConfig(config);
      return config;
    }
  } catch (e) { }
  return JSON.parse(JSON.stringify(DEFAULTS));
}

/**
 * 凭证文件自动迁移
 * 如果 credentialsPath 不在应用数据目录下，自动复制过来并更新路径
 * 返回 true 表示有修改需要回写
 */
function migrateCredentials(config) {
  const cp = config.dataSource && config.dataSource.credentialsPath;
  if (!cp) return false;

  const { app } = require('electron');
  const credDir = path.join(app.getPath('userData'), 'credentials');
  const dest = path.join(credDir, path.basename(cp));

  // 已经在安全目录里了
  if (path.resolve(cp) === path.resolve(dest)) return false;

  // 安全目录里已有同名文件（之前迁移过但路径没更新）
  if (fs.existsSync(dest)) {
    config.dataSource.credentialsPath = dest;
    return true;
  }

  // 原路径还在，复制过来
  if (fs.existsSync(cp)) {
    if (!fs.existsSync(credDir)) fs.mkdirSync(credDir, { recursive: true });
    fs.copyFileSync(cp, dest);
    config.dataSource.credentialsPath = dest;
    return true;
  }

  return false;
}

function saveConfig(config) {
  const fp = getConfigPath();
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(config, null, 2));
}

function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] && typeof overrides[key] === 'object' && !Array.isArray(overrides[key])
        && defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
      result[key] = deepMerge(defaults[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

// 简易 store 接口
const store = {
  get store() { return loadConfig(); },
  get(key) {
    const config = loadConfig();
    return key.split('.').reduce((obj, k) => (obj && obj[k] !== undefined ? obj[k] : undefined), config);
  },
  set(key, value) {
    const config = loadConfig();
    const keys = key.split('.');
    let obj = config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    saveConfig(config);
  },
};

// 密码加密/解密
function encryptPassword(plainText) {
  if (!plainText) return '';
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plainText).toString('base64');
    }
  } catch (e) { }
  return Buffer.from(plainText).toString('base64');
}

function decryptPassword(encrypted) {
  if (!encrypted) return '';
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    }
    return Buffer.from(encrypted, 'base64').toString('utf-8');
  } catch (e) { return ''; }
}

module.exports = { store, encryptPassword, decryptPassword };
