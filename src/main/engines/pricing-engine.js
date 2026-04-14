/**
 * pricing-engine.js — 报价引擎
 *
 * 从 BB-Tiktok config.js + background.js 移植的完整报价计算逻辑。
 * 纯函数模块，零副作用，零浏览器依赖。
 *
 * 用法：
 *   const { calculateQuote } = require('./pricing-engine');
 *   const result = calculateQuote({ followers, videos, regionDistribution, totalSamples, category });
 */

'use strict';

// ═══════════════════════════════════════════════════════
// 常量 & 配置表（移植自 BB-Tiktok config.js）
// ═══════════════════════════════════════════════════════

/** 14 个地区组映射：国家代码 → 地区组名 */
const REGION_GROUPS = {
  '欧美英德区': ['US', 'CA', 'GB', 'IE', 'DE', 'CH'],
  '欧洲其他区': ['FR', 'IT', 'ES', 'PT', 'NL', 'BE', 'AT', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'HU', 'RO', 'BG', 'HR', 'SK', 'SI', 'LT', 'LV', 'EE', 'GR', 'RS', 'UA', 'BY'],
  '巴西+葡萄牙': ['BR', 'PT'],
  '拉美西语区': ['MX', 'AR', 'CO', 'CL', 'PE', 'EC', 'VE', 'UY', 'PY', 'BO', 'CR', 'PA', 'DO', 'GT', 'HN', 'SV', 'NI', 'CU', 'PR'],
  '西班牙': ['ES'],
  '阿语海湾': ['SA', 'AE', 'QA', 'KW', 'BH', 'OM'],
  '阿语其他': ['EG', 'MA', 'DZ', 'TN', 'LY', 'IQ', 'JO', 'LB', 'SY', 'YE', 'SD'],
  '印度T3区': [
    'IN', 'PK', 'BD', 'LK', 'NP', 'AF', 'MM',
    'KE', 'NG', 'GH', 'TZ', 'UG', 'ET', 'ZA', 'CM', 'CI', 'SN', 'MG', 'MZ', 'ZW',
    'RW', 'BJ', 'ML', 'BF', 'NE', 'TD', 'SO', 'ER', 'DJ', 'MW', 'ZM', 'AO', 'CD',
    'CG', 'GA', 'GQ', 'CF', 'SS', 'BI', 'TG', 'SL', 'LR', 'GM', 'GW', 'CV', 'ST',
    'KM', 'MU', 'SC'
  ],
  '日语': ['JP'],
  '印尼语': ['ID', 'MY', 'TH', 'SG'],
  '菲律宾': ['PH'],
  '越南': ['VN'],
  '俄语区': ['RU', 'KZ', 'UZ', 'TJ', 'KG', 'TM', 'AZ', 'GE', 'AM', 'MD'],
  '韩语': ['KR'],
};

// 反向映射：国家代码 → 地区组名
const COUNTRY_TO_GROUP = {};
for (const [group, countries] of Object.entries(REGION_GROUPS)) {
  for (const cc of countries) {
    // 西班牙同时出现在"欧洲其他区"和"西班牙"，优先用"西班牙"
    // 葡萄牙同时出现在"欧洲其他区"和"巴西+葡萄牙"，优先用"巴西+葡萄牙"
    if (!COUNTRY_TO_GROUP[cc] || group === '西班牙' || group === '巴西+葡萄牙') {
      COUNTRY_TO_GROUP[cc] = group;
    }
  }
}

/** KOC 价格表：地区 → 播放量区间 → [min, max] */
const PRICE_TABLE = {
  '欧美英德区':   [[5,10],[10,20],[20,40],[40,80],[80,150],[150,300],[300,450],[450,600]],
  '欧洲其他区':   [[3,5],[5,20],[20,30],[30,60],[60,100],[100,200],[200,250],[250,400]],
  '巴西+葡萄牙':  [[1,2],[2,8],[8,15],[15,60],[60,100],[100,180],[180,250],[250,350]],
  '拉美西语区':   [[1,2],[2,8],[8,15],[15,60],[60,100],[100,180],[180,250],[250,350]],
  '西班牙':       [[3,5],[5,20],[20,30],[30,60],[60,100],[100,200],[200,250],[250,400]],
  '阿语海湾':     [[1.5,4],[4,18],[18,35],[35,70],[70,90],[90,150],[150,250],[250,250]],
  '阿语其他':     [[0.15,0.3],[0.3,1.5],[1.5,3],[3,15],[15,30],[30,60],[60,200],[200,200]],
  '印度T3区':     [[0.5,0.5],[0.5,1],[1,3],[3,10],[10,15],[15,25],[25,40],[80,80]],
  '日语':         [[0,0],[0,0],[50,50],[50,150],[150,250],[250,400],[400,400],[400,400]],
  '印尼语':       [[1,2],[2,3],[3,10],[10,45],[45,80],[80,140],[140,200],[250,250]],
  '菲律宾':       [[1,1],[1,3],[3,10],[10,45],[45,80],[80,120],[120,200],[300,300]],
  '越南':         [[1,1],[1,3],[3,6],[6,40],[40,80],[80,120],[120,200],[300,300]],
  '俄语区':       [[1,1.5],[1.5,7.5],[7.5,15],[15,60],[60,120],[120,180],[180,250],[250,300]],
  '韩语':         [[10,15],[15,30],[30,100],[100,150]],
};

/** 好物分享价格表：地区 → 播放量区间 → 固定单价 */
const PRICE_TABLE_GOODS = {
  '欧美英德区':   [null, null, 5, 10, 20, 30],   // 5k-10k:5, 10k-50k:10, 50k-100k:20, 100k+:30
  '巴西+葡萄牙':  [null, null, 1, 5, 7, 10],
  '拉美西语区':   [null, null, 1, 5, 7, 10],
  '西班牙':       [null, null, 1, 5, 7, 10],
  '印尼语':       [null, null, 1, 2, 2, 3],
  '菲律宾':       [null, null, 1, 2, 2, 3],
  '越南':         [null, null, 1, 2, 2, 3],
};

/** 好物分享排除国家 */
const GOODS_EXCLUDE_COUNTRIES = ['DE'];

/** 默认播放量区间定义：[lo, hi, label] */
const PLAY_BRACKETS_DEFAULT = [
  [500,    1000,   '500-1k'],
  [1000,   5000,   '1k-5k'],
  [5000,   10000,  '5k-10k'],
  [10000,  50000,  '10k-50k'],
  [50000,  100000, '50k-100k'],
  [100000, 200000, '100k-200k'],
  [200000, 300000, '200k-300k'],
  [300000, 500000, '300k-500k'],
];

/** 韩语专属播放量区间 */
const PLAY_BRACKETS_KOREAN = [
  [3000,   5000,   '3k-5k'],
  [5000,   10000,  '5k-10k'],
  [10000,  50000,  '10k-50k'],
  [50000,  100001, '50k-100k+'],
];

/** 品类折扣规则 */
const TAG_RULES = {
  '普通':           { factor: 1,   cap: 0 },
  '剪辑&memes':     { factor: 0.5, cap: 50 },
  '对话类原创memes': { factor: 0.5, cap: 80 },
  'AI':             { factor: 0.1, cap: 30 },
  '搬运':           { factor: 0.1, cap: 30 },
  '好物分享':       { factor: 1,   cap: 0, useGoodsTable: true },
};

/** 互动率豁免阈值 */
const ENGAGEMENT_EXEMPT_THRESHOLD = 0.04; // 4%

/** KOL 判定阈值 */
const KOL_THRESHOLDS = {
  default: 200000,
  '日语': 50000,
};


// ═══════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════

/**
 * 保留 N 位有效数字四舍五入
 */
function roundSig(value, sig = 3) {
  if (value === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(value)));
  const power = sig - d;
  const magnitude = Math.pow(10, power);
  return Math.round(value * magnitude) / magnitude;
}

/**
 * 格式化数字为人类可读（1000→1k, 1000000→1M）
 */
function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}


// ═══════════════════════════════════════════════════════
// 核心计算函数
// ═══════════════════════════════════════════════════════

/**
 * 将 {国家: 人数} 按地区组归类
 * @param {{ [countryCode: string]: number }} regionCounts
 * @param {number} totalUsers
 * @returns {{ name: string, percentage: number, count: number }[]}
 */
function classifyRegionGroup(regionCounts, totalUsers) {
  const groupCounts = {};

  for (const [cc, count] of Object.entries(regionCounts)) {
    const group = COUNTRY_TO_GROUP[cc] || '印度T3区'; // 未归类 → 印度T3区
    groupCounts[group] = (groupCounts[group] || 0) + count;
  }

  const groups = Object.entries(groupCounts).map(([name, count]) => ({
    name,
    percentage: totalUsers > 0 ? (count / totalUsers) * 100 : 0,
    count,
  }));

  // 按 percentage 降序
  groups.sort((a, b) => b.percentage - a.percentage);
  return groups;
}

/**
 * 三步判断报价地区
 * @param {{ name: string, percentage: number }[]} groups — 已按 percentage 降序
 * @returns {{ pricingRegions: { name: string, weight: number }[], rule: string }}
 */
function determinePricingRegion(groups) {
  if (!groups.length) {
    return { pricingRegions: [{ name: '印度T3区', weight: 1 }], rule: 'no-data' };
  }

  const top1 = groups[0];
  const top2 = groups[1];

  // 1. Top1 ≥ 50% → 按该区
  if (top1.percentage >= 50) {
    return {
      pricingRegions: [{ name: top1.name, weight: 1 }],
      rule: `top1≥50% (${top1.name} ${top1.percentage.toFixed(1)}%)`,
    };
  }

  // 2. Top1 20-50%
  if (top1.percentage >= 20) {
    if (top2 && top2.percentage >= 20) {
      // 双区 1:1
      return {
        pricingRegions: [
          { name: top1.name, weight: 0.5 },
          { name: top2.name, weight: 0.5 },
        ],
        rule: `dual-region (${top1.name} ${top1.percentage.toFixed(1)}% + ${top2.name} ${top2.percentage.toFixed(1)}%)`,
      };
    }
    // Top2 < 20% → 按 Top1
    return {
      pricingRegions: [{ name: top1.name, weight: 1 }],
      rule: `top1 20-50% solo (${top1.name} ${top1.percentage.toFixed(1)}%)`,
    };
  }

  // 3. Top1 < 20% → 印度T3区
  return {
    pricingRegions: [{ name: '印度T3区', weight: 1 }],
    rule: `top1<20% fallback (${top1.name} ${top1.percentage.toFixed(1)}%)`,
  };
}

// ═══════════════════════════════════════════════════════
// 多信号投票地区判定
// ═══════════════════════════════════════════════════════

/** Unicode 字符集 → 地区组（纯正则，不依赖外部库） */
const SCRIPT_PATTERNS = [
  { regex: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g, group: '阿语海湾' },
  { regex: /[\u3040-\u309F\u30A0-\u30FF]/g, group: '日语' },       // 平假名+片假名
  { regex: /[\uAC00-\uD7AF\u1100-\u11FF]/g, group: '韩语' },       // 韩文音节+字母
  { regex: /[\u0400-\u04FF]/g, group: '俄语区' },                   // 西里尔文
  { regex: /[\u0E00-\u0E7F]/g, group: '印尼语' },                   // 泰文 → 归入印尼语组
  { regex: /[\u0900-\u097F\u0980-\u09FF]/g, group: '印度T3区' },    // 天城文+孟加拉文
  // 越南语通过声调符号检测
  { regex: /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/gi, group: '越南' },
];

/** 西语/葡语关键词 */
const LANG_KEYWORDS = {
  '巴西+葡萄牙': /\b(você|voce|obrigad[oa]|também|tambem|então|entao|porque|muito|para|como|isso|aqui|hoje|vamos|brasil|brasileiro)\b/i,
  '拉美西语区': /\b(hola|gracias|también|tambien|porque|pero|como|esto|aquí|aqui|hoy|vamos|amigos|hermanos|feliz)\b/i,
  '菲律宾': /\b(ang|mga|sa|ng|na|po|ko|mo|naman|lang|din|rin|talaga|grabe|salamat|maganda|ganda)\b/i,
  '印尼语': /\b(aku|saya|kamu|ini|itu|yang|dan|untuk|dengan|tidak|bisa|ada|juga|sudah|akan|terima kasih|bagus)\b/i,
};

/**
 * 检测文本数组的主要语言/地区
 * @param {string[]} texts
 * @returns {string|null} 地区组名或 null
 */
function detectTextLanguage(texts) {
  if (!texts || texts.length === 0) return null;
  const combined = texts.join(' ');
  if (combined.length < 10) return null;

  // 1. Unicode 字符集计分
  const scores = {};
  for (const { regex, group } of SCRIPT_PATTERNS) {
    const matches = combined.match(regex);
    if (matches && matches.length >= 3) {
      scores[group] = (scores[group] || 0) + matches.length;
    }
  }

  // 2. 关键词计分
  for (const [group, regex] of Object.entries(LANG_KEYWORDS)) {
    const matches = combined.match(new RegExp(regex.source, 'gi'));
    if (matches && matches.length >= 2) {
      scores[group] = (scores[group] || 0) + matches.length * 3; // 关键词权重高
    }
  }

  if (Object.keys(scores).length === 0) return null;

  // 取最高分
  let best = null, bestScore = 0;
  for (const [group, score] of Object.entries(scores)) {
    if (score > bestScore) { best = group; bestScore = score; }
  }
  return best;
}

/** Bio 地理关键词 → 地区组（小写匹配） */
const GEO_KEYWORDS = {
  // 韩语
  'seoul': '韩语', '서울': '韩语', 'busan': '韩语', '부산': '韩语', 'korea': '韩语',
  'south korea': '韩语', 'incheon': '韩语', 'daegu': '韩语',
  // 日语
  'tokyo': '日语', '東京': '日语', 'osaka': '日语', '大阪': '日语', 'japan': '日语',
  'kyoto': '日语', 'yokohama': '日语', 'nagoya': '日语', 'fukuoka': '日语',
  // 欧美英德区
  'new york': '欧美英德区', 'nyc': '欧美英德区', 'los angeles': '欧美英德区', 'la': '欧美英德区',
  'london': '欧美英德区', 'chicago': '欧美英德区', 'houston': '欧美英德区', 'miami': '欧美英德区',
  'toronto': '欧美英德区', 'vancouver': '欧美英德区', 'berlin': '欧美英德区', 'munich': '欧美英德区',
  'united states': '欧美英德区', 'usa': '欧美英德区', 'canada': '欧美英德区', 'uk': '欧美英德区',
  'germany': '欧美英德区', 'deutschland': '欧美英德区',
  // 巴西+葡萄牙
  'são paulo': '巴西+葡萄牙', 'sao paulo': '巴西+葡萄牙', 'rio de janeiro': '巴西+葡萄牙',
  'brasil': '巴西+葡萄牙', 'brazil': '巴西+葡萄牙', 'portugal': '巴西+葡萄牙', 'lisboa': '巴西+葡萄牙',
  // 拉美西语区
  'mexico': '拉美西语区', 'méxico': '拉美西语区', 'cdmx': '拉美西语区',
  'bogota': '拉美西语区', 'bogotá': '拉美西语区', 'buenos aires': '拉美西语区',
  'lima': '拉美西语区', 'santiago': '拉美西语区', 'colombia': '拉美西语区', 'argentina': '拉美西语区',
  // 印尼语
  'jakarta': '印尼语', 'indonesia': '印尼语', 'surabaya': '印尼语', 'bali': '印尼语',
  'malaysia': '印尼语', 'kuala lumpur': '印尼语', 'bangkok': '印尼语', 'thailand': '印尼语',
  // 菲律宾
  'manila': '菲律宾', 'philippines': '菲律宾', 'cebu': '菲律宾', 'davao': '菲律宾', 'pinoy': '菲律宾',
  // 越南
  'vietnam': '越南', 'hanoi': '越南', 'hà nội': '越南', 'ho chi minh': '越南', 'saigon': '越南',
  // 俄语区
  'moscow': '俄语区', 'москва': '俄语区', 'russia': '俄语区', 'россия': '俄语区',
  'kazakhstan': '俄语区', 'ukraine': '俄语区', 'київ': '俄语区', 'kyiv': '俄语区',
  // 阿语海湾
  'dubai': '阿语海湾', 'riyadh': '阿语海湾', 'saudi': '阿语海湾', 'qatar': '阿语海湾',
  'abu dhabi': '阿语海湾', 'kuwait': '阿语海湾',
  // 阿语其他
  'cairo': '阿语其他', 'egypt': '阿语其他', 'morocco': '阿语其他', 'algiers': '阿语其他',
  // 印度T3区
  'india': '印度T3区', 'mumbai': '印度T3区', 'delhi': '印度T3区', 'bangalore': '印度T3区',
  'lagos': '印度T3区', 'nigeria': '印度T3区', 'kenya': '印度T3区', 'nairobi': '印度T3区',
  'pakistan': '印度T3区', 'karachi': '印度T3区', 'dhaka': '印度T3区', 'south africa': '印度T3区',
  // 欧洲其他区
  'paris': '欧洲其他区', 'france': '欧洲其他区', 'roma': '欧洲其他区', 'italy': '欧洲其他区',
  'amsterdam': '欧洲其他区', 'warsaw': '欧洲其他区', 'stockholm': '欧洲其他区',
  // 西班牙
  'madrid': '西班牙', 'barcelona': '西班牙', 'españa': '西班牙', 'spain': '西班牙',
};

/** Hashtag → 地区组（不含 # 号，小写匹配） */
const REGION_HASHTAGS = {
  // 韩语
  'korea': '韩语', 'korean': '韩语', 'seoul': '韩语', 'kpop': '韩语', 'kdrama': '韩语',
  '한국': '韩语', '서울': '韩语', 'southkorea': '韩语', 'koreanfood': '韩语',
  // 日语
  'japan': '日语', 'japanese': '日语', 'tokyo': '日语', 'anime': '日语', 'manga': '日语',
  '日本': '日语', '東京': '日语', 'japantravel': '日语',
  // 巴西
  'brasil': '巴西+葡萄牙', 'brazil': '巴西+葡萄牙', 'brasileiro': '巴西+葡萄牙',
  'brasileira': '巴西+葡萄牙', 'portugal': '巴西+葡萄牙', 'português': '巴西+葡萄牙',
  // 拉美西语
  'mexico': '拉美西语区', 'méxico': '拉美西语区', 'colombia': '拉美西语区',
  'argentina': '拉美西语区', 'latino': '拉美西语区', 'latina': '拉美西语区',
  'latinoamerica': '拉美西语区', 'peru': '拉美西语区', 'chile': '拉美西语区',
  // 印尼语
  'indonesia': '印尼语', 'indonesian': '印尼语', 'jakarta': '印尼语',
  'malaysia': '印尼语', 'thai': '印尼语', 'thailand': '印尼语', 'bangkok': '印尼语',
  // 菲律宾
  'philippines': '菲律宾', 'filipino': '菲律宾', 'pinoy': '菲律宾', 'pinay': '菲律宾',
  'manila': '菲律宾', 'cebu': '菲律宾',
  // 越南
  'vietnam': '越南', 'vietnamese': '越南', 'hanoi': '越南', 'saigon': '越南',
  // 俄语区
  'russia': '俄语区', 'russian': '俄语区', 'москва': '俄语区', 'россия': '俄语区',
  'ukraine': '俄语区', 'kazakhstan': '俄语区',
  // 阿语海湾
  'dubai': '阿语海湾', 'saudi': '阿语海湾', 'saudiarabia': '阿语海湾',
  'qatar': '阿语海湾', 'kuwait': '阿语海湾', 'uae': '阿语海湾',
  // 阿语其他
  'egypt': '阿语其他', 'morocco': '阿语其他', 'cairo': '阿语其他',
  // 印度T3区
  'india': '印度T3区', 'indian': '印度T3区', 'nigeria': '印度T3区',
  'africa': '印度T3区', 'kenya': '印度T3区', 'pakistan': '印度T3区',
  // 欧美英德区
  'usa': '欧美英德区', 'america': '欧美英德区', 'american': '欧美英德区',
  'nyc': '欧美英德区', 'london': '欧美英德区', 'british': '欧美英德区',
  'canada': '欧美英德区', 'canadian': '欧美英德区',
  // 西班牙
  'spain': '西班牙', 'españa': '西班牙', 'madrid': '西班牙', 'barcelona': '西班牙',
};

/**
 * 从 bio 文本中匹配地理关键词
 * @param {string} bio
 * @returns {string|null} 地区组名
 */
function detectBioRegion(bio) {
  if (!bio || bio.length < 2) return null;
  const lower = bio.toLowerCase();

  // 先匹配多词（如 "new york", "ho chi minh"），再匹配单词
  const sortedKeys = Object.keys(GEO_KEYWORDS).sort((a, b) => b.length - a.length);
  for (const keyword of sortedKeys) {
    if (lower.includes(keyword)) {
      return GEO_KEYWORDS[keyword];
    }
  }
  return null;
}

/**
 * 从 hashtag 列表中投票地区
 * @param {string[]} hashtags — 不含 # 号
 * @returns {string|null} 得票最多的地区组
 */
function detectHashtagRegion(hashtags) {
  if (!hashtags || hashtags.length === 0) return null;

  const votes = {};
  for (const tag of hashtags) {
    const lower = tag.toLowerCase().replace(/^#/, '');
    const group = REGION_HASHTAGS[lower];
    if (group) votes[group] = (votes[group] || 0) + 1;
  }

  if (Object.keys(votes).length === 0) return null;
  let best = null, bestCount = 0;
  for (const [group, count] of Object.entries(votes)) {
    if (count > bestCount) { best = group; bestCount = count; }
  }
  return best;
}

/**
 * 5 信号投票判定地区
 *
 * @param {Object} signals
 * @param {string} [signals.authorRegion] — 达人注册国家代码
 * @param {string[]} [signals.videoDescs] — 视频标题/描述列表
 * @param {string} [signals.bio] — bio 文本
 * @param {string[]} [signals.hashtags] — hashtag 列表
 * @param {{ [cc: string]: number }} [signals.commentRegions] — 评论用户国家分布
 * @param {number} [signals.commentSamples] — 评论采样总数
 *
 * @returns {{ pricingRegions: { name: string, weight: number }[], rule: string }}
 */
function voteRegion({ authorRegion, videoDescs, bio, hashtags, commentRegions, commentSamples } = {}) {
  const votes = {};  // { 地区组名: 票数 }
  const signals = []; // 调试用

  // 信号1: author.region
  if (authorRegion) {
    const group = COUNTRY_TO_GROUP[authorRegion.toUpperCase()];
    if (group) {
      votes[group] = (votes[group] || 0) + 1;
      signals.push(`S1:author.region=${authorRegion}→${group}`);
    }
  }

  // 信号2: 视频语言检测
  const langGroup = detectTextLanguage(videoDescs);
  if (langGroup) {
    votes[langGroup] = (votes[langGroup] || 0) + 1;
    signals.push(`S2:videoLang→${langGroup}`);
  }

  // 信号3: Bio 地理关键词
  const bioGroup = detectBioRegion(bio);
  if (bioGroup) {
    votes[bioGroup] = (votes[bioGroup] || 0) + 1;
    signals.push(`S3:bioGeo→${bioGroup}`);
  }

  // 信号4: Hashtag 地区
  const hashGroup = detectHashtagRegion(hashtags);
  if (hashGroup) {
    votes[hashGroup] = (votes[hashGroup] || 0) + 1;
    signals.push(`S4:hashtag→${hashGroup}`);
  }

  // 信号5: 评论 region（加权票）
  let commentWinner = null;
  if (commentRegions && commentSamples >= 50) {
    const groups = classifyRegionGroup(commentRegions, commentSamples);
    const { pricingRegions: commentPR } = determinePricingRegion(groups);
    const weight = commentSamples >= 200 ? 3 : commentSamples >= 100 ? 2 : 1;
    for (const { name, weight: w } of commentPR) {
      votes[name] = (votes[name] || 0) + weight * w;
    }
    commentWinner = commentPR[0]?.name;
    signals.push(`S5:comments(n=${commentSamples},w=${weight})→${commentPR.map(r => r.name).join('+')}`);
  }

  // 无信号 → 兜底
  if (Object.keys(votes).length === 0) {
    return {
      pricingRegions: [{ name: '印度T3区', weight: 1 }],
      rule: 'vote:no-signals→fallback',
    };
  }

  // 排序取最高
  const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const [topGroup, topVotes] = sorted[0];
  const [secondGroup, secondVotes] = sorted[1] || [null, 0];

  // 平票时：优先评论信号（最权威）
  if (secondVotes === topVotes && commentWinner) {
    return {
      pricingRegions: [{ name: commentWinner, weight: 1 }],
      rule: `vote:tie→comment(${signals.join(', ')})`,
    };
  }

  return {
    pricingRegions: [{ name: topGroup, weight: 1 }],
    rule: `vote:${topGroup}=${topVotes}票(${signals.join(', ')})`,
  };
}


/**
 * 判定 KOL / KOC
 */
function determineCreatorLevel(pricingRegions, followerCount) {
  // 检查是否有日语地区
  const hasJapanese = pricingRegions.some(r => r.name === '日语');
  const threshold = hasJapanese ? KOL_THRESHOLDS['日语'] : KOL_THRESHOLDS.default;

  if (followerCount >= threshold) {
    return { level: 'KOL', reason: `followers ${formatNumber(followerCount)} ≥ ${formatNumber(threshold)}` };
  }
  return { level: 'KOC', reason: `followers ${formatNumber(followerCount)} < ${formatNumber(threshold)}` };
}

/**
 * 匹配播放量区间
 * @returns {{ index: number, label: string, lo: number, hi: number, belowMin: boolean }}
 */
function getPlayBracket(playCount, brackets) {
  // 低于最低区间
  if (playCount < brackets[0][0]) {
    return { index: -1, label: `<${brackets[0][2]}`, lo: 0, hi: brackets[0][0], belowMin: true };
  }
  // 超过最高区间
  if (playCount >= brackets[brackets.length - 1][1]) {
    const last = brackets[brackets.length - 1];
    return { index: brackets.length - 1, label: last[2], lo: last[0], hi: last[1], belowMin: false };
  }
  // 区间内
  for (let i = 0; i < brackets.length; i++) {
    if (playCount >= brackets[i][0] && playCount < brackets[i][1]) {
      return { index: i, label: brackets[i][2], lo: brackets[i][0], hi: brackets[i][1], belowMin: false };
    }
  }
  // fallback
  return { index: 0, label: brackets[0][2], lo: brackets[0][0], hi: brackets[0][1], belowMin: true };
}

/**
 * 好物分享播放量区间（独立区间定义）
 */
function getGoodsBracketIndex(playCount) {
  if (playCount < 5000) return null;      // <5k → 无价
  if (playCount < 10000) return 2;        // 5k-10k
  if (playCount < 50000) return 3;        // 10k-50k
  if (playCount < 100000) return 4;       // 50k-100k
  return 5;                               // 100k+
}

/**
 * 核心查价函数 — 线性插值
 * @param {string} regionGroup
 * @param {number} playCount
 * @returns {number}
 */
function lookupPrice(regionGroup, playCount) {
  const table = PRICE_TABLE[regionGroup];
  if (!table) return 0;

  const brackets = regionGroup === '韩语' ? PLAY_BRACKETS_KOREAN : PLAY_BRACKETS_DEFAULT;
  const bracket = getPlayBracket(playCount, brackets);

  if (bracket.index === -1) {
    // 低于最低区间：从 0 线性插值到 min
    const [priceMin] = table[0];
    const lowestBracketLo = brackets[0][0];
    if (lowestBracketLo === 0) return priceMin;
    const ratio = playCount / lowestBracketLo;
    return roundSig(priceMin * ratio, 3);
  }

  if (bracket.index >= table.length) {
    // 超出价格表范围 → 取最后一档 max
    return table[table.length - 1][1];
  }

  const [priceMin, priceMax] = table[bracket.index];

  if (playCount >= brackets[brackets.length - 1][1]) {
    // 超过最高播放量区间 → 取该档 max
    return priceMax;
  }

  // 区间内线性插值
  const ratio = (bracket.hi - bracket.lo) > 0
    ? (playCount - bracket.lo) / (bracket.hi - bracket.lo)
    : 0;
  const price = priceMin + (priceMax - priceMin) * ratio;
  return roundSig(price, 3);
}

/**
 * 好物分享查价 — 固定价格
 */
function lookupGoodsPrice(regionGroup, playCount) {
  const table = PRICE_TABLE_GOODS[regionGroup];
  if (!table) return null;

  const idx = getGoodsBracketIndex(playCount);
  if (idx === null || idx >= table.length) return null;
  return table[idx];
}

/**
 * 加权查价（多地区时按 weight 加权求和）
 */
function lookupWeightedPrice(pricingRegions, playCount) {
  let total = 0;
  for (const { name, weight } of pricingRegions) {
    total += lookupPrice(name, playCount) * weight;
  }
  return roundSig(total, 3);
}

/**
 * 好物分享加权查价
 */
function lookupWeightedGoodsPrice(pricingRegions, playCount) {
  let total = 0;
  let hasPrice = false;
  for (const { name, weight } of pricingRegions) {
    const p = lookupGoodsPrice(name, playCount);
    if (p !== null) {
      total += p * weight;
      hasPrice = true;
    }
  }
  return hasPrice ? roundSig(total, 3) : null;
}

/**
 * 检查互动率豁免：最低 3 条视频全部 (comment+share)/play ≥ 4%
 */
function checkEngagementExempt(videos) {
  if (!videos || videos.length < 3) return false;

  // 取播放量最低的 3 条
  const sorted = [...videos].sort((a, b) => (a.playCount || 0) - (b.playCount || 0));
  const bottom3 = sorted.slice(0, 3);

  return bottom3.every(v => {
    const play = v.playCount || 0;
    if (play === 0) return false;
    const rate = ((v.commentCount || 0) + (v.shareCount || 0)) / play;
    return rate >= ENGAGEMENT_EXEMPT_THRESHOLD;
  });
}


// ═══════════════════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════════════════

/**
 * 计算报价
 *
 * @param {Object} input
 * @param {number} input.followers — 粉丝数
 * @param {Array}  input.videos — 最近视频列表 [{ playCount, diggCount, commentCount, shareCount, createTime }]
 * @param {{ [countryCode: string]: number }} input.regionDistribution — 受众国家分布 { 'US': 120, 'BR': 80 }
 * @param {number} input.totalSamples — 受众采样总数
 * @param {string} [input.category='auto'] — 品类标签（'普通'/'AI'/'搬运'/... 或 'auto' 由外部分类）
 *
 * @returns {Object} 报价结果
 */
function calculateQuote({ followers, videos, regionDistribution, totalSamples, category = '普通',
  authorRegion, videoDescs, bio, hashtags } = {}) {
  // 1. 地区分组 & 报价地区判定（多信号投票 or 传统单信号）
  const hasVoteSignals = authorRegion || (videoDescs && videoDescs.length) || bio || (hashtags && hashtags.length);
  let groups, pricingRegions, rule;

  if (hasVoteSignals) {
    // 多信号投票
    const voteResult = voteRegion({
      authorRegion,
      videoDescs,
      bio,
      hashtags,
      commentRegions: regionDistribution,
      commentSamples: totalSamples || 0,
    });
    pricingRegions = voteResult.pricingRegions;
    rule = voteResult.rule;
    groups = classifyRegionGroup(regionDistribution || {}, totalSamples || 0);
  } else {
    // 传统：仅评论 region
    groups = classifyRegionGroup(regionDistribution || {}, totalSamples || 0);
    const result = determinePricingRegion(groups);
    pricingRegions = result.pricingRegions;
    rule = result.rule;
  }

  // 2. KOL/KOC 判定
  const { level: creatorLevel, reason: levelReason } = determineCreatorLevel(pricingRegions, followers || 0);

  // 3. 取播放量（升序排列，取最低 3 条）
  const playCounts = (videos || [])
    .map(v => v.playCount || 0)
    .filter(p => p > 0)
    .sort((a, b) => a - b);

  const play1 = playCounts[0] || 0;  // 最低
  const play2 = playCounts[1] || play1;
  const play3 = playCounts[2] || play2;

  // 4. KOL 且暂无 KOL 专属价格表 → 返回待定
  if (creatorLevel === 'KOL') {
    return {
      offerPrice: null,
      priceRange: null,
      priceCeiling: null,
      regionGroup: pricingRegions.map(r => r.name).join('+'),
      playBracket: null,
      creatorLevel,
      tagDiscount: null,
      engagementRate: null,
      recentMinPlay: play1,
      confidence: '无',
      detail: `KOL (${levelReason}) — 暂无 KOL 价格表，需人工报价`,
      kolPricingPending: true,
      groups,
      pricingRegions,
      rule,
    };
  }

  // 5. 选择播放量区间定义
  const isKorean = pricingRegions.some(r => r.name === '韩语');
  const brackets = isKorean ? PLAY_BRACKETS_KOREAN : PLAY_BRACKETS_DEFAULT;

  // 6. 品类规则
  const tagRule = TAG_RULES[category] || TAG_RULES['普通'];
  const useGoods = tagRule.useGoodsTable || false;

  // 7. 计算基础价格（3 个播放量点）
  let price1, price2, price3;

  if (useGoods) {
    // 好物分享分支：检查排除国家 & 地区是否有好物价格
    const hasExcluded = pricingRegions.some(r => {
      const countries = REGION_GROUPS[r.name] || [];
      return countries.some(cc => GOODS_EXCLUDE_COUNTRIES.includes(cc));
    });

    const gp1 = !hasExcluded ? lookupWeightedGoodsPrice(pricingRegions, play1) : null;
    const gp2 = !hasExcluded ? lookupWeightedGoodsPrice(pricingRegions, play2) : null;
    const gp3 = !hasExcluded ? lookupWeightedGoodsPrice(pricingRegions, play3) : null;

    if (gp1 !== null) {
      // 好物分享有效
      price1 = gp1;
      price2 = gp2 || gp1;
      price3 = gp3 || gp2 || gp1;
    } else {
      // 好物分享无价格 → 回退到普通价格表
      price1 = lookupWeightedPrice(pricingRegions, play1);
      price2 = lookupWeightedPrice(pricingRegions, play2);
      price3 = lookupWeightedPrice(pricingRegions, play3);
    }
  } else {
    // 普通分支
    price1 = lookupWeightedPrice(pricingRegions, play1);
    price2 = lookupWeightedPrice(pricingRegions, play2);
    price3 = lookupWeightedPrice(pricingRegions, play3);
  }

  // 8. 互动率豁免检查
  const engagementExempt = checkEngagementExempt(videos);

  // 9. 品类折扣应用（互动率豁免时不打折）
  let tagDiscount = { factor: tagRule.factor, cap: tagRule.cap };
  if (engagementExempt || useGoods) {
    tagDiscount = { factor: 1, cap: 0 };
  }

  function applyDiscount(price) {
    let result = price * tagDiscount.factor;
    if (tagDiscount.cap > 0 && result > tagDiscount.cap) {
      result = tagDiscount.cap;
    }
    return roundSig(result, 3);
  }

  const finalPrice1 = applyDiscount(price1);
  const finalPrice3 = applyDiscount(price3);

  // 10. 组装结果
  const quoteMin = Math.round(finalPrice1);
  const quoteMax = Math.round(finalPrice3);
  const offerPrice = quoteMin;             // 首次报价 = 区间低端
  const priceCeiling = quoteMax;           // 天花板 = 区间高端

  const bracket1 = getPlayBracket(play1, brackets);

  // 计算平均互动率
  let engagementRate = null;
  if (videos && videos.length > 0) {
    const rates = videos
      .filter(v => (v.playCount || 0) > 0)
      .map(v => ((v.commentCount || 0) + (v.shareCount || 0)) / v.playCount * 100);
    if (rates.length > 0) {
      engagementRate = parseFloat((rates.reduce((s, r) => s + r, 0) / rates.length).toFixed(1));
    }
  }

  // 置信度（基于采样量）
  let confidence = '低';
  if (totalSamples >= 200) confidence = '高';
  else if (totalSamples >= 100) confidence = '中';
  else if (totalSamples >= 50) confidence = '低';
  else confidence = '极低';

  const regionGroupStr = pricingRegions.map(r =>
    r.weight < 1 ? `${r.name}(${(r.weight * 100).toFixed(0)}%)` : r.name
  ).join(' + ');

  const detail = [
    `地区: ${regionGroupStr} [${rule}]`,
    `等级: ${creatorLevel} (${levelReason})`,
    `品类: ${category}${engagementExempt ? ' [互动率豁免]' : ''}`,
    `折扣: factor=${tagDiscount.factor}, cap=${tagDiscount.cap}`,
    `播放量: p1=${formatNumber(play1)}, p2=${formatNumber(play2)}, p3=${formatNumber(play3)}`,
    `基础价: $${price1} / $${price2} / $${price3}`,
    `最终价: $${finalPrice1} ~ $${applyDiscount(price3)}`,
    `报价: $${offerPrice} (ceiling: $${priceCeiling})`,
    `采样: ${totalSamples || 0} (置信度: ${confidence})`,
  ].join('\n');

  return {
    offerPrice,
    priceRange: [quoteMin, quoteMax],
    priceCeiling,
    regionGroup: regionGroupStr,
    playBracket: bracket1.label,
    creatorLevel,
    tagDiscount,
    engagementRate,
    recentMinPlay: play1,
    confidence,
    detail,
    // 内部详情（调试/展示用）
    groups,
    pricingRegions,
    rule,
    playStats: { play1, play2, play3 },
    priceByPlay: { price1, price2, price3 },
    engagementExempt,
    belowMinBracket: bracket1.belowMin,
  };
}


// ═══════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════

module.exports = {
  calculateQuote,
  // 导出子函数供测试/桥接使用
  classifyRegionGroup,
  determinePricingRegion,
  determineCreatorLevel,
  voteRegion,
  detectTextLanguage,
  detectBioRegion,
  detectHashtagRegion,
  lookupPrice,
  lookupGoodsPrice,
  checkEngagementExempt,
  roundSig,
  formatNumber,
  // 导出常量供外部引用
  REGION_GROUPS,
  COUNTRY_TO_GROUP,
  PRICE_TABLE,
  PRICE_TABLE_GOODS,
  TAG_RULES,
  PLAY_BRACKETS_DEFAULT,
  PLAY_BRACKETS_KOREAN,
};
