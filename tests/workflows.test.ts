// The workflows' safety properties, read as text: who holds which permission and secret, what is pinned, what the
// caller interface is, and what the rendered caller files contain. YAML parsing would need a dependency; these are
// properties of the text.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseRepoConfig } from '../router/repo-config.ts';
import { allowedTools } from '../router/tools.ts';
import { CALLERS, callerVars, render } from '../scripts/render-callers.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const WORKFLOWS = readdirSync(new URL('../.github/workflows', import.meta.url)).map((f) => `.github/workflows/${f}`);
const ACTIONS = ['prepare', 'agent-setup', 'publish'].map((a) => `actions/${a}/action.yml`);
const SKILLS = ['plan', 'build', 'review', 'fix'].map((s) => `skills/factory-${s}/SKILL.md`);
const REUSABLE = ['router', 'stage', 'verify'].map((w) => `.github/workflows/${w}.yml`);

// One job's block in a workflow: from "  <name>:" to the next job at the same indent.
function section(yml: string, name: string): string {
  const start = yml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} not found`);
  const rest = yml.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

test('every action is pinned to a full commit SHA', () => {
  for (const f of [...WORKFLOWS, ...ACTIONS]) {
    for (const m of read(f).matchAll(/uses:\s*([^\s#]+)/g)) {
      const ref = m[1] ?? '';
      if (ref.startsWith('./')) continue;
      assert.match(ref, /@[0-9a-f]{40}$/, `${f}: ${ref}`);
    }
  }
});

test('the agent job only reads and never sees the signing key', () => {
  const agent = section(read('.github/workflows/stage.yml'), 'agent');
  assert.match(agent, /permissions: \{ contents: read, issues: read, pull-requests: read, actions: read \}/);
  assert.doesNotMatch(agent, /: write/);
  assert.doesNotMatch(agent, /FACTORY_SIGNING_KEY|signing-key/);
  assert.doesNotMatch(read('actions/agent-setup/action.yml'), /signing-key|FACTORY_SIGNING_KEY/);
  assert.match(agent, /persist-credentials: false/);
});

test('the signing key reaches only the router, prepare and publish', () => {
  const stage = read('.github/workflows/stage.yml');
  for (const job of ['prepare', 'publish']) assert.match(section(stage, job), /signing-key: \$\{\{ secrets\.FACTORY_SIGNING_KEY \}\}/, job);
  const verify = read('.github/workflows/verify.yml');
  assert.match(section(verify, 'prepare'), /signing-key/);
  for (const job of ['verify', 'report']) assert.doesNotMatch(section(verify, job), /signing-key|FACTORY_SIGNING_KEY|secrets\./, job);
});

test('the publish job runs factory code only, and the agent\'s output reaches it as data', () => {
  const publish = section(read('.github/workflows/stage.yml'), 'publish');
  assert.doesNotMatch(publish, /npm|INSTALL|claude-code-action|setup-python/);
  const action = read('actions/publish/action.yml');
  assert.match(action, /node --no-warnings \.factory-src\/router\/publish\.ts/);
  assert.doesNotMatch(action, /bash -c|npm/);
  // The immutable inputs come from prepare's job outputs, never from an artifact the agent job could replace.
  for (const input of ['attempt', 'base-sha', 'branch-sha', 'gated-sha', 'pr', 'fix-reason', 'default-branch']) {
    assert.match(publish, new RegExp(`${input}: \\$\\{\\{ needs\\.prepare\\.outputs\\.${input} \\}\\}`), input);
  }
});

test('the verify job has a read-only token, no secrets and no caches, and sandboxes every command', () => {
  const verify = section(read('.github/workflows/verify.yml'), 'verify');
  assert.match(verify, /permissions: \{ contents: read \}/);
  assert.doesNotMatch(verify, /secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN/);
  assert.doesNotMatch(verify, /cache/);
  assert.match(verify, /persist-credentials: false/);
  const commands = [...verify.matchAll(/^ {8}run: (.*)$/gm)].map((m) => m[1] ?? '').filter((r) => r.includes('$CMD'));
  assert.equal(commands.length, 4, 'install, typecheck, lint and test');
  for (const r of commands) assert.match(r, /^'"\$RUNNER_TEMP\/factory-src\/scripts\/sandboxed\.sh" "\$CMD"'$/);
  // The script is out of the workspace before the branch is checked out, so the branch can't replace it.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub expression, quoted from the workflow
  const branchCheckout = "ref: '${{ needs.prepare.outputs.gated-sha }}'";
  assert.ok(verify.indexOf('mv .factory-src "$RUNNER_TEMP/factory-src"') < verify.indexOf(branchCheckout));
  const sandbox = read('scripts/sandboxed.sh');
  // env -i: pid 1 inside the PID namespace is bwrap itself, and /proc/1/environ would show the step's environment.
  for (const flag of ['exec env -i PATH="$PATH" bwrap', '--clearenv', '--unshare-pid', '--tmpfs "$RUNNER_TEMP"', '--ro-bind / /']) assert.ok(sandbox.includes(flag), flag);
  // Install and test are separate calls: what the install puts in the home (pip --user, tool caches) must still be
  // there for the test. The home is a directory of its own that lives as long as the job, never the real one.
  assert.ok(sandbox.includes('SANDBOX_HOME="$RUNNER_TEMP/sandbox-home"'));
  assert.ok(sandbox.includes('--bind "$SANDBOX_HOME" "$HOME"'));
  assert.doesNotMatch(sandbox, /--bind "\$HOME"/);
  assert.ok(sandbox.indexOf('--bind "$SANDBOX_HOME" "$HOME"') < sandbox.indexOf('--bind "$GITHUB_WORKSPACE"'), 'the workspace is bound back in after the home');
  assert.ok(sandbox.indexOf('--tmpfs "$RUNNER_TEMP"') > sandbox.indexOf('--bind "$SANDBOX_HOME" "$HOME"'), 'the temp directory (which holds the home on the host) is hidden last');
});

test('the reusable workflows check out their own pinned commit from the job context, not from inputs', () => {
  for (const f of REUSABLE) {
    const yml = read(f);
    assert.doesNotMatch(yml, /inputs\.factory_(repo|ref)/, f);
  }
  const selfCheckouts = (f: string) => [...read(f).matchAll(/repository: '\$\{\{ job\.workflow_repository \}\}', ref: '\$\{\{ job\.workflow_sha \}\}'/g)].length;
  assert.equal(selfCheckouts('.github/workflows/router.yml'), 1);
  assert.equal(selfCheckouts('.github/workflows/stage.yml'), 3);
  assert.equal(selfCheckouts('.github/workflows/verify.yml'), 2);
});

test('git is set up for the agent with the bot identity and no interactive editor', () => {
  const setup = read('actions/agent-setup/action.yml');
  assert.match(setup, /git config user\.name 'github-actions\[bot\]'/);
  assert.match(setup, /git config user\.email '41898282\+github-actions\[bot\]@users\.noreply\.github\.com'/);
  assert.match(setup, /git config core\.editor true/, 'git rebase --continue must not open an editor');
  assert.match(setup, /mkdir -p \.factory\/out/, 'git bundle create does not make its directory');
});

test('every rule in a skill carries its reason', () => {
  for (const p of SKILLS) {
    const text = read(p);
    const start = text.indexOf('## Rules');
    assert.ok(start >= 0, `${p} has a Rules section`);
    const end = text.indexOf('\n## ', start + 1);
    const rules = text.slice(start, end === -1 ? undefined : end).split(/\n(?=- )/).slice(1);
    assert.ok(rules.length >= 3, p);
    for (const rule of rules) assert.match(rule, /Why:/, `${p}: "${rule.slice(0, 60)}" has no Why`);
  }
});

test('packages are installed only when missing, and apt never starts with an update', () => {
  for (const f of [...WORKFLOWS, ...ACTIONS]) {
    const lines = read(f).split('\n');
    const code = lines.filter((l) => !l.trim().startsWith('#'));
    assert.ok(!code.some((l) => l.includes('apt-get update')), `${f}: apt-get update hung for minutes on mirror DNS failures`);
    // The install has a timeout: in a workflow, on its step, a few lines above the command; in a composite action,
    // whose steps can't take timeout-minutes, on the command itself.
    const composite = f.startsWith('actions/');
    lines.forEach((l, n) => {
      if (l.includes('apt-get install') && !l.trim().startsWith('#')) {
        const timed = composite ? /\btimeout \d+ apt-get install/.test(l) : lines.slice(Math.max(0, n - 6), n).some((x) => x.includes('timeout-minutes: 5'));
        assert.ok(timed, `${f}:${n + 1}: an apt install needs a timeout`);
      }
    });
  }
  assert.match(read('.github/workflows/verify.yml'), /command -v bwrap >\/dev\/null \|\| sudo/);
});

test('the router can mark a PR ready, and checks out only the factory repo', () => {
  const route = section(read('.github/workflows/router.yml'), 'route');
  assert.match(route, /permissions: \{ contents: write, issues: write, pull-requests: write, actions: write \}/);
  const checkouts = [...route.matchAll(/uses: actions\/checkout@[^\n]*\n\s+with: ([^\n]*)/g)].map((m) => m[1] ?? '');
  assert.equal(checkouts.length, 1);
  assert.match(checkouts[0] ?? '', /repository: '\$\{\{ job\.workflow_repository \}\}'/, 'never the target repo, whose code an agent wrote');
  const caller = render(read('templates/factory-router.yml'), vars);
  assert.match(caller, /permissions:\n {2}contents: write\n/, 'a reusable workflow gets at most what its caller grants');
});

test('the report job can only read and dispatch', () => {
  // gh workflow run looks up the default branch first, which needs contents: read (sandbox trial, verify run 1).
  assert.match(section(read('.github/workflows/verify.yml'), 'report'), /permissions: \{ contents: read, actions: write \}/);
});

test('no workflow asks for an OIDC token in this release', () => {
  for (const f of [...WORKFLOWS, ...ACTIONS, ...CALLERS.map((c) => `templates/${c}`)]) assert.doesNotMatch(read(f), /id-token/, f);
});

test('the router serialises per repo, and its trigger filter names no login', () => {
  const router = read('.github/workflows/router.yml');
  assert.match(router, /concurrency: \{ group: 'factory-router-\$\{\{ github\.repository \}\}', cancel-in-progress: false, queue: max \}/);
  assert.doesNotMatch(router, /workflow_run/, 'workflow_run never fires for runs GITHUB_TOKEN dispatched');
  assert.doesNotMatch(router, /github\.actor == '/);
  for (const command of ['/approve', '/stop', '/retry']) assert.ok(router.includes(`startsWith(github.event.comment.body, '${command}')`), command);
  assert.match(router, /FACTORY_PAUSED: \$\{\{ inputs\.paused \}\}/);
});

// The caller interface: the names and required flags of each reusable workflow's inputs and secrets. Within one
// interface version an input may only be added, and only as optional. Changing this snapshot any other way needs a
// new interface number, a major version, and upgrade notes.
const INTERFACE_1: Record<string, string[]> = {
  router: ['interface!', 'dry_run', 'paused', 'FACTORY_SIGNING_KEY!'],
  stage: ['interface!', 'stage!', 'issue!', 'attempt!', 'paused', 'FACTORY_SIGNING_KEY!', 'CLAUDE_CODE_OAUTH_TOKEN!'],
  verify: ['interface!', 'issue!', 'attempt!', 'FACTORY_SIGNING_KEY!'],
};

test('the reusable workflows keep caller interface 1', () => {
  for (const f of REUSABLE) {
    const yml = read(f);
    const call = yml.slice(yml.indexOf('workflow_call:'), yml.indexOf('\njobs:'));
    const names = [...call.matchAll(/^ {6}(\w+): \{ (?:type: \w+, )?required: (true|false)/gm)].map((m) => `${m[1]}${m[2] === 'true' ? '!' : ''}`);
    const name = f.replace(/^.*\/(\w+)\.yml$/, '$1');
    assert.deepEqual(names, INTERFACE_1[name], f);
    assert.match(yml, /\[\[ "\$INTERFACE" == "1" \]\]/, `${f} checks the interface it was called with`);
  }
});

const vars = callerVars('adamwardecki/agent-factory', 'a'.repeat(40), '*/30 * * * *');

test('the rendered stage caller pins one commit everywhere and passes the attempt through', () => {
  const stage = render(read('templates/factory-stage.yml'), vars);
  assert.equal(stage.match(/a{40}/g)?.length, 2, 'one pin per job, and nothing else to keep in step with it');
  assert.match(stage, /run-name: 'factory-\$\{\{ inputs\.stage \}\} #\$\{\{ inputs\.issue \}\} \$\{\{ inputs\.attempt \}\}'/);
  assert.equal(stage.match(/group: 'factory-stage-\$\{\{ inputs\.issue \}\}', cancel-in-progress: false/g)?.length, 2);
  assert.match(section(stage, 'stage'), /if: inputs\.stage != 'verify'/);
  assert.match(section(stage, 'verify'), /if: inputs\.stage == 'verify'/);
  assert.doesNotMatch(section(stage, 'verify'), /CLAUDE_CODE_OAUTH_TOKEN/, 'verify never gets the Claude credential');
  assert.equal(stage.match(/interface: 1/g)?.length, 2);
  assert.doesNotMatch(stage, /\$\$\{|[^$]\{factory/);
});

test('the rendered router caller accepts reports, has no workflow_run trigger, and names no login', () => {
  const router = render(read('templates/factory-router.yml'), vars);
  assert.doesNotMatch(router, /workflow_run/);
  assert.equal(router.match(/a{40}/g)?.length, 1);
  for (const input of ['report_stage', 'report_issue', 'report_attempt', 'report_run_id', 'report_result']) assert.ok(router.includes(`${input}:`), input);
  assert.match(router, /cron: '\*\/30 \* \* \* \*'/);
  assert.match(router, /router\.yml@a{40}/);
  assert.match(router, /paused: \$\{\{ vars\.FACTORY_PAUSED \}\}/);
  assert.doesNotMatch(router, /github\.actor/);
});

test('the render script refuses a moving ref and unknown variables', () => {
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: templatefile() syntax under test
  assert.equal(render('a ${x} $${{ z }}', { x: '1' }), 'a 1 ${{ z }}');
  assert.throws(() => render('${missing}', {}), /unknown variable/);
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: templatefile() syntax under test
  assert.throws(() => callerVars('adamwardecki/agent-factory', 'v1.0.0', '*/30 * * * *'), /commit SHA/);
  assert.throws(() => callerVars('not a repo', 'a'.repeat(40), '*/30 * * * *'), /owner\/repo/);
  assert.throws(() => callerVars('o/r', 'a'.repeat(40), 'hourly'), /cron/);
});

test('skills never ask for command substitution or a write to GitHub', () => {
  for (const p of SKILLS) {
    const text = read(p);
    assert.doesNotMatch(text, /\$\(/, `${p}: headless runs refuse command substitution`);
    assert.doesNotMatch(text, /gh (issue comment|issue edit|pr create|pr review|pr comment)|git push|git fetch origin/, p);
  }
});

test('every git subcommand the build and fix skills use is one the agent is allowed to run', () => {
  const config = parseRepoConfig({ version: 1, roles: { queue: ['alice'] }, commands: { test: 'make test' } });
  for (const stage of ['build', 'fix'] as const) {
    const tools = allowedTools(stage, config);
    const used = [...read(`skills/factory-${stage}/SKILL.md`).matchAll(/`git ([a-z-]+)/g)].map((m) => m[1] ?? '');
    assert.ok(used.length > 0, stage);
    for (const sub of used) assert.ok(tools.includes(`Bash(git ${sub}:*)`), `${stage}: the skill runs git ${sub}, which the agent may not`);
  }
});

test('skills name no package manager, default branch or repo of their own', () => {
  for (const p of SKILLS) {
    assert.doesNotMatch(read(p), /\bnpm\b|\bpnpm\b|\byarn\b|\bpip\b|origin\/main|\bmain\b|create-pr|job-tracker|plugin\/|docs\/factory\.md|adamwardecki/i, p);
  }
});

test('the write identity is named in one place', () => {
  for (const f of readdirSync(new URL('../router', import.meta.url))) {
    if (f === 'config.ts') continue;
    assert.doesNotMatch(read(`router/${f}`), /github-actions\[bot\]'|41898282/, `router/${f}: use the constants in config.ts`);
  }
});

test('the last job of a stage run reports unless the run itself was cancelled', () => {
  // The router cancels the run of an attempt it has left; a report from that run would be about nothing. A job that
  // timed out is not a cancelled run, so its report still goes out.
  for (const f of ['.github/workflows/stage.yml', '.github/workflows/verify.yml']) {
    const yml = read(f);
    assert.doesNotMatch(yml, /always\(\)/, f);
    assert.match(yml, /if: \$\{\{ !cancelled\(\) && needs\.prepare\.result == 'success' \}\}/, f);
  }
});

test('composite action steps use only the keys a composite action supports', () => {
  // GitHub refuses to load a composite action with a job-step-only key such as timeout-minutes (sandbox trial, run 1).
  const allowed = new Set(['name', 'id', 'if', 'run', 'shell', 'uses', 'with', 'env', 'working-directory', 'continue-on-error']);
  for (const f of ['actions/prepare/action.yml', 'actions/agent-setup/action.yml', 'actions/publish/action.yml']) {
    const steps = read(f).split(/^ {4}- /m).slice(1);
    for (const step of steps) {
      const keys = [...`  ${step}`.matchAll(/^ {6}([a-z-]+):/gm)].map((m) => m[1] ?? '');
      for (const k of keys) assert.ok(allowed.has(k), `${f}: ${k}`);
    }
  }
});

test('agent-setup uses no action with a post step: its directory has left the workspace by then', () => {
  // The runner reads a composite action's action.yml again for its post steps. The agent job moves .factory-src out
  // before Claude starts, so a nested setup-node there failed the job after Claude had finished (sandbox trial, run 2).
  const uses = [...read('actions/agent-setup/action.yml').matchAll(/uses: ([^@\s]+)@/g)].map((m) => m[1]);
  assert.deepEqual(uses, ['actions/download-artifact']);
  const stage = read('.github/workflows/stage.yml');
  const at = (s: string) => stage.indexOf(s);
  for (const setup of ['actions/setup-node@', 'actions/setup-python@']) {
    assert.ok(at(setup) > 0 && at(setup) < at('uses: ./.factory-src/actions/agent-setup'), `${setup} runs in the job, before agent-setup's install`);
  }
});

test('Claude Code adds no co-author trailer to the agent\'s commits, and the skills say why', () => {
  // Claude Code's default attribution adds a Co-Authored-By trailer, which the publish job refuses (sandbox trial,
  // build run 1). Both settings: `attribution` is the current one, `includeCoAuthoredBy` the older one.
  const stage = read('.github/workflows/stage.yml');
  const settings = /settings: \$\{\{ inputs\.stage == 'plan' && '(.+)' \|\| '(.+)' \}\}/.exec(stage);
  assert.ok(settings?.[1] && settings[2], 'settings depend on the stage');
  const plan = JSON.parse(settings[1]);
  const other = JSON.parse(settings[2]);
  for (const s of [plan, other]) {
    assert.deepEqual(s.attribution, { commit: '', pr: '' });
    assert.equal(s.includeCoAuthoredBy, false);
  }
  // The planner reads the issue with gh. Build and fix run the repo's tests, which have network: the job's token must
  // not be in their environment (sandbox trial, containment probe). Review needs no gh either.
  assert.equal(plan.env, undefined);
  assert.deepEqual(other.env, { GITHUB_TOKEN: '', GH_TOKEN: '' });
  for (const skill of ['skills/factory-build/SKILL.md', 'skills/factory-fix/SKILL.md']) {
    assert.match(read(skill), /no Co-authored-by trailer/, skill);
  }
});
