import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import ts from "typescript";

const catalog = new JSDOM(readFileSync(new URL("../xliff/zh-Hans.xlf", import.meta.url), "utf8"), {
  contentType: "text/xml",
});
const units = [...catalog.window.document.querySelectorAll("trans-unit")];

function placeholderIds(element: Element): string[] {
  return [
    ...new Set([...element.querySelectorAll("x")].map((placeholder) => placeholder.getAttribute("id") ?? "")),
  ].sort();
}

test("the zh-Hans catalog contains the full application message set", () => {
  assert.ok(units.length >= 900, `expected at least 900 messages, found ${units.length}`);
});

test("every zh-Hans catalog message has a non-empty target", () => {
  const missing = units.flatMap((unit) => {
    const target = unit.querySelector("target");
    const hasContent =
      target && [...target.childNodes].some((node) => node.nodeType === 1 || Boolean(node.textContent?.trim()));
    return hasContent ? [] : [unit.getAttribute("id") ?? "<missing id>"];
  });
  assert.equal(missing.length, 0, `${missing.length} messages have no target: ${missing.slice(0, 12).join(", ")}`);
});

test("zh-Hans targets preserve every source placeholder id", () => {
  const mismatches = units.flatMap((unit) => {
    const source = unit.querySelector("source");
    const target = unit.querySelector("target");
    if (!source || !target) return [];
    const sourceIds = placeholderIds(source);
    const targetIds = placeholderIds(target);
    return JSON.stringify(sourceIds) === JSON.stringify(targetIds)
      ? []
      : [`${unit.getAttribute("id")}: source [${sourceIds.join(", ")}], target [${targetIds.join(", ")}]`];
  });
  assert.equal(
    mismatches.length,
    0,
    `${mismatches.length} messages changed placeholders: ${mismatches.slice(0, 12).join("; ")}`,
  );
});

const allowedUntranslatedTargets = new Set(["Core", "DEV", "Harness", "Slack", "Ultracode", "you@org.com"]);

test("zh-Hans targets do not leave user-facing English unchanged", () => {
  const unchanged = units.flatMap((unit) => {
    const source = normalizedVisibleText(unit.querySelector("source")?.textContent ?? "");
    const target = normalizedVisibleText(unit.querySelector("target")?.textContent ?? "");
    if (!source || source !== target || !isObviousEnglish(source) || allowedUntranslatedTargets.has(source)) return [];
    return [`${unit.getAttribute("id")}: ${source}`];
  });
  assert.equal(unchanged.length, 0, `unchanged English targets:\n${unchanged.join("\n")}`);
});

type VisibleLiteral = { file: string; kind: string; line: number; value: string };

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const allowedTechnicalLiterals = new Set([
  "chat.ts:text:bash",
  "connectors.ts:placeholder:Stripe",
  "connectors.ts:placeholder:STRIPE_API_KEY",
  "core-bridge.ts:return:HTTP",
  "skills.ts:placeholder:watch-pipeline",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "generated") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function normalizedVisibleText(value: string): string {
  return value
    .replace(/__QM_LIT_SLOT_\d+__/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isObviousEnglish(value: string): boolean {
  return /[A-Za-z]{2,}/.test(value);
}

function templateParts(template: ts.TemplateLiteral): string[] {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return [template.text];
  return [template.head.text, ...template.templateSpans.map((span) => span.literal.text)];
}

function visibleLiterals(file: string): VisibleLiteral[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const relativeFile = relative(sourceRoot, file).replaceAll("\\", "/");
  const findings: VisibleLiteral[] = [];

  function add(kind: string, value: string, node: ts.Node): void {
    const normalized = normalizedVisibleText(value);
    if (!isObviousEnglish(normalized)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    findings.push({ file: relativeFile, kind, line, value: normalized });
  }

  function visit(node: ts.Node): void {
    if (ts.isReturnStatement(node) && node.expression) {
      let raw: string | null = null;
      if (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)) {
        raw = node.expression.text;
      } else if (ts.isTemplateExpression(node.expression)) {
        raw = templateParts(node.expression)
          .map((part, index) => (index === 0 ? part : `__QM_LIT_SLOT_${index}__${part}`))
          .join("");
      }
      if (raw) {
        const visible = raw.includes("<") ? (JSDOM.fragment(raw).textContent ?? "") : raw;
        if (normalizedVisibleText(visible).includes(" ")) add("return", visible, node.expression);
      }
    }
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(sourceFile) === "html") {
      const parent = node.parent;
      const localized = ts.isCallExpression(parent) && parent.expression.getText(sourceFile) === "msg";
      if (!localized) {
        const raw = templateParts(node.template)
          .map((part, index) => (index === 0 ? part : `__QM_LIT_SLOT_${index}__${part}`))
          .join("");
        const fragment = JSDOM.fragment(raw);
        const textWalker = fragment.ownerDocument.createTreeWalker(fragment, 4);
        for (let textNode = textWalker.nextNode(); textNode; textNode = textWalker.nextNode()) {
          if (textNode.parentElement?.matches("style, script")) continue;
          add("text", textNode.nodeValue ?? "", node);
        }
        for (const element of fragment.querySelectorAll("*")) {
          for (const attribute of element.attributes) {
            const name = attribute.name.replace(/^[.?]/, "");
            const kind = name === "arialabel" ? "aria-label" : name;
            if (kind === "aria-label" || kind === "title" || kind === "placeholder") add(kind, attribute.value, node);
          }
        }
        if (ts.isTemplateExpression(node.template)) {
          let preceding = node.template.head.text;
          for (const span of node.template.templateSpans) {
            const attribute = /(?:[.?])?(aria-label|ariaLabel|title|placeholder)\s*=\s*$/.exec(preceding);
            if (
              attribute &&
              (ts.isStringLiteral(span.expression) || ts.isNoSubstitutionTemplateLiteral(span.expression))
            ) {
              const kind = attribute[1] === "ariaLabel" ? "aria-label" : attribute[1]!;
              add(kind, span.expression.text, span.expression);
            }
            preceding = span.literal.text;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

test("Lit templates do not contain bare user-facing English", () => {
  const findings = sourceFiles(sourceRoot)
    .flatMap(visibleLiterals)
    .filter((finding) => !allowedTechnicalLiterals.has(`${finding.file}:${finding.kind}:${finding.value}`))
    .filter(
      (finding, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.file === finding.file && candidate.kind === finding.kind && candidate.value === finding.value,
        ) === index,
    )
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.value.localeCompare(b.value));
  assert.equal(
    findings.length,
    0,
    findings
      .map((finding) => `${finding.file}:${finding.line} ${finding.kind} ${JSON.stringify(finding.value)}`)
      .join("\n"),
  );
});
