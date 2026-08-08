import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { needsHistoryImport } from "../src/harness/opencode-plugin.ts";

const source = readFileSync(new URL("../src/harness/opencode-plugin.ts", import.meta.url), "utf8");
const harnessSource = readFileSync(new URL("../src/harness/opencode-harness.ts", import.meta.url), "utf8");

test("OpenCode plugin discovers and registers bridged TypeBox tools", () => {
  assert.match(source, /requiredEnv\("OPENCODE_BRIDGE_URL"\)/);
  assert.match(source, /requiredEnv\("OPENCODE_BRIDGE_SECRET"\)/);
  assert.match(source, /HTTP loopback URL/);
  assert.match(source, /request<BridgeTool\[\] \| \{ tools: BridgeTool\[\] \}>\("definitions"\)/);
  assert.match(source, /args: argumentShape\(tool\.schema, definition\.parameters\)/);
  assert.match(source, /schema\.anyOf \?\? schema\.oneOf/);
  assert.match(source, /required\.has\(name\) \? value : value\.optional\(\)/);
  assert.match(source, /z\.record\(z\.string\(\), jsonSchemaToZod/);
});

test("OpenCode plugin forwards calls and honors bridge termination", () => {
  assert.match(source, /request<ToolResponse>\(`session\/\$\{encodeURIComponent\(context\.sessionID\)\}\/tool`, \{/);
  assert.match(source, /tool: definition\.name, sessionID: context\.sessionID, callID, args/);
  assert.match(source, /if \(result\.terminate\)/);
  assert.match(source, /client\.session\.abort\(\{ path: \{ id: context\.sessionID \} \}\)\.catch/);
  assert.match(source, /return result\.output/);
});

test("OpenCode plugin replaces core context without dropping the live user message", () => {
  assert.match(source, /Object\.assign\(output\.headers, context\.proxyHeaders \?\? \{\}\)/);
  assert.match(source, /output\.system\.splice\(0, output\.system\.length, context\.systemPrompt\)/);
  assert.match(source, /currentLastUser = output\.messages\.findLast/);
  assert.match(
    source,
    /output\.messages\.splice\(0, output\.messages\.length, \.\.\.\(history \?\? \[\]\), currentLastUser\)/,
  );
  assert.doesNotMatch(source, /"permission\.ask"/);
});

test("OpenCode plugin imports empty history only on the first model step", () => {
  const user = { info: { id: "user", role: "user", sessionID: "session" }, parts: [] };
  const assistant = { info: { id: "assistant", role: "assistant", sessionID: "session" }, parts: [] };
  assert.equal(needsHistoryImport([user], []), true);
  assert.equal(needsHistoryImport([user, assistant], []), false);
});

test("OpenCode plugin recognizes imported non-empty history", () => {
  const user = { info: { id: "user", role: "user", sessionID: "session" }, parts: [] };
  const prior = { info: { id: "prior", role: "assistant", sessionID: "session" }, parts: [] };
  const toolStep = { info: { id: "tool-step", role: "assistant", sessionID: "session" }, parts: [] };
  assert.equal(needsHistoryImport([user], [prior]), true);
  assert.equal(needsHistoryImport([prior, user], [prior]), false);
  assert.equal(needsHistoryImport([user, toolStep], [prior]), false);
});

test("OpenCode prompt disables bridged tools absent from this turn", () => {
  assert.match(harnessSource, /\.\.\.asTools\(definitionRef, \{ \.\.\.toolOptions\(opts\), surfaceTools: false \}\)/);
  assert.match(harnessSource, /Object\.fromEntries\(definitions\.map\(\(tool\) => \[tool\.name, false\]\)\)/);
  assert.match(harnessSource, /for \(const tool of tools\) enabled\[bridgeToolName\(tool\.name\)\] = true/);
});

const GUARD = /if \(turn\.cancel\?\.aborted\)/g;
const region = (from: string, to: string): string => {
  const start = harnessSource.indexOf(from);
  const end = harnessSource.indexOf(to);
  assert.ok(start >= 0, `landmark "${from}" is gone from opencode-harness.ts — this test needs relocating`);
  assert.ok(end > start, `landmark "${to}" is gone or moved above "${from}" — this test needs relocating`);
  return harnessSource.slice(start, end);
};

test("OpenCode observes cancellation before runtime startup", () => {
  const entry = region("const runPrompt =", "const single =");
  const guard = entry.search(GUARD);
  const startup = entry.indexOf("await ensureRuntime()");
  assert.ok(guard >= 0, "the turn entry point must check for cancellation");
  assert.ok(guard < startup, "an already-cancelled turn must not pay to start a runtime");
});

test("OpenCode observes cancellation before session creation and prompt dispatch", () => {
  const body = region("const runPromptWithRuntime =", "const runPrompt =");
  const guards = [...body.matchAll(GUARD)].map((match) => match.index ?? -1);
  const create = body.indexOf("rt.client.session.create({");
  const prompt = body.indexOf("rt.client.session.prompt({");
  assert.ok(create >= 0 && prompt >= 0, "this region must still create the session and dispatch the prompt");
  assert.ok(guards.length >= 3, `expected at least 3 cancellation guards, found ${guards.length}`);
  assert.ok(
    guards.some((index) => index < create),
    "a cancelled turn must not create a session",
  );
  assert.ok(
    guards.every((index) => index < prompt),
    "every guard must run before the prompt is dispatched",
  );
});
