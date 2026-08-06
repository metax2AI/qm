import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";
import { backgroundLabel } from "../src/session-list.ts";
import { pasteChipLabel } from "../src/paste-text.ts";
import {
  activeLocale,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  initializeLocale,
  localizedStatus,
  normalizeLocale,
  resolveLocale,
  saveLocale,
} from "../src/localization.ts";

test("normalizes supported browser locale aliases", () => {
  for (const locale of [
    "zh",
    "zh-CN",
    "zh-SG",
    "zh-Hans",
    "zh_cn",
    "zh-Hans-CN",
    "zh-CN-u-hc-h23",
    "zh-u-nu-hanidec",
    "zh-x-company",
  ]) {
    assert.equal(normalizeLocale(locale), "zh-Hans");
  }
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("zh-TW"), null);
  assert.equal(normalizeLocale("fr"), null);
});

test("resolves locale in stored, deployment, browser, English order", () => {
  assert.equal(resolveLocale({ stored: "en", deployment: "zh-Hans", browser: ["zh-CN"] }), "en");
  assert.equal(resolveLocale({ stored: "fr", deployment: "zh-Hans", browser: ["en-US"] }), "zh-Hans");
  assert.equal(resolveLocale({ deployment: "fr", browser: ["zh-SG", "en-US"] }), "zh-Hans");
  assert.equal(resolveLocale({ browser: ["fr-FR"] }), "en");
});

test("persists a normalized language choice before reloading", () => {
  const dom = new JSDOM("<!doctype html><html></html>", { url: "https://example.test" });
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  let reloads = 0;
  Object.defineProperties(globalThis, {
    localStorage: { configurable: true, value: dom.window.localStorage },
    location: { configurable: true, value: { reload: () => reloads++ } },
  });
  try {
    saveLocale("zh-CN");
    assert.equal(localStorage.getItem("qm.web-ui.locale"), "zh-Hans");
    assert.equal(reloads, 1);
  } finally {
    if (localStorageDescriptor) Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
    else delete (globalThis as Record<string, unknown>).localStorage;
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
    else delete (globalThis as Record<string, unknown>).location;
    dom.window.close();
  }
});

test("initializes the browser locale before formatting the first view when deployment default is unset", async () => {
  const dom = new JSDOM(
    '<!doctype html><html lang="en"><head><meta name="brand-self-label" content="QM"><meta name="web-ui-default-locale" content=""></head></html>',
    { url: "https://example.test" },
  );
  Object.defineProperty(dom.window.navigator, "languages", { configurable: true, value: ["zh-CN", "en"] });
  const descriptors = new Map(
    ["window", "document", "localStorage", "navigator", "CustomEvent"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage },
    navigator: { configurable: true, value: dom.window.navigator },
    CustomEvent: { configurable: true, value: dom.window.CustomEvent },
  });
  try {
    assert.equal(await initializeLocale(), "zh-Hans");
    assert.equal(activeLocale(), "zh-Hans");
    assert.equal(document.documentElement.lang, "zh-Hans");
    assert.equal(document.title, "QM · 网页");
    assert.equal(localizedStatus("pending"), "待处理");
    assert.equal(localizedStatus("vendor_state"), "vendor_state");
    assert.match(formatDateTime(new Date("2026-08-05T12:00:00Z"), { year: "numeric", month: "long" }), /年/);
    assert.equal(formatNumber(3, { style: "unit", unit: "hour", unitDisplay: "long" }), "3小时");
    assert.equal(formatRelativeTime(Date.now()), "现在");
    assert.equal(i18n("Copy code"), "复制代码");
    assert.equal(i18n("Copied!"), "已复制！");
    assert.equal(backgroundLabel(2, 2)?.label, "2 个后台任务正在运行 · 2 个监视任务已启用");
    assert.equal(pasteChipLabel(4200), "粘贴文本 · 4200 个字符");
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
});
