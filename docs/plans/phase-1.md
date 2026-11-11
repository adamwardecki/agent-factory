# Agent factory, phase 1: extract, App-less Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone `adamwardecki/agent-factory` repo. Any repo can call its router, stage and verify workflows
from two small caller files and get the factory pipeline, with no GitHub App: agents only read, and a deterministic
publish job makes every write.

**Architecture:** The router (Node, TypeScript with type stripping, no runtime dependencies) is ported from
`job-tracker-mcp/factory/` at commit `69ca0a7`, then changed in these ways:
- it reads per-repo config from `.github/factory.json`, including who may do what (`roles.queue`, `roles.approve`);
- it signs and verifies its markers with an HMAC key, and each signature names the key that made it;
- it gives every stage entry an attempt id, and only the current attempt may publish or move the issue on;
- it runs its own restricted CI stage, `verify`, instead of dispatching the repo's CI;
- it lets an issue into review or ready only when the PR head, the verified commit and the reviewed commit agree;
- it admits every issue that becomes active through one queue capped at `maxActive`;
- it accepts stage reports, and it can be paused.

Each agent stage is a reusable workflow with three jobs:
- **`prepare`:** holds the signing key, refuses unless the issue's signed state is at this stage and attempt, builds
  the agent's context, and passes the stage's immutable inputs on as job outputs. It writes nothing.
- **`agent`:** runs Claude with a read-only `GITHUB_TOKEN` and writes its output to files.
- **`publish`:** holds the key and write permissions. It checks every output before any remote write, re-checks the
  attempt before each write, and writes idempotently.

`verify` is a reusable workflow with three jobs: `prepare` (as above), `verify` (the repo's configured commands at
the gated SHA; `contents: read`, no secrets, no caches, each command in a bubblewrap sandbox) and `report`.

**Tech Stack:** Node 22.18+ (`node:test`, `node:crypto`, `node:child_process`), TypeScript 7 for `tsc --noEmit`,
Biome 2.5.15, GitHub Actions reusable workflows and composite actions,
`anthropics/claude-code-action@4fa93a88de49bbef68b10eb15aabedf28ca0e1ed` (v1.0.271).

**Spec:** `docs/superpowers/specs/2026-11-10-standalone-agent-factory-design.md` in the `job-tracker-mcp` workspace
(local only). It was revised on 2026-11-11 after two reviews; this plan matches that revision.

---

## What this plan is

The first version of this plan carried its code inline, and nobody had run that code. Two reviews then changed the
design (see "What the two reviews changed"). While reworking the plan, the code was written out and run. That found
three defects in the first version's code that reading had not:

- the signature line appended to a brief broke `parseBriefTouches`, so no signed brief would ever have parsed;
- a ported test reads `factory/risky-paths.txt`, which the new repo doesn't have, so "all ported tests pass" was
  false;
- a `sign` test matched a message that doesn't contain the word it looked for.

So this plan no longer carries code inline. **Every file it creates exists, in its final form, in the reference
tree next to this plan.** Each task copies files from the tree, test first, runs the checks, and commits.

### The reference tree

`docs/superpowers/plans/2026-11-11-agent-factory-phase-1/` in the `job-tracker-mcp` workspace (local only, 59
files). It is the repo this plan produces, minus `LICENSE` and `docs/`.

**What was verified on it** (2026-11-11, Node 22.23, in a clean clone with `npm install` from its `package.json`):

| Check | Result |
|---|---|
| `npm run typecheck` | passes |
| `npx --no biome ci .` | passes, no warnings |
| `npm test` | 261 tests pass |
| `actionlint` on the three reusable workflows, `ci.yml` and both rendered callers | no findings, except that the installed version doesn't know `queue: max` or `job.workflow_sha`; both are confirmed on GitHub (phase 0). Run it with the ignores in Task 9, Step 5 |
| The commit units below, applied in order | every unit passes typecheck, lint and tests (170, 175, 186, 216, 222, 243, 243, 261 tests) |

**What was verified on GitHub** (phase 0, in the private sandbox `adamwardecki/agent-factory-sandbox`; results and
run links are in the spec's "Phase 0 results"): the sandbox script, bundles through artifacts with leases, job
outputs vs artifacts, `job.workflow_sha`, the concurrency queue, and a `GITHUB_TOKEN`-opened PR (ready, review
request, approval-required runs).

**What was not verified:** the workflows in this tree have not run. Phase 0 ran probe workflows, not these. Also
open: `claude-code-action` with a read-only token (check 4, needs the Claude token on the sandbox), and whether an
approved run satisfies a *required* check (check 2, needs a plan with rulesets on the sandbox).

---

## Before starting

- **Phase 0 results** are in the spec's "Phase 0 results". Status on 2026-11-11: checks 1, 2 (approval half), 3, 5,
  6, 7 (with `contents: write`), 8, 9 and 10 done; **check 4 is partial**: `claude-code-action` passes all its setup with a read-only
  `github_token`, and only the run with a real Claude token (scoped writes under the scrub) is open; check 2's
  required-checks half is untested (Free plan; low risk, see the spec). Neither blocks Tasks 1 to 8, which are local
  code and tests. If the check 4 rerun fails, the file that changes is `stage.yml` (Task 9): revise it before
  dispatching Task 9, or at the latest before phase 2.
- **Visibility.** `agent-factory` stays **private** for now. Phase 1 works either way: the tests and the
  commits don't need it. Phase 2 does: a target repo's `GITHUB_TOKEN` can't check out another private repo, so the
  stage jobs would fail there. Make it public
  (`gh repo edit adamwardecki/agent-factory --visibility public --accept-visibility-change-consequences`) before the
  sandbox trials, or give the reusable workflows a read token. Don't change it without the maintainer's go-ahead.
- **Commits go straight to `main`.** The maintainer chose that for this repo ("commit everything to
  agent-factory"); the subagent-driven workflow normally wants a branch, so say so when dispatching Task 1.

## Conventions for every task

- **Where:** work in `~/Workspace/agent-factory`, a clone of https://github.com/adamwardecki/agent-factory (default
  branch `main`, one commit with a stub `README.md`). Every commit in this plan goes to that repo's `main` and is
  pushed at the end of each task. Two paths are used in the commands below:
  ```bash
  export SRC=/Users/adamwardecki/conductor/workspaces/job-hunt-mcp/dushanbe
  export REF=$SRC/docs/superpowers/plans/2026-11-11-agent-factory-phase-1
  ```
- **Copy, don't retype.** Take each file from `$REF` with `cp`. If a check fails after a copy, the cause is the
  copy or the order, not the file: report it instead of editing the file to make the check pass.
- **Read what you copy.** Each task lists what to look for. Report anything that contradicts the spec.
- **Commits:** subjects are plain imperative sentences in sentence case. End every message with a blank line and
  the `Co-Authored-By:` trailer for the model doing the work. Before the first commit, `git config user.email` must
  be `1017097+adamwardecki@users.noreply.github.com`; if it isn't, stop and ask.
- **Checks before every commit:** `npm run typecheck && npm run lint && npm test`.
- **Never call the real GitHub API from tests.** The tests use fake `Gh` objects and temporary git repos.

## What the two reviews changed

**The plan review (eight findings).**

| Finding | Fix | Where | Pinned by |
|---|---|---|---|
| P1: publishing isn't tied to the attempt that authorized it | `state.attempt` on every stage entry; `prepare` and `publish` refuse a run that isn't the current attempt; publish re-checks before every write; `/stop` cancels the run | `config.ts` (`attemptId`), `decide.ts` (`enter`, `cancelRun`, `runFinished`), `attempt.ts`, `prepare.ts`, `publish.ts` | `publish.test.ts`: "publication after /stop", "a /stop that lands between two writes"; `decide.test.ts`: the Attempts section |
| P1: a clean review can be applied to code the reviewer never saw | Publish stamps the review with the commit `prepare` recorded and posts it with `commit_id`; the state records `verifiedSha`; `onward()` is the only way into verify, review, fix and ready, and compares the SHAs | `markers.ts` (`stampReview`), `publish.ts`, `decide.ts` (`onward`, `verified`) | `decide.test.ts`: "the head changed during review", "ready needs the head, the review and verify to name the same commit"; `publish.test.ts`: "a review is stamped with the commit prepare recorded" |
| P1: CI runs before the risky-diff gate, outside the agent's security boundary | The router dispatches no repo CI. The `ci` stage runs `verify`: the repo's commands, sandboxed, read-only token, no secrets, entered only through the diff gate. The repo's own CI waits for "Approve workflows to run" | `decide.ts` (`built`, `fixed`, `verified`), `verify.yml`, `scripts/sandboxed.sh` | `decide.test.ts`: "a build with a risky diff waits for approval before verify runs anything on it"; `workflows.test.ts`: "the verify job has a read-only token, no secrets and no caches" |
| P1: build publication can overwrite unseen human commits | `prepare` records the branch head, or that the branch is absent; build pushes with `--force-with-lease=refs/heads/<branch>:<that sha or empty>` | `prepare.ts` (`branch-sha`), `publish.ts` | `publish.test.ts`: "build pushes with a lease on the head prepare saw, or on the branch not existing" |
| P2: `maxActive` does not actually cap active issues | `settle()` passes every inactive-to-active move through the cap; one that doesn't fit is parked in a new stage, `waiting`; `startNext` resumes waiting issues first, through `onward()` | `decide.ts` (`settle`, `park`, `resume`, `startNext`), `main.ts` (loads every issue before deciding) | `decide.test.ts`: the Admission section, including "/approve at capacity" |
| P2: contract failures can occur after the branch has already changed | `publish.ts` splits into `collect()` (local only, every file and the bundle) and `publish()` (the writes); writes are idempotent per attempt | `publish.ts`, `contract.ts` | `publish.test.ts`: "malformed output makes zero remote writes", "running the job again for the same attempt writes nothing twice" |
| P2: the skills keep repo-specific instructions | Four skills written in full, with no package manager, branch name or repo rule. Commands come from the context's Checks section and SHAs from its Commits section, both rendered by `prepare`. The fixer rebases onto the base SHA with no fetch | `skills/`, `context.ts` | `workflows.test.ts`: "skills name no package manager, default branch or repo of their own"; `context.test.ts`: "the checks and commits come from the repo config" |
| P2: the GitHub event assumption is outdated | The design uses the documented behaviour (approval-required `pull_request` runs for PRs that `GITHUB_TOKEN` opens) instead of fighting it, and phase 0 confirms it before this plan starts | spec: "Verify and the repo's CI", platform check 2 | phase 0 |

**The architecture review.**

| Change | Where | Pinned by |
|---|---|---|
| `roles: { queue, approve }` replaces `maintainers`; each command has its roles | `authority.ts`, `decide.ts`, `snapshot.ts` | `authority.test.ts`; `decide.test.ts`: the Roles section |
| Narrow scope: subscription auth only, logins only, one issue at a time. The admission queue handles any cap; config validation refuses `maxActive` above 1 and permission levels for now | `repo-config.ts`; no `stage-oidc.yml` | `repo-config.test.ts`: "what later phases switch on is refused for now" |
| Signatures carry a key id; state signed with a replaced key blocks the issue with the reason `key-rotated` | `sign.ts` (`check`), `snapshot.ts` (`stateFrom`), `decide.ts` (`sweepOne`) | `sign.test.ts`, `snapshot.test.ts`, `decide.test.ts`: "state signed with a replaced key" |
| The router's trigger filter names no login, and lives in the reusable workflow | `router.yml` | `workflows.test.ts`: "its trigger filter names no login" |
| Pause: `FACTORY_PAUSED` stops the router and every publish write | `config.ts` (`isPaused`), `main.ts`, `publish.ts`, both callers | `config.test.ts`, `publish.test.ts`: "a paused factory writes nothing" |
| Versioned interfaces: `interface: 1` on every reusable workflow; a version in the state comment | the three workflows, `markers.ts` (`STATE_VERSION`) | `workflows.test.ts`: "the reusable workflows keep caller interface 1"; `markers.test.ts` |
| Publish hardening: size caps, no factory markers in agent text, inert mentions and closing keywords, per-commit `.github/` check, no symlinks, submodules or merge commits, the bundle is never checked out | `contract.ts` | `contract.test.ts` |
| The factory repo is named once, in the `uses:` line (phase 0 later removed the inputs); the write identity is named in one file | callers, `config.ts` | `workflows.test.ts`: "the write identity is named in one place" |
| The router is level-triggered: a finished stage run is only a wake-up for a sweep | `events.ts`, `main.ts` | `events.test.ts` |

**Phase 0 (run on GitHub).** Each row is already in the reference tree.

| Result | Change | Where | Pinned by |
|---|---|---|---|
| 1: `workflow_run` doesn't fire for runs `GITHUB_TOKEN` dispatched | No `workflow_run` trigger in the router caller, the router's `if:` or `events.ts` | `templates/factory-router.yml`, `router.yml`, `events.ts` | `events.test.ts`: "workflow_run events are ignored"; `workflows.test.ts` |
| 3: `/proc/1/environ` leaked the step environment through bwrap | `exec env -i PATH="$PATH" bwrap …` | `scripts/sandboxed.sh` | `workflows.test.ts`: "sandboxes every command" |
| 3: `apt-get update` hung for minutes on the 26.04 image; bubblewrap is preinstalled, socat is not | Install only what is missing, never `apt-get update`, 5-minute step timeout | `actions/agent-setup/action.yml`, `verify.yml` | `workflows.test.ts`: "packages are installed only when missing" |
| 7: `markPullRequestReadyForReview` is refused from a run with `contents: read` (a review request still works) | The router job and its caller get `contents: write`; the job checks out only the factory repo | `router.yml`, `templates/factory-router.yml` | `workflows.test.ts`: "the router can mark a PR ready" |
| 8: `queue: max` works at job level | The router job uses it | `router.yml` | `workflows.test.ts`: "the router serialises per repo" |
| 9: `job.workflow_sha` and `job.workflow_repository` exist and drive a `checkout` | The `factory_repo` and `factory_ref` inputs are gone; every reusable workflow checks out its own pinned commit from the job context; callers carry one SHA per job | the three workflows, both templates | `workflows.test.ts`: "check out their own pinned commit from the job context", the interface snapshot |

## File map (`agent-factory`)

| File | Responsibility |
|---|---|
| `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `LICENSE` | Tooling and licence |
| `.github/workflows/ci.yml` | Lint and tests on Node 22.18 and 24 |
| `router/util.ts` | `isRecord`, `oneOf`, `errorText` (copied from `job-tracker-mcp`) |
| `router/config.ts` | Constants: stages (with `waiting`), run workflows (with `verify`), the write identity, run titles, attempt ids, dry-run and pause switches, `ConfigError` |
| `router/authority.ts` | `roles`: parsing, and deciding whether an actor holds a role (logins, permission levels, bots) |
| `router/repo-config.ts` | Loading and validating `.github/factory.json`; risky-path baseline; defaults; what this release refuses |
| `router/sign.ts` | Canonical form, key id, HMAC sign and check |
| `router/markers.ts` | Ported; state gains `queuedBy`, `attempt`, `verifiedSha`, `resume` and a version; attempt line; review marker with `sha` and `attempt` |
| `router/globs.ts` | Ported unchanged |
| `router/json.ts` | Ported; stage run check by workflow path |
| `router/decide.ts` | The state machine: roles, attempts, `onward()` SHA checks, verify, `settle()` admission, key rotation |
| `router/events.ts` | One stage workflow, reports with attempts, stage runs as wake-ups |
| `router/report.ts` | What a stage run did, from its jobs; report checks |
| `router/github.ts` | Ported; dispatch with attempt, run lookup and cancel, branch heads, repo contents, permissions, PRs, reviews with `commit_id` |
| `router/snapshot.ts` | Reads GitHub into snapshots: trust by signature and role |
| `router/context.ts` | Builds `context.md`: brief, Checks, Commits, review, notes |
| `router/attempt.ts` | `stale()`: whether a run is the current attempt of its stage |
| `router/prepare.ts` | CLI for the `prepare` job: checks the attempt; writes job outputs, `context.md`, `ci-run-id` |
| `router/tools.ts` | Allowed tools per stage, built from `commands` |
| `router/contract.ts` | Stage output checks (plan, review, PR text, git bundle), inert text |
| `router/publish.ts` | `collect` (local checks), `publish` (authorized, idempotent writes); CLI for the `publish` job |
| `router/main.ts` | Router entry |
| `skills/factory-{plan,build,review,fix}/SKILL.md` | Stage prompts that write to `.factory/out/` |
| `skills.lock.json` | Matt Pocock skills pin |
| `actions/{prepare,agent-setup,publish}/action.yml` | Composite actions shared by the stage and verify workflows |
| `scripts/sandboxed.sh` | Runs one configured command in `bwrap` with a clean environment, started with `env -i` (verify job) |
| `scripts/render-callers.ts` | Renders the caller templates |
| `.github/workflows/router.yml` | Reusable router workflow, with the trigger filter |
| `.github/workflows/stage.yml` | Reusable agent stage workflow |
| `.github/workflows/verify.yml` | Reusable verify workflow: the factory's restricted CI |
| `templates/factory-router.yml`, `templates/factory-stage.yml` | Caller templates (`templatefile()` syntax) |
| `tests/*.test.ts` | 17 test files, 261 tests |
| `README.md` | What it is, how to try it in a sandbox repo |

---

### Task 1: Bootstrap the repo

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `LICENSE`,
`.github/workflows/ci.yml`, `router/util.ts`, `docs/design.md`, `docs/plans/phase-1.md`.

- [ ] **Step 1: Clone the repo and check the commit identity**

```bash
git clone https://github.com/adamwardecki/agent-factory.git ~/Workspace/agent-factory
cd ~/Workspace/agent-factory && git switch main && git pull --ff-only
git config user.email   # must print 1017097+adamwardecki@users.noreply.github.com
```

- [ ] **Step 2: Commit the design and this plan into the repo**

They live only in the gitignored `docs/superpowers/` of the `job-tracker-mcp` workspace; the new repo is their home.

```bash
mkdir -p docs/plans
cp "$SRC/docs/superpowers/specs/2026-11-10-standalone-agent-factory-design.md" docs/design.md
cp "$SRC/docs/superpowers/plans/2026-11-11-agent-factory-phase-1.md" docs/plans/phase-1.md
git add docs && git commit -m "Add the design and the phase 1 plan"
```

- [ ] **Step 3: Copy the tooling**

```bash
mkdir -p router .github/workflows
cp "$REF"/{package.json,package-lock.json,tsconfig.json,biome.json,.gitignore} .
cp "$REF/.github/workflows/ci.yml" .github/workflows/
cp "$REF/router/util.ts" router/
cp "$SRC/LICENSE" LICENSE   # MIT; the copyright line must read "Copyright (c) 2026 Adam Wardecki"
```

- [ ] **Step 4: Install and check**

Run: `npm ci && npm run typecheck && npm run lint`
Expected: both pass. There are no tests yet, so don't run `npm test`. A root lockfile is fine here: this repo is not
a plugin.

- [ ] **Step 5: Commit and push**

```bash
git add -A && git commit -m "Set up the agent-factory repo" && git push origin main
```

---

### Task 2: Port the router and its tests unchanged

**Files:** Create `router/{config,context,decide,events,github,globs,json,main,markers,snapshot,stage-context}.ts`,
`router/risky-paths.txt`, `tests/{config,context,decide,events,github,globs,markers,snapshot}.test.ts`.

This commit records where the router came from. Task 5 replaces most of it.

- [ ] **Step 1: Copy the sources at the pinned commit**

```bash
mkdir -p tests
for f in config context decide events github globs json main markers snapshot stage-context; do
  git -C "$SRC" show 69ca0a7:factory/$f.ts > router/$f.ts
done
for f in config context decide events github globs markers snapshot; do
  git -C "$SRC" show 69ca0a7:tests/factory/$f.test.ts > tests/$f.test.ts
done
# One glob test reads the real list from disk.
git -C "$SRC" show 69ca0a7:factory/risky-paths.txt > router/risky-paths.txt
# Imports: the util helpers now live next to the router; tests import ../router/.
sed -i '' "s#'../plugin/servers/tracker/src/util.ts'#'./util.ts'#" router/*.ts
sed -i '' "s#'../../factory/#'../router/#; s#'factory/risky-paths.txt'#'router/risky-paths.txt'#" tests/*.test.ts
npm run lint:fix   # the import paths changed, so their order did too
```

`workflows.test.ts` is deliberately not copied; Task 9 adds a new one.

- [ ] **Step 2: Run the ported tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; `npm test` reports 170 tests. Any failure means the copy or the `sed` edits went wrong; fix that
rather than the tests.

- [ ] **Step 3: Commit and push**

```bash
git add -A && git commit -m "Port the factory router from job-tracker-mcp

Ported from job-tracker-mcp at 69ca0a7 without behaviour changes." && git push origin main
```

---

### Task 3: Signed markers

**Files:** Create `router/sign.ts`, `tests/sign.test.ts`.

- [ ] **Step 1: Copy the test and see it fail**

```bash
cp "$REF/tests/sign.test.ts" tests/
node --no-warnings --test tests/sign.test.ts
```

Expected: FAIL, `Cannot find module '…/router/sign.ts'`.

- [ ] **Step 2: Copy the implementation**

```bash
cp "$REF/router/sign.ts" router/
```

- [ ] **Step 3: Read it. Check that:**

- the signature line is `<!-- factory:sig <8 hex key id>.<64 hex HMAC> -->`, and the HMAC covers the issue number,
  the kind and the canonical body;
- `check()` returns `retired-key` when the key id differs, and `bad` when the id matches but the HMAC doesn't;
- `canonical()` normalises `\r\n` and trailing whitespace and drops the signature line.

- [ ] **Step 4: Run the checks**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; 175 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Sign and check the factory's markers with a per-repo key"
```

---

### Task 4: Roles and per-repo config

**Files:** Create `router/authority.ts`, `router/repo-config.ts`, `tests/authority.test.ts`,
`tests/repo-config.test.ts`. Modify `router/config.ts` (add `ConfigError`).

- [ ] **Step 1: Copy the tests and see them fail**

```bash
cp "$REF"/tests/{authority,repo-config}.test.ts tests/
node --no-warnings --test tests/authority.test.ts tests/repo-config.test.ts
```

Expected: FAIL, modules not found.

- [ ] **Step 2: Add `ConfigError` to the ported `router/config.ts`**

Append (Task 5 replaces the whole file, with this class in it):

```ts

// A problem in .github/factory.json. The router reports its message on the queued issue, so it names the field.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
```

- [ ] **Step 3: Copy the implementations**

```bash
cp "$REF"/router/{authority,repo-config}.ts router/
```

- [ ] **Step 4: Read them. Check that:**

- `roles.queue` is required and `roles.approve` defaults to it;
- `COMMAND_ROLES` gives `/approve` to `approve` only, `/retry` to `queue` only, and `/stop` to both;
- bots never hold a role, and `@read` and `@triage` are refused;
- `parseRepoConfig` refuses what later phases add, each with a message that says so: permission levels in
  `oauth_token` mode and `concurrency.maxActive` above 1 (phase 4), `preset`, `triageLabels` and `commands.extra`
  (phase 5);
- there is no CI workflow setting.

- [ ] **Step 5: Run the checks**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; 186 tests.

- [ ] **Step 6: Commit and push**

```bash
git add -A && git commit -m "Decide who may queue and who may approve, and load each repo's factory.json" && git push origin main
```

---

### Task 5: The router: attempts, verify, SHA checks, admission, signed trust

**Files:** Replace `router/{config,markers,json,decide,events,github,snapshot,context,main}.ts`. Create
`router/report.ts`, `router/attempt.ts`. Delete `router/stage-context.ts`, `router/risky-paths.txt`. Replace
`tests/{config,markers,decide,events,github,snapshot,context,globs}.test.ts`. Create `tests/report.test.ts`,
`tests/attempt.test.ts`.

**This task is one unit: one implementer, one commit.** The files depend on each other (the new `config.ts` removes
exports the ported `github.ts`, `events.ts` and `snapshot.ts` import), and under type stripping a missing named
export fails when the module loads, so the suite can't run on a half-done unit.

- [ ] **Step 1: Copy the tests and see them fail**

```bash
cp "$REF"/tests/{config,markers,decide,events,report,github,snapshot,context,globs,attempt}.test.ts tests/
npm test 2>&1 | tail -8
```

Expected: FAIL. The new tests import names the ported router doesn't export (`settle`, `attemptId`, `stampReview`,
`findRun`, `checkReport`, `stale`).

- [ ] **Step 2: Copy the implementation and remove what it replaces**

```bash
cp "$REF"/router/{config,markers,json,decide,events,report,github,snapshot,context,attempt,main}.ts router/
git rm -q router/stage-context.ts router/risky-paths.txt
```

- [ ] **Step 3: Read `router/decide.ts`. Check that:**

- **Attempts:** `enter()` sets a new `attempt` for every stage in `RUNNER_FOR` and clears it for the others;
  `runFinished` returns `[]` unless `run.attempt === st.attempt`; `planned`, `built` and `reviewed` accept a brief,
  PR footer or review only from the current attempt; `block()` and the two ways into `done` cancel the run.
- **Verify:** `built` and `fixed` go to `ci` through `onward(…, 'verify')`, never straight in; `verified` records
  `verifiedSha` on success, sends a red run to the fixer, and treats any other conclusion as a failed attempt.
- **SHAs:** `onward()` is the only caller of `enter()` for `ci`, `in-review` and `ready`, apart from `park`'s
  resume and the retry of a failed fixer, which runs the gate itself; review needs `head === verifiedSha`; ready
  also needs `review.sha === head`.
- **The diff gate** blocks with `no-pr` whenever there is no PR, for every target.
- **Admission:** `settle()` counts the issues that stay active, admits an inactive-to-active move only while that
  count is under `maxActive`, and otherwise parks it; `park()` drops the dispatch and keeps everything else;
  `startNext` takes waiting issues, then rebases, then queued issues.
- **Roles:** every actor check goes through `ctx.can(role, login)` or `mayCommand`; no login is named.

- [ ] **Step 4: Read the rest. Check that:**

- `router/snapshot.ts`: `stateFrom` returns `retiredKey` for a state comment signed with another key id and `newer`
  for a later state version; a PR's `attempt` is read only when its body's signature verifies; `trusted()` asks
  for the roles the command needs;
- `router/report.ts`: for verify, `conclude` returns `success` or `failure` only from the `verify` job's own
  conclusion, and `startup_failure` when `prepare` failed; `checkReport` refuses a run whose title names another
  workflow, issue or attempt;
- `router/events.ts`: a finished stage run parses to `'sweep'`, not to an event with a result;
- `router/main.ts`: it returns before reading anything when paused; it loads every issue before deciding; it
  settles the event's actions before applying them; it skips an issue whose state is from a newer release;
- `router/config.ts` is the only file that names `github-actions[bot]`.

- [ ] **Step 5: Run the checks**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; 216 tests. `tests/decide.test.ts` alone has 102: the 82 ported ones, adapted, and 20 new.

- [ ] **Step 6: Commit and push**

```bash
git add -A && git commit -m "Tie every stage to an attempt, verify behind the gate, and cap active issues

Roles replace the single maintainer. Markers are trusted by signature. Build and fix go to
the factory's own verify stage through the diff gate. Review and ready need the PR head, the
verified commit and the reviewed commit to agree. Every move into an active stage passes
through one admission queue." && git push origin main
```

---

### Task 6: The prepare job and the agents' tools

**Files:** Create `router/tools.ts`, `router/prepare.ts`, `tests/tools.test.ts`.

- [ ] **Step 1: Copy the test and see it fail**

```bash
cp "$REF/tests/tools.test.ts" tests/
node --no-warnings --test tests/tools.test.ts
```

Expected: FAIL, modules not found.

- [ ] **Step 2: Copy the implementation**

```bash
cp "$REF"/router/{tools,prepare}.ts router/
```

- [ ] **Step 3: Read them. Check that:**

- `prepare.ts` throws before writing anything when `stale()` gives a reason;
- `outputs()` carries `attempt`, `base-sha`, `branch-sha` (empty when the branch is absent), `gated-sha`, `pr`,
  `fix-reason` and `default-branch`, and every value is one line;
- the agent stages get `model`, `max-turns`, `allowed-tools`, `scrub` and `install`; verify gets `install`, `test`,
  `lint` and `typecheck` and no model;
- `install` is empty for plan and review;
- `allowedTools` gives no agent a `gh` write command, and gives build and fix exactly the configured commands.

- [ ] **Step 4: Run the checks**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; 222 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Build each stage's inputs in a job the agent can't reach"
```

---

### Task 7: Output contracts and the publish job

**Files:** Create `router/contract.ts`, `router/publish.ts`, `tests/contract.test.ts`, `tests/publish.test.ts`.

- [ ] **Step 1: Copy the tests and see them fail**

```bash
cp "$REF"/tests/{contract,publish}.test.ts tests/
node --no-warnings --test tests/contract.test.ts tests/publish.test.ts
```

Expected: FAIL, modules not found.

- [ ] **Step 2: Copy the implementation**

```bash
cp "$REF"/router/{contract,publish}.ts router/
```

- [ ] **Step 3: Read them. Check that:**

- `collect()` makes no `gh` call and no git command that names `origin`;
- in `collect()`, the text files are read and checked before or together with the bundle, and nothing is returned
  unless all of them pass;
- `publish()` calls `stale()` on freshly read state before every write, and stops at the first reason;
- each write in `execute()` is skipped when its effect is already there (a comment or review carrying this attempt,
  an open PR, a branch already at the tip);
- build's lease expects `branchSha` (empty when absent); fix's expects `gatedSha`;
- `checkBundle` fetches the bundle's one ref into `refs/factory/incoming` with `transfer.fsckObjects` on, never
  checks it out, and refuses merge commits, any commit touching `.github/`, symlinks, submodules and other authors;
- `inert()` leaves code spans and fences alone.

- [ ] **Step 4: Run the checks**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; 243 tests. The contract tests build real git repos and bundles in temporary directories.

- [ ] **Step 5: Commit and push**

```bash
git add -A && git commit -m "Check every stage output before the publish job writes any of it

The publish job collects and checks all of a stage's output locally, then writes. It reads
the signed state again before each write and stops if its attempt is no longer current, and
each write is safe to repeat." && git push origin main
```

---

### Task 8: Portable stage skills

**Files:** Create `skills/factory-{plan,build,review,fix}/SKILL.md`, `skills.lock.json`.

- [ ] **Step 1: Copy them**

```bash
cp -R "$REF/skills" .
cp "$REF/skills.lock.json" .
```

- [ ] **Step 2: Read all four. Check that:**

- none names a package manager, a default branch, another skill of the target repo, or `job-tracker`;
- every command an agent is told to run comes from the context's **Checks** section, and every SHA from its
  **Commits** section;
- none asks for command substitution (`$(…)`), `git push`, `git fetch`, or a `gh` write command;
- the planner writes `outcome` and `comment.md`; the builder `branch.bundle` and `pr.md`; the reviewer
  `review.md`; the fixer `branch.bundle` and `fix.md`, all under `.factory/out/`;
- every rule still carries its "Why:".

Task 9's `workflows.test.ts` pins the first three of these.

- [ ] **Step 3: Run the checks**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; still 243 tests.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Write the stage skills to hand their output to the publish job, for any repo"
```

---

### Task 9: Reusable workflows, composite actions, caller templates

**Files:** Create `actions/{prepare,agent-setup,publish}/action.yml`, `.github/workflows/{router,stage,verify}.yml`,
`templates/{factory-router,factory-stage}.yml`, `scripts/render-callers.ts`, `scripts/sandboxed.sh`,
`tests/workflows.test.ts`.

- [ ] **Step 1: Copy the test and see it fail**

```bash
cp "$REF/tests/workflows.test.ts" tests/
node --no-warnings --test tests/workflows.test.ts
```

Expected: FAIL, `Cannot find module '…/scripts/render-callers.ts'`.

- [ ] **Step 2: Copy the implementation**

```bash
mkdir -p actions templates scripts
cp -R "$REF/actions/." actions/
cp "$REF"/.github/workflows/{router,stage,verify}.yml .github/workflows/
cp "$REF"/templates/*.yml templates/
cp "$REF"/scripts/* scripts/
chmod +x scripts/sandboxed.sh
```

- [ ] **Step 3: Check the pinned actions still resolve**

Every `uses:` carries a 40-character SHA and a version comment. Confirm each SHA is that version's commit:

```bash
grep -rhoE "uses: [a-z-]+/[a-z-]+@[0-9a-f]{40} # v[0-9.]+" .github actions | sort -u | while read -r _ ref _ ver; do
  repo=${ref%@*}; sha=${ref#*@}
  o=$(gh api "repos/$repo/git/ref/tags/$ver" --jq '.object.sha+" "+.object.type'); set -- $o
  [ "$2" = tag ] && want=$(gh api "repos/$repo/git/tags/$1" --jq .object.sha) || want=$1
  [ "$want" = "$sha" ] && echo "ok  $repo $ver" || echo "BAD $repo $ver: pinned $sha, tag is $want"
done
```

Expected: six `ok` lines (`actions/checkout`, `actions/setup-node`, `actions/setup-python`,
`actions/upload-artifact`, `actions/download-artifact`, `anthropics/claude-code-action`). A `BAD` line means a tag
moved or a pin was mistyped: stop and report it.

- [ ] **Step 4: Read the workflows. Check that:**

- **`stage.yml`:** the `agent` job has only `read` permissions and never receives the signing key; it checks out the
  default branch at `base-sha` with no credentials kept; `.factory-src` is moved out of the workspace before Claude
  runs; review and fix switch to `gated-sha` and fail if the branch head is anything else; the `publish` job takes
  its inputs from `needs.prepare.outputs`, not from an artifact.
- **`verify.yml`:** the `verify` job has `contents: read` only, no secret, no token in its environment, no cache;
  the factory's checkout is moved to `$RUNNER_TEMP` before the PR head is checked out; all four commands run
  through `sandboxed.sh`; the `report` job has `actions: write` only.
- **`router.yml`:** the `if:` passes only the cron, manual runs, `agent:queued` labels, the three commands,
  changes-requested reviews and closes on factory branches of this repo; it names no login and has no
  `workflow_run` clause (phase 0, check 1). The job's concurrency uses `queue: max` (check 8). Its permissions
  include `contents: write`, which marking a PR ready needs (check 7); it checks out only the factory repo.
- **All three** take `interface` and fail on anything but `1`, and check out their own repository and commit from
  `job.workflow_repository` and `job.workflow_sha`, not from an input (check 9).
- **`scripts/sandboxed.sh`:** starts with `exec env -i PATH="$PATH" bwrap`, then `--clearenv`, an empty `$HOME` and
  `$RUNNER_TEMP`, `--unshare-pid`, the workspace bound back in after them. Without `env -i`, `/proc/1/environ`
  shows the step's environment (check 3). Don't remove it.
- **Installing packages** (`agent-setup`, `verify.yml`): only what's missing, no `apt-get update`, a step timeout
  (check 3).

- [ ] **Step 5: Lint the workflows**

```bash
ignore=(-ignore 'SC[0-9]+' -ignore 'unexpected key "queue"' -ignore 'workflow_(sha|repository)')
actionlint "${ignore[@]}" .github/workflows/*.yml
d=$(mktemp -d) && mkdir -p "$d/.github/workflows" && git -C "$d" init -q
node --no-warnings scripts/render-callers.ts adamwardecki/agent-factory "$(git rev-parse HEAD)" '*/30 * * * *' "$d/.github/workflows"
(cd "$d" && actionlint "${ignore[@]}")
```

Expected: no findings from either run. The two non-shellcheck ignores are keys GitHub supports and the installed
`actionlint` doesn't know yet (phase 0, checks 8 and 9); drop them when it does. The shellcheck ignore is for style
notes about the YAML-embedded scripts. Install `actionlint` first if it's missing (`brew install actionlint`).

- [ ] **Step 6: Run the checks**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; 261 tests.

- [ ] **Step 7: Commit and push**

```bash
git add -A && git commit -m "Add the reusable router, stage and verify workflows and the caller templates" && git push origin main
```

---

### Task 10: README and final check

**Files:** Replace `README.md`.

- [ ] **Step 1: Copy the README**

```bash
cp "$REF/README.md" README.md
```

Read it against the repo: every command, file name and label in it must exist. The label loop must include
`agent:waiting`.

- [ ] **Step 2: Compare the repo with the reference tree**

```bash
diff -rq "$REF" . -x node_modules -x .git -x docs -x LICENSE
```

Expected: no output. Any difference is a file that was edited instead of copied, or missed.

- [ ] **Step 3: Final verification from a clean install**

```bash
rm -rf node_modules && npm ci && npm run typecheck && npx --no biome ci . && npm test
git status --short   # only README.md
```

Expected: everything passes; 261 tests.

- [ ] **Step 4: Commit and push**

```bash
git add README.md && git commit -m "Explain how to try the factory on a sandbox repo" && git push origin main
gh run watch -R adamwardecki/agent-factory --exit-status   # CI on main must pass on Node 22.18 and 24
```

---

## Not in this plan (later phases)

The spec's "Phases" section has the full list. In short:

- **Phase 2: CLI and sandbox trials.** `cli/factory.ts` (`init`, `doctor`, `upgrade`, `rotate-key`, `pause`,
  `resume`), then the three trial issues in `agent-factory-sandbox`, installed with `init`. Also the comment that
  tells a maintainer to renew the Claude token when a stage dies on an auth error.
- **Phase 3: adopt.** Migrating `job-tracker-mcp`.
- **Phase 4: teams.** Permission levels and `maxActive` above 1 (the role checks and the admission queue are
  built and tested here; config validation refuses the values until then), `stage-oidc.yml` and the OIDC checks.
- **Phase 5: package for others.** `.github/actions/factory-setup`, `commands.extra`, `triageLabels`, the label and
  branch prefixes as caller inputs, presets, the default PR skill, the docs set, the first tagged release.
- **Phase 6: Terraform.** The optional `factory-repo` module, which renders `templates/` with `templatefile()`.

**Known gaps this plan leaves, on purpose:**

- `prSkill` is passed to the builder as a path to read. `skills/factory-pr`, the default when a repo sets none, is
  phase 5; until then the builder skill's own PR rules apply.
- A repo whose lint or test command scans every directory will see `.factory/`, the agent's working directory. The
  README says to add it to `.gitignore`; `doctor` checks for that in phase 2.
- Nothing here has run on GitHub. Phase 2 is where the workflows, the sandbox and the job outputs are exercised.
