"use strict";
const os = require("os");
const fs = require("fs");
// Small Ollama client: timeouts, model capability detection, thinking toggle, <think> stripping.
// Zero dependencies (uses Node's built-in fetch).

const CAP_TTL_MS = 10 * 60 * 1000;

// Used only when the server is too old to report `capabilities` from /api/show.
const NAME_HINTS = {
  vision: /vision|llava|bakllava|moondream|minicpm-v|\bvl\b|-vl|gemma[34]|granite3\.2-vision|mistral-small3|llama4/i,
  thinking: /qwen3|deepseek-r1|gpt-oss|magistral|thinking|bonsai|qwq|phi4-reasoning|cogito/i
};

function stripThinking(text) {
  return String(text || "")
    .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
    .replace(/^[\s\S]*?<\/(think|thinking)>/i, "") // model emitted only the closing tag
    .replace(/<(think|thinking)>[\s\S]*$/i, "") // unclosed block (cut off by token limit)
    .trim();
}

// Accepts off/false/no/0, on/true/yes/1, or low/medium/high. Returns false | true | "low" | "medium" | "high".
function parseThinkSetting(value, fallback = false) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if (["off", "false", "no", "0", "none", "disabled"].includes(v)) return false;
  if (["on", "true", "yes", "1", "enabled", "auto"].includes(v)) return true;
  if (["low", "medium", "high"].includes(v)) return v;
  return fallback;
}

// keepAlive: how long Ollama keeps a model in RAM/VRAM after a request ("5m", "30s", "0" = unload right away,
//            "-1" = never). Without it every model the bot touches stays loaded for Ollama's default (5 minutes).
// memoryLimitBytes: hard cap on the system RAM used by loaded models (0 = no cap). It counts every model Ollama has
//            loaded, not only this bot's: before a load, the least recently used models are unloaded until the new one
//            fits (this bot's own first, then any others); a model that is too big on its own is refused; and after
//            every request the real footprint (weights + context, from /api/ps) is checked again, so a model whose
//            context made it bigger than expected is unloaded instead of being left in RAM.
// minFreeBytes: low-memory guard. If the computer has less free memory than this, models are unloaded and new
//            model calls are refused until memory frees up (0 = off).
// Ollama reports "llama3.2" as "llama3.2:latest"; compare names in that form.
const norm = name => (String(name).includes(":") ? String(name) : `${name}:latest`);
const GB = 1024 ** 3;
const fmtGB = bytes => `${(bytes / GB).toFixed(1)} GB`;

// "auto", "off", "12", "12GB", "12 GiB", "512MB", "40%". Returns bytes, 0 for off, or null when it cannot be read.
function parseMemoryAmount(value, { totalBytes = os.totalmem(), auto = 0 } = {}) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!raw || raw === "auto" || raw === "default") return auto;
  if (["off", "no", "false", "none", "0", "unlimited", "disabled"].includes(raw)) return 0;
  let m = raw.match(/^(\d+(?:\.\d+)?)%$/);
  if (m) return Math.round((totalBytes * Math.min(100, Number(m[1]))) / 100);
  m = raw.match(/^(\d+(?:\.\d+)?)(gib|gb|g|mib|mb|m)?$/);
  if (m) return Math.round(Number(m[1]) * 1024 ** (/^m/.test(m[2] || "") ? 2 : 3));
  return null;
}

// Memory the OS could hand out right now (Linux MemAvailable, which counts reclaimable cache). null when unknown.
function availableMemoryBytes() {
  try {
    if (process.platform === "linux") {
      const m = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (m) return Number(m[1]) * 1024;
    }
    if (process.platform === "win32") return os.freemem();
  } catch {}
  return null; // macOS freemem() ignores cache and reads near zero on a healthy system
}

function createOllama({ url = "http://127.0.0.1:11434", log = () => {}, defaultTimeoutMs = 120000, keepAlive = "5m", memoryLimitBytes = 0, minFreeBytes = 0, numCtx = 0, availableMemory = availableMemoryBytes } = {}) {
  const base = String(url).replace(/\/+$/, "");
  const capCache = new Map(); // model -> { at, caps:Set }
  let useCounter = 0; // orders uses; timestamps tie when calls land in the same millisecond
  const loaded = new Map(); // model -> last-use order, for models this client asked Ollama to load and not yet unloaded
  const sizeCache = new Map(); // model -> on-disk size in bytes (from /api/tags)
  const measured = new Map(); // model -> RAM it really used last time it was loaded (from /api/ps)
  let gpuSeen = false; // once a model is seen partly in VRAM, disk size says little about RAM use
  const guarded = memoryLimitBytes > 0 || minFreeBytes > 0;
  // Loads are done one at a time while a limit is on: two requests checking the budget at once would both fit "alone".
  let gate = Promise.resolve();
  const exclusive = fn => {
    const run = gate.then(fn, fn);
    gate = run.catch(() => {});
    return run;
  };
  const ramPart = m => Math.max(0, (Number(m.size) || 0) - (Number(m.size_vram) || 0));

  async function request(path, body, { timeoutMs = defaultTimeoutMs, method = "POST", signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      const res = await fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body || {}),
        signal: controller.signal
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        const err = new Error(`Ollama ${path} HTTP ${res.status}${detail ? ": " + detail : ""}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(signal?.aborted ? `Ollama ${path} request cancelled` : `Ollama ${path} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function capabilities(model) {
    const hit = capCache.get(model);
    if (hit && Date.now() - hit.at < CAP_TTL_MS) return hit.caps;

    let caps;
    try {
      const info = await request("/api/show", { model }, { timeoutMs: 8000 });
      if (Array.isArray(info.capabilities)) {
        caps = new Set(info.capabilities.map(String));
      } else {
        caps = new Set();
        for (const [cap, re] of Object.entries(NAME_HINTS)) if (re.test(model)) caps.add(cap);
      }
    } catch (err) {
      log("[ollama] could not read capabilities for", model, "-", err.message);
      caps = new Set();
      capCache.set(model, { at: Date.now() - CAP_TTL_MS + 30000, caps }); // retry in 30s
      return caps;
    }
    capCache.set(model, { at: Date.now(), caps });
    return caps;
  }

  // Same body as POST /api/generate. Extras handled here:
  //  - think: only sent to models that report the "thinking" capability (others would 400)
  //  - images: only sent to models that report "vision"
  // Returns the parsed response with `response` stripped of any <think> blocks and `thinking` always a string.
  async function generate(body, { timeoutMs = defaultTimeoutMs, signal } = {}) {
    const payload = { ...body, stream: false };
    const caps = await capabilities(payload.model);

    if ("think" in payload) {
      if (!caps.has("thinking")) delete payload.think;
      else if (typeof payload.think === "string" && !/gpt-oss/i.test(payload.model)) payload.think = true;
    }
    if (payload.images && !caps.has("vision")) {
      log("[ollama] model", payload.model, "has no vision capability; dropping images");
      delete payload.images;
    }

    if (payload.keep_alive === undefined) payload.keep_alive = keepAlive;
    if (numCtx > 0 && !(payload.options && payload.options.num_ctx)) payload.options = { ...payload.options, num_ctx: numCtx };
    return guarded ? exclusive(() => send(payload, timeoutMs, signal)) : send(payload, timeoutMs, signal);
  }

  async function send(payload, timeoutMs, signal) {
    if (guarded) await beforeLoad(payload.model);
    const dropsImmediately = String(payload.keep_alive) === "0";
    if (!dropsImmediately) loaded.set(payload.model, ++useCounter);

    let data;
    try {
      data = await request("/api/generate", payload, { timeoutMs, signal });
    } catch (err) {
      if (err.status === 404) loaded.delete(payload.model); // not installed: nothing to unload later
      throw err;
    }
    if (dropsImmediately) loaded.delete(payload.model);
    else if (guarded) await afterLoad(payload.model);
    data.thinking = String(data.thinking || "");
    data.response = stripThinking(data.response);
    return data;
  }

  async function running() {
    const models = (await request("/api/ps", null, { method: "GET", timeoutMs: 5000 })).models || [];
    for (const m of models) if (Number(m.size_vram) > 0) gpuSeen = true;
    const names = new Set(models.map(m => norm(m.name || m.model)));
    for (const name of [...loaded.keys()]) if (!names.has(norm(name))) loaded.delete(name); // Ollama already freed it
    return models;
  }

  function lowMemoryError(avail) {
    const err = new Error(`Low memory guard: only ${fmtGB(avail)} free (needs ${fmtGB(minFreeBytes)}); not loading a model until memory frees up`);
    err.code = "LOW_MEMORY";
    return err;
  }

  // Throws instead of loading when the model cannot fit or the computer is short on memory.
  async function beforeLoad(model) {
    let models;
    try {
      models = await running();
    } catch (err) {
      // Cannot see what is loaded: still refuse when the computer is clearly short on memory.
      const avail = minFreeBytes > 0 ? availableMemory() : null;
      if (avail !== null && avail < minFreeBytes) throw lowMemoryError(avail);
      log("[ollama] could not read loaded models -", err.message);
      return;
    }
    const key = norm(model);
    if (models.some(m => norm(m.name || m.model) === key)) return; // already loaded: no new memory needed

    if (minFreeBytes > 0) {
      let avail = availableMemory();
      if (avail !== null && avail < minFreeBytes && loaded.size) {
        log(`[ollama] low memory (${fmtGB(avail)} free); unloading this bot's models`);
        await unloadAll();
        avail = availableMemory();
      }
      if (avail !== null && avail < minFreeBytes) throw lowMemoryError(avail);
    }
    if (!(memoryLimitBytes > 0)) return;

    const need = await estimate(model);
    if (need > memoryLimitBytes && (measured.has(key) || !gpuSeen)) {
      const err = new Error(`${model} needs about ${fmtGB(need)} of RAM, more than the Model memory limit (${fmtGB(memoryLimitBytes)}). Pick a smaller model, lower Context size, or raise the limit.`);
      err.code = "OVER_LIMIT";
      throw err;
    }
    let used = models.reduce((sum, m) => sum + ramPart(m), 0);
    if (used + need <= memoryLimitBytes) return;
    // This bot's own models first (least recently used first), then anything else Ollama is holding.
    const ours = [...loaded].sort((a, b) => a[1] - b[1]).map(([name]) => name);
    const others = models.map(m => m.name || m.model).filter(name => !ours.some(o => norm(o) === norm(name)));
    for (const name of [...ours, ...others]) {
      if (used + need <= memoryLimitBytes) break;
      const m = models.find(x => norm(x.name || x.model) === norm(name));
      if (!m) continue;
      used -= ramPart(m);
      await unload(name);
    }
  }

  // The real footprint is only known once loaded (the context window can add gigabytes). Enforce the cap on it.
  async function afterLoad(model) {
    let models;
    try {
      models = await running();
    } catch {
      return;
    }
    const key = norm(model);
    const self = models.find(m => norm(m.name || m.model) === key);
    if (self) measured.set(key, ramPart(self));
    if (memoryLimitBytes > 0) {
      let used = models.reduce((sum, m) => sum + ramPart(m), 0);
      for (const m of models) {
        if (used <= memoryLimitBytes) break;
        if (norm(m.name || m.model) === key) continue;
        used -= ramPart(m);
        await unload(m.name || m.model);
      }
      if (self && used > memoryLimitBytes) {
        log(`[ollama] ${model} used ${fmtGB(ramPart(self))} of RAM, over the Model memory limit (${fmtGB(memoryLimitBytes)}); unloaded it. Pick a smaller model or lower Context size.`);
        await unload(model);
        return;
      }
    }
    const avail = minFreeBytes > 0 ? availableMemory() : null;
    if (avail !== null && avail < minFreeBytes) {
      log(`[ollama] low memory (${fmtGB(avail)} free) after using ${model}; unloading it`);
      await unload(model);
    }
  }

  // RAM a model will need: what it used last time, else its weights plus room for the context.
  async function estimate(model) {
    const hit = measured.get(norm(model));
    if (hit !== undefined) return hit;
    return modelSize(model);
  }

  async function modelSize(model) {
    if (!sizeCache.size) {
      try {
        const data = await request("/api/tags", null, { method: "GET", timeoutMs: 5000 });
        for (const m of data.models || []) sizeCache.set(norm(m.name || m.model), Number(m.size) || 0);
      } catch (err) {
        log("[ollama] could not read model sizes -", err.message);
      }
    }
    // Weights plus a little for the KV cache; 0 (unknown) just means nothing is evicted on its account.
    return Math.round((sizeCache.get(norm(model)) || 0) * 1.15);
  }

  // An empty generate request with keep_alive 0 tells Ollama to free the model now.
  async function unload(model) {
    loaded.delete(model);
    try {
      await request("/api/generate", { model, keep_alive: 0 }, { timeoutMs: 10000 });
      log("[ollama] unloaded", model);
    } catch (err) {
      log("[ollama] could not unload", model, "-", err.message);
    }
  }

  async function unloadAll() {
    await Promise.all([...loaded.keys()].map(unload));
  }

  // Frees every model Ollama has loaded, including ones other programs loaded.
  async function unloadEverything() {
    const models = await running().catch(() => []);
    await Promise.all(models.map(m => unload(m.name || m.model)));
    return models.length;
  }

  async function listModels() {
    const data = await request("/api/tags", null, { method: "GET", timeoutMs: 5000 });
    return (data.models || []).map(m => m.name);
  }

  return { generate, capabilities, listModels, request, unload, unloadAll, unloadEverything, loadedModels: () => [...loaded.keys()], url: base };
}

module.exports = { createOllama, stripThinking, parseThinkSetting, parseMemoryAmount, availableMemoryBytes };
