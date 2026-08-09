import { orgId as configOrgId } from "./config.ts";
import { isStrongSigningSecret, MIN_SIGNING_SECRET_LENGTH } from "./auth/source-auth.ts";
import { createDockerLifecycle } from "./sandbox/docker-lifecycle.ts";
import { createGuestAgent } from "./sandbox/guest-agent-client.ts";
import { spawnDockerExec, type DockerExec } from "./sandbox/docker-exec.ts";
import { buildRunnerServer } from "./runner/server.ts";
import { createRunnerStore } from "./runner/store.ts";
import { errMessage } from "./util/errors.ts";

const LABEL = "runner";
const NAME_PREFIX = "qmr";
const DEFAULT_PORT = 48090;

function numEnv(v: string | undefined): number | undefined {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

export async function resolveBindAddress(
  dexec: DockerExec,
  selfContainer: string | undefined,
  network: string | undefined,
): Promise<string> {
  if (!selfContainer || !network) return "0.0.0.0";
  const r = await dexec([
    "inspect",
    "-f",
    `{{with index .NetworkSettings.Networks ${JSON.stringify(network)}}}{{.IPAddress}}{{end}}`,
    selfContainer,
  ]);
  const ip = r.stdout.trim();
  if (r.code !== 0 || !ip) {
    console.warn(
      `[runner] cannot resolve this container's address on ${network} — binding 0.0.0.0, so the API is reachable from every attached sandbox network`,
    );
    return "0.0.0.0";
  }
  return ip;
}

async function main(): Promise<void> {
  const port = numEnv(process.env.RUNNER_PORT) ?? DEFAULT_PORT;
  const signingSecret = process.env.SANDBOX_RUNNER_SECRET ?? "";
  if (!isStrongSigningSecret(signingSecret)) {
    console.error(`[runner] SANDBOX_RUNNER_SECRET must be at least ${MIN_SIGNING_SECRET_LENGTH} characters`);
    process.exit(1);
  }
  const imageRef = process.env.RUNNER_SANDBOX_IMAGE;
  if (!imageRef) {
    console.error("[runner] RUNNER_SANDBOX_IMAGE must name the digest-pinned sandbox rootfs to boot");
    process.exit(1);
  }

  const dexec = spawnDockerExec(process.env.RUNNER_DOCKER_BIN ?? "docker");
  const selfContainer = process.env.RUNNER_SELF_CONTAINER ?? process.env.HOSTNAME;
  const serviceNetwork = process.env.RUNNER_SERVICE_NETWORK;
  const agent = createGuestAgent({ label: LABEL });

  const lifecycle = createDockerLifecycle({
    label: LABEL,
    namePrefix: NAME_PREFIX,
    image: imageRef,
    homeDir: process.env.RUNNER_HOME_DIR ?? "/root",
    buildHint: "publish the sandbox rootfs and point RUNNER_SANDBOX_IMAGE at its digest",
    endpointMode: { kind: "container-dns", ...(selfContainer ? { selfContainer } : {}) },
    waitReady: (resolveEndpoint, name) => agent.waitReady(resolveEndpoint, name),
    dockerExec: dexec,
    ...(numEnv(process.env.RUNNER_SANDBOX_CPUS) ? { cpus: numEnv(process.env.RUNNER_SANDBOX_CPUS)! } : {}),
    ...(numEnv(process.env.RUNNER_SANDBOX_MEMORY_MB)
      ? { memoryMb: numEnv(process.env.RUNNER_SANDBOX_MEMORY_MB)! }
      : {}),
    onError: (e) => console.warn(`[runner] ${e.category}/${e.code}: ${e.message}`),
  });

  const store = createRunnerStore(process.env.DATABASE_URL);
  const reconciled = await reconcile(store, dexec);
  if (reconciled) console.log(`[runner] pruned ${reconciled} record(s) whose container no longer exists`);

  const server = buildRunnerServer({
    lifecycle,
    agent,
    store,
    signingSecret,
    namePrefix: NAME_PREFIX,
    imageRef,
    orgId: configOrgId(),
  });

  const bind = await resolveBindAddress(dexec, selfContainer, serviceNetwork);
  server.listen(port, bind, () => console.log(`[runner] listening on ${bind}:${port}`));
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

export async function reconcile(store: ReturnType<typeof createRunnerStore>, dexec: DockerExec): Promise<number> {
  let pruned = 0;
  for (const [id] of await store.entries()) {
    const r = await dexec(["inspect", "-f", "{{.Id}}", id]);
    if (r.code !== 0) {
      await store.delete(id);
      pruned++;
    }
  }
  return pruned;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[runner] failed to start: ${errMessage(e)}`);
    process.exit(1);
  });
}
