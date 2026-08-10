import { randomUUID } from "node:crypto";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { ephemeralCredLinkPaths, ephemeralCredLinkScript } from "../credentials/resident-paths.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createExecBackup, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";

const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";

export interface BoxRef {
  id: string;
  coldStart: boolean;
  acquisitionId?: string;
}

export interface BoxLifecycle {
  ensureScope(scopeId: string): Promise<BoxRef>;
  ensureScratch(key: string): Promise<BoxRef>;
  ensureRunning(id: string): Promise<void>;
  teardown(ref: { id: string; scratch?: boolean; acquisitionId?: string }, opts?: TeardownOptions): Promise<void>;
}

export interface BoxIo {
  exec(
    id: string,
    command: string,
    timeoutSec: number,
    signal?: AbortSignal,
    acquisitionId?: string,
  ): Promise<ExecResult>;
  readAbs(id: string, absPath: string, acquisitionId?: string): Promise<Uint8Array | null>;
  writeAbs(id: string, absPath: string, data: Uint8Array, acquisitionId?: string): Promise<void>;
}

export interface BoxSandboxOptions {
  label: string;
  workspace: WorkspaceStore;
  lifecycle: BoxLifecycle;
  io: BoxIo;
  profile: AgentComputerProfile;
  homeDir: string;
  workspaceDir: string;
  defaultTimeoutSec: number;
}

export function createBoxSandbox(opts: BoxSandboxOptions): Sandbox {
  const { label, workspace, lifecycle, io, profile, homeDir, workspaceDir, defaultTimeoutSec } = opts;

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await lifecycle.ensureRunning(handle.id);
      return io.exec(handle.id, command, timeoutSec, undefined, handle.acquisitionId);
    },
  };
  const procSessions = createExecProcessSessions(procIo);

  const execFileOps = createExecFileOps({
    label,
    exec: (id, script, t, acquisitionId) => io.exec(id, script, t, undefined, acquisitionId),
    writeInline: (id, abs, data, _label, acquisitionId) => io.writeAbs(id, abs, data, acquisitionId),
  });

  const execBackup = createExecBackup({
    label,
    exec: (id, script, t, acquisitionId) => io.exec(id, script, t, undefined, acquisitionId),
    readAbsBytes: (id, abs, acquisitionId) => io.readAbs(id, abs, acquisitionId),
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths().map(({ rel }) => rel),
  });

  const sandbox: Sandbox = {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = writable?.scopeId ?? "default";
      const body = scratch ? await lifecycle.ensureScratch(scratch.key) : await lifecycle.ensureScope(scope);
      const name = body.id;

      const env = provOpts?.env && Object.keys(provOpts.env).length ? provOpts.env : undefined;
      const handle: SandboxHandle = {
        id: name,
        ...(body.acquisitionId ? { acquisitionId: body.acquisitionId } : {}),
        rootDir: workspaceDir,
        homeDir,
        coldStart: body.coldStart,
        ...(scratch ? { scratch: true } : {}),
        ...(env ? { env } : {}),
      };

      try {
        const prep = await io.exec(
          name,
          `mkdir -p ${shq(workspaceDir)} && ${ephemeralCredLinkScript(homeDir)}`,
          30,
          undefined,
          body.acquisitionId,
        );
        if (prep.code !== 0) throw new Error(`${label} sandbox provision prep failed: ${prep.stderr.slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => io.exec(name, script, t, undefined, body.acquisitionId),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label },
        );

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs(`${label}-sandbox: teardown after failed provision`, undefined));
        throw err;
      }
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await lifecycle.ensureRunning(handle.id);
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      const signal = execOpts?.signal;
      if (!signal) return io.exec(handle.id, script, timeoutSec, undefined, handle.acquisitionId);
      const killUid = randomUUID();
      const fireKill = () => {
        io.exec(handle.id, killScript(killUid), 15, undefined, handle.acquisitionId).catch(
          swallowAs(`${label}-sandbox: kill in-flight exec`, undefined),
        );
      };
      if (signal.aborted) fireKill();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await io.exec(handle.id, killableScript(script, killUid), timeoutSec, signal, handle.acquisitionId);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await io.writeAbs(handle.id, posixJoin(handle.rootDir, relPath), data, handle.acquisitionId);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return io.readAbs(handle.id, posixJoin(handle.rootDir, relPath), handle.acquisitionId);
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    backupComputer: execBackup.backupComputer,

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      await lifecycle.teardown(
        {
          id: handle.id,
          ...(handle.scratch ? { scratch: true } : {}),
          ...(handle.acquisitionId ? { acquisitionId: handle.acquisitionId } : {}),
        },
        tdOpts,
      );
    },
  };

  return sandbox;
}
