"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseActions, actionsPrompt, rememberPerson, ALL_ON } = require("../lib/steam-actions");

const OFF = { react: false, me: false, spoiler: false, mention: false, store: false };

test("react and me tags become actions and leave the text clean", () => {
  const r = parseActions("nice one [react:steamhappy] [me:claps]", ALL_ON);
  assert.equal(r.plain, "nice one");
  assert.deepEqual(r.actions, [{ type: "react", name: "steamhappy" }, { type: "me", text: "claps" }]);
});

test("unknown emoticons are dropped when the owned list is known", () => {
  const r = parseActions("hi [react:madeup]", ALL_ON, { ownedEmoticons: new Set(["steamhappy"]) });
  assert.deepEqual(r.actions, []);
});

test("group mentions use the roster; unknown names fall back to @Name; DMs are plain", () => {
  const roster = new Map();
  rememberPerson(roster, "Bob", 42);
  const r = parseActions("hey [mention:Bob] and [mention:Zed]", ALL_ON);
  assert.equal(r.bbcode(roster, true), "hey [mention=42]@Bob[/mention] and @Zed");
  assert.equal(r.bbcode(roster, false), "hey @Bob and @Zed");
  assert.equal(r.plain, "hey @Bob and @Zed");
});

test("spoilers become their own /spoiler action and leave the text", () => {
  const r = parseActions("the answer is [spoiler:the butler did it]", ALL_ON);
  assert.deepEqual(r.actions, [{ type: "spoiler", text: "the butler did it" }]);
  assert.equal(r.plain, "the answer is");
  assert.equal(r.bbcode(null, true), "the answer is");
});

test("model-written brackets can never become BBCode", () => {
  const r = parseActions("click [url=https://evil.example]here[/url] [img]x[/img]", ALL_ON);
  assert.equal(r.bbcode(null, true), "click \\[url=https://evil.example]here\\[/url] \\[img]x\\[/img]");
});

test("disabled actions vanish but inline ones keep their text", () => {
  const r = parseActions("a [react:steamhappy][spoiler:b][mention:C][me:d][store:1]", OFF);
  assert.equal(r.plain, "a bC");
  assert.deepEqual(r.actions, []);
});

test("store tag becomes a /store action with the game name", () => {
  const r = parseActions("sure [store:BeamNG.drive]", ALL_ON);
  assert.deepEqual(r.actions, [{ type: "store", text: "BeamNG.drive" }]);
  assert.equal(r.plain, "sure");
});

test("actionsPrompt lists enabled actions and owned emoticons", () => {
  const p = actionsPrompt(ALL_ON, { ownedEmoticons: ["steamhappy"], isGroup: false });
  assert.match(p, /\[react:steamhappy\]/);
  assert.match(p, /:steamhappy:/);
  assert.doesNotMatch(p, /\[mention:/);
  assert.equal(actionsPrompt(OFF, {}), "");
});

test("garbled emoticons are repaired or removed; bare [name] becomes a reaction; Emoticons off strips them", () => {
  const owned = new Set(["steamhappy", "steammocking"]);
  assert.equal(parseActions("hi :steamhappy! ok", ALL_ON, { ownedEmoticons: owned }).plain, "hi :steamhappy:! ok");
  assert.equal(parseActions("hm :steamocking nya", ALL_ON, { ownedEmoticons: owned }).plain, "hm :steammocking: nya");
  assert.equal(parseActions("hm :steamnonsense: nya", ALL_ON, { ownedEmoticons: owned }).plain, "hm nya");
  assert.equal(parseActions("it is 5:30 at http://x.com", ALL_ON, { ownedEmoticons: owned }).plain, "it is 5:30 at http://x.com");
  const r = parseActions("[steamhappy] sounds fun", ALL_ON, { ownedEmoticons: owned });
  assert.deepEqual(r.actions, [{ type: "react", name: "steamhappy" }]);
  assert.equal(r.plain, "sounds fun");
  assert.equal(parseActions("yay :steamhappy: ok", ALL_ON, { ownedEmoticons: owned, emoticons: false }).plain, "yay ok");
});

test("tags written with a leading slash or a closing tag still work", () => {
  const r = parseActions("hello [/me:waves hello] [react:steamhappy][/react]", ALL_ON);
  assert.equal(r.plain, "hello");
  assert.deepEqual(r.actions, [{ type: "me", text: "waves hello" }, { type: "react", name: "steamhappy" }]);
});

test("only one emoticon and one reaction survive; invented links and mid-sentence slash commands are dropped", () => {
  const owned = new Set(["steamhappy", "steammocking"]);
  assert.equal(parseActions("a :steammocking: b :steamhappy: c :steammocking:", ALL_ON, { ownedEmoticons: owned }).plain, "a :steammocking: b c");
  assert.equal(parseActions("[react:steamhappy] [react:steammocking]", ALL_ON, { ownedEmoticons: owned }).actions.length, 1);
  assert.equal(parseActions("hi /me linkstore:app://99/nic see https://x.com/me ok", ALL_ON).plain, "hi see https://x.com/me ok");
  assert.equal(parseActions("/me waves", ALL_ON).plain, "/me waves"); // at the start it is a real command
});

test("mentions match names loosely", () => {
  const roster = new Map();
  rememberPerson(roster, "【HAKAI】", 7);
  rememberPerson(roster, "[AI BOT] Kisaragi", 8);
  assert.equal(parseActions("[mention:hakai]", ALL_ON).bbcode(roster, true), "[mention=7]@【HAKAI】[/mention]");
  assert.equal(parseActions("[mention:Kisaragi]", ALL_ON).bbcode(roster, true), "[mention=8]@\\[AI BOT] Kisaragi[/mention]");
  assert.equal(parseActions("[mention:Zed]", ALL_ON).bbcode(roster, true), "@Zed");
});

test("mentions show the real profile name (brackets escaped); storeLinkFor finds the first search hit", async () => {
  const { storeLinkFor } = require("../lib/steam-actions");
  const roster = new Map();
  rememberPerson(roster, "Hakai", 7, 60, "【HAKAI】");
  rememberPerson(roster, "Bot", 8, 60, "[AI BOT] Kisaragi");
  assert.equal(parseActions("[mention:hakai]", ALL_ON).bbcode(roster, true), "[mention=7]@【HAKAI】[/mention]");
  assert.equal(parseActions("[mention:bot]", ALL_ON).bbcode(roster, true), "[mention=8]@\\[AI BOT] Kisaragi[/mention]");
  const fake = async () => ({ json: async () => ({ items: [{ id: 284160, name: "BeamNG.drive" }] }) });
  assert.equal(await storeLinkFor("beamng", fake), "https://store.steampowered.com/app/284160");
  assert.equal(await storeLinkFor("nothing", async () => { throw new Error("offline"); }), "");
});
