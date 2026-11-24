// A batch: the background agents one response starts with batch: true. Each
// starts on bb's stuck parent notifications, so a failure or a question still
// wakes the parent at once and a finished turn does not. The parent's wake for
// the batch is one message bb holds in the parent's queue, scheduled a few
// minutes out. A tracker, a detached process started with that message, pushes
// its time back while the batch is open. When every agent has finished, or the
// bound after the first finished has passed, it writes their results into the
// message, hands every agent back to bb's usual notices, and sends it. bb sends
// a held message at most once, so a second tracker or the scheduled time firing
// cannot wake the parent twice. A tracker that dies stops pushing the time
// back, so the message fires on its own, and the tracker the parent's next run
// starts hands the agents back. The tracker runs in a systemd scope of its own
// where there is one, since bb's service stops every process in its cgroup each
// time it restarts.
//
// The parent alone writes a batch's record; each tracker writes only its lease
// file beside it, with its pid and the time it last reached bb.
//
// Plain JavaScript, so node runs the tracker on its own: node bb-batch.mjs <record>.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BbCli, RUNNING, TRACKER_CALL_TIMEOUT_MS, resultText } from "./bb-cli.mjs";

// staleMs: a tracker that has not reached bb for this long is replaced. It
// covers a heartbeat plus one bb call the tracker kills at its timeout.
// boundMs: once one agent has finished, the batch waits this long for the rest
// before it reports the finished ones. Of 172 groups of idle siblings bb
// started within two minutes of each other (Nov 2026), the last's final update
// came within 16 minutes of the first's in 9 in 10 and within 34 in 19 in 20,
// so 30 minutes rarely cuts a batch short.
export const DEFAULT_TIMING = { pollMs: 5000, heartbeatMs: 120_000, deadlineS: 600, staleMs: 180_000, boundMs: 1_800_000 };

const TRACKER = fileURLToPath(import.meta.url);
const FROM_PSTACK = "This message comes from pstack's agent tool, not from the user.";
const FALLBACK =
  "[pstack batch] pstack's batch tracker sends this notice only if it stops before every agent of a batch this thread started has finished. Otherwise it replaces it with all of their reports. Agents of the batch still running now report to you one by one, as bb's usual notices. Call list_agents for their status, and `bb thread output <id>` for a finished one's report." +
  `\n\n${FROM_PSTACK}`;

const STATUS = { idle: "completed", error: "failed" };

// systemd's user manager starts a command in a new scope and then runs it in
// place, so the tracker keeps the pid it was started with.
const SCOPE = ["--user", "--scope", "--collect", "--quiet", "--description=pstack batch tracker"];
const hasScopes = () => spawnSync("systemd-run", [...SCOPE, "true"], { stdio: "ignore", timeout: 5000 }).status === 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeJson(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function readLease(path) {
  try {
    return readJson(`${path}.tracker`);
  } catch {
    return undefined;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The parent's side: records the batch of the current response, seals it when
// the response's tool calls are done, and keeps a live tracker on each batch.
export class Batches {
  // The record of the batch this response is starting, once its first agent asks for one.
  current;
  writes = Promise.resolve();

  constructor({ cli, threadId, dir, timing = DEFAULT_TIMING }) {
    this.bb = new BbCli(cli);
    this.cli = cli;
    this.threadId = threadId;
    this.dir = dir;
    this.timing = timing;
  }

  // Starts an agent as a member of this response's batch. The held message
  // and its tracker exist before the agent does, so no member is ever without
  // its report. An agent the batch failed to record reports on its own instead.
  async join(start) {
    this.current ??= this.open().catch((e) => {
      this.current = undefined;
      throw e;
    });
    const path = await this.current;
    const id = await start();
    try {
      await this.update(path, (record) => record.members.push(id));
    } catch (e) {
      await this.bb.json(["thread", "update", id, "--parent-notifications", "auto"]).catch(() => {
        throw new Error(`Started ${id}, but neither recorded it in its batch nor switched it to report on its own: ${e instanceof Error ? e.message : e}`);
      });
    }
    return id;
  }

  async open() {
    const { queuedMessage } = await this.bb.json(
      ["thread", "tell", this.threadId, "--send-at", `${this.timing.deadlineS}s`, "--mode", "auto", "--message-file", "-"],
      FALLBACK,
    );
    if (!queuedMessage?.id) throw new Error(`bb did not hold the batch's message: ${JSON.stringify(queuedMessage)}`);
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${Date.now()}-${randomBytes(4).toString("hex")}.json`);
    writeJson(path, { parent: this.threadId, cli: this.cli, row: queuedMessage.id, members: [], sealed: false, timing: this.timing });
    // A tool call later in this response may run for longer than the message is held.
    this.track(path);
    return path;
  }

  // One failed write rejects only its own caller, not the writes after it.
  update(path, change) {
    const write = this.writes.then(() => {
      const record = readJson(path);
      change(record);
      writeJson(path, record);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  // The response's tool calls are done, so its batch has every member it will get.
  async seal() {
    const path = await this.current?.catch(() => undefined);
    this.current = undefined;
    if (path) await this.close(path);
  }

  async close(path) {
    await this.update(path, (record) => (record.sealed = true));
    const record = readJson(path);
    if (record.members.length > 0) return this.ensureTracker(path);
    await this.bb.json(["thread", "queue", "delete", this.threadId, record.row]).catch(() => {});
    rmSync(path, { force: true });
  }

  // A run starting means no earlier response is still adding agents, so this
  // seals what a response cut short left open and replaces any tracker that
  // died or stopped reaching bb.
  async ensure() {
    await this.seal();
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir).filter((n) => n.endsWith(".json"))) {
      const path = join(this.dir, name);
      try {
        if (!readJson(path).sealed) await this.close(path);
        else this.ensureTracker(path);
      } catch {
        // Its tracker closed the batch and removed the record meanwhile.
      }
    }
  }

  ensureTracker(path) {
    const lease = readLease(path);
    if (!lease || !alive(lease.pid) || Date.now() - lease.beat > this.timing.staleMs) this.track(path);
  }

  // The new lease names the new tracker, so a stale one still running sees it and exits.
  // Without systemd's user manager (macOS, no user bus) it is a plain detached process.
  track(path) {
    const argv = [process.execPath, TRACKER, path];
    const [command, ...args] = hasScopes() ? ["systemd-run", ...SCOPE, ...argv] : argv;
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    writeJson(`${path}.tracker`, { pid: child.pid, beat: Date.now() });
  }
}

// bb's held message is gone or being sent: the tracker sent it, or it fired on its own.
async function delivered(bb, { parent, row }) {
  const queued = await bb.json(["thread", "queue", "list", parent]);
  const message = queued.find((m) => m.id === row);
  return !message || message.state === "claimed";
}

// A row bb will send to the agent by itself: a scheduled wakeup, a retry it
// booked after a failed turn, a report an agent's own batch holds. A row whose
// retries are spent, or one a newer retry overtook, waits for a person.
const pending = (m) => m.state !== "failed_exhausted" && m.waitingOn?.kind !== "superseded";

// An agent has finished when it is not running, bb holds nothing it will send
// it, and none of its own agents still run.
async function finished(bb, member) {
  if (member.status === "deleted") return true;
  if (RUNNING.has(member.status)) return false;
  const [queued, children] = await Promise.all([
    bb.json(["thread", "queue", "list", member.id]),
    bb.json(["thread", "list", "--parent-thread", member.id, "--include-hidden"]),
  ]);
  return !queued.some(pending) && !children.some((c) => RUNNING.has(c.status));
}

async function report(bb, members, done) {
  const parts = await Promise.all(
    members.map(async ({ id, title, status }, i) => {
      if (!done[i]) return resultText(id, title ?? "", { status: "running", output: "Still running. It reports to you on its own when it finishes." });
      const { output } = await bb.json(["thread", "output", id]).catch(() => ({ output: null }));
      return resultText(id, title ?? "", { status: STATUS[status] ?? status, output: output || "(no output)" });
    }),
  );
  const count = done.filter(Boolean).length;
  const head =
    count === members.length
      ? `[pstack batch] All ${members.length} agents this thread started together in one response have finished. bb held each one's own report until the last finished, so here are all of them.`
      : `[pstack batch] ${count} of the ${members.length} agents this thread started together in one response have finished, and the rest are still running well after the first finished, so here are the finished ones' reports now. The others report to you one by one as they finish.`;
  return `${head}\n\n${parts.join("\n\n---\n\n")}\n\n${FROM_PSTACK}`;
}

// Hands every agent of the batch back to bb's usual notices. True once all are.
async function handBack(bb, members) {
  const stuck = members.filter((m) => m.status !== "deleted" && m.parentNotifications !== "auto");
  const results = await Promise.allSettled(stuck.map((m) => bb.json(["thread", "update", m.id, "--parent-notifications", "auto"])));
  return results.every((r) => r.status === "fulfilled");
}

// One look at the batch. Returns true once the batch is over and every agent
// is back on bb's usual notices. look holds what earlier looks found.
async function step(bb, record, look) {
  const { parent, row, timing } = record;
  // A tracker replacing one that died may find the batch already reported.
  look.over ??= await delivered(bb, record);
  const children = await bb.json(["thread", "list", "--parent-thread", parent, "--include-hidden"]);
  const members = record.members.map((id) => children.find((c) => c.id === id) ?? { id, title: null, status: "deleted" });
  if (look.over) return (await handBack(bb, members)) && record.sealed;

  // A batch whose parent's run ended without sealing it has every member it will get.
  const sealed = record.sealed || !RUNNING.has((await bb.json(["thread", "show", parent])).thread.status);
  if (sealed) {
    const done = await Promise.all(members.map((m) => finished(bb, m)));
    const all = done.every(Boolean);
    if (done.some(Boolean)) look.firstDone ??= Date.now();
    // Two looks in a row, so an agent idle only for the moment before bb starts its next turn is not taken for finished.
    const ready = (all && look.allDone) || (look.firstDone !== undefined && Date.now() - look.firstDone >= timing.boundMs);
    look.allDone = all;
    if (ready) {
      // Handed back before the report goes, so an agent that finishes in between reports on its own rather than not at all.
      await handBack(bb, members);
      try {
        await bb.json(["thread", "queue", "update", parent, row, "--message-file", "-"], await report(bb, members, done));
        await bb.json(["thread", "queue", "send", parent, row, "--mode", "auto"]);
      } catch (e) {
        if (!(await delivered(bb, record))) throw e;
      }
      look.over = true;
      return false;
    }
  }
  if (Date.now() < look.nextBeat) return false;
  try {
    await bb.json(["thread", "queue", "update", parent, row, "--send-at", `${timing.deadlineS}s`]);
    look.nextBeat = Date.now() + timing.heartbeatMs;
  } catch (e) {
    if (!(await delivered(bb, record))) throw e;
    look.over = true;
  }
  return false;
}

export async function track(path) {
  const look = { allDone: false, nextBeat: 0, firstDone: undefined, over: undefined };
  let bb;
  for (;;) {
    let record;
    try {
      record = readJson(path);
    } catch {
      // The parent closed an empty batch, or another tracker finished this one.
      break;
    }
    // The parent started a tracker to replace this one.
    if ((readLease(path)?.pid ?? process.pid) !== process.pid) return;
    bb ??= new BbCli(record.cli, { timeoutMs: TRACKER_CALL_TIMEOUT_MS });
    try {
      if (await step(bb, record, look)) break;
      writeJson(`${path}.tracker`, { pid: process.pid, beat: Date.now() });
    } catch {
      // bb did not answer; look again next poll. The held message still fires if this never recovers.
      look.allDone = false;
    }
    await sleep(record.timing.pollMs);
  }
  rmSync(path, { force: true });
  rmSync(`${path}.tracker`, { force: true });
}

if (process.argv[1] === TRACKER) void track(process.argv[2]);
