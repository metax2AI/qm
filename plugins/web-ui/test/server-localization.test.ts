import assert from "node:assert/strict";
import test from "node:test";
import { injectDefaultLocale, normalizeWebLocale } from "../server/localization.ts";

test("normalizes supported deployment locale aliases", () => {
  assert.equal(normalizeWebLocale("zh-CN"), "zh-Hans");
  assert.equal(normalizeWebLocale("zh_SG"), "zh-Hans");
  assert.equal(normalizeWebLocale("en-US"), "en");
  assert.equal(normalizeWebLocale("zh-TW"), null);
  assert.equal(normalizeWebLocale(undefined), null);
});

test("injects the deployment locale into first-response HTML", () => {
  const html =
    '<!doctype html><html lang="en"><head><title>QM</title><meta name="web-ui-default-locale" content="en" /></head></html>';
  const localized = injectDefaultLocale(html, "zh-Hans");
  assert.match(localized, /<html lang="zh-Hans">/);
  assert.match(localized, /<title>QM · 网页<\/title>/);
  assert.match(localized, /<meta name="web-ui-default-locale" content="zh-Hans" \/>/);
});

test("leaves browser locale resolution available without a deployment default", () => {
  const html = '<!doctype html><html lang="en"><head><meta name="web-ui-default-locale" content="en" /></head></html>';
  const localized = injectDefaultLocale(html, null);
  assert.match(localized, /<html lang="en">/);
  assert.match(localized, /<meta name="web-ui-default-locale" content="" \/>/);
});
