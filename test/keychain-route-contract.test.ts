import assert from "node:assert/strict";
import { test } from "node:test";
import { keychainRoutes } from "../src/api/routes/keychain.ts";
import type { ApiCtx, Route } from "../src/api/routes/route.ts";
import { secretDropRoutes } from "../src/api/routes/secret-drop.ts";

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

function routeAt(routes: ReadonlyArray<Route<ApiCtx>>, method: string, path: string): Route<ApiCtx> {
  const route = routes.find(
    (candidate) => "path" in candidate && candidate.method === method && candidate.path === path,
  );
  assert.ok(route);
  return route;
}

async function invoke(
  route: Route<ApiCtx>,
  method: string,
  pathname: string,
): Promise<{ status: number; body: unknown }> {
  const { res, out } = fakeRes();
  const ctx = {
    res,
    deps: {},
    method,
    pathname,
    params: { id: "drop-1" },
    body: {},
  } as unknown as ApiCtx;
  await route.handle(ctx);
  return out;
}

test("keychain routes distinguish an unconfigured deployment from a missing resource", async () => {
  const out = await invoke(routeAt(keychainRoutes, "GET", "/v1/keychain/overview"), "GET", "/v1/keychain/overview");
  assert.equal(out.status, 503);
  assert.equal((out.body as { error: string }).error, "not_configured");
});

test("credential-drop routes distinguish an unconfigured deployment from a missing link", async () => {
  for (const [method, pattern, pathname] of [
    ["POST", "/v1/keychain/drops", "/v1/keychain/drops"],
    ["POST", "/v1/keychain/drops/:id", "/v1/keychain/drops/drop-1"],
  ] as const) {
    const out = await invoke(routeAt(secretDropRoutes, method, pattern), method, pathname);
    assert.equal(out.status, 503);
    assert.equal((out.body as { error: string }).error, "not_configured");
  }
});
