/**
 * prepare-runtime.mjs
 * 准备桌面版运行时资源：
 *   1. 从 nodejs.org 下载 Node v24.x win-x64 便携版，解压到 resources/node/
 *   2. 在 resources/dsh/ 安装 @deepseek-ai/dsh 及其全部依赖
 *   3. 精简多平台预编译（node-pty 只留 win32-x64）
 *   4. 自检：node.exe + dsh --version
 *
 * 用法：node scripts/prepare-runtime.mjs
 * 注意：本机 PowerShell 执行策略禁用 npm.ps1，这里一律调用 npm.cmd。
 */
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(root, ".cache", "runtime");
const npmCache = path.join(root, ".cache", "npm-dsh");
const nodeDir = path.join(root, "resources", "node");
const dshDir = path.join(root, "resources", "dsh");

const NODE_MAJOR = 24; // 与系统已验证的 Node 大版本一致

function log(msg) {
  console.log(`[prepare-runtime] ${msg}`);
}

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    httpsGet(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpsGetText(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

function httpsGetFile(url, dest) {
  return new Promise((resolve, reject) => {
    httpsGet(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpsGetFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
    }).on("error", reject);
  });
}

async function resolveLatestNodeVersion() {
  log(`查询 Node v${NODE_MAJOR}.x 最新版…`);
  const index = await httpsGetText(`https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/`);
  const m = index.match(/node-v(\d+\.\d+\.\d+)-win-x64\.zip/);
  if (!m) throw new Error("无法从 nodejs.org 解析 Node win-x64 版本号");
  return m[1];
}

/** 递归查找文件 */
function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

async function ensureNodeRuntime(version) {
  const zipName = `node-v${version}-win-x64.zip`;
  const zipPath = path.join(cacheDir, zipName);
  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(zipPath)) {
    const url = `https://nodejs.org/dist/v${version}/${zipName}`;
    log(`下载 ${url} …`);
    await httpsGetFile(url, zipPath);
    log("下载完成");
  } else {
    log(`使用缓存的 ${zipName}`);
  }

  if (existsSync(path.join(nodeDir, "node.exe"))) {
    log(`resources/node 已存在（node.exe），跳过解压`);
    return;
  }
  const tmp = path.join(cacheDir, "node-extract");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  log("解压 Node …");
  // 用 PowerShell Expand-Archive 解压（本地与 CI 行为一致，不依赖 tar 的实现差异）
  const ps = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmp}' -Force`],
    { stdio: "inherit" }
  );
  if (ps.status !== 0) throw new Error("Expand-Archive 解压失败");
  const nodeExePath = findFile(tmp, "node.exe");
  if (!nodeExePath) throw new Error("解压结果中找不到 node.exe");
  rmSync(nodeDir, { recursive: true, force: true });
  const { renameSync } = await import("node:fs");
  renameSync(path.dirname(nodeExePath), nodeDir);
  rmSync(tmp, { recursive: true, force: true });
  log(`Node 就绪：${path.join(nodeDir, "node.exe")}`);
}

function installDshBundle() {
  mkdirSync(dshDir, { recursive: true });
  const manifest = path.join(dshDir, "package.json");
  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify({ name: "dsh-bundle", private: true, version: "0.0.0" }, null, 2));
  }
  log("安装 @deepseek-ai/dsh@latest 到 resources/dsh …（可能需要几分钟）");
  const r = spawnSync("npm.cmd", ["install", "@deepseek-ai/dsh@latest", "--no-audit", "--no-fund", "--cache", npmCache], {
    cwd: dshDir,
    stdio: "inherit",
    env: { ...process.env, npm_config_cache: npmCache },
  });
  if (r.status !== 0) throw new Error("npm install 失败");
}

function pruneForeignPrebuilds() {
  const ptyPre = path.join(dshDir, "node_modules", "node-pty", "prebuilds");
  if (!existsSync(ptyPre)) return;
  for (const d of readdirSync(ptyPre)) {
    if (d !== "win32-x64") {
      rmSync(path.join(ptyPre, d), { recursive: true, force: true });
      log(`精简 node-pty prebuilds：移除 ${d}`);
    }
  }
}

function verify() {
  const nodeExe = path.join(nodeDir, "node.exe");
  if (!existsSync(nodeExe)) throw new Error(`缺少 ${nodeExe}`);
  const binJs = path.join(dshDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!existsSync(binJs)) throw new Error(`缺少 ${binJs}`);
  const nv = spawnSync(nodeExe, ["--version"], { encoding: "utf8" });
  const dv = spawnSync(nodeExe, [binJs, "--version"], { encoding: "utf8" });
  log(`自检通过：node ${nv.stdout.trim()} / dsh ${dv.stdout.trim()}`);
}

async function main() {
  const version = await resolveLatestNodeVersion();
  await ensureNodeRuntime(version);
  installDshBundle();
  pruneForeignPrebuilds();
  verify();
  log("完成。现在可以执行 npm run dev 或 npm run dist。");
}

main().catch((err) => {
  console.error("[prepare-runtime] 失败:", err.message);
  process.exit(1);
});
