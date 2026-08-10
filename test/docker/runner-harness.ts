import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createAuditLog } from "../../src/audit/audit-log.ts";
import { signedRequestHeaders } from "../../src/auth/source-auth-sign.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";
import { buildRunnerServer } from "../../src/runner/server.ts";
import type { RunnerBoxRecord } from "../../src/runner/store.ts";
import { spawnDockerExec } from "../../src/sandbox/docker-exec.ts";
import { createDockerLifecycle } from "../../src/sandbox/docker-lifecycle.ts";
import { createGuestAgent } from "../../src/sandbox/guest-agent-client.ts";
import { createRunnerSandbox } from "../../src/sandbox/runner-sandbox.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";

export const docker = spawnDockerExec("docker");
export const sandboxImage = "qm-sandbox-local:latest";

const SIGNING_SECRET = "runner-hardening-test-secret-that-is-long-enough";

export async function unavailableReason(): Promise<string | null> {
  if ((await docker(["version"], 15_000)).code !== 0) return "Docker daemon unavailable";
  if ((await docker(["image", "inspect", sandboxImage], 15_000)).code !== 0) return `${sandboxImage} unavailable`;
  return null;
}

export async function removeDockerResources(namePrefix: string): Promise<void> {
  const containers = await docker(["ps", "-aq", "--filter", `name=^/${namePrefix}-`], 15_000);
  for (const id of containers.stdout.trim().split("\n").filter(Boolean)) await docker(["rm", "-f", id], 15_000);
  const networks = await docker(["network", "ls", "--filter", `name=^${namePrefix}-`, "-q"], 15_000);
  for (const id of networks.stdout.trim().split("\n").filter(Boolean)) await docker(["network", "rm", id], 15_000);
  const volumes = await docker(["volume", "ls", "--filter", `name=^${namePrefix}-`, "-q"], 15_000);
  for (const id of volumes.stdout.trim().split("\n").filter(Boolean)) await docker(["volume", "rm", id], 15_000);
}

export interface RunnerHarness {
  sandbox: Sandbox;
  baseUrl: string;
  namePrefix: string;
  signingSecret: string;
}

export async function startRunner(t: TestContext, label: string): Promise<RunnerHarness> {
  const namePrefix = `${label}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const agent = createGuestAgent({ label: "runner-hardening" });
  const server = buildRunnerServer({
    lifecycle: createDockerLifecycle({
      label: "runner-hardening",
      namePrefix,
      image: sandboxImage,
      homeDir: "/root",
      buildHint: "run npm run sandbox:local:build",
      endpointMode: { kind: "published-port" },
      waitReady: (resolveEndpoint, name) => agent.waitReady(resolveEndpoint, name),
      dockerExec: docker,
      cpus: 0.5,
      memoryMb: 256,
      pidsLimit: 64,
      repoRoot: process.cwd(),
    }),
    agent,
    store: createMemoryMap<RunnerBoxRecord>(),
    signingSecret: SIGNING_SECRET,
    namePrefix,
    imageRef: sandboxImage,
    orgId: "runner-hardening-test",
    auditLog: createAuditLog(),
  });

  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeDockerResources(namePrefix);
  });

  const baseUrl = await listen(server);
  return {
    namePrefix,
    baseUrl,
    signingSecret: SIGNING_SECRET,
    sandbox: createRunnerSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), `${label}-`))), {
      baseUrl,
      signingSecret: SIGNING_SECRET,
      homeDir: "/root",
    }),
  };
}

export interface RawResponse {
  status: number;
  text: string;
}

export async function rawPost(harness: RunnerHarness, requestTarget: string, body: unknown): Promise<RawResponse> {
  const payload = JSON.stringify(body);
  const headers = signedRequestHeaders(harness.signingSecret, "POST", requestTarget, payload);
  const { port } = new URL(harness.baseUrl);
  const lines = [
    `POST ${requestTarget} HTTP/1.0`,
    "host: 127.0.0.1",
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(payload)}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "connection: close",
  ];
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(port) }, () =>
      socket.write(`${lines.join("\r\n")}\r\n\r\n${payload}`),
    );
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  const [head = "", text = ""] = raw.split("\r\n\r\n");
  return { status: Number(head.split(" ")[1]), text };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
