"use strict";

const { execFile } = require("node:child_process");
const { join } = require("node:path");

const DISK_QUERY = "(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.FileSystem -eq 'NTFS' } | Select-Object -ExpandProperty DeviceID) -join ','";

function discoverFixedNtfsDrives({ platform = process.platform, run = execFile,
  systemRoot = process.env.SystemRoot || "C:\\Windows" } = {}) {
  if (platform !== "win32") return Promise.resolve([]);
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    run(powershell, ["-NoProfile", "-NonInteractive", "-Command", DISK_QUERY],
      { windowsHide: true, timeout: 12000, maxBuffer: 16384 }, (error, stdout) => {
        if (error) return reject(new Error("无法检测本地 NTFS 磁盘。"));
        const letters = String(stdout || "").split(/[\s,;]+/)
          .filter((value) => /^[a-z]:$/i.test(value)).map((value) => value[0].toUpperCase());
        resolve([...new Set(letters)].sort());
      });
  });
}

module.exports = { discoverFixedNtfsDrives };
