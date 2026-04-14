const XLSX = require('xlsx');
const path = require('path');

const desktop = path.join(require('os').homedir(), 'Desktop');
const filePath = path.join(desktop, 'test.xlsx');

const wb = XLSX.utils.book_new();

// 待爬取 - TT 测试数据：混合 URL 和 username
const ttQueue = XLSX.utils.aoa_to_sheet([
  ['link'],
  ['https://www.tiktok.com/@testuser1'],
  ['@testuser2'],
  ['testuser3'],
]);
XLSX.utils.book_append_sheet(wb, ttQueue, '待爬取');

// IG待爬取 - IG 测试数据
const igQueue = XLSX.utils.aoa_to_sheet([
  ['link'],
  ['https://www.instagram.com/iguser1'],
  ['@iguser2'],
  ['iguser3'],
]);
XLSX.utils.book_append_sheet(wb, igQueue, 'IG待爬取');

// 未发送
const unsent = XLSX.utils.aoa_to_sheet([['url', 'username', 'email']]);
XLSX.utils.book_append_sheet(wb, unsent, '未发送');

// IG未发送
const igUnsent = XLSX.utils.aoa_to_sheet([['url', 'username', 'email']]);
XLSX.utils.book_append_sheet(wb, igUnsent, 'IG未发送');

// 已发送
const sent = XLSX.utils.aoa_to_sheet([['url', 'username', 'email', 'sent_at', 'sent_by', 'template_subject']]);
XLSX.utils.book_append_sheet(wb, sent, '已发送');

// IG已发送
const igSent = XLSX.utils.aoa_to_sheet([['url', 'username', 'email', 'sent_at', 'sent_by', 'template_subject']]);
XLSX.utils.book_append_sheet(wb, igSent, 'IG已发送');

XLSX.writeFile(wb, filePath);
console.log('测试文件已创建:', filePath);
