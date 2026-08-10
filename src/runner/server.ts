import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { canonicalPayload, PayloadTooLargeError, readRawBody, sendJson, verifyOrReject } from "../api/http.ts";
import { createSourceAuth, type SourceAuth } from "../auth/source-auth.ts";
import { errMessage } from "../util/errors.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DockerLifecycle } from "../sandbox/docker-lifecycle.ts";
import { GuestAgentStatusError, type GuestAgent } from "../sandbox/guest-agent-client.ts";
import { RUNNER_HEALTH_PATH, RUNNER_PATH_PREFIX } from "./protocol.ts";
import type {
  RunnerEnsureRequest,
  RunnerExecRequest,
  RunnerReadRequest,
  RunnerTeardownRequest,
  RunnerWriteRequest,
} from "./protocol.ts";
import { RUNNER_HOLD_LEASE_MS, runnerLiveHolds, type RunnerBoxRecord } from "./store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { recycleRunnerBox, type RunnerBoxQueue } from "./recovery.ts";

const MAX_RUNNER_BODY_BYTES = 256 * 1024 * 1024;
const BOX_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const ACQUISITION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  boxQueue: RunnerBoxQueue;
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
  const boxQueue = opts.boxQueue;

  async function updateRecord(
    id: string,
    update: (record: RunnerBoxRecord) => RunnerBoxRecord,
  ): Promise<RunnerBoxRecord | null> {
    if (!store.update) throw new Error("runner store must support atomic updates");
    return store.update(id, update);
  }

  async function touch(id: string, acquisitionId: string): Promise<RunnerBoxRecord | null> {
    if (!ACQUISITION_ID.test(acquisitionId)) throw new BadRequestError("need acquisitionId");
    const at = now();
    return updateRecord(id, (record) => {
      if ((record.holds?.[acquisitionId] ?? 0) <= at) throw new BadRequestError("expired acquisitionId");
      return {
        ...record,
        lastActivityMs: at,
        parked: false,
        holds: { ...record.holds, [acquisitionId]: at + RUNNER_HOLD_LEASE_MS },
      };
    });
  }

  async function liveEndpoint(id: string): Promise<string> {
    assertBoxName(id, namePrefix);
    await lifecycle.ensureRunning(id);
    return lifecycle.endpointOf(id);
  }

  async function viaAgent<T>(id: string, acquisitionId: string, call: (endpoint: string) => Promise<T>): Promise<T> {
    const generation = await boxQueue(id, async () => {
      assertBoxName(id, namePrefix);
      const current = await touch(id, acquisitionId);
      if (!current) throw new BadRequestError(`unknown sandbox id: ${id}`);
      return current.generation;
    });
    try {
      return await call(await liveEndpoint(id));
    } catch (error) {
      if (error instanceof GuestAgentStatusError || error instanceof BadRequestError) throw error;
      await boxQueue(id, async () => {
        const record = await store.get(id);
        if (!record || record.generation !== generation || record.destroyPending || record.parked) return;
        await recycleRunnerBox(id, record, "agent_unreachable", { lifecycle, store, auditLog, now }).catch((e) =>
          console.warn(`[runner] could not recycle ${id} after an unreachable agent: ${errMessage(e)}`),
        );
      });
      throw error;
    }
  }

  async function ensure(body: RunnerEnsureRequest): Promise<{ id: string; coldStart: boolean }> {
    const scopeId = body.scopeId?.trim();
    const scratchKey = body.scratchKey?.trim();
    if (!scopeId === !scratchKey) throw new BadRequestError("need exactly one of scopeId or scratchKey");
    if (!ACQUISITION_ID.test(body.acquisitionId)) throw new BadRequestError("need acquisitionId");
    const id = scratchKey ? lifecycle.scratchNameOf(scratchKey) : lifecycle.containerNameOf(scopeId!);
    return boxQueue(id, async () => {
      const existing = await store.get(id);
      if (existing?.destroyPending) throw new Error(`sandbox ${id} is still being destroyed`);
      const ref = scratchKey ? await lifecycle.ensureScratch(scratchKey) : await lifecycle.ensureScope(scopeId!);
      const record: RunnerBoxRecord = {
        generation: randomUUID(),
        containerName: ref.id,
        networkName: lifecycle.networkNameOf(ref.id),
        imageRef,
        orgId,
        createdAtMs: now(),
        lastActivityMs: now(),
        keepWarm: false,
        holds: {},
        ...(scopeId ? { scopeId, volumeName: lifecycle.volumeNameOf(scopeId) } : {}),
        ...(scratchKey ? { scratchKey } : {}),
      };
      await store.putIfAbsent(ref.id, record);
      const held = await updateRecord(ref.id, (current) => {
        if (current.orgId !== orgId) throw new Error(`sandbox ${ref.id} belongs to another organization`);
        if (current.destroyPending) throw new Error(`sandbox ${ref.id} is still being destroyed`);
        const at = now();
        return {
          ...current,
          ...record,
          generation: current.generation,
          createdAtMs: current.createdAtMs,
          lastActivityMs: at,
          holds: { ...runnerLiveHolds(current, at), [body.acquisitionId]: at + RUNNER_HOLD_LEASE_MS },
          parked: false,
          keepWarm: false,
        };
      });
      if (!held) throw new Error(`sandbox ${ref.id} disappeared while it was being acquired`);
      return { id: ref.id, coldStart: ref.coldStart, acquisitionId: body.acquisitionId };
    });
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
      const result = await viaAgent(id, req.acquisitionId, (endpoint) => agent.exec(endpoint, req.cmd, timeoutSec));
      await touch(id, req.acquisitionId);
      return { status: 200, body: result };
    }
    if (action === "read") {
      const req = parsed as RunnerReadRequest;
      if (typeof req.path !== "string") throw new BadRequestError("need path");
      const bytes = await viaAgent(id, req.acquisitionId, (endpoint) => agent.readAbs(endpoint, req.path));
      await touch(id, req.acquisitionId);
      if (bytes === null) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: { b64: Buffer.from(bytes).toString("base64") } };
    }
    if (action === "write") {
      const req = parsed as RunnerWriteRequest;
      if (typeof req.path !== "string" || typeof req.b64 !== "string") throw new BadRequestError("need path + b64");
      await viaAgent(id, req.acquisitionId, (endpoint) =>
        agent.writeAbs(endpoint, req.path, Buffer.from(req.b64, "base64")),
      );
      await touch(id, req.acquisitionId);
      return { status: 200, body: { ok: true } };
    }
    if (action === "teardown") {
      const req = parsed as RunnerTeardownRequest;
      assertBoxName(id, namePrefix);
      if (!ACQUISITION_ID.test(req.acquisitionId)) throw new BadRequestError("need acquisitionId");
      return boxQueue(id, async () => {
        const current = await store.get(id);
        if (!current) return { status: 200, body: { ok: true } };
        if (!(req.acquisitionId in (current.holds ?? {})) && !current.destroyPending) {
          return { status: 200, body: { ok: true } };
        }
        const held = await updateRecord(id, (record) => {
          const at = now();
          const holds = runnerLiveHolds(record, at);
          delete holds[req.acquisitionId];
          const released = Object.keys(holds).length === 0;
          const destroyPending = !!record.destroyPending || !!req.destroy || !!req.scratch;
          return {
            ...record,
            lastActivityMs: at,
            holds,
            ...(destroyPending ? { destroyPending: true } : {}),
            ...(released && !destroyPending ? { parked: !req.keepWarm, keepWarm: !!req.keepWarm } : {}),
          };
        });
        if (!held) return { status: 200, body: { ok: true } };
        if (Object.keys(held.holds ?? {}).length > 0) {
          return { status: 200, body: { ok: true } };
        }
        const destroy = !!held.destroyPending;
        const parking = !destroy && !held.keepWarm;
        try {
          await lifecycle.teardownBox(
            { id, ...(held.scratchKey ? { scratch: true } : {}), ...(held.scopeId ? { scopeId: held.scopeId } : {}) },
            {
              ...(held.keepWarm && !destroy ? { keepWarm: true } : {}),
              ...(destroy ? { destroy: true } : {}),
            },
          );
        } catch (error) {
          if (parking) await store.merge(id, { parked: false, lastActivityMs: now() });
          throw error;
        }
        if (destroy) {
          if (!store.deleteIf) throw new Error("runner store must support conditional deletes");
          await store.deleteIf(id, (record) => record.generation === held.generation);
        }
        return { status: 200, body: { ok: true } };
      });
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

    try {
      const payload = canonicalPayload(req.method ?? "POST", url, raw);
      if (!(await verifyOrReject(req, res, signingSecret, auth, payload, true))) return;
      const out = await handle(pathname, req.method ?? "POST", raw);
      sendJson(res, out.status, out.body);
    } catch (e) {
      if (e instanceof BadRequestError) return sendJson(res, 400, { error: "bad_request", message: e.message });
      sendJson(res, 500, { error: "runner_error", message: errMessage(e) });
    }
  }

  return createServer((req, res) => void onRequest(req, res));
}
