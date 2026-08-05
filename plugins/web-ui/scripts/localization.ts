import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "node_modules", "@lit", "localize-tools", "bin", "lit-localize.js");
const tracked = [join(root, "xliff"), join(root, "src", "generated")];

function filesAt(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => filesAt(join(path, entry.name)));
}

function snapshot(): Map<string, string> {
  return new Map(tracked.flatMap(filesAt).map((path) => [relative(root, path), readFileSync(path, "utf8")]));
}

function run(command: "extract" | "build"): void {
  const result = spawnSync(process.execPath, [cli, command, "--config", join(root, "lit-localize.json")], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
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

function build(): void {
  run("build");
  for (const path of filesAt(join(root, "src", "generated"))) stripGenerated(path);
}

const command = process.argv[2];
if (command === "extract") run("extract");
else if (command === "build") build();
else if (command === "check") {
  const before = snapshot();
  run("extract");
  build();
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
