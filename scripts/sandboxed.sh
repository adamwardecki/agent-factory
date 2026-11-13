#!/usr/bin/env bash
# Runs one of the repo's configured commands on the checked-out PR head, for the verify job. The command is the
# branch's code (tests, package scripts), so it gets nothing of the job: a clean environment, an empty home, no
# runner temp directory (where the factory's own checkout and the job's files live), and its own PID namespace, so
# it can't read another process's environment. The filesystem is read-only apart from the workspace, /tmp and the
# home. The home is a fresh directory of its own that lasts for the whole job: install and test are separate calls,
# and what an install leaves there (pip --user, tool caches) has to be there for the test. The network stays on:
# installs need the registry.
# Usage: sandboxed.sh '<command>'
set -euo pipefail
[[ $# -eq 1 && -n "$1" ]] || { echo "usage: sandboxed.sh '<command>'" >&2; exit 2; }
: "${GITHUB_WORKSPACE:?}" "${RUNNER_TEMP:?}" "${HOME:?}"

SANDBOX_HOME="$RUNNER_TEMP/sandbox-home"
mkdir -p -m 700 "$SANDBOX_HOME"

# bwrap itself runs with an empty environment (env -i). Inside the new PID namespace, pid 1 is bwrap, and its
# /proc/1/environ is the environment it was started with: --clearenv only cleans the command it runs. Without env -i
# the command could read the whole step environment, token included, from /proc/1/environ.
# Order matters below: the home and temp directory go on first, and the workspace, which sits under the home
# on GitHub's runners, is bound back in after them.
exec env -i PATH="$PATH" bwrap \
  --ro-bind / / \
  --dev /dev \
  --proc /proc \
  --tmpfs /tmp \
  --bind "$SANDBOX_HOME" "$HOME" \
  --tmpfs "$RUNNER_TEMP" \
  --bind "$GITHUB_WORKSPACE" "$GITHUB_WORKSPACE" \
  --unshare-pid --unshare-ipc --unshare-uts \
  --new-session --die-with-parent \
  --clearenv \
  --setenv PATH "$PATH" \
  --setenv HOME "$HOME" \
  --setenv LANG C.UTF-8 \
  --setenv CI true \
  --chdir "$GITHUB_WORKSPACE" \
  bash -c "$1"
