import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { countTokens } from "../src/util/tokens.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";

function countTempDirs(prefix: string): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).length;
}

function recordingTurn(
  systemPrompt: string,
  recorded: Array<{ model: string; inputTokens: number; entryCount: number }>,
  sessionId: string,
): HarnessTurnInput {
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    input: "hi",
    systemPrompt,
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "scope" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry) => ({ ...entry, seq: 1 }) as Awaited<ReturnType<HarnessTurnInput["emit"]>>,
    recordModelCall: (rec) => recorded.push(rec),
  };
}

async function runIgnoringPromptError(
  harness: ReturnType<typeof createPiHarness>,
  turn: HarnessTurnInput,
): Promise<void> {
  try {
    await harness.turns.runTurn(turn);
  } catch {
    return;
  }
}

test("every turn composes the freshly resolved system prompt", async () => {
  const harness = createPiHarness();
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];
  const first = "BASE\n\n## What you remember\nA";
  const second = "BASE\n\n## What you remember\nBBBBBBBBBBBBBBBBBBBB";

  await runIgnoringPromptError(harness, recordingTurn(first, recorded, "fresh-prompt"));
  await runIgnoringPromptError(harness, recordingTurn(second, recorded, "fresh-prompt"));

  assert.equal(recorded[0]!.inputTokens, countTokens(first) + countTokens("hi"));
  assert.equal(recorded[1]!.inputTokens, countTokens(second) + countTokens("hi"));
});

test("each turn removes its isolated resource directories", async () => {
  const prefix = `pi-turn-${process.pid}`;
  const harness = createPiHarness({ tempDirPrefix: prefix });
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];

  await runIgnoringPromptError(harness, recordingTurn("BASE", recorded, "cleanup"));

  assert.equal(countTempDirs(`${prefix}-cwd-`), 0);
  assert.equal(countTempDirs(`${prefix}-agent-`), 0);
});

test("the Pi harness exposes no session-reset hook after removing session state", () => {
  assert.equal(createPiHarness().turns.resetSession, undefined);
});

test("ack emoji keeps working on a non-Anthropic base model when an Anthropic key is present", async () => {
  const harness = createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({ anthropic: "sk-ant-test" }),
  });
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; model: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), model: JSON.parse(String(init?.body ?? "{}")).model });
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"emoji":"eyes"}' }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const picked = await harness.models.pickAckEmoji?.("ship it", ["eyes", "rocket"]);
    assert.equal(picked, "eyes", "the pick still lands even though the base model is OpenAI");
    assert.equal(calls.length, 1, "the Anthropic ack call was actually attempted");
    assert.match(calls[0]!.url, /anthropic/, "it went to the Anthropic API");
    assert.equal(calls[0]!.model, "claude-haiku-4-5", "it used the Anthropic auxiliary, not the OpenAI judge model");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ack emoji stays home when the deployment has no Anthropic key at all", async () => {
  const harness = createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({ openai: "sk-openai-test" }),
  });
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    assert.equal(await harness.models.pickAckEmoji?.("ship it", ["eyes"]), undefined);
    assert.equal(called, 0, "no Anthropic call without an Anthropic key");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("model utilities resolve provider credentials for every call", async () => {
  let resolutions = 0;
  const harness = createPiHarness({
    resolveProviderKeys: async () => {
      resolutions += 1;
      return {};
    },
  });

  assert.equal(await harness.models.oneShot?.("system", "first"), undefined);
  assert.equal(await harness.models.oneShot?.("system", "second"), undefined);
  assert.equal(resolutions, 2);
});

test("text-only DeepSeek turns keep image files available without sending unsupported inline image bytes", async () => {
  const harness = createPiHarness({
    defaultModelId: "deepseek-v4-flash",
    deepseekApiKey: "sk-deepseek-test",
  });
  const realFetch = globalThis.fetch;
  const requests: Array<{ url: string; authorization: string; body: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body: String(init?.body ?? ""),
    });
    const chunks = [
      {
        id: "chatcmpl-deepseek-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-flash",
        choices: [{ index: 0, delta: { role: "assistant", content: "handled" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-deepseek-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-flash",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
    ];
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof globalThis.fetch;
  try {
    const turn = recordingTurn("BASE", [], "deepseek-image");
    turn.environment = "Attached files are available at /workspace/inbox/chart.png";
    turn.attachments = [{ name: "chart.png", mimetype: "image/png", sizeBytes: 18, direction: "in" }];
    turn.images = [{ mimeType: "image/png", dataBase64: "SECRET_IMAGE_BYTES", artifactId: "artifact-1" }];
    assert.equal((await harness.turns.runTurn(turn)).reply, "handled");
    assert.equal(requests.length, 1);
    for (const request of requests) {
      assert.equal(request.url, "https://api.deepseek.com/chat/completions");
      assert.equal(request.authorization, "Bearer sk-deepseek-test");
      assert.doesNotMatch(request.body, /SECRET_IMAGE_BYTES/);
      const payload = JSON.parse(request.body) as { messages: Array<{ role: string; content: unknown }> };
      const user = payload.messages.findLast((message) => message.role === "user");
      assert.equal(typeof user?.content, "string");
      assert.match(String(user?.content), /image omitted/i);
      assert.match(String(user?.content), /\/workspace\/inbox\/chart\.png/);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("DeepSeek tool calls replay non-null assistant content without tool_choice", async () => {
  const harness = createPiHarness({
    defaultModelId: "deepseek-v4-flash",
    deepseekApiKey: "sk-deepseek-test",
  });
  const realFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(payload);
    const first = requests.length === 1;
    const chunks = first
      ? [
          {
            id: "chatcmpl-deepseek-tool",
            object: "chat.completion.chunk",
            created: 1,
            model: "deepseek-v4-flash",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  reasoning_content: "I need to read the file.",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-read-1",
                      type: "function",
                      function: { name: "read", arguments: '{"path":"notes.txt"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-deepseek-tool",
            object: "chat.completion.chunk",
            created: 1,
            model: "deepseek-v4-flash",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          },
        ]
      : [
          {
            id: "chatcmpl-deepseek-final",
            object: "chat.completion.chunk",
            created: 1,
            model: "deepseek-v4-flash",
            choices: [{ index: 0, delta: { role: "assistant", content: "finished" }, finish_reason: null }],
          },
          {
            id: "chatcmpl-deepseek-final",
            object: "chat.completion.chunk",
            created: 1,
            model: "deepseek-v4-flash",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
          },
        ];
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof globalThis.fetch;
  try {
    const turn = recordingTurn("BASE", [], "deepseek-tool-loop");
    turn.tools = {
      read: async () => ({ content: "release ready", sourceScopeId: turn.scopeLabel }),
    } as unknown as HarnessTurnInput["tools"];
    assert.equal((await harness.turns.runTurn(turn)).reply, "finished");
    assert.equal(requests.length, 2);
    const replay = requests[1]!;
    assert.equal("tool_choice" in replay, false);
    const assistant = (replay.messages as Array<Record<string, unknown>>).find(
      (message) => message.role === "assistant" && Array.isArray(message.tool_calls),
    );
    assert.ok(assistant);
    assert.equal(assistant.content, "");
    assert.equal(assistant.reasoning_content, "I need to read the file.");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("prior-turn bootstrap is taped as a retry-idempotent import before the first prompt", async () => {
  const harness = createPiHarness();
  const records: Array<{ kind: string; payload: unknown }> = [];
  const turn = recordingTurn("BASE", [], "prior-bootstrap");
  turn.priorTurns = [
    { role: "assistant", text: "I opened this thread with the release result" },
    { role: "user", name: "Jordan", text: "tell me more" },
  ];
  turn.tape = async (record) => {
    records.push({ kind: record.kind, payload: record.payload });
  };
  await runIgnoringPromptError(harness, turn);
  const bootstrap = records.filter((record) => record.kind === "context_event");
  assert.equal(bootstrap.length, 1);
  assert.equal((bootstrap[0]!.payload as { event?: string }).event, "legacy_import");
  assert.match(JSON.stringify(bootstrap[0]), /release result/);
  assert.match(JSON.stringify(bootstrap[0]), /tell me more/);
});
