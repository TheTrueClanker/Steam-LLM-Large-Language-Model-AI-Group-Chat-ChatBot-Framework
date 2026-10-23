"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkForUpdate, pickAsset, isNewer, DEFAULT_REPO } = require("../lib/update");

const rel = {
  tag_name: "v2.2.0", html_url: "https://github.com/o/r/releases/tag/v2.2.0", body: "notes",
  assets: [
    { name: "SteamLLMChatbot-Setup-2.2.0.exe", browser_download_url: "https://github.com/o/r/releases/download/v2.2.0/a.exe", size: 5, digest: "sha256:" + "a".repeat(64) },
    { name: "SteamLLMChatbot-2.2.0.AppImage", browser_download_url: "https://github.com/o/r/releases/download/v2.2.0/b.AppImage", size: 7 }
  ]
};
const ok = body => async () => ({ status: 200, ok: true, json: async () => body });

test("defaults to the original project, not a fork", () => {
  assert.match(DEFAULT_REPO, /^TheTrueClanker\//);
});

test("picks the installer for each platform and reads the checksum when present", () => {
  assert.equal(pickAsset(rel.assets, "win32").name, "SteamLLMChatbot-Setup-2.2.0.exe");
  assert.equal(pickAsset(rel.assets, "win32").sha256, "a".repeat(64));
  assert.equal(pickAsset(rel.assets, "linux").name, "SteamLLMChatbot-2.2.0.AppImage");
  assert.equal(pickAsset(rel.assets, "darwin"), null);
});

test("reports a newer release with its installer; none when up to date or no releases exist", async () => {
  const r = await checkForUpdate("2.1.3", { repo: "o/r", platform: "linux", fetchFn: ok(rel) });
  assert.equal(r.available, true);
  assert.equal(r.latest, "2.2.0");
  assert.equal(r.asset.name, "SteamLLMChatbot-2.2.0.AppImage");
  assert.equal((await checkForUpdate("2.2.0", { repo: "o/r", fetchFn: ok(rel) })).available, false);
  assert.equal((await checkForUpdate("1.0.0", { repo: "o/r", fetchFn: async () => ({ status: 404, ok: false }) })).available, false);
  assert.ok(isNewer("2.10.0", "2.9.9"));
});

test("rejects a malformed update source", async () => {
  await assert.rejects(checkForUpdate("1.0.0", { repo: "not a repo", fetchFn: ok(rel) }));
});
