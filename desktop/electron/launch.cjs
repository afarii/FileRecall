"use strict";

const { spawn } = require("node:child_process");

// Some development hosts use this variable for their own Electron process.
// The desktop application must start in Electron's normal application mode.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(require("electron"), ["."], { env, stdio: "inherit" });
child.on("error", (error) => {
  console.error("无法启动 FileRecall：", error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
