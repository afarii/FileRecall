"use strict";

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

function createDesktopUpdates({ updater, currentVersion, onChange, onAvailable }) {
  let state = { currentVersion, phase: updater ? "idle" : "unsupported" };
  const status = () => state;
  if (!updater) {
    return { status, check: status, download: status, install: status, close() {} };
  }

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableWebInstaller = true;
  let closed = false;
  let announcedVersion;
  let availableVersion;

  function publish(phase, details) {
    if (closed) return;
    state = { currentVersion, phase, version: availableVersion, ...details };
    onChange(state);
  }

  updater.on("error", () => {
    if (state.phase === "installing") {
      publish("ready", { message: "无法启动更新安装程序，请重试。" });
    }
  });
  updater.on("download-progress", ({ percent }) => {
    if (state.phase === "downloading" && Number.isFinite(percent)) {
      publish("downloading", { percent: Math.min(100, Math.max(0, Math.round(percent))) });
    }
  });

  async function check() {
    if (closed || ["checking", "downloading", "ready", "installing"].includes(state.phase)) return state;
    availableVersion = undefined;
    publish("checking");
    try {
      const result = await updater.checkForUpdates();
      if (!result) {
        publish("unsupported");
      } else if (result.isUpdateAvailable) {
        availableVersion = result.updateInfo.version;
        publish("available");
      } else {
        publish("current");
      }
    } catch (error) {
      if (error.code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND") {
        publish("idle", { message: "预览通道暂未提供更新。" });
      } else {
        publish("idle", { message: "检查更新失败，请检查网络后重试。" });
      }
    }
    if (!closed && state.phase === "available" && availableVersion !== announcedVersion) {
      announcedVersion = availableVersion;
      onAvailable(availableVersion);
    }
    return state;
  }

  async function download() {
    if (closed || state.phase !== "available") return state;
    publish("downloading", { percent: 0 });
    try {
      const files = await updater.downloadUpdate();
      if (!files.length) throw new Error("Update download did not return a file");
      publish("ready");
    } catch {
      publish("available", { message: "下载或校验更新失败，请重试。" });
    }
    return state;
  }

  function install() {
    if (closed || state.phase !== "ready") return state;
    publish("installing");
    try {
      updater.quitAndInstall();
    } catch {
      publish("ready", { message: "无法启动更新安装程序，请重试。" });
    }
    return state;
  }

  const firstCheck = setTimeout(() => void check(), 15_000);
  const periodicCheck = setInterval(() => void check(), CHECK_INTERVAL);
  firstCheck.unref();
  periodicCheck.unref();
  return {
    status, check, download, install,
    close() {
      closed = true;
      clearTimeout(firstCheck);
      clearInterval(periodicCheck);
    },
  };
}

module.exports = { createDesktopUpdates };
