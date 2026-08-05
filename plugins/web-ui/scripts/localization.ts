import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runAndLog } from "@lit/localize-tools/lib/cli.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tracked = [join(root, "xliff"), join(root, "src", "generated")];

function filesAt(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => filesAt(join(path, entry.name)));
}

function snapshot(): Map<string, string> {
  return new Map(tracked.flatMap(filesAt).map((path) => [relative(root, path), readFileSync(path, "utf8")]));
}

async function run(command: "extract" | "build"): Promise<void> {
  const status = await runAndLog([
    process.execPath,
    "lit-localize",
    command,
    "--config",
    join(root, "lit-localize.json"),
  ]);
  if (status !== 0) process.exit(status);
}

function stripGenerated(path: string): void {
  let source = readFileSync(path, "utf8")
    .replace(
      /^\s*\/\/ Do not modify this file by hand!\n\s*\/\/ Re-generate this file by running lit-localize\.?\n/m,
      "",
    )
    .replace(/^\s*\/\*\*[\s\S]*?^\s*\*\/\n/gm, "")
    .replace(/^\s*\/\* eslint-disable [^\n]*\*\/\n/gm, "")
    .trim();
  source = source
    .replace(/^[ \t]+(?=import |export const templates =|};$)/gm, "")
    .replace(/^[ \t]*('(?:h|s)[0-9a-f]+':)/gm, "  $1");
  writeFileSync(path, `${source.replace(/\n{3,}/g, "\n\n")}\n`);
}

async function build(): Promise<void> {
  await run("build");
  for (const path of filesAt(join(root, "src", "generated"))) stripGenerated(path);
}

const command = process.argv[2];
if (command === "extract") await run("extract");
else if (command === "build") await build();
else if (command === "check") {
  const before = snapshot();
  await run("extract");
  await build();
  const after = snapshot();
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => before.get(path) !== after.get(path),
  );
  if (changed.length) {
    process.stderr.write(`Localization files were out of date:\n${changed.map((path) => `- ${path}`).join("\n")}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write("Expected extract, build, or check.\n");
  process.exit(1);
}
