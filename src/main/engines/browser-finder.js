/**
 * 浏览器检测工具
 * 自动查找系统已安装的 Chrome 或 Edge 浏览器
 * 用于 puppeteer 的 executablePath 参数
 */
const fs = require('fs');
const path = require('path');

function findBrowserPath() {
  // 1. 检查 puppeteer 缓存（开发模式下有效）
  try {
    const puppeteer = require('puppeteer');
    const cachedPath = puppeteer.executablePath();
    if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;
  } catch {}

  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  // 2. 检查系统 Chrome
  const chromePaths = isWin ? [
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : isMac ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(process.env.HOME || '', 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const p of chromePaths) {
    if (p && fs.existsSync(p)) return p;
  }

  // 3. 检查系统 Edge
  const edgePaths = isWin ? [
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ] : isMac ? [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : [];
  for (const p of edgePaths) {
    if (p && fs.existsSync(p)) return p;
  }

  return null;
}

module.exports = { findBrowserPath };
