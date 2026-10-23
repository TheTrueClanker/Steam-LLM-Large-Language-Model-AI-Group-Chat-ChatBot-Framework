"use strict";

const $ = (id) => document.getElementById(id);
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const LOG_LIMIT = 200000;
const OPTIONS = {
  "Default group mode": ["off", "alias", "smart", "all"],
  "Default DM mode": ["off", "alias", "all"],
  "Startup mode": ["auto", "manual"],
  "Thinking": ["off", "on", "low", "medium", "high"],
};
const MODEL_KEYS = ["Reply model", "Timing model", "Fast reply model", "Fast timing model", "Memory model"];
const MODEL_FIELDS = [...MODEL_KEYS, "Vision model", "Safety model"];
const DEFAULT_OLLAMA = "http://127.0.0.1:11434";
const THEMES = [["dark", "Dark"], ["light", "Light"], ["steam", "Steam"], ["catboy", "Yuki's Theme"], ["fergus", "Fergus Dynamics"], ["sakura", "Sakura"], ["contrast", "High contrast"]];

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/* ---------- state ---------- */
let bots = [];          // [{ id, label, running }]
let botId = "default";  // currently selected bot
let cfg = {};           // flat key -> value for the selected bot
let ui = {};            // saved UI prefs
const logs = new Map(); // bot id -> console text
const chatLines = new Map(); // bot id -> [{ kind: user|bot|sys, ... }]
const chatBusy = new Set();

const isRunning = (id) => bots.some((b) => b.id === id && b.running);
const ollamaUrl = () => cfg["Ollama URL"] || DEFAULT_OLLAMA;

async function loadConfig() {
  const sections = await api.getConfig(botId);
  cfg = {};
  for (const s of sections) for (const i of s.items) cfg[i.key] = i.value;
  return sections;
}

/* ---------- themes ---------- */
function applyTheme(name) {
  document.documentElement.dataset.theme = THEMES.some(([id]) => id === name) ? name : "dark";
  $("themeSelect").value = document.documentElement.dataset.theme;
}
$("themeSelect").replaceChildren(...THEMES.map(([id, label]) => el("option", { value: id, textContent: label })));
$("themeSelect").onchange = () => { applyTheme($("themeSelect").value); api.setUi({ theme: $("themeSelect").value }); };

/* ---------- bot picker ---------- */
async function refreshBots() {
  bots = await api.listBots();
  if (!bots.some((b) => b.id === botId)) botId = bots[0].id;
  $("botSelect").replaceChildren(...bots.map((b) => el("option", { value: b.id, textContent: (b.running ? "● " : "") + b.label, selected: b.id === botId })));
  const running = bots.filter((b) => b.running).length;
  $("runningInfo").textContent = bots.length > 1 ? `${running} of ${bots.length} bots running` : "";
}

async function selectBot(id) {
  botId = id;
  await refreshBots();
  await loadConfig();
  renderLog();
  renderChat();
  setRunning(isRunning(botId));
  $("optAutostart").checked = !!bots.find((b) => b.id === botId)?.autostart;
  const active = document.querySelector("#tabs button.active");
  if (active) active.click();
  api.setUi({ lastBot: botId });
}
$("botSelect").onchange = () => selectBot($("botSelect").value);

function dialog(title, buildBody, onOk) {
  $("botDialogTitle").textContent = title;
  const body = $("botDialogBody");
  body.replaceChildren();
  buildBody(body);
  $("botDialog").hidden = false;
  $("botDialogCancel").onclick = () => { $("botDialog").hidden = true; };
  $("botDialogOk").onclick = async () => { if (await onOk() !== false) $("botDialog").hidden = true; };
}

$("botNew").onclick = () => dialog("Add a bot", (body) => {
  body.append(
    el("p", { className: "hint", textContent: "Each bot has its own persona, settings, memory and Steam account. Several bots can run at the same time." }),
    el("label", { textContent: "Name" }), el("input", { id: "newBotName", value: "New bot", autocomplete: "off" }),
    el("label", {}, el("input", { id: "newBotClone", type: "checkbox", checked: true }), " Copy persona and settings from the current bot (not its Steam login)"),
  );
}, async () => {
  const id = await api.createBot($("newBotName").value, $("newBotClone").checked ? botId : null);
  await selectBot(id);
  openWizard();
});

$("botMenu").onclick = () => dialog("Manage this bot", (body) => {
  body.append(
    el("label", { textContent: "Name" }), el("input", { id: "renameBot", value: bots.find((b) => b.id === botId)?.label || "" }),
    el("button", {
      textContent: "Delete this bot...", className: "danger", onclick: async () => {
        if (bots.length <= 1) { alert("You need at least one bot."); return; }
        if (!confirm("Delete this bot and its settings, persona and memory? This cannot be undone.")) return;
        await api.deleteBot(botId);
        $("botDialog").hidden = true;
        await selectBot(bots.find((b) => b.id !== botId).id);
      },
    }),
  );
}, async () => {
  await api.renameBot(botId, $("renameBot").value);
  await refreshBots();
});

/* ---------- tabs ---------- */
document.querySelectorAll("#tabs button").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll("#tabs button, .tab").forEach((n) => n.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "settings") renderSettings();
    if (btn.dataset.tab === "prompt") loadPrompt();
    if (btn.dataset.tab === "ollama") refreshOllama();
    if (btn.dataset.tab === "chat") renderChat();
  };
});

/* ---------- dashboard ---------- */
function setRunning(running) {
  $("status").textContent = running ? "Running" : "Stopped";
  $("status").className = "pill " + (running ? "running" : "stopped");
  $("startBtn").disabled = running;
  $("stopBtn").disabled = !running;
  $("botInput").disabled = !running;
  $("sendBtn").disabled = !running;
}

function renderLog() {
  const log = $("log");
  log.textContent = logs.get(botId) || "";
  log.scrollTop = log.scrollHeight;
}

function appendLog(id, text) {
  const next = ((logs.get(id) || "") + text.replace(ANSI, "")).slice(-LOG_LIMIT);
  logs.set(id, next);
  if (id !== botId) return;
  const log = $("log");
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = next;
  if (stick) log.scrollTop = log.scrollHeight;
}

$("startBtn").onclick = async () => {
  const res = await api.botStart(botId);
  if (!res.ok) { appendLog(botId, `[GUI] ${res.error}\n`); return; }
  logs.set(botId, "");
  renderLog();
  await refreshBots();
  setRunning(true);
};
$("stopBtn").onclick = () => api.botStop(botId);
$("folderBtn").onclick = () => api.openData(botId);
$("wizardBtn").onclick = () => openWizard();
$("inputForm").onsubmit = (e) => {
  e.preventDefault();
  const line = $("botInput").value;
  if (!line) return;
  api.botInput(botId, line);
  appendLog(botId, `> ${line}\n`);
  $("botInput").value = "";
};
api.onLog(({ id, text }) => appendLog(id, text));
api.onExit(async ({ id, code }) => {
  await refreshBots();
  if (id === botId) setRunning(false);
  appendLog(id, code === 20
    ? "\n[GUI] Steam login is missing or was rejected. Check the Steam account in Settings.\n"
    : `\n[GUI] Bot stopped (exit code ${code}).\n`);
});

/* ---------- test chat ---------- */
let attachments = []; // [{ dataUrl, base64 }]

function renderChat() {
  const box = $("chatLog");
  const lines = chatLines.get(botId) || [];
  box.replaceChildren(...lines.map(bubbleFor));
  if (!lines.length) box.append(el("div", { className: "bubble sys", textContent: "Say something to start. The first message takes a few seconds while the model loads." }));
  box.scrollTop = box.scrollHeight;
  $("chatSend").disabled = chatBusy.has(botId);
}

function bubbleFor(line) {
  const bubble = el("div", { className: "bubble " + line.kind });
  if (line.who) bubble.append(el("span", { className: "who", textContent: line.who }));
  for (const src of line.images || []) bubble.append(el("img", { src }));
  bubble.append(document.createTextNode(line.text || ""));
  if (line.chips?.length) bubble.append(el("div", { className: "chips" }, ...line.chips.map((c) => el("span", { className: "chip", textContent: c }))));
  return bubble;
}

function pushChat(id, line) {
  if (!chatLines.has(id)) chatLines.set(id, []);
  chatLines.get(id).push(line);
  if (id === botId) renderChat();
}

function renderAttachments() {
  const box = $("chatAttach");
  box.hidden = !attachments.length;
  box.replaceChildren(...attachments.map((a, i) => el("span", { className: "thumb" }, el("img", { src: a.dataUrl, title: "Click to remove", onclick: () => { attachments.splice(i, 1); renderAttachments(); } }))));
}

$("chatImg").onclick = () => $("chatFile").click();
$("chatFile").onchange = () => {
  for (const file of $("chatFile").files) {
    if (attachments.length >= 3 || file.size > 8 * 1024 * 1024) continue;
    const reader = new FileReader();
    reader.onload = () => { attachments.push({ dataUrl: reader.result, base64: String(reader.result).split(",")[1] }); renderAttachments(); };
    reader.readAsDataURL(file);
  }
  $("chatFile").value = "";
};

$("chatForm").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if ((!text && !attachments.length) || chatBusy.has(botId)) return;
  const sender = $("chatSender").value.trim() || "Tester";
  pushChat(botId, { kind: "user", who: sender, text, images: attachments.map((a) => a.dataUrl) });
  pushChat(botId, { kind: "sys", text: "thinking...", pending: true });
  chatBusy.add(botId);
  await api.chatSend(botId, { id: Date.now(), text, kind: $("chatKind").value, sender, imageData: attachments.map((a) => a.base64) });
  attachments = [];
  renderAttachments();
  $("chatInput").value = "";
  renderChat();
};

$("chatReset").onclick = async () => {
  await api.chatReset(botId);
  chatLines.set(botId, []);
  renderChat();
};

function dropPending(id) {
  const lines = chatLines.get(id) || [];
  chatLines.set(id, lines.filter((l) => !l.pending));
}

api.onChat((m) => {
  const id = m.botId;
  if (m.ready) {
    pushChat(id, { kind: "sys", text: `${m.bot} is ready - model ${m.model}, thinking ${m.thinking === false ? "off" : m.thinking}, vision ${m.vision ? "on" : "off"}${m.visionModel ? " (" + m.visionModel + ")" : ""}, actions: ${m.actions.join(", ") || "none"}` });
    return;
  }
  if (m.reset) return;
  dropPending(id);
  chatBusy.delete(id);
  if (m.error) pushChat(id, { kind: "sys", text: "Error: " + m.error });
  else if (m.blocked) pushChat(id, { kind: "sys", text: "(the bot chose not to reply - the safety filter blocked it)" });
  else {
    const chips = m.actions.map((a) => (a.type === "react" ? `reacts :${a.name}:` : `/me ${a.text}`));
    if (m.vision) chips.push(m.vision.images ? `saw ${m.vision.images} image(s)` : "images described as text");
    chips.push(`${(m.ms / 1000).toFixed(1)}s`);
    pushChat(id, { kind: "bot", who: $("botSelect").selectedOptions[0]?.textContent.replace(/^● /, "") || "Bot", text: m.bbcode || m.reply, chips });
  }
  if (id === botId) renderChat();
});

api.onChatLog(({ botId: id, text }) => {
  if (id !== botId) return;
  const pre = $("chatDebug");
  pre.textContent = (pre.textContent + text.replace(ANSI, "")).slice(-20000);
  pre.scrollTop = pre.scrollHeight;
});

/* ---------- settings ---------- */
function messageIn(node, text, ok) {
  node.textContent = text;
  node.className = "msg " + (ok ? "ok" : "bad");
}

async function renderSettings() {
  const sections = await loadConfig();
  api.ollamaTags(ollamaUrl()).then((res) => {
    $("modelOptions").replaceChildren(...(res.ok ? res.models : []).map((m) => el("option", { value: m })));
  });
  const form = $("settingsForm");
  form.replaceChildren();
  for (const s of sections) {
    const set = el("fieldset", {}, el("legend", { textContent: s.section }));
    for (const item of s.items) {
      let input;
      if (OPTIONS[item.key]) {
        input = el("select", {}, ...OPTIONS[item.key].map((o) => el("option", { value: o, textContent: o, selected: o === item.value })));
      } else if (/^(on|off)$/i.test(item.value)) {
        input = el("input", { type: "checkbox", checked: item.value.toLowerCase() === "on" });
      } else {
        input = el("input", { type: /password/i.test(item.key) ? "password" : "text", value: item.value });
        if (MODEL_FIELDS.includes(item.key)) input.setAttribute("list", "modelOptions");
      }
      input.dataset.key = item.key;
      set.append(el("div", { className: "field" }, el("label", { textContent: item.key }), input, ...(item.help ? [el("small", { textContent: item.help })] : [])));
    }
    form.append(set);
  }
}

function collectSettings() {
  const values = {};
  document.querySelectorAll("#settingsForm [data-key]").forEach((n) => {
    values[n.dataset.key] = n.type === "checkbox" ? (n.checked ? "on" : "off") : n.value;
  });
  return values;
}

$("saveSettings").onclick = async () => {
  await api.setConfig(botId, collectSettings());
  await loadConfig();
  messageIn($("settingsMsg"), isRunning(botId) ? "Saved. Restart the bot to apply." : "Saved.", true);
};

/* ---------- persona (system prompt) ---------- */
async function loadPrompt() { $("promptText").value = await api.getPrompt(botId); }
$("savePrompt").onclick = async () => {
  await api.setPrompt(botId, $("promptText").value);
  messageIn($("promptMsg"), isRunning(botId) ? "Saved. Restart the bot to apply." : "Saved.", true);
};

async function aiPersona(mode) {
  const description = $("aiIdea").value.trim();
  if (mode === "generate" && !description) { messageIn($("aiMsg"), "Describe the character first.", false); return; }
  for (const id of ["aiGenerate", "aiEnhance"]) $(id).disabled = true;
  messageIn($("aiMsg"), "Writing... this can take a minute on a big model.", true);
  const res = await api.personaGenerate(botId, { mode, description, model: $("aiModel").value.trim() });
  for (const id of ["aiGenerate", "aiEnhance"]) $(id).disabled = false;
  if (!res.ok) { messageIn($("aiMsg"), res.error, false); return; }
  $("promptText").value = await api.personaMerge($("promptText").value, { systemPrompt: res.systemPrompt, personality: res.personality });
  messageIn($("aiMsg"), "Written into the editor below. Read it, tweak it, then press Save persona (try it in Test chat afterwards).", true);
}
$("aiGenerate").onclick = () => aiPersona("generate");
$("aiEnhance").onclick = () => aiPersona("enhance");

/* ---------- ollama ---------- */
let installed = [];

async function refreshOllama() {
  await loadConfig();
  const res = await api.ollamaTags(ollamaUrl());
  installed = res.ok ? res.models : [];
  $("ollamaStatus").textContent = res.ok ? `Ollama running at ${ollamaUrl()}` : "Ollama not reachable";
  $("ollamaStatus").className = "pill " + (res.ok ? "ok" : "bad");
  $("modelList").replaceChildren(...(installed.length ? installed : ["(none installed)"]).map((m) => el("li", { textContent: m })));
  return res;
}

$("ollamaRefresh").onclick = refreshOllama;
$("ollamaDownload").onclick = () => api.openLink("https://ollama.com/download");

// Pulls each model in turn, reporting progress into the given bar/message nodes.
async function pullModels(models, bar, msg) {
  bar.hidden = false;
  for (const model of models) {
    messageIn(msg, `Pulling ${model}...`, true);
    const res = await api.ollamaPull(ollamaUrl(), model);
    if (!res.ok) { messageIn(msg, `Could not pull ${model}: ${res.error}`, false); return false; }
  }
  bar.hidden = true;
  messageIn(msg, "Done.", true);
  return true;
}

api.onPullProgress((p) => {
  const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
  for (const [bar, msg] of [[$("pullBar"), $("pullMsg")], [$("wizBar"), $("wizMsg")]]) {
    if (!bar) continue;
    bar.value = pct;
    msg.textContent = `${p.model}: ${p.status}${p.total ? ` (${pct}%)` : ""}`;
  }
});

$("pullForm").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("pullName").value.trim();
  if (!name) return;
  if (await pullModels([name], $("pullBar"), $("pullMsg"))) refreshOllama();
};

/* ---------- first-run wizard ---------- */
const STEPS = [
  {
    title: "1. Ollama and a model",
    build(box) {
      box.append(
        el("p", { className: "hint", textContent: "The bot talks through a local Ollama model. This checks Ollama is running and can download a model for you." }),
        el("span", { id: "wizOllama", className: "pill stopped", textContent: "Checking..." }),
        el("button", { textContent: "Download Ollama", onclick: () => api.openLink("https://ollama.com/download") }),
        el("label", { textContent: "Model" }),
        el("input", { id: "wizModel", value: cfg["Reply model"] || "llama3.2:latest", autocomplete: "off" }),
        el("label", {}, el("input", { id: "wizSafety", type: "checkbox", checked: true }), ` Also pull the safety model (${cfg["Safety model"] || "llama-guard3:1b"})`),
        el("button", { textContent: "Pull now", onclick: wizPull }),
        el("progress", { id: "wizBar", max: 100, value: 0, hidden: true }),
        el("p", { id: "wizMsg", className: "msg" }),
      );
      refreshOllama().then((res) => {
        $("wizOllama").textContent = res.ok ? "Ollama is running" : "Ollama not reachable - install and start it, then Refresh";
        $("wizOllama").className = "pill " + (res.ok ? "ok" : "bad");
      });
    },
    async save() {
      const model = $("wizModel").value.trim();
      if (!model) return "Enter a model name.";
      await api.setConfig(botId, Object.fromEntries(MODEL_KEYS.map((k) => [k, model])));
    },
  },
  {
    title: "2. Steam account",
    build(box) {
      box.append(
        el("p", { className: "hint", textContent: "Use a Steam account dedicated to the bot. After the first successful login the bot remembers it, so Steam Guard is only asked once. Leave Steam Guard blank to type a fresh code into the console when asked." }),
        el("label", { textContent: "Steam account name" }), el("input", { id: "wizUser", value: cfg["Steam account name"] || "", autocomplete: "off" }),
        el("label", { textContent: "Steam password" }), el("input", { id: "wizPass", type: "password", value: cfg["Steam password"] || "" }),
        el("p", { className: "hint", textContent: "Only want to try the persona? Skip the wizard and use the Test chat tab - no Steam account needed." }),
      );
    },
    async save() {
      if (!$("wizUser").value.trim() || !$("wizPass").value) return "Steam account name and password are required.";
      await api.setConfig(botId, { "Steam account name": $("wizUser").value.trim(), "Steam password": $("wizPass").value });
    },
  },
  {
    title: "3. Bot name",
    build(box) {
      box.append(
        el("p", { className: "hint", textContent: "The bot replies in groups when its name or an alias is said." }),
        el("label", { textContent: "Bot name" }), el("input", { id: "wizName", value: cfg["Bot name"] || "" }),
        el("label", { textContent: "Aliases (comma separated)" }), el("input", { id: "wizAliases", value: cfg["Aliases"] || "" }),
      );
    },
    async save() {
      if (!$("wizName").value.trim()) return "Give the bot a name.";
      await api.setConfig(botId, { "Bot name": $("wizName").value.trim(), "Aliases": $("wizAliases").value.trim() });
    },
  },
  {
    title: "4. Personality",
    build(box) {
      box.append(
        el("p", { className: "hint", textContent: "Edit the system prompt in plain English, or keep the default. The Persona tab can also write one for you with an installed model." }),
        el("textarea", { id: "wizPrompt", spellcheck: false }),
      );
      api.getPrompt(botId).then((t) => { $("wizPrompt").value = t; });
    },
    async save() { await api.setPrompt(botId, $("wizPrompt").value); },
  },
  {
    title: "All set",
    build(box) {
      box.append(el("p", { textContent: "Settings saved. Try the persona in the Test chat tab, then press Start bot on the Dashboard." }));
    },
    async save() {},
  },
];

let step = 0;

async function wizPull() {
  const models = [$("wizModel").value.trim()];
  if ($("wizSafety").checked && cfg["Safety model"] !== "") models.push(cfg["Safety model"] || "llama-guard3:1b");
  if (models[0]) await pullModels(models, $("wizBar"), $("wizMsg"));
}

function renderStep() {
  const box = el("div", { className: "step" }, el("h2", { textContent: STEPS[step].title }));
  STEPS[step].build(box);
  $("wizardStep").replaceChildren(box);
  $("wizBack").disabled = step === 0;
  $("wizNext").textContent = step === STEPS.length - 1 ? "Finish" : "Next";
}

async function openWizard() {
  await loadConfig();
  step = 0;
  renderStep();
  $("wizard").hidden = false;
}

function closeWizard() { $("wizard").hidden = true; api.setUi({ wizardSeen: true }); }

$("wizBack").onclick = () => { step--; renderStep(); };
$("wizSkip").onclick = closeWizard;
$("wizNext").onclick = async () => {
  const problem = await STEPS[step].save();
  if (problem) { alert(problem); return; }
  await loadConfig();
  if (step === STEPS.length - 1) { closeWizard(); return; }
  step++;
  renderStep();
};

/* ---------- background behaviour + updates ---------- */
$("optAutostart").onchange = () => api.setAutostart(botId, $("optAutostart").checked).then(refreshBots);
$("optTray").onchange = () => api.setUi({ closeToTray: $("optTray").checked });
$("optLogin").onchange = () => api.setUi({ launchAtLogin: $("optLogin").checked });

async function checkUpdates() {
  const res = await api.checkUpdate();
  if (!res.ok || !res.available || ui.dismissedUpdate === res.latest) return;
  $("updateText").textContent = `Version ${res.latest} is out (you have ${res.current}).`;
  $("updateOpen").onclick = () => api.openLink(res.url);
  $("updateDismiss").onclick = () => { $("updateBanner").hidden = true; api.setUi({ dismissedUpdate: res.latest }); };
  $("updateInstall").hidden = !res.canInstall;
  $("updateInstall").onclick = async () => {
    if (!confirm(`Download ${res.asset.name} and install version ${res.latest}? Running bots will be stopped and the app will restart.`)) return;
    $("updateInstall").disabled = true;
    const done = await api.installUpdate();
    $("updateInstall").disabled = false;
    $("updateText").textContent = done.ok
      ? (done.action === "saved" ? `Downloaded to ${done.path}. Install it from there.` : "Installing...")
      : `Update failed: ${done.error}`;
  };
  $("updateBanner").hidden = false;
}
api.onUpdateProgress(({ got, total }) => {
  $("updateText").textContent = total ? `Downloading the update... ${Math.round((got / total) * 100)}%` : "Downloading the update...";
});

/* ---------- boot ---------- */
(async () => {
  ui = await api.getUi();
  applyTheme(ui.theme);
  bots = await api.listBots();
  if (ui.lastBot && bots.some((b) => b.id === ui.lastBot)) botId = ui.lastBot;
  await selectBot(botId);
  $("optTray").checked = ui.closeToTray !== false;
  $("optLogin").checked = !!ui.launchAtLogin;
  checkUpdates();
  if (!ui.wizardSeen && !cfg["Steam account name"]) openWizard();
})();
