#!/usr/bin/env node
// Stands in for the bb CLI (the bb harness points settings.bb.cli at it). It
// logs each call's argv and stdin to FAKE_BB_LOG and answers from the JSON
// state in FAKE_BB_STATE: { threads: { <id>: { title, status, parentThreadId,
// output } }, waitExit, spawnStatus }. A spawn adds a thread with the next id.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [command, sub, ...rest] = process.argv.slice(2);
const stdin = readFileSync(0, "utf8");
const statePath = process.env.FAKE_BB_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
appendFileSync(process.env.FAKE_BB_LOG, `${JSON.stringify({ argv: [command, sub, ...rest], stdin })}\n`);

const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const thread = (id) => ({ id, title: null, status: "idle", parentThreadId: null, ...state.threads[id] });
const save = () => writeFileSync(statePath, JSON.stringify(state));
const print = (value) => process.stdout.write(JSON.stringify(value));

if (command !== "thread") process.exit(3);
switch (sub) {
  case "show":
    print({ thread: thread(rest[0]) });
    break;
  case "spawn": {
    const id = `thr_child${Object.keys(state.threads).length}`;
    state.threads[id] = { title: opt("--title"), status: state.spawnStatus ?? "starting", parentThreadId: "thr_self", output: state.childOutput ?? "done" };
    save();
    print(thread(id));
    break;
  }
  case "wait":
    process.exit(state.waitExit ?? 0);
  case "output":
    print({ output: thread(rest[0]).output ?? null });
    break;
  case "list":
    print(Object.keys(state.threads).map(thread).filter((t) => t.parentThreadId === opt("--parent-thread")));
    break;
  case "stop":
    state.threads[rest[0]].status = "idle";
    save();
    print({ ok: true });
    break;
  case "update":
  case "tell":
    print({ ok: true, delivery: "sent" });
    break;
  default:
    process.exit(3);
}
