/**
 * 错误信息中文翻译
 * 把常见的英文系统错误翻译成人能看懂的中文
 */

const ERROR_TRANSLATIONS = [
  [/ENOENT.*no such file or directory.*open '?(.+?)'?$/im, (_, p) => `文件不存在: ${p}`],
  [/ENOENT.*no such file or directory/i, () => '文件或目录不存在'],
  [/EACCES.*permission denied/i, () => '没有访问权限，请检查文件是否被占用或权限不足'],
  [/EPERM/i, () => '操作被系统拒绝，文件可能被占用'],
  [/EBUSY/i, () => '文件被其他程序占用，请关闭后重试'],
  [/ENOSPC/i, () => '磁盘空间不足'],
  [/ECONNREFUSED/i, () => '连接被拒绝，目标服务未启动或网络不通'],
  [/ECONNRESET/i, () => '连接被重置，网络不稳定'],
  [/ETIMEDOUT/i, () => '连接超时，网络不通或目标服务器无响应'],
  [/ENETUNREACH/i, () => '网络不可达，请检查网络连接'],
  [/getaddrinfo.*ENOTFOUND/i, () => '域名解析失败，请检查网络连接'],
  [/does not have permission/i, () => 'Google Sheet 权限不足，请确认服务账号有编辑权限'],
  [/insufficient authentication/i, () => 'Google 认证失败，请检查凭证文件是否有效'],
  [/invalid_grant/i, () => 'Google 凭证已过期或无效，请重新下载凭证文件'],
  [/token has been expired/i, () => 'Google 令牌已过期，请重新授权'],
  [/Requested entity was not found/i, () => 'Google Sheet 不存在，请检查 Sheet ID 是否正确'],
  [/Unable to parse range/i, () => 'Sheet 标签页名称不正确，请检查设置'],
  [/net::ERR_/i, () => '网页加载失败，网络异常或页面不存在'],
  [/Navigation timeout/i, () => '页面加载超时，网络太慢或目标网站暂时无法访问'],
  [/Session closed/i, () => '浏览器会话已断开'],
  [/Protocol error/i, () => '浏览器通信异常，正在尝试恢复'],
  [/Target closed/i, () => '浏览器页面已关闭'],
  [/Invalid login/i, () => '登录失败，邮箱或密码错误'],
  [/AUTHENTICATIONFAILED/i, () => '邮箱认证失败，请检查账号密码'],
  [/self[- ]signed certificate/i, () => '证书验证失败（自签名证书）'],
  [/certificate has expired/i, () => 'SSL 证书已过期'],
  [/Too many login attempts/i, () => '登录尝试次数过多，请稍后再试'],
  [/rate limit/i, () => '请求频率过高，被限流了'],
  [/quota.*exceeded/i, () => 'API 配额已用完'],
];

function translateError(msg) {
  if (!msg) return '未知错误';
  for (const [pattern, replacer] of ERROR_TRANSLATIONS) {
    const match = msg.match(pattern);
    if (match) return replacer(...match);
  }
  return msg;
}

module.exports = { translateError };
