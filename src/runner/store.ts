import { createMemoryMap, createPostgresMapFactory, type DurableMap } from "../persistence/durable-map.ts";
import { hashId } from "../util/crypto.ts";

const RUNNER_BOXES_TABLE = "runner_sandboxes";
export const RUNNER_HOLD_LEASE_MS = 60 * 60_000;

export interface RunnerBoxRecord {
  generation: string;
  containerName: string;
  networkName: string;
  imageRef: string;
  orgId: string;
  createdAtMs: number;
  lastActivityMs: number;
  parked?: boolean;
  keepWarm?: boolean;
  holds?: Record<string, number>;
  destroyPending?: boolean;
  scopeId?: string;
  scratchKey?: string;
  volumeName?: string;
}

export function runnerLiveHolds(record: RunnerBoxRecord, at: number): Record<string, number> {
  return Object.fromEntries(Object.entries(record.holds ?? {}).filter(([, expiresAt]) => expiresAt > at));
}

export function runnerStoreTable(orgId: string): string {
  return `${RUNNER_BOXES_TABLE}_${hashId([orgId])}`;
}

export function createRunnerStore(databaseUrl?: string, orgId?: string): DurableMap<RunnerBoxRecord> {
  return databaseUrl
    ? createPostgresMapFactory(databaseUrl).map<RunnerBoxRecord>(orgId ? runnerStoreTable(orgId) : RUNNER_BOXES_TABLE)
    : createMemoryMap<RunnerBoxRecord>();
}
