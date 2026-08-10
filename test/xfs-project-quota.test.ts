import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXfsProjectQuota, xfsProjectId, xfsScopeHash } from "../src/sandbox/xfs-project-quota.ts";

test("XFS project quota fails closed unless project accounting and enforcement are both active", async () => {
  const root = mkdtempSync(join(tmpdir(), "xfs-quota-off-"));
  const quota = createXfsProjectQuota({
    root,
    limitMb: 1024,
    quotaExec: async () => ({ code: 0, stdout: "Accounting: ON\nEnforcement: OFF\n", stderr: "" }),
  });

  await assert.rejects(quota.preflight(), /project quota accounting and enforcement must both be ON/);
});

test("XFS project quota creates a private scope tree and applies a hard byte limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "xfs-quota-on-"));
  const calls: string[][] = [];
  const quota = createXfsProjectQuota({
    root,
    limitMb: 2048,
    quotaExec: async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: args.includes("state -p") ? "Accounting: ON\nEnforcement: ON\n" : "",
        stderr: "",
      };
    },
  });
  const scope = "personal:Sensitive User";
  const projectId = xfsProjectId(scope);

  const first = await quota.ensure(scope);
  const second = await quota.ensure(scope);

  assert.equal(first.coldStart, true);
  assert.equal(second.coldStart, false);
  assert.equal(first.source, second.source);
  assert.equal(first.source.includes("Sensitive"), false);
  assert.deepEqual(calls[1], ["-x", "-c", `project -s -p ${first.source} ${projectId}`, root]);
  assert.deepEqual(calls[2], ["-x", "-c", `limit -p bhard=2048m ${projectId}`, root]);
  assert.equal(await readFile(join(root, ".projects", String(projectId)), "utf8"), xfsScopeHash(scope));
});

test("destroying an XFS quota tree clears the limit and project allocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "xfs-quota-destroy-"));
  const calls: string[][] = [];
  const quota = createXfsProjectQuota({
    root,
    limitMb: 512,
    quotaExec: async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: args.includes("state -p") ? "Accounting: ON\nEnforcement: ON\n" : "",
        stderr: "",
      };
    },
  });
  const scope = "team:T1";
  const created = await quota.ensure(scope);

  await quota.destroy(scope);

  assert.equal(
    calls.some((args) => args.includes(`limit -p bsoft=0 bhard=0 ${xfsProjectId(scope)}`)),
    true,
  );
  await assert.rejects(readFile(created.source));
  await assert.rejects(readFile(join(root, ".projects", String(xfsProjectId(scope)))));
});
