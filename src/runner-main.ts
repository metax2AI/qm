import { orgId as configOrgId } from "./config.ts";
import { isStrongSigningSecret, MIN_SIGNING_SECRET_LENGTH } from "./auth/source-auth.ts";
import { createDockerLifecycle } from "./sandbox/docker-lifecycle.ts";
import { createGuestAgent } from "./sandbox/guest-agent-client.ts";
import { spawnDockerExec, type DockerExec } from "./sandbox/docker-exec.ts";
import { buildRunnerServer } from "./runner/server.ts";
import { createRunnerStore } from "./runner/store.ts";
import { errMessage } from "./util/errors.ts";
import { createAuditLog } from "./audit/audit-log.ts";
import { createPostgresAuditLog } from "./admin/postgres-audit-log.ts";
import { reconcileRunnerBoxes } from "./runner/recovery.ts";
import { createSweeper } from "./util/sweeper.ts";
import { createXfsProjectQuota } from "./sandbox/xfs-project-quota.ts";

const LABEL = "runner";
const NAME_PREFIX = "qmr";
const DEFAULT_PORT = 48090;
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;
const DEFAULT_PIDS_LIMIT = 256;
const DEFAULT_ROOTFS_MB = 10_240;
const DEFAULT_HOME_MB = 10_240;
const DEFAULT_HOME_ROOT = "/var/lib/qm/sandbox-homes";
const DEFAULT_TIMEOUT_SEC = 600;
const RECOVERY_INTERVAL_MS = 30_000;

function positiveNumEnv(name: string, value: string | undefined, fallback: number, integer = false): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${name} must be a positive${integer ? " integer" : " number"}`);
  }
  return parsed;
}

export function isDigestPinnedImageRef(ref: string): boolean {
  return /@sha256:[0-9a-f]{64}$/.test(ref);
}

export function runnerNamePrefix(orgId: string): string {
  return `${NAME_PREFIX}-${orgId}`;
}

export async function resolveBindAddress(
  dexec: DockerExec,
  selfContainer: string | undefined,
  network: string | undefined,
): Promise<string> {
  if (!selfContainer) throw new Error("RUNNER_SELF_CONTAINER is required");
  if (!network) throw new Error("RUNNER_SERVICE_NETWORK is required");
  const r = await dexec([
    "inspect",
    "-f",
    `{{with index .NetworkSettings.Networks ${JSON.stringify(network)}}}{{.IPAddress}}{{end}}`,
    selfContainer,
  ]);
  const ip = r.stdout.trim();
  if (r.code !== 0 || !ip) {
    throw new Error(`[runner] cannot resolve this container's address on ${network}`);
  }
  return ip;
}

async function main(): Promise<void> {
  const port = positiveNumEnv("RUNNER_PORT", process.env.RUNNER_PORT, DEFAULT_PORT, true);
  const signingSecret = process.env.SANDBOX_RUNNER_SECRET ?? "";
  if (!isStrongSigningSecret(signingSecret)) {
    console.error(`[runner] SANDBOX_RUNNER_SECRET must be at least ${MIN_SIGNING_SECRET_LENGTH} characters`);
    process.exit(1);
  }
  const imageRef = process.env.RUNNER_SANDBOX_IMAGE;
  if (!imageRef || !isDigestPinnedImageRef(imageRef)) {
    console.error("[runner] RUNNER_SANDBOX_IMAGE must be pinned by digest (@sha256:…)");
    process.exit(1);
  }

  const dexec = spawnDockerExec(process.env.RUNNER_DOCKER_BIN ?? "docker");
  const selfContainer = process.env.RUNNER_SELF_CONTAINER ?? process.env.HOSTNAME;
  const serviceNetwork = process.env.RUNNER_SERVICE_NETWORK;
  const egressProxyUrl = process.env.RUNNER_EGRESS_PROXY_URL;
  const egressProxyContainer = egressProxyUrl ? new URL(egressProxyUrl).hostname : undefined;
  const orgId = configOrgId();
  const namePrefix = runnerNamePrefix(orgId);
  const agent = createGuestAgent({ label: LABEL });
  const cpus = positiveNumEnv("RUNNER_SANDBOX_CPUS", process.env.RUNNER_SANDBOX_CPUS, DEFAULT_CPUS);
  const memoryMb = positiveNumEnv(
    "RUNNER_SANDBOX_MEMORY_MB",
    process.env.RUNNER_SANDBOX_MEMORY_MB,
    DEFAULT_MEMORY_MB,
    true,
  );
  const pidsLimit = positiveNumEnv(
    "RUNNER_SANDBOX_PIDS_LIMIT",
    process.env.RUNNER_SANDBOX_PIDS_LIMIT,
    DEFAULT_PIDS_LIMIT,
    true,
  );
  const rootfsMb = positiveNumEnv(
    "RUNNER_SANDBOX_ROOTFS_MB",
    process.env.RUNNER_SANDBOX_ROOTFS_MB,
    DEFAULT_ROOTFS_MB,
    true,
  );
  const maxExecTimeoutSec = positiveNumEnv(
    "RUNNER_SANDBOX_TIMEOUT_SEC",
    process.env.RUNNER_SANDBOX_TIMEOUT_SEC,
    DEFAULT_TIMEOUT_SEC,
    true,
  );
  const homeQuota = createXfsProjectQuota({
    root: process.env.RUNNER_SANDBOX_HOME_ROOT ?? DEFAULT_HOME_ROOT,
    limitMb: positiveNumEnv("RUNNER_SANDBOX_HOME_MB", process.env.RUNNER_SANDBOX_HOME_MB, DEFAULT_HOME_MB, true),
  });
  await homeQuota.preflight();

  const lifecycle = createDockerLifecycle({
    label: LABEL,
    namePrefix,
    image: imageRef,
    homeDir: process.env.RUNNER_HOME_DIR ?? "/root",
    buildHint: "publish the sandbox rootfs and point RUNNER_SANDBOX_IMAGE at its digest",
    endpointMode: {
      kind: "container-dns",
      attachContainers: [selfContainer, egressProxyContainer].filter((value): value is string => !!value),
    },
    internalNetwork: true,
    waitReady: (resolveEndpoint, name) => agent.waitReady(resolveEndpoint, name),
    dockerExec: dexec,
    cpus,
    memoryMb,
    pidsLimit,
    rootfsMb,
    homeQuota,
    onError: (e) => console.warn(`[runner] ${e.category}/${e.code}: ${e.message}`),
  });

  const databaseUrl = process.env.DATABASE_URL;
  const store = createRunnerStore(databaseUrl);
  const auditLog = databaseUrl ? createPostgresAuditLog(databaseUrl) : createAuditLog();
  const recovery = { store, lifecycle, auditLog };
  const reconciled = await reconcileRunnerBoxes(recovery);
  if (reconciled) console.log(`[runner] recycled ${reconciled} missing or abnormal sandbox container(s)`);

  const server = buildRunnerServer({
    lifecycle,
    agent,
    store,
    signingSecret,
    namePrefix,
    imageRef,
    orgId,
    auditLog,
    maxExecTimeoutSec,
  });

  const bind = await resolveBindAddress(dexec, selfContainer, serviceNetwork);
  const recoverySweeper = createSweeper(() => reconcileRunnerBoxes(recovery), RECOVERY_INTERVAL_MS, {
    label: "runner-recovery",
  });
  recoverySweeper.start();
  server.listen(port, bind, () => console.log(`[runner] listening on ${bind}:${port}`));
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      recoverySweeper.stop();
      server.close(() => process.exit(0));
    });
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[runner] failed to start: ${errMessage(e)}`);
    process.exit(1);
  });
}
