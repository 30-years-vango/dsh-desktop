"use strict";
const api = window.dshDesktop;

const title = document.getElementById("title");
const subtitle = document.getElementById("subtitle");
const spinner = document.getElementById("spinner");
const errorBox = document.getElementById("errorBox");
const errorText = document.getElementById("errorText");

const PHASE_TEXT = {
  starting: "正在启动 DSH 服务器…",
  connecting: "检测到已有 DSH 实例，正在连接…",
  running: "正在加载界面…",
  error: "出错了",
};

function render(status) {
  const phase = status.server.phase;
  title.textContent = PHASE_TEXT[phase] ?? status.server.phase;
  // phase === 'running' 时主进程会主动跳转到 GUI，这里无需处理
  if (phase === "error") {
    spinner.classList.add("hidden");
    errorBox.classList.remove("hidden");
    errorText.textContent = status.server.error || "未知错误";
    subtitle.textContent = `dsh ${status.dshVersion} · 应用 v${status.appVersion}`;
  } else {
    errorBox.classList.add("hidden");
    if (status.server.url) subtitle.textContent = `${status.server.url} · dsh ${status.dshVersion}`;
  }
}

document.getElementById("retryBtn").addEventListener("click", () => {
  spinner.classList.remove("hidden");
  errorBox.classList.add("hidden");
  title.textContent = "正在重新启动…";
  api.restartServer();
});
document.getElementById("settingsBtn").addEventListener("click", () => api.openSettings());
document.getElementById("logsBtn").addEventListener("click", () => api.openLogFolder());

api.onStatus(render);
api.getStatus().then(render);
