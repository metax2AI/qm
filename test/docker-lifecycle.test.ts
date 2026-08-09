import { test } from "node:test";
import assert from "node:assert/strict";
import { createDockerLifecycle } from "../src/sandbox/docker-lifecycle.ts";
import { installFakeDocker, type FakeDocker } from "./support/fake-docker.ts";
import { scopeId } from "../src/types.ts";

function lifecycleOn(fake: FakeDocker, namePrefix: string) {
  return createDockerLifecycle({
    label: namePrefix,
    namePrefix,
    image: "qm-sandbox-local:latest",
    homeDir: "/root",
    buildHint: "build it",
    endpointMode: { kind: "published-port" },
    waitReady: async () => {},
    dockerExec: fake.dockerExec,
    repoRoot: "/nonexistent-repo-root",
  });
}

test("two docker-backed backends on one daemon never touch each other's containers", async () => {
  const fake = installFakeDocker(1);
  const scope = scopeId("personal", "U1");

  const local = lifecycleOn(fake, "qm");
  const runner = lifecycleOn(fake, "qmr");

  const localBox = await local.ensureScope(scope);

  fake.imageId = "sha256:image-v2";
  const runnerBox = await runner.ensureScope(scope);

  assert.notEqual(localBox.id, runnerBox.id);
  assert.equal(fake.containers.has(localBox.id), true, "the second backend must not reap the first backend's box");
  assert.equal(fake.containers.has(runnerBox.id), true);
  assert.equal(fake.volumes.size, 2, "each backend owns its own home volume");
  assert.equal(fake.networks.size, 2, "each backend owns its own network");

  await runner.teardown({ id: runnerBox.id }, { destroy: true });
  assert.equal(fake.containers.has(localBox.id), true, "destroying one backend's box must leave the other's alone");
  assert.equal(fake.volumes.size, 1);
});

function runnerLifecycleOn(fake: FakeDocker, selfContainer?: string) {
  return createDockerLifecycle({
    label: "runner",
    namePrefix: "qmr",
    image: "qm-sandbox-local:latest",
    homeDir: "/root",
    buildHint: "publish the rootfs",
    endpointMode: { kind: "container-dns", ...(selfContainer ? { selfContainer } : {}) },
    waitReady: async () => {},
    dockerExec: fake.dockerExec,
    repoRoot: "/nonexistent-repo-root",
  });
}

test("container-dns boxes publish no host port and are addressed by container name", async () => {
  const fake = installFakeDocker(1);
  const lifecycle = runnerLifecycleOn(fake);
  const box = await lifecycle.ensureScope(scopeId("personal", "U2"));

  const argv = fake.runArgv.at(-1)!;
  assert.equal(argv.includes("-p"), false, "the agent port must not be published to the host");
  assert.equal(
    argv.some((a) => a.startsWith("--add-host=host.docker.internal")),
    false,
  );
  assert.equal(await lifecycle.endpointOf(box.id), `http://${box.id}:8080`);
});

test("the runner attaches itself to each sandbox network, and re-attaches after the network is recreated", async () => {
  const fake = installFakeDocker(1);
  const lifecycle = runnerLifecycleOn(fake, "qm-org-runner");
  const scope = scopeId("personal", "U3");

  const box = await lifecycle.ensureScope(scope);
  const net = lifecycle.networkNameOf(box.id);
  assert.deepEqual([...(fake.attachments.get(net) ?? [])], ["qm-org-runner"]);

  await lifecycle.teardown({ id: box.id }, { destroy: true });
  assert.equal(fake.networks.has(net), false);

  const again = await lifecycle.ensureScope(scope);
  assert.deepEqual([...(fake.attachments.get(lifecycle.networkNameOf(again.id)) ?? [])], ["qm-org-runner"]);
});
