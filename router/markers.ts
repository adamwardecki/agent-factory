// The text formats the factory reads back from GitHub: the router's state comment, the planner's brief, the
// reviewer's verdict and the maintainer's slash commands.

import { ATTEMPT, RUN_WORKFLOWS, type RunWorkflow, STAGES, STATE_VERSION, type Stage } from './config.ts';
import { isRecord, oneOf } from './util.ts';

export const FIX_REASONS = ['ci', 'review', 'maintainer', 'rebase'] as const;
export type FixReason = (typeof FIX_REASONS)[number];

// Why an issue is blocked; /retry picks its way back in from this. 'human' is a planner that asked for one; 'no-pr'
// is a verify, review or fix round with no PR whose diff the gate could check; 'key-rotated' is state signed with a
// signing key that was replaced, which only a fresh agent:queued label restarts.
export const BLOCK_REASONS = ['rounds', 'rebases', 'attempts', 'stuck', 'stop', 'human', 'no-pr', 'key-rotated', 'credential'] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const COMMANDS = ['approve', 'stop', 'retry'] as const;
export type Command = (typeof COMMANDS)[number];

// Where an issue goes once a risky diff is approved: what the diff gate stopped it from entering.
export const AFTER_APPROVAL = ['verify', 'review', 'fix', 'ready'] as const;
export type AfterApproval = (typeof AFTER_APPROVAL)[number];

export type FactoryState = {
  stage: Stage;
  since: string; // ISO time the current stage began
  round: number; // fix rounds counted toward MAX_ROUNDS (CI and reviewer)
  attempts: number; // failed runs of the current stage
  failedAt?: string;
  pr?: number;
  brief?: number; // comment id of the brief the later stages work from
  approvalFor?: 'plan' | 'diff';
  approvedTouches?: string[]; // the Touches of the plan the maintainer approved; diff paths under them need no approval
  approvalSha?: string; // PR head whose risky files the open diff approval request lists
  approvedSha?: string; // PR head the maintainer approved; the diff gate is skipped until the head moves
  afterApproval?: AfterApproval;
  ciRun?: string; // URL of the latest CI run the router acted on; the fixer reads its log
  blockedFrom?: Stage;
  blockedFor?: BlockReason;
  rebases?: number; // rebases since the PR last reached ready any other way (MAX_REBASES)
  headSha?: string; // PR head when the fixer was dispatched; unchanged after it means it pushed nothing
  gatedSha?: string; // PR head the diff gate checked when it let review or fix run; the stage runs on no other
  fixReason?: FixReason;
  queuedBy?: string; // who added agent:queued; asked to review when the PR is ready
  attempt?: string; // id of the current entry into a stage that runs a workflow; only this attempt may publish
  verifiedSha?: string; // PR head the verify stage last passed on; review and ready need the head to be this one
  resume?: RunWorkflow; // for a waiting issue: the workflow it was about to run when no slot was free
  runs: string[];
};

// Markers count only at the top of the body. The bot's comments can quote attacker-influenced text (a review
// quoting the diff), and a marker inside that quote must not stand in for the real one.
const STATE_RE = /^\s*<!-- factory:state (\{.*?\}) -->/s;
const REVIEW_RE = /^\s*<!-- factory:review (\{.*?\}) -->/s;
export const BRIEF_MARKER = '<!-- factory:brief v1 -->';

function json(re: RegExp, body: string): unknown {
  const m = re.exec(body);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1] ?? '');
  } catch {
    return undefined;
  }
}

export function renderState(s: FactoryState): string {
  const pr = s.pr ? ` · PR #${s.pr}` : '';
  const runs = s.runs.length ? `\n\nRuns: ${s.runs.map((u, i) => `[${i + 1}](${u})`).join(' ')}` : '';
  // Escape < and > so a field holding `-->` cannot end the comment early and leave the rest as visible text.
  const data = JSON.stringify({ v: STATE_VERSION, ...s }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<!-- factory:state ${data} -->\nFactory: **${s.stage}**${pr} · fix round ${s.round}${runs}`;
}

// Counters and ids are whole numbers; a fractional or negative one means the comment was not written by renderState.
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const id = (v: unknown): v is number => count(v) && v > 0;
// An empty head would match a PR snapshot whose head failed to load, and skip the diff gate.
const sha = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const attempt = (v: unknown): v is string => typeof v === 'string' && ATTEMPT.test(v);

// The version a state comment was written with: 1 when it names none. null when the body is not a state comment.
export function stateVersion(body: string): number | null {
  const v = json(STATE_RE, body);
  if (!isRecord(v)) return null;
  return count(v.v) && v.v > 0 ? v.v : 1;
}

export function parseState(body: string): FactoryState | null {
  const v = json(STATE_RE, body);
  // A state written by a newer release may mean something this one doesn't know; the router leaves it alone.
  if (isRecord(v) && count(v.v) && v.v > STATE_VERSION) return null;
  // Every age check reads since; one that does not parse would leave the issue never retried and never stuck.
  if (!isRecord(v) || !oneOf(STAGES, v.stage) || !isTime(v.since)) return null;
  if (!count(v.round) || !count(v.attempts) || !Array.isArray(v.runs)) return null;
  const s: FactoryState = {
    stage: v.stage,
    since: v.since,
    round: v.round,
    attempts: v.attempts,
    runs: v.runs.filter((r): r is string => typeof r === 'string'),
  };
  if (isTime(v.failedAt)) s.failedAt = v.failedAt;
  if (id(v.pr)) s.pr = v.pr;
  if (id(v.brief)) s.brief = v.brief;
  if (v.approvalFor === 'plan' || v.approvalFor === 'diff') s.approvalFor = v.approvalFor;
  if (Array.isArray(v.approvedTouches)) s.approvedTouches = v.approvedTouches.filter((t): t is string => typeof t === 'string');
  if (sha(v.approvalSha)) s.approvalSha = v.approvalSha;
  if (sha(v.approvedSha)) s.approvedSha = v.approvedSha;
  if (oneOf(AFTER_APPROVAL, v.afterApproval)) s.afterApproval = v.afterApproval;
  if (typeof v.ciRun === 'string') s.ciRun = v.ciRun;
  if (oneOf(STAGES, v.blockedFrom)) s.blockedFrom = v.blockedFrom;
  if (oneOf(BLOCK_REASONS, v.blockedFor)) s.blockedFor = v.blockedFor;
  if (count(v.rebases)) s.rebases = v.rebases;
  if (sha(v.headSha)) s.headSha = v.headSha;
  if (sha(v.gatedSha)) s.gatedSha = v.gatedSha;
  if (oneOf(FIX_REASONS, v.fixReason)) s.fixReason = v.fixReason;
  if (typeof v.queuedBy === 'string' && v.queuedBy !== '') s.queuedBy = v.queuedBy;
  if (attempt(v.attempt)) s.attempt = v.attempt;
  if (sha(v.verifiedSha)) s.verifiedSha = v.verifiedSha;
  if (oneOf(RUN_WORKFLOWS, v.resume)) s.resume = v.resume;
  return s;
}

const TOUCHES = '**touches:**';
// The attempt and signature lines the publish job adds after the brief end the section too. Agent text can't
// contain them: the publish job refuses it.
const SECTION_END = /^\s*(?:#|\*\*[^*]+:\*\*|<!-- factory:(?:attempt|sig) )/;
const BULLET = /^\s*[-*]\s+(.*)$/;

// The bulleted paths under "**Touches:**" in the brief's Factory block, up to the next heading or bold label. null
// when the marker or the heading is missing, the heading appears twice, or the section holds anything but bullets:
// the router treats that as a planner that broke its contract. Dropping a line it could not read would let a risky
// path slip past the approval check.
export function parseBriefTouches(body: string): string[] | null {
  if (!body.trimStart().startsWith(BRIEF_MARKER)) return null;
  const lines = body.split('\n');
  const headings = lines.flatMap((l, i) => (l.trim().toLowerCase() === TOUCHES ? [i] : []));
  const [start] = headings;
  if (start === undefined || headings.length > 1) return null;
  const touches: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (SECTION_END.test(line)) break;
    if (line.trim() === '') continue;
    const item = BULLET.exec(line)?.[1]?.trim();
    if (!item) return null;
    // Every backticked path in the bullet counts, so `- \`docs/x.md\` and \`plugin/hooks/y.ts\`` cannot hide the
    // second one; a bullet without backticks names its path first and may add a note after it (`- b.ts: tests`),
    // whose trailing punctuation would otherwise turn `plugin/hooks:` into a path no glob matches.
    const quoted = [...item.matchAll(/`([^`]+)`/g)].map((m) => m[1]?.trim() ?? '').filter((p) => p !== '');
    const first = item.split(/\s+/)[0] ?? '';
    touches.push(...(quoted.length ? quoted : [first.replace(/[:,;]$/, '')]));
  }
  return touches;
}

export type ReviewMarker = { blocking: number; nits: number; sha: string | null; attempt: string | null };

// The reviewer writes the counts; the publish job adds the commit it reviewed and the attempt (stampReview).
export function parseReview(body: string): ReviewMarker | null {
  const v = json(REVIEW_RE, body);
  if (!isRecord(v) || !count(v.blocking)) return null;
  return { blocking: v.blocking, nits: count(v.nits) ? v.nits : 0, sha: sha(v.sha) ? v.sha : null, attempt: attempt(v.attempt) ? v.attempt : null };
}

// Rewrites the review's marker with the reviewed commit and the attempt. Whatever sha or attempt the agent wrote in
// its own marker is dropped: only the publish job knows them.
export function stampReview(body: string, reviewedSha: string, attemptId: string): string | null {
  const r = parseReview(body);
  if (!r) return null;
  const marker = `<!-- factory:review ${JSON.stringify({ blocking: r.blocking, nits: r.nits, sha: reviewedSha, attempt: attemptId })} -->`;
  return body.replace(REVIEW_RE, marker);
}

// The line the publish job puts at the end of everything else it posts (brief, planner note, PR body, fix comment),
// just above the signature. It ties the text to the attempt that produced it.
const ATTEMPT_LINE = /(?:^|\n)<!-- factory:attempt ([0-9a-z]{1,16}) -->[ \t\r\n]*(?:<!-- factory:sig [0-9a-f.]+ -->[ \t\r\n]*)?$/;
export const withAttempt = (body: string, attemptId: string): string => `${body.replace(/\s+$/, '')}\n<!-- factory:attempt ${attemptId} -->`;
export function attemptOf(body: string): string | null {
  return ATTEMPT_LINE.exec(body.replace(/\r\n/g, '\n'))?.[1] ?? null;
}

// Agent-written text must not carry the factory's own markers: a forged one could pass for the publish job's.
export const FORBIDDEN_MARKERS = ['factory:sig', 'factory:attempt', 'factory:state'] as const;

export function parseCommand(body: string): Command | null {
  // The word must end at whitespace or the end of the comment: `\b` would read `/approve-not-yet` as an approval.
  const word = /^\/([a-z]+)(?=\s|$)/.exec(body.trim())?.[1];
  return oneOf(COMMANDS, word) ? word : null;
}
