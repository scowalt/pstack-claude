---
name: keep-true
description: "Keep a stated outcome true after the work ships. Writes the outcome, an executable proof, and what the agent may touch into the repo, then has a bb automation run the proof on a schedule and wake this thread to repair it within those limits. Use for /keep-true, 'keep this true', 'keep X at parity', or any request that should stay done rather than get done once."
---

# Keep true

A task ends when it ships. An outcome stays true for as long as someone depends on it. This skill turns the thread that runs it into the outcome's keeper: a bb script automation runs the outcome's proof on a schedule, stays silent while the proof passes, and tells this thread when the proof fails or passes again.

This skill needs bb. If `BB_THREAD_ID` is unset, say so and stop.

## The outcome

Each outcome is a directory in the repository it concerns, `.agents/outcomes/<slug>/`, with two files:

- `proof`: an executable that exits 0 while the outcome holds and non-zero when it does not, printing the evidence. It only reads. It runs from the repository root of a fresh checkout of the remote default branch, with no secrets beyond what the bb server host already has.
- `OUTCOME.md`, in this shape:

```markdown
# <What stays true, in one sentence>

## Proof
What `proof` checks, in words, and why passing it means the sentence is true.

## Allowed
What the keeper may do without asking: the paths it may edit, whether it may merge its own PRs, which services it may call.

## Ask first
The decisions that stay with the user. Always includes changing `proof` or this file.
```

Keep the outcome a state, not a task. "Fix the login bug" is a task. "Every login error in the last hour has a tracked issue" is a state.

## Set up

1. Settle the sentence with the user. If they gave a task, propose the state it serves. Ask for what goes under **Allowed** and **Ask first** with `AskUserQuestion`, one question per decision, with a recommendation. Authority is the user's call.
2. Write `proof`. Run it and show it passing. Then show it failing: run it against a revision, fixture, or input where the outcome is false. A proof that cannot fail proves nothing. Keep its output stable between runs, with no timestamps.
3. Write `OUTCOME.md`, and land both files through the [Opening a PR](../poteto-mode/playbooks/opening-a-pr.md) playbook. The automation reads `proof` from the remote default branch, so nothing below works before the merge.
4. Make this thread easy to find: `bb thread update --self --title "Keep true: <sentence>"`.
5. Create the check. `<skill>` is this file's directory, and the schedule is the slowest one that still catches a break before it matters:

   ```bash
   bb automation create --project "$BB_PROJECT_ID" --name "keep-true: <slug>" \
     --cron "<expr>" --timezone "<IANA zone>" \
     --script-file <skill>/scripts/check-outcome.sh --interpreter bash --timeout 15m \
     --working-directory project \
     --env-json '{"OUTCOME":"<slug>","KEEPER":"'"$BB_THREAD_ID"'"}'
   ```

   `--working-directory project` needs the project's source on the bb server host. When it has none, pass the absolute path of a clone there instead.
6. Run it once with `bb automation run <id> --project "$BB_PROJECT_ID"`, and confirm with `bb automation runs <id> --project "$BB_PROJECT_ID"` that the run ended silent, which means the proof passed.
7. Optionally, have this thread look for improvements on its own. Read the provider and model from `bb thread show "$BB_THREAD_ID" --json`, then create a weekly agent automation with `--target-thread "$BB_THREAD_ID"` and the prompt `keep-true improve <slug>`.

## Repair

A `[keep-true] <slug> broke` message starts this.

1. Fetch, and rerun `proof` on the latest remote default branch. If it passes now, reply in one line and stop.
2. Find the root cause per the [Bug fix](../poteto-mode/playbooks/bug-fix.md) playbook. Start the fix on a new branch from the remote default branch.
3. Do only what **Allowed** covers. Anything under **Ask first**, or outside **Allowed**, goes to the user through `AskUserQuestion`. Then stop.
4. Never weaken `proof` or edit `OUTCOME.md` to make the check pass. That changes the outcome, and it is the user's decision.
5. Land the fix as far as **Allowed** permits. The repair is done when `proof` passes on the remote default branch.

## Recovered

A `[keep-true] <slug> holds again` message starts this. Reply in one line with what fixed it: your PR, someone else's commit, or a recovery outside the repository.

## Improve

A `keep-true improve <slug>` message starts this. Look for one change that makes the outcome harder to break or the proof catch more. Make it if **Allowed** covers it, ask if it changes `proof`, and reply "nothing worth doing" when nothing is.

## Retire

Delete the automations (`bb automation list --project "$BB_PROJECT_ID"` lists them by name) and remove the outcome directory through a PR.
