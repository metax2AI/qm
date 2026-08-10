import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { scopeId } from "../../src/types.ts";
import type { SandboxHandle } from "../../src/sandbox/sandbox.ts";
import { docker, skipUnavailable, startRunner, unavailableReason } from "./runner-harness.ts";

const suffix = (): string => randomUUID().replaceAll("-", "").slice(0, 10);

test(
  "a runner sandbox cannot reach the host kernel, its devices, or the docker daemon",
  { timeout: 300_000 },
  async (t) => {
    const skip = await unavailableReason();
    if (skip) return skipUnavailable(t, skip);

    const { sandbox } = await startRunner(t, "qmesc");
    const handle = await sandbox.provision([{ scopeId: scopeId("personal", suffix()), mountPath: "", mode: "rw" }]);
    const attempt = async (command: string): Promise<number> => (await sandbox.run(handle, command)).code;

    const status = await sandbox.run(handle, "grep -E '^(CapEff|CapBnd|NoNewPrivs):' /proc/self/status");
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(
      status.stdout
        .trim()
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .sort(),
      ["CapBnd: 0000000000000000", "CapEff: 0000000000000000", "NoNewPrivs: 1"],
    );

    assert.notEqual(await attempt("mount -t tmpfs none /mnt"), 0, "mounting needs CAP_SYS_ADMIN");
    assert.notEqual(await attempt("mknod /dev/qm-escape b 8 0"), 0, "device nodes need CAP_MKNOD");
    assert.notEqual(await attempt("dmesg"), 0, "the kernel ring buffer needs CAP_SYSLOG");
    assert.notEqual(await attempt("echo escaped > /proc/sys/kernel/hostname"), 0, "/proc/sys must stay read-only");
    assert.notEqual(await attempt("echo /tmp/payload > /sys/kernel/uevent_helper"), 0, "/sys must stay read-only");
    assert.notEqual(await attempt("mkdir /sys/fs/cgroup/qm-escape"), 0, "the cgroup tree must stay read-only");
    assert.notEqual(await attempt("test -e /var/run/docker.sock -o -e /run/docker.sock"), 0, "no docker socket");

    const devices = await sandbox.run(handle, "ls /dev");
    assert.equal(devices.code, 0, devices.stderr);
    assert.deepEqual(
      devices.stdout.trim().split(/\s+/).filter(Boolean).sort(),
      [
        "core",
        "fd",
        "full",
        "mqueue",
        "null",
        "ptmx",
        "pts",
        "random",
        "shm",
        "stderr",
        "stdin",
        "stdout",
        "tty",
        "urandom",
        "zero",
      ],
      "the sandbox sees only docker's default device set — no host block devices",
    );

    const hostConfig = await docker(
      [
        "inspect",
        "-f",
        "{{.HostConfig.Privileged}} {{json .HostConfig.CapAdd}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}} {{json .HostConfig.Devices}} {{json .HostConfig.Binds}} [{{.HostConfig.PidMode}}] [{{.HostConfig.IpcMode}}] [{{.HostConfig.UsernsMode}}] [{{.HostConfig.NetworkMode}}]",
        handle.id,
      ],
      15_000,
    );
    assert.equal(hostConfig.code, 0, hostConfig.stderr);
    assert.equal(
      hostConfig.stdout.trim(),
      `false null ["ALL"] ["no-new-privileges:true"] [] ["${handle.id.replace("-sbx-", "-home-")}:/root"] [] [private] [] [${handle.id.replace("-sbx-", "-net-")}]`,
      "the runner must not grant privileges, capabilities, host devices, host namespaces, or host paths",
    );

    const mounts = await docker(["inspect", "-f", "{{json .Mounts}}", handle.id], 15_000);
    assert.equal(mounts.code, 0, mounts.stderr);
    const paths = (JSON.parse(mounts.stdout) as Array<{ Type: string; Destination: string }>).map(
      ({ Type, Destination }) => `${Type}:${Destination}`,
    );
    assert.deepEqual(paths, ["volume:/root"], "the scope home volume is the only thing mounted into a sandbox");
  },
);

test("one scope's sandbox cannot see another scope's processes or files", { timeout: 300_000 }, async (t) => {
  const skip = await unavailableReason();
  if (skip) return skipUnavailable(t, skip);

  const { sandbox } = await startRunner(t, "qmesc");
  const marker = `qm-escape-${suffix()}`;
  const provision = (scope: string): Promise<SandboxHandle> =>
    sandbox.provision([{ scopeId: scopeId("personal", scope), mountPath: "", mode: "rw" }]);

  const victim = await provision(suffix());
  const attacker = await provision(suffix());

  const dumpCmdlines = 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done';
  const planted = await sandbox.run(
    victim,
    `cp /bin/sleep /tmp/${marker} && (/tmp/${marker} 600 </dev/null >/dev/null 2>&1 &) && printf secret > /root/${marker}.txt`,
  );
  assert.equal(planted.code, 0, planted.stderr);
  const ownView = await sandbox.run(victim, dumpCmdlines);
  assert.equal(ownView.code, 0, ownView.stderr);
  assert.match(ownView.stdout, new RegExp(marker), "the victim sees its own process, so the dump itself works");

  const processes = await sandbox.run(attacker, dumpCmdlines);
  assert.equal(processes.code, 0, processes.stderr);
  assert.doesNotMatch(processes.stdout, new RegExp(marker), "the attacker's PID namespace excludes the victim");
  assert.match(processes.stdout, /microvm-agent/, "the attacker sees only its own container's processes");

  const victimFile = await sandbox.run(victim, `cat /root/${marker}.txt`);
  assert.equal(victimFile.stdout, "secret", "the victim's own home volume holds the file");
  const files = await sandbox.run(attacker, `cat /root/${marker}.txt`);
  assert.notEqual(files.code, 0, "the attacker's home volume must not contain the victim's file");
});
