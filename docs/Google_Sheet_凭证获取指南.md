# Google Sheet 凭证获取指南

Agent Charon 使用 **Google 服务账号 (Service Account)** 连接 Google Sheet。
按以下步骤操作，全程免费，大约 5 分钟。

---

## 第一步：创建 Google Cloud 项目

1. 打开 https://console.cloud.google.com/
2. 用你的 Google 账号登录
3. 点击页面顶部的项目选择器 → **新建项目**
4. 项目名称随便填（比如 `agent-charon`），点 **创建**
5. 等几秒，确认已切换到新项目（顶部显示项目名）

---

## 第二步：启用 Google Sheets API

1. 在 Google Cloud Console 左侧菜单，找到 **API 和服务** → **库**
   - 或者直接访问：https://console.cloud.google.com/apis/library
2. 搜索 **Google Sheets API**
3. 点进去，点 **启用**

---

## 第三步：创建服务账号

1. 左侧菜单 → **API 和服务** → **凭据**
   - 或直接访问：https://console.cloud.google.com/apis/credentials
2. 点顶部 **+ 创建凭据** → 选 **服务账号**
3. 填写信息：
   - 服务账号名称：随便填（比如 `charon-sheets`）
   - 服务账号 ID：会自动生成，不用改
4. 点 **创建并继续**
5. 角色那一步可以直接跳过（点 **继续**）
6. 最后一步也跳过，点 **完成**

---

## 第四步：下载凭证 JSON 文件

1. 在凭据页面，找到刚创建的服务账号，点击它的邮箱地址进入详情
2. 切换到 **密钥** 标签页
3. 点 **添加密钥** → **创建新密钥**
4. 选 **JSON** 格式，点 **创建**
5. 浏览器会自动下载一个 `.json` 文件 — **这就是凭证文件，妥善保管**

> 文件名类似：`agent-charon-xxxxx-xxxxxxxxxxxx.json`

---

## 第五步：给服务账号共享你的 Google Sheet

这一步很关键，很多人会漏掉！

1. 打开你下载的 JSON 文件，找到 `client_email` 字段，复制那个邮箱地址
   - 格式类似：`charon-sheets@agent-charon-xxxxx.iam.gserviceaccount.com`
2. 打开你要用的 Google Sheet 在线表格
3. 点右上角 **共享**
4. 把服务账号的邮箱粘贴进去
5. 权限选 **编辑者**
6. 取消勾选"通知对方"（服务账号没有邮箱收件箱）
7. 点 **共享**

---

## 第六步：在 Agent Charon 中配置

1. 打开 Agent Charon 桌面端
2. 进入 **设置** 页面
3. **Google 凭证文件**：点击选择，选中刚下载的 JSON 文件
4. **Google Sheet ID**：从你的表格 URL 中复制
   - URL 格式：`https://docs.google.com/spreadsheets/d/`**这一段就是ID**`/edit`
   - 例如：`1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms`
5. 点 **保存设置**
6. 点 **同步表格结构** 测试连接

---

## 常见问题

### Q: 提示"权限不足"或"找不到表格"
A: 99% 是第五步没做 — 没把服务账号邮箱加为表格的编辑者。

### Q: 提示"API 未启用"
A: 回到第二步，确认 Google Sheets API 已启用，且项目选对了。

### Q: 凭证文件丢了怎么办？
A: 回到 Google Cloud Console → 凭据 → 服务账号 → 密钥，重新创建一个新的就行，旧的会自动失效。

### Q: 要花钱吗？
A: 不要。Google Sheets API 免费额度很大（每分钟 60 次读取、每分钟 60 次写入），Agent Charon 的用量远远用不到上限。

---

*最后更新：2026-04-09*
