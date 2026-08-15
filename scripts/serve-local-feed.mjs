/**
 * serve-local-feed.mjs
 * 本地自动更新源：把 electron-builder 的 build/ 产物目录通过 HTTP 服务出来，
 * 配合 dev-app-update.yml 或 DSH_UPDATE_FEED_URL 做更新链路测试。
 *
 * 用法：
 *   node scripts/serve-local-feed.mjs [目录] [端口]
 *   默认目录：./build ，默认端口：8080
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "build");
const port = Number(process.argv[3] ?? process.env.PORT ?? 8080);

const MIME = {
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".exe": "application/octet-stream",
  ".blockmap": "application/octet-stream",
  ".html": "text/html; charset=utf-8",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const rel = urlPath.replace(/^\/+/, "");
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep) && target !== root) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream" });
  createReadStream(target).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[serve-local-feed] 更新源已启动：http://127.0.0.1:${port}  （目录：${root}）`);
});
