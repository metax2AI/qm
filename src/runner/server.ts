import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { canonicalPayload, PayloadTooLargeError, readRawBody, sendJson, verifyOrReject } from "../api/http.ts";
import { createSourceAuth, type SourceAuth } from "../auth/source-auth.ts";
import { errMessage } from "../util/errors.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DockerLifecycle } from "../sandbox/docker-lifecycle.ts";
import type { GuestAgent } from "../sandbox/guest-agent-client.ts";
import { RUNNER_HEALTH_PATH, RUNNER_PATH_PREFIX } from "./protocol.ts";
import type {
  RunnerEnsureRequest,
  RunnerExecRequest,
  RunnerReadRequest,
  RunnerTeardownRequest,
  RunnerWriteRequest,
} from "./protocol.ts";
import type { RunnerBoxRecord } from "./store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { recycleRunnerBox } from "./recovery.ts";

const MAX_RUNNER_BODY_BYTES = 256 * 1024 * 1024;
const BOX_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export interface RunnerServerOptions {
  lifecycle: DockerLifecycle;
  agent: GuestAgent;
  store: DurableMap<RunnerBoxRecord>;
  signingSecret: string;
  namePrefix: string;
  imageRef: string;
  orgId: string;
  auditLog: AuditLog;
  maxExecTimeoutSec?: number;
  now?: () => number;
  auth?: SourceAuth;
}

function assertBoxName(id: string, namePrefix: string): void {
  if (!BOX_NAME.test(id) || !id.startsWith(`${namePrefix}-`)) {
    throw new BadRequestError(`invalid sandbox id: ${id.slice(0, 64)}`);
  }
}

class BadRequestError extends Error {}

function parseRoute(pathname: string): { id: string; action: string } | null {
  if (!pathname.startsWith(`${RUNNER_PATH_PREFIX}/`)) return null;
  const rest = pathname.slice(RUNNER_PATH_PREFIX.length + 1).split("/");
  if (rest.length !== 2) return null;
  const [rawId, action] = rest as [string, string];
  if (!rawId || !action) return null;
  return { id: decodeURIComponent(rawId), action };
}

export function buildRunnerServer(opts: RunnerServerOptions): Server {
  const { lifecycle, agent, store, signingSecret, namePrefix, imageRef, orgId, auditLog } = opts;
  const now = opts.now ?? (() => Date.now());
  const maxExecTimeoutSec = opts.maxExecTimeoutSec ?? 600;
  const auth = opts.auth ?? createSourceAuth({ signingSecret, now });

  async function touch(id: string): Promise<void> {
    await store.merge(id, { lastActivityMs: now(), parked: false });
  }

  async function liveEndpoint(id: string): Promise<string> {
    assertBoxName(id, namePrefix);
    await lifecycle.ensureRunning(id);
    return lifecycle.endpointOf(id);
  }

  async function viaAgent<T>(id: string, call: (endpoint: string) => Promise<T>): Promise<T> {
    try {
      return await call(await liveEndpoint(id));
    } catch (error) {
      const record = await store.get(id);
      if (record) {
        await recycleRunnerBox(id, record, "agent_unreachable", { lifecycle, store, auditLog, now }).catch((e) =>
          console.warn(`[runner] could not recycle ${id} after an unreachable agent: ${errMessage(e)}`),
        );
      }
      throw error;
    }
  }

  async function ensure(body: RunnerEnsureRequest): Promise<{ id: string; coldStart: boolean }> {
    const scopeId = body.scopeId?.trim();
    const scratchKey = body.scratchKey?.trim();
    if (!scopeId === !scratchKey) throw new BadRequestError("need exactly one of scopeId or scratchKey");
    const ref = scratchKey ? await lifecycle.ensureScratch(scratchKey) : await lifecycle.ensureScope(scopeId!);
    const existing = await store.get(ref.id);
    const record: RunnerBoxRecord = {
      containerName: ref.id,
      networkName: lifecycle.networkNameOf(ref.id),
      imageRef,
      orgId,
      createdAtMs: existing?.createdAtMs ?? now(),
      lastActivityMs: now(),
      ...(scopeId ? { scopeId, volumeName: lifecycle.volumeNameOf(scopeId) } : {}),
      ...(scratchKey ? { scratchKey } : {}),
    };
    await store.put(ref.id, record);
    return { id: ref.id, coldStart: ref.coldStart };
  }

  async function handle(pathname: string, method: string, raw: string): Promise<{ status: number; body: unknown }> {
    if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (pathname === `${RUNNER_PATH_PREFIX}/ensure`) {
      return { status: 200, body: await ensure(parsed as RunnerEnsureRequest) };
    }
    const route = parseRoute(pathname);
    if (!route) return { status: 404, body: { error: "not_found" } };
    const { id, action } = route;

    if (action === "exec") {
      const req = parsed as RunnerExecRequest;
      if (typeof req.cmd !== "string") throw new BadRequestError("need cmd");
      const timeoutSec = Math.min(maxExecTimeoutSec, Math.max(1, Number(req.timeoutSec) || 60));
      const result = await viaAgent(id, (endpoint) => agent.exec(endpoint, req.cmd, timeoutSec));
      await touch(id);
      return { status: 200, body: result };
    }
    if (action === "read") {
      const req = parsed as RunnerReadRequest;
      if (typeof req.path !== "string") throw new BadRequestError("need path");
      const bytes = await viaAgent(id, (endpoint) => agent.readAbs(endpoint, req.path));
      await touch(id);
      if (bytes === null) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: { b64: Buffer.from(bytes).toString("base64") } };
    }
    if (action === "write") {
      const req = parsed as RunnerWriteRequest;
      if (typeof req.path !== "string" || typeof req.b64 !== "string") throw new BadRequestError("need path + b64");
      await viaAgent(id, (endpoint) => agent.writeAbs(endpoint, req.path, Buffer.from(req.b64, "base64")));
      await touch(id);
      return { status: 200, body: { ok: true } };
    }
    if (action === "teardown") {
      const req = parsed as RunnerTeardownRequest;
      assertBoxName(id, namePrefix);
      const scopeId = (await store.get(id))?.scopeId;
      const { released } = await lifecycle.teardownBox(
        { id, ...(req.scratch ? { scratch: true } : {}), ...(scopeId ? { scopeId } : {}) },
        {
          ...(req.keepWarm ? { keepWarm: true } : {}),
          ...(req.destroy ? { destroy: true } : {}),
        },
      );
      if (!released) await touch(id);
      else if (req.destroy || req.scratch) await store.delete(id);
      else if (req.keepWarm) await touch(id);
      else await store.merge(id, { lastActivityMs: now(), parked: true });
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: "not_found" } };
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0] ?? "/";
    if (pathname === RUNNER_HEALTH_PATH) return sendJson(res, 200, { ok: true });

    let raw: string;
    try {
      raw = await readRawBody(req, MAX_RUNNER_BODY_BYTES);
    } catch (e) {
      const tooLarge = e instanceof PayloadTooLargeError;
      return sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? "payload_too_large" : "bad_request" });
    }

    const payload = canonicalPayload(req.method ?? "POST", url, raw);
    if (!(await verifyOrReject(req, res, signingSecret, auth, payload, true))) return;

    try {
      const out = await handle(pathname, req.method ?? "POST", raw);
      sendJson(res, out.status, out.body);
    } catch (e) {
      if (e instanceof BadRequestError) return sendJson(res, 400, { error: "bad_request", message: e.message });
      sendJson(res, 500, { error: "runner_error", message: errMessage(e) });
    }
  }

  return createServer((req, res) => void onRequest(req, res));
}
