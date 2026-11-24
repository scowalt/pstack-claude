// Inside a bb thread the agent tools start bb child threads through the bb CLI.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { install } from "../../plugins/pstack/pi/index.ts";
import { agentBody, alive, fakeCtx, fakePi, gitRepo, readEntries, resultText, sleep, useWorld, waitFor } from "./harness.mjs";

const fakeBb = fileURLToPath(new URL("./fake-bb.mjs", import.meta.url));
const bb = { cli: fakeBb, projectId: "proj_p", threadId: "thr_self", environmentId: "env_e" };
const bbBatch = { pollMs: 30, heartbeatMs: 150, deadlineS: 600, staleMs: 1500, boundMs: 60_000 };

let w;
let saved;
beforeEach(() => (saved = { ...process.env }));
// Registered before useWorld's cleanup, so it runs first: a batch tracker is
// detached so it outlives pi, and this stops every one this test started, with
// the bb calls it is making, while its world still exists. A tracker's argv
// holds its record's path, under this test's own temporary world.
afterEach(() => {
  if (w) {
    const root = dirname(w.agentDir);
    const found = spawnSync("pgrep", ["-f", `bb-batch\\.mjs ${root}/`], { encoding: "utf8" }).stdout;
    for (const pid of found.split("\n").map(Number).filter((p) => Number.isInteger(p) && p > 1)) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {}
      }
    }
  }
  process.env = saved;
});
const setupWorld = useWorld();

function setup({ threads = {}, sheet, timing, ...state } = {}) {
  const made = setupWorld({ sheet, settings: { bb, bbBatch: { ...bbBatch, ...timing } } });
  w = made.w;
  process.env.FAKE_BB_STATE = join(w.agentDir, "bb-state.json");
  process.env.FAKE_BB_LOG = join(w.agentDir, "bb.log");
  writeFileSync(process.env.FAKE_BB_STATE, JSON.stringify({ threads: { thr_self: {}, ...threads }, ...state }));
  writeFileSync(process.env.FAKE_BB_LOG, "");
  return made;
}
const calls = () => readEntries(process.env.FAKE_BB_LOG);
const callsOf = (sub) => calls().filter((c) => c.argv[1] === sub);
const flag = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

describe("bb CLI", () => {
  test("a bb call that hangs is killed, so a detached tracker never waits on it forever", async () => {
    const { BbCli } = await import("../../plugins/pstack/pi/bb-cli.mjs");
    const started = Date.now();
    const r = await new BbCli("sleep", { timeoutMs: 200 }).run(["30"]);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("the extension's own bb calls have no limit, so a long bb thread wait is not killed", async () => {
    const { BbCli } = await import("../../plugins/pstack/pi/bb-cli.mjs");
    const r = await new BbCli("sleep").run(["0.3"]);
    expect(r.code).toBe(0);
    expect(new BbCli("sleep").timeoutMs).toBeUndefined();
  });
});

describe("agent", () => {
  test("a foreground agent is a bb child thread on this environment, and returns its final reply", async () => {
    const { pi, ctx } = setup({ childOutput: "the report" });
    const result = await pi.call("agent", { description: "probe", prompt: "do it", subagent_type: "pstack:poteto-agent", model: "opus" }, ctx);

    const [spawn] = callsOf("spawn");
    expect(flag(spawn.argv, "--project")).toBe("proj_p");
    expect(spawn.argv).toContain("--parent-self");
    expect(flag(spawn.argv, "--environment")).toBe("env_e");
    expect(flag(spawn.argv, "--provider")).toBe("pi");
    expect(flag(spawn.argv, "--model")).toBe("anthropic/fixture-opus");
    expect(flag(spawn.argv, "--reasoning-level")).toBe("medium");
    expect(flag(spawn.argv, "--parent-notifications")).toBe("off");
    expect(flag(spawn.argv, "--title")).toBe("probe");
    expect(spawn.stdin).toContain(agentBody("agents/poteto-agent.md"));
    expect(spawn.stdin.endsWith("\n\ndo it")).toBe(true);

    expect(callsOf("wait")[0].argv.slice(2, 5)).toEqual(["thr_child1", "--status", "idle"]);
    expect(result.isError).toBe(false);
    expect(resultText(result)).toContain("status: completed");
    expect(resultText(result)).toEndWith("the report");
  });

  test("a background agent returns its thread id at once and leaves the report to bb", async () => {
    const { pi, ctx } = setup();
    const result = await pi.call("agent", { description: "bg", prompt: "go", run_in_background: true }, ctx);
    expect(result.details).toEqual({ agentId: "thr_child1", status: "running" });
    expect(flag(callsOf("spawn")[0].argv, "--parent-notifications")).toBe("auto");
    expect(callsOf("wait")).toEqual([]);
    await pi.emit("turn_end", {}, ctx);
    await pi.emit("agent_start", {}, ctx);
    expect(calls().map((c) => c.argv[1])).toEqual(["show", "spawn"]);
  });

  test("a thread bb puts in error fails the foreground call", async () => {
    const { pi, ctx } = setup({ waitExit: 4, childOutput: "half done" });
    const result = await pi.call("agent", { description: "x", prompt: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("status: failed");
  });

  test("worktree isolation starts a new worktree from the parent's HEAD; readonly is stated in the prompt", async () => {
    const { pi, ctx } = setup();
    const git = gitRepo(w.cwd);
    await pi.call("agent", { description: "x", prompt: "x", isolation: "worktree", readonly: true }, ctx);
    const [spawn] = callsOf("spawn");
    expect(flag(spawn.argv, "--new-environment")).toBe("worktree");
    expect(flag(spawn.argv, "--base-branch")).toBe(git("rev-parse", "HEAD"));
    expect(spawn.argv).not.toContain("--environment");
    expect(spawn.stdin).toContain("This agent is read-only.");
  });

  test("a thread three layers down starts no agents", async () => {
    const { pi, ctx } = setup({ threads: { thr_self: { parentThreadId: "thr_a" }, thr_a: { parentThreadId: "thr_b" }, thr_b: { parentThreadId: "thr_c" } } });
    const err = await pi.call("agent", { description: "x", prompt: "x" }, ctx).catch((e) => e);
    expect(err.message).toContain("nest at most 3 layers");
    expect(callsOf("spawn")).toEqual([]);
  });
});

describe("batch", () => {
  const state = () => JSON.parse(readFileSync(process.env.FAKE_BB_STATE, "utf8"));
  // What bb delivered to this thread: tells, held messages sent or fired, and the child outcomes bb reports.
  const wakes = () => (state().wakes ?? []).filter((m) => m.threadId === "thr_self");
  const bbDoes = (...args) => {
    const r = spawnSync(fakeBb, ["thread", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stdout || r.stderr);
  };
  const finish = (id, fields = {}) => bbDoes("__set", id, JSON.stringify({ status: "idle", output: `${id}'s report`, ...fields }));
  const batchDir = () => join(w.agentDir, "pstack", "bb-batches", "thr_self");
  const hasTracker = () => existsSync(batchDir()) && readdirSync(batchDir()).some((n) => n.endsWith(".tracker"));
  const trackerPid = () => JSON.parse(readFileSync(join(batchDir(), readdirSync(batchDir()).find((n) => n.endsWith(".tracker"))), "utf8")).pid;
  const kinds = () => wakes().map((m) => m.kind);
  const rowOf = (threadId) => state().queued.find((m) => m.threadId === threadId).id;
  const batchOver = () => !existsSync(batchDir()) || readdirSync(batchDir()).length === 0;

  // One response of a running parent that starts n batched agents, then ends its turn unless told not to.
  async function fanOut(n, { endTurn = true, ...options } = {}) {
    const made = setup({ threads: { thr_self: { status: "active" } }, ...options });
    const calls = Array.from({ length: n }, (_, i) => made.pi.call("agent", { description: `candidate ${i + 1}`, prompt: "go", run_in_background: true, batch: true }, made.ctx));
    const ids = (await Promise.all(calls)).map((r) => r.details.agentId).sort();
    if (endTurn) await made.pi.emit("turn_end", {}, made.ctx);
    return { ...made, ids };
  }

  test("batched agents start on bb's stuck notifications, and the parent wakes once, when the last finishes, with every result", async () => {
    const { ids } = await fanOut(3);
    expect(ids).toEqual(["thr_child1", "thr_child2", "thr_child3"]);
    expect(callsOf("spawn").map((c) => flag(c.argv, "--parent-notifications"))).toEqual(["stuck", "stuck", "stuck"]);
    expect(state().queued).toHaveLength(1);

    finish("thr_child1");
    finish("thr_child2");
    // The held message's time keeps moving out while an agent runs.
    await waitFor(() => callsOf("queue").filter((c) => c.argv[2] === "update" && c.argv.includes("--send-at")).length >= 3);
    expect(wakes()).toEqual([]);

    finish("thr_child3");
    await waitFor(() => wakes().length > 0);
    await sleep(300);
    expect(wakes().map((m) => m.kind)).toEqual(["queued"]);
    const { text } = wakes()[0];
    for (const id of ids) expect(text).toContain(`status: completed\nthread: @thread:${id}\n\n${id}'s report`);
    expect(text).toMatch(/^agentId: thr_child1\ndescription: candidate \d$/m);
    expect(text).toStartWith("[pstack batch] All 3 agents");
    expect(state().queued).toEqual([]);
    await waitFor(batchOver);
  });

  test("an agent that fails wakes the parent at once, and the batch still reports once the rest finish", async () => {
    await fanOut(3);
    bbDoes("__set", "thr_child2", JSON.stringify({ status: "error", output: "crashed" }));
    expect(wakes()).toEqual([{ threadId: "thr_self", kind: "child-failed", child: "thr_child2" }]);

    await sleep(300);
    expect(wakes()).toHaveLength(1);
    finish("thr_child1");
    finish("thr_child3");
    await waitFor(() => wakes().length === 2);
    await sleep(300);
    expect(wakes().map((m) => m.kind)).toEqual(["child-failed", "queued"]);
    expect(wakes()[1].text).toContain("status: failed\nthread: @thread:thr_child2\n\ncrashed");
  });

  test("a tracker that dies mid-batch is started again when the parent's pi starts again, and the batch still wakes it exactly once", async () => {
    await fanOut(3);
    await waitFor(hasTracker);
    const first = trackerPid();
    process.kill(first, "SIGKILL");
    await waitFor(() => !alive(first));
    finish("thr_child1");

    // bb ended the parent's pi; its next run loads the extension afresh.
    const pi = fakePi();
    install(pi.api, { ...w.settings, bb, bbBatch });
    await pi.emit("session_start", { reason: "resume" }, fakeCtx({ cwd: w.cwd }));
    const second = trackerPid();
    expect(second).not.toBe(first);
    expect(alive(second)).toBe(true);

    finish("thr_child2");
    finish("thr_child3");
    await waitFor(() => wakes().length > 0);
    await sleep(300);
    expect(wakes().map((m) => m.kind)).toEqual(["queued"]);
    expect(wakes()[0].text).toStartWith("[pstack batch] All 3 agents");
    await waitFor(batchOver);
  });

  test("when no tracker runs, the held message fires on its own, and the next run hands the agents still running back to bb's own notices", async () => {
    const { pi, ctx } = await fanOut(2);
    await waitFor(hasTracker);
    const pid = trackerPid();
    process.kill(pid, "SIGKILL");
    await waitFor(() => !alive(pid));

    bbDoes("__fire", "thr_self", state().queued[0].id);
    expect(wakes().map((m) => m.kind)).toEqual(["queued"]);
    expect(wakes()[0].text).toContain("Agents of the batch still running now report to you one by one");

    await pi.emit("agent_start", {}, ctx);
    await waitFor(() => ["thr_child1", "thr_child2"].every((id) => state().threads[id].parentNotifications === "auto"));
    await waitFor(batchOver);
    finish("thr_child1");
    expect(wakes().map((m) => m.kind)).toEqual(["queued", "child-completed"]);
  });

  test("an agent that ends its turn while its own agents run has not finished", async () => {
    await fanOut(1);
    bbDoes("__set", "thr_grandchild", JSON.stringify({ parentThreadId: "thr_child1", status: "active" }));
    finish("thr_child1", { output: "waiting on my worker" });
    await sleep(400);
    expect(wakes()).toEqual([]);

    // bb hands the worker's report to the agent, which starts its last turn.
    bbDoes("__set", "thr_grandchild", JSON.stringify({ status: "idle" }));
    bbDoes("__set", "thr_child1", JSON.stringify({ status: "active" }));
    finish("thr_child1", { output: "the final report" });
    await waitFor(() => wakes().length > 0);
    expect(wakes()[0].text).toContain("the final report");
  });

  test("an agent in error that bb will retry has not finished, and the batch carries the retry's real report", async () => {
    await fanOut(2);
    bbDoes("__set", "thr_child1", JSON.stringify({ status: "error", output: "every account is out of quota" }));
    bbDoes("__queue", "thr_child1", JSON.stringify({ payload: { kind: "retry" }, sendAt: Date.now() + 3_600_000 }));
    finish("thr_child2");
    await sleep(400);
    expect(kinds()).toEqual(["child-failed"]);

    // bb sends the retry, and the turn it starts finishes.
    bbDoes("__fire", "thr_child1", rowOf("thr_child1"));
    bbDoes("__set", "thr_child1", JSON.stringify({ status: "active" }));
    finish("thr_child1", { output: "the real report" });
    await waitFor(() => wakes().length === 2);
    expect(kinds()).toEqual(["child-failed", "queued"]);
    expect(wakes()[1].text).toContain("status: completed\nthread: @thread:thr_child1\n\nthe real report");
  });

  test("a row bb will not send by itself, such as one whose retries are spent, does not hold the batch", async () => {
    await fanOut(2);
    bbDoes("__set", "thr_child1", JSON.stringify({ status: "error", output: "gave up" }));
    bbDoes("__queue", "thr_child1", JSON.stringify({ state: "failed_exhausted" }));
    bbDoes("__queue", "thr_child2", JSON.stringify({ waitingOn: { kind: "superseded" } }));
    finish("thr_child2");
    await waitFor(() => wakes().length === 2);
    expect(kinds()).toEqual(["child-failed", "queued"]);
    expect(wakes()[1].text).toContain("status: failed\nthread: @thread:thr_child1\n\ngave up");
  });

  test("an idle agent that bb still holds a message for, such as its own batch's report, has not finished", async () => {
    await fanOut(1);
    bbDoes("__queue", "thr_child1", JSON.stringify({ sendAt: Date.now() + 3_600_000 }));
    finish("thr_child1", { output: "Started 1 worker with batch: true; waiting for the batch report." });
    await sleep(400);
    expect(wakes()).toEqual([]);

    bbDoes("__fire", "thr_child1", rowOf("thr_child1"));
    bbDoes("__set", "thr_child1", JSON.stringify({ status: "active" }));
    finish("thr_child1", { output: "the final report" });
    await waitFor(() => wakes().length > 0);
    expect(wakes()[0].text).toContain("the final report");
    expect(wakes()[0].text).not.toContain("waiting for the batch report");
  });

  test("after the batch reports, every agent is back on bb's usual notices, so a later turn reports on its own", async () => {
    const { ids } = await fanOut(2);
    finish("thr_child1");
    finish("thr_child2");
    await waitFor(() => wakes().length > 0);
    await waitFor(batchOver);
    expect(ids.map((id) => state().threads[id].parentNotifications)).toEqual(["auto", "auto"]);

    bbDoes("__set", "thr_child1", JSON.stringify({ status: "active" }));
    finish("thr_child1", { output: "a later turn" });
    expect(kinds()).toEqual(["queued", "child-completed"]);
  });

  test("the held message is kept back from the first agent on, so a long tool call later in the response cannot let it fire", async () => {
    const { pi, ctx } = await fanOut(2, { endTurn: false, timing: { deadlineS: 1 } });
    await sleep(1500);
    // Any bb call lets the fake's scheduler send what is due.
    bbDoes("__state", "{}");
    expect(wakes()).toEqual([]);

    await pi.emit("turn_end", {}, ctx);
    finish("thr_child1");
    finish("thr_child2");
    await waitFor(() => wakes().length > 0);
    expect(kinds()).toEqual(["queued"]);
    expect(wakes()[0].text).toStartWith("[pstack batch] All 2 agents");
  });

  test("one agent still running long after the first finished does not hide its finished siblings", async () => {
    await fanOut(3, { timing: { boundMs: 600 } });
    finish("thr_child1");
    finish("thr_child2");
    await sleep(200);
    expect(wakes()).toEqual([]);

    await waitFor(() => wakes().length > 0);
    const { text } = wakes()[0];
    expect(text).toStartWith("[pstack batch] 2 of the 3 agents");
    expect(text).toContain("thread: @thread:thr_child1\n\nthr_child1's report");
    expect(text).toContain("thread: @thread:thr_child2\n\nthr_child2's report");
    expect(text).toContain("status: running\nthread: @thread:thr_child3\n\nStill running.");
    await waitFor(batchOver);
    finish("thr_child3");
    expect(kinds()).toEqual(["queued", "child-completed"]);
    expect(wakes()[1].child).toBe("thr_child3");
  });

  test("a batch whose parent's run ended without sealing it still reports, so its tracker never keeps the message back forever", async () => {
    await fanOut(2, { endTurn: false });
    // pi died mid-response: no turn_end, and bb shows the parent no longer running.
    bbDoes("__set", "thr_self", JSON.stringify({ status: "error" }));
    finish("thr_child1");
    finish("thr_child2");
    await waitFor(() => wakes().length > 0);
    expect(kinds()).toEqual(["queued"]);
    expect(wakes()[0].text).toStartWith("[pstack batch] All 2 agents");
  });

  test("an agent its batch failed to record reports on its own, and later batches still record theirs", async () => {
    setup();
    const { Batches } = await import("../../plugins/pstack/pi/bb-batch.mjs");
    const batches = new Batches({ cli: fakeBb, threadId: "thr_self", dir: batchDir(), timing: bbBatch });
    const spawnChild = () => JSON.parse(spawnSync(fakeBb, ["thread", "spawn", "--parent-notifications", "stuck", "--json"], { encoding: "utf8" }).stdout).id;
    const records = () => readdirSync(batchDir()).filter((n) => n.endsWith(".json"));

    // The record's write fails: here it has gone from under the batch.
    const lost = await batches.join(async () => {
      for (const name of records()) rmSync(join(batchDir(), name));
      return spawnChild();
    });
    expect(state().threads[lost].parentNotifications).toBe("auto");
    await batches.seal().catch(() => {});

    const kept = await batches.join(async () => spawnChild());
    const [name] = records();
    expect(JSON.parse(readFileSync(join(batchDir(), name), "utf8")).members).toEqual([kept]);
    expect(state().threads[kept].parentNotifications).toBe("stuck");
  });

  test("a switch back to bb's usual notices that fails is retried, and the batch is kept until it succeeds", async () => {
    const { ids } = await fanOut(2);
    bbDoes("__state", JSON.stringify({ failing: "update" }));
    finish("thr_child1");
    finish("thr_child2");
    await waitFor(() => wakes().length > 0);
    await sleep(300);
    expect(batchOver()).toBe(false);
    expect(ids.map((id) => state().threads[id].parentNotifications)).toEqual(["stuck", "stuck"]);

    bbDoes("__state", JSON.stringify({ failing: null }));
    await waitFor(() => ids.every((id) => state().threads[id].parentNotifications === "auto"));
    await waitFor(batchOver);
    expect(kinds()).toEqual(["queued"]);
  });

  test("a live tracker that cannot reach bb is replaced on the parent's next run, and stops once it is", async () => {
    const { pi, ctx } = await fanOut(2, { timing: { staleMs: 800 } });
    await waitFor(hasTracker);
    const first = trackerPid();
    bbDoes("__state", JSON.stringify({ failFor: [first] }));
    finish("thr_child1");
    finish("thr_child2");
    await sleep(1100);
    expect(wakes()).toEqual([]);
    expect(alive(first)).toBe(true);

    await pi.emit("agent_start", {}, ctx);
    expect(trackerPid()).not.toBe(first);
    await waitFor(() => wakes().length > 0);
    expect(kinds()).toEqual(["queued"]);
    expect(wakes()[0].text).toStartWith("[pstack batch] All 2 agents");
    await waitFor(() => !alive(first));
  });

  test("batch needs run_in_background, and is not offered outside bb", async () => {
    const { pi, ctx } = setup();
    const err = await pi.call("agent", { description: "x", prompt: "x", batch: true }, ctx).catch((e) => e);
    expect(err.message).toContain("batch needs run_in_background");
    expect(callsOf("spawn")).toEqual([]);
    expect(Object.keys(pi.tools.get("agent").parameters.properties)).toContain("batch");
    const { pi: plain } = setupWorld({});
    expect(Object.keys(plain.tools.get("agent").parameters.properties)).not.toContain("batch");
  });
});

describe("send_message, list_agents, stop_agent", () => {
  const child = { title: "reviewer", status: "idle", parentThreadId: "thr_self" };

  test("send_message finds a child by description, turns on its reports, and tells it", async () => {
    const { pi, ctx } = setup({ threads: { thr_r: child } });
    await pi.call("send_message", { to: "reviewer", message: "again" }, ctx);
    expect(callsOf("update")[0].argv).toEqual(["thread", "update", "thr_r", "--parent-notifications", "auto", "--json"]);
    const [tell] = callsOf("tell");
    expect(tell.argv.slice(2, 5)).toEqual(["thr_r", "--mode", "auto"]);
    expect(tell.stdin).toBe("again");
  });

  test("an unknown agent is an error that lists the children", async () => {
    const { pi, ctx } = setup({ threads: { thr_r: child } });
    const err = await pi.call("send_message", { to: "nobody", message: "x" }, ctx).catch((e) => e);
    expect(err.message).toContain("thr_r (reviewer)");
  });

  test("list_agents lists this thread's children; stop_agent stops a running one", async () => {
    const { pi, ctx } = setup({ threads: { thr_r: { ...child, status: "active" }, thr_other: { parentThreadId: "thr_x" } } });
    const listed = JSON.parse(resultText(await pi.call("list_agents", {}, ctx)));
    expect(listed.map((a) => [a.id, a.running])).toEqual([["thr_r", true]]);
    const stopped = await pi.call("stop_agent", { id: "thr_r" }, ctx);
    expect(callsOf("stop")[0].argv.slice(0, 3)).toEqual(["thread", "stop", "thr_r"]);
    expect(stopped.details).toEqual({ agentId: "thr_r", status: "idle" });
  });
});

describe("schedule_wakeup", () => {
  const wake = (pi, ctx, params) => pi.call("schedule_wakeup", { reason: "waiting on CI", ...params }, ctx);
  const queued = () => JSON.parse(readFileSync(process.env.FAKE_BB_STATE, "utf8")).queued ?? [];
  const texts = () => queued().map((m) => m.content[0].text);
  const notes = () => {
    const seen = [];
    return { seen, ui: { notify: (message) => seen.push(message) } };
  };

  test("schedules a bb message for the clamped delay, ending in a line that says the thread sent it to itself, which outlives the session", async () => {
    const { pi, ctx } = setup();
    const result = await wake(pi, ctx, { delaySeconds: 5, prompt: "/loop watch PR 42" });
    expect(callsOf("tell").map((c) => c.argv)).toEqual([["thread", "tell", "thr_self", "--send-at", "60s", "--mode", "auto", "--message-file", "-", "--json"]]);
    const [prompt, marker] = callsOf("tell")[0].stdin.split("\n\n");
    expect(prompt).toBe("/loop watch PR 42");
    expect(marker).toMatch(/scheduled this message for itself with schedule_wakeup\. .*not a message from the user\.$/);
    expect(result.details).toMatchObject({ delaySeconds: 60, id: "qmsg_1" });
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    expect(queued().map((m) => m.id)).toEqual(["qmsg_1"]);
  });

  test("a new call deletes this tool's pending message before it schedules another, and leaves the user's", async () => {
    const mine = { id: "qmsg_user", threadId: "thr_self", state: "scheduled", sendAt: Date.now() + 3_600_000, content: [{ type: "text", text: "the user's reminder" }] };
    const { pi, ctx } = setup({ queued: [mine] });
    await wake(pi, ctx, { delaySeconds: 600, prompt: "first" });
    await wake(pi, ctx, { delaySeconds: 120, prompt: "second" });
    expect(calls().map((c) => c.argv.slice(1, 5).join(" "))).toEqual([
      "queue list thr_self --json",
      "tell thr_self --send-at 600s",
      "queue list thr_self --json",
      "queue delete thr_self qmsg_1",
      "tell thr_self --send-at 120s",
    ]);
    expect(texts()).toEqual(["the user's reminder", expect.stringMatching(/^second\n\n\[schedule_wakeup\] /)]);
  });

  test("stop: true deletes the pending message and says whether there was one", async () => {
    const { pi, ctx } = setup();
    await wake(pi, ctx, { delaySeconds: 120, prompt: "later" });
    expect((await wake(pi, ctx, { stop: true })).details).toEqual({ cancelled: true });
    expect(callsOf("queue").at(-1).argv.slice(1, 5)).toEqual(["queue", "delete", "thr_self", "qmsg_1"]);
    expect(queued()).toEqual([]);
    expect((await wake(pi, ctx, { stop: true })).details).toEqual({ cancelled: false });
  });

  test.each(["tell", "queue"])("a failed bb %s fails the call with bb's error", async (failing) => {
    const { pi, ctx } = setup({ failing });
    const err = await wake(pi, ctx, { delaySeconds: 60, prompt: "later" }).catch((e) => e);
    expect(err.message).toBe(`bb thread ${failing}: fake ${failing} failure (try again)`);
    expect(queued()).toEqual([]);
  });

  test("a self-paced /loop re-arms through bb, and what the delivered /loop sends is the agent's, without the marker", async () => {
    const { pi, ctx } = setup();
    await wake(pi, ctx, { delaySeconds: 60, prompt: "/loop watch PR 42" });
    const [delivered] = texts();
    // Pi passes an extension command what follows its name.
    await pi.commands.get("loop").handler(delivered.slice("/loop ".length), ctx);
    expect(pi.userMessages).toEqual([]);
    const sent = pi.messages.map((m) => m.message.content);
    expect(sent).toEqual([expect.stringMatching(/^watch PR 42\n\n\[\/loop, self-paced\] .*schedule_wakeup with prompt "\/loop watch PR 42" /)]);
    await wake(pi, ctx, { delaySeconds: 60, prompt: "/loop watch PR 42" });
    expect(texts()).toEqual([delivered]);
  });

  test("/loop stop deletes the pending bb wakeup, after the process that scheduled it has gone", async () => {
    const { pi, ctx } = setup();
    const { seen, ui } = notes();
    await wake(pi, ctx, { delaySeconds: 60, prompt: "/loop watch PR 42" });
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    await pi.commands.get("loop").handler("stop", { ...ctx, ui });
    expect(queued()).toEqual([]);
    expect(seen).toEqual(["Loop stopped."]);
  });

  test("a fixed-interval /loop is refused with the self-paced form, from the user or from a wakeup", async () => {
    const { pi, ctx } = setup();
    const { seen, ui } = notes();
    await pi.commands.get("loop").handler("5m check the deploy", { ...ctx, ui });
    expect(seen).toEqual([expect.stringContaining("Use /loop <prompt>")]);
    expect(pi.userMessages).toEqual([]);
    const err = await wake(pi, ctx, { delaySeconds: 60, prompt: "/loop 5m check the deploy" }).catch((e) => e);
    expect(err.message).toContain("Use /loop <prompt>");
    expect(callsOf("tell")).toEqual([]);
  });

  test("an extension command other than /loop is refused, since pi would run it as the user's", async () => {
    const { pi, ctx } = setup();
    const err = await wake(pi, ctx, { delaySeconds: 60, prompt: "/pstack-agents" }).catch((e) => e);
    expect(err.message).toContain("pi would run /pstack-agents as the user's command");
    expect(callsOf("tell")).toEqual([]);
  });
});

describe("session routing", () => {
  const mandateOf = async (pi, ctx) => {
    const event = { prompt: "hi", systemPrompt: "", systemPromptOptions: { sections: {} } };
    await pi.emit("before_agent_start", event, ctx);
    return "pstack-session-start" in event.systemPromptOptions.sections;
  };

  test("a top-level bb thread gets the mandate and a child thread does not", async () => {
    const top = setup();
    expect(await mandateOf(top.pi, top.ctx)).toBe(true);
    const nested = setup({ threads: { thr_self: { parentThreadId: "thr_parent" } } });
    expect(await mandateOf(nested.pi, nested.ctx)).toBe(false);
  });

  test("a bb thread leaves asking to bb's AskUserQuestion", () => {
    const { pi } = setup();
    expect(pi.tools.has("ask_user_question")).toBe(false);
    expect(pi.tools.has("schedule_wakeup")).toBe(true);
  });

  test("pi bb agents: off keeps pi child processes", async () => {
    const { pi } = setup({ sheet: "pi bb agents: off\n" });
    expect(pi.tools.get("agent").description).toContain("a separate pi process");
  });
});
