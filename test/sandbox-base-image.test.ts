import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DOCUMENT_PARSERS_FACT } from "../src/sandbox/sandbox.ts";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const AGENT_ROOTFS = ["fly/Dockerfile", "aws/microvm-agent/Dockerfile", "cli/templates/aws/microvm-agent/Dockerfile"];

const DOCUMENT_PARSERS = [
  { pkg: "pandas", module: "pandas" },
  { pkg: "openpyxl", module: "openpyxl" },
  { pkg: "python-docx", module: "docx" },
  { pkg: "pdfplumber", module: "pdfplumber" },
  { pkg: "chardet", module: "chardet" },
];

test("the sandbox base permits Claude Code's required install script", () => {
  assert.match(read("fly/Dockerfile"), /npm install -g --allow-scripts=@anthropic-ai\/claude-code/);
});

test("the runner image ships the Alpine package that provides xfs_quota", () => {
  assert.match(read("deploy/runner/Dockerfile"), /apk add --no-cache .*xfsprogs-extra/);
});

for (const path of AGENT_ROOTFS) {
  test(`${path} ships pinned document parsers, so agents never install them over the network`, () => {
    const text = read(path);
    assert.match(text, /python3 -m venv \/opt\/agent-venv/, "this file must still build the agent venv");
    for (const { pkg } of DOCUMENT_PARSERS) {
      assert.match(text, new RegExp(`"${pkg}==\\d+\\.\\d+\\.\\d+"`), `${pkg} must be installed at a pinned version`);
    }
    assert.match(text, /--only-binary=:all:/, "a missing wheel must fail fast rather than compile from source");
  });
}

test("the advertised parser fact names every module the images install", () => {
  for (const { module } of DOCUMENT_PARSERS) {
    assert.ok(
      DOCUMENT_PARSERS_FACT.includes(module),
      `agents are told what is preinstalled through this string, so it must name ${module}`,
    );
  }
});
