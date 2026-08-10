import { createMemoryMap, createPostgresMapFactory, type DurableMap } from "../persistence/durable-map.ts";

const RUNNER_BOXES_TABLE = "runner_sandboxes";

export interface RunnerBoxRecord {
  containerName: string;
  networkName: string;
  imageRef: string;
  orgId: string;
  createdAtMs: number;
  lastActivityMs: number;
  parked?: boolean;
  scopeId?: string;
  scratchKey?: string;
  volumeName?: string;
}

export function createRunnerStore(databaseUrl?: string): DurableMap<RunnerBoxRecord> {
  return databaseUrl
    ? createPostgresMapFactory(databaseUrl).map<RunnerBoxRecord>(RUNNER_BOXES_TABLE)
    : createMemoryMap<RunnerBoxRecord>();
}
