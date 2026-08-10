import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAuditLog } from "../../src/audit/audit-log.ts";
import { createPostgresMapFactory, type PostgresArtifactMaps } from "../../src/persistence/durable-map.ts";
import { reconcileRunnerBoxes } from "../../src/runner/recovery.ts";
import { buildRunnerServer } from "../../src/runner/server.ts";
import type { RunnerBoxRecord } from "../../src/runner/store.ts";
import { docker, removeDockerResources, sandboxImage, skipUnavailable } from "./runner-harness.ts";
import { createDockerLifecycle } from "../../src/sandbox/docker-lifecycle.ts";
import { createGuestAgent } from "../../src/sandbox/guest-agent-client.ts";
import { createRunnerSandbox } from "../../src/sandbox/runner-sandbox.ts";
import { scopeId } from "../../src/types.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createKeyedQueue } from "../../src/util/async.ts";

const secret = "runner-restart-test-secret-that-is-long-enough";

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

async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function dropTable(factory: PostgresArtifactMaps, table: string): Promise<void> {
  await factory.pool.query(`DROP TABLE IF EXISTS ${table}`);
  await factory.pool.query("DELETE FROM durable_map_versions WHERE tbl = $1", [table]).catch(() => undefined);
}

test(
  "a fresh runner instance safely rebuilds an abnormal real container from Postgres",
  { timeout: 180_000 },
  async (t) => {
    const databaseUrl = process.env.RUNNER_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!databaseUrl) return skipUnavailable(t, "RUNNER_TEST_DATABASE_URL or DATABASE_URL unavailable");
    if ((await docker(["version"], 15_000)).code !== 0) return skipUnavailable(t, "Docker daemon unavailable");
    if ((await docker(["image", "inspect", sandboxImage], 15_000)).code !== 0)
      return skipUnavailable(t, `${sandboxImage} unavailable`);

    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const namePrefix = `qmrr-${suffix}`;
    const table = `runner_restart_${suffix}`;
    const scope = scopeId("personal", suffix);
    const agent = createGuestAgent({ label: "runner-restart" });
    const auditLog = createAuditLog();
    const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "runner-restart-")));
    let firstServer: Server | undefined;
    let secondServer: Server | undefined;
    let firstFactory: PostgresArtifactMaps | undefined;
    let secondFactory: PostgresArtifactMaps | undefined;
    let firstFactoryClosed = false;

    const lifecycle = () =>
      createDockerLifecycle({
        label: "runner-restart",
        namePrefix,
        image: sandboxImage,
        homeDir: "/root",
        buildHint: "run npm run sandbox:local:build",
        endpointMode: { kind: "published-port" },
        trackHolds: false,
        waitReady: (resolveEndpoint, name) => agent.waitReady(resolveEndpoint, name),
        dockerExec: docker,
        cpus: 0.5,
        memoryMb: 256,
        pidsLimit: 64,
        repoRoot: process.cwd(),
      });

    try {
      firstFactory = createPostgresMapFactory(databaseUrl);
      const firstStore = firstFactory.map<RunnerBoxRecord>(table);
      const firstLifecycle = lifecycle();
      const firstBoxQueue = createKeyedQueue<string>();
      firstServer = buildRunnerServer({
        lifecycle: firstLifecycle,
        agent,
        store: firstStore,
        signingSecret: secret,
        namePrefix,
        imageRef: sandboxImage,
        orgId: "runner-restart-test",
        auditLog,
        boxQueue: firstBoxQueue,
      });
      const firstClient = createRunnerSandbox(workspace, {
        baseUrl: await listen(firstServer),
        signingSecret: secret,
        homeDir: "/root",
      });
      const handle = await firstClient.provision([{ scopeId: scope, mountPath: "", mode: "rw" }]);
      await firstClient.writeFile(handle, "restart-proof.txt", "survived");

      await close(firstServer);
      firstServer = undefined;
      await firstFactory.pool.close();
      firstFactoryClosed = true;
      const killed = await docker(["kill", handle.id], 15_000);
      assert.equal(killed.code, 0, killed.stderr);

      secondFactory = createPostgresMapFactory(databaseUrl);
      const secondStore = secondFactory.map<RunnerBoxRecord>(table);
      const secondLifecycle = lifecycle();
      const secondBoxQueue = createKeyedQueue<string>();
      assert.equal(
        await reconcileRunnerBoxes({
          store: secondStore,
          lifecycle: secondLifecycle,
          auditLog,
          boxQueue: secondBoxQueue,
        }),
        1,
      );

      secondServer = buildRunnerServer({
        lifecycle: secondLifecycle,
        agent,
        store: secondStore,
        signingSecret: secret,
        namePrefix,
        imageRef: sandboxImage,
        orgId: "runner-restart-test",
        auditLog,
        boxQueue: secondBoxQueue,
      });
      const secondClient = createRunnerSandbox(workspace, {
        baseUrl: await listen(secondServer),
        signingSecret: secret,
        homeDir: "/root",
      });
      assert.equal(await secondClient.readFile(handle, "restart-proof.txt"), "survived");
      const result = await secondClient.run(handle, "printf recovered");
      assert.equal(result.stdout, "recovered");
      assert.equal(result.code, 0);
      assert.deepEqual(
        (await auditLog.events()).map(({ action, status }) => ({ action, status })),
        [{ action: "sandbox.recycled", status: "abnormal_exit" }],
      );
      await secondClient.teardown(handle, { destroy: true });
      assert.equal(await secondStore.get(handle.id), null);
    } finally {
      await close(firstServer);
      await close(secondServer);
      await removeDockerResources(namePrefix);
      if (secondFactory) {
        await dropTable(secondFactory, table);
        await secondFactory.pool.close();
      } else if (firstFactory && !firstFactoryClosed) {
        await dropTable(firstFactory, table);
        await firstFactory.pool.close();
      } else {
        const cleanupFactory = createPostgresMapFactory(databaseUrl);
        await dropTable(cleanupFactory, table);
        await cleanupFactory.pool.close();
      }
    }
  },
);
