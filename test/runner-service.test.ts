import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildRunnerServer } from "../src/runner/server.ts";
import { RUNNER_HOLD_LEASE_MS, createRunnerStore, type RunnerBoxRecord } from "../src/runner/store.ts";
import { createRunnerSandbox } from "../src/sandbox/runner-sandbox.ts";
import { createDockerLifecycle, type DockerLifecycle } from "../src/sandbox/docker-lifecycle.ts";
import { reconcileRunnerBoxes, type RunnerBoxQueue } from "../src/runner/recovery.ts";
import { createGuestAgent } from "../src/sandbox/guest-agent-client.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { installFakeDocker, type FakeDocker } from "./support/fake-docker.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { createKeyedQueue, sleep } from "../src/util/async.ts";
import { scopeId } from "../src/types.ts";
import type { SandboxHandle } from "../src/sandbox/sandbox.ts";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { createAuditLog, type AuditLog } from "../src/audit/audit-log.ts";
import { createSourceAuth, type SourceAuth } from "../src/auth/source-auth.ts";

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
  boxQueue: RunnerBoxQueue;
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

async function startRunner(
  maxExecTimeoutSec?: number,
  watchDocker?: (args: string[]) => Promise<void>,
  existing?: Pick<Harness, "fake" | "store" | "auditLog">,
  auth?: SourceAuth,
  now?: () => number,
): Promise<Harness> {
  const fake = existing?.fake ?? installFakeDocker(daemonPort);
  const store = existing?.store ?? createRunnerStore();
  const auditLog = existing?.auditLog ?? createAuditLog();
  const agent = createGuestAgent({ label: "runner" });
  const dockerExec: DockerExec = async (args, timeoutMs) => {
    await watchDocker?.(args);
    return fake.dockerExec(args, timeoutMs);
  };
  const lifecycle = createDockerLifecycle({
    label: "runner",
    namePrefix: "qmr",
    image: "qm-sandbox-local:latest",
    homeDir: guestHome,
    buildHint: "publish the rootfs",
    endpointMode: { kind: "published-port" },
    waitReady: (resolveEndpoint, name) => agent.waitReady(resolveEndpoint, name),
    dockerExec,
    trackHolds: false,
    repoRoot: tmp,
  });
  const boxQueue = createKeyedQueue<string>();
  const server = buildRunnerServer({
    lifecycle,
    agent,
    store,
    signingSecret: SECRET,
    namePrefix: "qmr",
    imageRef: "qm-sandbox-local:latest",
    orgId: "test-org",
    auditLog,
    boxQueue,
    ...(auth ? { auth } : {}),
    ...(now ? { now } : {}),
    ...(maxExecTimeoutSec ? { maxExecTimeoutSec } : {}),
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  return {
    fake,
    store,
    auditLog,
    lifecycle,
    boxQueue,
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

test("an expired acquisition cannot renew itself with late I/O", async () => {
  let at = Date.now();
  const h = await startRunner(
    undefined,
    undefined,
    undefined,
    createSourceAuth({ signingSecret: SECRET, now: () => at, replayWindowMs: RUNNER_HOLD_LEASE_MS * 2 + 60_000 }),
    () => at,
  );
  try {
    const sb = clientFor(h);
    const handle = await sb.provision(rw(scopeId("personal", "R-expired")));
    at += RUNNER_HOLD_LEASE_MS + 1;
    await assert.rejects(sb.run(handle, "echo too-late"), /400.*expired acquisitionId/);
  } finally {
    await h.close();
  }
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
    assert.equal(Object.keys(record?.holds ?? {}).length, 1);
    assert.ok(record!.lastActivityMs >= record!.createdAtMs);

    await sb.teardown(handle, { destroy: true });
    assert.equal(await h.store.get(handle.id), null);
    assert.equal(h.fake.containers.has(handle.id), false);
  } finally {
    await h.close();
  }
});

test("retrying an ensure with the same acquisition ID does not add another hold", async () => {
  const h = await startRunner();
  try {
    const acquisitionId = "00000000-0000-4000-8000-000000000010";
    const body = JSON.stringify({ scopeId: scopeId("personal", "R-retry"), acquisitionId });
    let id = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const path = `/v1/sandboxes/ensure?n=${randomUUID()}`;
      const res = await fetch(`${h.baseUrl}${path}`, {
        method: "POST",
        headers: signedRequestHeaders(SECRET, "POST", path, body, { "content-type": "application/json" }),
        body,
      });
      assert.equal(res.status, 200);
      id = ((await res.json()) as { id: string }).id;
    }
    assert.equal(Object.keys((await h.store.get(id))?.holds ?? {}).length, 1);
  } finally {
    await h.close();
  }
});

test("a workspace-relative path cannot climb out of the workspace", async () => {
  const h = await startRunner();
  try {
    const sb = clientFor(h);
    const handle = await sb.provision(rw(scopeId("personal", "R-traversal")));
    for (const rel of ["../escaped.txt", "..", "nested/../../escaped.txt", "../../../etc/passwd"]) {
      await assert.rejects(sb.writeFile(handle, rel, "escaped"), /path must stay under/, `write ${rel}`);
      await assert.rejects(sb.readFile(handle, rel), /path must stay under/, `read ${rel}`);
      await assert.rejects(sb.removeDir(handle, rel), /path must stay under/, `removeDir ${rel}`);
      await assert.rejects(sb.listDir(handle, rel), /path must stay under/, `listDir ${rel}`);
      await assert.rejects(
        sb.extractFiles!(handle, [{ path: rel, data: Buffer.from("escaped") }]),
        /path must stay under/,
        `extractFiles ${rel}`,
      );
    }
    assert.equal(existsSync(join(guestHome, "escaped.txt")), false);
    assert.equal(await sb.readFile(handle, "/etc/passwd"), null, "an absolute path stays workspace-relative");
  } finally {
    await h.close();
  }
});

test("an error the guest agent answered with is the caller's problem, not the container's", async () => {
  const h = await startRunner();
  try {
    const sb = clientFor(h);
    const handle = await sb.provision(rw(scopeId("personal", "R-status")));
    await sb.writeFile(handle, "blocked", "not a directory");
    const runsBefore = h.fake.runCount;

    await assert.rejects(sb.writeFile(handle, "blocked/child.txt", "nope"), /500/);

    assert.equal(h.fake.runCount, runsBefore, "the box must not be rebuilt because a write failed inside it");
    assert.equal(h.fake.containers.get(handle.id)?.running, true);
    assert.deepEqual(await h.auditLog.events(), []);
    assert.equal(await sb.readFile(handle, "blocked"), "not a directory");
  } finally {
    await h.close();
  }
});

test("parking records the intent before the container stops, so the sweeper cannot resurrect it", async () => {
  const parkedAtStop: Array<boolean | undefined> = [];
  const h = await startRunner(undefined, async (args) => {
    if (args[0] === "stop") parkedAtStop.push((await h.store.get(args.at(-1)!))?.parked);
  });
  try {
    const sb = clientFor(h);
    const scope = scopeId("personal", "R-park");
    const first = await sb.provision(rw(scope));
    const second = await sb.provision(rw(scope));

    await sb.teardown(second);
    assert.deepEqual(parkedAtStop, [], "a box another hold still owns is never stopped");
    assert.equal((await h.store.get(first.id))?.parked, false, "and it is not recorded as parked either");

    await sb.teardown(first);
    assert.deepEqual(parkedAtStop, [true], "the stop must find the record already parked");
    assert.equal((await h.store.get(first.id))?.parked, true);
    assert.equal(
      await reconcileRunnerBoxes({
        store: h.store,
        lifecycle: h.lifecycle,
        auditLog: h.auditLog,
        boxQueue: h.boxQueue,
      }),
      0,
    );
    assert.deepEqual(await h.auditLog.events(), []);
  } finally {
    await h.close();
  }
});

test("keep-warm release survives recovery without an active acquisition", async () => {
  const h = await startRunner();
  try {
    const sb = clientFor(h);
    const handle = await sb.provision(rw(scopeId("personal", "R-warm")));
    await sb.teardown(handle, { keepWarm: true });

    assert.equal((await h.store.get(handle.id))?.keepWarm, true);
    assert.equal(Object.keys((await h.store.get(handle.id))?.holds ?? {}).length, 0);
    assert.equal(
      await reconcileRunnerBoxes({
        store: h.store,
        lifecycle: h.lifecycle,
        auditLog: h.auditLog,
        boxQueue: h.boxQueue,
      }),
      0,
    );
    assert.equal(h.fake.containers.get(handle.id)?.running, true);
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
    assert.equal(
      await reconcileRunnerBoxes({ store: h.store, lifecycle, auditLog: h.auditLog, boxQueue: h.boxQueue }),
      0,
    );
    assert.equal(h.fake.containers.get(handle.id)?.running, false, "the sweep leaves a parked sandbox parked");
    assert.equal(h.fake.runCount, runsBefore, "and does not rebuild it");
    assert.deepEqual(await h.auditLog.events(), []);

    const resumed = await sb.provision(rw(scopeId("personal", "R6")));
    const r = await sb.run(resumed, "echo woken");
    assert.equal(r.stdout.trim(), "woken");
    assert.equal((await h.store.get(handle.id))?.parked, false, "activity clears the parked flag");
  } finally {
    await h.close();
  }
});

test("a box another hold still owns keeps its durable record and its recovery eligibility", async () => {
  const h = await startRunner();
  try {
    const sb = clientFor(h);
    const scope = scopeId("personal", "R7");
    const first = await sb.provision(rw(scope));
    const second = await sb.provision(rw(scope));
    assert.equal(first.id, second.id, "one scope, one box");

    await sb.teardown(first, { destroy: true });
    assert.ok(await h.store.get(first.id), "a box someone still holds must not lose its record to the other's destroy");
    assert.equal(h.fake.containers.has(first.id), true);
    assert.equal((await h.store.get(first.id))?.parked, false, "a running box must stay eligible for recovery");
    assert.equal(
      await reconcileRunnerBoxes({
        store: h.store,
        lifecycle: h.lifecycle,
        auditLog: h.auditLog,
        boxQueue: h.boxQueue,
      }),
      0,
    );
    assert.equal(h.fake.containers.has(first.id), true, "recovery must respect the remaining acquisition");

    await sb.teardown(first, { destroy: true });
    assert.equal(
      Object.keys((await h.store.get(first.id))?.holds ?? {}).length,
      1,
      "repeating one teardown cannot release another acquisition",
    );

    await sb.teardown(second, { destroy: true });
    assert.equal(await h.store.get(first.id), null, "the last hold releases it for real");
    assert.equal(h.fake.containers.has(first.id), false);
  } finally {
    await h.close();
  }
});

test("a delayed teardown from an old generation cannot destroy a recreated box", async () => {
  const h = await startRunner();
  try {
    const sb = clientFor(h);
    const scope = scopeId("personal", "R-generation");
    const old = await sb.provision(rw(scope));
    await sb.teardown(old, { destroy: true });
    assert.equal(await h.store.get(old.id), null);

    const fresh = await sb.provision(rw(scope));
    await sb.teardown(old, { destroy: true });

    const record = await h.store.get(fresh.id);
    assert.equal(record?.destroyPending, undefined);
    assert.deepEqual(Object.keys(record?.holds ?? {}), [fresh.acquisitionId]);
    assert.equal(h.fake.containers.has(fresh.id), true);
    await sb.teardown(fresh, { destroy: true });
  } finally {
    await h.close();
  }
});

test("a runner-only restart preserves durable holds", { timeout: 30_000 }, async () => {
  const firstRunner = await startRunner();
  let secondRunner: Harness | undefined;
  try {
    const firstClient = clientFor(firstRunner);
    const scope = scopeId("personal", "R-restart-holds");
    const first = await firstClient.provision(rw(scope));
    const second = await firstClient.provision(rw(scope));
    assert.equal(Object.keys((await firstRunner.store.get(first.id))?.holds ?? {}).length, 2);
    const closed = firstRunner.close();
    firstRunner.server.closeAllConnections();
    await closed;

    secondRunner = await startRunner(undefined, undefined, firstRunner);
    const secondClient = clientFor(secondRunner);
    await secondClient.teardown(first);
    assert.equal(Object.keys((await secondRunner.store.get(first.id))?.holds ?? {}).length, 1);
    assert.equal(secondRunner.fake.containers.get(first.id)?.running, true);

    await secondClient.teardown(second);
    assert.equal(Object.keys((await secondRunner.store.get(first.id))?.holds ?? {}).length, 0);
    assert.equal((await secondRunner.store.get(first.id))?.parked, true);
    assert.equal(secondRunner.fake.containers.get(first.id)?.running, false);
  } finally {
    if (firstRunner.server.listening) await firstRunner.close();
    if (secondRunner?.server.listening) await secondRunner.close();
  }
});

test("a box whose agent cannot be reached is recycled and audited", async () => {
  const h = await startRunner();
  try {
    const sb = clientFor(h);
    const handle = await sb.provision(rw(scopeId("personal", "R9")));
    h.fake.containers.delete(handle.id);

    await assert.rejects(sb.run(handle, "echo hi"), "the caller learns this attempt failed");

    assert.equal(h.fake.containers.has(handle.id), true, "and the box was rebuilt for the next one");
    assert.deepEqual(
      (await h.auditLog.events()).map(({ action, status }) => ({ action, status })),
      [{ action: "sandbox.recycled", status: "agent_unreachable" }],
    );
  } finally {
    await h.close();
  }
});

test("a failing in-flight exec does not undo a concurrent teardown that parked the box", async () => {
  let sb: ReturnType<typeof clientFor>;
  let handle: SandboxHandle;
  let armed = false;
  const hook = async () => {
    if (!armed) return;
    armed = false;
    await sb.teardown(handle);
    h.fake.containers.delete(handle.id);
  };
  const h = await startRunner(undefined, hook);
  try {
    sb = clientFor(h);
    handle = await sb.provision(rw(scopeId("personal", "R-park-race")));
    armed = true;

    await assert.rejects(sb.run(handle, "echo hi"), /500/, "the transport failure reaches the caller");

    assert.equal(h.fake.runCount, 1, "the parked box is not destroyed and rebuilt");
    assert.deepEqual(await h.auditLog.events(), [], "a parked box's in-flight failure is not a recycle");
    assert.equal((await h.store.get(handle.id))?.parked, true, "the park intent survives");
    assert.deepEqual((await h.store.get(handle.id))?.holds, {}, "and no hold is left behind");
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

test("a command that runs past its cap is the command's problem, not the box's", async () => {
  const h = await startRunner(1);
  try {
    const sb = clientFor(h);
    const handle = await sb.provision(rw(scopeId("personal", "R5")));
    const { processId } = await sb.startProcess!(handle, "sleep 30");
    const started = Date.now();
    const result = await sb.run(handle, "sleep 5", { timeoutMs: 30_000 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 4_000, "the cap decided when to stop, not the command");
    assert.equal(h.fake.runCount, 1, "the agent killed the child and kept serving, so the box is untouched");
    assert.equal(h.fake.volumes.size, 1);
    assert.deepEqual(await h.auditLog.events(), [], "nothing was recycled, so nothing to audit");
    assert.equal((await sb.run(handle, "echo still here")).stdout.trim(), "still here");
    assert.ok(
      (await sb.listProcesses!(handle)).some((session) => session.processId === processId),
      "the scope's background work outlives one command hitting its cap",
    );
  } finally {
    await h.close();
  }
});

test("unsigned, wrongly-signed, and replayed requests are all refused", async () => {
  const h = await startRunner();
  try {
    const path = "/v1/sandboxes/ensure";
    const body = JSON.stringify({ scopeId: "personal:R4", acquisitionId: "00000000-0000-4000-8000-000000000001" });

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

test("an auth store outage fails closed without escaping the request handler", async () => {
  const h = await startRunner(undefined, undefined, undefined, {
    verify: async () => {
      throw new Error("database unavailable");
    },
  });
  try {
    const path = "/v1/sandboxes/ensure";
    const body = JSON.stringify({
      scopeId: "personal:auth-outage",
      acquisitionId: "00000000-0000-4000-8000-000000000002",
    });
    const res = await fetch(`${h.baseUrl}${path}`, {
      method: "POST",
      headers: signedRequestHeaders(SECRET, "POST", path, body, { "content-type": "application/json" }),
      body,
    });
    assert.equal(res.status, 500);
    assert.equal((await fetch(`${h.baseUrl}/health`)).status, 200);
  } finally {
    await h.close();
  }
});

test("the guest agent exits cleanly on SIGTERM, so a parked container is not an abnormal exit", async () => {
  const port = await freePort();
  const agent = spawn(process.execPath, [join(process.cwd(), "aws/microvm-agent/agent.mjs")], {
    env: { ...process.env, AGENT_PORT: String(port), HOME: guestHome },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => agent.on("exit", (code) => resolve(code)));
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 200) break;
    } catch {
      if (Date.now() > deadline) throw new Error("agent never became reachable");
    }
    await sleep(50);
  }

  agent.kill("SIGTERM");
  assert.equal(await exited, 0, "docker stop must leave exit 0, not the 143 the recovery sweep reads as a failure");
});
