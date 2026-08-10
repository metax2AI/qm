import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createXfsProjectQuota,
  xfsMountPointOf,
  xfsProjectId,
  xfsScopeHash,
} from "../src/sandbox/xfs-project-quota.ts";

function tmpRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function mountinfoFor(mountPoint: string, fstype = "xfs"): string {
  return [
    `24 30 0:22 / /proc rw,relatime - proc proc rw`,
    `31 1 259:1 / / rw,relatime - ext4 /dev/vda1 rw`,
    `48 31 253:0 / ${mountPoint} rw,relatime - ${fstype} /dev/vdb rw,prjquota`,
  ].join("\n");
}

function mountinfoPathFor(mountPoint: string, fstype?: string): string {
  const path = join(tmpRoot("xfs-mountinfo-"), "mountinfo");
  writeFileSync(path, mountinfoFor(mountPoint, fstype));
  return path;
}

test("XFS project quota fails closed unless project accounting and enforcement are both active", async () => {
  const root = tmpRoot("xfs-quota-off-");
  const quota = createXfsProjectQuota({
    root,
    registryRoot: root,
    namespace: "acme",
    limitMb: 1024,
    mountinfoPath: mountinfoPathFor(root),
    quotaExec: async () => ({ code: 0, stdout: "Accounting: ON\nEnforcement: OFF\n", stderr: "" }),
  });

  await assert.rejects(quota.preflight(), /project quota accounting and enforcement must both be ON/);
});

test("XFS project quota addresses the mount point, not the scope tree inside it", async () => {
  const mountPoint = tmpRoot("xfs-quota-mount-");
  const root = join(mountPoint, "qm", "sandbox-homes", "acme");
  const calls: string[][] = [];
  const quota = createXfsProjectQuota({
    root,
    registryRoot: join(mountPoint, "qm", "sandbox-homes"),
    namespace: "acme",
    limitMb: 64,
    mountinfoPath: mountinfoPathFor(mountPoint),
    quotaExec: async (args) => {
      calls.push(args);
      return { code: 0, stdout: args.includes("state -p") ? "Accounting: ON\nEnforcement: ON\n" : "", stderr: "" };
    },
  });

  await quota.ensure("personal:U1");

  assert.equal(calls.length > 0, true);
  for (const args of calls) assert.equal(args.at(-1), mountPoint);
});

test("XFS project quota refuses a home root that is not on an XFS filesystem", async () => {
  const root = tmpRoot("xfs-quota-ext4-");
  const quota = createXfsProjectQuota({
    root,
    registryRoot: root,
    namespace: "acme",
    limitMb: 64,
    mountinfoPath: mountinfoPathFor(root, "ext4"),
    quotaExec: async () => ({ code: 0, stdout: "Accounting: ON\nEnforcement: ON\n", stderr: "" }),
  });

  await assert.rejects(quota.preflight(), /not an XFS filesystem/);
});

test("XFS project quota treats an xfs_quota diagnostic as failure even when it exits zero", async () => {
  const root = tmpRoot("xfs-quota-enxio-");
  const quota = createXfsProjectQuota({
    root,
    registryRoot: root,
    namespace: "acme",
    limitMb: 64,
    mountinfoPath: mountinfoPathFor(root),
    quotaExec: async () => ({
      code: 0,
      stdout: "",
      stderr: `xfs_quota: cannot setup path for mount ${root}: No such device or address\n`,
    }),
  });

  await assert.rejects(quota.preflight(), /cannot setup path for mount/);
});

test("XFS project quota reports a silent per-scope command failure instead of running without a limit", async () => {
  const root = tmpRoot("xfs-quota-limit-");
  const quota = createXfsProjectQuota({
    root,
    registryRoot: root,
    namespace: "acme",
    limitMb: 64,
    mountinfoPath: mountinfoPathFor(root),
    quotaExec: async (args) => ({
      code: 0,
      stdout: args.includes("state -p") ? "Accounting: ON\nEnforcement: ON\n" : "",
      stderr: args.some((arg) => arg.startsWith("limit -p"))
        ? "xfs_quota: cannot set limits: Operation not permitted\n"
        : "",
    }),
  });

  await assert.rejects(quota.ensure("personal:U1"), /xfs project limit failed: xfs_quota: cannot set limits/);
});

test("the XFS mount point of a path is the mount that actually holds it", () => {
  const mountinfo = [
    `31 1 259:1 / / rw,relatime - ext4 /dev/vda1 rw`,
    `48 31 253:0 / /data rw,relatime - xfs /dev/vdb rw,prjquota`,
    `52 48 253:1 / /data/nested rw,relatime - xfs /dev/vdc rw,prjquota`,
    `56 48 0:61 / /data/scratch rw,relatime - tmpfs tmpfs rw`,
    `60 31 253:2 / /data-archive rw,relatime - xfs /dev/vdd rw,prjquota`,
  ].join("\n");

  assert.equal(xfsMountPointOf("/data/qm/sandbox-homes/acme", mountinfo), "/data");
  assert.equal(xfsMountPointOf("/data/nested/homes", mountinfo), "/data/nested");
  assert.throws(() => xfsMountPointOf("/srv/homes", mountinfo), /is on \/ \(ext4\), not an XFS filesystem/);
  assert.throws(() => xfsMountPointOf("/data/scratch/homes", mountinfo), /is on \/data\/scratch \(tmpfs\)/);
});

test("a nearer non-XFS mount hides the XFS filesystem beneath it", () => {
  const mountinfo = [
    `31 1 259:1 / / rw,relatime - xfs /dev/mapper/root rw,prjquota`,
    `48 31 0:61 / /var/lib/qm/sandbox-homes rw,relatime - tmpfs tmpfs rw`,
  ].join("\n");

  assert.throws(
    () => xfsMountPointOf("/var/lib/qm/sandbox-homes/acme", mountinfo),
    /is on \/var\/lib\/qm\/sandbox-homes \(tmpfs\), not an XFS filesystem/,
  );
});

test("XFS project quota creates a private scope tree and applies a hard byte limit", async () => {
  const root = tmpRoot("xfs-quota-on-");
  const calls: string[][] = [];
  const quota = createXfsProjectQuota({
    root,
    registryRoot: root,
    namespace: "acme",
    limitMb: 2048,
    mountinfoPath: mountinfoPathFor(root),
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
  const projectId = xfsProjectId("acme", scope);

  const first = await quota.ensure(scope);
  const second = await quota.ensure(scope);

  assert.equal(first.coldStart, true);
  assert.equal(second.coldStart, false);
  assert.equal(first.source, second.source);
  assert.equal(first.source.includes("Sensitive"), false);
  assert.deepEqual(calls[1], ["-x", "-c", `project -s -p ${first.source} ${projectId}`, root]);
  assert.deepEqual(calls[2], ["-x", "-c", `limit -p bhard=2048m ${projectId}`, root]);
  assert.equal(await readFile(join(root, ".projects", String(projectId)), "utf8"), xfsScopeHash("acme", scope));
});

test("destroying an XFS quota tree clears the limit and project allocation", async () => {
  const root = tmpRoot("xfs-quota-destroy-");
  const calls: string[][] = [];
  const quota = createXfsProjectQuota({
    root,
    registryRoot: root,
    namespace: "acme",
    limitMb: 512,
    mountinfoPath: mountinfoPathFor(root),
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
    calls.some((args) => args.includes(`limit -p bsoft=0 bhard=0 ${xfsProjectId("acme", scope)}`)),
    true,
  );
  await assert.rejects(readFile(created.source));
  await assert.rejects(readFile(join(root, ".projects", String(xfsProjectId("acme", scope)))));
});

test("XFS project quota IDs are partitioned by organization", () => {
  const scope = "personal:U1";
  assert.notEqual(xfsProjectId("acme", scope), xfsProjectId("globex", scope));
  assert.notEqual(xfsScopeHash("acme", scope), xfsScopeHash("globex", scope));
});

test("a shared XFS registry rejects a project ID collision across organizations", async () => {
  const registryRoot = tmpRoot("xfs-quota-shared-");
  const quotaExec = async (args: string[]) => ({
    code: 0,
    stdout: args.includes("state -p") ? "Accounting: ON\nEnforcement: ON\n" : "",
    stderr: "",
  });
  const mountinfoPath = mountinfoPathFor(registryRoot);
  const acme = createXfsProjectQuota({
    root: join(registryRoot, "acme"),
    registryRoot,
    namespace: "acme",
    limitMb: 64,
    mountinfoPath,
    quotaExec,
  });
  const globex = createXfsProjectQuota({
    root: join(registryRoot, "globex"),
    registryRoot,
    namespace: "globex",
    limitMb: 64,
    mountinfoPath,
    quotaExec,
  });
  const acmeScope = "personal:A5957";
  const globexScope = "personal:B32628";
  assert.equal(xfsProjectId("acme", acmeScope), xfsProjectId("globex", globexScope));

  await acme.ensure(acmeScope);
  await assert.rejects(globex.ensure(globexScope), /XFS project id collision/);
});
