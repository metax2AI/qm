import assert from "node:assert/strict";
import test from "node:test";
import { apiErrorMessage } from "../src/core-bridge.ts";

test("known API codes use reviewed UI copy instead of server English", () => {
  assert.equal(
    apiErrorMessage({ error: "payload_too_large", message: "unreviewed server prose" }, 413),
    "The request is too large.",
  );
  assert.equal(
    apiErrorMessage({ error: "session_busy", message: "session busy" }, 409),
    "This conversation is busy. Try again in a moment.",
  );
  assert.equal(
    apiErrorMessage({ error: "credential_unavailable", message: "credential not found or disabled" }, 404),
    "This credential is unavailable.",
  );
  assert.equal(
    apiErrorMessage({ error: "ask_resolved", message: "ask already expired" }, 409),
    "That access request is no longer available.",
  );
});

test("unknown API diagnostics remain unchanged", () => {
  assert.equal(apiErrorMessage({ error: "vendor_failure", message: "provider trace 42" }, 502), "provider trace 42");
  assert.equal(
    apiErrorMessage({ error: "gateway_vendor_failure", message: "upstream trace 42" }, 502),
    "upstream trace 42",
  );
  assert.equal(apiErrorMessage({ error: "deploy_failed", message: "provider trace 73" }, 500), "provider trace 73");
  assert.equal(
    apiErrorMessage({ status: "refused", reasonCode: "vendor_refusal", reason: "provider diagnostic" }, 403),
    "provider diagnostic",
  );
  assert.equal(apiErrorMessage({ error: "vendor_failure" }, 502), "vendor_failure");
  assert.equal(apiErrorMessage({}, 502), "HTTP 502");
});

test("turn refusal codes use reviewed UI copy", () => {
  assert.equal(
    apiErrorMessage(
      {
        status: "refused",
        reasonCode: "context_access_denied",
        reason: "you're not allowed to use this context",
      },
      403,
    ),
    "You do not have access to that project.",
  );
  assert.equal(
    apiErrorMessage({ status: "refused", reasonCode: "rate_limited", reason: "retry in 17s" }, 403),
    "Too many requests. Try again later.",
  );
  assert.equal(
    apiErrorMessage({ status: "refused", reasonCode: "rate_limited", retryAfterMs: 17_000 }, 403),
    "Too many requests. Try again in 17 seconds.",
  );
  assert.equal(
    apiErrorMessage({ status: "refused", reasonCode: "budget_exceeded", reason: "$1.23 of $1" }, 403),
    "The usage budget has been reached. Try again later.",
  );
  assert.equal(
    apiErrorMessage({ status: "refused", reasonCode: "budget_exceeded", budget: { spentUsd: 1.23, limitUsd: 1 } }, 403),
    "The usage budget has been reached ($1.23 of $1.00). Try again later.",
  );
  assert.equal(
    apiErrorMessage({ status: "refused", reasonCode: "security_quarantine", reason: "screening details" }, 403),
    "This request was blocked by the workspace security policy.",
  );
  assert.equal(
    apiErrorMessage({ status: "refused", refusalKind: "security_quarantine", reason: "legacy details" }, 403),
    "This request was blocked by the workspace security policy.",
  );
});
