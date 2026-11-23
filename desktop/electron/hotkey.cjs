"use strict";

const { readFileSync, writeFileSync, renameSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const defaultHotkey = "Ctrl+Shift+Space";

function normalizeHotkey(value) {
  if (typeof value !== "string" || value.length > 50) return null;
  const parts = value.trim().toUpperCase().split("+").map((part) => part.trim());
  const key = parts.pop();
  const modifiers = new Set(parts);
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|SPACE)$/.test(key)
    || modifiers.size !== parts.length || modifiers.size < 2
    || parts.some((part) => !["CTRL", "ALT", "SHIFT"].includes(part))) return null;
  const ordered = ["Ctrl", "Alt", "Shift"].filter((part) => modifiers.has(part.toUpperCase()));
  return [...ordered, key === "SPACE" ? "Space" : key].join("+");
}

function createHotkey(globalShortcut, userData, callback) {
  const file = join(userData, "hotkey.json");
  let current = defaultHotkey;
  try { current = normalizeHotkey(JSON.parse(readFileSync(file, "utf8"))) || defaultHotkey; } catch {}
  const register = (value) => {
    try { return Boolean(globalShortcut?.register(value, callback)); } catch { return false; }
  };
  let registered = register(current);

  return {
    status: () => ({ shortcut: current, registered }),
    update(value) {
      const next = normalizeHotkey(value);
      if (!next) return { ok: false, message: "请使用两个修饰键加字母、数字、空格或 F1–F12，例如 Ctrl+Shift+Space。" };
      if (next === current && registered) return { ok: true, shortcut: current };
      if (!register(next)) return { ok: false, message: "无法注册此热键，可能已被其他应用占用。" };
      try {
        writeFileSync(file + ".tmp", JSON.stringify(next));
        renameSync(file + ".tmp", file);
      } catch {
        globalShortcut.unregister(next);
        try { rmSync(file + ".tmp", { force: true }); } catch {}
        return { ok: false, message: "无法保存热键设置。" };
      }
      if (registered) globalShortcut.unregister(current);
      current = next;
      registered = true;
      return { ok: true, shortcut: current };
    },
    close() {
      if (registered) globalShortcut.unregister(current);
      registered = false;
    },
  };
}

module.exports = { createHotkey, normalizeHotkey };
