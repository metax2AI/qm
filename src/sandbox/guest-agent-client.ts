import { sleep } from "../util/async.ts";
import { errMessage } from "../util/errors.ts";
import type { ExecResult } from "./sandbox.ts";

export interface GuestAgentOptions {
  label: string;
  fetchImpl?: typeof fetch;
}

export interface GuestAgent {
  exec(endpoint: string, command: string, timeoutSec: number, signal?: AbortSignal): Promise<ExecResult>;
  readAbs(endpoint: string, absPath: string): Promise<Uint8Array | null>;
  writeAbs(endpoint: string, absPath: string, data: Uint8Array): Promise<void>;
  waitReady(resolveEndpoint: () => Promise<string>, name: string): Promise<void>;
}

export const GUEST_TRANSFER_TIMEOUT_MS = 600_000;

export class GuestAgentStatusError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GuestAgentStatusError";
    this.status = status;
  }
}

export function createGuestAgent({ label, fetchImpl = fetch }: GuestAgentOptions): GuestAgent {
  async function call(
    endpoint: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    const signals = [AbortSignal.timeout(timeoutMs ?? 30_000), ...(signal ? [signal] : [])];
    const res = await fetchImpl(`${endpoint}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.any(signals),
    });
    return { status: res.status, text: await res.text() };
  }

  return {
    async exec(endpoint, command, timeoutSec, signal): Promise<ExecResult> {
      const res = await call(endpoint, "/exec", { cmd: command, timeoutSec }, (timeoutSec + 15) * 1000, signal);
      if (res.status !== 200)
        throw new GuestAgentStatusError(
          `${label} sandbox exec failed (${res.status}): ${res.text.slice(0, 300)}`,
          res.status,
        );
      const j = JSON.parse(res.text) as { stdout: string; stderr: string; code: number; timedOut: boolean };
      return { stdout: j.stdout ?? "", stderr: j.stderr ?? "", code: j.code, timedOut: !!j.timedOut };
    },

    async readAbs(endpoint, absPath): Promise<Uint8Array | null> {
      const res = await call(endpoint, "/read", { path: absPath }, GUEST_TRANSFER_TIMEOUT_MS);
      if (res.status === 404) return null;
      if (res.status !== 200)
        throw new GuestAgentStatusError(
          `${label} sandbox read ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`,
          res.status,
        );
      return Buffer.from((JSON.parse(res.text) as { b64: string }).b64, "base64");
    },

    async writeAbs(endpoint, absPath, data): Promise<void> {
      const res = await call(
        endpoint,
        "/write",
        { path: absPath, b64: Buffer.from(data).toString("base64") },
        GUEST_TRANSFER_TIMEOUT_MS,
      );
      if (res.status !== 200)
        throw new GuestAgentStatusError(
          `${label} sandbox write ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`,
          res.status,
        );
    },

    async waitReady(resolveEndpoint, name): Promise<void> {
      const deadline = Date.now() + 30_000;
      let lastErr = "";
      while (Date.now() < deadline) {
        try {
          const res = await call(await resolveEndpoint(), "/health", undefined, 3000);
          if (res.status === 200) return;
          lastErr = `http ${res.status}`;
        } catch (e) {
          lastErr = errMessage(e);
        }
        await sleep(300);
      }
      throw new Error(`${label} sandbox ${name}: exec daemon never became reachable: ${lastErr}`);
    },
  };
}
