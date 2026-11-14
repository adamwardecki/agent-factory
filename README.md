# agent-factory

Turns GitHub issues labelled `agent:queued` into reviewed pull requests, with Claude Code agents running in GitHub
Actions. A maintainer queues issues and merges PRs; agents plan, build, review and fix in between.

There is no GitHub App. Agents hold a read-only token and write their output to files. A separate, deterministic
job checks that output and makes every write with the workflow's `GITHUB_TOKEN`.

**Status:** pre-release. The GitHub behaviour the design rests on was checked with probe workflows in a sandbox repo,
and three issues have gone from `agent:queued` to ready PRs there, through a maintainer's change request, the queue
and a rebase (`docs/design.md`, "Phase 0 results" and "Sandbox trial").

## How a stage runs

```
agent:queued ─► planning ─► (awaiting-approval) ─► building ─► ci ─► in-review ─► fixing ⟲ ─► ready ─► you merge
```

Each agent stage is one run of the target repo's `factory-stage.yml`, with three jobs:

| Job | Holds | Does |
|---|---|---|
| `prepare` | the signing key, a read-only token | Refuses unless this run is the issue's current attempt. Builds the agent's context. |
| `agent` | the Claude credential, a read-only token | Runs Claude. Writes a brief, a git bundle and PR text, or a review, to files. |
| `publish` | the signing key, a write token | Checks every file, then pushes, comments or opens the PR. Runs no code from the target repo. |

The `ci` stage runs `verify` instead of an agent: the repo's configured install, typecheck, lint and test commands
on the PR head, each in a sandbox, with a read-only token and no secrets. The repo's own CI is not started by the
factory. It runs on the PR once a maintainer approves the workflow runs.

A change to a risky path (workflows, agent instructions, dependency manifests, and the repo's own list) waits for
`/approve` before anything runs on the branch.

## Installing

You need admin access to the repo, a logged-in `gh` with the `repo` and `workflow` scopes, and Node 22.18 or newer.
Run the CLI from a clone of this repo at the commit you want to pin; it pins the clone's `HEAD`, which has to be on
GitHub.

```bash
git clone https://github.com/adamwardecki/agent-factory && cd agent-factory
node --no-warnings cli/factory.ts doctor --repo <owner/name>
node --no-warnings cli/factory.ts init --repo <owner/name> --queue <your-login> --node 24.x --install 'npm ci' --test 'npm test'
```

`init` creates the labels, sets `FACTORY_DRY_RUN` to `1`, generates `FACTORY_SIGNING_KEY` and turns on "Allow
GitHub Actions to create and approve pull requests", each only if it's missing. Then it opens one pull request with
the two caller workflows, a first `.github/factory.json` (if the repo has none; the flags above fill it in) and the
`.factory/` line in `.gitignore`. Running it again writes nothing, and it never moves the pin of callers that are
already installed: that's `upgrade`. What's left is printed:

1. Merge the pull request.
2. Set the Claude credential: `claude setup-token`, then `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner/name>`.
3. Label an issue `agent:queued`. The `factory-router` run logs what it would do and writes nothing.
4. Go live: `gh variable set FACTORY_DRY_RUN --body 0 --repo <owner/name>`.

The other commands:

| Command | Does |
|---|---|
| `doctor` | Checks the repo against the install contract: access, the Actions policy and settings, branch rules, the config, the callers' pin, labels and secrets. Exits 1 on an error. |
| `upgrade <sha>` | Opens a pull request that moves the callers to another commit of this repo. Refuses one more than one interface or state version away. |
| `pause`, `resume` | Set and remove `FACTORY_PAUSED`. Paused, the router does nothing, and a publish job that is already running makes no further write. |
| `rotate-key` | Replaces `FACTORY_SIGNING_KEY`. Refuses while issues are in flight; `--now`, after a leak, blocks them with `key-rotated`. |

When the subscription token expires, the next stage stops before Claude's first model call: the factory blocks the
issue and comments how to renew the token. `/retry` once it's renewed.

## Commands

Comment on the issue or its PR. `roles.queue` in `factory.json` may `/retry` and `/stop`; `roles.approve` (the same
people unless you list others) may `/approve` and `/stop`.

- `/approve`: continue past a risky plan or diff.
- `/stop`: block the issue now and cancel its run.
- `/retry`: restart a blocked issue.

## Working on this repo

```bash
npm ci
npm run typecheck && npm run lint && npm test
```

Node runs the TypeScript directly; there is no build step and no runtime dependency. `router/decide.ts` is the state
machine and is pure. `router/publish.ts` is the only code that writes a stage's output to GitHub.

## Limitations

See "Limitations" in `docs/design.md`. The ones to know before a first trial:

- The repo's own required checks run on a factory PR only after a maintainer approves the workflow runs.
- Agents can't add a dependency: the factory installs from the default branch's lockfile.
- This release supports the subscription token only, logins (not permission levels) in `roles`, and one issue at a
  time.
