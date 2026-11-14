import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doctor, preflight, report } from '../cli/doctor.ts';
import { factoryWith, installed, messages, PIN } from './cli-fixtures.ts';
import type { FakeRepo } from './fake-github.ts';

test('doctor on a fully installed repo reports no errors or warnings', async () => {
  const findings = await doctor(installed().host);
  assert.equal(messages(findings, 'error'), '');
  assert.equal(messages(findings, 'warning'), '');
  assert.match(messages(findings, 'info'), /dry run \(FACTORY_DRY_RUN is "1"\)/);
  assert.match(messages(findings, 'info'), /no issues in flight/);
});

test('each doctor check fires on its fixture', async () => {
  const set = (path: string, text: string) => (r: FakeRepo) => r.branches.get('main')?.set(path, text);
  const edit = (path: string, from: string, to: string) => (r: FakeRepo) => r.branches.get('main')?.set(path, (r.branches.get('main')?.get(path) ?? '').replaceAll(from, to));
  const cases: [string, (r: FakeRepo) => void, 'error' | 'warning' | 'info', RegExp][] = [
    ['no admin', (r) => { r.admin = false; }, 'error', /no admin access/],
    ['no workflow scope', (r) => { r.scopes = ['repo']; }, 'error', /gh auth refresh -s workflow/],
    ['fine-grained token', (r) => { r.scopes = null; }, 'warning', /reports no scopes/],
    ['Actions off', (r) => { r.actionsEnabled = false; }, 'error', /Actions is turned off/],
    ['local actions only', (r) => { r.allowedActions = 'local_only'; }, 'error', /only allows actions from this repo/],
    ['policy without the factory', (r) => { r.allowedActions = 'selected'; r.selected = { github_owned_allowed: true, patterns_allowed: ['anthropics/claude-code-action@*'] }; }, 'error', /doesn't admit o\/agent-factory/],
    ['policy without GitHub\'s actions', (r) => { r.allowedActions = 'selected'; r.selected = { github_owned_allowed: false, patterns_allowed: ['o/agent-factory/*', 'anthropics/*'] }; }, 'error', /actions made by GitHub/],
    ['PR setting off', (r) => { r.workflow.can_approve_pull_request_reviews = false; }, 'error', /create and approve pull requests" is off/],
    ['organisation lock', (r) => { r.orgOwned = true; r.orgAllowsPrs = false; }, 'error', /organisation o doesn't let Actions/],
    ['organisation unreadable', (r) => { r.orgOwned = true; r.orgAllowsPrs = 'unreadable'; }, 'info', /couldn't read the organisation's/],
    ['pull request rule on factory branches', (r) => { r.branchRules = { ...r.branchRules, 'factory/issue-1': [{ type: 'pull_request' }] }; }, 'error', /requires a pull request/],
    ['label differs in case', (r) => { r.labels.delete('ready-for-agent'); r.labels.add('Ready-For-Agent'); }, 'error', /Ready-For-Agent.*ready-for-agent/],
    ['signed commits', (r) => { r.branchRules = { ...r.branchRules, 'factory/issue-1': [{ type: 'required_signatures' }] }; }, 'error', /requires signed commits/],
    ['no force push', (r) => { r.branchRules = { ...r.branchRules, 'factory/issue-1': [{ type: 'non_fast_forward' }] }; }, 'error', /blocks force pushes/],
    ['rules unreadable', (r) => { r.branchRules = null; }, 'info', /couldn't read the rules for factory\/issue-\*/],
    ['bad config', set('.github/factory.json', '{ "version": 1, "riskypaths": [] }'), 'error', /unknown field "riskypaths"/],
    ['config not JSON', set('.github/factory.json', '{'), 'error', /\.github\/factory\.json: /],
    ['no config', (r) => { r.branches.get('main')?.delete('.github/factory.json'); }, 'error', /factory\.json is missing on main; run init/],
    ['unknown pin', edit('.github/workflows/factory-stage.yml', PIN, 'c'.repeat(40)), 'error', /isn't a commit of o\/agent-factory/],
    ['other factory', edit('.github/workflows/factory-stage.yml', 'o/agent-factory', 'x/fork'), 'warning', /pins x\/fork, not o\/agent-factory/],
    ['other interface', edit('.github/workflows/factory-router.yml', 'interface: 1', 'interface: 2'), 'error', /caller interface 2/],
    ['no pin', set('.github/workflows/factory-router.yml', 'name: factory-router\n'), 'error', /no pinned/],
    ['no labels', (r) => { r.labels.delete('agent:queued'); }, 'error', /missing labels: agent:queued/],
    ['no signing key', (r) => { r.secrets.delete('FACTORY_SIGNING_KEY'); }, 'error', /FACTORY_SIGNING_KEY secret is missing/],
    ['no Claude token', (r) => { r.secrets.delete('CLAUDE_CODE_OAUTH_TOKEN'); }, 'error', /claude setup-token/],
    ['no .gitignore line', set('.gitignore', 'dist/\n'), 'warning', /doesn't list \.factory\//],
    ['required checks', (r) => { r.branchRules = { main: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }, { type: 'pull_request', parameters: { required_approving_review_count: 1 } }] }; }, 'info', /main requires test: on a factory PR/],
    ['no review rule', (r) => { r.branchRules = {}; }, 'warning', /doesn't require an approving review/],
    ['CLA', (r) => { r.protection = { required_status_checks: { contexts: ['license/cla'] }, required_pull_request_reviews: { required_approving_review_count: 1 } }; }, 'warning', /license\/cla is required/],
    ['live', (r) => { r.variables.set('FACTORY_DRY_RUN', '0'); }, 'info', /^live/m],
    ['paused', (r) => { r.variables.set('FACTORY_PAUSED', '1'); }, 'info', /paused \(FACTORY_PAUSED is "1"\)/],
    ['in flight', (r) => { r.issues.push({ number: 7, labels: ['agent:building'] }); }, 'info', /in flight: #7/],
  ];
  for (const [name, change, level, re] of cases) assert.match(messages(await doctor(installed(change).host), level), re, name);
});

test('without admin access doctor says so and stops, instead of failing on the settings it can\'t read', async () => {
  const findings = await doctor(installed((r) => { r.admin = false; }).host);
  assert.match(messages(findings, 'error'), /no admin access/);
  assert.equal(findings.filter((f) => f.level === 'error').length, 1, messages(findings));
});

test('doctor checks the callers\' interface against the release they pin, not against this clone', async () => {
  const f = installed((r) => {
    for (const p of ['.github/workflows/factory-router.yml', '.github/workflows/factory-stage.yml']) r.branches.get('main')?.set(p, (r.branches.get('main')?.get(p) ?? '').replace('interface: 1', 'interface: 2'));
  });
  f.factory.commits = factoryWith({ [PIN]: [2, 1] }).commits;
  assert.doesNotMatch(messages(await doctor(f.host), 'error'), /interface/);
});

test('doctor names an open install PR instead of reporting its files missing', async () => {
  const f = installed((r) => {
    r.branches.get('main')?.delete('.github/factory.json');
    r.pulls.push({ number: 9, head: 'factory/install', base: 'main', title: 'Install', body: '', state: 'open' });
  });
  const findings = await doctor(f.host);
  assert.match(messages(findings, 'info'), /\.github\/factory\.json is in install PR #9, not yet merged/);
  assert.doesNotMatch(messages(findings, 'error'), /factory\.json/);
});

test('the preflight leaves out what init sets up itself', async () => {
  const f = installed((r) => {
    r.workflow.can_approve_pull_request_reviews = false;
    r.labels.clear();
    r.secrets.clear();
  });
  assert.equal(messages(await preflight(f.host), 'error'), '');
});

test('the report lists errors first, then warnings, then the rest', () => {
  const text = report([
    { level: 'info', check: 'a', message: 'three' },
    { level: 'error', check: 'b', message: 'one' },
    { level: 'warning', check: 'c', message: 'two' },
  ]);
  assert.deepEqual(text.split('\n').map((l) => l.split(' ').pop()), ['one', 'two', 'three']);
});
