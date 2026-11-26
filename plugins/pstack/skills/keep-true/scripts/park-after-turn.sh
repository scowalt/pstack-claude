#!/usr/bin/env bash
# Parks the calling bb thread once its current turn ends, so it leaves the
# Active shelf until its next message. Parking during the turn doesn't stick:
# the turn's own reply is new activity and returns the thread to Active.
set -euo pipefail

: "${BB_THREAD_ID:?park-after-turn needs bb}"
setsid nohup sh -c 'bb thread wait "$BB_THREAD_ID" --timeout 2h && bb sidebar park --thread "$BB_THREAD_ID"' \
  </dev/null >/dev/null 2>&1 &
