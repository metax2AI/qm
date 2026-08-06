import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ isAdmin: true, role: "org_admin", scopeId: "org:acme" }));
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-locale-zh-test-secret";
process.env.ADMIN_DEFAULT_LOCALE = "zh-Hans";
process.env.ADMIN_HIDE_SLACK = "1";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  if (core.listening) core.close();
});

test("ADMIN_DEFAULT_LOCALE=zh-Hans injects the locale into the shell", async () => {
  const r = await fetch(`${base}/`);
  const html = await r.text();
  assert.match(html, /<html lang="zh-Hans">/);
  assert.match(html, /<meta name="admin-default-locale" content="zh-Hans" \/>/);
});

test("ADMIN_HIDE_SLACK=1 removes the slack view from the navigation sections", async () => {
  const r = await fetch(`${base}/`);
  const html = await r.text();
  assert.match(html, /<meta name="admin-hide-slack" content="1" \/>/);
  assert.match(html, /const HIDE_SLACK =/);
  assert.match(html, /name="admin-hide-slack"\]'\)/);
});
