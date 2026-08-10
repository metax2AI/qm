import { test } from "node:test";
import assert from "node:assert/strict";
import { isDigestPinnedImageRef, resolveBindAddress, runnerNamePrefix } from "../src/runner-main.ts";
import { createRunnerStore, type RunnerBoxRecord } from "../src/runner/store.ts";
import { installFakeDocker } from "./support/fake-docker.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { createDockerLifecycle } from "../src/sandbox/docker-lifecycle.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { reconcileRunnerBoxes } from "../src/runner/recovery.ts";

function record(containerName: string): RunnerBoxRecord {
  return {
    containerName,
    networkName: `qmr-net-${containerName}`,
    imageRef: "registry.invalid/sandbox@sha256:abc",
    orgId: "test-org",
    createdAtMs: 1,
    lastActivityMs: 2,
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

  assert.equal(await reconcileRunnerBoxes({ store, lifecycle, auditLog, now: () => 3 }), 1);
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

  assert.equal(await reconcileRunnerBoxes({ store, lifecycle, auditLog, now: () => 4 }), 1);
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
  await store.merge(parkedId, { parked: true });
  const auditLog = createAuditLog();

  assert.equal(await reconcileRunnerBoxes({ store, lifecycle, auditLog, now: () => 5 }), 1);
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
});
