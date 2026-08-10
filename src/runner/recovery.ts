import type { AuditLog } from "../audit/audit-log.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DockerLifecycle } from "../sandbox/docker-lifecycle.ts";
import { scopeId } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { runnerLiveHolds, type RunnerBoxRecord } from "./store.ts";

export type RunnerRecycleReason = "agent_unreachable" | "oom_killed" | "abnormal_exit" | "container_missing";

export type RunnerBoxQueue = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

interface RunnerRecycleDeps {
  lifecycle: DockerLifecycle;
  store: DurableMap<RunnerBoxRecord>;
  auditLog: AuditLog;
  now?: () => number;
}

interface RunnerRecoveryDeps extends RunnerRecycleDeps {
  boxQueue: RunnerBoxQueue;
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
  deps: RunnerRecycleDeps,
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
  for (const [id] of await deps.store.entries()) {
    await deps.boxQueue(id, async () => {
      const current = await deps.store.get(id);
      if (!current) return;
      const holds = runnerLiveHolds(current, (deps.now ?? Date.now)());
      if (current.destroyPending) {
        if (Object.keys(holds).length) {
          await deps.store.merge(id, { holds });
          return;
        }
        try {
          await deps.lifecycle.teardownBox(
            {
              id,
              ...(current.scopeId ? { scopeId: current.scopeId } : {}),
              ...(current.scratchKey ? { scratch: true } : {}),
            },
            { destroy: true },
          );
          if (!deps.store.deleteIf) throw new Error("runner store must support conditional deletes");
          await deps.store.deleteIf(
            id,
            (record) =>
              record.generation === current.generation &&
              !!record.destroyPending &&
              Object.keys(runnerLiveHolds(record, (deps.now ?? Date.now)())).length === 0,
          );
        } catch (error) {
          console.warn(`[runner] failed to finish destroying ${id}: ${errMessage(error)}`);
        }
        return;
      }
      if (current.parked && Object.keys(holds).length) await deps.store.merge(id, { parked: false });
      else if (current.parked) {
        const parkedState = await deps.lifecycle.stateOf(id);
        if (parkedState?.running) {
          try {
            await deps.lifecycle.teardownBox({
              id,
              ...(current.scopeId ? { scopeId: current.scopeId } : {}),
              ...(current.scratchKey ? { scratch: true } : {}),
            });
          } catch (error) {
            console.warn(`[runner] failed to finish parking ${id}: ${errMessage(error)}`);
          }
        }
        return;
      }
      if (!Object.keys(holds).length && !current.keepWarm) {
        await deps.store.merge(id, { holds, parked: true });
        try {
          await deps.lifecycle.teardownBox({
            id,
            ...(current.scopeId ? { scopeId: current.scopeId } : {}),
            ...(current.scratchKey ? { scratch: true } : {}),
          });
        } catch (error) {
          await deps.store.merge(id, { parked: false });
          console.warn(`[runner] failed to park expired acquisition for ${id}: ${errMessage(error)}`);
        }
        return;
      }
      const state = await deps.lifecycle.stateOf(id);
      let reason: RunnerRecycleReason | null = null;
      if (!state) reason = "container_missing";
      else if (state.oomKilled) reason = "oom_killed";
      else if (!state.running && state.exitCode !== 0) reason = "abnormal_exit";
      if (!reason) return;
      const latest = await deps.store.get(id);
      if (!latest || latest.generation !== current.generation || latest.parked || latest.destroyPending) return;
      try {
        await recycleRunnerBox(id, latest, reason, deps);
        recycled++;
      } catch (error) {
        console.warn(`[runner] failed to recycle ${id}: ${errMessage(error)}`);
      }
    });
  }
  return recycled;
}
