import type { AuditLog } from "../audit/audit-log.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DockerLifecycle } from "../sandbox/docker-lifecycle.ts";
import { scopeId } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import type { RunnerBoxRecord } from "./store.ts";

export type RunnerRecycleReason = "agent_unreachable" | "oom_killed" | "abnormal_exit" | "container_missing";

interface RunnerRecoveryDeps {
  lifecycle: DockerLifecycle;
  store: DurableMap<RunnerBoxRecord>;
  auditLog: AuditLog;
  now?: () => number;
}

async function auditRecycle(
  auditLog: AuditLog,
  id: string,
  record: RunnerBoxRecord,
  status: RunnerRecycleReason | "recycle_failed",
  reason: RunnerRecycleReason,
  at: number,
): Promise<void> {
  const event = {
    at,
    principalId: "system:runner",
    action: "sandbox.recycled",
    resource: id,
    scopeLabel: record.scopeId ?? scopeId("org", record.orgId),
    status,
    detail: JSON.stringify({ reason, imageRef: record.imageRef }),
  };
  if (auditLog.recordOnce) {
    await auditLog.recordOnce(`runner-recycle|${id}|${status}|${at}`, event);
  } else {
    auditLog.record(event);
  }
}

export async function recycleRunnerBox(
  id: string,
  record: RunnerBoxRecord,
  reason: RunnerRecycleReason,
  deps: RunnerRecoveryDeps,
): Promise<void> {
  const at = (deps.now ?? Date.now)();
  try {
    await deps.lifecycle.recycle({
      id,
      ...(record.scopeId ? { scopeId: record.scopeId } : {}),
      ...(record.scratchKey ? { scratchKey: record.scratchKey } : {}),
    });
    await auditRecycle(deps.auditLog, id, record, reason, reason, at);
  } catch (error) {
    await auditRecycle(deps.auditLog, id, record, "recycle_failed", reason, at);
    throw error;
  }
}

export async function reconcileRunnerBoxes(deps: RunnerRecoveryDeps): Promise<number> {
  let recycled = 0;
  for (const [id, record] of await deps.store.entries()) {
    if (record.parked) continue;
    const state = await deps.lifecycle.stateOf(id);
    let reason: RunnerRecycleReason | null = null;
    if (!state) reason = "container_missing";
    else if (state.oomKilled) reason = "oom_killed";
    else if (!state.running && state.exitCode !== 0) reason = "abnormal_exit";
    if (!reason) continue;
    const current = await deps.store.get(id);
    if (!current || current.parked) continue;
    try {
      await recycleRunnerBox(id, current, reason, deps);
      recycled++;
    } catch (error) {
      console.warn(`[runner] failed to recycle ${id}: ${errMessage(error)}`);
    }
  }
  return recycled;
}
