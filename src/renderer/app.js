"use strict";
const api = window.dshDesktop;

const $ = (id) => document.getElementById(id);

const PHASE_LABEL = {
  starting: "启动中",
  connecting: "连接已有实例中",
  running: "运行中",
  error: "错误",
};
const MODE_LABEL = { spawn: "自管服务器", connect: "复用已有实例" };

function render(status) {
  $("verLine").textContent = `应用 v${status.appVersion} · dsh ${status.dshVersion}`;

  const srv = status.server;
  $("srvState").textContent = PHASE_LABEL[srv.phase] ?? srv.phase;
  $("srvState").style.color = srv.phase === "running" ? "#4ade80" : srv.phase === "error" ? "#f87171" : "#facc15";
  $("srvMode").textContent = srv.mode ? MODE_LABEL[srv.mode] ?? srv.mode : "—";
  $("srvUrl").textContent = srv.url || "—";

  if (!$("inPort").dataset.dirty) $("inPort").value = status.settings.port;
  if (!$("inWorkdir").dataset.dirty) $("inWorkdir").value = status.settings.defaultWorkingDirectory;
  if (!$("inDshHome").dataset.dirty) $("inDshHome").value = status.settings.dshHome;
  $("inCloseToTray").checked = !!status.settings.closeToTray;
  $("inAutoUpdate").checked = status.settings.autoUpdate !== false;

  const upd = status.update;
  const text = $("updateText");
  switch (upd.state) {
    case "checking": text.textContent = "正在检查…"; break;
    case "available": text.textContent = `发现新版本 ${upd.info?.version}，正在下载…`; break;
    case "not-available": text.textContent = "已是最新版本"; break;
    case "downloading": text.textContent = `下载中 ${Math.round(upd.progress?.percent ?? 0)}%`; break;
    case "downloaded": text.textContent = `新版本 ${upd.info?.version} 已就绪`; break;
    case "error": text.textContent = `更新失败：${upd.error}`; break;
    default: text.textContent = "—";
  }
  const prog = $("updateProgress");
  if (upd.state === "downloading" && upd.progress) {
    prog.classList.remove("hidden");
    $("updateBar").style.width = `${Math.round(upd.progress.percent)}%`;
  } else {
    prog.classList.add("hidden");
  }
}

/* 表单 */
for (const id of ["inPort", "inWorkdir", "inDshHome"]) {
  $(id).addEventListener("input", () => ($(id).dataset.dirty = "1"));
}
$("settingsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  api.saveSettings({
    port: Number($("inPort").value) || 3080,
    defaultWorkingDirectory: $("inWorkdir").value.trim() || undefined,
    dshHome: $("inDshHome").value.trim() || undefined,
    closeToTray: $("inCloseToTray").checked,
    autoUpdate: $("inAutoUpdate").checked,
  }).then(() => {
    for (const id of ["inPort", "inWorkdir", "inDshHome"]) delete $(id).dataset.dirty;
  });
});
$("btnWorkdir").addEventListener("click", async () => {
  const p = await api.pickDirectory();
  if (p) { $("inWorkdir").value = p; $("inWorkdir").dataset.dirty = "1"; }
});
$("btnDshHome").addEventListener("click", async () => {
  const p = await api.pickDirectory();
  if (p) { $("inDshHome").value = p; $("inDshHome").dataset.dirty = "1"; }
});

/* 操作按钮 */
$("btnRestart").addEventListener("click", () => api.restartServer());
$("btnUpdate").addEventListener("click", () => { $("updateText").textContent = "正在检查…"; api.checkForUpdates(); });
$("btnLogs").addEventListener("click", () => api.openLogFolder());
$("btnQuit").addEventListener("click", () => api.quitApp());

api.onStatus(render);
api.getStatus().then(render);
