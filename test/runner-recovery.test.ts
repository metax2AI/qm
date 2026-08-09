import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, resolveBindAddress } from "../src/runner-main.ts";
import { createRunnerStore, type RunnerBoxRecord } from "../src/runner/store.ts";
import { installFakeDocker } from "./support/fake-docker.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";

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

test("restart recovery keeps records whose container survived and prunes the rest", async () => {
  const fake = installFakeDocker(1);
  const store = createRunnerStore();
  await store.put("qmr-sbx-alive", record("qmr-sbx-alive"));
  await store.put("qmr-sbx-vanished", record("qmr-sbx-vanished"));
  fake.containers.set("qmr-sbx-alive", {
    name: "qmr-sbx-alive",
    imageId: fake.imageId,
    running: true,
    labels: {},
  });

  assert.equal(await reconcile(store, fake.dockerExec), 1);
  assert.ok(await store.get("qmr-sbx-alive"));
  assert.equal(await store.get("qmr-sbx-vanished"), null);
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

test("an unresolvable service network falls back to 0.0.0.0 rather than failing to boot", async () => {
  const dexec: DockerExec = async () => ({ code: 1, stdout: "", stderr: "no such object" });
  assert.equal(await resolveBindAddress(dexec, "qm-org-runner", "qm-org"), "0.0.0.0");
  assert.equal(await resolveBindAddress(dexec, undefined, "qm-org"), "0.0.0.0");
  assert.equal(await resolveBindAddress(dexec, "qm-org-runner", undefined), "0.0.0.0");
});
