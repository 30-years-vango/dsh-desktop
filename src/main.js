"use strict";
/**
 * dsh-desktop 主进程
 *
 * 职责：
 *   - 单实例锁
 *   - 解析端口：默认 3080；被已有 DSH 实例占用 → 连接模式；被其他程序占用 → 扫描空闲端口
 *   - 用内嵌的 Node 运行时以子进程方式启动 dsh web 服务器（--port <p>）
 *   - 服务器就绪后，主窗口加载 http://127.0.0.1:<p> 的 DSH GUI
 *   - 系统托盘、设置窗口、日志、崩溃退避重启
 *   - electron-updater 自动更新（GitHub Releases；可用 DSH_UPDATE_FEED_URL 覆盖为任意 generic 源）
 */
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// 从关闭的终端/后台任务启动时，stdout/stderr 可能是已断裂的管道（EPIPE）。
// 任何 console 写入（如 electron-updater 的日志）都不应让主进程崩溃。
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

/* ── 常量与默认值 ─────────────────────────────────────────── */
const DEFAULTS = {
  port: process.env.DSH_DEFAULT_PORT ? Number(process.env.DSH_DEFAULT_PORT) : 3080,
  defaultWorkingDirectory: os.homedir(),
  closeToTray: true,
  autoUpdate: true,
  dshHome: process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : path.join(os.homedir(), ".dsh"),
};
const PORT_SCAN_MAX = 3100;
const READY_TIMEOUT_MS = 30_000;
const UPDATE_INTERVAL_MS = 4 * 3600 * 1000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

let settings = { ...DEFAULTS };
let mainWindow = null;
let settingsWindow = null;
let tray = null;
let child = null;
let quitting = false;
let suppressExitRestart = false;
let restarts = 0;
let nodeVersionCached = null;

const serverState = { phase: "starting", mode: "spawn", port: null, url: null, error: null }; // starting|connecting|running|error
const updateState = { state: "idle", info: null, progress: null, error: null }; // idle|checking|available|not-available|downloading|downloaded|error

/* ── 工具 ─────────────────────────────────────────────────── */
function userData(...seg) {
  return path.join(app.getPath("userData"), ...seg);
}
function logsDir() {
  return userData("logs");
}
function logFile() {
  return userData("logs", "dsh.log");
}
function appendLog(line) {
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    const stamp = new Date().toISOString();
    let existing = "";
    try {
      existing = fs.readFileSync(logFile(), "utf8");
    } catch {}
    if (existing.length > MAX_LOG_BYTES) existing = existing.slice(-MAX_LOG_BYTES / 2);
    fs.writeFileSync(logFile(), `${existing}${stamp} ${line}\n`);
  } catch {}
}
/** 打包后资源在 process.resourcesPath；开发时在项目 resources/ 目录。 */
function resPath(...seg) {
  return app.isPackaged ? path.join(process.resourcesPath, ...seg) : path.join(__dirname, "..", "resources", ...seg);
}
function nodeExe() {
  return resPath("node", "node.exe");
}
function dshBinJs() {
  return resPath("dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
}
function readDshVersion() {
  try {
    return require(resPath("dsh", "node_modules", "@deepseek-ai", "dsh", "package.json")).version;
  } catch {
    return "未知";
  }
}
function getNodeVersion() {
  if (nodeVersionCached) return Promise.resolve(nodeVersionCached);
  return new Promise((resolve) => {
    try {
      const p = spawn(nodeExe(), ["--version"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", (d) => (out += String(d)));
      p.on("close", () => {
        nodeVersionCached = out.trim() || "未知";
        resolve(nodeVersionCached);
      });
      p.on("error", () => {
        nodeVersionCached = "未知";
        resolve(nodeVersionCached);
      });
    } catch {
      nodeVersionCached = "未知";
      resolve(nodeVersionCached);
    }
  });
}
function urlFor(port) {
  return `http://127.0.0.1:${port}`;
}
function isAllowedUrl(u) {
  try {
    const t = new URL(u);
    if (t.protocol === "file:") return true;
    if ((t.hostname === "127.0.0.1" || t.hostname === "localhost" || t.hostname === "[::1]") && t.protocol === "http:") return true;
    return false;
  } catch {
    return false;
  }
}

/* ── 设置持久化 ───────────────────────────────────────────── */
function settingsPath() {
  return userData("settings.json");
}
function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    appendLog(`保存设置失败: ${err.message}`);
  }
}

/* ── 探测与端口解析 ───────────────────────────────────────── */
function probe(urlStr, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, body = "") => {
      if (!settled) {
        settled = true;
        resolve({ ok, body });
      }
    };
    try {
      const req = http.get(urlStr, { timeout: timeoutMs }, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
          if (body.length > 1 << 16) req.destroy();
        });
        res.on("end", () => done(res.statusCode === 200, body));
        res.on("error", () => done(false));
      });
      req.on("timeout", () => {
        req.destroy();
        done(false);
      });
      req.on("error", () => done(false));
    } catch {
      done(false);
    }
  });
}
async function isDshServer(port) {
  const r = await probe(urlFor(port), 1500);
  return r.ok && r.body.includes("__DSH_BOOT__");
}
/** 返回 { mode: 'spawn'|'connect'|'error', port, error? } */
async function resolveServer() {
  const preferred = Number(settings.port) || DEFAULTS.port;
  const first = await probe(urlFor(preferred), 1500);
  if (!first.ok) return { mode: "spawn", port: preferred };
  if (first.body.includes("__DSH_BOOT__")) return { mode: "connect", port: preferred };
  // 首选端口被其他程序占用：扫描可用端口，顺带发现其他 DSH 实例
  for (let p = 3080; p <= PORT_SCAN_MAX; p++) {
    if (p === preferred) continue;
    const r = await probe(urlFor(p), 800);
    if (r.body.includes("__DSH_BOOT__")) return { mode: "connect", port: p };
    if (!r.ok) return { mode: "spawn", port: p };
  }
  return { mode: "error", port: null, error: `端口 ${preferred}–${PORT_SCAN_MAX} 均被占用，无法启动服务器` };
}

function waitForServer(urlStr, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (quitting) return resolve(false);
      probe(urlStr, 800).then((r) => {
        if (r.ok) resolve(true);
        else if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tick, 400);
      });
    };
    tick();
  });
}

/* ── 服务器生命周期 ───────────────────────────────────────── */
function setServerState(patch) {
  Object.assign(serverState, patch);
  pushStatus();
}
function fail(message) {
  appendLog(`FAIL: ${message}`);
  setServerState({ phase: "error", error: message });
}
async function startServer() {
  const resolved = await resolveServer();
  if (resolved.mode === "error") return fail(resolved.error);
  suppressExitRestart = false;
  setServerState({ phase: "starting", mode: resolved.mode, port: resolved.port, url: urlFor(resolved.port), error: null });
  if (resolved.mode === "connect") {
    appendLog(`连接已有 DSH 实例：${urlFor(resolved.port)}`);
    setServerState({ phase: "connecting" });
    const ok = await waitForServer(urlFor(resolved.port), 5000);
    if (!ok) return fail(`端口 ${resolved.port} 有响应但非 DSH 服务器`);
    setServerState({ phase: "running" });
    appendLog(`服务器就绪（连接模式）：${serverState.url}`);
    loadMainWindow();
    return;
  }
  spawnDshServer(resolved.port);
}
function spawnDshServer(port) {
  const exe = nodeExe();
  const bin = dshBinJs();
  if (!fs.existsSync(exe)) return fail(`缺少内嵌 Node 运行时：${exe}（请先运行 npm run runtime）`);
  if (!fs.existsSync(bin)) return fail(`缺少内嵌 dsh 包：${bin}（请先运行 npm run runtime）`);
  appendLog(`spawn: ${exe} ${bin} web --port ${port}`);
  const env = { ...process.env, DSH_HOME: settings.dshHome || DEFAULTS.dshHome };
  child = spawn(exe, [bin, "web", "--port", String(port)], {
    env,
    cwd: settings.defaultWorkingDirectory || os.homedir(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => appendLog(`[dsh] ${String(d).trimEnd()}`));
  child.stderr.on("data", (d) => appendLog(`[dsh:err] ${String(d).trimEnd()}`));
  child.on("error", (err) => {
    appendLog(`spawn error: ${err.message}`);
    fail(`无法启动 DSH 服务器：${err.message}`);
  });
  child.on("exit", (code, signal) => {
    appendLog(`dsh 进程退出 code=${code} signal=${signal}`);
    child = null;
    if (quitting || suppressExitRestart) return;
    if (restarts < 3) {
      restarts += 1;
      const delay = 1500 * restarts;
      appendLog(`将在 ${delay}ms 后重启（第 ${restarts} 次）`);
      setTimeout(() => {
        if (!quitting) startServer();
      }, delay);
    } else {
      fail(`DSH 服务器进程异常退出（code=${code}）`);
    }
  });
  waitForServer(urlFor(port), READY_TIMEOUT_MS).then((ok) => {
    if (quitting) return;
    if (!ok) return fail(`DSH 服务器启动超时（${READY_TIMEOUT_MS / 1000} 秒）`);
    restarts = 0;
    setServerState({ phase: "running" });
    appendLog(`服务器就绪（自管模式）：${urlFor(port)}`);
    loadMainWindow();
  });
}
async function restartServer() {
  restarts = 0;
  if (child) {
    suppressExitRestart = true;
    const pid = child.pid;
    child = null;
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {}
  }
  setServerState({ phase: "starting", mode: "spawn", error: null });
  setTimeout(() => startServer(), 600);
}

/* ── 窗口 ─────────────────────────────────────────────────── */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: "DSH Desktop",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "loading.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", (e) => {
    if (settings.closeToTray && !quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on("will-navigate", (e, target) => {
    if (!isAllowedUrl(target)) {
      e.preventDefault();
      if (/^https?:/.test(target)) shell.openExternal(target);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}
function loadMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const url = serverState.url;
  appendLog(`加载 GUI：${url}`);
  mainWindow.webContents.once("did-fail-load", (_e, code, desc) => {
    if (!quitting) fail(`加载 GUI 失败（${code} ${desc}）`);
  });
  mainWindow.loadURL(url).catch((err) => {
    if (!quitting) fail(`加载 GUI 失败：${err.message}`);
  });
}
function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 760,
    title: "DSH Desktop 设置",
    resizable: true,
    minimizable: false,
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}
function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}
function openInBrowser() {
  if (serverState.url) shell.openExternal(serverState.url);
}

/* ── 托盘 ─────────────────────────────────────────────────── */
function createTray() {
  const icon = path.join(__dirname, "assets", "icon.png");
  tray = new Tray(icon);
  tray.setToolTip("DSH Desktop");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 / 隐藏", click: toggleMainWindow },
      { label: "在浏览器中打开", click: openInBrowser },
      { type: "separator" },
      { label: "设置", click: createSettingsWindow },
      { label: "重启服务器", click: restartServer },
      { label: "检查更新", click: manualUpdateCheck },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", toggleMainWindow);
}

/* ── 自动更新 ─────────────────────────────────────────────── */
function setUpdateState(patch) {
  Object.assign(updateState, patch);
  pushStatus();
}
function initUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const feedOverride = process.env.DSH_UPDATE_FEED_URL;
  if (feedOverride) {
    appendLog(`使用 DSH_UPDATE_FEED_URL 覆盖更新源：${feedOverride}`);
    autoUpdater.setFeedURL({ provider: "generic", url: feedOverride });
  }

  autoUpdater.on("checking-for-update", () => setUpdateState({ state: "checking", error: null }));
  autoUpdater.on("update-available", (info) => {
    appendLog(`发现新版本：${info.version}`);
    setUpdateState({ state: "available", info });
  });
  autoUpdater.on("update-not-available", (info) => {
    appendLog(`已是最新版本：${info.version ?? app.getVersion()}`);
    setUpdateState({ state: "not-available", info });
  });
  autoUpdater.on("download-progress", (p) => setUpdateState({ state: "downloading", progress: p }));
  autoUpdater.on("update-downloaded", (info) => {
    appendLog(`新版本 ${info.version} 下载完成`);
    setUpdateState({ state: "downloaded", info });
    if (process.env.DSH_UPDATE_AUTO_INSTALL === "1") {
      appendLog("DSH_UPDATE_AUTO_INSTALL=1，立即重启安装");
      quitting = true;
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return;
    }
    const choice = dialog.showMessageBoxSync({
      type: "info",
      title: "更新已就绪",
      message: `新版本 ${info.version} 已下载完成`,
      detail: "重启应用即可完成安装。",
      buttons: ["立即重启安装", "稍后"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      quitting = true;
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
    }
  });
  autoUpdater.on("error", (err) => {
    appendLog(`updater error: ${err.message}`);
    setUpdateState({ state: "error", error: err.message });
  });

  const canAutoCheck = app.isPackaged || fs.existsSync(path.join(__dirname, "..", "dev-app-update.yml"));
  if (settings.autoUpdate && canAutoCheck) {
    // 未配置发布源（build.publish.owner 仍为占位符）时跳过自动检查，避免无意义报错
    let feedConfigured = !!process.env.DSH_UPDATE_FEED_URL;
    if (!feedConfigured && app.isPackaged) {
      try {
        const cfg = fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8");
        feedConfigured = !cfg.includes("YOUR_GITHUB_USERNAME");
      } catch {}
    }
    if (!feedConfigured) {
      appendLog("更新源未配置（build.publish.owner 仍为占位符），跳过自动更新检查");
    } else {
      setTimeout(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 10_000);
      setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), UPDATE_INTERVAL_MS);
    }
  }
}
function manualUpdateCheck() {
  autoUpdater
    .checkForUpdates()
    .then(() => {})
    .catch((err) => setUpdateState({ state: "error", error: String((err && err.message) || err) }));
}

/* ── 状态推送与 IPC ───────────────────────────────────────── */
function buildStatus() {
  return {
    server: { ...serverState },
    update: { ...updateState },
    appVersion: app.getVersion(),
    dshVersion: readDshVersion(),
    settings: { ...settings },
  };
}
function pushStatus() {
  const payload = buildStatus();
  for (const w of [mainWindow, settingsWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send("dshDesktop:status", payload);
  }
}
function registerIpc() {
  ipcMain.handle("dshDesktop:getStatus", () => buildStatus());
  ipcMain.handle("dshDesktop:saveSettings", (_e, patch = {}) => {
    const prev = { ...settings };
    settings = { ...settings, ...patch };
    saveSettings();
    pushStatus();
    if (patch.dshHome !== undefined || patch.port !== undefined) {
      if (prev.port !== settings.port || prev.dshHome !== settings.dshHome) restartServer();
    }
    return settings;
  });
  ipcMain.handle("dshDesktop:checkForUpdates", () => manualUpdateCheck());
  ipcMain.handle("dshDesktop:restartServer", () => restartServer());
  ipcMain.handle("dshDesktop:openLogFolder", () => shell.openPath(logsDir()));
  ipcMain.handle("dshDesktop:pickDirectory", async () => {
    const win = settingsWindow ?? mainWindow;
    const r = win ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] }) : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("dshDesktop:openSettings", () => createSettingsWindow());
  ipcMain.handle("dshDesktop:quitApp", () => {
    quitting = true;
    app.quit();
  });
}

/* ── 应用生命周期 ─────────────────────────────────────────── */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    settings = loadSettings();
    fs.mkdirSync(logsDir(), { recursive: true });
    appendLog(`=== DSH Desktop v${app.getVersion()} 启动（dsh ${readDshVersion()}）===`);
    getNodeVersion();
    createMainWindow();
    createTray();
    registerIpc();
    initUpdater();
    await startServer();
  });

  // 窗口全关时保持托盘驻留（由托盘/退出菜单真正退出）
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    quitting = true;
    if (child) {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } catch {}
    }
  });
}
