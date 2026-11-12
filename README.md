# agent-factory

Turns GitHub issues labelled `agent:queued` into reviewed pull requests, with Claude Code agents running in GitHub
Actions. A maintainer queues issues and merges PRs; agents plan, build, review and fix in between.

There is no GitHub App. Agents hold a read-only token and write their output to files. A separate, deterministic
job checks that output and makes every write with the workflow's `GITHUB_TOKEN`.

**Status:** pre-release. The GitHub behaviour the design rests on was checked with probe workflows in a sandbox repo
(`docs/design.md`, "Phase 0 results"); the workflows in this repo have not run yet. One check is open: a real Claude
run with a read-only token.

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

## Trying it on a sandbox repo

The stage workflows check this repo out with the *target* repo's `GITHUB_TOKEN`, which can't read another private
repo. So this repo has to be public before a target repo can run it (or the workflows need a read token). Phase 1
works either way.

Use a throwaway repo. You need admin access to it, the `gh` CLI, and Node 22.18 or newer.

1. Add `.factory/` to the repo's `.gitignore`.
2. Write `.github/factory.json` on the default branch:

   ```json
   {
     "version": 1,
     "roles": { "queue": ["your-github-login"] },
     "toolchain": { "node": "24.x" },
     "commands": { "install": "npm ci", "test": "npm test" }
   }
   ```

3. Render the two caller workflows at a commit of this repo, and commit them to the default branch:

   ```bash
   node --no-warnings scripts/render-callers.ts <owner>/agent-factory <40-character commit SHA> '*/30 * * * *' <target repo>/.github/workflows
   ```

4. Set the secrets and the dry-run switch:

   ```bash
   openssl rand -hex 32 | gh secret set FACTORY_SIGNING_KEY -R <target repo>
   claude setup-token   # then: gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <target repo>
   gh variable set FACTORY_DRY_RUN --body 1 -R <target repo>
   ```

5. Allow Actions to create pull requests: Settings → Actions → General → Workflow permissions.
6. Create the labels:

   ```bash
   for s in queued waiting planning awaiting-approval building ci in-review fixing ready blocked; do
     gh label create "agent:$s" --color 5319e7 --force -R <target repo>
   done
   for l in needs-info ready-for-agent ready-for-human; do gh label create "$l" --force -R <target repo>; done
   ```

7. Label an issue `agent:queued`. The `factory-router` run logs what it would do and writes nothing.
8. Go live: `gh variable set FACTORY_DRY_RUN --body 0 -R <target repo>`.

To stop the factory at any time: `gh variable set FACTORY_PAUSED --body 1 -R <target repo>`. The router then does
nothing, and a publish job that is already running makes no further write.

## Commands

Comment on the issue or its PR. `roles.queue` in `factory.json` may `/retry` and `/stop`; `roles.approve` (the same
people unless you list others) may `/approve` and `/stop`.

- `/approve`: continue past a risky plan or diff.
- `/stop`: block the issue now and cancel its run.
- `/retry`: restart a blocked issue.

## Working on this repo

```bash
npm install
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
