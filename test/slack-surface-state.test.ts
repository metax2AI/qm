import test from "node:test";
import assert from "node:assert/strict";
import {
  slackSurfaceState,
  type SlackInstallationStatus,
  type SlackInstallationStore,
} from "../src/surfaces/slack-installation.ts";

const storeWith = (status: SlackInstallationStatus): SlackInstallationStore => ({
  get: async () => null,
  status: async () => status,
  set: async () => status,
  delete: async () => {},
});

test("an admin-managed installation enables the surface and reports its status", async () => {
  const status: SlackInstallationStatus = { configured: true, managed: true, teamName: "Acme" };
  const state = await slackSurfaceState(storeWith(status), "absent");
  assert.deepEqual(state, { enabled: true, source: "admin", status });
});

test("an admin installation outranks the environment", async () => {
  const status: SlackInstallationStatus = { configured: true, managed: true };
  const state = await slackSurfaceState(storeWith(status), "configured");
  assert.equal(state.source, "admin");
});

test("a disconnected installation disables the surface even when the environment is configured", async () => {
  const tombstone: SlackInstallationStatus = { configured: false, managed: true };
  assert.deepEqual(await slackSurfaceState(storeWith(tombstone), "absent"), {
    enabled: false,
    source: "admin",
    status: tombstone,
  });
  const overEnvironment = await slackSurfaceState(storeWith(tombstone), "configured");
  assert.equal(
    overEnvironment.enabled,
    false,
    "deleting the installation is an explicit disconnect and outranks the environment, matching the runtime reconciler",
  );
});

test("a configured environment enables the surface when no installation is managed", async () => {
  const unmanaged = storeWith({ configured: false, managed: false });
  assert.deepEqual(await slackSurfaceState(unmanaged, "configured"), { enabled: true, source: "environment" });
  assert.deepEqual(await slackSurfaceState(undefined, "configured"), { enabled: true, source: "environment" });
});

test("a half-configured environment stays disabled and says why", async () => {
  assert.deepEqual(await slackSurfaceState(undefined, "partial"), {
    enabled: false,
    source: "invalid_environment",
  });
});

test("nothing configured leaves the surface disabled", async () => {
  assert.deepEqual(await slackSurfaceState(undefined, "absent"), { enabled: false, source: "none" });
  assert.deepEqual(await slackSurfaceState(undefined, undefined), { enabled: false, source: "none" });
  assert.deepEqual(await slackSurfaceState(storeWith({ configured: false, managed: false }), undefined), {
    enabled: false,
    source: "none",
  });
});
