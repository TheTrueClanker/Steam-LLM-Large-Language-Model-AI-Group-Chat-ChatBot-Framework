"use strict";

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// The GPU process crashes on some Wayland + NVIDIA setups (eglCreateImage fails), leaving a white window.
// A form UI doesn't need GPU rasterization, so use software rendering on Linux.
if (process.platform === "linux") app.commandLine.appendSwitch("disable-gpu");

const BOT_SRC = app.isPackaged ? path.join(process.resourcesPath, "bot") : path.join(__dirname, "..");
const DATA_DIR = path.join(app.getPath("userData"), "bot");
const CONFIG_FILE = path.join(DATA_DIR, "config.txt");
const PROMPT_FILE = path.join(DATA_DIR, "system prompt.txt");

let win = null;
let bot = null;

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of ["config.txt", "system prompt.txt"]) {
    const dest = path.join(DATA_DIR, f);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(BOT_SRC, f), dest);
  }
}

const isSkippable = (t) => !t || /^[#;]/.test(t) || /^\[[^\]]+\]$/.test(t);

// Returns [{ section, items: [{ key, value, help }] }] straight from config.txt,
// so new keys added to the framework's config show up in the GUI with no changes here.
function readConfig() {
  const sections = [];
  let current = null;
  let help = [];
  for (const raw of fs.readFileSync(CONFIG_FILE, "utf8").split(/\r?\n/)) {
    const t = raw.trim();
    const header = t.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = { section: header[1], items: [] };
      sections.push(current);
      help = [];
    } else if (t.startsWith("#")) {
      help.push(t.replace(/^#\s?/, ""));
    } else if (!isSkippable(t) && current && t.includes("=")) {
      const i = t.indexOf("=");
      current.items.push({ key: t.slice(0, i).trim(), value: t.slice(i + 1).trim(), help: help.join(" ") });
      help = [];
    } else if (!t) {
      help = [];
    }
  }
  return sections;
}

// Rewrites only `key = value` lines, leaving every comment and blank line untouched.
function writeConfig(values) {
  const out = fs.readFileSync(CONFIG_FILE, "utf8").split(/\r?\n/).map((line) => {
    const t = line.trim();
    const i = line.indexOf("=");
    if (isSkippable(t) || i < 0) return line;
    const key = line.slice(0, i).trim();
    return Object.prototype.hasOwnProperty.call(values, key)
      ? `${key} = ${String(values[key]).replace(/[\r\n]+/g, " ").trim()}`
      : line;
  });
  fs.writeFileSync(CONFIG_FILE, out.join("\n"));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle("config:get", () => readConfig());
ipcMain.handle("config:set", (_e, values) => writeConfig(values));
ipcMain.handle("prompt:get", () => fs.readFileSync(PROMPT_FILE, "utf8"));
ipcMain.handle("prompt:set", (_e, text) => fs.writeFileSync(PROMPT_FILE, String(text)));
ipcMain.handle("data:open", () => shell.openPath(DATA_DIR));
ipcMain.handle("link:open", (_e, url) => {
  if (/^https:\/\/(ollama\.com|nodejs\.org)\//.test(url)) shell.openExternal(url);
});

ipcMain.handle("bot:start", () => {
  if (bot) return false;
  bot = spawn(process.execPath, [path.join(BOT_SRC, "bot.js")], {
    cwd: DATA_DIR,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      STEAM_BOT_DATA_DIR: DATA_DIR,
      NODE_PATH: path.join(__dirname, "node_modules"),
    },
  });
  bot.stdin.on("error", () => {}); // EPIPE if the bot exits between our write and its close
  let closePressed = false;
  const onData = (buf) => {
    const text = buf.toString();
    send("bot:log", text);
    // bot.js waits for Enter before closing after a failed Steam login; there is no TTY here.
    if (!closePressed && /Press (any key|Enter) to close/i.test(text)) {
      closePressed = true;
      setTimeout(() => bot && bot.stdin.write("\n"), 300);
    }
  };
  bot.stdout.on("data", onData);
  bot.stderr.on("data", onData);
  bot.on("error", (err) => { send("bot:log", `[GUI] Could not start bot: ${err.message}\n`); bot = null; send("bot:exit", -1); });
  bot.on("exit", (code) => { bot = null; send("bot:exit", code); });
  return true;
});
ipcMain.handle("bot:stop", () => { if (bot) bot.kill(); });
ipcMain.handle("bot:input", (_e, line) => { if (bot) bot.stdin.write(String(line) + "\n"); });
ipcMain.handle("bot:running", () => !!bot);

ipcMain.handle("ollama:tags", async (_e, url) => {
  try {
    const res = await fetch(new URL("/api/tags", url), { signal: AbortSignal.timeout(3000) });
    const json = await res.json();
    return { ok: true, models: (json.models || []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("ollama:pull", async (_e, url, model) => {
  try {
    const res = await fetch(new URL("/api/pull", url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of res.body) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        send("ollama:progress", { model, status: msg.status, completed: msg.completed, total: msg.total });
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(() => {
  ensureData();
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: "Steam LLM Chatbot",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
});

app.on("before-quit", () => { if (bot) bot.kill(); });
app.on("window-all-closed", () => app.quit());
