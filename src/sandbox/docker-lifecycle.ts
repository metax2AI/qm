import { createHash } from "node:crypto";
import { join } from "node:path";
import { readdir, readFile as fsReadFile } from "node:fs/promises";
import { orgId as configOrgId } from "../config.ts";
import { createKeyedQueue } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { shortHash } from "../util/crypto.ts";
import { spawnDockerExec, type DockerExec } from "./docker-exec.ts";
import type { BoxLifecycle, BoxRef } from "./box-sandbox.ts";
import type { TeardownOptions } from "./sandbox.ts";

const AGENT_PORT = 8080;
const FINGERPRINT_LABEL = "qm.sandbox-fingerprint";
const FINGERPRINT_FIXED_SOURCES = ["fly/Dockerfile", "local/Dockerfile", "aws/microvm-agent/agent.mjs"];
const LOCAL_NAME_PREFIX = "qm";

export async function computeSandboxImageFingerprint(repoRoot: string): Promise<string | null> {
  try {
    const tools = (await readdir(join(repoRoot, "fly/tools"))).sort().map((f) => `fly/tools/${f}`);
    const paths = [...FINGERPRINT_FIXED_SOURCES, ...tools].sort();
    const fp = createHash("sha256");
    for (const p of paths) {
      fp.update(p);
      fp.update("\0");
      fp.update(
        createHash("sha256")
          .update(await fsReadFile(join(repoRoot, p)))
          .digest(),
      );
      fp.update("\n");
    }
    return fp.digest("hex");
  } catch {
    return null;
  }
}

const containerNameFor = (prefix: string, scopeId: string): string => `${prefix}-sbx-${localSlug(scopeId)}`;
const volumeNameFor = (prefix: string, scopeId: string): string => `${prefix}-home-${localSlug(scopeId)}`;
const scratchNameFor = (prefix: string, key: string): string => `${prefix}-scratch-${localSlug(key)}`;

function networkNameFor(prefix: string, containerName: string): string {
  for (const kind of ["sbx", "scratch"]) {
    const head = `${prefix}-${kind}-`;
    if (containerName.startsWith(head)) return `${prefix}-net-${containerName.slice(head.length)}`;
  }
  return `${prefix}-net-${containerName}`;
}

export const localContainerName = (scopeId: string): string => containerNameFor(LOCAL_NAME_PREFIX, scopeId);
export const localVolumeName = (scopeId: string): string => volumeNameFor(LOCAL_NAME_PREFIX, scopeId);
export const localNetworkName = (containerName: string): string => networkNameFor(LOCAL_NAME_PREFIX, containerName);

function localSlug(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
}

type SandboxEndpointMode = { kind: "published-port" } | { kind: "container-dns"; selfContainer?: string };

export interface DockerLifecycleOptions {
  label: string;
  namePrefix: string;
  image: string;
  homeDir: string;
  buildHint: string;
  endpointMode: SandboxEndpointMode;
  daemonHint?: string;
  waitReady(resolveEndpoint: () => Promise<string>, name: string): Promise<void>;
  dockerBin?: string;
  dockerExec?: DockerExec;
  cpus?: number;
  memoryMb?: number;
  repoRoot?: string;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export interface DockerLifecycle extends BoxLifecycle {
  endpointOf(name: string): Promise<string>;
  networkNameOf(containerName: string): string;
  volumeNameOf(scopeId: string): string;
}

export function createDockerLifecycle(opts: DockerLifecycleOptions): DockerLifecycle {
  const { label, namePrefix, image, homeDir, buildHint, endpointMode, waitReady } = opts;
  const daemonHint = opts.daemonHint ? ` ${opts.daemonHint}` : "";
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.dockerBin ?? "docker");
  const provisionQueue = createKeyedQueue<string>();
  const byContainerDns = endpointMode.kind === "container-dns";
  const selfContainer = endpointMode.kind === "container-dns" ? endpointMode.selfContainer : undefined;

  const selfAttached = new Set<string>();
  const portByName = new Map<string, number>();
  const scopeByContainer = new Map<string, string>();
  const scratchByKey = new Map<string, string>();
  const activeByContainer = new Map<string, number>();

  let preflightDone: Promise<string> | undefined;
  let staleWarned = false;

  async function preflight(): Promise<string> {
    preflightDone ??= (async () => {
      const version = await dexec(["version"], 15_000);
      if (version.code !== 0) {
        preflightDone = undefined;
        throw new Error(`SANDBOX_BACKEND=${label} requires a running Docker daemon${daemonHint}`);
      }
      const img = await dexec(["image", "ls", "--format", `{{.Repository}}:{{.Tag}} {{.ID}}`], 15_000);
      const line = img.stdout.split("\n").find((l) => l.startsWith(`${image} `));
      if (img.code !== 0 || !line) {
        preflightDone = undefined;
        throw new Error(`${label} sandbox image ${image} not found — ${buildHint}`);
      }
      const imageId = line.split(/\s+/)[1] ?? "";
      const want = await computeSandboxImageFingerprint(opts.repoRoot ?? process.cwd());
      if (!staleWarned && want && imageId) {
        const labeled = await dexec([
          "image",
          "inspect",
          "-f",
          `{{index .Config.Labels "${FINGERPRINT_LABEL}"}}`,
          imageId,
        ]);
        const fingerprint = labeled.code === 0 ? labeled.stdout.trim() : "";
        if (fingerprint && fingerprint !== want) {
          staleWarned = true;
          console.warn(`[${label}-sandbox] sandbox image ${image} is stale — ${buildHint}`);
        }
      }
      return imageId;
    })();
    return preflightDone;
  }

  async function containerState(name: string): Promise<{ running: boolean; imageId: string } | null> {
    const r = await dexec(["inspect", "-f", "{{.State.Running}} {{.Image}}", name]);
    if (r.code !== 0) return null;
    const [running = "", imageId = ""] = r.stdout.trim().split(/\s+/);
    return { running: running === "true", imageId };
  }

  async function resolvePort(name: string): Promise<number> {
    const cached = portByName.get(name);
    if (cached) return cached;
    const r = await dexec(["port", name, `${AGENT_PORT}/tcp`]);
    const m = r.stdout
      .split("\n")[0]
      ?.trim()
      .match(/:(\d+)$/);
    if (r.code !== 0 || !m)
      throw new Error(`${label} sandbox ${name}: cannot resolve agent port: ${r.stderr.trim() || r.stdout.trim()}`);
    const port = Number(m[1]);
    portByName.set(name, port);
    return port;
  }

  async function endpointOf(name: string): Promise<string> {
    if (byContainerDns) return `http://${name}:${AGENT_PORT}`;
    return `http://127.0.0.1:${await resolvePort(name)}`;
  }

  async function waitDaemon(name: string): Promise<void> {
    await waitReady(() => endpointOf(name), name);
  }

  async function startContainer(name: string): Promise<void> {
    portByName.delete(name);
    const r = await dexec(["start", name]);
    if (r.code !== 0) throw new Error(`docker start ${name} failed: ${r.stderr.trim()}`);
    await waitDaemon(name);
  }

  async function attachSelf(net: string): Promise<void> {
    if (!selfContainer || selfAttached.has(net)) return;
    const r = await dexec(["network", "connect", net, selfContainer]);
    if (r.code !== 0 && !/already exists in network|already connected/i.test(r.stderr)) {
      throw new Error(`docker network connect ${net} ${selfContainer} failed: ${r.stderr.trim()}`);
    }
    selfAttached.add(net);
  }

  async function ensureNetwork(name: string): Promise<string> {
    const net = networkNameFor(namePrefix, name);
    if ((await dexec(["network", "inspect", net])).code !== 0) {
      const r = await dexec(["network", "create", net]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
      }
    }
    await attachSelf(net);
    return net;
  }

  async function ensureReachable(name: string): Promise<void> {
    if (byContainerDns) await ensureNetwork(name);
  }

  async function runContainer(name: string, scope: string | undefined, withVolume: boolean): Promise<void> {
    const net = await ensureNetwork(name);
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "qm.sandbox=1",
      ...(scope ? ["--label", `qm.scope=${scope}`] : []),
      "--label",
      `qm.org=${configOrgId()}`,
      "--label",
      "agent_env=dev",
      "--network",
      net,
      ...(withVolume && scope ? ["-v", `${volumeNameFor(namePrefix, scope)}:${homeDir}`] : []),
      ...(byContainerDns ? [] : ["-p", `127.0.0.1:0:${AGENT_PORT}`, "--add-host=host.docker.internal:host-gateway"]),
      ...(opts.cpus ? ["--cpus", String(opts.cpus)] : []),
      ...(opts.memoryMb ? ["--memory", `${opts.memoryMb}m`] : []),
      image,
    ];
    const r = await dexec(args, 120_000);
    if (r.code !== 0) throw new Error(`docker run ${name} failed: ${r.stderr.trim()}`);
    portByName.delete(name);
    await waitDaemon(name);
  }

  async function removeNetwork(containerName: string, swallowLabel: string): Promise<void> {
    const net = networkNameFor(namePrefix, containerName);
    selfAttached.delete(net);
    await dexec(["network", "rm", net]).catch(swallowAs(swallowLabel, undefined));
  }

  function teardownQueueKey(ref: { id: string; scratch?: boolean }): string {
    if (ref.scratch) {
      for (const [k, name] of scratchByKey) if (name === ref.id) return `scratch:${k}`;
      return ref.id;
    }
    return scopeByContainer.get(ref.id) ?? ref.id;
  }

  return {
    endpointOf,
    networkNameOf: (containerName) => networkNameFor(namePrefix, containerName),
    volumeNameOf: (scope) => volumeNameFor(namePrefix, scope),

    async ensureScope(scope: string): Promise<BoxRef> {
      return provisionQueue(scope, async () => {
        const imageId = await preflight();
        const name = containerNameFor(namePrefix, scope);
        scopeByContainer.set(name, scope);
        const state = await containerState(name);
        if (state && state.imageId === imageId) {
          await ensureReachable(name);
          if (!state.running) await startContainer(name);
          activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
          return { id: name, coldStart: false };
        }
        if (state) await dexec(["rm", "-f", name]);
        const volume = volumeNameFor(namePrefix, scope);
        const hadVolume = (await dexec(["volume", "inspect", volume])).code === 0;
        if (!hadVolume) {
          const created = await dexec(["volume", "create", volume]);
          if (created.code !== 0) throw new Error(`docker volume create ${volume} failed: ${created.stderr.trim()}`);
        }
        await runContainer(name, scope, true);
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { id: name, coldStart: !hadVolume };
      });
    },

    async ensureScratch(key: string): Promise<BoxRef> {
      return provisionQueue(`scratch:${key}`, async () => {
        await preflight();
        const name = scratchNameFor(namePrefix, key);
        scratchByKey.set(key, name);
        const state = await containerState(name);
        if (state) {
          await ensureReachable(name);
          if (!state.running) await startContainer(name);
          activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
          return { id: name, coldStart: false };
        }
        await runContainer(name, undefined, false);
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { id: name, coldStart: true };
      });
    },

    async ensureRunning(name: string): Promise<void> {
      await ensureReachable(name);
      const state = await containerState(name);
      if (!state) throw new Error(`${label} sandbox container ${name} is gone`);
      if (!state.running) await startContainer(name);
    },

    async teardown(ref: { id: string; scratch?: boolean }, tdOpts?: TeardownOptions): Promise<void> {
      return provisionQueue(teardownQueueKey(ref), async () => {
        const remaining = (activeByContainer.get(ref.id) ?? 1) - 1;
        if (remaining > 0) {
          activeByContainer.set(ref.id, remaining);
          return;
        }
        activeByContainer.delete(ref.id);

        if (ref.scratch) {
          for (const [k, name] of scratchByKey) if (name === ref.id) scratchByKey.delete(k);
          if (tdOpts?.destroy) await dexec(["rm", "-f", ref.id]);
          else await dexec(["rm", "-f", ref.id]).catch(swallowAs(`${label}-sandbox: scratch rm`, undefined));
          await removeNetwork(ref.id, `${label}-sandbox: scratch network rm`);
          portByName.delete(ref.id);
          return;
        }

        if (tdOpts?.keepWarm) return;

        if (tdOpts?.destroy) {
          await dexec(["rm", "-f", ref.id]).catch(swallowAs(`${label}-sandbox: destroy rm`, undefined));
          await removeNetwork(ref.id, `${label}-sandbox: destroy network rm`);
          const scope = scopeByContainer.get(ref.id);
          if (scope)
            await dexec(["volume", "rm", volumeNameFor(namePrefix, scope)]).catch(
              swallowAs(`${label}-sandbox: destroy volume rm`, undefined),
            );
          scopeByContainer.delete(ref.id);
          portByName.delete(ref.id);
          return;
        }

        const r = await dexec(["stop", "-t", "2", ref.id], 60_000);
        if (r.code !== 0)
          opts.onError?.({
            category: "sandbox_park",
            code: "docker_stop_failed",
            message: r.stderr.trim(),
            ...(scopeByContainer.get(ref.id) ? { scopeLabel: scopeByContainer.get(ref.id)! } : {}),
          });
        portByName.delete(ref.id);
      });
    },
  };
}
