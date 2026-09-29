"use strict";

const $ = (id) => document.getElementById(id);
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const LOG_LIMIT = 200000;
const OPTIONS = {
  "Default group mode": ["off", "alias", "smart", "all"],
  "Default DM mode": ["off", "alias", "all"],
  "Startup mode": ["auto", "manual"],
};
const MODEL_KEYS = ["Reply model", "Timing model", "Fast reply model", "Fast timing model", "Memory model"];
const DEFAULT_OLLAMA = "http://127.0.0.1:11434";

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let cfg = {}; // flat key -> value, mirrors config.txt

async function loadConfig() {
  const sections = await api.getConfig();
  cfg = {};
  for (const s of sections) for (const i of s.items) cfg[i.key] = i.value;
  return sections;
}

const ollamaUrl = () => cfg["Ollama URL"] || DEFAULT_OLLAMA;

/* ---------- tabs ---------- */
document.querySelectorAll("#tabs button").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll("#tabs button, .tab").forEach((n) => n.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "settings") renderSettings();
    if (btn.dataset.tab === "prompt") loadPrompt();
    if (btn.dataset.tab === "ollama") refreshOllama();
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

function appendLog(text) {
  const log = $("log");
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = (log.textContent + text.replace(ANSI, "")).slice(-LOG_LIMIT);
  if (stick) log.scrollTop = log.scrollHeight;
}

$("startBtn").onclick = async () => {
  if (await api.botStart()) { $("log").textContent = ""; setRunning(true); }
};
$("stopBtn").onclick = () => api.botStop();
$("folderBtn").onclick = () => api.openData();
$("wizardBtn").onclick = () => openWizard();
$("inputForm").onsubmit = (e) => {
  e.preventDefault();
  const line = $("botInput").value;
  if (!line) return;
  api.botInput(line);
  appendLog(`> ${line}\n`);
  $("botInput").value = "";
};
api.onLog(appendLog);
api.onExit((code) => {
  setRunning(false);
  appendLog(code === 20
    ? "\n[GUI] Steam login is missing or was rejected. Check the Steam account in Settings.\n"
    : `\n[GUI] Bot stopped (exit code ${code}).\n`);
});

/* ---------- settings ---------- */
function messageIn(node, text, ok) {
  node.textContent = text;
  node.className = "msg " + (ok ? "ok" : "bad");
}

async function renderSettings() {
  const sections = await loadConfig();
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
  await api.setConfig(collectSettings());
  await loadConfig();
  messageIn($("settingsMsg"), "Saved.", true);
};

/* ---------- system prompt ---------- */
async function loadPrompt() { $("promptText").value = await api.getPrompt(); }
$("savePrompt").onclick = async () => {
  await api.setPrompt($("promptText").value);
  messageIn($("promptMsg"), "Saved.", true);
};

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
      await api.setConfig(Object.fromEntries(MODEL_KEYS.map((k) => [k, model])));
    },
  },
  {
    title: "2. Steam account",
    build(box) {
      box.append(
        el("p", { className: "hint", textContent: "Use a Steam account dedicated to the bot. Leave Steam Guard blank to type a fresh code into the console when asked." }),
        el("label", { textContent: "Steam account name" }), el("input", { id: "wizUser", value: cfg["Steam account name"] || "", autocomplete: "off" }),
        el("label", { textContent: "Steam password" }), el("input", { id: "wizPass", type: "password", value: cfg["Steam password"] || "" }),
      );
    },
    async save() {
      if (!$("wizUser").value.trim() || !$("wizPass").value) return "Steam account name and password are required.";
      await api.setConfig({ "Steam account name": $("wizUser").value.trim(), "Steam password": $("wizPass").value });
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
      await api.setConfig({ "Bot name": $("wizName").value.trim(), "Aliases": $("wizAliases").value.trim() });
    },
  },
  {
    title: "4. Personality",
    build(box) {
      box.append(
        el("p", { className: "hint", textContent: "Edit the system prompt in plain English, or keep the default and change it later on the System Prompt tab." }),
        el("textarea", { id: "wizPrompt", spellcheck: false }),
      );
      api.getPrompt().then((t) => { $("wizPrompt").value = t; });
    },
    async save() { await api.setPrompt($("wizPrompt").value); },
  },
  {
    title: "All set",
    build(box) {
      box.append(el("p", { textContent: "Settings saved. Press Finish to close the wizard, then Start bot on the Dashboard." }));
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

$("wizBack").onclick = () => { step--; renderStep(); };
$("wizSkip").onclick = () => { $("wizard").hidden = true; };
$("wizNext").onclick = async () => {
  const problem = await STEPS[step].save();
  if (problem) { alert(problem); return; }
  await loadConfig();
  if (step === STEPS.length - 1) { $("wizard").hidden = true; return; }
  step++;
  renderStep();
};

/* ---------- boot ---------- */
(async () => {
  await loadConfig();
  setRunning(await api.botRunning());
  if (!cfg["Steam account name"]) openWizard();
})();
