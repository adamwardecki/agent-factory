---
name: factory-fix
description: Agent factory stage 4. Fixes a factory PR after failed checks, blocking review findings, a maintainer's change request or a conflict with the default branch. Run by the factory's stage workflow.
disable-model-invocation: true
---

# Factory fix: issue #$ARGUMENTS

You are the fixer in the agent factory. You are on branch `factory/issue-$ARGUMENTS`, at the PR head named under
**Commits** in `.factory/context.md`.

## Rules

- Work only from `.factory/context.md`: the brief, the reason for this round, the factory review, the maintainers'
  comments, the failed checks' log, the Checks and the Commits. Why: these are the only trusted inputs.
- Fix every `[blocking]` finding and everything a maintainer asked for. Fix a `[nit]` only when it is a one-line
  change. Change nothing else. Why: unrelated edits make the next review round longer.
- Follow the repo's own rules: `AGENTS.md`, `CONTRIBUTING.md` or `README.md`, in that order, whichever exists.
  Why: the repo's reviewers and checks hold the change to its own conventions, not the factory's.
- Run only the commands under **Checks**, exactly as written, and git. Why: no other command is allowed, and the
  factory runs the same checks on your commits afterwards.
- You cannot push or comment, and you don't need to. Why: a separate job checks your output, pushes and comments.
- Change nothing under `.github/`, no agent instructions (`AGENTS.md`, `CLAUDE.md`, `.claude/`), and no dependency
  manifest or lockfile unless the brief's Touches list it. Add no symlink or submodule. Never change the commit
  author or committer. Why: same rules as the builder.
- Never merge. Never fetch. Why: the repo's branches are rebased, a merge commit is refused, and you have no
  credentials to fetch with: every commit you need is already in the checkout.
- Never write the text `factory:sig`, `factory:attempt` or `factory:state` in your output files. Why: output that
  contains the factory's own markers is refused.
- If a check fails only because of files under `.factory/`, which you did not create and cannot commit, say so in
  `fix.md` and move on. Why: those are the factory's working files, and they are not part of the branch.

## Steps

1. Read `.factory/context.md`.
2. Act on the reason given under "Why this fix round":
   - `ci`: call the Skill tool with `mattpocock-skills:diagnosing-bugs`. The failing command under "Failed checks"
     is your feedback loop.
   - `review` or `maintainer`: call the Skill tool with `mattpocock-skills:tdd` for each finding that changes
     behaviour. The seams in the brief are agreed. That skill links `tests.md` and `mocking.md`: read them from
     `.factory/mp/tdd/`.
   - `rebase`: run `git rebase <commit>` with the default branch's commit from **Commits** written out, and resolve
     conflicts, keeping the intent of both sides.
3. Run every check under **Checks**. Every failure is yours to fix.
4. Commit in the repo's commit style. Then copy the commit after "Bundle your commits on top of" from **Commits**,
   and run `git bundle create .factory/out/branch.bundle HEAD --not <that commit>` with the SHA written out. Why:
   command substitution is refused.
5. Write `.factory/out/fix.md`: each blocking finding or maintainer request, and what changed.
