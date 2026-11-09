// Inside a bb thread the agent tools start bb child threads through the bb CLI.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentBody, gitRepo, readEntries, resultText, useWorld } from "./harness.mjs";

const fakeBb = fileURLToPath(new URL("./fake-bb.mjs", import.meta.url));
const bb = { cli: fakeBb, projectId: "proj_p", threadId: "thr_self", environmentId: "env_e" };
const setupWorld = useWorld();

let w;
function setup({ threads = {}, sheet, ...state } = {}) {
  const made = setupWorld({ sheet, settings: { bb } });
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

let saved;
beforeEach(() => (saved = { ...process.env }));
afterEach(() => {
  process.env = saved;
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
