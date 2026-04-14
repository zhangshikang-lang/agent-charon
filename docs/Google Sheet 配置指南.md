# Google Sheet 配置指南

MARK 42 需要你提供自己的 Google 凭证文件来读写你的表格。整个过程 5 分钟。

---

## 第一步：创建 Google Cloud 项目

1. 打开 https://console.cloud.google.com/
2. 顶部栏点「选择项目」→「新建项目」
3. 名称随便填（比如 `my-outreach`），点「创建」

## 第二步：开启 Google Sheets API

1. 左侧菜单 →「API 和服务」→「库」
2. 搜索 `Google Sheets API`，点进去，点「启用」

## 第三步：创建服务账号

1. 左侧菜单 →「API 和服务」→「凭据」
2. 点顶部「+ 创建凭据」→ 选「服务账号」
3. 名称随便填（比如 `sheet-bot`），一路点「完成」

## 第四步：下载凭证 JSON 文件

1. 在「凭据」页面，找到刚创建的服务账号，点它
2. 切到「密钥」标签页
3. 点「添加密钥」→「创建新密钥」→ 选 **JSON** → 点「创建」
4. 浏览器会自动下载一个 `.json` 文件 — **这就是你要的凭证文件**

## 第五步：给服务账号授权你的表格

1. 打开你下载的 JSON 文件，找到 `client_email` 那一行，复制那个邮箱地址
   （长得像 `xxx@xxx.iam.gserviceaccount.com`）
2. 打开你的 Google Sheet
3. 点右上角「共享」
4. 把刚才复制的邮箱粘贴进去，权限选「编辑者」，点「发送」

## 第六步：在 MARK 42 中配置

1. 打开 MARK 42 →「设置」页
2. **Google Sheet ID**：从你的表格 URL 中复制
   `https://docs.google.com/spreadsheets/d/`**这一段就是ID**`/edit`
3. **凭证文件**：点「选择」，找到第四步下载的 JSON 文件
4. 点「保存所有设置」

---

搞定。现在 MARK 42 可以读写你自己的表格了。
