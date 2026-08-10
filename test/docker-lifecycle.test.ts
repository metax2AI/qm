import { test } from "node:test";
import assert from "node:assert/strict";
import { createDockerLifecycle, probeRootfsQuota } from "../src/sandbox/docker-lifecycle.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { installFakeDocker, type FakeDocker } from "./support/fake-docker.ts";
import { scopeId } from "../src/types.ts";
import type { XfsProjectQuota } from "../src/sandbox/xfs-project-quota.ts";

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

function runnerLifecycleOn(fake: FakeDocker, attachContainers: string[] = []) {
  return createDockerLifecycle({
    label: "runner",
    namePrefix: "qmr",
    image: "qm-sandbox-local:latest",
    homeDir: "/root",
    buildHint: "publish the rootfs",
    endpointMode: { kind: "container-dns", attachContainers },
    internalNetwork: true,
    cpus: 2,
    memoryMb: 2048,
    pidsLimit: 256,
    rootfsMb: 10_240,
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
  assert.equal(fake.internalNetworks.has(lifecycle.networkNameOf(box.id)), true);
  assert.deepEqual(argv.slice(argv.indexOf("--cpus"), argv.indexOf("--cpus") + 14), [
    "--cpus",
    "2",
    "--memory",
    "2048m",
    "--memory-swap",
    "2048m",
    "--pids-limit",
    "256",
    "--storage-opt",
    "size=10240m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
  ]);
});

test("the runner attaches itself to each sandbox network, and re-attaches after the network is recreated", async () => {
  const fake = installFakeDocker(1);
  const lifecycle = runnerLifecycleOn(fake, ["qm-org-runner", "qm-org-egress"]);
  const scope = scopeId("personal", "U3");

  const box = await lifecycle.ensureScope(scope);
  const net = lifecycle.networkNameOf(box.id);
  assert.deepEqual([...(fake.attachments.get(net) ?? [])], ["qm-org-runner", "qm-org-egress"]);

  fake.attachments.set(net, new Set());
  await lifecycle.ensureScope(scope);
  assert.deepEqual([...(fake.attachments.get(net) ?? [])], ["qm-org-runner", "qm-org-egress"]);

  await lifecycle.teardown({ id: box.id }, { destroy: true });
  await lifecycle.teardown({ id: box.id }, { destroy: true });
  assert.equal(fake.networks.has(net), false);

  const again = await lifecycle.ensureScope(scope);
  assert.deepEqual(
    [...(fake.attachments.get(lifecycle.networkNameOf(again.id)) ?? [])],
    ["qm-org-runner", "qm-org-egress"],
  );
});

test("the runner refuses a pre-existing sandbox network that is not internal", async () => {
  const fake = installFakeDocker(1);
  const scope = scopeId("personal", "U4");
  await lifecycleOn(fake, "qmr").ensureScope(scope);
  const lifecycle = runnerLifecycleOn(fake, ["qm-org-runner"]);

  await assert.rejects(lifecycle.ensureScope(scope), /must be internal/);
});

test("recycling a runner container preserves its persistent volume", async () => {
  const fake = installFakeDocker(1);
  const lifecycle = runnerLifecycleOn(fake, ["qm-org-runner", "qm-org-egress"]);
  const scope = scopeId("personal", "U5");
  const box = await lifecycle.ensureScope(scope);
  const volume = lifecycle.volumeNameOf(scope);

  await lifecycle.recycle({ id: box.id, scopeId: scope });

  assert.equal(fake.runCount, 2);
  assert.equal(fake.containers.has(box.id), true);
  assert.deepEqual([...fake.volumes], [volume]);
  assert.equal(fake.networks.has(lifecycle.networkNameOf(box.id)), true);
});

test("destroy disconnects runner peers before removing the scope network", async () => {
  const fake = installFakeDocker(1);
  const lifecycle = runnerLifecycleOn(fake, ["qm-org-runner", "qm-org-egress"]);
  const box = await lifecycle.ensureScope(scopeId("personal", "U6"));
  const network = lifecycle.networkNameOf(box.id);

  await lifecycle.teardown({ id: box.id }, { destroy: true });

  assert.equal(fake.networks.has(network), false);
});

test("runner persistent homes use the quota-managed bind tree instead of an unbounded named volume", async () => {
  const fake = installFakeDocker(1);
  const destroyed: string[] = [];
  const homeQuota: XfsProjectQuota = {
    preflight: async () => {},
    sourceOf: (scope) => `/quota/${scope.replaceAll(":", "-")}`,
    ensure: async (scope) => ({ source: `/quota/${scope.replaceAll(":", "-")}`, coldStart: true }),
    destroy: async (scope) => void destroyed.push(scope),
  };
  const lifecycle = createDockerLifecycle({
    label: "runner",
    namePrefix: "qmr",
    image: "qm-sandbox-local:latest",
    homeDir: "/root",
    buildHint: "publish the rootfs",
    endpointMode: { kind: "container-dns" },
    internalNetwork: true,
    homeQuota,
    waitReady: async () => {},
    dockerExec: fake.dockerExec,
    repoRoot: "/nonexistent-repo-root",
  });
  const scope = scopeId("personal", "U7");
  const box = await lifecycle.ensureScope(scope);
  const argv = fake.runArgv.at(-1)!;

  assert.deepEqual(argv.slice(argv.indexOf("--mount"), argv.indexOf("--mount") + 2), [
    "--mount",
    "type=bind,src=/quota/personal-U7,dst=/root",
  ]);
  assert.equal(fake.volumes.size, 0);
  await lifecycle.teardown({ id: box.id }, { destroy: true });
  assert.deepEqual(destroyed, [scope]);
});

function dfDocker(stdout: string, code = 0): { dexec: DockerExec; argv: string[][] } {
  const argv: string[][] = [];
  return {
    argv,
    dexec: async (args) => {
      argv.push(args);
      return { code, stdout, stderr: code === 0 ? "" : stdout };
    },
  };
}

const DF_HEADER = "Filesystem     1K-blocks  Used Available Use% Mounted on";

test("the rootfs quota probe believes the kernel's own accounting, not the requested config", async () => {
  const honoured = dfDocker(`${DF_HEADER}\noverlay          10485760 32768  10452992   1% /`);
  assert.deepEqual(await probeRootfsQuota(honoured.dexec, "img", 10_240), { enforced: true, reportedMb: 10_240 });

  const ignored = dfDocker(`${DF_HEADER}\noverlay         475270624 32768 475237856   1% /`);
  assert.deepEqual(await probeRootfsQuota(ignored.dexec, "img", 10_240), { enforced: false, reportedMb: 464_131 });
});

test("the rootfs quota probe asks for the configured size and reports failures rather than throwing", async () => {
  const probe = dfDocker("overlay 10485760 0 10485760 1% /");
  await probeRootfsQuota(probe.dexec, "qm-sandbox:pinned", 4096);
  const argv = probe.argv[0]!;
  assert.deepEqual(argv.slice(argv.indexOf("--storage-opt"), argv.indexOf("--storage-opt") + 2), [
    "--storage-opt",
    "size=4096m",
  ]);
  assert.deepEqual(argv.slice(-4), ["qm-sandbox:pinned", "df", "-k", "/"]);
  assert.ok(argv.includes("--rm") && argv.includes("none"), "the probe leaves no container or network behind");

  const refused = dfDocker("Container size cannot be smaller than image size", 125);
  assert.deepEqual(await probeRootfsQuota(refused.dexec, "img", 1), {
    enforced: false,
    detail: "Container size cannot be smaller than image size",
  });

  const garbled = dfDocker("df: /: cannot read");
  const verdict = await probeRootfsQuota(garbled.dexec, "img", 1024);
  assert.equal(verdict.enforced, false);
  assert.match(verdict.detail!, /unreadable df output/);
});
