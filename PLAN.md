# Agent Charon — 局域网文件互传功能方案

## 架构

在现有引擎架构基础上新增一个 `lan-share.js` 引擎，负责：
1. **设备发现** — UDP 广播，局域网内自动发现其他 Agent Charon 实例
2. **文件传输** — HTTP server 提供文件上传/下载接口
3. **双向** — 既能推送文件给别人，也能从别人那拉取

## 技术方案

### 1. 设备发现（UDP 广播）
- 固定 UDP 端口 `42042`
- 每 3 秒广播一次心跳包：`{ name: hostname, ip, port: httpPort }`
- 监听其他设备的心跳，维护在线设备列表
- 超过 10 秒没收到心跳的设备标记为离线

### 2. 文件传输（HTTP Server）
- 固定 HTTP 端口 `42043`
- `POST /send` — 接收别人推送过来的文件（multipart/form-data）
- `GET /files` — 列出本机共享的文件列表
- `GET /download/:filename` — 别人拉取本机文件
- `POST /share` — 将本地文件加入共享列表

### 3. 接收文件存储
- 默认保存到：`桌面/Agent-Charon-收件/`
- 可在设置里改路径

### 4. 安全
- 纯局域网，同一公司，不加认证
- 只监听局域网 IP（0.0.0.0），不暴露公网

## 要改的文件

### 新建文件
- `src/main/engines/lan-share.js` — 局域网引擎（UDP发现 + HTTP文件服务）

### 修改文件
- `src/main/ipc.js` — 注册局域网相关 IPC 事件
- `src/preload/index.js` — 暴露 lanShare API
- `src/renderer/index.html` — 新增"局域网"导航 tab + 页面
- `src/renderer/app.js` — 新增局域网 UI 交互逻辑
- `src/renderer/styles.css` — 局域网页面样式
- `src/main/index.js` — 窗口标题改为 Agent Charon
- `package.json` — 改名 + 版本号

## UI 设计

导航栏新增第4个 tab「局域网」，页面内容：

```
┌─────────────────────────────────────────────┐
│  局域网文件互传                               │
│                                             │
│  本机: DESKTOP-ABC (192.168.1.100)          │
│  状态: ● 在线                                │
│                                             │
│  ── 在线设备 ──────────────────────────────  │
│  ┌─────────────────────┐                    │
│  │ DESKTOP-XYZ          │ [发送文件] [浏览]  │
│  │ 192.168.1.101        │                   │
│  └─────────────────────┘                    │
│  ┌─────────────────────┐                    │
│  │ LAPTOP-DEF           │ [发送文件] [浏览]  │
│  │ 192.168.1.102        │                   │
│  └─────────────────────┘                    │
│                                             │
│  ── 收到的文件 ────────────────────────────  │
│  📄 report.xlsx  来自 DESKTOP-XYZ  10:32    │
│  📄 data.csv     来自 LAPTOP-DEF   10:35    │
│                                             │
│  ── 我的共享文件 ──────────────────────────  │
│  [+ 添加文件到共享]                          │
│  📄 koc-sample.xlsx                         │
└─────────────────────────────────────────────┘
```

## 改名

所有 "MARK 42" → "Agent Charon"：
- package.json: name, productName, shortcutName
- index.html: title, nav-brand
- index.js: window title
- version: 1.1.0 → 2.0.0
