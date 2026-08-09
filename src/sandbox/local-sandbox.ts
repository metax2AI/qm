import { arch } from "node:os";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createBoxSandbox, type BoxIo } from "./box-sandbox.ts";
import { createDockerLifecycle } from "./docker-lifecycle.ts";
import { createGuestAgent } from "./guest-agent-client.ts";
import type { DockerExec } from "./docker-exec.ts";
import type { AgentComputerProfile, Sandbox } from "./sandbox.ts";
import { DOCUMENT_PARSERS_FACT } from "./sandbox.ts";

const DEFAULT_LOCAL_SANDBOX_IMAGE = "qm-sandbox-local:latest";
const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const LABEL = "local";

export type { DockerExec };
export {
  computeSandboxImageFingerprint,
  localContainerName,
  localNetworkName,
  localVolumeName,
} from "./docker-lifecycle.ts";

export interface LocalSandboxOptions {
  image?: string;
  dockerBin?: string;
  cpus?: number;
  memoryMb?: number;
  defaultTimeoutSec?: number;
  homeDir?: string;
  repoRoot?: string;
  dockerExec?: DockerExec;
  fetchImpl?: typeof fetch;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createLocalSandbox(workspace: WorkspaceStore, opts: LocalSandboxOptions = {}): Sandbox {
  const image = opts.image ?? DEFAULT_LOCAL_SANDBOX_IMAGE;
  const homeDir = opts.homeDir ?? HOME_DIR;
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;

  const agent = createGuestAgent({ label: LABEL, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });

  const lifecycle = createDockerLifecycle({
    label: LABEL,
    image,
    homeDir,
    waitReady: (resolveEndpoint, name) => agent.waitReady(resolveEndpoint, name),
    ...(opts.dockerBin ? { dockerBin: opts.dockerBin } : {}),
    ...(opts.dockerExec ? { dockerExec: opts.dockerExec } : {}),
    ...(opts.cpus ? { cpus: opts.cpus } : {}),
    ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
    ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
  });

  const io: BoxIo = {
    exec: async (id, command, timeoutSec, signal) =>
      agent.exec(await lifecycle.endpointOf(id), command, timeoutSec, signal),
    readAbs: async (id, absPath) => agent.readAbs(await lifecycle.endpointOf(id), absPath),
    writeAbs: async (id, absPath, data) => agent.writeAbs(await lifecycle.endpointOf(id), absPath, data),
  };

  const profile: AgentComputerProfile = {
    backend: "local-docker",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: `Debian 12 (bookworm), glibc — local Docker container on a ${arch()} host (dev only)`,
      runtimes: ["Node 24", "Python 3 (venv on PATH — `pip install` just works)", DOCUMENT_PARSERS_FACT],
      tools: ["git", "curl", "wget", "jq", "unzip", "gnupg", "python3", "gh", "aws (CLI v2)"],
      notInstalled: ["gcloud", "kubectl", "flyctl", "glab"],
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      homeDir,
      workdir: workspaceDir,
    },
  };

  return createBoxSandbox({
    label: LABEL,
    workspace,
    lifecycle,
    io,
    profile,
    homeDir,
    workspaceDir,
    defaultTimeoutSec: opts.defaultTimeoutSec ?? 600,
  });
}
