import { randomUUID } from "node:crypto";
import { arch } from "node:os";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { WorkspaceLayer } from "../types.ts";
import { isStrongSigningSecret, MIN_SIGNING_SECRET_LENGTH } from "../auth/source-auth.ts";
import { signedRequestHeaders } from "../auth/source-auth-sign.ts";
import { runnerBoxPath, runnerEnsurePath } from "../runner/protocol.ts";
import type {
  RunnerEnsureResponse,
  RunnerExecResponse,
  RunnerReadResponse,
  RunnerTeardownRequest,
} from "../runner/protocol.ts";
import { GUEST_TRANSFER_TIMEOUT_MS } from "./guest-agent-client.ts";
import { createBoxSandbox, type BoxIo, type BoxLifecycle, type BoxRef } from "./box-sandbox.ts";
import type { AgentComputerProfile, ExecResult, ProvisionOptions, Sandbox, TeardownOptions } from "./sandbox.ts";
import { DOCUMENT_PARSERS_FACT } from "./sandbox.ts";
import { authenticatedProxyEnv, DROPPED_PROXY_ENV } from "./sandbox-env.ts";

const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const LABEL = "runner";
const EXEC_OVERHEAD_MS = 30_000;
const CONTROL_TIMEOUT_MS = 180_000;

export interface RunnerSandboxOptions {
  baseUrl: string;
  signingSecret: string;
  cpus?: number;
  memoryMb?: number;
  defaultTimeoutSec?: number;
  homeDir?: string;
  egressProxyUrl?: string;
  residentEnv?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

class RunnerApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RunnerApiError";
    this.status = status;
  }
}

export function createRunnerSandbox(workspace: WorkspaceStore, opts: RunnerSandboxOptions): Sandbox {
  if (!isStrongSigningSecret(opts.signingSecret)) {
    throw new Error(`SANDBOX_RUNNER_SECRET must be at least ${MIN_SIGNING_SECRET_LENGTH} characters`);
  }
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const homeDir = opts.homeDir ?? HOME_DIR;
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;

  async function call<T>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
    const pathWithQuery = `${path}?n=${randomUUID()}`;
    const payload = JSON.stringify(body ?? {});
    const headers = signedRequestHeaders(opts.signingSecret, "POST", pathWithQuery, payload, {
      "content-type": "application/json",
    });
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    const res = await fetchImpl(`${base}${pathWithQuery}`, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.any(signals),
    });
    const text = await res.text();
    if (res.status === 404) return null;
    if (!res.ok) throw new RunnerApiError(`runner POST ${path} -> ${res.status}: ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function required<T>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const out = await call<T>(path, body, timeoutMs, signal);
    if (out === null) throw new RunnerApiError(`runner POST ${path} -> 404`, 404);
    return out;
  }

  const lifecycle: BoxLifecycle = {
    async ensureScope(scopeId: string): Promise<BoxRef> {
      const r = await required<RunnerEnsureResponse>(runnerEnsurePath(), { scopeId }, CONTROL_TIMEOUT_MS);
      return { id: r.id, coldStart: !!r.coldStart };
    },
    async ensureScratch(key: string): Promise<BoxRef> {
      const r = await required<RunnerEnsureResponse>(runnerEnsurePath(), { scratchKey: key }, CONTROL_TIMEOUT_MS);
      return { id: r.id, coldStart: !!r.coldStart };
    },
    async ensureRunning(): Promise<void> {},
    async teardown(ref, tdOpts?: TeardownOptions): Promise<void> {
      const body: RunnerTeardownRequest = {
        ...(ref.scratch ? { scratch: true } : {}),
        ...(tdOpts?.keepWarm ? { keepWarm: true } : {}),
        ...(tdOpts?.destroy ? { destroy: true } : {}),
      };
      await required(runnerBoxPath(ref.id, "teardown"), body, CONTROL_TIMEOUT_MS);
    },
  };

  const io: BoxIo = {
    async exec(id, command, timeoutSec, signal): Promise<ExecResult> {
      const r = await required<RunnerExecResponse>(
        runnerBoxPath(id, "exec"),
        { cmd: command, timeoutSec },
        timeoutSec * 1000 + EXEC_OVERHEAD_MS,
        signal,
      );
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code, timedOut: !!r.timedOut };
    },
    async readAbs(id, absPath): Promise<Uint8Array | null> {
      const r = await call<RunnerReadResponse>(runnerBoxPath(id, "read"), { path: absPath }, GUEST_TRANSFER_TIMEOUT_MS);
      return r === null ? null : Buffer.from(r.b64, "base64");
    },
    async writeAbs(id, absPath, data): Promise<void> {
      await required(
        runnerBoxPath(id, "write"),
        { path: absPath, b64: Buffer.from(data).toString("base64") },
        GUEST_TRANSFER_TIMEOUT_MS,
      );
    },
  };

  const profile: AgentComputerProfile = {
    backend: "onprem-runner",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
    spec: {
      os: `Debian 12 (bookworm), glibc — on-prem container on a ${arch()} host`,
      runtimes: ["Node 24", "Python 3 (venv on PATH)", DOCUMENT_PARSERS_FACT],
      tools: ["git", "curl", "wget", "jq", "unzip", "gnupg", "python3"],
      notInstalled: ["gcloud", "kubectl", "flyctl", "glab"],
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      homeDir,
      workdir: workspaceDir,
    },
  };

  const box = createBoxSandbox({
    label: LABEL,
    workspace,
    lifecycle,
    io,
    profile,
    homeDir,
    workspaceDir,
    defaultTimeoutSec: opts.defaultTimeoutSec ?? 600,
  });

  return {
    ...box,
    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions) {
      const { env: suppliedEnv, ...rest } = provOpts ?? {};
      const turnEnv = Object.fromEntries(
        Object.entries({ ...opts.residentEnv, ...suppliedEnv }).filter(([key]) => !DROPPED_PROXY_ENV.has(key)),
      );
      const forceEgress = !!opts.egressProxyUrl && !!provOpts?.egressToken;
      const env = {
        ...turnEnv,
        ...(forceEgress ? authenticatedProxyEnv(opts.egressProxyUrl!, provOpts!.egressToken!) : {}),
      };
      return box.provision(layers, { ...rest, ...(Object.keys(env).length ? { env } : {}) });
    },
  };
}
