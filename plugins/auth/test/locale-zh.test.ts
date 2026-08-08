import test from "node:test";
import assert from "node:assert/strict";
import { renderSignInEmail } from "../src/email.ts";
import { authorizeQuery, hiddenRequestToken, linkFrom, startHarness } from "./helpers.ts";

const form = (entries: Record<string, string>): { method: string; headers: Record<string, string>; body: string } => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(entries).toString(),
});

test("AUTH_DEFAULT_LOCALE=zh-Hans renders the sign-in pages and email in Chinese", async (t) => {
  const h = await startHarness({ env: { AUTH_DEFAULT_LOCALE: "zh-Hans" } });
  t.after(() => h.close());

  const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`);
  assert.equal(page.status, 200);
  const formHtml = await page.text();
  assert.match(formHtml, /<html lang="zh-Hans">/);
  assert.match(formHtml, /登录 qm/);
  assert.match(formHtml, /输入你的企业邮箱，我们会发送一条一次性登录链接。/);
  assert.match(formHtml, /发送登录链接/);
  assert.match(formHtml, /只有管理员允许的邮箱地址才能登录。/);

  const request = hiddenRequestToken(formHtml);
  const submitted = await fetch(`${h.base}/authorize`, form({ request, email: "admin@example.com" }));
  assert.equal(submitted.status, 200);
  const sent = await submitted.text();
  assert.match(sent, /请查收邮件/);
  assert.match(sent, /只能使用一次，15 分钟后过期/);
  await h.settle();

  assert.equal(h.mailer.sent.length, 1);
  const email = h.mailer.sent[0]!;
  assert.equal(email.subject, "登录 qm");
  assert.match(email.text, /打开下面的链接完成登录/);
  assert.match(email.html, /<html lang="zh-Hans">/);
  assert.match(email.html, /或把下面的地址粘贴到浏览器中/);

  const link = new URL(linkFrom(h.mailer));
  const confirm = await fetch(`${h.base}/verify${link.search}`);
  const confirmHtml = await confirm.text();
  assert.match(confirmHtml, /完成登录/);
  assert.match(confirmHtml, /点击下方按钮完成登录。链接在确认时即失效/);
  assert.match(confirmHtml, /登录<\/button>/);
});

test("AUTH_DEFAULT_LOCALE=zh-Hans shows Chinese error pages", async (t) => {
  const h = await startHarness({ env: { AUTH_DEFAULT_LOCALE: "zh-Hans" } });
  t.after(() => h.close());

  const stale = await fetch(`${h.base}/verify`, form({ token: "not-a-token" }));
  assert.equal(stale.status, 400);
  const staleHtml = await stale.text();
  assert.match(staleHtml, /这条登录链接已失效/);
  assert.match(staleHtml, /重新获取登录链接/);
  assert.match(staleHtml, /href="https:\/\/agent\.example\.test\/auth\/login"/);

  const refused = await fetch(`${h.base}/authorize?${authorizeQuery({ client_id: "someone-else" })}`);
  const refusedHtml = await refused.text();
  assert.match(refusedHtml, /这条登录链接无效/);
  assert.match(refusedHtml, /此登录请求来自未知应用。/);

  const badChallenge = await fetch(
    `${h.base}/authorize?${authorizeQuery({ code_challenge: "not-a-valid-challenge" })}`,
  );
  assert.match(await badChallenge.text(), /PKCE 校验值格式有误/);
});

test("renderSignInEmail stays English without a locale and Chinese with zh-Hans", () => {
  const base = {
    to: "admin@example.com",
    brandName: "qm",
    link: "https://agent.example.test/idp/verify#token=abc",
    ttlMinutes: 15,
  };
  const en = renderSignInEmail(base);
  assert.equal(en.subject, "Sign in to qm");
  assert.match(en.text, /works once and expires in 15 minutes/);

  const zhEmail = renderSignInEmail({ ...base, locale: "zh-Hans" });
  assert.equal(zhEmail.subject, "登录 qm");
  assert.match(zhEmail.text, /打开下面的链接完成登录/);
  assert.match(zhEmail.html, /lang="zh-Hans"/);
});
