"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mergePersona, buildPersonaPrompt, parsePersonaOutput, sectionBody } = require("../lib/persona");

const FILE = `# header comment

[SYSTEM PROMPT]
old system

[PERSONALITY]
old personality

[MASTERS]
# one id per line
76561190000000001

[MASTER BEHAVIOR]
obey
`;

test("mergePersona replaces only the persona sections", () => {
  const out = mergePersona(FILE, { systemPrompt: "new system\nline two", personality: "new personality" });
  assert.equal(sectionBody(out, "SYSTEM PROMPT"), "new system\nline two");
  assert.equal(sectionBody(out, "PERSONALITY"), "new personality");
  assert.equal(sectionBody(out, "MASTERS"), "76561190000000001");
  assert.equal(sectionBody(out, "MASTER BEHAVIOR"), "obey");
  assert.match(out, /^# header comment/);
  assert.match(out, /# one id per line/);
});

test("mergePersona leaves a section alone when the new body is empty", () => {
  assert.equal(sectionBody(mergePersona(FILE, { systemPrompt: "x", personality: "" }), "PERSONALITY"), "old personality");
});

test("parsePersonaOutput copes with fences and thinking blocks, and rejects junk", () => {
  const raw = "<think>hmm</think>```\n[SYSTEM PROMPT]\nYou are Z.\n[PERSONALITY]\nDry.\n```";
  assert.deepEqual(parsePersonaOutput(raw), { systemPrompt: "You are Z.", personality: "Dry." });
  assert.equal(parsePersonaOutput("sure! here you go"), null);
});

test("buildPersonaPrompt switches between generate and enhance", () => {
  assert.match(buildPersonaPrompt({ description: "a pirate" }), /from this idea: a pirate/);
  const p = buildPersonaPrompt({ mode: "enhance", description: "funnier", current: { systemPrompt: "SYS", personality: "PER" } });
  assert.match(p, /Improve the existing character/);
  assert.match(p, /SYS/);
});
