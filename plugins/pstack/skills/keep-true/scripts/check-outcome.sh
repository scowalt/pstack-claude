#!/usr/bin/env bash
# Runs one outcome's proof against the remote default branch and tells the
# keeper thread when the outcome breaks or holds again. Run by a bb script
# automation whose working directory is a clone of the repository.
#
# Environment: OUTCOME (slug under .agents/outcomes), KEEPER (bb thread id),
# BB_AUTOMATION_ID (set by bb). Optional: PROOF_TIMEOUT (default 600s),
# KEEP_TRUE_STATE (default ${XDG_STATE_HOME:-$HOME/.local/state}/keep-true).
set -uo pipefail

: "${OUTCOME:?OUTCOME is not set}" "${KEEPER:?KEEPER is not set}" "${BB_AUTOMATION_ID:?BB_AUTOMATION_ID is not set}"
state_dir=${KEEP_TRUE_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/keep-true}
state_file="$state_dir/$BB_AUTOMATION_ID"
mkdir -p "$state_dir"
last=$(cat "$state_file" 2>/dev/null || echo pass)

git fetch --quiet origin || { echo "git fetch origin failed in $PWD" >&2; exit 1; }
base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
sha=$(git rev-parse --short "$base") || exit 1

tmp=$(mktemp -d)
trap 'git worktree remove --force "$tmp/wt" >/dev/null 2>&1; rm -rf "$tmp"' EXIT
git worktree add --quiet --detach "$tmp/wt" "$base" || exit 1

proof=".agents/outcomes/$OUTCOME/proof"
if [ -x "$tmp/wt/$proof" ]; then
  limit=()
  command -v timeout >/dev/null && limit=(timeout "${PROOF_TIMEOUT:-600}")
  output=$(cd "$tmp/wt" && ${limit[@]+"${limit[@]}"} "./$proof" 2>&1)
  status=$?
else
  output="$proof is missing or not executable at $base ($sha)."
  status=127
fi

tell() {
  bb thread tell "$KEEPER" --mode auto --message-file - || { echo "bb thread tell $KEEPER failed" >&2; exit 1; }
}

if [ "$status" -eq 0 ]; then
  if [ "$last" = fail ]; then
    tell <<EOF
[keep-true] $OUTCOME holds again at $base ($sha). The proof passed. Follow the keep-true skill's Recovered steps.
EOF
    echo "told $KEEPER: $OUTCOME holds again"
  fi
  echo pass >"$state_file"
  exit 0
fi

if [ "$last" = pass ]; then
  tell <<EOF
[keep-true] $OUTCOME broke at $base ($sha). The proof exited $status. Follow the keep-true skill's Repair steps.

Last 100 lines of the proof's output:
\`\`\`
$(printf '%s\n' "$output" | tail -n 100)
\`\`\`
EOF
  echo "told $KEEPER: $OUTCOME broke (exit $status)"
fi
echo fail >"$state_file"
