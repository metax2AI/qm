import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "skills-seed", "google-workspace", "scripts", "gmail.py");

const DRIVER = `
import base64, importlib.util, json, sys
from email import message_from_bytes
from email.policy import default as default_policy
spec = importlib.util.spec_from_file_location("gmail", sys.argv[1])
gmail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gmail)
raw = gmail.build_raw({"To": "a@b.com", "Subject": "Probe"}, sys.stdin.read())["raw"]
msg = message_from_bytes(base64.urlsafe_b64decode(raw), policy=default_policy)
parts = {p.get_content_type(): p.get_content() for p in msg.walk() if not p.is_multipart()}
print(json.dumps({"contentType": msg.get_content_type(), "parts": parts}))
`;

// gmail.py annotates with PEP 604 unions evaluated at def time, so it needs the
// 3.10+ the agent sandbox ships. `python3` on a developer machine is often older
// than that — probe for a version that can actually import the script rather than
// reporting its own age as a failure of the code under test.
function usablePython(): string | undefined {
  const candidates = ["python3", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10"];
  for (const bin of candidates) {
    const probe = spawnSync(bin, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"]);
    if (probe.status === 0) return bin;
  }
  return undefined;
}

const PYTHON = usablePython();
const NEEDS_PYTHON = { skip: PYTHON ? false : "no python3 >= 3.10 on PATH" };

function buildMime(body: string): { contentType: string; parts: Record<string, string> } {
  if (!PYTHON) throw new Error("buildMime called without a usable python3");
  const out = execFileSync(PYTHON, ["-c", DRIVER, SCRIPT], { input: body, encoding: "utf8" });
  return JSON.parse(out);
}

test(
  "drafted mail is multipart/alternative so recipients don't get Gmail's narrow plain-text rendering",
  NEEDS_PYTHON,
  () => {
    const body =
      "Hi Alice and Bob,\n\nWould you fill this out? Takes ~5 minutes:\nhttps://forms.example.com/abc123\n\nCarol";
    const mime = buildMime(body);
    assert.equal(mime.contentType, "multipart/alternative");
    const plain = mime.parts["text/plain"];
    const html = mime.parts["text/html"];
    assert.ok(plain && html, "both alternatives exist");
    assert.ok(plain.includes("Takes ~5 minutes"), "plain part keeps the body");
    assert.ok(html.startsWith('<div dir="ltr">'), "html mirror is composer-shaped");
    assert.ok(html.includes("Hi Alice and Bob,<br><br>"), "paragraph breaks survive");
    assert.ok(
      html.includes('<a href="https://forms.example.com/abc123">https://forms.example.com/abc123</a>'),
      "bare URLs stay clickable in the html mirror",
    );
  },
);

test("html mirror escapes markup and keeps sentence punctuation out of links", NEEDS_PYTHON, () => {
  const mime = buildMime('a < b & "c" — see https://x.test/a?b=1&c=2.');
  const plain = mime.parts["text/plain"];
  const html = mime.parts["text/html"];
  assert.ok(plain && html, "both alternatives exist");
  assert.ok(plain.includes('a < b & "c"'), "plain part is untouched");
  assert.ok(html.includes("a &lt; b &amp; &quot;c&quot; — see"), "text is html-escaped");
  assert.ok(html.includes('<a href="https://x.test/a?b=1&amp;c=2">'), "url is escaped for the attribute");
  assert.ok(html.includes("</a>."), "trailing period stays outside the link");
});

test("smart punctuation stays out of links; balanced brackets stay in", NEEDS_PYTHON, () => {
  const mime = buildMime("See \u201chttps://x.test/reset?token=abc\u201d and http://[::1]/path\u2026");
  const html = mime.parts["text/html"];
  assert.ok(html, "html part exists");
  assert.ok(html.includes('<a href="https://x.test/reset?token=abc">'), "smart quote trimmed from the href");
  assert.ok(html.includes('<a href="http://[::1]/path">'), "balanced IPv6 brackets kept");
  assert.ok(html.includes("</a>…"), "trailing ellipsis stays outside the link");
});

test("intra-paragraph line breaks survive as <br> in the html mirror", NEEDS_PYTHON, () => {
  const mime = buildMime("Short.\n\nTwo lines\nin one paragraph");
  assert.equal(mime.contentType, "multipart/alternative");
  const html = mime.parts["text/html"];
  assert.ok(html, "html part exists");
  assert.ok(html.includes("Two lines<br>in one paragraph"), "intra-paragraph breaks become <br>");
});
