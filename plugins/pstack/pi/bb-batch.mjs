// A batch: the background agents one response starts with batch: true. Each
// starts on bb's stuck parent notifications, so a failure or a question still
// wakes the parent at once and a finished turn does not. The parent's wake for
// the batch is one message bb holds in the parent's queue, scheduled a few
// minutes out. While the tracker, a detached process, sees an agent running,
// it pushes that time back. When the last agent finishes it writes every
// agent's result into the message and sends it. bb sends a held message at
// most once, so a second tracker or the scheduled time firing cannot wake the
// parent twice. A tracker that dies stops pushing the time back, so the
// message fires on its own, and the tracker the parent's next run starts hands
// the agents still running back to bb's usual notices.
//
// Plain JavaScript, so node runs the tracker on its own: node bb-batch.mjs <record>.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BbCli, RUNNING, resultText } from "./bb-cli.mjs";

export const DEFAULT_TIMING = { pollMs: 5000, heartbeatMs: 120_000, deadlineS: 600 };

const TRACKER = fileURLToPath(import.meta.url);
const FROM_PSTACK = "This message comes from pstack's agent tool, not from the user.";
const FALLBACK =
  "[pstack batch] pstack's batch tracker sends this notice only if it stops before every agent of a batch this thread started has finished. Otherwise it replaces it with all of their reports. Agents of the batch still running now report to you one by one, as bb's usual notices. Call list_agents for their status, and `bb thread output <id>` for a finished one's report." +
  `\n\n${FROM_PSTACK}`;

const STATUS = { idle: "completed", error: "failed" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeRecord(path, record) {
  writeFileSync(`${path}.tmp`, JSON.stringify(record));
  renameSync(`${path}.tmp`, path);
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
// the response's tool calls are done, and keeps a tracker running for each
// sealed batch.
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
  // exists before the agent does, so no member is ever without its report.
  async join(start) {
    this.current ??= this.open().catch((e) => {
      this.current = undefined;
      throw e;
    });
    const path = await this.current;
    const id = await start();
    await this.update(path, (record) => record.members.push(id));
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
    writeRecord(path, { parent: this.threadId, cli: this.cli, row: queuedMessage.id, members: [], sealed: false, timing: this.timing });
    return path;
  }

  update(path, change) {
    this.writes = this.writes.then(() => {
      const record = JSON.parse(readFileSync(path, "utf8"));
      change(record);
      writeRecord(path, record);
    });
    return this.writes;
  }

  // The response's tool calls are done, so its batch has every member it will get.
  async seal() {
    const path = await this.current?.catch(() => undefined);
    this.current = undefined;
    if (path) await this.close(path);
  }

  async close(path) {
    await this.update(path, (record) => (record.sealed = true));
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (record.members.length > 0) return this.track(path);
    await this.bb.json(["thread", "queue", "delete", this.threadId, record.row]).catch(() => {});
    rmSync(path, { force: true });
  }

  // A run starting means no earlier response is still adding agents, so this
  // seals what a response cut short left open and restarts any tracker that died.
  async ensure() {
    await this.seal();
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir).filter((n) => n.endsWith(".json"))) {
      const path = join(this.dir, name);
      try {
        const record = JSON.parse(readFileSync(path, "utf8"));
        if (!record.sealed) await this.close(path);
        else if (!this.tracking(path)) this.track(path);
      } catch {
        // Its tracker closed the batch and removed the record meanwhile.
      }
    }
  }

  tracking(path) {
    try {
      return alive(Number(readFileSync(`${path}.pid`, "utf8")));
    } catch {
      return false;
    }
  }

  track(path) {
    const child = spawn(process.execPath, [TRACKER, path], { detached: true, stdio: "ignore" });
    child.unref();
    writeFileSync(`${path}.pid`, String(child.pid));
  }
}

// bb's held message is gone or being sent: it fired on its own, or another tracker sent it.
async function delivered(bb, { parent, row }) {
  const queued = await bb.json(["thread", "queue", "list", parent]);
  const message = queued.find((m) => m.id === row);
  return !message || message.state === "claimed";
}

// An agent whose own agents still run ends turns that are not its last.
async function hasRunningChildren(bb, { id }) {
  const children = await bb.json(["thread", "list", "--parent-thread", id, "--include-hidden"]);
  return children.some((c) => RUNNING.has(c.status));
}

async function report(bb, members) {
  const parts = await Promise.all(
    members.map(async ({ id, title, status }) => {
      const { output } = await bb.json(["thread", "output", id]).catch(() => ({ output: null }));
      return resultText(id, title ?? "", { status: STATUS[status] ?? status, output: output || "(no output)" });
    }),
  );
  return `[pstack batch] All ${members.length} agents this thread started together in one response have finished. bb held each one's own report until the last finished, so here are all of them.\n\n${parts.join("\n\n---\n\n")}\n\n${FROM_PSTACK}`;
}

async function allFinished(bb, members) {
  if (members.some((m) => RUNNING.has(m.status))) return false;
  const busy = await Promise.all(members.filter((m) => m.status !== "deleted").map((m) => hasRunningChildren(bb, m)));
  return !busy.some(Boolean);
}

// One look at the batch. The report goes out only when two looks in a row
// find every agent finished, so an agent that is idle only for the moment
// between its own agent's report and the turn that report starts is not taken
// for finished. Returns true once the batch is over.
async function step(bb, record, look) {
  const { parent, row, members: ids, timing } = record;
  const children = await bb.json(["thread", "list", "--parent-thread", parent, "--include-hidden"]);
  const members = ids.map((id) => children.find((c) => c.id === id) ?? { id, title: null, status: "deleted" });
  const finishedBefore = look.finished;
  look.finished = await allFinished(bb, members);
  if (look.finished && finishedBefore) {
    try {
      await bb.json(["thread", "queue", "update", parent, row, "--message-file", "-"], await report(bb, members));
      await bb.json(["thread", "queue", "send", parent, row, "--mode", "auto"]);
    } catch (e) {
      if (!(await delivered(bb, record))) throw e;
    }
    return true;
  }
  if (Date.now() < look.nextBeat) return false;
  try {
    await bb.json(["thread", "queue", "update", parent, row, "--send-at", `${timing.deadlineS}s`]);
    look.nextBeat = Date.now() + timing.heartbeatMs;
    return false;
  } catch (e) {
    if (!(await delivered(bb, record))) throw e;
  }
  for (const id of ids) await bb.json(["thread", "update", id, "--parent-notifications", "auto"]).catch(() => {});
  return true;
}

export async function track(path) {
  const record = JSON.parse(readFileSync(path, "utf8"));
  const bb = new BbCli(record.cli);
  const look = { finished: false, nextBeat: 0 };
  // Another tracker that closed the batch removed the record.
  while (existsSync(path)) {
    try {
      if (await step(bb, record, look)) break;
    } catch {
      // bb did not answer; look again next poll. The held message still fires if this never recovers.
      look.finished = false;
    }
    await sleep(record.timing.pollMs);
  }
  rmSync(path, { force: true });
  rmSync(`${path}.pid`, { force: true });
}

if (process.argv[1] === TRACKER) void track(process.argv[2]);
