"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createOllama, stripThinking, parseThinkSetting } = require("../lib/ollama");
const { bbcodeToPlain, extractImageUrls, isMentioned } = require("../lib/steam-text");
const { hostAllowed } = require("../lib/images");

test("stripThinking removes closed, unclosed and orphan-closing think blocks", () => {
  assert.equal(stripThinking("<think>hmm</think>hello"), "hello");
  assert.equal(stripThinking("hello<think>cut off"), "hello");
  assert.equal(stripThinking("reasoning...</think>hi"), "hi");
});

test("parseThinkSetting", () => {
  assert.equal(parseThinkSetting("off"), false);
  assert.equal(parseThinkSetting("ON"), true);
  assert.equal(parseThinkSetting("high"), "high");
  assert.equal(parseThinkSetting("", true), true);
});

test("bbcodeToPlain", () => {
  assert.equal(bbcodeToPlain("hi [emoticon]steamhappy[/emoticon]"), "hi :steamhappy:");
  assert.equal(bbcodeToPlain("[mention=123]@Bob[/mention] yo"), "@Bob yo");
  assert.equal(bbcodeToPlain("[spoiler]boo[/spoiler]"), "boo");
  assert.equal(bbcodeToPlain("a \\[b] c"), "a [b] c"); // sender typed a literal bracket
  assert.equal(bbcodeToPlain('[img src="https://images.steamusercontent.com/ugc/1/2/"][/img]'), "[image]");
});

test("extractImageUrls", () => {
  const raw = '[img src="https://giphy.com/gifs/x" thumbnail_src="https://media0.giphy.com/media/x/giphy.gif"][/img] see https://i.imgur.com/a.png and https://example.com/page';
  const urls = extractImageUrls(raw);
  assert.equal(urls[0], "https://media0.giphy.com/media/x/giphy.gif");
  assert.ok(urls.includes("https://i.imgur.com/a.png"));
  assert.ok(!urls.includes("https://example.com/page"));
});

test("isMentioned", () => {
  assert.equal(isMentioned({ mentions: { mention_all: true } }, 5), true);
  assert.equal(isMentioned({ mentions: { mention_steamids: [{ accountid: 5 }] } }, 5), true);
  assert.equal(isMentioned({ message: "[mention=5]@bot[/mention]" }, 5), true);
  assert.equal(isMentioned({ message: "hello" }, 5), false);
});

test("hostAllowed only lets known hosts through by default", () => {
  assert.equal(hostAllowed("https://images.steamusercontent.com/ugc/1", false), true);
  assert.equal(hostAllowed("https://evil.example/x.png", false), false);
  assert.equal(hostAllowed("http://images.steamusercontent.com/x", false), false);
  assert.equal(hostAllowed("https://evil.example/x.png", true), true);
  assert.equal(hostAllowed("https://127.0.0.1/x.png", true), false);
});

test("generate only sends think/images to models that support them", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/show") {
        const caps = json.model === "smart" ? ["completion", "thinking", "vision"] : ["completion"];
        return res.end(JSON.stringify({ capabilities: caps }));
      }
      if (json.prompt) seen.push(json); // ignore unload requests (empty prompt)
      res.end(JSON.stringify({ response: "<think>x</think>ok" }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const ollama = createOllama({ url: `http://127.0.0.1:${server.address().port}` });

  const plain = await ollama.generate({ model: "dumb", prompt: "p", think: false, images: ["AA"] });
  assert.equal(plain.response, "ok");
  assert.ok(!("think" in seen[0]) && !("images" in seen[0]));

  await ollama.generate({ model: "smart", prompt: "p", think: false, images: ["AA"] });
  assert.equal(seen[1].think, false);
  assert.deepEqual(seen[1].images, ["AA"]);

  server.closeAllConnections();
  server.close();
});

test("extractInvites and isNewer", () => {
  const { extractInvites } = require("../lib/steam-text");
  const { isNewer } = require("../lib/update");
  assert.deepEqual(extractInvites('[invite chatgroupid="47270190" chatgroupname="Multilandia"][/invite]'), [{ chatGroupId: "47270190", groupName: "Multilandia" }]);
  assert.equal(isNewer("v2.1.0", "2.0.5"), true);
  assert.equal(isNewer("2.0.5", "2.0.5"), false);
  assert.equal(isNewer("2.0.10", "2.0.9"), true);
});

test("only one model stays loaded, keep_alive is always sent, unloadAll frees everything", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/show") return res.end(JSON.stringify({ capabilities: ["completion"] }));
      calls.push({ model: json.model, keep_alive: json.keep_alive, num_ctx: json.options?.num_ctx, prompt: json.prompt });
      res.end(JSON.stringify({ response: "ok" }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const ollama = createOllama({ url: `http://127.0.0.1:${server.address().port}`, keepAlive: "2m", numCtx: 4096 });

  await ollama.generate({ model: "a", prompt: "x" });
  await ollama.generate({ model: "a", prompt: "x" });
  assert.deepEqual(calls.map(c => c.model), ["a", "a"]); // same model: no unload
  assert.equal(calls[0].keep_alive, "2m");
  assert.equal(calls[0].num_ctx, 4096);

  await ollama.generate({ model: "b", prompt: "x" });
  assert.deepEqual(calls.slice(2).map(c => [c.model, c.keep_alive]), [["a", 0], ["b", "2m"]]); // a unloaded first
  assert.deepEqual(ollama.loadedModels(), ["b"]);

  await ollama.unloadAll();
  assert.equal(calls.at(-1).keep_alive, 0);
  assert.deepEqual(ollama.loadedModels(), []);
  server.closeAllConnections();
  server.close();
});

test("extractImageUrls handles [img]url[/img] and urls inside tag attributes", () => {
  assert.deepEqual(extractImageUrls("[img]https://images.steamusercontent.com/ugc/1/2/[/img]"), ["https://images.steamusercontent.com/ugc/1/2/"]);
  assert.ok(extractImageUrls('[img src="x" url="https://images.steamusercontent.com/ugc/9/"][/img]').includes("https://images.steamusercontent.com/ugc/9/"));
});
