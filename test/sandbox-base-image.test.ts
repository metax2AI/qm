import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = (): string => readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");

test("the sandbox base permits Claude Code's required install script", () => {
  assert.match(dockerfile(), /npm install -g --allow-scripts=@anthropic-ai\/claude-code/);
});

test("the sandbox base ships pinned document parsers, so agents never install them over the network", () => {
  const text = dockerfile();
  for (const pkg of ["pandas", "openpyxl", "python-docx", "pdfplumber", "chardet"]) {
    assert.match(text, new RegExp(`"${pkg}==\\d+\\.\\d+\\.\\d+"`), `${pkg} must be installed at a pinned version`);
  }
});
