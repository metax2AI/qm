import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildRunnerServer } from "../src/runner/server.ts";
import { createRunnerStore, type RunnerBoxRecord } from "../src/runner/store.ts";
import { createRunnerSandbox } from "../src/sandbox/runner-sandbox.ts";
import { createDockerLifecycle, type DockerLifecycle } from "../src/sandbox/docker-lifecycle.ts";
import { reconcileRunnerBoxes } from "../src/runner/recovery.ts";
import { createGuestAgent } from "../src/sandbox/guest-agent-client.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { installFakeDocker, type FakeDocker } from "./support/fake-docker.ts";
import { sleep } from "../src/util/async.ts";
import { scopeId } from "../src/types.ts";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { createAuditLog, type AuditLog } from "../src/audit/audit-log.ts";

const SECRET = "runner-test-secret-that-is-long-enough";
const tmp = mkdtempSync(join(tmpdir(), "runner-svc-"));
const guestHome = join(tmp, "home");
let daemon: ChildProcess;
let daemonPort = 0;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

before(async () => {
  daemonPort = await freePort();
  daemon = spawn(process.execPath, [join(process.cwd(), "aws/microvm-agent/agent.mjs")], {
    env: { ...process.env, AGENT_PORT: String(daemonPort), HOME: guestHome },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/health`);
      if (res.status === 200) return;
    } catch {
      if (Date.now() > deadline) throw new Error("test daemon never became reachable");
    }
    await sleep(100);
  }
});

after(() => {
  daemon?.kill("SIGKILL");
});

interface Harness {
  fake: FakeDocker;
  store: DurableMap<RunnerBoxRecord>;
  auditLog: AuditLog;
  lifecycle: DockerLifecycle;
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

async function startRunner(maxExecTimeoutSec?: number): Promise<Harness> {
  const fake = installFakeDocker(daemonPort);
  const store = createRunnerStore();
  const auditLog = createAuditLog();
  const agent = createGuestAgent({ label: "runner" });
  const lifecycle = createDockerLifecycle({
    label: "runner",
    namePrefix: "qmr",
    image: "qm-sandbox-local:latest",
    homeDir: guestHome,
    buildHint: "publish the rootfs",
    endpointMode: { kind: "published-port" },
    waitReady: (resolveEndpoint, name) => agent.waitReady(resolveEndpoint, name),
    dockerExec: fake.dockerExec,
    repoRoot: tmp,
  });
  const server = buildRunnerServer({
    lifecycle,
    agent,
    store,
    signingSecret: SECRET,
    namePrefix: "qmr",
    imageRef: "qm-sandbox-local:latest",
    orgId: "test-org",
    auditLog,
    ...(maxExecTimeoutSec ? { maxExecTimeoutSec } : {}),
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  return {
    fake,
    store,
    auditLog,
    lifecycle,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

function clientFor(h: Harness, secret = SECRET, egressProxyUrl?: string, residentEnv?: Record<string, string>) {
  return createRunnerSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "runner-ws-"))), {
    baseUrl: h.baseUrl,
    signingSecret: secret,
    homeDir: guestHome,
    ...(egressProxyUrl ? { egressProxyUrl } : {}),
    ...(residentEnv ? { residentEnv } : {}),
  });
}

const rw = (scope: string) => [{ scopeId: scope, mountPath: "", mode: "rw" as const }];

test("the runner client refuses a weak signing secret before sending traffic", () => {
  assert.throws(
    () =>
      createRunnerSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "runner-ws-"))), {
        baseUrl: "http://runner.invalid",
        signingSecret: "weak",
      }),
    /SANDBOX_RUNNER_SECRET must be at least 32 characters/,
  );
});

test("a full turn round-trips over the runner API: provision, exec, write, read, teardown", async () => {
  const h = await startRunner();
  try {
    const sb = clientFor(h);
    const scope = scopeId("personal", "R1");
    const handle = await sb.provision(rw(scope));
    assert.equal(handle.id.startsWith("qmr-sbx-"), true);
    assert.equal(handle.coldStart, true);

    const r = await sb.run(handle, "echo hello-runner");
    assert.equal(r.stdout.trim(), "hello-runner");
    assert.equal(r.code, 0);

    await sb.writeFile(handle, "note.txt", "written through the runner");
    assert.equal(await sb.readFile(handle, "note.txt"), "written through the runner");
    assert.equal(await sb.readFile(handle, "absent.txt"), null);

    const record = await h.store.get(handle.id);
    assert.equal(record?.scopeId, scope);
    assert.equal(record?.orgId, "test-org");
    assert.equal(record?.networkName, "qmr-net-" + handle.id.slice("qmr-sbx-".length));
    assert.ok(record!.lastActivityMs >= record!.createdAtMs);

    await sb.teardown(handle, { destroy: true });
    assert.equal(await h.store.get(handle.id), null);
    assert.equal(h.fake.containers.has(handle.id), false);
  } finally {
    await h.close();
  }
});

test("the runner restarts a parked container on the next exec, so core never has to ask", async () => {
  const h = await startRunner();
  try {
    const sb = clientFor(h);
    const handle = await sb.provision(rw(scopeId("personal", "R2")));
    h.fake.containers.get(handle.id)!.running = false;

    const r = await sb.run(handle, "echo revived");
    assert.equal(r.stdout.trim(), "revived");
    assert.equal(h.fake.containers.get(handle.id)!.running, true);
  } finally {
    await h.close();
  }
});

test("parking a sandbox survives the recovery sweep instead of being resurrected as an abnormal exit", async () => {
  const h = await startRunner();
  try {
    const sb = clientFor(h);
    const handle = await sb.provision(rw(scopeId("personal", "R6")));
    const lifecycle = h.lifecycle;

    await sb.teardown(handle);
    assert.equal(h.fake.containers.get(handle.id)?.running, false, "the park path stops the container");
    assert.notEqual(h.fake.containers.get(handle.id)?.exitCode, 0, "a SIGTERMed daemon never exits zero");
    assert.equal((await h.store.get(handle.id))?.parked, true);

    const runsBefore = h.fake.runCount;
    assert.equal(await reconcileRunnerBoxes({ store: h.store, lifecycle, auditLog: h.auditLog }), 0);
    assert.equal(h.fake.containers.get(handle.id)?.running, false, "the sweep leaves a parked sandbox parked");
    assert.equal(h.fake.runCount, runsBefore, "and does not rebuild it");
    assert.deepEqual(await h.auditLog.events(), []);

    const r = await sb.run(handle, "echo woken");
    assert.equal(r.stdout.trim(), "woken");
    assert.equal((await h.store.get(handle.id))?.parked, false, "activity clears the parked flag");
  } finally {
    await h.close();
  }
});

test("process sessions work over the runner transport", async () => {
  const h = await startRunner();
  try {
    const sb = clientFor(h);
    const handle = await sb.provision(rw(scopeId("personal", "R3")));
    const { processId } = await sb.startProcess!(handle, "echo streamed; sleep 0.2");
    let cursor = 0;
    let out = "";
    for (let i = 0; i < 20 && !out.includes("streamed"); i++) {
      const chunk = await sb.readProcess!(handle, processId, { sinceCursor: cursor, waitMs: 500 });
      cursor = chunk.cursor;
      out += chunk.chunks;
      if (chunk.status.state === "exited") break;
    }
    assert.match(out, /streamed/);
    const sessions = await sb.listProcesses!(handle);
    assert.equal(
      sessions.some((s) => s.processId === processId),
      true,
    );
  } finally {
    await h.close();
  }
});

test("the runner forces proxy variables from the turn token and drops caller-provided proxy variables", async () => {
  const h = await startRunner();
  try {
    const sb = clientFor(h, SECRET, "http://qm-org-egress:48080", {
      TZ: "Asia/Shanghai",
      HTTP_PROXY: "http://resident-proxy.invalid:1",
    });
    const handle = await sb.provision(rw(scopeId("personal", "R4")), {
      egressToken: "signed-egress-token",
      env: { HTTPS_PROXY: "http://attacker.invalid:1", FOO: "kept" },
    });
    assert.equal(sb.profile.egressEnforcement, "domain");
    assert.equal(handle.env?.FOO, "kept");
    assert.equal(handle.env?.TZ, "Asia/Shanghai");
    assert.equal(handle.env?.HTTPS_PROXY, "http://x:signed-egress-token@qm-org-egress:48080");
    assert.equal(handle.env?.HTTP_PROXY, handle.env?.HTTPS_PROXY);
    assert.equal(handle.env?.NO_PROXY, "localhost,127.0.0.1,::1");
  } finally {
    await h.close();
  }
});

test("the runner caps a caller-requested execution timeout", async () => {
  const h = await startRunner(1);
  try {
    const sb = clientFor(h);
    const handle = await sb.provision(rw(scopeId("personal", "R5")));
    const started = Date.now();
    const result = await sb.run(handle, "sleep 5", { timeoutMs: 30_000 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 4_000);
    assert.equal(h.fake.runCount, 2);
    assert.equal(h.fake.volumes.size, 1);
    assert.deepEqual(
      (await h.auditLog.events()).map(({ action, status }) => ({ action, status })),
      [{ action: "sandbox.recycled", status: "timeout" }],
    );
  } finally {
    await h.close();
  }
});

test("unsigned, wrongly-signed, and replayed requests are all refused", async () => {
  const h = await startRunner();
  try {
    const path = "/v1/sandboxes/ensure";
    const body = JSON.stringify({ scopeId: "personal:R4" });

    const unsigned = await fetch(`${h.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(unsigned.status, 401);

    const wrong = await fetch(`${h.baseUrl}${path}`, {
      method: "POST",
      headers: signedRequestHeaders("a-different-secret-of-adequate-length", "POST", path, body, {
        "content-type": "application/json",
      }),
      body,
    });
    assert.equal(wrong.status, 401);

    const headers = signedRequestHeaders(SECRET, "POST", path, body, { "content-type": "application/json" });
    const first = await fetch(`${h.baseUrl}${path}`, { method: "POST", headers, body });
    assert.equal(first.status, 200);
    const replayed = await fetch(`${h.baseUrl}${path}`, { method: "POST", headers, body });
    assert.equal(replayed.status, 401);
  } finally {
    await h.close();
  }
});

test("a sandbox id outside the runner's own namespace is refused before it reaches docker", async () => {
  const h = await startRunner();
  try {
    for (const id of ["--privileged", "qm-sbx-someone-elses-box", "../escape", "qmr"]) {
      const path = `/v1/sandboxes/${encodeURIComponent(id)}/exec`;
      const body = JSON.stringify({ cmd: "echo pwned", timeoutSec: 5 });
      const res = await fetch(`${h.baseUrl}${path}`, {
        method: "POST",
        headers: signedRequestHeaders(SECRET, "POST", path, body, { "content-type": "application/json" }),
        body,
      });
      assert.equal(res.status, 400, `${id} must be refused`);
    }
    assert.equal(h.fake.runCount, 0);
  } finally {
    await h.close();
  }
});

test("health needs no signature so the container probe can reach it", async () => {
  const h = await startRunner();
  try {
    const res = await fetch(`${h.baseUrl}/health`);
    assert.equal(res.status, 200);
  } finally {
    await h.close();
  }
});
