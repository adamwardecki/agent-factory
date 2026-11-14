// The agent factory's installer. Run from a clone of agent-factory at the commit to pin:
//   node --no-warnings cli/factory.ts <command> --repo <owner/name> [flags]
// Commands: init, doctor, upgrade <sha>, rotate-key [--now], pause, resume.
// Needs Node 22.18+ and a logged-in gh with the repo and workflow scopes. The factory repo is the clone's origin
// remote unless --factory says otherwise, and init pins the clone's HEAD.

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CALLERS } from '../scripts/render-callers.ts';
import { doctor, hasErrors, report } from './doctor.ts';
import { checkRepo, type Host, realHost, repoFromRemote } from './host.ts';
import { init } from './init.ts';
import { pause, resume, rotateKey } from './keys.ts';
import { commitExists } from './repo.ts';
import { upgrade } from './upgrade.ts';

const USAGE = `usage: node --no-warnings cli/factory.ts <init|doctor|upgrade <sha>|rotate-key [--now]|pause|resume> --repo <owner/name>
  init flags, for a first .github/factory.json when the repo has none:
    --queue <login,...> --test <command> [--install <command>] [--lint <command>] [--typecheck <command>]
    [--node <version>] [--python <version>]
  init: --sweep '<cron>' (default '*/30 * * * *')
  all: --factory <owner/repo> (default: this clone's origin remote)`;

// fileURLToPath, not .pathname: a clone in a directory with a space would otherwise be `%20`.
const here = fileURLToPath(new URL('..', import.meta.url));
const gitRaw = (...args: string[]) => execFileSync('git', ['-C', here, ...args], { encoding: 'utf8' });
const git = (...args: string[]) => gitRaw(...args).trim();

export async function main(argv: string[], hostFor: (repo: string, factory: string) => Host = realHost, out: (line: string) => void = console.log): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      factory: { type: 'string' },
      queue: { type: 'string' },
      test: { type: 'string' },
      install: { type: 'string' },
      lint: { type: 'string' },
      typecheck: { type: 'string' },
      node: { type: 'string' },
      python: { type: 'string' },
      sweep: { type: 'string', default: '*/30 * * * *' },
      now: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const [command, arg] = positionals;
  if (values.help || !command || !values.repo) {
    out(USAGE);
    return values.help ? 0 : 2;
  }
  const repo = checkRepo(values.repo);
  const factory = values.factory ? checkRepo(values.factory) : repoFromRemote(git('remote', 'get-url', 'origin'));
  const h = hostFor(repo, factory);

  switch (command) {
    case 'doctor': {
      const findings = await doctor(h);
      out(report(findings));
      return hasErrors(findings) ? 1 : 0;
    }
    case 'init': {
      const ref = git('rev-parse', 'HEAD');
      // The pin has to be on GitHub, or every run of the callers fails to find it.
      if (!(await commitExists(h.factory, ref))) throw new Error(`this clone's HEAD ${ref} isn't on ${factory}; push it, or check out a release`);
      // From the commit being pinned, not the working tree: an uncommitted edit must not go into the PR.
      const templates = Object.fromEntries(CALLERS.map((name) => [name, gitRaw('show', `${ref}:templates/${name}`)]));
      const r = await init(h, {
        factoryRef: ref,
        sweep: values.sweep,
        templates,
        queue: (values.queue ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        node: values.node ?? null,
        python: values.python ?? null,
        install: values.install ?? null,
        test: values.test ?? null,
        lint: values.lint ?? null,
        typecheck: values.typecheck ?? null,
      });
      for (const line of r.done) out(`done: ${line}`);
      if (r.done.length === 0) out('done: nothing; everything was already in place');
      for (const line of r.next) out(`next: ${line}`);
      return 0;
    }
    case 'upgrade': {
      if (!arg) throw new Error('upgrade needs the commit SHA to move to');
      out((await upgrade(h, arg)).message);
      return 0;
    }
    case 'rotate-key':
      out(await rotateKey(h, values.now));
      return 0;
    case 'pause':
      out(await pause(h));
      return 0;
    case 'resume':
      out(await resume(h));
      return 0;
    default:
      out(USAGE);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
