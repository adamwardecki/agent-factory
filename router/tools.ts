// The tools each stage's agent may use. Agents never get gh write commands: they write their output to .factory/out,
// and the publish job makes every write. Build and fix may run exactly the repo's configured commands, nothing else.
// This limits what the agent types. It doesn't contain what a test does once it runs: the read-only token and the
// environment scrub do that.

import type { StageWorkflow } from './config.ts';
import type { RepoConfig } from './repo-config.ts';

const READ = ['Read(./**)', 'Grep', 'Glob'];

// What build and fix need from git, one subcommand at a time. Not all of git: no push or fetch (the stages hold no
// credentials, and must not need any), no config, remote, clone or submodule.
const GIT_WRITE = ['add', 'rm', 'mv', 'commit', 'switch', 'checkout', 'restore', 'reset', 'rebase', 'cherry-pick', 'stash', 'bundle'];
const GIT_READ = ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'branch', 'merge-base'];
// Covers the Write tool too: plan and review can create files under .factory/ and nowhere else.
const SCRATCH = 'Edit(./.factory/**)';

export function allowedTools(stage: StageWorkflow, config: RepoConfig): string[] {
  const c = config.commands;
  switch (stage) {
    case 'plan':
      return [...READ, SCRATCH, 'Skill', 'Bash(gh issue view:*)'];
    case 'review':
      return [...READ, SCRATCH, 'Skill', 'Agent', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git rev-parse:*)', 'Bash(git show:*)'];
    case 'build':
    case 'fix': {
      const commands = [c.test, c.lint, c.typecheck].flatMap((x) => (x ? [`Bash(${x})`] : []));
      const perFile = c.testFile ? [`Bash(${c.testFile}:*)`] : [];
      return [...READ, 'Edit', 'Write', 'Skill', 'Agent', ...[...GIT_WRITE, ...GIT_READ].map((g) => `Bash(git ${g}:*)`), ...commands, ...perFile];
    }
  }
}
