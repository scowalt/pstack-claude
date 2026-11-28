#!/usr/bin/env node
// Stands in for the bb CLI (the bb harness points settings.bb.cli at it). It
// logs each call's argv and stdin to FAKE_BB_LOG and answers from the JSON
// state in FAKE_BB_STATE: { threads: { <id>: { title, status, parentThreadId,
// output, parentNotifications } }, waitExit, spawnStatus, queued, failing,
// failFor, failTo, wakes }. A spawn adds a thread with the next id, a tell with
// --send-at adds a queued message to that thread's queue, and a command whose
// subcommand is `failing`, a `<sub> <threadId>` failTo lists as { sub: [ids] },
// or any command a process in failFor runs, fails as
// bb does with --json. As bb's scheduler would, each call first sends every
// queued message whose time has passed.
//
// wakes lists what bb would have delivered to a thread, in order: a tell, a
// queued message sent or fired, and a child's outcome its parent-notifications
// setting reports (auto: completed and failed; stuck: failed). Tests drive bb's
// side with subcommands bb does not have: `thread __set <id> <json>` changes a
// thread, `thread __fire <threadId> <messageId>` sends a queued message as its
// scheduled time would, `thread __queue <threadId> <json>` adds a row to a
// thread's queue, `thread __delete <id>` deletes a thread, after which bb
// answers 404 for it, and `thread __state <json>` changes the top-level state.
//
// The batch tracker calls this from its own process while the test does, so
// every call holds a lock over the state, and the state is replaced whole.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";

const [command, sub, ...rest] = process.argv.slice(2);
const stdin = readFileSync(0, "utf8");
const statePath = process.env.FAKE_BB_STATE;
const lock = `${statePath}.lock`;
// A call never waits long for the lock: the process holding it may have been killed with its tracker.
const lockBy = Date.now() + 5000;
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch (e) {
    // The test's world, and the state with it, is gone.
    if (e.code !== "EEXIST" || Date.now() > lockBy) process.exit(1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
}
process.on("exit", () => rmdirSync(lock));
const state = JSON.parse(readFileSync(statePath, "utf8"));
appendFileSync(process.env.FAKE_BB_LOG, `${JSON.stringify({ argv: [command, sub, ...rest], stdin })}\n`);

const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const thread = (id) => ({ id, title: null, status: "idle", parentThreadId: null, ...state.threads[id] });
const save = () => {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
  renameSync(`${statePath}.tmp`, statePath);
};
const print = (value) => process.stdout.write(JSON.stringify(value));
const fail = (message, code) => {
  print({ ok: false, error: { code, message } });
  process.exit(1);
};
const wake = (threadId, kind, extra) => state.wakes.push({ threadId, kind, ...extra });
const queuedText = (m) => m.content[0].text;

if (command !== "thread") process.exit(3);
if (state.failing === sub || state.failFor?.includes(process.ppid) || state.failTo?.[sub]?.includes(rest[0])) {
  print({ ok: false, error: { message: `fake ${sub} failure`, hint: "try again" } });
  process.exit(1);
}
state.queued ??= [];
state.wakes ??= [];
if (state.deleted?.includes(sub === "queue" ? rest[1] : rest[0])) fail("HTTP 404: Thread not found", "thread_not_found");
// As bb counts it: a failed row, else a row that is not bb's own notice.
const queuedWork = (id) => {
  const rows = state.queued.filter((m) => m.threadId === id);
  if (rows.some((m) => m.state?.startsWith("failed"))) return "failed";
  return rows.some((m) => !m.systemNotice) ? "waiting" : "none";
};
const due = state.queued.filter((m) => m.sendAt && m.sendAt <= Date.now());
for (const m of due) wake(m.threadId, "queued", { text: queuedText(m) });
if (due.length) {
  state.queued = state.queued.filter((m) => !due.includes(m));
  save();
}
switch (sub) {
  case "show":
    print({ thread: thread(rest[0]) });
    break;
  case "spawn": {
    const id = `thr_child${Object.keys(state.threads).length}`;
    state.threads[id] = {
      title: opt("--title"),
      status: state.spawnStatus ?? "starting",
      parentThreadId: "thr_self",
      output: state.childOutput ?? "done",
      parentNotifications: opt("--parent-notifications") ?? "auto",
    };
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
    print(
      Object.keys(state.threads)
        .map(thread)
        .filter((t) => t.parentThreadId === opt("--parent-thread"))
        .map((t) => ({ ...t, queuedWork: queuedWork(t.id) })),
    );
    break;
  case "stop":
    state.threads[rest[0]].status = "idle";
    save();
    print({ ok: true });
    break;
  case "update":
    if (opt("--parent-notifications")) state.threads[rest[0]].parentNotifications = opt("--parent-notifications");
    save();
    print({ ok: true, delivery: "sent" });
    break;
  case "__set": {
    const before = thread(rest[0]);
    state.threads[rest[0]] = { ...state.threads[rest[0]], ...JSON.parse(rest[1]) };
    const after = thread(rest[0]);
    const mode = after.parentNotifications ?? "auto";
    if (before.status !== after.status && after.parentThreadId) {
      if (after.status === "error" && mode !== "off") wake(after.parentThreadId, "child-failed", { child: after.id });
      if (after.status === "idle" && mode === "auto") wake(after.parentThreadId, "child-completed", { child: after.id });
    }
    save();
    break;
  }
  case "tell": {
    const sendAt = opt("--send-at");
    if (!sendAt) {
      wake(rest[0], "tell", { text: stdin });
      // bb starts an idle child's next turn at once.
      const target = state.threads[rest[0]];
      if (target?.parentThreadId && (target.status ?? "idle") === "idle") target.status = "pending";
      save();
      print({ ok: true, delivery: "sent" });
      break;
    }
    state.queuedCount = (state.queuedCount ?? 0) + 1;
    const queuedMessage = { id: `qmsg_${state.queuedCount}`, threadId: rest[0], state: "scheduled", sendAt: Date.now() + Number.parseInt(sendAt, 10) * 1000, content: [{ type: "text", text: stdin }] };
    state.queued.push(queuedMessage);
    save();
    print({ ok: true, delivery: "queued", queuedMessage });
    break;
  }
  case "__queue":
    state.queuedCount = (state.queuedCount ?? 0) + 1;
    state.queued.push({ id: `qmsg_${state.queuedCount}`, threadId: rest[0], state: "scheduled", waitingOn: { kind: "time" }, content: [{ type: "text", text: "Please continue." }], ...JSON.parse(rest[1]) });
    save();
    break;
  case "__delete":
    delete state.threads[rest[0]];
    (state.deleted ??= []).push(rest[0]);
    save();
    break;
  case "__state":
    Object.assign(state, JSON.parse(rest[0]));
    save();
    break;
  case "__fire":
  case "queue": {
    const action = sub === "__fire" ? "send" : rest[0];
    const [threadId, id] = sub === "__fire" ? rest : rest.slice(1);
    const message = state.queued.find((m) => m.id === id);
    if (action === "list") print(state.queued.filter((m) => m.threadId === threadId));
    else if (action === "delete") {
      state.queued = state.queued.filter((m) => m !== message);
      save();
      print({ ok: true });
    } else if (action === "update") {
      if (!message) fail("HTTP 404: Queued message not found");
      if (rest.includes("--message-file")) message.content = [{ type: "text", text: stdin }];
      if (opt("--send-at")) message.sendAt = Date.now() + Number.parseInt(opt("--send-at"), 10) * 1000;
      save();
      print(message);
    } else if (action === "send") {
      if (!message) fail("HTTP 404: Queued message not found");
      state.queued = state.queued.filter((m) => m !== message);
      wake(threadId, "queued", { text: queuedText(message) });
      save();
      print({ ok: true, delivery: "sent" });
    } else process.exit(3);
    break;
  }
  default:
    process.exit(3);
}
