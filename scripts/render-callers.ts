// Renders templates/*.yml for a target repo. The templates use Terraform's templatefile() syntax, so the optional
// Terraform module can render the same files later: ${var} is a variable, and $${ is a literal ${ (GitHub's own
// expressions). Nothing else is supported.
// Usage: node --no-warnings scripts/render-callers.ts <owner/repo of agent-factory> <factory_ref sha> <cron> <out dir>

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CALLERS = ['factory-router.yml', 'factory-stage.yml'] as const;

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\$\{|\$\{(\w+)\}/g, (m, name: string | undefined) => {
    if (m === '$${') return '${';
    const v = vars[name ?? ''];
    if (v === undefined) throw new Error(`unknown variable ${name}`);
    return v;
  });
}

export function callerVars(factoryRepo: string, factoryRef: string, sweepCron: string): Record<string, string> {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(factoryRepo)) throw new Error(`not an owner/repo: ${factoryRepo}`);
  // A full SHA, never a tag or branch: a moved ref must not change what runs.
  if (!/^[0-9a-f]{40}$/.test(factoryRef)) throw new Error('factory_ref must be a 40-character commit SHA');
  if (!/^[0-9*/,-]+( [0-9*/,-]+){4}$/.test(sweepCron)) throw new Error(`not a cron expression: ${sweepCron}`);
  return { factory_repo: factoryRepo, factory_ref: factoryRef, sweep_cron: sweepCron };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [repo, ref, cron, outDir] = process.argv.slice(2);
  if (!repo || !ref || !cron || !outDir) throw new Error('usage: render-callers.ts <owner/repo of agent-factory> <factory_ref sha> <cron> <out dir>');
  const vars = callerVars(repo, ref, cron);
  mkdirSync(outDir, { recursive: true });
  for (const f of CALLERS) writeFileSync(join(outDir, f), render(readFileSync(new URL(`../templates/${f}`, import.meta.url), 'utf8'), vars));
}
