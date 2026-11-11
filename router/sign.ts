// Every factory write comes from the workflow's GITHUB_TOKEN, like any other workflow in the repo, so authorship
// can't tell the factory's comments apart. The router and the publish job sign them with a per-repo key the agent
// never sees; a comment counts only if its signature checks out, which also rules out later edits.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type SigKind = 'state' | 'brief' | 'note' | 'review' | 'pr' | 'fix';
// ok: signed with this key. retired-key: well-formed, but signed with another key (FACTORY_SIGNING_KEY was rotated).
// bad: the text was changed, or the signature belongs to another issue or kind. unsigned: no signature line.
export type SigStatus = 'ok' | 'retired-key' | 'bad' | 'unsigned';

const SIG = /\n?<!-- factory:sig ([0-9a-f]{8})\.([0-9a-f]{64}) -->[ \t\r\n]*$/;

// The first 8 hex characters of the key's SHA-256. It tells "signed with a retired key" from "tampered"; it says
// nothing about the key itself.
export const keyId = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 8);

// GitHub can hand bodies back with \r\n and trailing whitespace; sign and check the same normalised text. This is
// also the body without its signature line.
export function canonical(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .replace(SIG, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function mac(key: string, issue: number, kind: SigKind, text: string): string {
  // The issue number and kind are signed too, so a brief can't be replayed on another issue or as a review.
  return createHmac('sha256', key).update(`${issue}\n${kind}\n${text}`).digest('hex');
}

export function sign(key: string, issue: number, kind: SigKind, body: string): string {
  if (key.length < 32) throw new Error('FACTORY_SIGNING_KEY must be at least 32 characters');
  const text = canonical(body);
  return `${text}\n<!-- factory:sig ${keyId(key)}.${mac(key, issue, kind, text)} -->`;
}

export function check(key: string, issue: number, kind: SigKind, body: string): SigStatus {
  const m = SIG.exec(body.replace(/\r\n/g, '\n'));
  if (!m?.[1] || !m[2]) return 'unsigned';
  if (key.length < 32) return 'bad';
  if (m[1] !== keyId(key)) return 'retired-key';
  const want = Buffer.from(mac(key, issue, kind, canonical(body)), 'hex');
  const got = Buffer.from(m[2], 'hex');
  return got.length === want.length && timingSafeEqual(got, want) ? 'ok' : 'bad';
}

export const verify = (key: string, issue: number, kind: SigKind, body: string): boolean => check(key, issue, kind, body) === 'ok';
