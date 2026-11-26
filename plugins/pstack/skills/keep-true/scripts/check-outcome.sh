#!/usr/bin/env bash
# Runs one outcome's proof against the remote default branch. When the outcome
# breaks, it opens a new repair thread in the project. When the outcome holds
# again, it tells that repair thread, if it still exists. Run by a bb script
# automation whose working directory is a clone of the repository.
#
# Environment: OUTCOME (slug under .agents/outcomes), BB_PROJECT_ID and
# BB_AUTOMATION_ID (set by bb). Optional: PROOF_TIMEOUT (default 600s),
# KEEP_TRUE_STATE (default ${XDG_STATE_HOME:-$HOME/.local/state}/keep-true).
set -uo pipefail

: "${OUTCOME:?OUTCOME is not set}" "${BB_PROJECT_ID:?BB_PROJECT_ID is not set}" "${BB_AUTOMATION_ID:?BB_AUTOMATION_ID is not set}"
state_dir=${KEEP_TRUE_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/keep-true}
state_file="$state_dir/$BB_AUTOMATION_ID"
mkdir -p "$state_dir"
read -r last repair 2>/dev/null <"$state_file" || true
last=${last:-pass}
repair=${repair:-}

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

if [ "$status" -eq 0 ]; then
  if [ "$last" = fail ]; then
    if [ -n "$repair" ] && bb thread tell "$repair" --mode auto --message-file - <<EOF
[keep-true] $OUTCOME holds again at $base ($sha). The proof passed. Follow the keep-true skill's Recovered steps.
EOF
    then
      echo "told $repair: $OUTCOME holds again"
    else
      echo "$OUTCOME holds again at $base ($sha); its repair thread ${repair:-(none)} is gone"
    fi
  fi
  echo pass >"$state_file"
  exit 0
fi

if [ "$last" = pass ]; then
  spawned=$(bb thread spawn --project "$BB_PROJECT_ID" --new-environment worktree \
    --title "keep-true: $OUTCOME broke" --json --prompt-file - <<EOF
[keep-true] $OUTCOME broke at $base ($sha). The proof exited $status. Follow the keep-true skill's Repair steps for .agents/outcomes/$OUTCOME.

Last 100 lines of the proof's output:
\`\`\`
$(printf '%s\n' "$output" | tail -n 100)
\`\`\`
EOF
  ) || { echo "bb thread spawn failed" >&2; exit 1; }
  repair=$(printf '%s' "$spawned" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | cut -d '"' -f 4)
  echo "opened ${repair:-a repair thread}: $OUTCOME broke (exit $status)"
fi
echo "fail $repair" >"$state_file"
