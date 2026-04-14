/**
 * 导出无邮箱 URL
 * 从 scrape-log.json 中提取所有没有邮箱的记录，输出到桌面 Excel
 *
 * 用法：双击运行 或 node scripts/export-no-email.js
 */
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

// scrape-log.json 位置：%APPDATA%/agent-charon/scraper-data/
const userDataDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'agent-charon')
  : path.join(require('os').homedir(), '.agent-charon');
const logPath = path.join(userDataDir, 'scraper-data', 'scrape-log.json');

if (!fs.existsSync(logPath)) {
  console.log('未找到爬取日志:', logPath);
  console.log('请确认 Agent Charon 至少运行过一次爬取任务');
  process.exit(1);
}

const logData = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
const scraped = logData.scraped || {};

// 筛选：没有邮箱且没有致命错误的记录
const noEmailEntries = [];
for (const [url, entry] of Object.entries(scraped)) {
  if (!entry.email) {
    noEmailEntries.push({
      url,
      username: entry.username || '',
      bio: (entry.bio || '').replace(/[\r\n]+/g, ' '),
      error: entry.error || '',
      time: entry.at || '',
    });
  }
}

if (noEmailEntries.length === 0) {
  console.log('没有无邮箱的记录，全部都有邮箱');
  process.exit(0);
}

// 生成 Excel
const headers = ['TikTok链接', '用户名', '简介', '错误信息', '爬取时间'];
const rows = noEmailEntries.map(e => [e.url, e.username, e.bio, e.error, e.time]);

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

// 列宽
ws['!cols'] = [
  { wch: 45 }, // url
  { wch: 20 }, // username
  { wch: 50 }, // bio
  { wch: 30 }, // error
  { wch: 20 }, // time
];

XLSX.utils.book_append_sheet(wb, ws, '无邮箱达人');

const desktop = path.join(require('os').homedir(), 'Desktop');
const outPath = path.join(desktop, '无邮箱达人链接.xlsx');
XLSX.writeFile(wb, outPath);

console.log(`导出完成！共 ${noEmailEntries.length} 条无邮箱记录`);
console.log(`文件位置: ${outPath}`);
