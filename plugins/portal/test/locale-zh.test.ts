import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

let providerConfigured = false;
let whoamiStatus = 200;

const upstream = createServer((req: IncomingMessage, res) => {
  if (req.url?.startsWith("/v1/surface-config")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(
      JSON.stringify({ webuiModels: [], baseModel: "m", harnessId: "pi", modelProviderConfigured: providerConfigured }),
    );
  }
  if (req.url === "/api/whoami") {
    res.writeHead(whoamiStatus, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: false }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "http://portal.test";
process.env.PORTAL_SESSION_SECRET = "locale-zh-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "locale-zh-test-core-secret";
process.env.PORTAL_DEFAULT_LOCALE = "zh-Hans";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;

const { server } = await import("../src/index.ts");
const {
  adminUnavailableHtml,
  connectErrorHtml,
  connectWrongRecipientHtml,
  nonAdminDeniedHtml,
  notConfiguredHtml,
  playgroundBusyHtml,
  playgroundRestrictedHtml,
  signInErrorHtml,
} = await import("../src/index.ts");
const { deriveKey, seal } = await import("../src/session.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

const sessionKey = deriveKey("locale-zh-test-portal-secret", "portal.session.v1");
function sessionCookie(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `portal_session=${encodeURIComponent(seal({ k: "session", sub, org: "acme", iat: now, exp: now + 28800 }, sessionKey))}`;
}

test.after(() => {
  server.close();
  upstream.close();
});

test("PORTAL_DEFAULT_LOCALE=zh-Hans renders the not-set-up page in Chinese", async () => {
  const r = await fetch(`${base}/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-member") },
    redirect: "manual",
  });
  assert.equal(r.status, 503);
  const html = await r.text();
  assert.match(html, /<html lang="zh-Hans">/);
  assert.match(html, /尚未完成设置/);
  assert.match(html, /请联系管理员在管理后台完成初始化设置。/);
});

test("PORTAL_DEFAULT_LOCALE=zh-Hans renders the admin-denied page in Chinese", async () => {
  providerConfigured = true;
  const r = await fetch(`${base}/admin/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-member") },
  });
  assert.equal(r.status, 403);
  const html = await r.text();
  assert.match(html, /<html lang="zh-Hans">/);
  assert.match(html, /没有管理员权限/);
  assert.match(html, /当前登录/);
});

test("PORTAL_DEFAULT_LOCALE=zh-Hans renders the admin-outage page in Chinese", async () => {
  whoamiStatus = 502;
  const r = await fetch(`${base}/admin/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-outage") },
  });
  assert.equal(r.status, 403);
  const html = await r.text();
  assert.match(html, /管理后台暂时不可用/);
});

test("PORTAL_DEFAULT_LOCALE=zh-Hans shows the sign-in callback failure in Chinese", async () => {
  const r = await fetch(`${base}/auth/callback`, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(r.status, 400);
  const html = await r.text();
  assert.match(html, /登录会话已过期——请重试/);
  assert.match(html, /无法完成登录/);
});

test("the exported card pages are Chinese when the locale is zh-Hans and English by default", () => {
  const zh = signInErrorHtml("boom");
  assert.match(zh, /<html lang="zh-Hans">/);
  assert.match(zh, /无法完成登录/);
  assert.match(zh, /重新登录/);

  assert.match(nonAdminDeniedHtml({ sub: "u@example.com", org: "acme" }), /没有管理员权限/);
  assert.match(notConfiguredHtml(), /尚未完成设置/);
  assert.match(adminUnavailableHtml(), /管理后台暂时不可用/);
  assert.match(playgroundBusyHtml(), /演示区繁忙/);
  assert.match(playgroundRestrictedHtml(), /演示区不可用/);
  assert.match(connectErrorHtml("x"), /<html lang="zh-Hans">/);
  assert.match(connectErrorHtml("x"), /无法连接/);
  assert.match(connectWrongRecipientHtml({ provider: "", alreadyConnected: true }), /你已连接 此应用/);
  assert.match(connectWrongRecipientHtml({ provider: "", alreadyConnected: false }), /连接我的 此应用/);

  assert.match(signInErrorHtml("boom", "en"), /We couldn&#39;t sign you in/);
  assert.match(nonAdminDeniedHtml({ sub: "u@example.com", org: "acme" }, "en"), /admin access/);
  assert.match(connectErrorHtml("boom", "en"), /Can&#39;t connect/);
  assert.match(connectWrongRecipientHtml({ provider: "salesforce", alreadyConnected: true }, "en"), /already connected/);
  assert.doesNotMatch(notConfiguredHtml(), /We couldn't/);
});
