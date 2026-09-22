# 访客统计 · Visitor Statistics

基于 **Cloudflare Pages + Workers + D1 + GitHub** 的轻量访客追踪系统。

通过一张「伪装成图片」的追踪像素，记录每次访问的详细日志（IP、归属地、设备、浏览器等），并通过 Telegram 实时推送通知。图片与前端托管在 Cloudflare 边缘，数据永久保存在 D1。

---

## ✨ 功能

- 🖼 **追踪像素** — 上传任意图片作为追踪点，嵌入 HTML 即可统计访问
- 📊 **详细日志** — 每次访问记录时间 / IP / 归属地 / 运营商 / 设备 / 系统 / 浏览器 / 来源
- 📈 **灵活统计范围** — 概览曲线图支持今天 / 7 天 / 30 天 / 3 个月 / 1 年，支持按标识符筛选
- 📨 **Telegram 通知** — 实时推送每次有效访问，含完整设备指纹，按钮自动指向当前域名
- 🎨 **图片管理** — 网页端上传图片到 Git 仓库，自动触发 Pages 部署
- 🔍 **管理面板监控** — 内置 `_panel` 追踪点，记录所有访问登录页的访客
- 🚫 **反爬虫 / 反测速** — UA 黑名单 + /24 段冷却，避免被刷屏
- 💾 **纯 D1 存储** — 无每日写入配额困扰

---

## 🏗 架构

```
访客 → GET /nezha.png
        ↓
    Cloudflare Worker
        ├── 前台：读取 Git 静态资源 → 返回图片
        └── 后台：ctx.waitUntil()
                   ├── 写入 D1（详细日志 + 每日汇总）
                   └── 推送 Telegram（IP 冷却 60 秒）

管理员 → 管理面板
        ├── 上传图片 → Worker 写入 Git 仓库
        ├── 触发 Deploy Hook → Pages 重建
        └── 查询 D1 → 返回统计 / 日志
```

| 组件 | 用途 |
|---|---|
| **Cloudflare Pages** | 托管 `index.html` + `_worker.js` |
| **Cloudflare D1** | 存储访问日志、每日汇总、图片索引 |
| **Cloudflare Workers** | 处理 `/api/*` 与 `/<id>.<ext>` 请求 |
| **GitHub 仓库** | 存储图片二进制（`public/pic/*.{png,jpg,...}`） |
| **Telegram Bot API** | 推送访问通知 |

---

## 📋 前置要求

| 项 | 要求 |
|---|---|
| **Cloudflare 账号** | 免费版即可 |
| **GitHub 账号** | 用于存放图片 + 部署 Pages |
| **Telegram 账号** | 用于接收通知 |
| **域名** | 推荐准备一个域名（用于自定义访问） |

---

## 🔑 变量清单

整个部署需要准备 **7 个环境变量 + 1 个 D1 绑定**，建议先**全部获取完成**，最后一步统一配置。

| # | 变量名 | 类型 | 说明 | 获取位置 |
|---|---|---|---|---|
| 1 | `PASSWORD` | 环境变量 | 管理面板登录密码 | 自己设定 |
| 2 | `GITHUB_TOKEN` | 环境变量 | GitHub PAT | [第 5 步](#5-创建-github-personal-access-token) |
| 3 | `REPO_NAME` | 环境变量 | 仓库名 `owner/repo` | [第 2 步](#2-使用模板创建自己的仓库) |
| 4 | `BRANCH` | 环境变量 | 分支名（可选，默认 `main`） | 一般填 `main` |
| 5 | `CF_DEPLOY_HOOK_URL` | 环境变量 | Pages 部署挂钩 Hook URL  | [第 8 步](#8-创建-deploy-hook) |
| 6 | `TG_ID` | 环境变量 | Telegram chat_id | [第 4 步](#4-创建-telegram-bot) |
| 7 | `TG_TOKEN` | 环境变量 | Telegram bot token | [第 4 步](#4-创建-telegram-bot) |
| — | `DB` | D1 绑定 | 数据库绑定 | [第 3 步](#3-创建-d1-数据库) |

> 💡 Telegram 消息里「👤 管理仪表盘」按钮的地址**无需配置**——Worker 会自动使用本次请求的域名，你在哪个域名访问管理面板，按钮就指向哪个域名。

---

## 🚀 部署流程

### 1. 给作者点个 Star ⭐

如果这个项目对你有帮助，去 [仓库首页](https://github.com/oyz8/Visitor_Statistics) 点个 **Star** 支持一下！

### 2. 使用模板创建自己的仓库

1. 打开模板仓库 [oyz8/Visitor_Statistics](https://github.com/oyz8/Visitor_Statistics)
2. 点击右上角绿色的 **「Use this template」** 按钮 → 选择 **「Create a new repository」**
3. 填写表单：

   | 字段 | 值 |
   |---|---|
   | **Owner** | 你的 GitHub 用户名 |
   | **Repository name** | 例如 `visitor-statistics` |
   | **Description** | 可选 |
   | **Choose visibility** | 选 **Private**（推荐） |

4. ⚠️ **记录下仓库名**（格式 `owner/repo`），例如 `你的用户名/visitor-statistics` —— 这就是 `REPO_NAME` 的值。
5. 点击 **「Create repository」**

新仓库会自动包含 `index.html`、`_worker.js`、`README.md`。

> 📝 **记录**：`REPO_NAME = 你的用户名/仓库名`

### 3. 创建 D1 数据库

1. Cloudflare Dashboard → **Workers & Pages** → **D1** → **Create database**
2. 名称随意（例如 `visitor-stats`）
3. 创建后无需手动建表——首次登录管理面板时会自动创建

> 📝 **记录**：D1 数据库（后面配置绑定时选择）

### 4. 创建 Telegram Bot

1. Telegram 搜索 **@BotFather**
2. 发送 `/newbot`，按提示创建
3. 记录返回的 **token**（形如 `7xxxxxx:xxxxxxxxxxxxxxxxxx`）
4. 搜索你刚创建的 bot，发送 `/start`
5. 访问 `https://api.telegram.org/bot<token>/getUpdates`，找到 `"chat":{"id":xxxxx}`

> 📝 **记录**：
> - `TG_TOKEN = 7xxxxxx:xxxxxxxxxxxxxxxxxx`
> - `TG_ID = 123456789`

### 5. 创建 GitHub Personal Access Token

用于让 Worker 有权限写图片到你的仓库。

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
2. **Repository access**：只选你刚创建的 `visitor-statistics` 仓库
3. **Permissions** → **Contents**：**Read and write**
4. 生成并复制 token（形如 `ghp_xxxxx`）

> ⚠️ 复制时**不要带到尾部换行**。
>
> 📝 **记录**：`GITHUB_TOKEN = ghp_xxxxx`

### 6. 创建 Pages 项目

1. Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 选择**你刚才创建的仓库**
3. **Build settings**：
   - Framework preset：**None**
   - Build command：**留空**
   - Build output directory：**留空**（或 `/`）
4. 点击 **Save and Deploy**

部署完成后会得到一个 `*.pages.dev` 域名，例如 `xxx.pages.dev`。

### 7. ⚠️ 关闭 Git 自动部署（重要）

**为什么要关闭？**

本项目的图片更新走的是 **Worker → GitHub API → Deploy Hook** 路线，而非 `git push`。如果保留 Git 自动部署：

- 每次上传图片（Worker 提交到 Git）会**自动触发一次构建**
- 手动改代码 push 时也会**自动触发一次构建**
- 构建次数暴涨，配额浪费，且无法控制时机

**操作步骤**：

1. Pages 项目 → **Settings**
2. 左侧菜单 → **Builds & deployments**
3. 找到 **Automatic deployments** → **Disable**
4. 保存

> 💡 **副作用**：以后 `git push` 更新代码后，页面**不会自动更新**。需要手动 Retry deployment（见第 11 步）。

### 8. 创建 Deploy Hook（部署挂钩）

1. Pages 项目 → **Settings** → **Builds & deployments** → **Deploy hooks** → **Create**
2. 名称随意（例如 `manual`），分支选 `main`
3. 复制生成的 URL

> 📝 **记录**：`CF_DEPLOY_HOOK_URL = https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/xxxxx`

### 9. 绑定自定义域名（推荐）

默认的 `*.pages.dev` 域名较长且可能被墙。绑定自定义域名后：

- 访问更快
- 追踪图片链接更美观
- 更隐蔽

**如果已有 Cloudflare 托管的域名**（推荐）：

1. Pages 项目 → **Custom domains** → **Set up a custom domain**
2. 输入域名，例如 `img.你的域名.com`
3. 如果域名也在 Cloudflare 托管，会自动添加 CNAME 记录
4. 等 SSL 证书签发（约 1 分钟）

**如果域名在其他服务商**：

1. 在 Pages 项目 → **Custom domains** → 输入域名
2. 按提示去域名服务商处添加 CNAME 记录指向 `xxx.pages.dev`
3. 等待 DNS 生效

**完成后**：

- 访问 `https://img.你的域名.com/` → 打开管理面板
- 访问 `https://img.你的域名.com/nezha.png` → 追踪图片

> 📝 **记录**：自定义域名（用于生成追踪链接）

### 10. 统一配置环境变量与绑定

现在所有变量都准备好了，一次性配置到 Pages：

Dashboard → Pages 项目 → **Settings** → **Functions**：

#### D1 数据库绑定

| Variable name | D1 database |
|---|---|
| `DB` | 选择第 3 步创建的数据库 |

> ⚠️ 变量名**必须严格为 `DB`**（区分大小写）。

#### 环境变量（7 个）

| 变量名 | 值 |
|---|---|
| `PASSWORD` | 自己设定的强密码 |
| `GITHUB_TOKEN` | 第 5 步的 PAT |
| `REPO_NAME` | 第 2 步记录的 `owner/repo` |
| `BRANCH` | `main`（或留空） |
| `CF_DEPLOY_HOOK_URL` | 第 8 步的 Hook URL |
| `TG_ID` | 第 4 步的 chat_id |
| `TG_TOKEN` | 第 4 步的 token |

> ⚠️ 粘贴 `GITHUB_TOKEN` 后**不要按回车**，直接保存。

### 11. 首次部署

配置完环境变量和绑定后，**手动触发一次部署**使配置生效：

**方式一（推荐）**：

Dashboard → Pages 项目 → **Deployments** → 最新一条 → **Retry deployment**

**方式二**：

访问 Deploy Hook URL（GET/POST 都行），Cloudflare 会开始构建。

### 12. 验证

1. 打开 `https://你的域名/`（或 `xxx.pages.dev`）
2. 输入 `PASSWORD` 登录
3. 首次会弹出「初始化数据库」面板 → 点「创建数据表」
4. 系统自动创建 3 张表：`visits`、`daily_summary`、`img_index`
5. 进入管理面板 → 上传一张图片测试「保存并部署」流程
6. 访问 `https://你的域名/<标识符>.png` 验证图片正常返回
7. 检查 Telegram 是否收到通知，确认「👤 管理仪表盘」按钮指向你的域名

---

## 📖 使用方法

### 首次访问

1. 打开 `https://你的域名/`
2. 输入 `PASSWORD` 登录
3. 首次会弹出「初始化数据库」面板 → 点「创建数据表」
4. 系统自动创建 3 张表：`visits`、`daily_summary`、`img_index`
5. 进入管理面板

### 添加追踪图片

1. 「图片管理」→ 点「＋ 添加一行」
2. **填写标识符**（例如 `nezha`）—— 决定访问 URL 和 Git 文件名
3. 点击缩略图或「选择图片」上传任意本地图片（也可直接拖拽）
4. 一次性可以添加多行
5. 点「保存并部署」

**系统会**：
- 上传图片到 Git 仓库 `public/pic/nezha.png`
- 自动清理被替换/删除的旧图
- 自动触发 Pages 部署
- 30 秒后自动刷新，缩略图显示最新图

### 嵌入追踪像素

把链接嵌入到任何 HTML 页面或邮件正文：

```html
<img src="https://你的域名/nezha.png" width="1" height="1" alt="">
```

当访客打开页面时：
- 浏览器请求该图片 → Worker 拦截
- 记录访问日志到 D1
- 推送 Telegram 通知（同一 IP 60 秒内只推一次）
- 返回图片（浏览器显示）

### 查看统计

**概览页**：

- 顶部 4 个汇总数字：今日 / 昨日 / 近 7 天 / 近 1 年
- 顶部标识符标签：切「全部」或单个标识符，汇总数字与曲线同步切换
- **曲线图**：平滑面积折线图，支持 5 个时间范围：

  | 范围 | 内容 |
  |---|---|
  | **今天** | 按小时分桶，展示 24 小时访问量（00:00 ~ 23:00） |
  | **7 天** | 按天 |
  | **30 天** | 按天 |
  | **3 个月** | 按天 |
  | **1 年** | 按天，展示近 365 天全部数据 |

- 鼠标悬停曲线上的数据点可查看具体日期 / 小时与访问次数

**详细日志页**：

- 按日期 / 标识符 / IP 筛选
- 分页浏览每次访问的完整记录

### 管理面板访问监控

登录页标题前的云图标 `/_panel.svg` 是内置追踪点：

- **任何人打开管理面板**（未登录访客）都会触发追踪
- **已登录用户刷新不会触发**（图标切换为内联 data URI）
- 在概览 / 日志中显示为 `_panel`，名称固定为「管理面板」
- 退出登录后再次访问会重新触发

---

## ⚠️ 注意事项

### 数据存储

| 存储 | 用途 | 免费额度 |
|---|---|---|
| **D1** | 访问日志 + 汇总 + 图片索引 | 5 GB 存储 / 10 万写/天 / 500 万读/天 |
| **GitHub** | 图片二进制 | 仓库 ≤ 1 GB（推荐） |
| **Cloudflare Pages** | 静态资源 + Worker | 无限带宽 |

### 图片限制

- **单张 ≤ 8 MB**（超过报错）
- **支持格式**：PNG / JPG / GIF / WebP / SVG
- **文件名 = 标识符 + 扩展名**：填 `nezha` 上传 PNG → Git 里是 `nezha.png`
- **标识符规则**：字母、数字、下划线、连字符，长度 1–64
- **保留标识符**：`_panel`（系统内置）

### Telegram 通知规则

- **同 IP 60 秒内**只推送 1 条（内存冷却）
- **同 /24 段 IP** 共享冷却，避免同机房批量访问刷屏
- **爬虫 UA** 不推送：`bot` / `spider` / `curl` / `itdog` / `boce` 等
- **测速站 Referer** 不推送：`itdog.cn` / `boce.com` / `17ce.com` 等
- **「👤 管理仪表盘」按钮地址**自动使用本次请求的域名，无需任何配置

### 部署相关

- **Git 自动部署已关闭**——上传图片后必须通过管理面板点「保存并部署」触发
- **Deploy Hook URL 只创建一次**——如果更换了 Pages 项目，需要重新创建
- **环境变量改动后**需要 **Retry deployment** 才生效
- **图片更新后**约 30 秒生效（Pages 构建时间），期间缩略图可能 404

### 自定义域名

- 在 Pages 项目 → **Custom domains** 里绑定
- 推荐用子域名（如 `img.你的域名.com`）避免与主站冲突
- 绑定后所有追踪链接都用新域名，**原来的 `*.pages.dev` 仍可访问**
- 域名不用必须托管在 Cloudflare，但托管在 Cloudflare 更简单

### 常见错误

| 错误信息 | 原因 | 解决 |
|---|---|---|
| `未授权` | 密码错误 / 未登录 | 重新登录 |
| `D1_ERROR: no such table: xxx` | 数据库未初始化 | 登录面板点「创建数据表」 |
| `Invalid header value` | `GITHUB_TOKEN` 带换行 / 空格 | 重新粘贴，不按回车 |
| `GitHub PUT 401` | PAT 权限不足 / 过期 | 重新生成，勾选 `Contents: Read and write` |
| `GitHub PUT 404` | `REPO_NAME` 拼写错误 / 仓库不存在 | 检查格式：`用户名/仓库名` |
| `Hook 4xx / 5xx` | Deploy Hook 失效 | 重新创建 Hook，更新 `CF_DEPLOY_HOOK_URL` |
| 图片 404 | Pages 未构建完 | 等 30 秒后刷新 |
| 图片裂图 | Git 里文件路径不对 | 检查 `public/pic/xxx.png` 是否存在 |

### 安全建议

- **`PASSWORD` 用强密码**，不要与其他服务共用
- **PAT 权限最小化**：只给目标仓库的 `Contents: Read and write`
- **不要公开 `CF_DEPLOY_HOOK_URL`**——任何人拿到可以触发部署
- **管理面板 URL 不要公开**——虽然需要密码，但登录页本身也会被 `_panel` 追踪

### 数据备份

D1 数据定期导出：

```bash
# 需要 wrangler CLI 和 Cloudflare API Token
wrangler d1 export visitor-stats --remote --output backup.sql
```

Git 里的图片天然有版本历史，无需额外备份。

---

## 🔧 高级配置

### 修改追踪数据保留天数

默认保留 **365 天（1 年）**。修改 `_worker.js` 顶部：

```javascript
const STATS_DAYS = 30;   // 30 天（月度视图）
const STATS_DAYS = 90;   // 90 天（季度视图）
const STATS_DAYS = 365;  // 默认，1 年
const STATS_DAYS = 730;  // 2 年（前提：D1 存得下）
```

> ⚠️ **D1 免费版每天 500 万行读**。365 天的 `daily_summary` 查询大约返回 `365 × 标识符数量` 行，标识符 ≤ 100 时没问题（3.6 万行/次）。如果标识符很多，请谨慎调大。
>
> 💡 前端概览页的「1 年」按钮显示的正是 `STATS_DAYS` 内的全部数据，改这个值会同步影响可查看范围。

### 修改 Telegram 冷却时间

默认 60 秒。修改 `_worker.js` 顶部：

```javascript
const PUSH_COOLDOWN_SEC = 300;  // 改成 5 分钟
```

### 添加自定义白名单 / 黑名单

修改 `_worker.js` 里的两个正则：

```javascript
const BOT_RE = /.../;              // 爬虫 UA 黑名单
const REFERER_BLOCK_RE = /.../;    // 测速站 Referer 黑名单
```

---

## 📁 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 管理面板前端（登录 + 概览 + 日志 + 图片管理 + 说明） |
| `_worker.js` | 后端 Worker（API + 图片追踪 + Git 上传 + TG 推送） |
| `README.md` | 本文档 |
| `public/pic/*` | 图片二进制（由 Worker 自动上传） |

---

## ❓ FAQ

**Q: 为什么我推送了代码，页面没更新？**
A: Git 自动部署已关闭（见部署流程第 7 步）。进 Dashboard → Pages → Deployments → Retry deployment 手动触发一次。

**Q: 一共需要多少个环境变量？**
A: **7 个环境变量 + 1 个 D1 绑定**。见 [变量清单](#-变量清单)。

**Q: 能不能同时追踪多个站点？**
A: 能。上传多个图片，每个标识符一个追踪点，独立统计。

**Q: 有没有访问次数上限？**
A: D1 免费版每天 10 万次写入。每次访问写 2 行（visits + daily_summary），即每天约 5 万次有效访问。超出后写入失败但图片仍正常返回。

**Q: 图片占空间吗？**
A: GitHub 仓库 ≤ 1 GB 免费，按每张 100 KB 算能存 1 万张。

**Q: 为什么不用 KV？**
A: KV 免费版每天仅 1000 次写入，冷却标记 / 索引更新很快耗尽。D1 的 10 万写/天更宽裕，且支持关系查询。

**Q: 可以部署到 Workers 而非 Pages 吗？**
A: 可以，但需要自己托管静态资源（如用 R2 或 Workers Sites）。当前方案依赖 Pages 的 `ASSETS` 绑定。

**Q: Telegram 按钮为什么会自动指向我的域名？**
A: Worker 每次收到访问请求时，会取该请求的 `request.url` 得到当前域名，Telegram 消息里的「👤 管理仪表盘」按钮就指向这个域名。你在哪个域名下使用管理面板，通知按钮就指向哪个域名，无需任何配置。

**Q: 如何清空所有数据重新开始？**
A: 在 D1 Console 执行：
```sql
DROP TABLE IF EXISTS visits;
DROP TABLE IF EXISTS daily_summary;
DROP TABLE IF EXISTS img_index;
```
然后登录管理面板重新「创建数据表」。

**Q: 仓库可以设为 Private 吗？**
A: 可以。本项目推荐使用 **Private** 仓库——图片只对你可见，Worker 通过 PAT 上传，Pages 通过 Git 授权访问。访问者通过 Pages 域名看到图片，但无法浏览你的 Git 仓库。

**Q: 关闭 Git 自动部署后，我改代码怎么办？**
A: 改完 `git push` 后，去 Dashboard → Pages → Deployments → 最新一条 → **Retry deployment**，或在 Deploy Hook URL 上点一次（GET 请求即可）。

**Q: 一定要绑定自定义域名吗？**
A: **不强制**，但**强烈推荐**。原因：
1. `*.pages.dev` 域名长且不稳定（Cloudflare 有时会调整）
2. 国内访问 `*.pages.dev` 可能受限
3. 追踪图片链接更美观，例如 `img.你的域名.com/nezha.png`
4. 便于后续统计和防护

**Q: 绑定域名后原来的 pages.dev 还能访问吗？**
A: 能。绑定自定义域名后，两个域名**同时可用**，不会互相影响。

---

## 📄 许可证

MIT

---

## 🙏 致谢

- [Cloudflare Workers / Pages / D1](https://developers.cloudflare.com/)
- [Telegram Bot API](https://core.telegram.org/bots/api)

---

## 免责声明

- 本项目仅供学习与技术交流使用，作者不对因使用本项目造成的任何直接或间接损失负责。
- 项目中涉及的 Cloudflare、GitHub、Telegram 等第三方服务，请遵守其各自的服务条款。
