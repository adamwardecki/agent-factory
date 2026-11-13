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

// What GitHub reads as "this closes that": a keyword, then (through spaces, colons and markdown emphasis) a reference.
const closesSomething = (t: string) => /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s*_:~]*(#\d|GH-\d|[\w.-]+\/[\w.-]+#\d|https?:\/\/github\.com\/\S+\/(?:issues|pull)\/\d)/i.test(t);

test('mentions and closing keywords are made inert, except inside code', () => {
  const forms = ['Fixes #12', 'closes owner/repo#34', 'Resolves https://github.com/o/r/issues/5', 'Fixes GH-5', '**Closes** #5', 'resolved: #7', 'CLOSE  #8'];
  for (const f of forms) {
    assert.ok(closesSomething(f), `${f}: the matcher knows this form`);
    assert.ok(!closesSomething(inert(`Done. ${f}. More text.`)), f);
  }
  const out = inert('Thanks @alice. See `@scope/pkg` and `Closes #5`, and:\n```\nfixes #9 by @bob\n```\nmail a@b.c');
  assert.ok(!/@alice/.test(out) && out.includes('@\u200balice'));
  assert.ok(out.includes('`@scope/pkg`') && out.includes('`Closes #5`'), 'code spans are untouched');
  assert.ok(out.includes('fixes #9 by @bob'), 'fences are untouched');
  assert.ok(out.includes('a@b.c'), 'an address is not a mention');
  for (const plain of ['Refs #12', 'The fix for #12 is here', 'closes the loop', 'See GH-5']) assert.equal(inert(plain), plain, 'a plain reference stays a link');
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
  const commit = (file: string, opts: { author?: string; link?: string; message?: string } = {}) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    if (opts.link) symlinkSync(opts.link, join(dir, file));
    else writeFileSync(join(dir, file), `${Math.random()}\n`);
    run(['add', '-A']);
    run(['commit', '-qm', opts.message ?? `change ${file}`], opts.author ? { ...bot, GIT_AUTHOR_NAME: opts.author, GIT_AUTHOR_EMAIL: 'x@example.com' } : bot);
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

test('commit messages may not close issues or add co-authors: a squash merge would carry them', () => {
  for (const message of ['Fixes #9', 'Tidy up\n\nResolves https://github.com/o/r/issues/9', 'Add thing\n\nCo-authored-by: Evil <e@example.com>', 'closes GH-3']) {
    const r = repo();
    r.commit('b.txt', { message });
    assert.throws(() => checkBundle(gitIn(r.dir), r.bundle(), r.base), /commit message/, JSON.stringify(message));
  }
  const ok = repo();
  ok.commit('b.txt', { message: 'Refs #9: tidy the parser\n\nThe fix for #9 is in the next commit.' });
  assert.doesNotThrow(() => checkBundle(gitIn(ok.dir), ok.bundle(), ok.base));
});

test('a rebase round carries commits a person already put on the branch, but nothing new from anyone else', () => {
  const maintainer = { ...process.env, GIT_AUTHOR_NAME: 'Maintainer', GIT_AUTHOR_EMAIL: 'm@example.com', GIT_COMMITTER_NAME: BOT_NAME, GIT_COMMITTER_EMAIL: BOT_EMAIL };
  const r = repo();
  r.commit('b.txt');
  // GitHub's "Commit suggestion": the maintainer is the author, and the message may carry a co-author trailer.
  writeFileSync(join(r.dir, 'c.txt'), 'suggested\n');
  r.run(['add', '-A']);
  r.run(['commit', '-qm', 'Apply suggestion\n\nCo-authored-by: Reviewer <rv@example.com>'], maintainer);
  const old = r.run(['rev-parse', 'HEAD']);
  r.run(['switch', '-q', 'main']);
  writeFileSync(join(r.dir, 'main.txt'), 'moved on\n');
  r.run(['add', '-A']);
  r.run(['commit', '-qm', 'main moves']);
  const newBase = r.run(['rev-parse', 'HEAD']);
  r.run(['switch', '-q', 'work']);
  r.run(['rebase', '-q', newBase]);
  const bundle = join(r.dir, 'rebased.bundle');
  r.run(['bundle', 'create', bundle, 'HEAD', '--not', newBase]);
  assert.throws(() => checkBundle(gitIn(r.dir), bundle, newBase), /author|Co-authored-by/, 'a build round has no such commits');
  assert.doesNotThrow(() => checkBundle(gitIn(r.dir), bundle, newBase, { carried: old }));
  // A person's commit the old head did not have is not carried, and the committer is always the bot.
  r.commit('d.txt', { author: 'Mallory' });
  const more = join(r.dir, 'more.bundle');
  r.run(['bundle', 'create', more, 'HEAD', '--not', newBase]);
  assert.throws(() => checkBundle(gitIn(r.dir), more, newBase, { carried: old }), /Mallory/);
  const stranger = repo();
  stranger.commit('b.txt');
  const oldStranger = stranger.run(['rev-parse', 'HEAD']);
  stranger.run(['commit', '--amend', '-qm', 'same tree again'], { ...process.env, GIT_AUTHOR_NAME: 'Eve', GIT_AUTHOR_EMAIL: 'eve@example.com', GIT_COMMITTER_NAME: 'Eve', GIT_COMMITTER_EMAIL: 'eve@example.com' });
  const eve = join(stranger.dir, 'eve.bundle');
  stranger.run(['bundle', 'create', eve, 'HEAD', '--not', stranger.base]);
  assert.throws(() => checkBundle(gitIn(stranger.dir), eve, stranger.base, { carried: oldStranger }), /committer|author/);
});

test('a bundle that does not build on the base, or a base that is not a SHA, is refused', () => {
  const r = repo();
  r.commit('b.txt');
  const bundle = r.bundle();
  const unrelated = r.run(['commit-tree', '-m', 'x', r.run(['write-tree'])]);
  assert.throws(() => checkBundle(gitIn(r.dir), bundle, unrelated), /base/);
  assert.throws(() => checkBundle(gitIn(r.dir), bundle, 'main'), /not a commit SHA/);
});
