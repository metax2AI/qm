import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("critical authentication and navigation paths render in Simplified Chinese", async () => {
  const dom = new JSDOM(
    '<!doctype html><html lang="en"><head><meta name="brand-self-label" content="QM"><meta name="web-ui-default-locale" content="zh-Hans"></head><body><div id="app"></div></body></html>',
    { url: "http://localhost/web-ui/" },
  );
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    navigator: dom.window.navigator,
    customElements: dom.window.customElements,
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const localization = await vite.ssrLoadModule("/src/localization.ts");
    assert.equal(await localization.initializeLocale(), "zh-Hans");
    const shell = await vite.ssrLoadModule("/src/shell.ts");

    shell.renderAuthGate({ kind: "denied" });
    assert.equal(document.querySelector("h1")?.textContent, "你没有访问权限");
    assert.match(document.querySelector(".signin-body")?.textContent ?? "", /管理员/);

    shell.appState.me = { user: "alice", org: "acme" };
    shell.mountShell();
    await Promise.resolve();

    assert.equal(document.documentElement.lang, "zh-Hans");
    assert.equal(document.querySelector("aside")?.getAttribute("aria-label"), "导航");
    assert.equal(document.querySelector(".new-chat span")?.textContent, "新建聊天");
    assert.equal(document.querySelector('option[value="zh-Hans"]')?.textContent, "简体中文");
    assert.equal(document.querySelector('button[aria-label="退出登录"]')?.getAttribute("title"), "退出登录");
    assert.deepEqual(
      [...document.querySelectorAll(".navrow span")].map((element) => element.textContent),
      ["项目", "聊天", "文件", "定时任务", "钥匙串", "应用", "内存", "技能"],
    );
  } finally {
    await vite.close();
    dom.window.close();
  }
});
