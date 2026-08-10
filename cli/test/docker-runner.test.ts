import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerDown, dockerLogs, dockerStatus, dockerUp } from "../src/backends/docker.ts";
import { CONFIG_FILENAME, loadConfigAt } from "../src/config.ts";

const SANDBOX_IMAGE = `registry.example.com/qm/sandbox@sha256:${"7a".repeat(32)}`;
const SECRET_VALUES = {
  CAPABILITY_SECRET: "capability-secret".repeat(3),
  CONNECTOR_SECRET_KEY: "connector-secret".repeat(3),
  CORE_SIGNING_SECRET: "core-signing-secret".repeat(3),
  PORTAL_IDENTITY_SECRET: "portal-identity-secret".repeat(3),
  SANDBOX_RUNNER_SECRET: "runner-signing-secret".repeat(3),
  SKILL_SIGNING_SECRET: "skill-signing-secret".repeat(3),
};

function fakeDocker(dir: string): { argvLog: string; envLog: string } {
  const argvLog = join(dir, "docker-argv.log");
  const envLog = join(dir, "docker-env.log");
  const bin = join(dir, "docker");
  writeFileSync(argvLog, "");
  writeFileSync(envLog, "");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "version") { console.log("25.0"); process.exit(0); }
if (args[0] === "run") {
  const envFile = args.indexOf("--env-file");
  if (envFile !== -1) {
    fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({ name: args[args.indexOf("--name") + 1], env: fs.readFileSync(args[envFile + 1], "utf8") }) + "\\n");
  }
  console.log("cid");
  process.exit(0);
}
if (args[0] === "logs") {
  const name = args[args.length - 1];
  if (name.endsWith("-runner")) console.log("[runner] listening on 172.18.0.3:48090");
  else if (name.endsWith("-egress-proxy")) console.log("[egress-authz] listening on 127.0.0.1:48081");
  else console.log("listening on :8080");
  process.exit(0);
}
if (args[0] === "inspect") { console.log("true"); process.exit(0); }
if (args[0] === "ps") {
  console.log(["qm-acme-core", "qm-acme-runner", "qm-acme-egress-proxy"].join("\\n"));
  process.exit(0);
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  return { argvLog, envLog };
}

test("docker up wires the isolated runner and egress proxy before core", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-runner-"));
  const priorPath = process.env.PATH;
  const priorDatabase = process.env.DATABASE_URL;
  const logs = console.log;
  const warnings = console.warn;
  try {
    const homeRoot = join(dir, "sandbox-homes");
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        sandbox: { backend: "runner", image: SANDBOX_IMAGE },
        env: { core: { RUNNER_SANDBOX_HOME_ROOT: homeRoot } },
      }),
    );
    writeFileSync(
      join(dir, ".env"),
      `${Object.entries(SECRET_VALUES)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
    );
    const fake = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    process.env.DATABASE_URL = "postgres://operator:password@db.internal/qm";
    console.log = (): void => {};
    console.warn = console.log;

    const config = loadConfigAt(join(dir, CONFIG_FILENAME)).config;
    await dockerUp(config, dir);
    dockerStatus(config);
    await dockerLogs(config, "runner");
    await dockerDown(config);

    const calls = readFileSync(fake.argvLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const runs = calls.filter((args) => args[0] === "run");
    const byName = new Map(runs.map((args) => [args[args.indexOf("--name") + 1]!, args]));
    const proxy = byName.get("qm-acme-egress-proxy")!;
    const runner = byName.get("qm-acme-runner")!;
    const core = byName.get("qm-acme-core")!;
    assert.ok(proxy);
    assert.ok(runner);
    assert.ok(core);
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "pull" && args[1] === "--platform" && args[2] === "linux/amd64" && args[3] === SANDBOX_IMAGE,
      ),
    );
    assert.ok(runs.indexOf(proxy) < runs.indexOf(runner));
    assert.ok(runs.indexOf(runner) < runs.indexOf(core));
    assert.ok(proxy.includes("NET_ADMIN"));
    assert.ok(runner.includes("/var/run/docker.sock:/var/run/docker.sock"));
    assert.ok(runner.includes("SYS_ADMIN"));
    assert.ok(runner.includes(`${homeRoot}:${homeRoot}`));
    assert.ok(!core.some((arg) => arg.includes("docker.sock")));
    assert.ok(runner.includes(`RUNNER_SANDBOX_IMAGE=${SANDBOX_IMAGE}`));
    assert.ok(runner.includes(`RUNNER_SANDBOX_HOME_ROOT=${homeRoot}`));
    assert.ok(runner.includes("RUNNER_SELF_CONTAINER=qm-acme-runner"));
    assert.ok(runner.includes("RUNNER_SERVICE_NETWORK=qm-acme"));
    assert.ok(runner.includes("RUNNER_EGRESS_PROXY_URL=http://qm-acme-egress-proxy:48080"));
    assert.ok(core.includes("SANDBOX_BACKEND=runner"));
    assert.ok(core.includes("RUNNER_URL=http://qm-acme-runner:48090"));
    assert.ok(core.includes("RUNNER_EGRESS_PROXY_URL=http://qm-acme-egress-proxy:48080"));
    const argv = readFileSync(fake.argvLog, "utf8");
    for (const value of [...Object.values(SECRET_VALUES), process.env.DATABASE_URL]) assert.ok(!argv.includes(value));
    const envFiles = readFileSync(fake.envLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string; env: string });
    const envByName = new Map(envFiles.map((entry) => [entry.name, entry.env]));
    assert.match(envByName.get("qm-acme-runner")!, /^SANDBOX_RUNNER_SECRET=/m);
    assert.match(envByName.get("qm-acme-runner")!, /^DATABASE_URL=/m);
    assert.match(envByName.get("qm-acme-egress-proxy")!, /^CAPABILITY_SECRET=/m);
    assert.match(envByName.get("qm-acme-egress-proxy")!, /^DATABASE_URL=/m);
    assert.match(envByName.get("qm-acme-core")!, /^SANDBOX_RUNNER_SECRET=/m);
    assert.ok(calls.some((args) => args[0] === "logs" && args.at(-1) === "qm-acme-runner"));
    assert.ok(calls.some((args) => args[0] === "rm" && args.at(-1) === "qm-acme-runner"));
    assert.ok(calls.some((args) => args[0] === "rm" && args.at(-1) === "qm-acme-egress-proxy"));
  } finally {
    console.log = logs;
    console.warn = warnings;
    process.env.PATH = priorPath;
    if (priorDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabase;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docker purge removes only this organization's configured runner homes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-runner-purge-"));
  const priorPath = process.env.PATH;
  const logs = console.log;
  const warnings = console.warn;
  try {
    const homeRoot = join(dir, "sandbox-homes");
    mkdirSync(join(homeRoot, "acme"), { recursive: true });
    mkdirSync(join(homeRoot, "globex"), { recursive: true });
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        sandbox: { backend: "runner", image: SANDBOX_IMAGE },
        env: { core: { RUNNER_SANDBOX_HOME_ROOT: homeRoot } },
      }),
    );
    fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    console.log = (): void => {};
    console.warn = console.log;

    const config = loadConfigAt(join(dir, CONFIG_FILENAME)).config;
    await dockerDown(config, { purge: true });

    assert.equal(existsSync(join(homeRoot, "acme")), false);
    assert.equal(existsSync(join(homeRoot, "globex")), true);
  } finally {
    console.log = logs;
    console.warn = warnings;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
