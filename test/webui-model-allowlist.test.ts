import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

test("the org allowed-models list restricts the runtime-config picker and clearing restores the catalog", async () => {
  const modelCredentialFetch: typeof fetch = async () =>
    Response.json({
      data: [
        { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", supported_parameters: ["tools"] },
        { id: "deepseek/deepseek-chat-v3.1", name: "DeepSeek: DeepSeek V3.1", supported_parameters: ["tools"] },
      ],
    });
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "webui-model-allowlist-")),
      openrouterApiKey: "deployment-openrouter-key",
    }),
    { modelCredentialFetch },
  );
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    modelCredentialFetch,
    harnessId: "pi",
    providerKeys: { anthropic: false, deepseek: false, openai: false, openrouter: true },
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const runtimeModels = async (): Promise<string[]> => {
    const response = await fetch(`${base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(response.status, 200);
    return ((await response.json()) as { modelsByHarness: Record<string, string[]> }).modelsByHarness.pi!;
  };
  try {
    const unrestricted = await runtimeModels();
    assert.ok(unrestricted.includes("anthropic/claude-sonnet-4.5"));
    assert.ok(unrestricted.includes("deepseek/deepseek-chat-v3.1"));

    const saved = await fetch(`${base}/v1/admin/scopes/org%3Adefault-org/webui-models`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ids: ["deepseek/deepseek-chat-v3.1", "openrouter/auto"] }),
    });
    assert.equal(saved.status, 200);

    assert.deepEqual(await runtimeModels(), ["deepseek/deepseek-chat-v3.1", "openrouter/auto"]);

    const cleared = await fetch(`${base}/v1/admin/scopes/org%3Adefault-org/webui-models`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal(cleared.status, 200);
    const restored = await runtimeModels();
    assert.ok(restored.includes("anthropic/claude-sonnet-4.5"));
    assert.ok(restored.includes("deepseek/deepseek-chat-v3.1"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an unconfigured Web allowlist accepts every model advertised by the default picker", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webui-custom-default-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    harnessId: "pi",
    providerKeys: { anthropic: true, deepseek: false, openai: false, openrouter: false },
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const registered = await fetch(`${base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        name: "Acme Gateway",
        protocol: "openai",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "custom-key",
        validate: false,
        models: [{ id: "acme-large" }],
      }),
    });
    assert.equal(registered.status, 200);
    const surface = await fetch(`${base}/v1/surface-config`);
    assert.ok(((await surface.json()) as { webuiModels: string[] }).webuiModels.includes("acme-large"));
    const turn = await fetch(`${base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "web",
        actor: { externalId: "alice" },
        conversation: { kind: "dm", threadRef: "web:alice:custom-model" },
        text: "hello",
        model: "acme-large",
      }),
    });
    assert.equal(turn.status, 200);
    assert.notEqual(((await turn.json()) as { reasonCode?: string }).reasonCode, "model_not_enabled");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
