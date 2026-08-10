import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EGRESS_PROXY_AUD, mintCapabilityToken } from "../../src/auth/capability-token.ts";
import { spawnDockerExec } from "../../src/sandbox/docker-exec.ts";
import { probeRootfsQuota } from "../../src/sandbox/docker-lifecycle.ts";
import { authenticatedProxyEnv } from "../../src/sandbox/sandbox-env.ts";
import { scopeId } from "../../src/types.ts";

const docker = spawnDockerExec("docker");
const image = "qm-sandbox-local:latest";
const proxyImage = "qm-egress-proxy:local";

test("runner sandbox networks deny direct egress and isolate scopes while preserving the proxy path", async (t) => {
  if ((await docker(["version"], 15_000)).code !== 0) return t.skip("Docker daemon unavailable");
  if ((await docker(["image", "inspect", image], 15_000)).code !== 0) return t.skip(`${image} unavailable`);

  const suffix = randomUUID().slice(0, 8);
  const netA = `qmr-test-a-${suffix}`;
  const netB = `qmr-test-b-${suffix}`;
  const boxA = `qmr-test-box-a-${suffix}`;
  const boxB = `qmr-test-box-b-${suffix}`;
  const proxy = `qmr-test-proxy-${suffix}`;
  const containers = [boxA, boxB, proxy];
  const networks = [netA, netB];

  try {
    for (const network of networks) {
      const created = await docker(["network", "create", "--internal", network], 15_000);
      assert.equal(created.code, 0, created.stderr);
    }

    const proxyRun = await docker(
      ["run", "-d", "--name", proxy, "--network", netA, image, "python3", "-m", "http.server", "8088"],
      30_000,
    );
    assert.equal(proxyRun.code, 0, proxyRun.stderr);
    assert.equal((await docker(["network", "connect", netB, proxy], 15_000)).code, 0);

    for (const [box, network] of [
      [boxA, netA],
      [boxB, netB],
    ] as const) {
      const run = await docker(
        [
          "run",
          "-d",
          "--name",
          box,
          "--network",
          network,
          "--cpus",
          "0.5",
          "--memory",
          "256m",
          "--memory-swap",
          "256m",
          "--pids-limit",
          "64",
          "--storage-opt",
          "size=64m",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          image,
          "sleep",
          "300",
        ],
        30_000,
      );
      assert.equal(run.code, 0, run.stderr);
    }

    const viaProxy = await docker(["exec", boxA, "curl", "-fsS", "--max-time", "5", `http://${proxy}:8088`], 10_000);
    assert.equal(viaProxy.code, 0, viaProxy.stderr);

    const direct = await docker(
      [
        "exec",
        boxA,
        "env",
        "-u",
        "http_proxy",
        "-u",
        "https_proxy",
        "-u",
        "HTTP_PROXY",
        "-u",
        "HTTPS_PROXY",
        "-u",
        "ALL_PROXY",
        "-u",
        "all_proxy",
        "curl",
        "-fsS",
        "--connect-timeout",
        "2",
        "--max-time",
        "5",
        "https://example.com",
      ],
      10_000,
    );
    assert.notEqual(direct.code, 0);

    const dns = await docker(["exec", boxA, "getent", "hosts", "example.com"], 10_000);
    assert.notEqual(dns.code, 0);

    const crossScope = await docker(
      ["exec", boxA, "curl", "-fsS", "--connect-timeout", "2", "--max-time", "5", `http://${boxB}:8080`],
      10_000,
    );
    assert.notEqual(crossScope.code, 0);

    const limits = await docker(
      [
        "inspect",
        "-f",
        '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} {{index .HostConfig.StorageOpt "size"}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}',
        boxA,
      ],
      15_000,
    );
    assert.equal(limits.code, 0, limits.stderr);
    assert.equal(limits.stdout.trim(), '500000000 268435456 268435456 64 64m ["ALL"] ["no-new-privileges:true"]');
  } finally {
    for (const container of containers) await docker(["rm", "-f", container], 15_000);
    for (const network of networks) await docker(["network", "rm", network], 15_000);
  }
});

test("runner egress is forced through the domain policy proxy", async (t) => {
  if ((await docker(["version"], 15_000)).code !== 0) return t.skip("Docker daemon unavailable");
  if ((await docker(["image", "inspect", image], 15_000)).code !== 0) return t.skip(`${image} unavailable`);
  if ((await docker(["image", "inspect", proxyImage], 15_000)).code !== 0) return t.skip(`${proxyImage} unavailable`);

  const suffix = randomUUID().slice(0, 8);
  const serviceNetwork = `qmr-test-service-${suffix}`;
  const sandboxNetwork = `qmr-test-sandbox-${suffix}`;
  const box = `qmr-test-box-${suffix}`;
  const proxy = `qmr-test-egress-${suffix}`;
  const secret = "runner-egress-integration-secret";
  const token = await mintCapabilityToken(
    {
      actorId: "runner-security-test",
      scopeId: scopeId("personal", suffix),
      aud: EGRESS_PROXY_AUD,
      egress: { allowedHosts: ["example.com"], deniedHosts: [] },
      exp: Date.now() + 60_000,
    },
    secret,
  );

  try {
    assert.equal((await docker(["network", "create", serviceNetwork], 15_000)).code, 0);
    assert.equal((await docker(["network", "create", "--internal", sandboxNetwork], 15_000)).code, 0);
    const proxyRun = await docker(
      [
        "run",
        "-d",
        "--name",
        proxy,
        "--network",
        serviceNetwork,
        "--cap-add",
        "NET_ADMIN",
        "-e",
        `CAPABILITY_SECRET=${secret}`,
        "-e",
        "EGRESS_TOKENLESS=deny",
        proxyImage,
      ],
      30_000,
    );
    assert.equal(proxyRun.code, 0, proxyRun.stderr);
    assert.equal((await docker(["network", "connect", sandboxNetwork, proxy], 15_000)).code, 0);

    const proxyEnv = authenticatedProxyEnv(`http://${proxy}:48080`, token);
    const boxRun = await docker(
      [
        "run",
        "-d",
        "--name",
        box,
        "--network",
        sandboxNetwork,
        ...Object.entries(proxyEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        image,
        "sleep",
        "300",
      ],
      30_000,
    );
    assert.equal(boxRun.code, 0, boxRun.stderr);

    let proxyLogs = "";
    for (let attempt = 0; attempt < 50 && !proxyLogs.includes("[egress-authz] listening"); attempt++) {
      proxyLogs = (await docker(["logs", proxy], 15_000)).stdout;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(proxyLogs, /\[egress-authz\] listening/);

    const allowed = await docker(["exec", box, "curl", "-fsS", "--max-time", "10", "http://example.com"], 15_000);
    assert.equal(allowed.code, 0, allowed.stderr);

    const denied = await docker(["exec", box, "curl", "-fsS", "--max-time", "10", "http://iana.org"], 15_000);
    assert.notEqual(denied.code, 0);

    const tokenless = await docker(
      [
        "exec",
        box,
        "env",
        "-u",
        "http_proxy",
        "-u",
        "https_proxy",
        "-u",
        "HTTP_PROXY",
        "-u",
        "HTTPS_PROXY",
        "-u",
        "ALL_PROXY",
        "-u",
        "all_proxy",
        "curl",
        "-fsS",
        "--proxy",
        `http://${proxy}:48080`,
        "--max-time",
        "10",
        "http://example.com",
      ],
      15_000,
    );
    assert.notEqual(tokenless.code, 0);
  } finally {
    for (const container of [box, proxy]) await docker(["rm", "-f", container], 15_000);
    for (const network of [sandboxNetwork, serviceNetwork]) await docker(["network", "rm", network], 15_000);
  }
});

test("the rootfs quota probe's verdict matches what the storage driver actually enforces", async (t) => {
  if ((await docker(["version"], 15_000)).code !== 0) return t.skip("Docker daemon unavailable");
  if ((await docker(["image", "inspect", image], 15_000)).code !== 0) return t.skip(`${image} unavailable`);

  const capMb = 64;
  const verdict = await probeRootfsQuota(docker, image, capMb);

  const write = await docker(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--storage-opt",
      `size=${capMb}m`,
      image,
      "sh",
      "-c",
      `dd if=/dev/zero of=/rootfs-quota-probe bs=1M count=${capMb * 2} 2>/dev/null`,
    ],
    120_000,
  );
  const kernelEnforces = write.code !== 0;

  t.diagnostic(
    `driver ${kernelEnforces ? "enforces" : "ignores"} --storage-opt size; probe reported ${verdict.reportedMb ?? "nothing"}m for a ${capMb}m cap`,
  );
  assert.equal(
    verdict.enforced,
    kernelEnforces,
    "the probe must not claim a cap the driver ignores, nor deny one it honours",
  );
});
