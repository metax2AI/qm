import "./support/auto-fake-sprites.ts";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";

const CAP = "core-only-capability-secret-for-tests-01";
const PID = "portal-only-identity-secret-for-tests-01";

describe("deliverWebDelivery", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "deliver-web-")) }));
    server = createInsecureTestServer(built.app, {
      capabilitySecret: CAP,
      portalIdentitySecret: PID,
      scheduler: built.scheduler,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const deliver = (id: string) => fetch(`${base}/v1/deliveries/${encodeURIComponent(id)}/deliver`, { method: "POST" });

  const enqueueWeb = async (
    key: string,
    text: string,
    destination: { target: string; audienceScopeId?: string },
  ): Promise<string> => {
    await built.app.enqueueDelivery({
      destination: { type: "web", ...destination },
      text,
      idempotencyKey: key,
    });
    const res = await fetch(`${base}/v1/deliveries?type=web`);
    assert.equal(res.status, 200);
    const rows =
      ((await res.json()) as { deliveries?: Array<{ id: string; idempotencyKey: string }> }).deliveries ?? [];
    const found = rows.find((r) => r.idempotencyKey === key);
    assert.ok(found, `delivery ${key} is pending`);
    return found.id;
  };

  const enqueueGroup = async (key: string, text: string): Promise<string> => {
    await built.app.enqueueDelivery({
      destination: { type: "group", target: "C1:171.001" },
      text,
      idempotencyKey: key,
    });
    const res = await fetch(`${base}/v1/deliveries?type=group`);
    assert.equal(res.status, 200);
    const rows =
      ((await res.json()) as { deliveries?: Array<{ id: string; idempotencyKey: string }> }).deliveries ?? [];
    const found = rows.find((r) => r.idempotencyKey === key);
    assert.ok(found, `delivery ${key} is pending`);
    return found.id;
  };

  const sessionByThread = async (threadRef: string): Promise<string | null> => {
    const res = await fetch(`${base}/v1/sessions?principalId=U1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions?: Array<{ id: string; threadRef: string }> };
    return body.sessions?.find((s) => s.threadRef === threadRef)?.id ?? null;
  };

  const sessionTexts = async (id: string): Promise<string[]> => {
    const res = await fetch(`${base}/v1/sessions/${encodeURIComponent(id)}?viewer=U1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries?: Array<{ type: string; payload: { text?: string } }> };
    return (body.entries ?? []).filter((e) => e.type === "assistant").map((e) => e.payload.text ?? "");
  };

  it("writes a web delivery into the target session, adds the owner as participant, and acks it", async () => {
    const d = await enqueueWeb("post:deliver-test:one", "hello delivered", {
      target: "web:U1:thread-x",
      audienceScopeId: "personal:U1",
    });
    const res = await deliver(d);
    assert.equal(res.status, 200);

    const sessionId = await sessionByThread("web:U1:thread-x");
    assert.ok(sessionId, "delivery created the target session");
    assert.ok((await sessionTexts(sessionId)).includes("hello delivered"));

    const pending = await fetch(`${base}/v1/deliveries?type=web`);
    assert.equal(pending.status, 200);
    const pendingIds = ((await pending.json()) as { deliveries?: { id: string }[] }).deliveries ?? [];
    assert.ok(!pendingIds.some((p) => p.id === d), "a delivered web delivery is no longer pending");
  });

  it("rejects a repeat deliver with 409 and does not append twice", async () => {
    const d = await enqueueWeb("post:deliver-test:repeat", "only once", {
      target: "web:U1:thread-repeat",
      audienceScopeId: "personal:U1",
    });
    assert.equal((await deliver(d)).status, 200);
    assert.equal((await deliver(d)).status, 409);

    const sessionId = await sessionByThread("web:U1:thread-repeat");
    assert.ok(sessionId);
    assert.deepEqual(
      (await sessionTexts(sessionId)).filter((t) => t === "only once"),
      ["only once"],
    );
  });

  it("refuses a non-web delivery with 404", async () => {
    const d = await enqueueGroup("post:deliver-test:group", "not web");
    assert.equal((await deliver(d)).status, 404);
  });

  it("refuses a web delivery with a non-web thread target with 400", async () => {
    const d = await enqueueWeb("post:deliver-test:badtarget", "bad target", {
      target: "slack:C1:171.001",
    });
    assert.equal((await deliver(d)).status, 400);
  });
});
