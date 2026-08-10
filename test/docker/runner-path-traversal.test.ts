import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runnerBoxPath } from "../../src/runner/protocol.ts";
import { scopeId } from "../../src/types.ts";
import type { SandboxHandle } from "../../src/sandbox/sandbox.ts";
import {
  docker,
  rawPost,
  skipUnavailable,
  startRunner,
  unavailableReason,
  type RawResponse,
  type RunnerHarness,
} from "./runner-harness.ts";

const suffix = (): string => randomUUID().replaceAll("-", "").slice(0, 10);

const call = (harness: RunnerHarness, id: string, action: string, body: unknown): Promise<RawResponse> =>
  rawPost(harness, `${runnerBoxPath(id, action)}?n=${randomUUID()}`, body);

test("file paths cannot leave the workspace, and nothing reaches the host", { timeout: 300_000 }, async (t) => {
  const skip = await unavailableReason();
  if (skip) return skipUnavailable(t, skip);

  const harness = await startRunner(t, "qmtrav");
  const { sandbox } = harness;
  const handle = await sandbox.provision([{ scopeId: scopeId("personal", suffix()), mountPath: "", mode: "rw" }]);
  const marker = `qm-traversal-${suffix()}`;

  const hostFile = join(tmpdir(), `${marker}.host`);
  writeFileSync(hostFile, "host secret");

  for (const rel of [
    `../${marker}.txt`,
    "../../etc/passwd",
    "..",
    `a/../../${marker}.txt`,
    hostFile.replace(/^\//, "../".repeat(12)),
  ]) {
    await assert.rejects(sandbox.writeFile(handle, rel, "escaped"), /path must stay under/, `write ${rel}`);
    await assert.rejects(sandbox.readFile(handle, rel), /path must stay under/, `read ${rel}`);
    await assert.rejects(sandbox.removeDir(handle, rel), /path must stay under/, `removeDir ${rel}`);
  }

  const home = await sandbox.run(handle, `ls -A /root | grep -c ${marker} || true`);
  assert.equal(home.stdout.trim(), "0", "no traversing write reached the scope's home directory");

  assert.equal(await sandbox.readFile(handle, `/tmp/${marker}.host`), null, "absolute paths stay workspace-relative");
  const joined = await sandbox.run(handle, `cat /root/workspace/tmp/${marker}.host`);
  assert.notEqual(joined.code, 0, "an absolute path is joined under the workspace, where nothing was written");

  await sandbox.writeFile(handle, `nested/${marker}.txt`, "inside");
  assert.equal(await sandbox.readFile(handle, `nested/${marker}.txt`), "inside", "ordinary paths still work");
});

test("the runner refuses sandbox ids that address anything but its own boxes", { timeout: 300_000 }, async (t) => {
  const skip = await unavailableReason();
  if (skip) return skipUnavailable(t, skip);

  const harness = await startRunner(t, "qmtrav");
  const handle = await harness.sandbox.provision([
    { scopeId: scopeId("personal", suffix()), mountPath: "", mode: "rw" },
  ]);

  const body = {
    cmd: "printf pwned",
    timeoutSec: 5,
    path: "/etc/passwd",
    b64: "",
    acquisitionId: handle.acquisitionId,
  };
  const ok = await call(harness, handle.id, "exec", {
    cmd: "printf ok",
    timeoutSec: 5,
    acquisitionId: handle.acquisitionId,
  });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.text, /"stdout":"ok"/, "a hand-built request reaches the box, so the rejections below are the check");

  for (const id of [
    "..",
    `..%2f${handle.id}`,
    "..%2f..%2fetc%2fpasswd",
    "%2fetc%2fpasswd",
    `${handle.id}%2f..%2f..%2f..%2fetc`,
    "qm-sbx-someone-elses-box",
    `-${harness.namePrefix}-sbx-x`,
    harness.namePrefix,
  ]) {
    for (const action of ["exec", "read", "write", "teardown"]) {
      const res = await rawPost(harness, `/v1/sandboxes/${id}/${action}?n=${randomUUID()}`, body);
      assert.equal(res.status, 400, `${action} ${id} -> ${res.status} ${res.text}`);
      assert.match(res.text, /invalid sandbox id/, `${action} ${id}`);
    }
  }

  for (const target of [
    `/v1/sandboxes/../${handle.id}/exec`,
    `/v1/sandboxes/./${handle.id}/exec`,
    `/v1/sandboxes/${handle.id}/../${handle.id}/exec`,
    "/v1/sandboxes/../health",
  ]) {
    const res = await rawPost(harness, `${target}?n=${randomUUID()}`, body);
    assert.notEqual(res.status, 200, `${target} -> ${res.status} ${res.text}`);
  }
});

test("an absolute path in a runner request stays inside that one container", { timeout: 300_000 }, async (t) => {
  const skip = await unavailableReason();
  if (skip) return skipUnavailable(t, skip);

  const harness = await startRunner(t, "qmtrav");
  const scope = (): Promise<SandboxHandle> =>
    harness.sandbox.provision([{ scopeId: scopeId("personal", suffix()), mountPath: "", mode: "rw" }]);
  const target = await scope();
  const bystander = await scope();
  const marker = `qm-abs-${suffix()}`;

  const written = await call(harness, target.id, "write", {
    path: `/etc/${marker}`,
    b64: Buffer.from("planted").toString("base64"),
    acquisitionId: target.acquisitionId,
  });
  assert.equal(written.status, 200, written.text);

  const readBack = await call(harness, target.id, "read", {
    path: `/etc/${marker}`,
    acquisitionId: target.acquisitionId,
  });
  assert.equal(readBack.status, 200, readBack.text);
  assert.equal(Buffer.from((JSON.parse(readBack.text) as { b64: string }).b64, "base64").toString(), "planted");

  const elsewhere = await call(harness, bystander.id, "read", {
    path: `/etc/${marker}`,
    acquisitionId: bystander.acquisitionId,
  });
  assert.equal(elsewhere.status, 404, "the write reached one container's mount namespace only");

  const socket = await call(harness, target.id, "read", {
    path: "/var/run/docker.sock",
    acquisitionId: target.acquisitionId,
  });
  assert.equal(socket.status, 404, "there is no docker socket to read inside a sandbox");

  const hostSide = await docker(["exec", target.id, "test", "-e", `/etc/${marker}`], 15_000);
  assert.equal(hostSide.code, 0, "the file exists in the container");
  assert.notEqual((await docker(["exec", bystander.id, "test", "-e", `/etc/${marker}`], 15_000)).code, 0);
});
