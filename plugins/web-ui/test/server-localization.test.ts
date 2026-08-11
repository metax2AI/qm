import assert from "node:assert/strict";
import test from "node:test";
import { defaultWebLocale, injectDefaultLocale, normalizeWebLocale } from "../server/localization.ts";

test("normalizes supported deployment locale aliases", () => {
  assert.equal(normalizeWebLocale("zh-CN"), "zh-Hans");
  assert.equal(normalizeWebLocale("zh_SG"), "zh-Hans");
  assert.equal(normalizeWebLocale("zh-Hans-SG"), "zh-Hans");
  assert.equal(normalizeWebLocale("zh-CN-u-hc-h23"), "zh-Hans");
  assert.equal(normalizeWebLocale("zh-u-nu-hanidec"), "zh-Hans");
  assert.equal(normalizeWebLocale("zh-x-company"), "zh-Hans");
  assert.equal(normalizeWebLocale("en-US"), "en");
  assert.equal(normalizeWebLocale("zh-TW"), null);
  assert.equal(normalizeWebLocale(undefined), null);
});

test("defaults a downstream Web deployment to Simplified Chinese", () => {
  assert.equal(defaultWebLocale(undefined), "zh-Hans");
  assert.equal(defaultWebLocale("fr"), "zh-Hans");
  assert.equal(defaultWebLocale("en"), "en");
});

test("injects the deployment locale into first-response HTML", () => {
  const html =
    '<!doctype html><html lang="en"><head><title>QM</title><meta name="web-ui-default-locale" content="en" /></head></html>';
  const localized = injectDefaultLocale(html, "zh-Hans");
  assert.match(localized, /<html lang="zh-Hans">/);
  assert.match(localized, /<title>QM · 网页<\/title>/);
  assert.match(localized, /<meta name="web-ui-default-locale" content="zh-Hans" \/>/);
});

test("renders the language the visitor chose, not the deployment default", () => {
  const html =
    '<!doctype html><html lang="en"><head><title>QM</title><meta name="web-ui-default-locale" content="en" /></head></html>';
  const localized = injectDefaultLocale(html, "zh-Hans", "en");
  assert.match(localized, /<html lang="en">/);
  assert.match(localized, /<title>QM · Web<\/title>/);
  assert.match(localized, /<meta name="web-ui-default-locale" content="zh-Hans" \/>/);
});

test("falls back to the deployment default when the visitor has no stored choice", () => {
  const html =
    '<!doctype html><html lang="en"><head><title>QM</title><meta name="web-ui-default-locale" content="en" /></head></html>';
  const localized = injectDefaultLocale(html, "zh-Hans", null);
  assert.match(localized, /<html lang="zh-Hans">/);
  assert.match(localized, /<title>QM · 网页<\/title>/);
});

test("leaves browser locale resolution available without a deployment default", () => {
  const html = '<!doctype html><html lang="en"><head><meta name="web-ui-default-locale" content="en" /></head></html>';
  const localized = injectDefaultLocale(html, null);
  assert.match(localized, /<html lang="en">/);
  assert.match(localized, /<meta name="web-ui-default-locale" content="" \/>/);
});
