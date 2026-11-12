import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { BOT_EMAIL, BOT_NAME } from '../router/config.ts';
import { checkBundle, checkPlan, checkReview, checkText, gitIn, inert, splitPr } from '../router/contract.ts';

const BRIEF = '<!-- factory:brief v1 -->\n## Agent Brief\n\n**Touches:**\n- `docs/a.md`\n- `packages/@scope/x.ts`';

test('a plan outcome is one of three, and a brief must parse', () => {
  assert.deepEqual(checkPlan('ready-for-agent\n', BRIEF), { outcome: 'ready-for-agent', comment: BRIEF });
  assert.deepEqual(checkPlan('needs-info', 'What browser?'), { outcome: 'needs-info', comment: 'What browser?' });
  assert.throws(() => checkPlan('ship-it', 'x'), /outcome/);
  assert.throws(() => checkPlan('ready-for-agent', 'no marker'), /brief/);
  assert.throws(() => checkPlan('needs-info', '   '), /empty/);
});

test('a review needs the marker with whole counts on its first line', () => {
  assert.equal(checkReview('<!-- factory:review {"blocking":0,"nits":2} -->\n## Standards'), '<!-- factory:review {"blocking":0,"nits":2} -->\n## Standards');
  assert.throws(() => checkReview('LGTM'), /marker/);
});

test('PR text: first line is the title', () => {
  assert.deepEqual(splitPr('Add a thing\n\nBody text.'), { title: 'Add a thing', body: 'Body text.' });
  assert.throws(() => splitPr('\nBody'), /title/);
  assert.throws(() => splitPr(`${'x'.repeat(121)}\nBody`), /title/);
});

test('agent text is refused when it is empty, too long or carries a factory marker', () => {
  assert.throws(() => checkText('', 'fix.md'), /fix\.md is empty/);
  assert.throws(() => checkText('x'.repeat(60_001), 'fix.md'), /limit/);
  for (const marker of ['<!-- factory:sig 0.0 -->', '<!-- factory:attempt abc -->', '<!-- factory:state {} -->']) {
    assert.throws(() => checkText(`Done.\n${marker}`, 'fix.md'), /factory marker/);
  }
});

test('mentions and closing keywords are made inert, except inside code', () => {
  const out = inert('Thanks @alice. Fixes #12 and closes owner/repo#34. See `@scope/pkg` and:\n```\nfixes #9 by @bob\n```\nmail a@b.c');
  assert.ok(!/@alice/.test(out) && out.includes('@​alice'));
  assert.ok(!/Fixes #12/.test(out) && out.includes('Fixes #​12'));
  assert.ok(out.includes('closes owner/repo#​34'));
  assert.ok(out.includes('`@scope/pkg`'), 'code spans are untouched');
  assert.ok(out.includes('fixes #9 by @bob'), 'fences are untouched');
  assert.ok(out.includes('a@b.c'), 'an address is not a mention');
  assert.equal(inert('Refs #12'), 'Refs #12', 'a plain reference stays a link');
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-contract-'));
  const bot = { ...process.env, GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL, GIT_COMMITTER_NAME: BOT_NAME, GIT_COMMITTER_EMAIL: BOT_EMAIL };
  const run = (args: string[], env = bot) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run(['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  run(['add', '.']);
  run(['commit', '-qm', 'base']);
  const base = run(['rev-parse', 'HEAD']);
  run(['switch', '-qc', 'work']);
  const commit = (file: string, opts: { author?: string; link?: string } = {}) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    if (opts.link) symlinkSync(opts.link, join(dir, file));
    else writeFileSync(join(dir, file), `${Math.random()}\n`);
    run(['add', '-A']);
    run(['commit', '-qm', `change ${file}`], opts.author ? { ...bot, GIT_AUTHOR_NAME: opts.author, GIT_AUTHOR_EMAIL: 'x@example.com' } : bot);
  };
  const remove = (file: string) => {
    run(['rm', '-q', file]);
    run(['commit', '-qm', `remove ${file}`]);
  };
  const bundle = () => {
    const path = join(dir, 'out.bundle');
    run(['bundle', 'create', path, 'HEAD', '--not', base]);
    run(['switch', '-q', 'main']);
    return path;
  };
  return { dir, base, run, commit, remove, bundle };
}

test('a bundle of bot commits on the base passes and is never checked out', () => {
  const r = repo();
  r.commit('b.txt');
  const { tip } = checkBundle(gitIn(r.dir), r.bundle(), r.base);
  assert.match(tip, /^[0-9a-f]{40}$/);
  assert.equal(r.run(['rev-parse', 'refs/factory/incoming']), tip);
  assert.equal(r.run(['rev-parse', 'HEAD']), r.base, 'the work tree stays on the base');
});

test('a commit that touches .github is refused even if a later commit removes it again', () => {
  const r = repo();
  r.commit('.github/workflows/x.yml');
  r.remove('.github/workflows/x.yml');
  r.commit('b.txt');
  assert.throws(() => checkBundle(gitIn(r.dir), r.bundle(), r.base), /\.github/);
});

test('symlinks, other authors and merge commits are refused', () => {
  const link = repo();
  link.commit('docs/link', { link: '../.github' });
  assert.throws(() => checkBundle(gitIn(link.dir), link.bundle(), link.base), /symlink/);
  const other = repo();
  other.commit('b.txt', { author: 'Mallory' });
  assert.throws(() => checkBundle(gitIn(other.dir), other.bundle(), other.base), /author/);
  const merged = repo();
  merged.commit('b.txt');
  merged.run(['switch', '-qc', 'side', merged.base]);
  merged.commit('c.txt');
  merged.run(['switch', '-q', 'work']);
  merged.run(['merge', '-q', '--no-ff', '-m', 'merge', 'side']);
  assert.throws(() => checkBundle(gitIn(merged.dir), merged.bundle(), merged.base), /merge commit/);
});

test('a bundle that does not build on the base, or a base that is not a SHA, is refused', () => {
  const r = repo();
  r.commit('b.txt');
  const bundle = r.bundle();
  const unrelated = r.run(['commit-tree', '-m', 'x', r.run(['write-tree'])]);
  assert.throws(() => checkBundle(gitIn(r.dir), bundle, unrelated), /base/);
  assert.throws(() => checkBundle(gitIn(r.dir), bundle, 'main'), /not a commit SHA/);
});
