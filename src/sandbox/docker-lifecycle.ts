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
import type { XfsProjectQuota } from "./xfs-project-quota.ts";

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

type SandboxEndpointMode = { kind: "published-port" } | { kind: "container-dns"; attachContainers?: string[] };

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
  pidsLimit?: number;
  rootfsMb?: number;
  homeQuota?: XfsProjectQuota;
  trackHolds?: boolean;
  internalNetwork?: boolean;
  repoRoot?: string;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

interface TeardownOutcome {
  released: boolean;
}

export interface DockerLifecycle extends BoxLifecycle {
  teardownBox(ref: BoxTeardownRef, opts?: TeardownOptions): Promise<TeardownOutcome>;
  endpointOf(name: string): Promise<string>;
  containerNameOf(scopeId: string): string;
  scratchNameOf(key: string): string;
  networkNameOf(containerName: string): string;
  volumeNameOf(scopeId: string): string;
  stateOf(name: string): Promise<DockerContainerState | null>;
  recycle(ref: { id: string; scopeId?: string; scratchKey?: string }): Promise<void>;
}

interface BoxTeardownRef {
  id: string;
  scratch?: boolean;
  scopeId?: string;
}

interface DockerContainerState {
  running: boolean;
  oomKilled: boolean;
  exitCode: number;
  imageId: string;
}

export interface RootfsQuotaProbe {
  enforced: boolean;
  reportedMb?: number;
  detail?: string;
}

const ROOTFS_QUOTA_SLACK = 1.1;

export const DEFAULT_ADDRESS_POOL_NETWORKS = 30;

export interface AddressPoolProbe {
  configured: boolean;
  bridgeNetworks: number;
}

export async function probeAddressPools(dexec: DockerExec): Promise<AddressPoolProbe> {
  const pools = await dexec(["info", "--format", "{{json .DefaultAddressPools}}"], 15_000);
  const declared = pools.code === 0 ? pools.stdout.trim() : "";
  const nets = await dexec(["network", "ls", "--filter", "driver=bridge", "-q"], 15_000);
  return {
    configured: declared !== "" && declared !== "null" && declared !== "[]",
    bridgeNetworks: nets.code === 0 ? nets.stdout.trim().split("\n").filter(Boolean).length : 0,
  };
}

export async function probeRootfsQuota(dexec: DockerExec, image: string, rootfsMb: number): Promise<RootfsQuotaProbe> {
  const r = await dexec(
    ["run", "--rm", "--network", "none", "--storage-opt", `size=${rootfsMb}m`, image, "df", "-k", "/"],
    120_000,
  );
  if (r.code !== 0) return { enforced: false, detail: r.stderr.trim() || r.stdout.trim() };
  const line = r.stdout.trim().split("\n").at(-1) ?? "";
  const blocks = Number(line.trim().split(/\s+/)[1]);
  if (!Number.isFinite(blocks) || blocks <= 0) return { enforced: false, detail: `unreadable df output: ${line}` };
  const reportedMb = Math.round(blocks / 1024);
  return { enforced: reportedMb <= rootfsMb * ROOTFS_QUOTA_SLACK, reportedMb };
}

export function createDockerLifecycle(opts: DockerLifecycleOptions): DockerLifecycle {
  const { label, namePrefix, image, homeDir, buildHint, endpointMode, waitReady } = opts;
  const daemonHint = opts.daemonHint ? ` ${opts.daemonHint}` : "";
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.dockerBin ?? "docker");
  const provisionQueue = createKeyedQueue<string>();
  const byContainerDns = endpointMode.kind === "container-dns";
  const attachContainers = endpointMode.kind === "container-dns" ? (endpointMode.attachContainers ?? []) : [];

  const attachedContainerNetworks = new Set<string>();
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
      const img = await dexec(["image", "inspect", "-f", "{{.Id}}", image], 15_000);
      const imageId = img.stdout.trim();
      if (img.code !== 0 || !imageId) {
        preflightDone = undefined;
        throw new Error(`${label} sandbox image ${image} not found — ${buildHint}`);
      }
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

  async function containerState(name: string): Promise<DockerContainerState | null> {
    const r = await dexec([
      "inspect",
      "-f",
      "{{.State.Running}}\t{{.State.OOMKilled}}\t{{.State.ExitCode}}\t{{.Image}}",
      name,
    ]);
    if (r.code !== 0) return null;
    const [running = "", oomKilled = "", exitCode = "", imageId = ""] = r.stdout.trim().split("\t");
    return {
      running: running === "true",
      oomKilled: oomKilled === "true",
      exitCode: Number(exitCode) || 0,
      imageId,
    };
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

  async function attachContainer(net: string, container: string, refresh: boolean): Promise<void> {
    const key = `${net}\0${container}`;
    if (!refresh && attachedContainerNetworks.has(key)) return;
    const r = await dexec(["network", "connect", net, container]);
    if (r.code !== 0 && !/already exists in network|already connected/i.test(r.stderr)) {
      throw new Error(`docker network connect ${net} ${container} failed: ${r.stderr.trim()}`);
    }
    attachedContainerNetworks.add(key);
  }

  async function ensureNetwork(name: string, refreshPeers = false): Promise<string> {
    const net = networkNameFor(namePrefix, name);
    const inspected = await dexec(["network", "inspect", "-f", "{{.Internal}}", net]);
    if (inspected.code !== 0) {
      const r = await dexec([
        "network",
        "create",
        ...(opts.internalNetwork ? ["--internal"] : []),
        "--label",
        "qm.sandbox=1",
        "--label",
        `qm.org=${configOrgId()}`,
        net,
      ]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
      }
    } else if (opts.internalNetwork && inspected.stdout.trim() !== "true") {
      throw new Error(`${label} sandbox network ${net} must be internal`);
    }
    for (const container of attachContainers) await attachContainer(net, container, refreshPeers);
    return net;
  }

  async function ensureReachable(name: string, refreshPeers = false): Promise<void> {
    if (byContainerDns) await ensureNetwork(name, refreshPeers);
  }

  async function runContainer(name: string, scope: string | undefined, withVolume: boolean): Promise<void> {
    const net = await ensureNetwork(name);
    let homeArgs: string[] = [];
    if (withVolume && scope) {
      homeArgs = opts.homeQuota
        ? ["--mount", `type=bind,src=${opts.homeQuota.sourceOf(scope)},dst=${homeDir}`]
        : ["-v", `${volumeNameFor(namePrefix, scope)}:${homeDir}`];
    }
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
      ...homeArgs,
      ...(byContainerDns ? [] : ["-p", `127.0.0.1:0:${AGENT_PORT}`, "--add-host=host.docker.internal:host-gateway"]),
      ...(opts.cpus ? ["--cpus", String(opts.cpus)] : []),
      ...(opts.memoryMb ? ["--memory", `${opts.memoryMb}m`, "--memory-swap", `${opts.memoryMb}m`] : []),
      ...(opts.pidsLimit ? ["--pids-limit", String(opts.pidsLimit)] : []),
      ...(opts.rootfsMb ? ["--storage-opt", `size=${opts.rootfsMb}m`] : []),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      image,
    ];
    const r = await dexec(args, 120_000);
    if (r.code !== 0) throw new Error(`docker run ${name} failed: ${r.stderr.trim()}`);
    portByName.delete(name);
    await waitDaemon(name);
  }

  async function removeNetwork(containerName: string, swallowLabel: string, strict = false): Promise<void> {
    const net = networkNameFor(namePrefix, containerName);
    for (const container of attachContainers) {
      await dexec(["network", "disconnect", "-f", net, container]).catch(
        swallowAs(`${swallowLabel}: disconnect ${container}`, undefined),
      );
    }
    for (const key of attachedContainerNetworks) if (key.startsWith(`${net}\0`)) attachedContainerNetworks.delete(key);
    const removed = await dexec(["network", "rm", net]).catch((error) => {
      if (strict) throw error;
      return undefined;
    });
    if (
      strict &&
      removed &&
      removed.code !== 0 &&
      !/not found|no such network/i.test(`${removed.stderr}\n${removed.stdout}`)
    ) {
      throw new Error(`docker network rm ${net} failed: ${removed.stderr.trim() || removed.stdout.trim()}`);
    }
    if (!strict && removed && removed.code !== 0) {
      swallowAs(swallowLabel, undefined)(new Error(removed.stderr.trim()));
    }
  }

  async function removeDockerObject(args: string[], missing: RegExp, action: string): Promise<void> {
    const result = await dexec(args);
    if (result.code !== 0 && !missing.test(`${result.stderr}\n${result.stdout}`)) {
      throw new Error(`${action} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  async function ensureVolume(scope: string): Promise<boolean> {
    if (opts.homeQuota) return !(await opts.homeQuota.ensure(scope)).coldStart;
    const volume = volumeNameFor(namePrefix, scope);
    const hadVolume = (await dexec(["volume", "inspect", volume])).code === 0;
    if (!hadVolume) {
      const created = await dexec(["volume", "create", volume]);
      if (created.code !== 0) throw new Error(`docker volume create ${volume} failed: ${created.stderr.trim()}`);
    }
    return hadVolume;
  }

  function teardownQueueKey(ref: BoxTeardownRef): string {
    if (ref.scratch) {
      for (const [k, name] of scratchByKey) if (name === ref.id) return `scratch:${k}`;
      return ref.id;
    }
    return ref.scopeId ?? scopeByContainer.get(ref.id) ?? ref.id;
  }

  async function teardownBox(ref: BoxTeardownRef, tdOpts?: TeardownOptions): Promise<TeardownOutcome> {
    return provisionQueue(teardownQueueKey(ref), async () => {
      if (opts.trackHolds !== false) {
        const remaining = (activeByContainer.get(ref.id) ?? 1) - 1;
        if (remaining > 0) {
          activeByContainer.set(ref.id, remaining);
          return { released: false };
        }
        activeByContainer.delete(ref.id);
      }
      const scope = ref.scopeId ?? scopeByContainer.get(ref.id);

      if (ref.scratch) {
        for (const [k, name] of scratchByKey) if (name === ref.id) scratchByKey.delete(k);
        if (tdOpts?.destroy)
          await removeDockerObject(["rm", "-f", ref.id], /no such (object|container)/i, `docker rm ${ref.id}`);
        else await dexec(["rm", "-f", ref.id]).catch(swallowAs(`${label}-sandbox: scratch rm`, undefined));
        await removeNetwork(ref.id, `${label}-sandbox: scratch network rm`, !!tdOpts?.destroy);
        portByName.delete(ref.id);
        return { released: true };
      }

      if (tdOpts?.keepWarm) return { released: true };

      if (tdOpts?.destroy) {
        await removeDockerObject(["rm", "-f", ref.id], /no such (object|container)/i, `docker rm ${ref.id}`);
        await removeNetwork(ref.id, `${label}-sandbox: destroy network rm`, true);
        if (scope) {
          if (opts.homeQuota) await opts.homeQuota.destroy(scope);
          else {
            const volume = volumeNameFor(namePrefix, scope);
            await removeDockerObject(
              ["volume", "rm", volume],
              /no such volume|not found/i,
              `docker volume rm ${volume}`,
            );
          }
        }
        scopeByContainer.delete(ref.id);
        portByName.delete(ref.id);
        return { released: true };
      }

      const r = await dexec(["stop", "-t", "2", ref.id], 60_000);
      if (r.code !== 0)
        opts.onError?.({
          category: "sandbox_park",
          code: "docker_stop_failed",
          message: r.stderr.trim(),
          ...(scope ? { scopeLabel: scope } : {}),
        });
      if (r.code !== 0) throw new Error(`docker stop ${ref.id} failed: ${r.stderr.trim() || r.stdout.trim()}`);
      portByName.delete(ref.id);
      return { released: true };
    });
  }

  return {
    endpointOf,
    containerNameOf: (scope) => containerNameFor(namePrefix, scope),
    scratchNameOf: (key) => scratchNameFor(namePrefix, key),
    networkNameOf: (containerName) => networkNameFor(namePrefix, containerName),
    volumeNameOf: (scope) => opts.homeQuota?.sourceOf(scope) ?? volumeNameFor(namePrefix, scope),
    stateOf: containerState,

    async ensureScope(scope: string): Promise<BoxRef> {
      return provisionQueue(scope, async () => {
        const imageId = await preflight();
        const name = containerNameFor(namePrefix, scope);
        scopeByContainer.set(name, scope);
        const state = await containerState(name);
        if (state && state.imageId === imageId) {
          await ensureReachable(name, true);
          if (!state.running) await startContainer(name);
          if (opts.trackHolds !== false) activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
          return { id: name, coldStart: false };
        }
        if (state) await dexec(["rm", "-f", name]);
        const hadVolume = await ensureVolume(scope);
        await runContainer(name, scope, true);
        if (opts.trackHolds !== false) activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
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
          await ensureReachable(name, true);
          if (!state.running) await startContainer(name);
          if (opts.trackHolds !== false) activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
          return { id: name, coldStart: false };
        }
        await runContainer(name, undefined, false);
        if (opts.trackHolds !== false) activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { id: name, coldStart: true };
      });
    },

    async ensureRunning(name: string): Promise<void> {
      await ensureReachable(name);
      const state = await containerState(name);
      if (!state) throw new Error(`${label} sandbox container ${name} is gone`);
      if (!state.running) await startContainer(name);
    },

    async recycle(ref: { id: string; scopeId?: string; scratchKey?: string }): Promise<void> {
      return provisionQueue(ref.scopeId ?? (ref.scratchKey ? `scratch:${ref.scratchKey}` : ref.id), async () => {
        await dexec(["rm", "-f", ref.id]);
        portByName.delete(ref.id);
        if (ref.scopeId) {
          scopeByContainer.set(ref.id, ref.scopeId);
          await ensureVolume(ref.scopeId);
          await runContainer(ref.id, ref.scopeId, true);
          return;
        }
        if (ref.scratchKey) {
          scratchByKey.set(ref.scratchKey, ref.id);
          await runContainer(ref.id, undefined, false);
          return;
        }
        throw new Error(`${label} sandbox ${ref.id}: cannot recycle without scopeId or scratchKey`);
      });
    },

    teardown: async (ref, tdOpts) => void (await teardownBox(ref, tdOpts)),
    teardownBox,
  };
}
