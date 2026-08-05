import assert from "node:assert/strict";
import { test } from "node:test";
import { cronRoutes } from "../src/api/routes/crons.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { Cron } from "../src/types.ts";

function fakeRes() {
  const out = { status: 0, body: undefined as unknown };
  return {
    res: {
      writeHead(status: number) {
        out.status = status;
        return this;
      },
      end(data?: string) {
        out.body = data ? JSON.parse(data) : undefined;
      },
    } as unknown as ApiCtx["res"],
    out,
  };
}

test("manual cron runs distinguish a missing scheduler from a missing cron", async () => {
  const route = cronRoutes.find((candidate) => "path" in candidate && candidate.path === "/v1/crons/:id/run");
  assert.ok(route);
  const cron = { id: "cron-1", enabled: true, archived: false } as Cron;
  const { res, out } = fakeRes();
  const ctx = {
    res,
    app: { getCron: async () => cron },
    deps: {},
    capability: null,
    params: { id: cron.id },
    url: new URL(`http://x/v1/crons/${cron.id}/run`),
  } as unknown as ApiCtx;

  await route.handle(ctx);
  assert.equal(out.status, 503);
  assert.equal((out.body as { error: string }).error, "not_configured");
});
