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
