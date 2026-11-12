import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASELINE_RISKY, parseAuthMode, parseRepoConfig } from '../router/repo-config.ts';

const minimal = { version: 1, roles: { queue: ['alice'] }, commands: { test: 'npm test' } };

test('a minimal config gets the defaults', () => {
  const c = parseRepoConfig(minimal);
  assert.deepEqual(c.roles, { queue: [{ login: 'alice' }], approve: [{ login: 'alice' }] });
  assert.equal(c.defaultBranch, 'main');
  assert.deepEqual(c.commands, { install: null, test: 'npm test', lint: null, typecheck: null, testFile: null });
  assert.deepEqual(c.limits, { maxRounds: 3, maxRebases: 2, maxAttempts: 2, maxActive: 1 });
  assert.equal(c.models.plan, 'claude-opus-5-5');
  assert.equal(c.maxTurns.build, 150);
  assert.equal(c.prSkill, null);
  assert.deepEqual(c.toolchain, { node: null, python: null });
  assert.deepEqual(c.riskyPaths, BASELINE_RISKY);
});

test('every field can be set', () => {
  const c = parseRepoConfig({
    ...minimal,
    roles: { queue: ['alice', 'bob'], approve: ['alice'] },
    defaultBranch: 'trunk',
    toolchain: { node: '24.x' },
    commands: { install: 'npm ci', test: 'npm test', lint: 'npm run lint', typecheck: 'npm run typecheck', testFile: 'node --test' },
    riskyPaths: ['src/db/**'],
    prSkill: '.claude/skills/create-pr',
    models: { review: 'claude-sonnet-5-5' },
    maxTurns: { fix: 80 },
    limits: { maxRounds: 4 },
    concurrency: { maxActive: 1 },
  });
  assert.equal(c.defaultBranch, 'trunk');
  assert.deepEqual(c.roles.approve, [{ login: 'alice' }]);
  assert.equal(c.models.review, 'claude-sonnet-5-5');
  assert.equal(c.models.build, 'claude-sonnet-5-5');
  assert.equal(c.maxTurns.fix, 80);
  assert.deepEqual(c.limits, { maxRounds: 4, maxRebases: 2, maxAttempts: 2, maxActive: 1 });
  assert.ok(c.riskyPaths.includes('src/db/**'));
  assert.ok(c.riskyPaths.includes('**/package-lock.json'), 'a node toolchain adds its manifests and lockfiles');
});

test('invalid configs name the field', () => {
  assert.throws(() => parseRepoConfig(null), /JSON object/);
  assert.throws(() => parseRepoConfig({ ...minimal, version: 2 }), /version 2/);
  assert.throws(() => parseRepoConfig({ ...minimal, roles: { queue: [] } }), /roles\.queue/);
  assert.throws(() => parseRepoConfig({ ...minimal, roles: undefined, maintainers: ['alice'] }), /roles/);
  assert.throws(() => parseRepoConfig({ ...minimal, commands: {} }), /commands\.test/);
  assert.throws(() => parseRepoConfig({ ...minimal, commands: { test: 'npm test\nrm -rf /' } }), /commands\.test/);
  assert.throws(() => parseRepoConfig({ ...minimal, limits: { maxRounds: 0 } }), /limits\.maxRounds/);
  assert.throws(() => parseRepoConfig({ ...minimal, riskyPaths: ['ok', 3] }), /riskyPaths/);
});

test('a section of the wrong shape is an error, not an empty one', () => {
  // toolchain: "node" used to be ignored, which dropped the node manifests and lockfiles from the risky paths.
  for (const field of ['toolchain', 'limits', 'concurrency', 'models', 'maxTurns', 'roles', 'commands']) {
    for (const bad of ['x', ['y'], 2, null]) {
      assert.throws(() => parseRepoConfig({ ...minimal, [field]: bad }), new RegExp(field), `${field}: ${JSON.stringify(bad)}`);
    }
  }
  assert.throws(() => parseRepoConfig({ ...minimal, models: { plan: null } }), /models\.plan/);
  assert.throws(() => parseRepoConfig({ ...minimal, models: { plan: '' } }), /models\.plan/);
});

test('the risky baseline covers GLOSSARY and CONTEXT files by pattern, and go is not supported yet', () => {
  const c = parseRepoConfig(minimal);
  for (const f of ['GLOSSARY.md', 'GLOSSARY-API.md', 'CONTEXT.md', 'CONTEXT-web.md']) assert.ok(c.riskyPaths.some((g) => g === 'GLOSSARY*.md' || g === 'CONTEXT*.md') || c.riskyPaths.includes(f), f);
  assert.ok(c.riskyPaths.includes('GLOSSARY*.md') && c.riskyPaths.includes('CONTEXT*.md'));
  assert.throws(() => parseRepoConfig({ ...minimal, toolchain: { go: '1.22' } }), /toolchain\.go is not supported by this factory release yet/);
  assert.throws(() => parseRepoConfig({ ...minimal, version: undefined }), /version is missing/);
});

test('no setting may hold a newline or other control character: they reach job outputs and prompts', () => {
  for (const bad of ['24.x\nevil=1', 'a\u0000b', 'x\u2028y']) {
    assert.throws(() => parseRepoConfig({ ...minimal, toolchain: { node: bad } }), /toolchain\.node/, JSON.stringify(bad));
    assert.throws(() => parseRepoConfig({ ...minimal, toolchain: { python: bad } }), /toolchain\.python/);
    assert.throws(() => parseRepoConfig({ ...minimal, models: { plan: bad } }), /models\.plan/);
    assert.throws(() => parseRepoConfig({ ...minimal, defaultBranch: bad }), /defaultBranch/);
    assert.throws(() => parseRepoConfig({ ...minimal, prSkill: bad }), /prSkill/);
  }
});

test('commands and model names cannot break the quoting of the allowed-tools list', () => {
  // Commands become `Bash(<command>)` entries in a comma-separated list inside a quoted CLI argument.
  for (const bad of ['npm test "x"', 'npm test \\ x', 'a, Bash(curl:*)', 'npm run (x)', 'sh -c "a"']) {
    assert.throws(() => parseRepoConfig({ ...minimal, commands: { test: bad } }), /commands\.test/, bad);
  }
  for (const good of ['npm test', 'make test', 'pytest -q', 'go test ./...', 'node --no-warnings --test tests/*.test.ts', 'cargo test --workspace']) {
    assert.doesNotThrow(() => parseRepoConfig({ ...minimal, commands: { test: good } }), good);
  }
  for (const bad of ['claude opus', 'claude-opus-5-5 --dangerously-skip-permissions', 'a"b', 'a,b']) {
    assert.throws(() => parseRepoConfig({ ...minimal, models: { plan: bad } }), /models\.plan/, bad);
  }
  assert.doesNotThrow(() => parseRepoConfig({ ...minimal, models: { plan: 'claude-opus-5-5', build: 'claude-sonnet-5-5' } }));
});

test('commands may not hold control characters or surrounding whitespace', () => {
  for (const bad of ['npm\u0000test', 'npm\ttest\u2028x', ' npm test', 'npm test ']) assert.throws(() => parseRepoConfig({ ...minimal, commands: { test: bad } }), /commands\.test/, JSON.stringify(bad));
});

test('an unknown field is an error, so a typo cannot silently drop a protection', () => {
  assert.throws(() => parseRepoConfig({ ...minimal, riskypaths: ['src/db/**'] }), /unknown field "riskypaths"/);
  assert.throws(() => parseRepoConfig({ ...minimal, commands: { test: 'npm test', tests: 'x' } }), /unknown field "commands\.tests"/);
  assert.throws(() => parseRepoConfig({ ...minimal, limits: { maxRound: 2 } }), /unknown field "limits\.maxRound"/);
  assert.throws(() => parseRepoConfig({ ...minimal, concurrency: { max: 2 } }), /unknown field "concurrency\.max"/);
  assert.throws(() => parseRepoConfig({ ...minimal, toolchain: { rust: '1' } }), /unknown field "toolchain\.rust"/);
  assert.throws(() => parseRepoConfig({ ...minimal, models: { deploy: 'x' } }), /unknown field "models\.deploy"/);
  assert.throws(() => parseRepoConfig({ ...minimal, roles: { queue: ['alice'], aprove: ['bob'] } }), /unknown field "roles\.aprove"/);
  // The old design had a CI workflow setting; say why it is gone instead of ignoring it.
  assert.throws(() => parseRepoConfig({ ...minimal, ci: { workflows: ['ci.yml'] } }), /ci is not a setting.*verify/);
  assert.doesNotThrow(() => parseRepoConfig({ ...minimal, $schema: 'https://example.test/factory.schema.json' }));
});

test('what later phases switch on is refused for now, with the reason', () => {
  assert.throws(() => parseRepoConfig({ ...minimal, concurrency: { maxActive: 2 } }), /maxActive above 1/);
  assert.throws(() => parseRepoConfig({ ...minimal, roles: { queue: ['@write'] } }), /need the oidc auth mode/);
  assert.deepEqual(parseRepoConfig({ ...minimal, roles: { queue: ['@write'] } }, 'oidc').roles.queue, [{ level: 'write' }]);
  assert.throws(() => parseRepoConfig({ ...minimal, preset: 'node' }), /preset is not supported/);
  assert.throws(() => parseRepoConfig({ ...minimal, triageLabels: {} }), /triageLabels is not supported/);
  assert.throws(() => parseRepoConfig({ ...minimal, commands: { test: 'npm test', extra: ['npm run x'] } }), /commands\.extra is not supported/);
  assert.equal(parseAuthMode(undefined), 'oauth_token');
  assert.equal(parseAuthMode('oidc'), 'oidc');
  assert.throws(() => parseAuthMode('api_key'), /auth mode/);
});
