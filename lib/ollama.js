"use strict";
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
// onlyOne:   before using a different model, unload the other models THIS client loaded, so reply, timing,
//            memory and vision models can never pile up in memory (and swap) at the same time.
function createOllama({ url = "http://127.0.0.1:11434", log = () => {}, defaultTimeoutMs = 120000, keepAlive = "5m", onlyOne = true, numCtx = 0 } = {}) {
  const base = String(url).replace(/\/+$/, "");
  const capCache = new Map(); // model -> { at, caps:Set }
  const loaded = new Set(); // models this client has asked Ollama to load and not yet unloaded

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

    if (onlyOne) {
      for (const other of [...loaded]) if (other !== payload.model) await unload(other);
    }
    if (payload.keep_alive === undefined) payload.keep_alive = keepAlive;
    if (numCtx > 0 && !(payload.options && payload.options.num_ctx)) payload.options = { ...payload.options, num_ctx: numCtx };
    const dropsImmediately = String(payload.keep_alive) === "0";
    if (!dropsImmediately) loaded.add(payload.model);

    let data;
    try {
      data = await request("/api/generate", payload, { timeoutMs, signal });
    } catch (err) {
      if (err.status === 404) loaded.delete(payload.model); // not installed: nothing to unload later
      throw err;
    }
    if (dropsImmediately) loaded.delete(payload.model);
    data.thinking = String(data.thinking || "");
    data.response = stripThinking(data.response);
    return data;
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
    await Promise.all([...loaded].map(unload));
  }

  async function listModels() {
    const data = await request("/api/tags", null, { method: "GET", timeoutMs: 5000 });
    return (data.models || []).map(m => m.name);
  }

  return { generate, capabilities, listModels, request, unload, unloadAll, loadedModels: () => [...loaded], url: base };
}

module.exports = { createOllama, stripThinking, parseThinkSetting };
