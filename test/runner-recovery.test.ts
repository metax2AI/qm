import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDigestPinnedImageRef,
  requireRunnerDatabaseUrl,
  resolveBindAddress,
  runnerHomeRoot,
  runnerNamePrefix,
} from "../src/runner-main.ts";
import { createRunnerStore, runnerStoreTable, type RunnerBoxRecord } from "../src/runner/store.ts";
import { installFakeDocker } from "./support/fake-docker.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { createDockerLifecycle } from "../src/sandbox/docker-lifecycle.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { reconcileRunnerBoxes } from "../src/runner/recovery.ts";
import { createKeyedQueue } from "../src/util/async.ts";

const boxQueue = createKeyedQueue<string>();

function record(containerName: string): RunnerBoxRecord {
  return {
    generation: containerName,
    containerName,
    networkName: `qmr-net-${containerName}`,
    imageRef: "registry.invalid/sandbox@sha256:abc",
    orgId: "test-org",
    createdAtMs: 1,
    lastActivityMs: 2,
    holds: { active: Number.MAX_SAFE_INTEGER },
  };
}

function lifecycleOn(fake: ReturnType<typeof installFakeDocker>) {
  return createDockerLifecycle({
    label: "runner",
    namePrefix: "qmr",
    image: "qm-sandbox-local:latest",
    homeDir: "/root",
    buildHint: "publish the rootfs",
    endpointMode: { kind: "container-dns" },
    internalNetwork: true,
    waitReady: async () => {},
    dockerExec: fake.dockerExec,
    repoRoot: "/nonexistent-repo-root",
  });
}

test("restart recovery safely rebuilds a missing scope container and keeps its record", async () => {
  const fake = installFakeDocker(1);
  const store = createRunnerStore();
  const lifecycle = lifecycleOn(fake);
  const id = "qmr-sbx-vanished";
  const scope = "personal:U1";
  const volume = lifecycle.volumeNameOf(scope);
  await store.put(id, { ...record(id), scopeId: scope, volumeName: volume });
  fake.volumes.add(volume);
  const auditLog = createAuditLog();

  assert.equal(await reconcileRunnerBoxes({ store, lifecycle, auditLog, boxQueue, now: () => 3 }), 1);
  assert.ok(await store.get(id));
  assert.equal(fake.containers.has(id), true);
  assert.equal(fake.volumes.has(volume), true);
  assert.equal((await auditLog.events())[0]?.status, "container_missing");
});

test("restart recovery recycles OOM-killed containers and records the resource exhaustion", async () => {
  const fake = installFakeDocker(1);
  const store = createRunnerStore();
  const lifecycle = lifecycleOn(fake);
  const id = "qmr-sbx-oom";
  const scope = "personal:U2";
  const volume = lifecycle.volumeNameOf(scope);
  await store.put(id, { ...record(id), scopeId: scope, volumeName: volume });
  fake.volumes.add(volume);
  fake.containers.set(id, {
    name: id,
    imageId: fake.imageId,
    running: false,
    oomKilled: true,
    exitCode: 137,
    labels: {},
    volume,
  });
  const auditLog = createAuditLog();

  assert.equal(await reconcileRunnerBoxes({ store, lifecycle, auditLog, boxQueue, now: () => 4 }), 1);
  assert.equal(fake.containers.get(id)?.running, true);
  assert.equal(fake.volumes.has(volume), true);
  assert.equal((await auditLog.events())[0]?.status, "oom_killed");
});

test("restart recovery recycles abnormal exits but leaves normally parked containers stopped", async () => {
  const fake = installFakeDocker(1);
  const lifecycle = lifecycleOn(fake);
  const store = createRunnerStore();
  const abnormalId = "qmr-sbx-abnormal";
  const parkedId = "qmr-sbx-parked";
  const abnormalScope = "personal:U3";
  const parkedScope = "personal:U4";
  const abnormalVolume = lifecycle.volumeNameOf(abnormalScope);
  const parkedVolume = lifecycle.volumeNameOf(parkedScope);
  await store.put(abnormalId, { ...record(abnormalId), scopeId: abnormalScope, volumeName: abnormalVolume });
  await store.put(parkedId, { ...record(parkedId), scopeId: parkedScope, volumeName: parkedVolume });
  fake.volumes.add(abnormalVolume);
  fake.volumes.add(parkedVolume);
  fake.containers.set(abnormalId, {
    name: abnormalId,
    imageId: fake.imageId,
    running: false,
    oomKilled: false,
    exitCode: 42,
    labels: {},
    volume: abnormalVolume,
  });
  fake.containers.set(parkedId, {
    name: parkedId,
    imageId: fake.imageId,
    running: false,
    oomKilled: false,
    exitCode: 143,
    labels: {},
    volume: parkedVolume,
  });
  await store.merge(parkedId, { parked: true, holds: {} });
  const auditLog = createAuditLog();

  assert.equal(await reconcileRunnerBoxes({ store, lifecycle, auditLog, boxQueue, now: () => 5 }), 1);
  assert.equal(fake.containers.get(abnormalId)?.running, true);
  assert.equal(fake.containers.get(parkedId)?.running, false);
  assert.equal((await auditLog.events())[0]?.status, "abnormal_exit");
});

test("the runner binds only its service-network address, so attached sandboxes cannot reach the API", async () => {
  const calls: string[][] = [];
  const dexec: DockerExec = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "172.20.0.5\n", stderr: "" };
  };
  assert.equal(await resolveBindAddress(dexec, "qm-org-runner", "qm-org"), "172.20.0.5");
  assert.equal(calls[0]?.[0], "inspect");
  assert.ok(calls[0]?.some((a) => a.includes('"qm-org"')));
});

test("an unresolvable service network fails closed", async () => {
  const dexec: DockerExec = async () => ({ code: 1, stdout: "", stderr: "no such object" });
  await assert.rejects(resolveBindAddress(dexec, "qm-org-runner", "qm-org"), /cannot resolve/);
  await assert.rejects(resolveBindAddress(dexec, undefined, "qm-org"), /RUNNER_SELF_CONTAINER/);
  await assert.rejects(resolveBindAddress(dexec, "qm-org-runner", undefined), /RUNNER_SERVICE_NETWORK/);
});

test("the runner accepts only digest-pinned sandbox images", () => {
  assert.equal(isDigestPinnedImageRef("registry.example/qm@sha256:" + "a".repeat(64)), true);
  assert.equal(isDigestPinnedImageRef("registry.example/qm:latest"), false);
  assert.equal(isDigestPinnedImageRef("registry.example/qm@sha256:abc"), false);
});

test("runner resource names are partitioned by organization", () => {
  assert.equal(runnerNamePrefix("acme"), "qmr-acme");
  assert.notEqual(runnerNamePrefix("acme"), runnerNamePrefix("globex"));
  assert.equal(runnerHomeRoot("/data/qm/sandbox-homes", "acme"), "/data/qm/sandbox-homes/acme");
  assert.notEqual(runnerHomeRoot("/data/qm/sandbox-homes", "acme"), runnerHomeRoot("/data/qm/sandbox-homes", "globex"));
  assert.notEqual(runnerStoreTable("acme"), runnerStoreTable("globex"));
  assert.throws(() => runnerHomeRoot("/data/qm/../shared", "acme"), /safe absolute path/);
});

test("the production runner requires durable database state", () => {
  assert.equal(requireRunnerDatabaseUrl("postgres://db/qm"), "postgres://db/qm");
  assert.throws(() => requireRunnerDatabaseUrl(undefined), /DATABASE_URL is required/);
  assert.throws(() => requireRunnerDatabaseUrl("  "), /DATABASE_URL is required/);
});

test("a box parked after the sweep read the store is left alone, not rebuilt and then orphaned", async () => {
  const fake = installFakeDocker(1);
  const store = createRunnerStore();
  const lifecycle = lifecycleOn(fake);
  const scope = "personal:U8";
  const box = await lifecycle.ensureScope(scope);
  await store.put(box.id, { ...record(box.id), scopeId: scope, volumeName: lifecycle.volumeNameOf(scope) });
  await lifecycle.teardownBox({ id: box.id, scopeId: scope });
  const stale = new Map(await store.entries());
  const auditLog = createAuditLog();

  const snapshotted = {
    ...store,
    entries: async () => [...stale.entries()],
  };
  await store.merge(box.id, { parked: true, holds: {} });

  assert.equal(await reconcileRunnerBoxes({ store: snapshotted, lifecycle, auditLog, boxQueue, now: () => 6 }), 0);
  assert.equal(fake.containers.get(box.id)?.running, false, "the parked container must stay stopped");
  assert.equal((await store.get(box.id))?.parked, true);
  assert.deepEqual(await auditLog.events(), []);
});

test("destroy fails until the home quota is released", async () => {
  const fake = installFakeDocker(1);
  const scope = "personal:U9";
  const lifecycle = createDockerLifecycle({
    label: "runner",
    namePrefix: "qmr",
    image: "qm-sandbox-local:latest",
    homeDir: "/root",
    buildHint: "publish the rootfs",
    endpointMode: { kind: "container-dns" },
    internalNetwork: true,
    homeQuota: {
      preflight: async () => {},
      sourceOf: (s) => `/quota/${s}`,
      ensure: async (s) => ({ source: `/quota/${s}`, coldStart: true }),
      destroy: async () => {
        throw new Error("xfs_quota: no such project");
      },
    },
    waitReady: async () => {},
    dockerExec: fake.dockerExec,
    repoRoot: "/nonexistent-repo-root",
  });

  const box = await lifecycle.ensureScope(scope);
  await assert.rejects(lifecycle.teardownBox({ id: box.id, scopeId: scope }, { destroy: true }), /no such project/);
  assert.equal(fake.containers.has(box.id), false);
  assert.equal(fake.networks.has(lifecycle.networkNameOf(box.id)), false);
});

test("a destroy tombstone survives cleanup failure and is retried", async () => {
  const fake = installFakeDocker(1);
  const scope = "personal:U10";
  let attempts = 0;
  const lifecycle = createDockerLifecycle({
    label: "runner",
    namePrefix: "qmr",
    image: "qm-sandbox-local:latest",
    homeDir: "/root",
    buildHint: "publish the rootfs",
    endpointMode: { kind: "container-dns" },
    internalNetwork: true,
    trackHolds: false,
    homeQuota: {
      preflight: async () => {},
      sourceOf: (s) => `/quota/${s}`,
      ensure: async (s) => ({ source: `/quota/${s}`, coldStart: true }),
      destroy: async () => {
        attempts++;
        if (attempts === 1) throw new Error("quota busy");
      },
    },
    waitReady: async () => {},
    dockerExec: fake.dockerExec,
    repoRoot: "/nonexistent-repo-root",
  });
  const box = await lifecycle.ensureScope(scope);
  const store = createRunnerStore();
  await store.put(box.id, {
    ...record(box.id),
    scopeId: scope,
    volumeName: lifecycle.volumeNameOf(scope),
    holds: {},
    destroyPending: true,
  });
  const auditLog = createAuditLog();

  await reconcileRunnerBoxes({ store, lifecycle, auditLog, boxQueue });
  assert.ok(await store.get(box.id));
  assert.equal(fake.containers.has(box.id), false);

  await reconcileRunnerBoxes({ store, lifecycle, auditLog, boxQueue });
  assert.equal(await store.get(box.id), null);
  assert.equal(attempts, 2);
});

test("recovery waits for live acquisitions before finishing a pending destroy", async () => {
  const fake = installFakeDocker(1);
  const lifecycle = lifecycleOn(fake);
  const scope = "personal:U11";
  const box = await lifecycle.ensureScope(scope);
  const store = createRunnerStore();
  await store.put(box.id, {
    ...record(box.id),
    scopeId: scope,
    volumeName: lifecycle.volumeNameOf(scope),
    holds: { active: 100 },
    destroyPending: true,
  });
  const auditLog = createAuditLog();
  let at = 50;

  await reconcileRunnerBoxes({ store, lifecycle, auditLog, boxQueue, now: () => at });
  assert.ok(await store.get(box.id));
  assert.equal(fake.containers.has(box.id), true);

  at = 101;
  await reconcileRunnerBoxes({ store, lifecycle, auditLog, boxQueue, now: () => at });
  assert.equal(await store.get(box.id), null);
  assert.equal(fake.containers.has(box.id), false);
});

test("a stale destroy snapshot cannot delete a recreated generation", async () => {
  const fake = installFakeDocker(1);
  const lifecycle = lifecycleOn(fake);
  const scope = "personal:U12";
  const box = await lifecycle.ensureScope(scope);
  const store = createRunnerStore();
  const fresh = {
    ...record(box.id),
    generation: "fresh",
    scopeId: scope,
    volumeName: lifecycle.volumeNameOf(scope),
    holds: { active: Date.now() + 60_000 },
  };
  await store.put(box.id, fresh);
  const stale = { ...fresh, generation: "old", holds: {}, destroyPending: true };
  const snapshotted = { ...store, entries: async () => [[box.id, stale] as [string, RunnerBoxRecord]] };

  assert.equal(
    await reconcileRunnerBoxes({
      store: snapshotted,
      lifecycle,
      auditLog: createAuditLog(),
      boxQueue,
    }),
    0,
  );
  assert.equal((await store.get(box.id))?.generation, "fresh");
  assert.equal(fake.containers.has(box.id), true);
});

test("recovery parks an unclaimed box after its acquisition lease expires", async () => {
  const fake = installFakeDocker(1);
  const lifecycle = lifecycleOn(fake);
  const scope = "personal:U13";
  const box = await lifecycle.ensureScope(scope);
  const store = createRunnerStore();
  await store.put(box.id, {
    ...record(box.id),
    scopeId: scope,
    volumeName: lifecycle.volumeNameOf(scope),
    holds: { lost: 10 },
  });

  await reconcileRunnerBoxes({
    store,
    lifecycle,
    auditLog: createAuditLog(),
    boxQueue,
    now: () => 11,
  });
  assert.equal((await store.get(box.id))?.parked, true);
  assert.equal(fake.containers.get(box.id)?.running, false);
});

test("recovery finishes a durable park intent left before the stop", async () => {
  const fake = installFakeDocker(1);
  const lifecycle = lifecycleOn(fake);
  const scope = "personal:U14";
  const box = await lifecycle.ensureScope(scope);
  const store = createRunnerStore();
  await store.put(box.id, {
    ...record(box.id),
    scopeId: scope,
    volumeName: lifecycle.volumeNameOf(scope),
    parked: true,
    holds: {},
  });

  await reconcileRunnerBoxes({ store, lifecycle, auditLog: createAuditLog(), boxQueue });
  assert.equal(fake.containers.get(box.id)?.running, false);
  assert.equal((await store.get(box.id))?.parked, true);
});
