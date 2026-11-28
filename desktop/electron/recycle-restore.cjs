"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { win32 } = require("node:path");
const { lstat } = require("node:fs/promises");
const { setTimeout: delay } = require("node:timers/promises");
const { isRecyclePath } = require("./recycle-path.cjs");

const run = promisify(execFile);
const payloadPath = path => typeof path === "string" &&
  /^[a-z]:\\\$Recycle\.Bin\\S-\d+(?:-\d+)+\\\$R[^\\]+$/i.test(win32.normalize(path));

// Canonical "undelete" verb, independent of Windows display language.
// Match the exact recycled payload path, never the displayed filename.
// Use encoded data rather than interpolating user-controlled PowerShell code.
async function invokeRestore(path) {
  if (process.platform !== "win32" || !payloadPath(path)) throw new Error("回收站文件位置无效。");
  const encoded = Buffer.from(path, "utf16le").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$wanted=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + encoded + "'))",
    "$shell=New-Object -ComObject Shell.Application",
    "$bin=$shell.NameSpace(10)",
    "if ($null -eq $bin) { exit 2 }",
    "$matches=@($bin.Items() | Where-Object { [string]::Equals([string]$_.Path,$wanted,[StringComparison]::OrdinalIgnoreCase) })",
    "if ($matches.Count -ne 1) { exit 3 }",
    "$matches[0].InvokeVerb('undelete')",
  ].join("\r\n");
  const exe = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await run(exe, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 15000, maxBuffer: 32768 });
}

function samePath(a,b) {
  return typeof a === "string" && typeof b === "string" &&
    win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
}

// Revalidate identity and both locations before invoking the shell. Never move
// raw $R files or delete $I metadata ourselves. Windows handles actual restore.
async function restoreRememberedFile(row, { lookup, verify, stat = lstat, invoke = invokeRestore, wait = delay, attempts = 20 }) {
  if (!row || row.deleted || !row.path || isRecyclePath(row.path) ||
      !/^[a-z]:\\/i.test(row.path)) return { ok:false, message:"原文件位置无法确认，请在回收站中手动还原。" };
  const original = row.path;
  try {
    const current = await verify(await lookup(row.volume,row.frn));
    if (!current || current.identity !== row.identity || !payloadPath(current.path) ||
        win32.parse(current.path).root.toLowerCase() !== win32.parse(original).root.toLowerCase())
      return { ok:false, message:"回收站文件身份已改变，请重新搜索。" };
    // Existing objects (including broken links) must not be overwritten.
    try {
      await stat(original);
      return { ok:false, message:"原位置已有同名文件，请先处理该文件或在回收站手动还原。" };
    } catch (err) { if (err?.code !== "ENOENT") throw err; }
    const latest = await verify(await lookup(row.volume,row.frn));
    if (!latest || latest.identity !== row.identity || !samePath(latest.path,current.path))
      return { ok:false, message:"回收站文件身份已改变，请重新搜索。" };
    await invoke(latest.path);
    // InvokeVerb can return before Explorer finishes. Confirm the same identity
    // at the original location instead of reporting success on dispatch alone.
    for (let i=0; i<attempts; i++) {
      const restored = await verify({...latest,path:original});
      if (restored?.identity === row.identity) return {ok:true};
      await wait(250);
    }
    return {ok:false,message:"已请求 Windows 还原，但尚未确认结果。请检查系统提示或回收站。"};
  } catch {
    return {ok:false,message:"无法自动还原，请在 Windows 回收站中手动还原。"};
  }
}

module.exports = { restoreRememberedFile, payloadPath };
