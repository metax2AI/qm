import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setCustomProviders,
  resolveCustomModel,
  isCustomModelId,
  customModelCatalog,
  customProvidersVersion,
  isReservedCustomProviderId,
  validateCustomProviderSpec,
} from "../src/model/custom-providers.ts";
import { builtInModelCatalog } from "../src/model/model-catalog.ts";
import { createCustomProviderStore } from "../src/model/custom-provider-store.ts";
import { modelSupportedByHarness, modelServiceable, resolveModel } from "../src/model/pi-models.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { StoredCustomProvider } from "../src/model/custom-provider-store.ts";

afterEach(() => setCustomProviders([]));

const GATEWAY = {
  id: "acme-gateway",
  name: "Acme Gateway",
  protocol: "openai" as const,
  baseUrl: "https://llm.acme.internal/v1",
  models: [{ id: "acme-large", name: "Acme Large", contextWindow: 200_000, maxTokens: 16_000, input: 2, output: 8 }],
};

test("a registered custom model resolves with the provider's protocol and base URL", () => {
  setCustomProviders([GATEWAY]);
  const model = resolveCustomModel("acme-large");
  assert.ok(model);
  assert.equal(model.provider, "acme-gateway");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://llm.acme.internal/v1");
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.cost.input, 2);
});

test("anthropic-protocol providers produce anthropic-messages models with defaults", () => {
  setCustomProviders([
    {
      id: "eu-anthropic",
      name: "EU Anthropic-compatible",
      protocol: "anthropic",
      baseUrl: "https://eu.example.com",
      models: [{ id: "eu-claude" }],
    },
  ]);
  const model = resolveCustomModel("eu-claude");
  assert.ok(model);
  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.contextWindow, 128_000);
  assert.equal(model.cost.input, 0);
});

test("resolveModel falls back to custom models; built-ins shadow custom ids", () => {
  setCustomProviders([{ ...GATEWAY, models: [{ id: "acme-large" }, { id: "claude-opus-5", name: "impostor" }] }]);
  assert.equal(resolveModel("acme-large")?.provider, "acme-gateway");
  // The built-in claude-opus-5 must win over a custom model claiming its id.
  assert.equal(String(resolveModel("claude-opus-5")?.provider), "anthropic");
});

test("custom models are gated to pi and mock harnesses", () => {
  setCustomProviders([GATEWAY]);
  assert.equal(modelSupportedByHarness("acme-large", "pi"), true);
  assert.equal(modelSupportedByHarness("acme-large", "mock"), true);
  assert.equal(modelSupportedByHarness("acme-large", "claude"), false);
  assert.equal(modelSupportedByHarness("acme-large", "codex"), false);
  assert.equal(modelSupportedByHarness("acme-large", "opencode"), true);
});

test("a registered custom model is serviceable regardless of built-in key availability", () => {
  setCustomProviders([GATEWAY]);
  assert.equal(
    modelServiceable("acme-large", { anthropic: false, deepseek: false, openai: false, openrouter: false }),
    true,
  );
});

test("catalog lists custom models; clearing the registry removes them", () => {
  setCustomProviders([GATEWAY]);
  assert.deepEqual(customModelCatalog(), [{ id: "acme-large", name: "Acme Large", provider: "acme-gateway" }]);
  setCustomProviders([]);
  assert.equal(isCustomModelId("acme-large"), false);
  assert.equal(resolveModel("acme-large"), undefined);
});

test("identical registry refreshes do not invalidate derived caches", () => {
  setCustomProviders([GATEWAY]);
  const before = customProvidersVersion();
  setCustomProviders([GATEWAY]);
  assert.equal(customProvidersVersion(), before);
});

test("duplicate model ids across custom providers are rejected", () => {
  assert.throws(
    () =>
      setCustomProviders([
        GATEWAY,
        {
          id: "other-gateway",
          name: "Other Gateway",
          protocol: "openai",
          baseUrl: "https://other.example.com/v1",
          models: [{ id: "acme-large" }],
        },
      ]),
    /registered by both/,
  );
});

test("spec validation rejects reserved ids, bad slugs, bad URLs, and empty model lists", () => {
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, id: "openai" }), /reserved/);
  assert.equal(isReservedCustomProviderId("deepseek"), true);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, id: "deepseek" }), /reserved/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, id: "Not A Slug" }), /slug/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, baseUrl: "ftp://x" }), /http/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, baseUrl: "https://x?y=1" }), /query/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, models: [] }), /at least one model/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, models: [{ id: "a" }, { id: "a" }] }), /duplicate/);
});

test("store round-trip: upsert encrypts the key, statuses never leak it, delete disables", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({ backing, keyMaterial: "test-key-material" });

  await store.upsert(GATEWAY, "sk-secret-123", "admin@example.com");
  const statuses = await store.statuses();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.hasKey, true);
  assert.equal(JSON.stringify(statuses).includes("sk-secret-123"), false);

  const raw = await backing.get("acme-gateway");
  assert.ok(raw?.apiKeyEnc);
  assert.equal(raw!.apiKeyEnc!.includes("sk-secret-123"), false);

  assert.equal(await store.resolveKey("acme-gateway"), "sk-secret-123");
  assert.deepEqual(await store.enabled(), [GATEWAY]);

  // Upsert without a key keeps the existing one.
  await store.upsert({ ...GATEWAY, name: "Renamed" }, undefined, "admin@example.com");
  assert.equal(await store.resolveKey("acme-gateway"), "sk-secret-123");

  assert.equal(await store.delete("acme-gateway", "admin@example.com"), true);
  assert.equal(await store.resolveKey("acme-gateway"), null);
  assert.deepEqual(await store.enabled(), []);
  assert.equal((await store.statuses())[0]!.disabled, true);
  assert.equal(await store.delete("never-existed", "admin@example.com"), false);
});

test("store validates specs on upsert", async () => {
  const store = createCustomProviderStore({
    backing: createMemoryMap<StoredCustomProvider>(),
    keyMaterial: "k",
  });
  await assert.rejects(store.upsert({ ...GATEWAY, id: "anthropic" }, "k", "a@b.c"), /reserved/);
});

test("store rejects a model id already owned by another provider", async () => {
  const store = createCustomProviderStore({
    backing: createMemoryMap<StoredCustomProvider>(),
    keyMaterial: "k",
  });
  await store.upsert(GATEWAY, "first", "a@b.c");
  await assert.rejects(
    store.upsert(
      {
        id: "other-gateway",
        name: "Other Gateway",
        protocol: "openai",
        baseUrl: "https://other.example.com/v1",
        models: [{ id: "acme-large" }],
      },
      "second",
      "a@b.c",
    ),
    /already registered by provider "acme-gateway"/,
  );
});

test("concurrent stores cannot persist the same model id for different providers", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const advisoryLock = createMemoryAdvisoryLock();
  const first = createCustomProviderStore({ backing, keyMaterial: "k", advisoryLock });
  const second = createCustomProviderStore({ backing, keyMaterial: "k", advisoryLock });
  const results = await Promise.allSettled([
    first.upsert({ ...GATEWAY, id: "first-gateway" }, "first", "a@b.c"),
    second.upsert({ ...GATEWAY, id: "second-gateway" }, "second", "a@b.c"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await backing.all()).length, 1);
});

test("registered models surface in the catalog and vanish on unregister", () => {
  setCustomProviders([
    {
      id: "deepseek-gateway",
      name: "DeepSeek Gateway",
      protocol: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
    },
  ]);
  const catalog = builtInModelCatalog();
  const entry = catalog.find((m) => m.id === "deepseek-chat");
  assert.ok(entry, "custom model appears in the catalog");
  assert.equal(entry!.provider, "deepseek-gateway");
  setCustomProviders([]);
  assert.ok(!builtInModelCatalog().some((m) => m.id === "deepseek-chat"));
});

test("legacy custom providers cannot shadow a newly built-in provider", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  await backing.put("deepseek", {
    id: "deepseek",
    name: "Legacy DeepSeek",
    protocol: "openai",
    baseUrl: "https://legacy.example.com/v1",
    models: [{ id: "legacy-deepseek" }],
    apiKeyEnc: "legacy-ciphertext",
    updatedAt: 1,
    updatedBy: "legacy-admin",
  });
  const store = createCustomProviderStore({ backing, keyMaterial: "k" });
  assert.deepEqual(await store.enabled(), []);
  assert.equal(await store.resolveKey("deepseek"), null);
  assert.equal((await store.statuses())[0]!.disabled, true);
  const legacy = await backing.get("deepseek");
  assert.ok(legacy);
  setCustomProviders([legacy]);
  assert.equal(resolveModel("legacy-deepseek"), undefined);
});

test("opencode modelRef routes slashed custom model ids to the registered provider, not a phantom slash-prefix", async () => {
  const { modelRef } = await import("../src/harness/opencode-harness.ts");
  setCustomProviders([
    {
      id: "litellm",
      name: "LiteLLM",
      protocol: "openai",
      baseUrl: "https://litellm.example.com/v1",
      models: [{ id: "bedrock/claude-opus-5" }],
    },
  ]);
  try {
    assert.deepEqual(modelRef("bedrock/claude-opus-5"), { providerID: "litellm", modelID: "bedrock/claude-opus-5" });
    // built-in slash convention untouched
    assert.deepEqual(modelRef("openrouter/auto"), { providerID: "openrouter", modelID: "auto" });
  } finally {
    setCustomProviders([]);
  }
});

test("catalog cache invalidates immediately when the custom registry changes", async () => {
  const { selectableModelCatalog } = await import("../src/model/model-catalog.ts");
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  setCustomProviders([]);
  const before = await selectableModelCatalog(fetcher);
  assert.ok(!before.some((m) => m.id === "fresh-model"));
  setCustomProviders([
    {
      id: "freshco",
      name: "FreshCo",
      protocol: "openai",
      baseUrl: "https://fresh.example.com/v1",
      models: [{ id: "fresh-model" }],
    },
  ]);
  try {
    const after = await selectableModelCatalog(fetcher);
    assert.ok(
      after.some((m) => m.id === "fresh-model"),
      "new registration visible without waiting out the TTL",
    );
  } finally {
    setCustomProviders([]);
  }
  const cleared = await selectableModelCatalog(fetcher);
  assert.ok(!cleared.some((m) => m.id === "fresh-model"), "removal visible immediately too");
});
