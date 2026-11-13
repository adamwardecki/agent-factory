// What each stage's agent must hand over before the publish job writes anything. Every check here is local: a
// failed one means nothing was written, and the router counts the stage as a failed attempt, as it would a missing
// brief or PR.

import { execFileSync } from 'node:child_process';
import { BOT_EMAIL, BOT_NAME, TRIAGE_READY, TRIAGE_STOP } from './config.ts';
import { BRIEF_MARKER, FORBIDDEN_MARKERS, parseBriefTouches, parseReview } from './markers.ts';
import { oneOf } from './util.ts';

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

// GitHub refuses a comment, review or PR body over 65,536 characters; the attempt line and the signature need room.
export const MAX_TEXT = 60_000;
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

// Agent-written text, before the publish job adds anything to it.
export function checkText(text: string, file: string): string {
  if (text.trim() === '') throw new ContractError(`${file} is empty`);
  if (text.length > MAX_TEXT) throw new ContractError(`${file} is ${text.length} characters; the limit is ${MAX_TEXT}`);
  // A forged marker could pass for the publish job's own.
  const marker = FORBIDDEN_MARKERS.find((m) => text.includes(m));
  if (marker) throw new ContractError(`${file} contains the factory marker "${marker}", which only the factory writes`);
  return text;
}

const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;
const ZWSP = '​';

// What GitHub reads as "this closes that": a keyword, then (through spaces, colons and emphasis marks) a reference of
// any form: #12, GH-12, owner/repo#12, or an issue or pull URL.
const REFERENCE = '(?:#\\d|GH-\\d|[\\w.-]+\\/[\\w.-]+#\\d|https?:\\/\\/github\\.com\\/\\S+\\/(?:issues|pull)\\/\\d)';
const KEYWORD = '\\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const CLOSING = new RegExp(`${KEYWORD}[\\s*_:~]*${REFERENCE}`, 'i');
const CLOSING_KEYWORD = new RegExp(`${KEYWORD}(?=[\\s*_:~]*${REFERENCE})`, 'gi');

// Makes agent-written markdown inert: it must not notify people or close other issues when the PR merges. A
// zero-width space after "@" stops a mention, and one right after a closing keyword breaks the keyword from its
// reference, whatever form the reference takes. Code spans and fences are left alone: GitHub doesn't link inside
// them, and a brief's Touches paths live there.
export function inert(text: string): string {
  return text
    .split(CODE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/(^|[^\w/])@(?=[A-Za-z0-9])/g, `$1@${ZWSP}`)
            .replace(CLOSING_KEYWORD, `$1${ZWSP}`),
    )
    .join('');
}

const OUTCOMES = [TRIAGE_READY, ...TRIAGE_STOP] as const;
export type PlanOut = { outcome: (typeof OUTCOMES)[number]; comment: string };

export function checkPlan(outcome: string, comment: string): PlanOut {
  const o = outcome.trim();
  if (!oneOf(OUTCOMES, o)) throw new ContractError(`plan outcome must be one of ${OUTCOMES.join(', ')}, got ${JSON.stringify(o.slice(0, 40))}`);
  const text = inert(checkText(comment, 'comment.md'));
  if (o === TRIAGE_READY) {
    const touches = text.trimStart().startsWith(BRIEF_MARKER) ? parseBriefTouches(text) : null;
    if (touches === null) throw new ContractError('a ready-for-agent brief must start with the brief marker and have a Touches list that parses');
    // What gets posted is what the router reads back and compares with the risky paths.
    if (JSON.stringify(touches) !== JSON.stringify(parseBriefTouches(comment))) throw new ContractError('the Touches list must name each path in backticks');
  }
  return { outcome: o, comment: text };
}

export function checkReview(text: string): string {
  const body = inert(checkText(text, 'review.md'));
  if (parseReview(body) === null) throw new ContractError('the review must start with the factory review marker and whole counts');
  return body;
}

export function splitPr(text: string): { title: string; body: string } {
  const [first = '', ...rest] = inert(checkText(text, 'pr.md')).replace(/\r\n/g, '\n').split('\n');
  const title = first.trim();
  if (title === '' || title.length > 120) throw new ContractError('the first line of pr.md must be a title of 1 to 120 characters');
  return { title, body: rest.join('\n').trim() };
}

export type Git = (args: string[]) => string;
// No hooks, whatever the clone's config says: the publish job runs factory code only.
export const gitIn = (cwd: string): Git => (args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const SHA = /^[0-9a-f]{40}$/;
const IDENT = `${BOT_NAME} <${BOT_EMAIL}>`;
export const INCOMING = 'refs/factory/incoming';

// The agent's commits, as a bundle on top of `base`. The bundle's one ref is fetched into refs/factory/incoming of
// the publish job's clone, with object checks on, and is never checked out. Returns its tip.
// `carried` is the old head of the branch in a rebase round: a rebase keeps each commit's author and message, so
// commits whose author and message the old head already had (a maintainer's "Commit suggestion", say) are not the
// agent's and are not held to the agent's rules. Their committer is still the bot, since the rebase made it so.
export function checkBundle(git: Git, bundle: string, base: string, opts: { carried?: string | null } = {}): { tip: string } {
  const ok = (args: string[]) => {
    try {
      git(args);
      return true;
    } catch {
      return false;
    }
  };
  if (!SHA.test(base)) throw new ContractError(`the base ${JSON.stringify(base)} is not a commit SHA`);
  if (!ok(['bundle', 'verify', bundle])) throw new ContractError('the bundle does not verify against this repo');
  if (!ok(['-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '-q', bundle, `+HEAD:${INCOMING}`])) throw new ContractError('the bundle could not be read, or its objects failed the checks');
  const tip = git(['rev-parse', INCOMING]);
  if (tip === base) throw new ContractError('the bundle has no commits');
  if (!ok(['merge-base', '--is-ancestor', base, tip])) throw new ContractError(`the commits do not build on the base ${base}`);
  const range = `${base}..${tip}`;
  // A merge commit's own changes don't show in a plain log; the repo's branches are rebased, never merged.
  if (git(['rev-list', '--merges', range]) !== '') throw new ContractError('the commits include a merge commit; rebase instead');
  // Every commit, not only the final diff: GitHub rejects the whole push for one commit that touches a workflow.
  const raw = git(['log', '--format=', '--raw', '--no-abbrev', '--no-renames', range]).split('\n').filter((l) => l.startsWith(':'));
  for (const line of raw) {
    const m = /^:\d{6} (\d{6}) [0-9a-f]+ [0-9a-f]+ \w+\t(.+)$/.exec(line);
    if (!m?.[1] || !m[2]) throw new ContractError(`a commit's change list could not be read: ${line.slice(0, 80)}`);
    const [, mode, path] = m;
    if (path.startsWith('.github/') || path.startsWith('".github/')) throw new ContractError(`a commit changes ${path}; the factory never changes .github/`);
    // A symlink can make a harmless path point at a risky one, and the diff gate compares paths.
    if (mode === '120000') throw new ContractError(`a commit adds or changes the symlink ${path}; that needs a human`);
    if (mode === '160000') throw new ContractError(`a commit adds or changes the submodule ${path}; that needs a human`);
  }
  // Commit messages end up in the squash-merge message: a closing keyword would close someone else's issue when the
  // PR merges, and a Co-authored-by trailer would credit someone who did not write it. They can't be rewritten (that
  // would change the commits), so they are refused, and the agent words them again.
  const commits = (rev: string) =>
    git(['log', '--format=%an <%ae>%x01%cn <%ce>%x01%B%x00', rev])
      .split('\0')
      .filter((c) => c.trim() !== '')
      .map((c) => {
        const [author = '', committer = '', ...message] = c.replace(/^\n/, '').split('\x01');
        return { author, committer, message: message.join('\x01') };
      });
  const carried = new Set<string>();
  if (opts.carried && SHA.test(opts.carried) && ok(['cat-file', '-e', `${opts.carried}^{commit}`])) {
    for (const c of commits(opts.carried)) carried.add(`${c.author}\x01${c.message}`);
  }
  for (const c of commits(range)) {
    if (c.committer !== IDENT) throw new ContractError(`a commit's committer is ${c.committer}, not ${IDENT}`);
    if (carried.has(`${c.author}\x01${c.message}`)) continue;
    if (CLOSING.test(c.message)) throw new ContractError('a commit message contains a closing keyword for an issue or PR; say "Refs #n" instead');
    if (/^co-authored-by:/im.test(c.message)) throw new ContractError('a commit message has a Co-authored-by trailer; the factory\'s commits have one author');
    if (c.author !== IDENT) throw new ContractError(`a commit's author is ${c.author}, not ${IDENT}`);
  }
  return { tip };
}
