# qm

[`README.md`](./README.md) explains what QM is and how it is deployed.

## Commands

Node 24+ / npm 11+ (`.node-version`). TypeScript runs directly on Node — there is no
build step for core; `npm ci` then:

```bash
npm run dev                      # core with --watch, loads .env
npm run dev-instance             # production-shaped local instance (prefer the /dev-instance skill)

npm test                         # root suite: test/*.test.ts only
node --experimental-test-module-mocks --test test/<name>.test.ts        # one file
node --experimental-test-module-mocks --test --test-name-pattern '<re>' test/<name>.test.ts
npm run test:all                 # every test/**, including subdirectories
npm run test:pg                  # Postgres-backed durability tests (needs a live DB)
npm run test:e2e                 # test/e2e

npm run typecheck && npm run lint     # what CI gates on, plus format:check, lint:ox, lint:knip
```

The `--experimental-test-module-mocks` flag is what makes `npm test` differ from a bare
`node --test`; root tests that mock modules fail without it. CI shards the root suite five
ways (`test:root:shard`), so run affected files locally and let CI be the full gate.

Plugins and the CLI are separate npm packages with their own `node_modules`: run
`npm ci && npm test` inside `plugins/<name>/` or `cli/`, not from the root. `plugins/web-ui`
additionally needs `npm run build` (Vite + localization) and gates on `localize:check`.

## Architecture

Read `src/wiring.ts` first: it is the single composition root where every substrate —
session store, harness, sandbox, memory, config, ACL — is chosen behind an interface,
with an in-memory implementation for tests and a Postgres/cloud one for production.
`src/index.ts` only loads config, calls `buildApp`, and starts the server.

The turn path: a surface (Slack, web) posts to the HTTP API (`src/api/`) → the
orchestrator (`src/core/orchestrator.ts`) resolves scope, identity, policy, and memory →
the harness router (`src/harness/harness-router.ts`) dispatches to one of the
interchangeable agent harnesses (Pi, Claude, Codex, OpenCode, plus `mock-harness` for
tests) → tool calls land in the scope's sandbox (`src/sandbox/`, local Docker / AWS
microVM / Fly sprites). Long-running work is a _run_ (`src/runs/`) executed by a
worker process against pg-boss, not an in-request await.

The unit of isolation is the **scope** (`ScopeId` in `src/types.ts`): a person or a room.
Memory, files, keychain, crons, skills, and sandbox are all scope-owned, and
`src/resolution/` layers scope config over org defaults. Almost any feature question
reduces to "which scope owns this, and how does resolution reach it".

Surfaces are plugins, not core: `plugins/{web-ui,admin,portal,auth}` are standalone
services talking to core over the signed HTTP API, and `plugins/chassis` is the only
shared code between them. Slack (`src/slack/`) is the exception — in-process, supervised
by core.

## Working on the code

Two habits that keep task-focused changes from scarring the rest of the repo:

- **Fix every instance, not just the reported one.** When you find a bug or a pattern
  worth changing, grep the whole repo (`src/`, `plugins/`, `test/`, `scripts/`) for the
  same pattern and fix all of it in the same change. One autocorrected call site with
  five untouched siblings is a regression waiting to be rediscovered.
- **Fixes should make the system simpler, not more complex.** Prefer removing or
  consolidating code over adding a new layer, flag, or special case. If a fix grows the
  system's surface area, look for the version that shrinks it.
- **Never leave comments in the repo.** The standard is zero comments: no explanatory
  comments or docblocks, TODO/FIXME notes, lint/type suppression directives, or commented-out
  code. Express intent through names, structure, and tests; put rationale in commit messages or
  PR descriptions. Interpreter shebangs are executable directives, not comments.
- **Solve at the layer all paths flow through.** Before patching a call site, ask
  whether the fix belongs in the shared helper, the store interface, or the base
  module instead. Check for an existing helper before writing a new one-liner.
  The helper homes: `src/util/errors.ts` (errMessage/swallow), `src/util/async.ts`
  (sleep, createKeyedQueue), `src/util/sweeper.ts` (periodic loops),
  `src/sandbox/process-poll.ts` (process polling/liveness), `src/memory/notebook.ts`
  (memory line grammar). Plugins are separate packages and keep their own local
  copies rather than importing core code — the one exception is the shared
  `plugins/chassis` package (the sanctioned home for the plugin↔core plumbing:
  source-auth signer, signed core-client, node:http helpers, error helpers, CORE_*
  env), imported by relative path and never importing core. The bar cuts both ways:
  don't manufacture an abstraction for a pattern with one caller.
- **Never merge to `main` without a fresh-context pass that tries to break the change.**
  Not a blessing — hunt for the bug, the missed edge case, the unstated assumption, the
  thing that regresses. Always dispatch `/code-review` or an independent review agent that
  did not watch you write the change: the context that produced a diff already believes it
  is correct, and that belief is the bias review exists to defeat. Never self-review in the
  authoring context, however small the diff; a green CI run is not review either. What
  scales with risk is how deep the reviewer goes — a change with a narrow blast radius
  warrants one reviewer at modest effort scoped to the diff, while core control flow, auth
  and credentials, data loss or migrations, concurrency and retry logic, spend, public API
  contracts, the shared helpers above that every path flows through, or a diff too large to
  hold in your head warrant high effort and several reviewers with distinct lenses. Judge
  blast radius by checking callers, not by counting files — a one-line edit to a helper with
  fifty importers is not a small change. The reviewer, not the author, has the last word on
  depth: a modest pass that spots risk it wasn't scoped for escalates on its own initiative
  rather than staying in its lane. Resolve what they find before merging.
- **Verify locally with the affected tests, not the whole suite.** Run the tests covering
  what you changed plus typecheck and lint, then push and let CI be the full gate — CI
  shards the suite across parallel runners, and reproducing that serially costs several
  times the wall clock for the same signal. Judge "affected" by callers rather than by diff
  size, for the same reason as above; run everything locally when you can't tell what a
  change reaches.
- **Verify non-trivial behavior changes in a live dev instance before opening a PR.**
  When a change is substantial enough that unit tests alone won't prove it works
  end-to-end — new or changed agent behavior, or anything touching the Slack/web
  surfaces, orchestrator, directory, or cron flows — boot this worktree with the
  `/dev-instance` skill and exercise it through a browser against the configured Slack
  development workspace before opening a PR. Do this Slack QA in **Firefox**, never the
  Slack Mac app, and don't ask permission first — do it on your own; don't wait to be
  asked. Skip it for trivial refactors, docs, config, or pure-logic changes already
  covered by tests.
- **Screenshot every front-end change in the PR.** Anything an operator or user sees
  rendered — admin/web/portal UI, Slack surfaces, emails — ships with a screenshot of the
  after state (before/after when it's a change to something that already existed) in the PR
  description, so a reviewer sees the result without booting it. Can't reach the surface
  live? Render it against realistic data and say so.

## Downstream forks

Before acting, determine which repository this checkout is by running `git remote -v`.
If `origin` points at `yc-software/qm`, you are in upstream qm. If `origin` points
anywhere else, the repository is a long-lived downstream distribution whose history
began as a standalone clone of upstream.

A downstream distribution may modify core, including `src/`, plugins, the CLI, docs,
and CI, when its product requires behavior that upstream does not provide. Keep that
divergence small, intentional, and covered by tests so later upstream merges remain
tractable. Prefer extending shared choke points over copying upstream implementations or
replacing whole files. Organization credentials, infrastructure coordinates, private
connectors, and deployment-only configuration still belong under
`deploy/layers/<org>/`; secrets never enter Git.

Keep an `upstream` remote pointing at `yc-software/qm`. Sync upstream through a temporary
branch, merge rather than rebase, record the merged range and every resolved conflict,
run the affected verification, and merge the result into the downstream `main` through
a PR. Preserve both new upstream behavior and intentional downstream behavior when
resolving conflicts; never choose one side wholesale merely to complete a merge. The
`update-qm` skill supplies the same safe merge, conflict-resolution, and verification
workflow.

Generic improvements may still be contributed with the `upstream-pr` skill, but doing so
is optional and downstream history must never be pushed to upstream. Pass `--repo` to
every `gh` command because `gh` may otherwise select the wrong remote. Never reference
an upstream issue or pull request by number in downstream PRs, issues, comments, or
commit messages: GitHub may mirror the mention onto the upstream item and expose private
repository context. Name upstream work in plain words instead.

## Durable by default

A recurring mistake: stashing state the system later relies on in process memory. The
core runs blue-green and multi-instance — an in-memory `Map` or ring buffer is
per-instance and wiped by every deploy. Anything an operator or the system reads back
later (audit, logs, resolved config, queued or in-flight work) must live in a durable
store, never RAM alone. RAM-only is fine only as a cache in front of a durable store, or
for genuinely disposable, re-derivable state. If you're adding a log, audit, queue, or
resolved config, back it with Postgres; the spec's data-model & durability section tracks the gaps.

> `CLAUDE.md` is a symlink to `AGENTS.md`, so every tool (Claude Code, Codex,
> Cursor, …) reads the same guidance from this one file. If a tool-specific
> deviation ever becomes necessary, replace the symlink with a real file in the
> commit that introduces the deviation.
