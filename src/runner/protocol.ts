export const RUNNER_PATH_PREFIX = "/v1/sandboxes";
export const RUNNER_HEALTH_PATH = "/health";

export interface RunnerEnsureRequest {
  acquisitionId: string;
  scopeId?: string;
  scratchKey?: string;
}

export interface RunnerEnsureResponse {
  id: string;
  coldStart: boolean;
  acquisitionId: string;
}

export interface RunnerExecRequest {
  acquisitionId: string;
  cmd: string;
  timeoutSec: number;
}

export interface RunnerExecResponse {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface RunnerReadRequest {
  acquisitionId: string;
  path: string;
}

export interface RunnerReadResponse {
  b64: string;
}

export interface RunnerWriteRequest {
  acquisitionId: string;
  path: string;
  b64: string;
}

export interface RunnerTeardownRequest {
  acquisitionId: string;
  keepWarm?: boolean;
  destroy?: boolean;
  scratch?: boolean;
}

export const runnerEnsurePath = (): string => `${RUNNER_PATH_PREFIX}/ensure`;
export const runnerBoxPath = (id: string, action: string): string =>
  `${RUNNER_PATH_PREFIX}/${encodeURIComponent(id)}/${action}`;
