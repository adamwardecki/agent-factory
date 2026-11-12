import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FactoryState } from '../router/markers.ts';
import { outputs } from '../router/prepare.ts';
import { parseRepoConfig } from '../router/repo-config.ts';
import { allowedTools } from '../router/tools.ts';

const config = parseRepoConfig({
  version: 1,
  roles: { queue: ['alice'] },
  toolchain: { node: '24.x' },
  commands: { install: 'npm ci', test: 'npm test', lint: 'npm run lint', testFile: 'node --test' },
});

test('the planner reads, writes only .factory, and can only view issues', () => {
  assert.deepEqual(allowedTools('plan', config), ['Read(./**)', 'Grep', 'Glob', 'Edit(./.factory/**)', 'Skill', 'Bash(gh issue view:*)']);
});

test('build and fix get git and exactly the configured commands', () => {
  const tools = allowedTools('build', config);
  assert.ok(tools.includes('Bash(npm test)'));
  assert.ok(tools.includes('Bash(npm run lint)'));
  assert.ok(tools.includes('Bash(node --test:*)'));
  assert.ok(tools.includes('Bash(git:*)'));
  assert.ok(!tools.some((t) => t.startsWith('Bash(gh')), 'no gh: agents write files, the publish job writes to GitHub');
  assert.ok(!tools.includes('Bash(npm ci)'), 'the agent cannot reinstall');
  assert.deepEqual(allowedTools('fix', config), tools);
});

test('the reviewer reads, diffs and writes only .factory', () => {
  const tools = allowedTools('review', config);
  assert.ok(tools.includes('Edit(./.factory/**)'));
  assert.ok(!tools.includes('Edit') && !tools.includes('Write'));
  assert.ok(!tools.some((t) => /npm|node/.test(t)));
});

const SHA = (c: string) => c.repeat(40);
const state: FactoryState = { stage: 'fixing', since: '2026-11-09T11:00:00Z', round: 1, attempts: 0, runs: [], pr: 51, fixReason: 'rebase', gatedSha: SHA('a'), attempt: 'mhs1abc' };
const prepared = { attempt: 'mhs1abc', defaultBranch: 'main', baseSha: SHA('b'), branchSha: SHA('a'), state };

test('prepare hands the publish job the stage\'s immutable inputs as outputs', () => {
  const o = outputs({ ...prepared, workflow: 'fix' }, config);
  assert.deepEqual(
    { attempt: o.attempt, base: o['base-sha'], branch: o['branch-sha'], gated: o['gated-sha'], pr: o.pr, reason: o['fix-reason'], branchName: o['default-branch'] },
    { attempt: 'mhs1abc', base: SHA('b'), branch: SHA('a'), gated: SHA('a'), pr: '51', reason: 'rebase', branchName: 'main' },
  );
  assert.equal(o.install, 'npm ci');
  assert.equal(o.scrub, '1');
  assert.equal(o.node, '24.x');
  assert.match(o['allowed-tools'] ?? '', /Bash\(npm test\)/);
  for (const v of Object.values(o)) assert.doesNotMatch(v, /\n/, 'every output is one line');
});

test('a new branch is reported as absent, and plan and review install nothing', () => {
  const build = outputs({ ...prepared, workflow: 'build', branchSha: null, state: { ...state, stage: 'building', gatedSha: undefined, pr: undefined } }, config);
  assert.equal(build['branch-sha'], '');
  assert.equal(build['gated-sha'], '');
  assert.equal(build['fix-reason'], '');
  const plan = outputs({ ...prepared, workflow: 'plan', state: { ...state, stage: 'planning' } }, config);
  assert.equal(plan.install, '');
  assert.equal(plan.scrub, '');
  assert.equal(outputs({ ...prepared, workflow: 'review', state: { ...state, stage: 'in-review' } }, config).install, '');
});

test('verify gets the repo\'s commands and no model or tools', () => {
  const o = outputs({ ...prepared, workflow: 'verify', state: { ...state, stage: 'ci' } }, config);
  assert.deepEqual({ install: o.install, test: o.test, lint: o.lint, typecheck: o.typecheck }, { install: 'npm ci', test: 'npm test', lint: 'npm run lint', typecheck: '' });
  assert.equal(o['gated-sha'], SHA('a'));
  assert.equal(o.model, undefined);
  assert.equal(o['allowed-tools'], undefined);
});
