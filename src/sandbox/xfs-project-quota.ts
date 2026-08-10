import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface QuotaExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type QuotaExec = (args: string[]) => Promise<QuotaExecResult>;

export interface XfsProjectQuota {
  preflight(): Promise<void>;
  ensure(scope: string): Promise<{ source: string; coldStart: boolean }>;
  destroy(scope: string): Promise<void>;
  sourceOf(scope: string): string;
}

export function xfsScopeHash(scope: string): string {
  return createHash("sha256").update(scope).digest("hex");
}

export function xfsProjectId(scope: string): number {
  const raw = createHash("sha256").update(scope).digest().readUInt32BE(0);
  return 10_000 + (raw % (2_147_483_647 - 10_000));
}

function spawnQuotaExec(binary: string): QuotaExec {
  return async (args) =>
    new Promise((resolve) => {
      const child = spawn(binary, args, { timeout: 60_000, killSignal: "SIGKILL" });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

export function createXfsProjectQuota(opts: {
  root: string;
  limitMb: number;
  quotaExec?: QuotaExec;
  xfsQuotaBin?: string;
}): XfsProjectQuota {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(opts.root)) throw new Error("RUNNER_SANDBOX_HOME_ROOT must be a safe absolute path");
  if (!Number.isInteger(opts.limitMb) || opts.limitMb <= 0) {
    throw new Error("RUNNER_SANDBOX_HOME_MB must be a positive integer");
  }
  const quotaExec = opts.quotaExec ?? spawnQuotaExec(opts.xfsQuotaBin ?? "xfs_quota");
  const projectsDir = join(opts.root, ".projects");
  const scopesDir = join(opts.root, "scopes");
  let preflightPromise: Promise<void> | null = null;

  async function checked(args: string[], action: string): Promise<QuotaExecResult> {
    const result = await quotaExec(args);
    if (result.code !== 0) throw new Error(`${action} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  }

  async function preflight(): Promise<void> {
    preflightPromise ??= (async () => {
      await mkdir(opts.root, { recursive: true, mode: 0o700 });
      const state = await checked(["-x", "-c", "state -p", opts.root], "xfs project quota state");
      if (!/Accounting:\s+ON/.test(state.stdout) || !/Enforcement:\s+ON/.test(state.stdout)) {
        throw new Error(`XFS project quota accounting and enforcement must both be ON for ${opts.root}`);
      }
      await mkdir(projectsDir, { recursive: true, mode: 0o700 });
      await mkdir(scopesDir, { recursive: true, mode: 0o700 });
    })().catch((error) => {
      preflightPromise = null;
      throw error;
    });
    return preflightPromise;
  }

  function sourceOf(scope: string): string {
    return join(scopesDir, xfsScopeHash(scope));
  }

  async function claimProject(scope: string, projectId: number): Promise<void> {
    const allocation = join(projectsDir, String(projectId));
    const hash = xfsScopeHash(scope);
    try {
      await writeFile(allocation, hash, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readFile(allocation, "utf8")) !== hash) {
        throw new Error(`XFS project id collision for ${projectId}`, { cause: error });
      }
    }
  }

  return {
    preflight,
    sourceOf,
    async ensure(scope) {
      await preflight();
      const source = sourceOf(scope);
      let coldStart = false;
      try {
        await stat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        coldStart = true;
        await mkdir(source, { recursive: true, mode: 0o700 });
      }
      const projectId = xfsProjectId(scope);
      await claimProject(scope, projectId);
      await checked(["-x", "-c", `project -s -p ${source} ${projectId}`, opts.root], "xfs project setup");
      await checked(["-x", "-c", `limit -p bhard=${opts.limitMb}m ${projectId}`, opts.root], "xfs project limit");
      return { source, coldStart };
    },
    async destroy(scope) {
      await preflight();
      const projectId = xfsProjectId(scope);
      await rm(sourceOf(scope), { recursive: true, force: true });
      await checked(["-x", "-c", `limit -p bsoft=0 bhard=0 ${projectId}`, opts.root], "xfs project clear");
      await rm(join(projectsDir, String(projectId)), { force: true });
    },
  };
}
