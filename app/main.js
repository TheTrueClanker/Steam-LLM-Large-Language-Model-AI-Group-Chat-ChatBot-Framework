"use strict";

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, Notification } = require("electron");
const os = require("os");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// The GPU process crashes on some Wayland + NVIDIA setups (eglCreateImage fails), leaving a white window.
// A form UI doesn't need GPU rasterization, so use software rendering on Linux.
if (process.platform === "linux") app.commandLine.appendSwitch("disable-gpu");

const BOT_SRC = app.isPackaged ? path.join(process.resourcesPath, "bot") : path.join(__dirname, "..");
const lib = (name) => require(path.join(BOT_SRC, "lib", name));

const USER_DIR = app.getPath("userData");
const LEGACY_DIR = path.join(USER_DIR, "bot"); // the single bot older versions used; it stays as the "default" bot
const BOTS_DIR = path.join(USER_DIR, "bots");
const REGISTRY_FILE = path.join(USER_DIR, "bots.json");
const UI_FILE = path.join(USER_DIR, "ui.json");

let win = null;
let tray = null;
let quitting = false;
let trayNoticeShown = false;
const procs = new Map(); // bot id -> running bot.js
const chats = new Map(); // bot id -> test-chat process (bot.js --playground)

/* ---------- bot profiles ---------- */
function loadRegistry() {
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    if (Array.isArray(reg.bots) && reg.bots.length) return reg;
  } catch {}
  const reg = { bots: [{ id: "default", label: "My bot" }] };
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
  return reg;
}
function saveRegistry(reg) { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2)); }

function botDir(id) {
  if (!/^[a-z0-9-]{1,40}$/.test(String(id)) || !loadRegistry().bots.some((b) => b.id === id)) throw new Error("Unknown bot: " + id);
  return id === "default" ? LEGACY_DIR : path.join(BOTS_DIR, id);
}

function ensureData(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["config.txt", "system prompt.txt"]) {
    const dest = path.join(dir, f);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(BOT_SRC, f), dest);
  }
}

/* ---------- config.txt ---------- */
const isSkippable = (t) => !t || /^[#;]/.test(t) || /^\[[^\]]+\]$/.test(t);

// Returns [{ section, items: [{ key, value, help }] }] straight from config.txt,
// so new keys added to the framework's config show up in the GUI with no changes here.
function readConfig(dir) {
  const sections = [];
  let current = null;
  let help = [];
  for (const raw of fs.readFileSync(path.join(dir, "config.txt"), "utf8").split(/\r?\n/)) {
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

const flatConfig = (dir) => Object.fromEntries(readConfig(dir).flatMap((s) => s.items.map((i) => [i.key, i.value])));

// Rewrites only `key = value` lines, leaving every comment and blank line untouched.
function writeConfig(dir, values) {
  const file = path.join(dir, "config.txt");
  const out = fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => {
    const t = line.trim();
    const i = line.indexOf("=");
    if (isSkippable(t) || i < 0) return line;
    const key = line.slice(0, i).trim();
    return Object.prototype.hasOwnProperty.call(values, key)
      ? `${key} = ${String(values[key]).replace(/[\r\n]+/g, " ").trim()}`
      : line;
  });
  fs.writeFileSync(file, out.join("\n"), { mode: 0o600 });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// The bot process itself stays small (well under 200 MB); cap its heap so a bug can never let it eat the computer.
const BOT_NODE_FLAGS = ["--max-old-space-size=512"];

function botEnv(dir) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    STEAM_BOT_GUI: "1",
    STEAM_BOT_DATA_DIR: dir,
    NODE_PATH: path.join(__dirname, "node_modules"),
  };
}

/* ---------- registry / profiles IPC ---------- */
ipcMain.handle("bots:list", () => loadRegistry().bots.map((b) => ({ ...b, running: procs.has(b.id) })));

ipcMain.handle("bots:create", (_e, label, cloneFrom) => {
  const reg = loadRegistry();
  const name = String(label || "").trim().slice(0, 40) || "New bot";
  const id = (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "bot") + "-" + Math.random().toString(36).slice(2, 6);
  reg.bots.push({ id, label: name });
  saveRegistry(reg);
  const dir = botDir(id);
  ensureData(dir);
  if (cloneFrom) {
    // Copy settings and persona from another bot, but never its Steam login or memory.
    const src = botDir(cloneFrom);
    fs.copyFileSync(path.join(src, "config.txt"), path.join(dir, "config.txt"));
    fs.copyFileSync(path.join(src, "system prompt.txt"), path.join(dir, "system prompt.txt"));
    writeConfig(dir, { "Steam account name": "", "Steam password": "", "Steam Guard code": "" });
  }
  writeConfig(dir, { "Bot name": name });
  return id;
});

ipcMain.handle("bots:rename", (_e, id, label) => {
  const reg = loadRegistry();
  const bot = reg.bots.find((b) => b.id === id);
  if (bot) { bot.label = String(label || "").trim().slice(0, 40) || bot.label; saveRegistry(reg); }
});

ipcMain.handle("bots:delete", (_e, id) => {
  const reg = loadRegistry();
  if (reg.bots.length <= 1 || !reg.bots.some((b) => b.id === id)) return false;
  const dir = botDir(id);
  stopBot(id);
  stopChat(id);
  reg.bots = reg.bots.filter((b) => b.id !== id);
  saveRegistry(reg);
  if (id !== "default") fs.rmSync(dir, { recursive: true, force: true });
  return true;
});

/* ---------- per-bot files ---------- */
ipcMain.handle("config:get", (_e, id) => { const dir = botDir(id); ensureData(dir); return readConfig(dir); });
ipcMain.handle("config:set", (_e, id, values) => { writeConfig(botDir(id), values); stopChat(id); });
ipcMain.handle("prompt:get", (_e, id) => { const dir = botDir(id); ensureData(dir); return fs.readFileSync(path.join(dir, "system prompt.txt"), "utf8"); });
ipcMain.handle("prompt:set", (_e, id, text) => { fs.writeFileSync(path.join(botDir(id), "system prompt.txt"), String(text)); stopChat(id); });
ipcMain.handle("data:open", (_e, id) => shell.openPath(botDir(id)));
ipcMain.handle("link:open", (_e, url) => {
  const repo = updateRepo() || lib("update").DEFAULT_REPO;
  if (/^https:\/\/(ollama\.com|nodejs\.org)\//.test(url) || url.startsWith(`https://github.com/${repo}/releases`)) shell.openExternal(url);
});

/* ---------- UI preferences (theme, background behaviour) ---------- */
const readUi = () => { try { return JSON.parse(fs.readFileSync(UI_FILE, "utf8")); } catch { return {}; } };
// Nothing runs in the background unless the user turned it on: the tray and login options default to off.
const keepInTray = () => readUi().closeToTray === true;
ipcMain.handle("ui:get", () => ({ ...readUi(), closeToTray: keepInTray(), launchAtLogin: loginEntryExists() }));
ipcMain.handle("ui:set", (_e, patch) => {
  fs.writeFileSync(UI_FILE, JSON.stringify({ ...readUi(), ...patch }));
  if ("launchAtLogin" in patch) setLaunchAtLogin(!!patch.launchAtLogin);
});

// Windows/macOS use Electron's login items; Linux uses an XDG autostart entry.
const LOGIN_FILE = path.join(os.homedir(), ".config", "autostart", "steam-llm-chatbot.desktop");
function loginEntryExists() {
  if (process.platform === "linux") {
    // Desktop settings may switch an entry off without deleting it; treat that as off.
    try { return !/^(Hidden\s*=\s*true|X-GNOME-Autostart-enabled\s*=\s*false)\s*$/im.test(fs.readFileSync(LOGIN_FILE, "utf8")); } catch { return false; }
  }
  return app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin;
}
function setLaunchAtLogin(on) {
  if (process.platform === "linux") {
    const file = LOGIN_FILE;
    if (!on) return fs.rmSync(file, { force: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const exe = process.env.APPIMAGE || process.execPath;
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Steam LLM Chatbot\nExec="${exe}" --hidden${app.isPackaged ? "" : " " + app.getAppPath()}\nX-GNOME-Autostart-enabled=true\n`);
  } else {
    app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
  }
}

ipcMain.handle("bots:autostart", (_e, id, on) => {
  const reg = loadRegistry();
  const bot = reg.bots.find((b) => b.id === id);
  if (bot) { bot.autostart = !!on; saveRegistry(reg); }
});

/* ---------- updates: check the project's releases; install only after the user clicks ---------- */
const updateRepo = () => String(flatConfig(botDir("default"))["Update source"] || "").trim() || undefined;

ipcMain.handle("update:check", async () => {
  try {
    const info = await lib("update").checkForUpdate(app.getVersion(), { repo: updateRepo() });
    return { ok: true, current: app.getVersion(), canInstall: app.isPackaged && !!info.asset, ...info, asset: info.asset ? { name: info.asset.name, size: info.asset.size } : null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("update:install", async () => {
  try {
    // Look the release up again here: the renderer is never trusted to say what to download.
    const info = await lib("update").checkForUpdate(app.getVersion(), { repo: updateRepo() });
    if (!app.isPackaged) return { ok: false, error: "Updating only works in the installed app." };
    if (!info.available || !info.asset) return { ok: false, error: "No installer for this system in the latest release." };
    const a = info.asset;
    if (!a.url.startsWith(`https://github.com/${info.repo}/releases/download/`)) return { ok: false, error: "Unexpected download address." };

    const res = await fetch(a.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!res.ok) throw new Error("Download failed (HTTP " + res.status + ")");
    const total = Number(res.headers.get("content-length")) || a.size;
    const crypto = require("crypto");
    const hash = crypto.createHash("sha256");
    const tmp = path.join(app.getPath("temp"), "steam-llm-update-" + a.name);
    const out = fs.createWriteStream(tmp);
    let got = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      send("update:progress", { got, total });
    }
    await new Promise((r) => out.end(r));
    if (a.size && got !== a.size) throw new Error("The download was incomplete.");
    if (a.sha256 && hash.digest("hex") !== a.sha256) { fs.rmSync(tmp, { force: true }); throw new Error("The download did not match its checksum, so it was discarded."); }

    quitting = true;
    if (process.platform === "win32") {
      shell.openPath(tmp); // runs the installer, which replaces this app
      setTimeout(() => app.quit(), 1500);
      return { ok: true, action: "installer" };
    }
    if (process.env.APPIMAGE) {
      // Put the new AppImage next to the old one (kept for rollback) and start it once this app has quit.
      const dest = path.join(path.dirname(process.env.APPIMAGE), a.name);
      fs.copyFileSync(tmp, dest + ".part");
      fs.chmodSync(dest + ".part", 0o755);
      fs.renameSync(dest + ".part", dest);
      fs.rmSync(tmp, { force: true });
      spawn("sh", ["-c", 'sleep 2; exec "$0"', dest], { detached: true, stdio: "ignore" }).unref();
      setTimeout(() => app.quit(), 500);
      return { ok: true, action: "restart", path: dest };
    }
    const dest = path.join(app.getPath("downloads"), a.name);
    fs.copyFileSync(tmp, dest);
    shell.showItemInFolder(dest);
    quitting = false;
    return { ok: true, action: "saved", path: dest };
  } catch (err) {
    quitting = false;
    return { ok: false, error: err.message };
  }
});

/* ---------- running bots ---------- */
function stopBot(id) { const p = procs.get(id); if (p) p.kill(); }

function startBot(id) {
  if (procs.has(id)) return { ok: false, error: "Already running." };
  const dir = botDir(id);
  ensureData(dir);

  // Two processes logging into the same Steam account kick each other off.
  const account = (flatConfig(dir)["Steam account name"] || "").toLowerCase();
  if (account) {
    for (const other of procs.keys()) {
      if ((flatConfig(botDir(other))["Steam account name"] || "").toLowerCase() === account) {
        return { ok: false, error: `Another running bot already uses the Steam account "${account}". Stop it first, or give this bot its own account.` };
      }
    }
  }

  const bot = spawn(process.execPath, [...BOT_NODE_FLAGS, path.join(BOT_SRC, "bot.js")], { cwd: dir, env: botEnv(dir) });
  procs.set(id, bot);
  bot.stdin.on("error", () => {}); // EPIPE if the bot exits between our write and its close
  let closePressed = false;
  const onData = (buf) => {
    const text = buf.toString();
    send("bot:log", { id, text });
    // bot.js waits for Enter before closing after a failed Steam login; there is no TTY here.
    if (!closePressed && /Press (any key|Enter) to close/i.test(text)) {
      closePressed = true;
      setTimeout(() => procs.get(id) === bot && bot.stdin.write("\n"), 300);
    }
  };
  bot.stdout.on("data", onData);
  bot.stderr.on("data", onData);
  bot.on("error", (err) => { send("bot:log", { id, text: `[GUI] Could not start bot: ${err.message}\n` }); procs.delete(id); send("bot:exit", { id, code: -1 }); });
  bot.on("exit", (code) => { if (procs.get(id) === bot) procs.delete(id); send("bot:exit", { id, code }); });
  return { ok: true };
}
ipcMain.handle("bot:start", (_e, id) => startBot(id));
ipcMain.handle("bot:stop", (_e, id) => stopBot(id));
ipcMain.handle("bot:input", (_e, id, line) => { const p = procs.get(id); if (p) p.stdin.write(String(line) + "\n"); });

/* ---------- test chat (bot.js --playground: the real reply pipeline, no Steam) ---------- */
function stopChat(id) {
  const c = chats.get(id);
  if (c) { chats.delete(id); clearTimeout(c.idle); c.proc.kill(); }
}

// A test-chat process holds its model in memory, so it is stopped after 10 idle minutes (restarts on the next message).
function touchChat(id) {
  const c = chats.get(id);
  if (!c) return;
  clearTimeout(c.idle);
  c.idle = setTimeout(() => stopChat(id), 10 * 60 * 1000);
}

function startChat(id) {
  if (chats.has(id)) return chats.get(id);
  const dir = botDir(id);
  ensureData(dir);
  const proc = spawn(process.execPath, [...BOT_NODE_FLAGS, path.join(BOT_SRC, "bot.js"), "--playground"], { cwd: dir, env: botEnv(dir) });
  const chat = { proc };
  chats.set(id, chat);
  proc.stdin.on("error", () => {});
  let buffered = "";
  const onData = (buf) => {
    buffered += buf.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      if (line.startsWith("@@CHAT ")) {
        try { send("chat:msg", { botId: id, ...JSON.parse(line.slice(7)) }); } catch {}
      } else if (line.trim()) {
        send("chat:log", { botId: id, text: line + "\n" });
      }
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("error", (err) => send("chat:msg", { botId: id, error: "Could not start the test chat: " + err.message }));
  proc.on("exit", () => {
    if (chats.get(id) !== chat) return; // stopped on purpose
    chats.delete(id);
    send("chat:msg", { botId: id, error: "The test chat process stopped unexpectedly. Send another message to restart it." });
  });
  return chat;
}

ipcMain.handle("chat:send", (_e, id, req) => {
  botDir(id);
  const chat = startChat(id);
  touchChat(id);
  chat.proc.stdin.write(JSON.stringify(req) + "\n");
});
ipcMain.handle("chat:reset", (_e, id) => { const c = chats.get(id); if (c) c.proc.stdin.write(JSON.stringify({ reset: true }) + "\n"); });
ipcMain.handle("chat:stop", (_e, id) => stopChat(id));

/* ---------- Ollama ---------- */
ipcMain.handle("ollama:tags", async (_e, url) => {
  try {
    const res = await fetch(new URL("/api/tags", url), { signal: AbortSignal.timeout(3000) });
    const json = await res.json();
    return { ok: true, models: (json.models || []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// What Ollama has loaded and how much RAM it takes. Ollama is its own background program (on Linux its installer
// adds a system service that starts with the computer), so this is shown separately from the bots.
ipcMain.handle("ollama:loaded", async (_e, url) => {
  try {
    const res = await fetch(new URL("/api/ps", url), { signal: AbortSignal.timeout(3000) });
    const json = await res.json();
    return { ok: true, models: (json.models || []).map((m) => ({ name: m.name || m.model, ram: Math.max(0, (m.size || 0) - (m.size_vram || 0)), vram: m.size_vram || 0 })) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("ollama:free", async (_e, url) => {
  try {
    const n = await lib("ollama").createOllama({ url }).unloadEverything();
    return { ok: true, freed: n };
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

/* ---------- AI-assisted persona writing ---------- */
ipcMain.handle("persona:generate", async (_e, id, { mode, description, model }) => {
  try {
    const dir = botDir(id);
    const cfg = flatConfig(dir);
    const persona = lib("persona");
    const { createOllama } = lib("ollama");
    const file = fs.readFileSync(path.join(dir, "system prompt.txt"), "utf8");
    const prompt = persona.buildPersonaPrompt({
      mode,
      description,
      botName: cfg["Bot name"],
      current: { systemPrompt: persona.sectionBody(file, "SYSTEM PROMPT"), personality: persona.sectionBody(file, "PERSONALITY") },
    });
    const ollama = createOllama({ url: cfg["Ollama URL"] || "http://127.0.0.1:11434" });
    const data = await ollama.generate(
      { model: model || cfg["Reply model"], prompt, think: false, options: { temperature: 0.8 } },
      { timeoutMs: 5 * 60 * 1000 }
    );
    const parsed = persona.parsePersonaOutput(data.response);
    return parsed ? { ok: true, ...parsed } : { ok: false, error: "The model did not follow the format. Try again, or pick a larger model.", raw: data.response };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("persona:merge", (_e, fileText, parsed) => lib("persona").mergePersona(fileText, parsed));

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: "Steam LLM Chatbot",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    show: !process.argv.includes("--hidden"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Closing the window keeps the bots running in the tray (turn off in the header menu).
  win.on("close", (e) => {
    if (quitting || !tray || !keepInTray()) return;
    e.preventDefault();
    win.hide();
    if (!trayNoticeShown && Notification.isSupported()) {
      trayNoticeShown = true;
      new Notification({ title: "Steam LLM Chatbot is still running", body: procs.size ? "Your bots keep running in the tray. Right-click the tray icon and choose Quit to stop everything." : "It is in the tray. Right-click the tray icon and choose Quit to close it completely." }).show();
    }
  });
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 22, height: 22 }));
  } catch { tray = null; return; }
  const refresh = () => {
    const running = [...procs.keys()].length;
    tray.setToolTip(`Steam LLM Chatbot - ${running} bot${running === 1 ? "" : "s"} running`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open", click: showWindow },
      { label: `${running} running`, enabled: false },
      { type: "separator" },
      { label: "Quit (stops all bots)", click: () => { quitting = true; app.quit(); } },
    ]));
  };
  tray.on("click", showWindow);
  setInterval(refresh, 3000).unref();
  refresh();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on("second-instance", showWindow);

// The login entry is the only source of truth. If the user removed it outside the app (e.g. KDE's
// Autostart settings), record that instead of ever writing it back; if the option is off, clear any
// entry an older version may have left behind.
function reconcileLaunchAtLogin() {
  try {
    const ui = readUi();
    const exists = loginEntryExists();
    if (ui.launchAtLogin === true && !exists) fs.writeFileSync(UI_FILE, JSON.stringify({ ...ui, launchAtLogin: false }));
    else if (ui.launchAtLogin !== true && exists) setLaunchAtLogin(false);
  } catch (err) { console.warn("launch at login", err.message); }
}

app.whenReady().then(() => {
  reconcileLaunchAtLogin();
  // Started by a login entry the user no longer wants (left by an older version): don't run at all.
  if (process.argv.includes("--hidden") && readUi().launchAtLogin !== true) { quitting = true; app.quit(); return; }
  loadRegistry();
  ensureData(botDir("default"));
  createWindow();
  createTray();
  for (const b of loadRegistry().bots) {
    if (b.autostart) { const r = startBot(b.id); if (!r.ok) console.warn("autostart", b.id, r.error); }
  }
});

app.on("before-quit", () => { quitting = true; for (const p of procs.values()) p.kill(); for (const id of [...chats.keys()]) stopChat(id); });
// Closing the window quits (stopping every bot) unless "Keep running in the tray" is on.
app.on("window-all-closed", () => { if (quitting || !tray || !keepInTray()) app.quit(); });
