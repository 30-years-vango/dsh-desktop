# DSH Desktop

DeepSeek Harness 的 Windows 桌面版：双击即用，无需命令行、无需浏览器，支持自动更新。

- **自包含**：内嵌 Node.js 运行时 + `@deepseek-ai/dsh` 全量依赖，启动时自动拉起本地 DSH 服务器（默认 `127.0.0.1:3080`）并在应用窗口内展示 Web GUI。
- **复用已有数据**：默认使用与 CLI 相同的 `DSH_HOME`（`C:\Users\admin\.dsh`），已有会话、配置、存储直接可见。
- **智能端口**：若 3080 已有正在运行的 `dsh web` 实例，直接复用（连接模式）；被其他程序占用则自动扫描空闲端口。
- **自动更新**：通过 GitHub Releases + electron-updater 检查、下载、安装新版本（含内嵌 dsh 的升级）。

---

## 一、日常使用

1. 安装 `DSH-Desktop-x.y.z-setup.exe`（安装时可选择目录）。
2. 从开始菜单或桌面快捷方式启动 **DSH Desktop**。
3. 主窗口加载 DSH GUI；关闭窗口默认最小化到托盘（托盘图标：显示/隐藏、浏览器打开、设置、重启服务器、检查更新、退出）。

> 未签名安装包首次运行会弹 SmartScreen 提示：点 **更多信息 → 仍要运行** 即可。

## 二、从源码构建（开发者）

前置：Node.js（建议 v24.x）、可联网。

```powershell
cd dsh-desktop
npm.cmd install          # 安装 electron / electron-builder / electron-updater
npm run icon             # 生成 DeepSeek 鲸鱼图标（白鲸 + 品牌蓝底，取自 DSH 官方 favicon.svg）
npm run runtime          # 下载 Node 便携版 + 安装 @deepseek-ai/dsh 到 resources/
npm run dev              # 开发运行（加载本地 resources，调试主进程）
npm run dist             # 产出 NSIS 安装包到 build/（含 latest.yml 更新元数据）
```

> 本机 PowerShell 执行策略禁用 `npm.ps1`，请使用 `npm.cmd`。
> npm / Electron 下载缓存默认在工作区 `.cache/` 内，无需额外配置。

## 三、发布与自动更新

### 1. 准备 GitHub 仓库

创建仓库（例如 `dsh-desktop`），然后在 `package.json` 的 `build.publish` 中填写你的用户名：

```json
"publish": { "provider": "github", "owner": "<你的GitHub用户名>", "repo": "dsh-desktop" }
```

### 2. 升级内嵌 dsh 并发布新版本

每次想升级 dsh（或改代码）时：

```powershell
npm run runtime                       # 拉取 @deepseek-ai/dsh@latest 到 resources/dsh
# 修改 package.json 中的 version（例如 0.1.1）
$env:GH_TOKEN = "<你的GitHub Token>"
npm run publish                       # 构建并自动创建 GitHub Release 并上传安装包
```

应用下次启动（或 4 小时后，或托盘"检查更新"）即可检出并自动安装新版本。

> Token 需要 `repo` 权限。若不想自动建 Release，可改用 `npm run dist` 后手动上传 `build/` 下的
> `DSH-Desktop-x.y.z-setup.exe`、`latest.yml`、`latest.yml.blockmap` 到 Release 资产。

### 3. 本地测试更新链路（不依赖 GitHub）

```powershell
npm run dist                          # 生成 v0.1.0 产物（或已安装的旧版本）
# 修改 version → 0.1.1，再次 npm run dist
npm run serve:feed                    # 本地更新源 http://127.0.0.1:8080 服务 build/
$env:DSH_UPDATE_FEED_URL = "http://127.0.0.1:8080"
npm run dev                           # 运行应用 → 设置 → 检查更新 → 下载并安装 0.1.1
```

`DSH_UPDATE_FEED_URL` 环境变量可把更新源临时指向任意 generic 服务器，方便测试，也支持自建更新源。
`DSH_UPDATE_AUTO_INSTALL=1` 可跳过确认对话框直接重启安装（无交互/CI 场景）。
`DSH_DEFAULT_PORT` 可覆盖默认端口（测试辅助）。

## 四、配置

设置窗口（托盘 → 设置）可修改并持久化到 `%APPDATA%/dsh-desktop/settings.json`：

| 配置项 | 说明 |
|---|---|
| 服务器端口 | 默认 3080；修改后自动重启服务器 |
| 工作目录 | dsh 进程的启动目录（模型感知的 cwd） |
| DSH_HOME | 用户数据目录，默认 `%USERPROFILE%\.dsh` |
| 关闭到托盘 | 关窗口最小化到托盘 |
| 自动检查更新 | 每 4 小时检查一次（默认开启） |

日志：`%APPDATA%/dsh-desktop/logs/dsh.log`（dsh 子进程输出 + 应用日志）。

## 五、目录结构

```
dsh-desktop/
├── package.json            # 应用清单 + electron-builder 配置（publish: github）
├── dev-app-update.yml      # 开发期本地更新源
├── scripts/
│   ├── prepare-runtime.mjs # 下载 Node + 安装 dsh 包
│   ├── gen-icon.mjs        # 生成占位图标
│   └── serve-local-feed.mjs# 本地更新源测试服务器
├── src/
│   ├── main.js             # 主进程：服务器子进程/托盘/更新
│   ├── preload.js          # contextBridge IPC
│   └── renderer/           # 设置窗口 + 启动/错误页
└── resources/              # 构建时填充：node/（Node 运行时）、dsh/（dsh 包）、icon.ico
```

## 六、已知限制

- 仅支持 Windows x64。
- 未做代码签名，SmartScreen 会提示（功能不受影响；如需静默安装可后续购买证书签名）。
- 托盘退出会整树结束 dsh 子进程；进程异常退出时自动重启（最多 3 次）。
- 应用版本独立于 dsh 版本；升级 dsh 后需发布新应用版本。
- dsh 每次启动会把 `$DSH_HOME/profiles/node_modules` 里的安装链接指向本次运行的安装位置（这是 dsh 的
  设计，确保 profile 插件可解析）。若同时混用命令行版（npx/全局）与桌面版，两者启动时会互相改指向
  ——各自启动后都能正常工作，但建议固定使用其中一个入口（桌面版）。
