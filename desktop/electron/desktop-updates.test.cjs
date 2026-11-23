"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createDesktopUpdates } = require("./desktop-updates.cjs");

test("updates require explicit download and install, and a failed download can be retried", async (t) => {
  const updater = new EventEmitter();
  const changes = [];
  const announcements = [];
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.4.2" } });
  let downloads = 0;
  updater.downloadUpdate = async () => {
    downloads++;
    if (downloads === 1) throw new Error("Network unavailable");
    updater.emit("download-progress", { percent: 81.7 });
    return ["FileRecall-Setup-0.4.2-x64.exe"];
  };
  let installations = 0;
  updater.quitAndInstall = () => {
    if (++installations === 1) updater.emit("error", new Error("Installer could not start"));
  };
  const updates = createDesktopUpdates({
    updater, currentVersion: "0.4.1",
    onChange: (state) => changes.push(state),
    onAvailable: (version) => announcements.push(version),
  });
  t.after(updates.close);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal((await updates.check()).phase, "available");
  await updates.check();
  assert.deepEqual(announcements, ["0.4.2"]);
  assert.equal(downloads, 0);
  updates.install();
  assert.equal(installations, 0);

  assert.equal((await updates.download()).phase, "available");
  assert.equal((await updates.download()).phase, "ready");
  assert.ok(changes.some((state) => state.phase === "downloading" && state.percent === 82));
  assert.equal(updates.install().phase, "ready");
  assert.equal(updates.install().phase, "installing");
  updates.install();
  assert.equal(installations, 2);
});

test("a missing preview feed leaves checking enabled", async (t) => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {
    throw Object.assign(new Error("Missing feed"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" });
  };
  const updates = createDesktopUpdates({
    updater, currentVersion: "0.4.1", onChange() {}, onAvailable() {},
  });
  t.after(updates.close);
  assert.match((await updates.check()).message, /暂未提供更新/);
  updater.checkForUpdates = async () => ({ isUpdateAvailable: false });
  assert.equal((await updates.check()).phase, "current");
});
