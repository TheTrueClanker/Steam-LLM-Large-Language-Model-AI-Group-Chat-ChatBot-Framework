"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createOllama, parseMemoryAmount } = require("../lib/ollama");

const GB = 1024 ** 3;

// Fake Ollama. `disk` = size in /api/tags, `ram` = size it really takes once loaded (defaults to disk).
// `foreign` = models some other program loaded.
async function fakeOllama({ disk, ram = {}, foreign = [], delayMs = 0 }) {
  const resident = new Set(foreign);
  const log = [];
  let active = 0;
  let maxActive = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      const json = JSON.parse(body || "{}");
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/show") return res.end(JSON.stringify({ capabilities: ["completion"] }));
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: Object.entries(disk).map(([name, size]) => ({ name: name + ":latest", size })) }));
      if (req.url === "/api/ps") return res.end(JSON.stringify({ models: [...resident].map(name => ({ name: name + ":latest", size: ram[name] ?? disk[name] })) }));
      const name = String(json.model).replace(/:latest$/, "");
      if (String(json.keep_alive) === "0") {
        resident.delete(name);
        log.push("unload " + name);
        return res.end(JSON.stringify({ response: "" }));
      }
      active++;
      maxActive = Math.max(maxActive, active);
      resident.add(name);
      log.push("load " + name);
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      active--;
      res.end(JSON.stringify({ response: "ok" }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    resident,
    log,
    maxActive: () => maxActive,
    close: () => { server.closeAllConnections(); server.close(); }
  };
}

test("parseMemoryAmount reads GB, MB, percentages, auto and off, and rejects junk", () => {
  const total = 16 * GB;
  assert.equal(parseMemoryAmount("auto", { totalBytes: total, auto: 5 }), 5);
  assert.equal(parseMemoryAmount("", { totalBytes: total, auto: 5 }), 5);
  assert.equal(parseMemoryAmount("off", { totalBytes: total }), 0);
  assert.equal(parseMemoryAmount("0", { totalBytes: total }), 0);
  assert.equal(parseMemoryAmount("6", { totalBytes: total }), 6 * GB);
  assert.equal(parseMemoryAmount("6GB", { totalBytes: total }), 6 * GB);
  assert.equal(parseMemoryAmount("6 GiB", { totalBytes: total }), 6 * GB);
  assert.equal(parseMemoryAmount("1.5g", { totalBytes: total }), 1.5 * GB);
  assert.equal(parseMemoryAmount("512MB", { totalBytes: total }), 512 * 1024 ** 2);
  assert.equal(parseMemoryAmount("25%", { totalBytes: total }), 4 * GB);
  assert.equal(parseMemoryAmount("lots", { totalBytes: total }), null);
  assert.equal(parseMemoryAmount("-4", { totalBytes: total }), null);
});

test("a model too big for the limit on its own is refused, not loaded", async () => {
  const fake = await fakeOllama({ disk: { huge: 20 * GB } });
  const ollama = createOllama({ url: fake.url, memoryLimitBytes: 8 * GB });
  await assert.rejects(ollama.generate({ model: "huge", prompt: "x" }), err => err.code === "OVER_LIMIT");
  assert.deepEqual(fake.log, []);
  fake.close();
});

test("if a model turns out bigger than the limit once loaded (big context), it is unloaded right after the reply", async () => {
  const fake = await fakeOllama({ disk: { m: 4 * GB }, ram: { m: 10 * GB } });
  const logs = [];
  const ollama = createOllama({ url: fake.url, memoryLimitBytes: 8 * GB, log: (...p) => logs.push(p.join(" ")) });
  const res = await ollama.generate({ model: "m", prompt: "x" });
  assert.equal(res.response, "ok"); // the reply still goes out
  assert.deepEqual(fake.log, ["load m", "unload m"]);
  assert.ok(logs.some(l => /over the Model memory limit/.test(l)));
  // next time its measured size is known, so it is refused up front
  await assert.rejects(ollama.generate({ model: "m", prompt: "x" }), err => err.code === "OVER_LIMIT");
  fake.close();
});

test("models loaded by other programs count toward the limit and are unloaded when needed", async () => {
  const fake = await fakeOllama({ disk: { other: 6 * GB, mine: 4 * GB }, foreign: ["other"] });
  const ollama = createOllama({ url: fake.url, memoryLimitBytes: 8 * GB });
  await ollama.generate({ model: "mine", prompt: "x" });
  assert.deepEqual(fake.log, ["unload other", "load mine"]);
  assert.deepEqual([...fake.resident], ["mine"]);
  fake.close();
});

test("concurrent calls load one at a time so they cannot both squeeze past the limit", async () => {
  const fake = await fakeOllama({ disk: { a: 5 * GB, b: 5 * GB }, delayMs: 30 });
  const ollama = createOllama({ url: fake.url, memoryLimitBytes: 8 * GB });
  await Promise.all([ollama.generate({ model: "a", prompt: "x" }), ollama.generate({ model: "b", prompt: "x" })]);
  assert.equal(fake.maxActive(), 1);
  assert.equal(fake.resident.size, 1, "never both resident: " + fake.log.join(", "));
  fake.close();
});

test("low memory guard unloads the bot's models and refuses to load while memory is short", async () => {
  const fake = await fakeOllama({ disk: { a: 2 * GB, b: 2 * GB } });
  let free = 10 * GB;
  const ollama = createOllama({ url: fake.url, minFreeBytes: 2 * GB, availableMemory: () => free });
  await ollama.generate({ model: "a", prompt: "x" });
  free = 1 * GB; // something else ate the RAM
  await assert.rejects(ollama.generate({ model: "b", prompt: "x" }), err => err.code === "LOW_MEMORY");
  assert.deepEqual(fake.log, ["load a", "unload a"]);
  free = 10 * GB;
  await ollama.generate({ model: "b", prompt: "x" });
  assert.deepEqual(fake.log.at(-1), "load b");
  fake.close();
});

test("unloadEverything frees models no matter who loaded them", async () => {
  const fake = await fakeOllama({ disk: { x: GB, y: GB }, foreign: ["x", "y"] });
  const ollama = createOllama({ url: fake.url });
  assert.equal(await ollama.unloadEverything(), 2);
  assert.equal(fake.resident.size, 0);
  fake.close();
});
