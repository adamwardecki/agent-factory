import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doctor } from '../cli/doctor.ts';
import { firstConfig, type InitOptions, init, withFactoryIgnored } from '../cli/init.ts';
import { FACTORY_LABELS } from '../cli/repo.ts';
import { CALLERS, callerVars, render } from '../scripts/render-callers.ts';
import { factoryWith, merge, messages, NEXT, PIN, templates } from './cli-fixtures.ts';
import { fake, fakeRepo } from './fake-github.ts';

const opts = (extra: Partial<InitOptions> = {}): InitOptions => ({
  factoryRef: PIN,
  sweep: '*/30 * * * *',
  templates,
  queue: ['alice'],
  node: '24.x',
  python: null,
  install: 'npm ci',
  test: 'npm test',
  lint: null,
  typecheck: null,
  ...extra,
});

test('init installs everything missing and opens one pull request with the files', async () => {
  const f = fake(fakeRepo(), factoryWith());
  const r = await init(f.host, opts());
  for (const l of FACTORY_LABELS) assert.ok(f.repo.labels.has(l), l);
  assert.equal(f.repo.variables.get('FACTORY_DRY_RUN'), '1');
  assert.match(f.secretValues.get('FACTORY_SIGNING_KEY') ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(f.repo.workflow, { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true });
  assert.equal(r.pr, 100);
  const branch = f.repo.branches.get('factory/install');
  assert.ok(branch);
  const vars = callerVars('o/agent-factory', PIN, '*/30 * * * *');
  for (const n of CALLERS) assert.equal(branch.get(`.github/workflows/${n}`), render(templates[n] ?? '', vars));
  assert.deepEqual(JSON.parse(branch.get('.github/factory.json') ?? ''), { version: 1, roles: { queue: ['alice'] }, toolchain: { node: '24.x' }, commands: { install: 'npm ci', test: 'npm test' } });
  assert.match(branch.get('.gitignore') ?? '', /^\.factory\/$/m);
  assert.equal(f.repo.branches.get('main')?.get('.github/factory.json'), undefined, 'nothing is pushed to the default branch');
  const next = r.next.join('\n');
  assert.match(next, /merge PR #100/);
  assert.match(next, /claude setup-token/);
  assert.match(next, /FACTORY_DRY_RUN --body 0/);
});

test('init keeps the write setting it found when it turns pull requests on', async () => {
  const f = fake(fakeRepo({ workflow: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: false } }), factoryWith());
  await init(f.host, opts());
  assert.deepEqual(f.repo.workflow, { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true });
});

test('init a second time writes nothing, before and after the install PR is merged', async () => {
  const f = fake(fakeRepo(), factoryWith());
  await init(f.host, opts());
  const before = f.writes.length;
  const again = await init(f.host, opts());
  assert.equal(f.writes.length, before, f.writes.slice(before).join('\n'));
  assert.match(again.done.join('\n'), /install PR #100 is already open/);
  merge(f);
  const merged = await init(f.host, opts());
  assert.equal(f.writes.length, before, f.writes.slice(before).join('\n'));
  assert.equal(merged.pr, null);
  f.repo.secrets.set('CLAUDE_CODE_OAUTH_TOKEN', '***');
  assert.equal(messages(await doctor(f.host), 'error'), '', 'and doctor is happy');
});

test('init leaves callers that are already installed alone: their sweep, and their pin, which upgrade moves', async () => {
  const f = fake(fakeRepo(), factoryWith());
  await init(f.host, opts({ sweep: '0 * * * *' }));
  merge(f);
  const before = f.writes.length;
  await init(f.host, opts());
  assert.equal(f.writes.length, before, `a default --sweep rewrote the callers: ${f.writes.slice(before).join(', ')}`);
  const newer = await init(f.host, opts({ factoryRef: NEXT }));
  assert.equal(f.writes.length, before, `a newer clone re-pinned the callers: ${f.writes.slice(before).join(', ')}`);
  assert.match(newer.next.join('\n'), new RegExp(`upgrade ${NEXT}`));
});

test('init again while the install PR is open needs no flags and writes nothing', async () => {
  const f = fake(fakeRepo(), factoryWith());
  await init(f.host, opts());
  const before = f.writes.length;
  const r = await init(f.host, opts({ test: null, queue: [] }));
  assert.equal(f.writes.length, before);
  assert.match(r.done.join('\n'), /install PR #100 is already open/);
});

test('init stops before any write when the organisation locks the pull request setting', async () => {
  const f = fake(fakeRepo({ orgOwned: true, orgAllowsPrs: 'unreadable', orgLocksPrSetting: true }), factoryWith());
  await assert.rejects(init(f.host, opts()), /organisation/);
  assert.deepEqual(f.writes, ['PUT /repos/o/app/actions/permissions/workflow']);
});

test('init stops before any write when a factory label exists in another case', async () => {
  const f = fake(fakeRepo({ labels: new Set(['Ready-For-Agent']) }), factoryWith());
  await assert.rejects(init(f.host, opts()), /Ready-For-Agent/);
  assert.deepEqual(f.writes, []);
});

test('init keeps the repo\'s own factory.json and .gitignore, and a secret or variable already set', async () => {
  const own = '{ "version": 1, "roles": { "queue": ["bob"] }, "commands": { "test": "make test" } }\n';
  const repo = fakeRepo({ secrets: new Map([['FACTORY_SIGNING_KEY', '***']]), variables: new Map([['FACTORY_DRY_RUN', '0']]) });
  repo.branches.get('main')?.set('.github/factory.json', own);
  repo.branches.get('main')?.set('.gitignore', 'node_modules/\n.factory/\n');
  const f = fake(repo, factoryWith());
  const r = await init(f.host, opts({ test: null, queue: [] }));
  const branch = f.repo.branches.get('factory/install');
  assert.equal(branch?.get('.github/factory.json'), own);
  assert.equal(branch?.get('.gitignore'), 'node_modules/\n.factory/\n');
  assert.ok(!f.writes.some((w) => w.includes('secret') || w.includes('variables')), f.writes.join('\n'));
  assert.doesNotMatch(r.next.join('\n'), /FACTORY_DRY_RUN/, 'already live');
});

test('init without a factory.json needs --test and --queue, and a bad flag changes nothing', async () => {
  for (const o of [opts({ test: null }), opts({ queue: [] }), opts({ install: 'npm ci "--x"' })]) {
    const f = fake(fakeRepo(), factoryWith());
    await assert.rejects(init(f.host, o), /--test|--queue|commands\.install/);
    assert.deepEqual(f.writes, []);
  }
});

test('init stops before any write when the preflight finds an error', async () => {
  const repos = [
    fakeRepo({ admin: false }),
    fakeRepo({ actionsEnabled: false }),
    fakeRepo({ orgOwned: true, orgAllowsPrs: false }),
    fakeRepo({ branchRules: { 'factory/issue-1': [{ type: 'required_signatures' }] } }),
    fakeRepo({ scopes: ['repo'] }),
  ];
  for (const repo of repos) {
    const f = fake(repo, factoryWith());
    await assert.rejects(init(f.host, opts()), /stopped before changing anything/);
    assert.deepEqual(f.writes, []);
  }
});

test('the first factory.json is checked like the router checks it', () => {
  assert.throws(() => firstConfig(opts({ test: 'npm test "x"' })), /commands\.test/);
  assert.throws(() => firstConfig(opts({ queue: ['dependabot[bot]'] })), /bot/);
  assert.equal(JSON.parse(firstConfig(opts({ node: null, python: '3.13', install: null }))).toolchain.python, '3.13');
});

test('.gitignore gets .factory/ once, on its own line', () => {
  assert.equal(withFactoryIgnored(null), "# The factory's agents work here (agent-factory)\n.factory/\n");
  assert.equal(withFactoryIgnored('dist'), "dist\n# The factory's agents work here (agent-factory)\n.factory/\n");
  assert.equal(withFactoryIgnored('a\n.factory/\n'), null);
  assert.equal(withFactoryIgnored('/.factory\n'), null);
});
