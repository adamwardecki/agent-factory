# Standalone agent factory design

Date: 2026-11-10. Revised 2026-11-11 after the architecture review and the phase 1 plan review. Status: draft for
review.

## Goal

Turn the agent factory that lives in `job-tracker-mcp` into a standalone project that a repo can adopt with one
command, and that works for one developer and for a small team. Two changes come with the move:

- **No GitHub App.** Agents never hold a write token. They write their output to files, and a deterministic
  publish job does every write with the workflow's `GITHUB_TOKEN`.
- **The maintainer's Claude subscription stays the default credential** (`CLAUDE_CODE_OAUTH_TOKEN`). OIDC
  federation to an Anthropic API organisation is a supported alternative.

The pipeline, the router's state machine and the safety rules stay as they are today (`docs/factory.md` in
`job-tracker-mcp`), except where this document says otherwise.

## Decisions

| Question | Decision |
|---|---|
| Who it's for | Individuals on their own repos (the maintainer first, then anyone with their own GitHub account and Claude credential), and small teams sharing a repo with OIDC and GitHub's own merge controls. |
| Who may drive the factory | `roles` in `factory.json`: `queue` (may start and steer work) and `approve` (may pass a risky plan or diff). Each holds logins, permission levels (`@write`, `@maintain`, `@admin`), or both. |
| How many issues at once | `concurrency.maxActive` in `factory.json`, default 1. |
| GitHub identity | No App. Writes use `GITHUB_TOKEN`, only in deterministic jobs. The write identity sits behind one seam, so an App mode can be added later without touching the router's logic. |
| Claude credential | `oauth_token` (default): `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. `oidc`: workload identity federation, no secret stored anywhere, billed to an Anthropic API organisation. The mode is chosen at install time. |
| CI on agent code | The factory runs its own restricted stage, `verify`: the repo's configured commands in a sandbox, with a read-only token and no secrets. The repo's own CI runs on the PR only after a maintainer approves the workflow runs. |
| Stale work | Every entry into a stage gets an attempt id. Only the current attempt may publish or move the issue on. |
| Where the code lives | A new **public** repo, `adamwardecki/agent-factory`. Target repos pin it by commit SHA. Public because the stage jobs check it out with the target repo's `GITHUB_TOKEN`, which can't read another private repo. The repo name is an install-time input, so an organisation can point at its own fork or mirror. |
| Per-repo setup | An **install contract** (see below) that any installer can meet. The default installer is a zero-dependency CLI (`init`, `doctor`, `upgrade`). A Terraform module is an optional layer for people who manage many repos. |
| Per-repo config | `.github/factory.json`, read from the default branch only, owned by the repo and changed by pull request. JSON, because Node has no YAML parser and the factory takes no dependencies. |
| Trust in factory comments | HMAC signatures with a per-repo key generated at install time, outside Terraform. They replace the GraphQL "who edited it" checks. |
| Stopping it | `FACTORY_PAUSED`, an Actions variable no installer manages, so anyone with admin access can stop the factory in one command. |
| First adopter | `job-tracker-mcp`. Its in-repo factory is removed once the standalone one has merged a PR there. |

## Out of scope

- The rest of team support, for a v2 spec once v1 has run on a few repos:
  - authority by GitHub team (`@org/team`), which needs an App or a personal access token to check membership;
  - CODEOWNERS deciding who may `/approve` mid-pipeline. GitHub's code-owner review still applies at merge time;
  - cost limits per issue or per person;
  - keeping parallel issues off the same files before they conflict.
- **An App as the write identity.** It would fix required checks that can't be dispatched, required signed commits
  and bot identity for organisations (see Limitations). v1 only keeps the seam for it.
- Issues that need a new dependency. Install runs from the default branch's lockfile, so the agent can't test
  against a package the branch adds. The planner sends these to a human.
- Running the factory for someone else on their repos with your credential. Each adopter brings their own.
- A static Anthropic API key as a third auth mode.
- Self-hosted runners and GitHub Enterprise Server.
- A cap across repos. `maxActive` is per repo.

## Layout of `agent-factory`

| Path | What |
|---|---|
| `router/` | The current `factory/*.ts` (decide, events, snapshot, github, context, globs, markers), plus the config loader, `sign.ts` (HMAC), `prepare.ts` (stage context), `publish.ts` (stage output → GitHub writes) and the output contracts. Node 22.18+, type stripping, no dependencies. |
| `cli/` | `factory.ts`: `init`, `doctor`, `upgrade`, `rotate-key`, `pause`, `resume`. Node plus the `gh` CLI, no dependencies. |
| `skills/factory-{plan,build,review,fix}/` | The stage prompts, rewritten for file outputs (see Stages). |
| `skills/factory-pr/` | The default PR skill, used when a repo sets no `prSkill`. |
| `skills.lock.json` | The Matt Pocock skills pin (repo plus commit SHA). It moves out of target repos. |
| `actions/` | Composite actions shared by the stage workflows (prepare, agent setup, publish). |
| `.github/workflows/router.yml` | Reusable workflow (`workflow_call`): the router job. |
| `.github/workflows/stage.yml`, `stage-oidc.yml` | Reusable workflows: the `prepare`, `agent` and `publish` jobs, one file per auth mode. `stage-oidc.yml` arrives in phase 4. |
| `.github/workflows/verify.yml` | Reusable workflow: the `prepare`, `verify` and `report` jobs. The factory's restricted CI. |
| `scripts/sandboxed.sh` | Runs one configured command in bubblewrap with a clean environment (the verify job). |
| `templates/` | The two caller workflows. The CLI, `scripts/render-callers.ts` and the Terraform module all render these. |
| `presets/` | Toolchain presets (`node.json`, `python.json`, `go.json`): default setup, commands and risky paths. |
| `terraform/modules/factory-repo/`, `terraform/examples/` | The optional module and its examples. |
| `tests/` | `node:test` suites, plus `terraform test` with a mock provider. |
| `docs/` | Quick start, runbook, config reference, security model, upgrade notes. |
| `LICENSE`, `CHANGELOG.md` | MIT. One changelog entry per release. |

Releases are git tags. Target repos pin a commit SHA, so a moved tag can't change what runs. The pin is the one
`uses: <factory repo>/.github/workflows/<file>@<sha>` line in each caller job. The reusable workflows check out their
own repository and commit from the `job` context (`job.workflow_repository` and `job.workflow_sha`, confirmed by
phase 0 check 9), so the workflow YAML and the code it runs always come from the same commit, and there is no second
copy of the SHA to keep in step. Dependabot can upgrade a repo by bumping that one line.

## Install contract

A repo runs the factory when these exist. Nothing else is required, and any tool may create them.

| What | Detail |
|---|---|
| Two caller workflows | `.github/workflows/factory-router.yml` and `factory-stage.yml` on the default branch, rendered from `templates/`. |
| Config | `.github/factory.json` on the default branch. |
| Labels | The `agent:*` stage labels and the three triage labels. |
| `.gitignore` | Lists `.factory/`, the agents' working directory. Git already ignores it in the agent job, but linters that read `.gitignore` don't know that. |
| Secret `FACTORY_SIGNING_KEY` | 64 random characters. |
| Claude credential | Secret `CLAUDE_CODE_OAUTH_TOKEN`, or the four `FACTORY_ANTHROPIC_*` variables in `oidc` mode. |
| Variable `FACTORY_DRY_RUN` | The router treats any value other than exactly `0` as dry run, so a typo fails safe. During the `job-tracker-mcp` trials the variable held `)`, and the factory ran live. |
| Repo setting | Actions may create pull requests. |

Recommended, not required: a rule on the default branch that requires one approving review. The factory never
merges, with or without it.

## Files in each target repo

Three files. None of them contains factory logic.

1. **`.github/workflows/factory-router.yml`.** It holds the triggers: issue labels, issue comments, PR reviews,
   `pull_request_target` closed, the sweep cron, and `workflow_dispatch` with optional `report_*` inputs. There is no
   `workflow_run` trigger: it never fires for runs that `GITHUB_TOKEN` dispatched (phase 0 check 1). It has one job: `uses: <factory repo>/.github/workflows/router.yml@<sha>`,
   passing the secrets it needs.
2. **`.github/workflows/factory-stage.yml`.** It has `workflow_dispatch` inputs `stage`, `issue` and `attempt`, and
   its run-name is `factory-<stage> #<issue> <attempt>`. It has two jobs, picked by `inputs.stage`:
   - the agent stages: `uses: …/stage.yml@<sha>`, or `…/stage-oidc.yml@<sha>` with `id-token: write` in `oidc`
     mode;
   - `verify`: `uses: …/verify.yml@<sha>`.
3. **`.github/factory.json`.** The repo's config. The installer writes a first version and never overwrites it
   afterwards; the repo owns it and changes it by pull request. Why: config that an installer keeps rewriting can't
   be changed where the code is reviewed, and every local change becomes drift.

```json
{
  "version": 1,
  "roles": { "queue": ["adamwardecki", "@maintain"], "approve": ["adamwardecki"] },
  "concurrency": { "maxActive": 1 },
  "defaultBranch": "main",
  "toolchain": { "node": "24.x" },
  "commands": {
    "install": "npm ci --prefix dev --ignore-scripts",
    "test": "npm test",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "testFile": "node --no-warnings --test",
    "extra": ["npm run test:node", "npm run lint:fix"]
  },
  "riskyPaths": ["plugin/hooks/**", "plugin/servers/tracker/src/db.ts"],
  "prSkill": ".claude/skills/create-pr",
  "models": { "plan": "claude-opus-5-5", "build": "claude-sonnet-5-5", "review": "claude-opus-5-5", "fix": "claude-sonnet-5-5" },
  "maxTurns": { "plan": 60, "build": 150, "review": 60, "fix": 100 },
  "limits": { "maxRounds": 3, "maxRebases": 2, "maxAttempts": 2 }
}
```

- **Where config is read from:** the router and the stage read `factory.json` from the default branch through the
  API, never from a checkout of a PR branch.
- **Risky paths:** the factory adds a built-in baseline to `riskyPaths`: `.github/**`, `**/.claude/**`, `AGENTS.md`,
  `**/CLAUDE.md`, `**/CLAUDE.local.md`, `.mcp.json`, `docs/agents/**`, `GLOSSARY*.md`, `CONTEXT*.md`,
  `**/docs/adr/**`, `.factory/**`, and the lockfiles and manifests of the configured toolchain.
- **No CI setting.** The factory runs `commands` itself in the verify stage, and the repo's own CI waits for a
  maintainer (see Verify and the repo's CI).
- **Allowed tools:** each agent's Bash rules come from `commands`, so `"test": "npm test"` becomes
  `Bash(npm test)`. `commands.extra` lists further commands, allowed exactly as written, for build and fix. No
  other command can run. The allowlist limits what the agent types; it doesn't contain what a test does once it
  runs. The read-only token and the environment scrub do that.
- **Sandbox home:** verify runs install, typecheck, lint and test as separate sandboxed commands that share one
  home directory for the job, so a `pip install --user` or a tool cache from the install is still there for the
  test. The runner's tool cache is read-only, so a Python repo should install into a virtualenv in the workspace
  (`python -m venv .venv && .venv/bin/pip install -r requirements.txt`, and `.venv/bin/pytest` as the test command).
- **Toolchain setup:** `toolchain` covers the built-in setups (`node`, `python`, `go`). For anything else (Rust, a
  monorepo, a test database), the agent job also runs the repo's own composite action at the fixed path
  `.github/actions/factory-setup`, if it exists. It runs from the default branch's checkout, before the switch to
  the PR branch, and `.github/**` is a risky path, so an agent can't change it.
- **`prSkill` is optional.** If set, it names a repo skill the builder follows for PR conventions. If not, the
  builder uses `skills/factory-pr`: run the configured test and lint commands, write an imperative title and a
  body with what changed, why, and a Validation section.
- **`preset` is optional.** `"preset": "node"` (or `python`, `go`) fills in `toolchain`, `commands` and extra
  risky paths. Explicit fields override the preset. A repo with neither a preset nor `commands` fails config
  validation with a message naming the missing fields.
- **`triageLabels` is optional.** It renames the three triage labels for repos that already use other names.
- **Names fixed at install time:** the label prefix (`agent:`) and the branch prefix (`factory/issue-`) are inputs
  of the caller workflows, not `factory.json` fields, because the router's trigger filter needs them before any
  code runs. They have one source: the caller.
- **Matt Pocock's repo conventions are optional.** The stage skills carry defaults when the repo has no
  `docs/agents/`. The CLI offers to add `.claude/settings.json` with the skills pin for local sessions, and never
  overwrites an existing one; it prints the lines to merge instead. (Phase 5: the pin format for local sessions
  isn't settled yet.)

## Router

- **Level-triggered.** Every router run rebuilds the state of all active issues from GitHub and acts on what it
  finds. The event that woke it only says "look now". Why: GitHub drops pending runs in a concurrency group, and
  an event can be missed for other reasons; a router that needed each event would stall. The sweep is the same code
  on a timer.
- **Trigger filter.** The router job's `if:` passes only events the router could act on:
  - an `agent:queued` label;
  - a comment that starts with `/approve`, `/stop` or `/retry`;
  - a changes-requested review or a close on a PR whose head is a factory branch in this repo;
  - the cron and `workflow_dispatch`.

  It no longer checks who the actor is, because roles are data the workflow file can't read. The router code checks
  the actor. A skipped job doesn't enter the concurrency group, so other comments and labels in a busy repo cost
  nothing and push nothing out.
- **Serial.** One concurrency group for the whole repo, cancel-in-progress off, with `queue: max` (phase 0 check 8):
  every waiting run is kept, up to 100, instead of replacing the pending one. Correctness doesn't depend on it.
- **Permissions.** The router job has `contents: write`, `issues: write`, `pull-requests: write` and
  `actions: write`. `contents: write` is there because `markPullRequestReadyForReview` is refused without it, from
  any run (phase 0 check 7). It is safe here because the job runs factory code only: it checks out the factory
  repo at the pinned commit and never the target repo. The caller workflow must grant the same, since a reusable
  workflow gets at most what its caller does.
- **Sweep cron:** default `*/30 * * * *`, configurable at install time. Why not shorter: every run bills at least a
  minute on a private repo, and `*/10` alone is about 4,300 minutes a month. The quick start suggests `*/10` for
  public repos.
- **Attempts.** Every entry into a stage that has a workflow sets `attempt` in the state: the entry time in base
  36, so an issue never sees the same id twice, even after `/stop` and a re-queue.
  - The dispatch carries the attempt, and so does every output the publish job writes (brief, PR footer, review,
    fix comment).
  - The router accepts reports, runs and outputs only from the current attempt. The old "created after the stage
    began" timestamp checks are gone.
  - `/stop` and every other block cancel the attempt's run.
- **One way forward.** `onward()` is the only way into verify, review, fix or ready, and it compares SHAs:
  - verify and review run only on a head that passed the diff gate;
  - review runs only on `pr.headSha == verifiedSha`;
  - ready needs `pr.headSha == review.sha == verifiedSha` and a clean review;
  - a head that moved goes back through the gate and verify.
- **Pause.** When `FACTORY_PAUSED` holds anything other than nothing or exactly `0`, the router logs and exits, and
  the publish job writes nothing. After `resume`, the sweep treats a stage that finished meanwhile as a failed
  attempt and retries it under the normal limits.
- **Dry run** logs the actions and writes nothing, as today.
- **Versioned interfaces:**
  - The caller passes `interface: 1`. The reusable workflows refuse a number they don't know, with an error
    naming the release to pin. Within one interface version, `workflow_call` inputs are only added, and only as
    optional. A test snapshots the inputs.
  - The state comment's hidden data carries a version. A release reads the current and the previous version and
    writes the current one, so an upgrade never strands an issue in flight. A state newer than the router knows
    (a downgrade) is left alone, with one comment saying so.

## Stages

Each stage run has three jobs.

### Job `prepare`: read-only, holds the signing key

- **Why it exists:** the runner process holds every secret its job uses. So the signing key must not be in the job
  that runs Claude.
- **What it does:** runs `router/prepare.ts` from `agent-factory` at the pinned commit. It writes nothing to GitHub.
  - It refuses to go on unless the issue's signed state is at this stage and this attempt.
  - It verifies signatures and builds `.factory/context.md` as today, and hands it to `agent` as an artifact. The
    context has a `## Checks` section with the repo's commands from `factory.json`, and a `## Commits` section
    with the SHAs the stage works from.
  - It passes the stage's immutable inputs to `publish` as job outputs: the attempt, the base SHA, the branch's
    head (or that the branch is absent), `gatedSha`, the PR number and the fix reason. Job outputs, not an
    artifact, because the agent job could overwrite an artifact through the runtime token.

### Job `agent`: read-only

- **`GITHUB_TOKEN` permissions:** `contents`, `issues`, `pull-requests` and `actions`, all `read`.
- **Checkouts:** the target repo's default branch at the workspace root, and `agent-factory` at the pinned commit into
  `.factory-src/`. Both `.factory-src/` and `.factory/` go into `.git/info/exclude`, so the agent can't commit them.
- **Skills:** installs the stage skills into `~/.claude/skills` and Matt's skills at the pin. The stage skills
  name no package manager, branch or repo rule: commands come from the context's Checks section, and SHAs from
  its Commits section. The fixer rebases onto the base SHA from the checkout it already has, with no fetch. A
  test bans repo-specific words in `skills/`.
- **Toolchain:** runs the `toolchain` setup, `.github/actions/factory-setup` if present, and `commands.install`,
  all before the branch switch, only for build and fix.
- **Branch:** review and fix check out the PR branch afterwards and verify that its head equals `gatedSha`.
- **Claude:** runs `claude-code-action` with:
  - the credential for the repo's auth mode (see Claude credential);
  - `github_token` set to the read-only token;
  - `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` for build, review and fix, with bubblewrap installed;
  - no `gh` write commands in the allowed tools.
- **Output:** the agent writes its result under `.factory/out/`, as the table below shows. The job uploads that
  directory as the `factory-out` artifact, kept for one day.

| Stage | Output files |
|---|---|
| plan | `outcome` (`ready-for-agent`, `needs-info` or `ready-for-human`), `comment.md`. For `ready-for-agent`, `comment.md` is the brief. |
| build | `branch.bundle` (`git bundle` of the commits on top of the default branch), `pr.md` (first line is the title, the rest is the body) |
| review | `review.md` (first line is the review marker with its counts; publish adds the reviewed SHA and the attempt) |
| fix | `branch.bundle` (commits on top of `gatedSha`, or on top of the default branch for a rebase), `fix.md` |

### Job `publish`: deterministic, with write permissions

It runs after `agent` (`needs: agent`, `if: always()`).

- **`GITHUB_TOKEN` permissions:** `contents`, `issues` and `pull-requests` set to `write`; `actions` set to
  `write` for the report dispatch.
- **What it runs:** only `agent-factory` code at the pinned commit. It never runs target-repo code, never installs
  dependencies and never runs Claude.
- **What it does:** `router/publish.ts <stage> <issue>` works in two steps:
  1. **Collect:** local only. It reads and checks every output file and the bundle against the stage's contract,
     and returns the list of writes. A failure here means nothing was written.
  2. **Write:** each write runs in turn. Immediately before each one, publish re-reads the signed state and stops
     if the issue is no longer at this stage and attempt, or the factory is paused.
- **Writes are idempotent per attempt,** so a retry after a partial failure is safe:
  - a comment or review that already carries this attempt isn't posted twice;
  - the factory's open PR is updated rather than duplicated;
  - a push is skipped when the remote already has the tip.
- **What `/stop` can't undo:** one write already in flight when the stop lands can complete. It's inert: it
  carries the old attempt, so the router ignores it; the next attempt's lease starts from whatever is on the
  branch then; and the diff gate checks the branch again before anything runs on it. Publish doesn't join the
  router's concurrency group, because a waiting publish job could be dropped from it.
- **One write module.** All writes go through one module that takes a token and a bot login. Nothing else in the
  router or the publish job assumes `github-actions[bot]`. That module is the seam for a later App mode.

Checks on every artifact, before any write:
- **Size:** the bundle and each markdown file are under a cap; markdown is under GitHub's 65,536-character body
  limit.
- **Agent-written markdown is made inert:** `@mentions` are escaped, and so are closing keywords (`fixes #12`,
  `closes #12`, `resolves #12`). Why: agent text must not notify people or close other issues on merge. Publish
  writes the PR's own `Closes #<n>` line itself.
- **No factory markers in agent text.** Output that contains `factory:sig`, `factory:attempt` or `factory:state`
  is refused.
- **Bundles are never checked out.** Publish fetches the bundle into a bare repo, with one explicit refspec and
  object checks on (`transfer.fsckObjects`), runs no hooks, and pushes from there.

Contract checks per stage:
- **plan:**
  - `outcome` is one of the three values;
  - a brief starts with the brief marker and has a `**Touches:**` list that parses.
  - Then it posts the signed comment and sets the one triage label.
- **build:**
  - `git bundle verify`;
  - every commit descends from the default branch head the stage started on;
  - no commit changes a path under `.github/`. Checked per commit, not only on the final diff: GitHub rejects the
    push for any such commit, and the contract gives a clearer error;
  - no merge commits: the factory's branches are rebased, and a merge's own changes hide from a per-commit check;
  - no commit adds or changes a symlink or a submodule. Why: a symlink can make a harmless path point at a risky
    one, and the diff gate compares paths. Such an issue goes to a human;
  - every commit's author and committer is `github-actions[bot]` with the noreply address
    `41898282+github-actions[bot]@users.noreply.github.com`. The agent job sets that identity; it also passes
    `create-pr`-style noreply email checks.
  - Then it pushes `factory/issue-<n>` with an explicit lease on the head `prepare` recorded
    (`--force-with-lease=refs/heads/<branch>:<sha>`, or an empty expected value, which requires the branch not to
    exist). Why: a retry must not replace commits a maintainer pushed while the builder ran. Then it opens a draft
    PR whose body ends in `Closes #<n>` and carries a signed footer.
- **review:**
  - the marker parses, with integer counts.
  - Then it writes the reviewed SHA and the attempt into the marker, signs it, and posts a `COMMENT` review with
    `commit_id` set to that SHA. A review counts only for the commit it reviewed.
- **fix:**
  - the same bundle checks, with `gatedSha` as the base (or the default branch for `rebase`).
  - Then it pushes with `--force-with-lease=refs/heads/factory/issue-<n>:<gatedSha>` and posts a signed comment.

**A failed contract check writes nothing.** The stage counts as failed, exactly as a missing brief or PR does
today.

**Report:** as its last step, which always runs, `publish` dispatches `factory-router.yml` with these inputs:
- `report_stage`, `report_issue`, `report_attempt`, `report_run_id`;
- `report_result`: `success` only if all three jobs succeeded.

This exists because `workflow_run` doesn't fire for a run that `GITHUB_TOKEN` dispatched (phase 0 check 1);
`workflow_dispatch` from `GITHUB_TOKEN` does work. The router doesn't trust the inputs. It checks, through the API,
that:
- the run belongs to this repo's `factory-stage.yml`;
- the run's event is `workflow_dispatch`;
- the run's display title matches `factory-<stage> #<issue> <attempt>`, and the attempt is the current one;
- the reported result matches the jobs' conclusions.

## Verify and the repo's CI

**The problem:** CI runs what the branch contains. If the router dispatched the repo's CI on agent-written code,
changed tests or package scripts would run with whatever secrets and token that CI holds, before anyone approved
anything.

**The factory's own check: the `verify` stage.** After build and after each fix, the issue goes to `ci` through the
diff gate, and `ci` runs `verify.yml`. It has three jobs:
- **`prepare`:** as in the agent stages.
- **`verify`:** checks out `gatedSha` and runs the repo's configured install, typecheck, lint and test commands.
  - `contents: read`, no secrets, no caches;
  - each command runs through `scripts/sandboxed.sh`: bubblewrap, a clean environment, its own PID namespace.
- **`report`:** factory code only. It dispatches the result to the router, like publish does.

When verify passes, the state records `verifiedSha`. Review runs only on that SHA.

**The diff gate runs first.** A risky diff that the approved Touches don't cover waits at `awaiting-approval`, and
verify doesn't run. Why: verify installs from the branch's manifest and lockfile.

**The repo's own CI is the maintainer's to start.** GitHub puts `pull_request` runs for a PR that `GITHUB_TOKEN`
opened or updated (`opened`, `synchronize`, `reopened`) in an approval-required state: the PR shows "Approve
workflows to run". So:
- the repo's CI, which may hold secrets, runs agent-written code only after a person has looked at the PR;
- there are no duplicate runs, because the factory dispatches none;
- required checks on the default branch go green after that approval, and each new head needs it again;
- `factory.json` needs no CI setting, and the repo's CI workflows need no `workflow_dispatch` trigger.

Platform check 2 confirms this on a real repo. If GitHub doesn't behave this way, the fallback is to dispatch a
configured list of CI workflows behind the diff gate, and `doctor` must then warn about workflows with secrets.

## Trust

All factory writes now come from `github-actions[bot]`, the same as any other workflow in the repo that uses
`GITHUB_TOKEN`. Author checks alone no longer tell factory comments apart, so the factory signs them:

- **The key:** the installer generates `FACTORY_SIGNING_KEY` and stores it as an Actions secret. It's never in
  Terraform state. Only the router, `prepare` and `publish` receive it; the agent job doesn't.
- **What gets signed:** state comments, briefs, the planner's other comments, reviews, fix comments and the PR
  footer. Each ends in
  `<!-- factory:sig <key id>.<HMAC-SHA256(key, issue number, marker kind, body without the signature)> -->`.
  - **Replay:** the signed body of every stage output carries its attempt, and a review's also carries the SHA it
    reviewed. An old review or brief therefore can't stand in for a newer one. Approvals inside the state name the
    head they cover.
  - **Key id:** the first 8 hex characters of the key's SHA-256. It lets the router tell "signed with a retired
    key" from "tampered" and say which in its comment.
- **Canonical form:** before signing and before checking, the body is normalised: `\r\n` becomes `\n`, trailing
  whitespace is removed from every line, trailing newlines are removed, and the signature line itself is
  dropped. GitHub returns some bodies with `\r\n`, and without this signatures would fail at random.
- **Verification:** the router and the context builder accept a marker only if its signature checks out. That
  covers edits too: an edited comment fails the check. It replaces the GraphQL `editor` lookup.
- **Key rotation** (`rotate-key`): markers signed with the old key stop verifying, so issues in flight lose their
  state. Planned rotation: `pause`, wait until `doctor` shows nothing in flight, rotate, `resume`. After a
  suspected leak: rotate at once; the router blocks each issue in flight with the reason `key-rotated`, and
  re-adding `agent:queued` starts it over.
- **What signatures don't stop:** someone with write access can put an older, validly signed state comment back.
  The security doc says so. Approvals are tied to a head SHA, which limits what that buys.
- **Commands** (`/approve`, `/stop`, `/retry`), `agent:queued` labels, changes-requested reviews and notes in the
  fix context count only from someone with the right role (see Roles). A command also has to be unedited or last
  edited by someone with that role. That rule keeps today's GraphQL check for comments.
- **Other rules are unchanged:**
  - fork runs, PRs and reviews are ignored;
  - config and code come from the default branch and from `agent-factory` at a pinned SHA;
  - the risky-diff gate runs before verify, before review or fix agents run on a branch, and before `ready`.

## Roles

`roles` has two lists. They're separate because they are different powers: `queue` spends the credential and steers
agents; `approve` is a security decision.

| Role | May |
|---|---|
| `queue` | Add `agent:queued`; `/retry`; `/stop`; request changes on a ready PR; write the PR reviews and comments the fixer reads. |
| `approve` | `/approve` a risky plan or diff; `/stop`. |

- **`queue` is required; `approve` defaults to the same list.** A solo repo writes one list. Neither has a
  built-in default, and validation fails without `queue`.
- **Entries** are GitHub logins and permission levels, in any mix: `["alice", "@maintain"]`.
  - **A login** matches that account only.
  - **A permission level** (`@write`, `@maintain` or `@admin`) matches anyone whose permission on the repo is at
    least that level, in the order read < triage < write < maintain < admin. The router checks with
    `GET /repos/{owner}/{repo}/collaborators/{login}/permission`, which works with `GITHUB_TOKEN`, and caches each
    answer for the rest of the run.
  - **`@read` and `@triage` are rejected** by config validation. Read access is open to everyone on a public repo,
    and triage people can't push, so neither should be able to approve risky diffs.
- **Permission levels need `oidc` mode.** With `oauth_token`, validation accepts logins only. Why: a level lets
  everyone who can push spend one person's personal subscription.
- **The check runs on the actor at the time of the event.** Someone removed from the repo stops counting from the
  next event. Their earlier comments keep whatever effect they already had.
- **Bots never count,** even with write access. `github-actions[bot]` and every `[bot]` account are refused before
  the permission check, so another workflow or App can't drive the factory.
- **Cost:** with `@write` in `queue`, anyone who can push can queue issues, and each run bills the repo's API
  organisation. That's the same group that can already dispatch `factory-stage.yml` by hand.

## Review requests

When a PR becomes ready, the router asks for one review:
- **From whoever queued the issue:** the person who added `agent:queued`, from the timeline lookup the sweep
  already does. A PR's author can't be asked to review it, but factory PRs are authored by `github-actions[bot]`, so
  that never comes up.
- **Fallback:** the first plain login in `roles.approve`, then in `roles.queue`, if there is one.
- **Otherwise no request.** A repo with a `CODEOWNERS` file also gets GitHub's own code-owner requests when the PR
  leaves draft, independent of the factory.

## Parallel issues

`concurrency.maxActive` (1 to 5, default 1) caps how many issues may be in an active stage at once: planning,
building, ci, in-review or fixing.

- **One admission queue.** Every move from an inactive stage to an active one passes through the cap: `/approve`,
  `/retry`, a changes-requested review, the sweep's retries, rebases and queued issues. Why: today only the start
  of a queued issue checks capacity, so approving one issue while another runs gives two active issues.
  - A move that doesn't fit saves the issue in a new inactive stage, `waiting`, which records the stage it was
    entering. Nothing is dispatched.
  - `startNext` resumes waiting issues before it starts queued ones, oldest first, and re-checks each through
    `onward()`, because the PR may have moved while it waited.
  - The router loads every issue before it decides an event, so the event is admitted against the real count.
- **Waiting on a person** (`awaiting-approval`, `ready`) doesn't take a slot, as today.
- **Rebases for conflicting ready PRs** take a slot like any other stage, ahead of queued issues. A rebase that
  blocks at the rebase cap doesn't use a slot, so a queued issue can start in the same pass.
- **One run per issue at a time:** each stage run has the concurrency group `factory-stage-<issue>`, with
  cancel-in-progress off. Two dispatches for the same issue never overlap; runs for different issues run side by
  side.
- **The router stays serial** (see Router), so two runs can't both fill the last slot.
- **Conflicts:** issues that touch the same files will conflict once the first one merges. The existing rebase path
  handles that: the conflicting ready PR goes back to the fixer, up to `maxRebases`. Keeping overlapping issues
  apart up front is v2.
- **Rate limits:** every active issue draws on the same Claude credential. With a subscription
  (`oauth_token` mode), `maxActive` above 2 will hit rate limits during busy fix loops; the quick start says so.

## Claude credential

The mode is an install-time choice. Switching modes re-renders the stage caller; no factory code changes.

**`oauth_token` (default): the maintainer's subscription.**
- The `agent` job passes `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`.
- The secret is set once per repo by hand: `claude setup-token`, then `gh secret set`. `init` prints the two
  commands and `doctor` checks the secret exists.
- The job's permissions don't include `id-token`.
- The token needs renewing by hand. When a stage dies before its first model call with an auth error, the router
  blocks the issue (`credential`) and comments once, saying to renew the token; `/retry` afterwards. The signal
  is a step of the agent job, `Claude refused the credential`, which fails only when the action's result is an
  error at no cost with the API's authentication message (a dummy token in the sandbox gave "Failed to
  authenticate. API Error: 401 OAuth access token is invalid."). The router reads that step's conclusion from the
  jobs API, which a dispatched report can't fake. The agent's own test code could write that output file and fake
  it; the worst it buys is a block instead of a retry.

**`oidc`: workload identity federation.**
- **Inputs:** `organization_id`, `federation_rule_id`, `service_account_id` and `workspace_id`. These are IDs, not
  secrets, so they're stored as Actions variables (`FACTORY_ANTHROPIC_*`).
- **The `agent` job** passes the action's `anthropic_organization_id`, `anthropic_federation_rule_id`,
  `anthropic_service_account_id` and `anthropic_workspace_id` inputs. The action exchanges the job's GitHub OIDC
  token (audience `https://api.anthropic.com`) for short-lived Anthropic credentials. No Claude secret exists in
  the repo or anywhere to rotate.
- **Only the agent job gets `id-token: write`, and only in this mode.** A reusable workflow can't grant itself
  more than its caller does, and GitHub checks a nested job's `id-token` permission even when the job is skipped.
  So there are two stage workflows, `stage.yml` and `stage-oidc.yml`, which share composite actions, and the
  installer renders the stage caller for one of them. The prepare job, the publish job and the router never get
  `id-token`.
- **One-time setup in the Claude Console**, by hand:
  - create a service account in the API organisation;
  - create a federation rule for that service account. Match the subject prefix
    `repo:<owner>/<repo>:ref:refs/heads/<default branch>`, so only runs dispatched on the default branch qualify.
    If the Console can match other claims, also require `job_workflow_ref` to start with
    `<factory repo>/.github/workflows/stage-oidc.yml@`, so only the factory's stage workflow gets credentials. If
    it can't, the runbook says so: then any workflow on the default branch of that repo can use the rule.
  - note the organisation, rule, service account and workspace IDs.
- **Billing:** usage is billed per token to the API organisation. Rate limits are the organisation's, separate from
  the maintainer's subscription. Separate workspaces with spend limits keep repos from sharing one budget.
- **Exposure:** an agent that gets code execution could request its own OIDC token while the job runs. It could
  only use it against Anthropic under this rule, or against a cloud provider that already trusts this repo's
  OIDC tokens. The runbook says to keep other trust policies for the repo narrower than "any workflow".

## Installing: the CLI

`node cli/factory.ts <command> --repo <owner>/<name>`, run from a clone of `agent-factory` at a release tag. It
needs Node 22.18+ and an authenticated `gh` with the `workflow` scope. It holds no state: every command reads the
repo and acts on what it finds, so running it twice is safe: the second run writes nothing.

- **`init`** installs the contract:
  1. Runs the `doctor` checks that can fail before anything exists, and stops on an error.
  2. Creates the labels that are missing. Sets `FACTORY_DRY_RUN` to `1` if it's unset. Generates
     `FACTORY_SIGNING_KEY` if the secret is missing. Turns on "Actions may create pull requests".
  3. Opens a pull request from `factory/install` with the two caller workflows, the `.factory/` line in
     `.gitignore` and, if the repo has none, a first `factory.json` from the flags (`--queue`, `--test`,
     `--install`, `--lint`, `--typecheck`, `--node`, `--python`; `--preset` arrives with presets in phase 5). The
     flags are checked with the router's own config parser before init writes anything. A pull request, not a push
     to the default branch, so the installer needs no bypass of branch rules and the maintainer reviews what will
     run.
  4. Prints what's left: the Claude credential, and going live with `gh variable set FACTORY_DRY_RUN --body 0`.
  - `--protect-default-branch` (phase 5) also adds a ruleset requiring one approving review, if no rule requires
    one yet. Not in phase 2: rulesets return 403 on a private repo on the Free plan, so the sandbox can't check it.
- **`doctor`** checks a repo and prints errors and warnings. It reads workflow files as text, because there's no
  YAML parser; its warnings are hints, not proofs.

  | Check | Level |
  |---|---|
  | The `gh` token's scopes and admin access | error |
  | Actions is enabled, and the allowed-actions policy admits the factory repo and `anthropics/claude-code-action` | error |
  | "Actions may create pull requests" is on, and the organisation hasn't locked it off. Reading the organisation's setting needs `admin:org`, so with the usual scopes this is an info line; `init` changes the setting before anything else, and stops on GitHub's 409 if the organisation forbids it | error |
  | `factory.json` validates; the callers' pinned SHA exists in the factory repo; the interface version is known | error |
  | A ruleset that covers `factory/issue-*` requires signed commits, a pull request, status checks, deployments or a merge queue, restricts creating or updating branches, or blocks force pushes (a rebase round force-pushes). Classic branch protection with a wildcard pattern isn't read; the runbook says to check it by hand | error |
  | A factory label exists only in another case (GitHub refuses the exact one next to it, and the router matches exactly) | error |
  | `oauth_token` mode with a permission level in `roles` | error |
  | The signing key and the Claude credential exist (names only; values can't be read) | error |
  | The default branch has required checks: they run on a factory PR only after someone approves the workflow runs | info |
  | The default branch doesn't require an approving review | warning |
  | A CLA or DCO check is required | warning |
  | `FACTORY_DRY_RUN` and `FACTORY_PAUSED` values; issues in flight | info |
- **`upgrade <sha>`** opens a pull request that re-renders the callers at a new pin. It refuses a release whose
  interface or state version the repo can't move to in one step, and names the version to go through. Moving to a
  new state version also waits until no issue in flight still holds a state older than the pinned release's.
  `init` never moves a pin: it leaves installed callers as they are and says to run `upgrade`.
- **`rotate-key`** replaces the signing key (see Trust).
- **`pause`** and **`resume`** set `FACTORY_PAUSED`. `gh variable set FACTORY_PAUSED --body 1` does the same.

## Terraform module `factory-repo` (optional)

For people who keep many repos in Terraform. It meets the same install contract and renders the same templates.
It manages settings, and files only on request. It holds no secret, so any backend will do.

**Inputs:**
- `repository`, `factory_repository` (default `adamwardecki/agent-factory`), `factory_ref` (a 40-character SHA, rendered into each caller's `uses:` line);
- `config`: the first `factory.json`, used only when the repo has none;
- `manage_files` (default `true`);
- `rulesets = { default_branch = true, restrict_other_branches = false }`, `required_checks`,
  `extra_bypass_actors`;
- `sweep_cron`;
- `claude_auth` (default `{ mode = "oauth_token" }`; see Claude credential).

**Resources:**

| Resource | What |
|---|---|
| `github_repository_file` × 2 (`manage_files`) | The two caller workflows, committed to the default branch. With `manage_files = false`, `init` and `upgrade` own them through pull requests. |
| `github_repository_file` (`manage_files`) | `factory.json`, created once (`overwrite_on_create = false`) with `ignore_changes` on its content. The repo owns it afterwards. |
| `github_issue_label` | The `agent:*` and triage labels. |
| `github_actions_variable` | `FACTORY_DRY_RUN`, created as `1` with `ignore_changes` on its value, so going live isn't drift. `FACTORY_PAUSED` is never managed. |
| `github_actions_variable` (OIDC only) | `FACTORY_ANTHROPIC_ORGANIZATION_ID`, `…_FEDERATION_RULE_ID`, `…_SERVICE_ACCOUNT_ID`, `…_WORKSPACE_ID`. |
| `github_workflow_repository_permissions` | Lets Actions create PRs (`can_approve_pull_request_reviews = true`; the only switch GitHub has). Default workflow permissions stay `read`. |
| `github_repository_ruleset` (`rulesets.default_branch`) | Default branch: 1 approving review, stale approvals dismissed, approval of the latest push, `required_checks`, squash only, maintainer bypass. Set it to `false` in a repo that already protects its default branch. |
| `github_repository_ruleset` × 2 (`rulesets.restrict_other_branches`) | All other branches except `factory/issue-*`, and tags: creations and updates restricted to the bypass list. Off by default. Why: these rules contained an App token that agents held. Now the only writer is `publish.ts`, which pushes one fixed ref, and in a team repo the rules would block everyone's branches and other workflows' tags. |

**What the module doesn't do:**
- **The signing key and the Claude token.** `node cli/factory.ts init` (or `rotate-key`) sets the key, and
  `gh secret set` the token. Neither passes through Terraform, so neither lands in state.
- **The provider token:** a PAT with the `repo` and `workflow` scopes. With `manage_files = true` it must be able to
  bypass the default-branch rules, because `github_repository_file` commits straight to that branch. With
  `manage_files = false` it needs admin access only.

## Migrating `job-tracker-mcp`

The new caller files have the same names as two of the old workflows, and the labels and `FACTORY_DRY_RUN`
already exist. So the old factory goes first:

1. Finish or block every issue the old factory has in flight.
2. Remove the old factory in one maintainer PR: `factory/`, the six `factory-*.yml` workflows, the
   `.claude/skills/factory-*` skills, the factory rows in AGENTS.md and `tests/factory/`. Keep `docs/factory.md` as a
   pointer to the new runbook. Keep `.claude/settings.json`.
3. Run `init`. It keeps the existing labels, leaves `FACTORY_DRY_RUN` as it is (check that it holds `1`), sets the
   signing key and opens the install PR. Edit `factory.json` in that PR: `riskyPaths` copied from the old
   `factory/risky-paths.txt`, and `prSkill` set to `.claude/skills/create-pr`. Run `doctor` and fix what it
   reports.
4. Set `FACTORY_DRY_RUN` to `0`. Run a docs issue through to a merged PR.
5. Uninstall the `job-tracker-factory` App and delete its key, and delete the secrets the old factory used:
   `FACTORY_APP_PRIVATE_KEY`, `FACTORY_APP_ID` and the App variables. Remove the two rulesets that contained the App
   (`factory: App pushes only factory branches`, `factory: no tags from the App`).

## Error handling

- **Contract or publish failures** count as failed attempts. The sweep retries after the retry delay, and the last
  attempt blocks with a comment.
- **The report dispatch fails or never arrives:** the sweep recovers from `lastRun` as it does today.
- **`factory.json` is missing or invalid:** the router logs it, writes nothing, and comments once on any issue
  labelled `agent:queued`, naming the field that failed.
- **A report, run or output from an attempt that isn't current** is ignored.
- **The issue left the stage while a publish job ran** (`/stop`, a block, a pause): the job stops before its next
  write.
- **The PR head moved after verify or review:** the issue goes back through the diff gate and verify.
- **A marker signed with a retired key:** the router blocks the issue with the reason `key-rotated`.
- **An unknown interface or state version:** the workflow fails, or the router leaves the issue alone, with a
  message naming the release that supports it.
- **The Claude credential is refused:** the router blocks the issue (`credential`) and comments once, saying to
  renew the token; `/retry` once it's renewed.

## Testing

- **Unit tests**, carried over from `job-tracker-mcp/tests/factory`, plus new ones:
  - config: validation and defaults, `roles`, `commands.extra`, `triageLabels`, levels refused in `oauth_token`
    mode;
  - `sign.ts`: round trip, tamper, wrong issue, wrong kind, retired key id;
  - `publish.ts`: each stage's contract checks, run against real temporary git repos and bundles. This includes a
    `.github/` change in a middle commit, a symlink, a submodule, an oversized file, a mention and a closing
    keyword;
  - the report path in `decide`/`events`;
  - roles: logins, each permission level and its order, `@read`/`@triage` rejected, bots refused even with write
    access, one permission lookup per actor per run, `queue` without `approve` can't `/approve`;
  - the diff gate before verify: a risky diff gets no verify run until `/approve`;
  - attempts: a report, run or output from an older attempt is ignored; `/stop` cancels the run;
  - SHAs: review only on `verifiedSha`; ready only when head, review and verify agree; a moved head goes back
    through the gate and verify;
  - review requests: whoever queued, then the first login, then none;
  - admission: slots filled oldest first, `waiting` issues ahead of queued ones, rebases ahead of both, never
    more than `maxActive` active after a sweep or an event;
  - pause: the router and publish write nothing; a stage that finished meanwhile is retried after resume;
  - state versions: the previous version is read and rewritten; a newer one is left alone.
- **The four scenarios the plan review asked for.** `publish` takes injectable `gh` and `git`, so these run
  without a network:
  - publication after `/stop`: the publish job makes no write once the attempt is no longer current;
  - the head changes during review: the old review can't make the new head ready, and verify runs again;
  - `/approve` at capacity: the approved issue goes to `waiting`, and never more than `maxActive` are active;
  - malformed output: zero remote writes.
- **Workflow text tests:**
  - agent jobs hold only `read` permissions;
  - the verify job has `contents: read`, no secrets and no cache steps, and runs every command through
    `scripts/sandboxed.sh`;
  - publish jobs never run target-repo commands;
  - every action is pinned to a SHA;
  - the stage workflow's concurrency group is per issue, with cancel-in-progress off, and the router's is per repo;
  - the signing key reaches only the router, prepare and publish;
  - the router's trigger filter names no login;
  - the `workflow_call` inputs match the snapshot for the interface version;
  - `stage.yml` passes only `claude_code_oauth_token` and never requests `id-token`; `stage-oidc.yml` passes only
    the four federation inputs.
- **CLI tests**, against a fake `gh`: `init` twice changes nothing the second time; an existing `factory.json` and
  `.claude/settings.json` are kept; each `doctor` check fires on a fixture.
- **`terraform test`** with `mock_provider "github"`: the rendered callers (the pinned `uses:` lines), both auth
  modes, each `rulesets` switch, `manage_files = false`, and that no secret is a module input or a resource.
- **End to end:** a throwaway repo, `adamwardecki/agent-factory-sandbox`, with a tiny Node project. It runs three
  trial issues:
  - a docs change that goes through to ready;
  - a change to a risky path that waits for approval;
  - an issue with a planted instruction that must not get through the planner.

  Then `job-tracker-mcp` as in Migrating.

## Platform checks (phase 0)

The App-less design rests on GitHub behaviour that nobody has tested here. These run first, in the sandbox repo,
with throwaway workflows and no factory code. Each has a consequence, so a failure changes the design before
anything is built on it.

| # | Check | If it fails |
|---|---|---|
| 1 | `workflow_run` fires for `factory-stage.yml` runs that `GITHUB_TOKEN` dispatched. | Nothing changes: the report dispatch and the sweep carry the factory. Drop the trigger. **Result: it doesn't fire; trigger dropped.** |
| 2 | A PR that `GITHUB_TOKEN` opens or updates gets `pull_request` runs in an approval-required state, and once approved they satisfy the required checks. | Dispatch a configured list of CI workflows behind the diff gate instead (see Verify and the repo's CI). If that can't satisfy required checks either, stop and plan the App mode. |
| 3 | The verify job's sandbox: bubblewrap with a clean environment can run a real install and test on a hosted runner, and the commands can't read the job's token. | Find what the sandbox must allow. Verify with a weaker sandbox isn't acceptable; stop. |
| 4 | `claude-code-action` works with a read-only `github_token` and no `gh` write tools. | Find what it writes and whether an input turns it off. Otherwise stop. |
| 5 | `git bundle` round-trips through an artifact, including an explicit `--force-with-lease` for an existing and for an absent branch. | Carry a patch series (`git format-patch`) instead. |
| 6 | Allowing Actions to create PRs works on the account's plan, and the PR shows `github-actions[bot]` as author, so the maintainer can approve it. | Stop: there's no other way to open a PR without an App or a PAT. |
| 7 | `GITHUB_TOKEN` can mark that draft PR ready and request a review on it. Today's router needs the App token for both. | Open PRs as non-draft. "Ready" is then the `agent:ready` label plus a comment that mentions the reviewer. |
| 8 | The larger concurrency queue (GitHub changelog, May 2026): whether it exists for job-level groups, and its syntax. | Nothing changes. The router is level-triggered either way. |
| 9 | `job.workflow_sha` and `job.workflow_repository` in a reusable workflow (changelog, August and September 2026). | Keep the `factory_ref` input and the SHA rendered twice. |
| 10 | Job outputs from `prepare` reach `publish` unchanged when the agent job in between is compromised (it can't set another job's outputs). | Sign the manifest in `prepare` and verify it in `publish`. |

### Phase 0 results

Run 2026-11-11 in the private sandbox `adamwardecki/agent-factory-sandbox` (Free plan, `ubuntu-latest` = Ubuntu 26.04).
The probe workflows and their runs stay in that repo.

| # | Result | Evidence and consequence |
|---|---|---|
| 6 | **Pass** | A workflow with `pull-requests: write` opened a draft PR with `GITHUB_TOKEN`; the PR's author is `github-actions[bot]`. Needs "Actions may create PRs" on (repo setting, off by default). No design change. |
| 7 | **Pass, with a condition** | The same run that opened a PR could mark it ready and request a review. Across runs, as the design has it (publish opens the draft, a later router run readies it): a run with `contents: write` marked the PR ready (PR #4), and a run with `contents: read` was refused with `Resource not accessible by integration` (PR #3 stayed a draft); the review request worked in both. **The cause is `contents: write`, not who opened the PR:** the old in-repo factory's router had `contents: read` and blamed the App. So the router job and its caller get `contents: write` (see Router, Permissions). No other design change. |
| 2 (approval) | **Pass** | `opened` and `synchronize` on a PR that `GITHUB_TOKEN` opened and pushed to each created a `pull_request` run with conclusion `action_required`, one per head. Approving the latest one with `POST /actions/runs/{id}/approve` as the repo owner ran the workflow and its check appeared on the PR. So the repo's own CI waits for a maintainer, per head, as designed. The runs appeared 30 to 60 seconds after the push, not at once. |
| 2 (required checks) | **Not tested** | Needs a ruleset or branch protection. The Free plan returns 403 on both for private repos ("Upgrade to GitHub Pro or make this repository public"). Whether an approved run satisfies a *required* check is still open. A public sandbox would answer it. Low risk: after approval, the `test` check run appeared in the PR's status rollup on the head commit, which is what a required-status rule matches; it runs for real in phase 3, on `job-tracker-mcp`'s rulesets. |
| 1 | **Fails as expected** | `wr-target` dispatched by a user fired the `workflow_run` listener; `wr-target` dispatched by `GITHUB_TOKEN` ran but fired no listener, several minutes later. A `workflow_dispatch` from `GITHUB_TOKEN` itself works. So the report dispatch and the sweep carry the factory, as designed. Drop the `workflow_run` trigger from the router caller: it only fires for runs a person dispatched. |
| 3 | **Pass after one fix** | `scripts/sandboxed.sh` ran a real `npm ci && npm test` on a hosted runner (registry reachable), and hid the job: empty `RUNNER_TEMP`, no runner install directory, no git credentials in the checkout, `/etc` and `/usr` read-only, only 4 processes visible. **It leaked the whole step environment, token included, through `/proc/1/environ`:** pid 1 inside the new PID namespace is bwrap itself, and `--clearenv` only cleans the command it runs. Fixed by starting bwrap as `env -i PATH="$PATH" bwrap …`; after it, pid 1's environment is `PATH` only and no process's environment holds the planted secret. Also learned: `ubuntu-latest` is Ubuntu 26.04 and ships bubblewrap 0.11.1 but not socat; `apt-get update` hung for 3m20s on mirror DNS failures in two runs. So: install packages only when missing, never run `apt-get update` first, and give the step a timeout. Confirmed: socat installed from the image's own package lists without an update in about 28 seconds (the Azure mirror failed and `archive.ubuntu.com` served it). |
| 4 | **Pass** | With a dummy `CLAUDE_CODE_OAUTH_TOKEN`, `claude-code-action` ran its whole setup with `github_token` set to a read-only `GITHUB_TOKEN` (`contents`, `issues`, `pull-requests`, `actions` all read) and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`; nothing asked for a write permission. Then, on 2026-11-13, with a real token from `claude setup-token`: under the scrub and the read-only token, the agent ran `Bash(git log:*)`, wrote `.factory/out/git.txt` and `.factory/out/ok.txt` through `Edit(./.factory/**)`, and was refused a write to `./notes.txt` in the repo root (absent afterwards, `git status` clean). Cost $0.05 with Sonnet. No design change. |
| 5 | **Pass** | A bundle made with `git bundle create out.bundle HEAD --not <base>` survived upload and download between jobs, verified, imported with `transfer.fsckObjects` into a ref, and had the base as its parent. Pushes: an empty lease on an absent branch worked; an empty lease on an existing branch was refused (`stale info`); a lease on the current tip worked, also as a rewind; a lease on a stale tip was refused. The build and fix leases work as written. |
| 8 | **Pass** | `concurrency: { group, cancel-in-progress: false, queue: max }` works at job level. Four dispatches into one group: without `queue` the two middle runs were cancelled (one pending slot); with `queue: max` all four ran in order. Use `queue: max` on the router's job: wake-ups are no longer dropped. The router stays level-triggered; this only cuts the cost of a missed one. `actionlint` doesn't know the key yet and flags it. |
| 9 | **Pass** | A reusable workflow called at a pinned commit reads `job.workflow_sha`, `job.workflow_repository` and `job.workflow_ref` (all three are the *reusable's*; `github.sha` is the caller's). It also checked itself out with `repository: ${{ job.workflow_repository }}` and `ref: ${{ job.workflow_sha }}` in a `with:` block, and got the pinned commit. **Consequence:** the `factory_repo` and `factory_ref` inputs and the SHA rendered twice can go; one `uses: …@<sha>` line per caller is the whole pin. Not available on GHES (already out of scope). Not tested: a private factory repo, which can't be checked out with the target's token either way. |
| 10 | **Pass, and it shows why** | The agent job replaced the `data` artifact that `prepare` had uploaded: the upload succeeded even without `overwrite: true`, and `publish` downloaded the forged content. `prepare`'s job output still read `real`. So an artifact is not a safe channel from `prepare` to `publish`; a job output is. The design already uses outputs. |

For `oidc` mode, before phase 4: that the token exchange works from a reusable workflow called by the target repo,
whether the Console can match `job_workflow_ref`, and that the scrub keeps working.

## Sandbox trial (phase 2, first issue)

Run 2026-11-13 to 14 in `agent-factory-sandbox`: one issue ("add a `multiply` function" to a tiny Node project)
from `agent:queued` to a ready PR. The dry run logged the expected actions and wrote nothing. Live, it found four
bugs, each fixed test-first and re-pinned:

| Run | What broke | Fix |
|---|---|---|
| plan 1 | GitHub refused to load `agent-setup`: composite action steps can't take `timeout-minutes`. | The apt install carries `timeout 300` instead. |
| plan 2 | Claude finished, then the job failed: the runner reads a composite action's file again for its nested post steps (`setup-node`), and the job had moved the factory checkout out of the workspace. | `setup-node` and `setup-python` run in the job, before `agent-setup`. |
| build 1 | The publish job refused the commit: Claude Code adds a `Co-Authored-By` trailer by default. The contract worked as designed. | `attribution` (and the older `includeCoAuthoredBy`) off in the action's settings; the build and fix skills say why. |
| verify 1 | The checks passed but the report never went out: `gh workflow run` looks up the default branch, which `actions: write` alone can't. | The report job also gets `contents: read`. |

After those: the plan's brief named the right touches; the build pushed one commit as `github-actions[bot]` and
opened a signed draft PR; verify ran `npm ci` and `npm test` in the sandbox; the review found nothing blocking; the
router marked the PR ready and requested the maintainer's review. The repo's own CI waited for approval
(`action_required`), as designed. Claude cost about $0.22 for the plan, $0.11 for the build.

Also seen: no scheduled sweep ran for about four hours after the callers were first committed, so the hourly retry
waited that long. Scheduled workflows can start late on a new or quiet repo; a report or a comment wakes the router
at once.

### Second round: more issues, the failure paths and containment

Run 2026-11-14, with the four fixes above pinned. No new bugs in the factory's code.

- **Admission:** a second issue queued while one was in review stayed `queued` and started in the router run that
  moved the first to `ready`. A changes-requested review on a ready PR, while another issue held the one slot,
  parked it in `waiting`; it ran fix, verify and review once the slot freed, and came back to `ready`.
- **Rebase over a person's commit (finding 2):** a maintainer commit on the PR branch, then a merge that made the PR
  conflict. The fix stage rebased, resolved the conflict (kept both functions), and the contract accepted the
  carried commit (author the maintainer, committer the bot).
- **Timeouts (finding 4):** a job that hits `timeout-minutes` reports `cancelled`, and so does its run. A later job
  with `if: ${{ !cancelled() }}` still runs, as does one with `always()`: `cancelled()` is only true when the run
  itself was cancelled. So a timed-out stage still reports, and the router counts it as a failed attempt.
- **Sandbox home (finding 1):** a `pip install --user` in one `sandboxed.sh` call was there in the next, and a
  virtualenv in the workspace works.
- **Containment (finding 5),** from a probe test that the build's agent and verify both ran. In the agent job,
  under the env scrub: `sudo` refused; `_actions`, `/usr` and the runner's file-command files (`GITHUB_ENV`,
  `GITHUB_PATH`) read-only; 7 processes visible; no `CLAUDE_CODE_OAUTH_TOKEN` or `ACTIONS_RUNTIME_TOKEN` in any
  visible environment. `$RUNNER_TEMP` is writable (the moved factory checkout, the skills, Claude's prompts, scripts
  of steps that already ran); nothing there runs again after Claude. In verify: an empty environment, 5 processes,
  `_actions` not visible, `$RUNNER_TEMP` a throwaway tmpfs.
- **Fixed after the round: the read-only `GITHUB_TOKEN` was in the test's environment** (as `GITHUB_TOKEN` and
  `GH_TOKEN`) in build and fix, and tests have network. `claude-code-action` puts the job's token in Claude's
  environment for `gh`; only the planner uses `gh`, so the other stages set both to empty in Claude Code's `env`
  setting.
- **Fixed after the round: a PR that a merge made conflicting was seen only by the next sweep.** Right after a
  push to a PR or its base, GitHub reports `mergeable_state: unknown` while it works the answer out, so the router run
  that the merge woke read the PR as clean. The PR read now asks again, up to five times two seconds apart, while
  the state is `unknown`.
- **Both fixes checked on GitHub:** a third build's probe saw neither token with a value, in its own environment or
  any visible process; and merging one ready PR sent the other, which it made conflicting, to a rebase in the same
  router run. On the way, a plain YAML value holding `': '` made GitHub refuse `stage.yml` at dispatch; the sweep
  dispatched the lost plan again, same attempt, ten minutes later. CI now runs actionlint, and a test refuses the
  pattern.
- **Not a bug:** an issue carries two stage labels for under a second while it changes stage (the new label is
  added, then the old one removed, so it is never without one; the router finds issues by those labels).

## Limitations

- **One manual step per repo:** in `oauth_token` mode, `claude setup-token` and `gh secret set`, and the token
  needs renewing by hand. In `oidc` mode, a federation rule in the Claude Console instead, and nothing to renew.
- **Shared limits (`oauth_token` mode):** every adopting repo, every parallel issue, and the maintainer's local
  sessions share one subscription's rate limits. `oidc` mode uses the API organisation's limits instead, and
  costs money per run.
- **Team authority is by login or permission level only,** not by GitHub team. Anyone in `approve` can pass a
  risky plan or diff; code owners only come in at merge time.
- **Parallel issues can conflict.** The fixer rebases conflicting ready PRs, but nothing keeps two issues off the
  same files to begin with.
- **No new dependencies.** An issue that needs one goes to a human (see Out of scope).
- **Personal use only (`oauth_token` mode):** a personal subscription covers the maintainer's own repos. `oidc`
  mode removes that limit on the credential side.
- **Bot authorship:** PRs and comments are authored by `github-actions[bot]`. Factory writes can't be told apart
  from the repo's other workflows by author, only by signature.
- **Who can approve PRs:** allowing Actions to create PRs also lets workflows approve them; GitHub has one switch
  for both. The factory never approves. Even if a workflow did, it couldn't satisfy the approving-review rule on a
  factory PR: those PRs are authored by `github-actions[bot]`, and GitHub doesn't let a PR's author approve it.
  The risk is other workflows in the repo approving other PRs, so review them before turning this on.
- **Tests can reach the network.** The agent's token is read-only and its environment is scrubbed, but test code
  is arbitrary code with network access. On a private repo, a prompt-injected agent could send source code out.
  The factory doesn't address that.
- **Required checks need a click.** The repo's own CI runs on a factory PR only after a maintainer approves the
  workflow runs, and again after each new head. `ready` means the factory's verify and review passed, not that the
  repo's CI did.
- **Organisation settings that block the factory**, all of which `doctor` reports:
  - "Actions may create pull requests" locked off for the organisation;
  - an allowed-actions list that doesn't admit the factory repo. Use a fork or mirror inside the organisation and
    change the `uses:` lines to point at it;
  - required signed commits on a rule that covers `factory/issue-*`. The publish job's pushes are unsigned.
    Requiring signatures on the default branch alone is fine, because GitHub signs squash merges;
  - a CLA or DCO check that rejects `github-actions[bot]`. Add the bot to its allowlist.
- **Without a rule on the default branch,** nothing requires a review before a merge. The factory still never
  merges. Rulesets on private repos need a paid GitHub plan.
- **Runners:** GitHub-hosted Ubuntu only, because of the bubblewrap sandbox.

## Adoption by others

Anyone can adopt the factory on repos they own or administer, with their own credential. Nothing in the code or
the installers may assume the original maintainer.

- **No built-in owner.** `roles.queue` has no default, and validation fails without it. Examples use
  `your-github-login`. A test greps the router, workflows, skills, CLI, module and examples for `adamwardecki`
  outside `examples/job-tracker-mcp/`, the default of the module's `factory_repository`, the README, and `LICENSE`.
- **Repo-agnostic defaults:** the presets, the default PR skill, and the built-in risky-path baseline. A repo with
  no `AGENTS.md` still works: the stage skills say to follow `AGENTS.md`, `CONTRIBUTING.md` or `README.md`, in that
  order, if present.
- **Quick start** (`docs/quick-start.md`), aimed at someone who has never seen the factory:
  1. Clone `agent-factory` at the latest release.
  2. `node cli/factory.ts init --repo you/your-repo --preset node --queue your-github-login`, then
     merge the pull request it opens.
  3. Set the Claude credential: `claude setup-token` plus `gh secret set`, or the OIDC Console steps.
  4. `node cli/factory.ts doctor --repo you/your-repo`, and fix what it reports.
  5. Label an issue `agent:queued` and check the dry-run log in Actions.
  6. `gh variable set FACTORY_DRY_RUN --body 0`.
- **Versioning:**
  - Semantic versioning on tags.
  - A breaking change to `factory.json` bumps its `version` field and the major version. The router refuses a
    `version` it doesn't know, with a comment naming the release that supports it.
  - A breaking change to the `workflow_call` inputs bumps the interface version and the major version.
  - Each release lists its commit SHA in `CHANGELOG.md`, so adopters can copy it into `upgrade`.
  - Upgrade notes say whether a release needs new caller files, or only a new pin.
  - Pins of the last two minor releases keep working on the GitHub side; nothing on `main` breaks an older pin.
- **Security model doc** (`docs/security.md`):
  - who can trigger what, and what each role can do;
  - what each job's token can do;
  - where untrusted text goes;
  - what signatures protect and what they don't;
  - what each auth mode stores;
  - that approving the workflow runs on a factory PR runs agent-written code with the repo CI's secrets, so read
    the diff first;
  - that tests have network access;
  - what an adopter must review before turning on "Actions may create PRs".
- **Credential guidance:** subscription mode is for the adopter's own personal repos. OIDC is for anything their
  employer owns or pays for, and for any repo where more than one person may queue. Each adopter's runs bill to
  their own plan or API organisation.
- **Support boundary:** issues against `agent-factory` itself are triaged by hand, never by the factory. Its own
  repo runs no factory, so a reported issue can't steer an agent with write access to the factory's code.

## Phases

Each phase gets its own implementation plan. The config and interface shapes are final from phase 1; until the
phase that ships a feature, validation refuses the values that need it.

0. **Platform checks:** the table above, in `agent-factory-sandbox`, with throwaway workflows. Update this spec with
   the results before phase 1 starts.
1. **Extract, App-less from the start, and nothing more:** create `agent-factory` with:
   - the router and the config loader (`roles`);
   - attempts, `onward()` and the admission queue;
   - the reusable workflows: the prepare/agent/publish split with the publish hardening, and `verify`;
   - signing with key ids, and the report dispatch;
   - the trigger filter without logins, pause, and the interface and state versions;
   - review requests to whoever queued;
   - portable stage skills.

   Subscription auth only, logins only, `maxActive: 1` only. Why so narrow: the first adopter needs none of the
   rest, and each extra mode is another thing to debug before the first merged PR. `job-tracker-mcp` keeps its
   in-repo factory, untouched, until phase 3.
2. **CLI and sandbox trials:** `init`, `doctor`, `upgrade`, `rotate-key`, `pause`, and the comment that says to
   renew the Claude token. Install the sandbox with `init`
   and run the three trial issues.
3. **Adopt:** migrate `job-tracker-mcp` as above.
4. **Teams:** permission levels, the `queue`/`approve` split in live use, `stage-oidc.yml` and the OIDC checks,
   `maxActive` above 1.
5. **Package for others:** `.github/actions/factory-setup`, `commands.extra`, `triageLabels`, the label and branch
   prefixes, presets, the default PR skill, the no-built-in-owner test, the quick start, the security model doc,
   `LICENSE`, `CHANGELOG.md` and the first tagged release. Check it with a fresh repo set up only from the quick
   start.
6. **Terraform:** the optional `factory-repo` module, its examples and `terraform test`.
