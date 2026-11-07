// Subagents as bb child threads. Inside a bb thread, bb already runs, shows,
// steers, and reports on child threads, so the agent tools start one of those
// instead of a pi process the bb app cannot see.
import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { truncateUtf8, OUTPUT_CAP_BYTES } from "./agent-text.ts";
import { agentParams, type AgentParams } from "./agent-tools.ts";
import { loadAgentTypes } from "./agent-files.ts";
import { fromAgentFile } from "./agents.ts";
import { type BbEnv, checkEffort, GENERAL_PURPOSE, readSheet, resolveModel, type Settings } from "./config.ts";

// As for pi children: three layers below the main session, and none from the third.
const MAX_SPAWN_DEPTH = 3;
// bb thread wait gives up after its timeout; a foreground agent waits in slices.
const WAIT_SLICE = "1h";
const WAIT_TIMED_OUT = 2;
const WAIT_THREAD_ERROR = 4;
const RUNNING = new Set(["pending", "starting", "active", "stopping"]);

interface BbThread {
  id: string;
  title: string | null;
  status: string;
  parentThreadId: string | null;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

// With --json, bb prints {"ok": false, "error": {message, hint}} on a failure.
function failure(args: string[], r: Run): Error {
  try {
    const { message, hint } = JSON.parse(r.stdout).error;
    if (message) return new Error(`bb ${args.slice(0, 2).join(" ")}: ${message}${hint ? ` (${hint})` : ""}`);
  } catch {}
  return new Error(`bb ${args.slice(0, 2).join(" ")} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 1000)}`);
}

class BbCli {
  constructor(private readonly cli: string) {}

  run(args: string[], { input, signal }: { input?: string; signal?: AbortSignal } = {}): Promise<Run> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cli, args, { stdio: ["pipe", "pipe", "pipe"], signal });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    });
  }

  async json<T>(args: string[], input?: string): Promise<T> {
    const r = await this.run([...args, "--json"], { input });
    if (r.code !== 0) throw failure(args, r);
    return JSON.parse(r.stdout) as T;
  }
}

// A worktree agent starts from the commit the parent has checked out, as a
// pi child's worktree does, not from the project's default branch.
function headOf(cwd: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

// What a pi child gets as flags and system prompt, a bb child gets as the
// head of its first message.
function childPrompt(params: AgentParams, type: string, body: string, parent: string, leaf: boolean): string {
  const rules = [`You are a subagent that @thread:${parent} started with pstack's agent tool, as subagent_type ${type}. Your final reply is your report to it, so make it complete on its own.`];
  if (params.readonly) rules.push("This agent is read-only. Do not create, edit, or delete files; reading files and running commands that change nothing is fine.");
  if (leaf) rules.push("You are at the deepest layer of agents, so do not start subagents.");
  const instructions = body ? `\n\n<agent-instructions>\n${body}\n</agent-instructions>` : "";
  return `<pstack-subagent>\n${rules.join("\n")}${instructions}\n</pstack-subagent>\n\n${params.prompt}`;
}

export class BbAgents {
  private readonly cli: BbCli;
  // What bb does not keep about a child: the subagent type it was started as.
  private readonly types = new Map<string, string>();
  private depth?: Promise<number>;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly settings: Settings,
    readonly env: BbEnv,
  ) {
    this.cli = new BbCli(env.cli);
  }

  // Layers of bb parent threads above this one, counted up to the limit.
  private depthOfSelf(): Promise<number> {
    this.depth ??= (async () => {
      let id = this.env.threadId;
      for (let n = 0; n < MAX_SPAWN_DEPTH; n++) {
        const { thread } = await this.cli.json<{ thread: BbThread }>(["thread", "show", id]);
        if (!thread.parentThreadId) return n;
        id = thread.parentThreadId;
      }
      return MAX_SPAWN_DEPTH;
    })().catch((e) => {
      this.depth = undefined;
      throw e;
    });
    return this.depth;
  }

  // A child thread runs no session-start mandate, as a Claude Code subagent
  // runs no SessionStart hook. When bb cannot say, the thread keeps it.
  async isChild(): Promise<boolean> {
    return (await this.depthOfSelf().catch(() => 0)) > 0;
  }

  async start(params: AgentParams, ctx: ExtensionContext): Promise<string> {
    const depth = await this.depthOfSelf();
    if (depth >= MAX_SPAWN_DEPTH) throw new Error(`Agents nest at most ${MAX_SPAWN_DEPTH} layers below the main session, and this thread is at the last one.`);
    const type = params.subagent_type || GENERAL_PURPOSE;
    const types = loadAgentTypes(this.settings);
    const def = types.get(type);
    if (!def) throw new Error(`Unknown subagent_type "${type}". Valid types: ${[...types.keys()].join(", ")}.`);
    const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const model = fromAgentFile(def.file, params.model, () => resolveModel(params.model ?? def.model, this.settings, readSheet(this.settings.agentDir), parentModel));
    const effort = params.effort ?? def.effort;
    // Pi's off and minimal have no bb reasoning level, so bb picks one for them.
    const thinking = this.pi.getThinkingLevel();
    const level = effort !== undefined ? fromAgentFile(def.file, params.effort, () => checkEffort(effort, this.settings)) : (() => {
      try {
        return checkEffort(thinking, this.settings);
      } catch {
        return undefined;
      }
    })();

    const background = params.run_in_background === true;
    const args = ["thread", "spawn", "--project", this.env.projectId, "--parent-self", "--title", params.description, "--prompt-file", "-", "--provider", "pi"];
    // A foreground call returns the result itself, so bb's report would arrive twice.
    args.push("--parent-notifications", background ? "auto" : "off");
    if (model) args.push("--model", model);
    if (level) args.push("--reasoning-level", level);
    if (params.isolation === "worktree") {
      args.push("--new-environment", "worktree");
      const head = headOf(ctx.cwd);
      if (head) args.push("--base-branch", head);
    } else {
      args.push("--environment", this.env.environmentId);
    }
    const thread = await this.cli.json<BbThread>(args, childPrompt(params, type, def.body, this.env.threadId, depth + 1 >= MAX_SPAWN_DEPTH));
    this.types.set(thread.id, type);
    return thread.id;
  }

  // Waits for the thread to go idle, then reads its final reply. An abort stops the thread.
  async result(id: string, signal?: AbortSignal): Promise<{ status: "completed" | "failed" | "stopped"; output: string }> {
    let status: "completed" | "failed" | "stopped";
    try {
      for (;;) {
        const r = await this.cli.run(["thread", "wait", id, "--status", "idle", "--timeout", WAIT_SLICE], { signal });
        if (r.code === WAIT_TIMED_OUT) continue;
        if (r.code === 0) status = "completed";
        else if (r.code === WAIT_THREAD_ERROR) status = "failed";
        else throw failure(["thread", "wait"], r);
        break;
      }
    } catch (e) {
      if (!signal?.aborted) throw e;
      await this.cli.run(["thread", "stop", id]);
      status = "stopped";
    }
    const { output } = await this.cli.json<{ output: string | null }>(["thread", "output", id]);
    return { status, output: output || "(no output)" };
  }

  async children(): Promise<BbThread[]> {
    return this.cli.json<BbThread[]>(["thread", "list", "--parent-thread", this.env.threadId, "--include-hidden"]);
  }

  async find(to: string): Promise<BbThread> {
    const children = await this.children();
    const byId = children.find((t) => t.id === to);
    if (byId) return byId;
    const matches = children.filter((t) => t.title === to);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`"${to}" matches several agents (${matches.map((t) => t.id).join(", ")}); pass an agentId.`);
    const known = children.map((t) => `${t.id} (${t.title ?? "untitled"})`);
    throw new Error(`No agent "${to}" among this thread's children. Known agents: ${known.join(", ") || "none"}.`);
  }

  // The reply to a message comes back the way a background agent's does, so
  // a child started in the foreground starts reporting to its parent here.
  async send(to: string, message: string): Promise<{ id: string; running: boolean }> {
    const thread = await this.find(to);
    await this.cli.json(["thread", "update", thread.id, "--parent-notifications", "auto"]);
    await this.cli.json(["thread", "tell", thread.id, "--mode", "auto", "--message-file", "-"], message);
    return { id: thread.id, running: RUNNING.has(thread.status) };
  }

  async stop(to: string): Promise<BbThread> {
    const thread = await this.find(to);
    if (RUNNING.has(thread.status)) await this.cli.json(["thread", "stop", thread.id]);
    return (await this.cli.json<{ thread: BbThread }>(["thread", "show", thread.id])).thread;
  }

  async listing(): Promise<object[]> {
    return (await this.children()).map((t) => ({
      id: t.id,
      description: t.title,
      subagent_type: this.types.get(t.id),
      status: t.status,
      running: RUNNING.has(t.status),
      thread: `@thread:${t.id}`,
    }));
  }
}

const BACKGROUND_NOTE =
  "The agent is working in the background as a bb child thread. bb reports to this thread automatically when it finishes. You know nothing about its results until that report arrives — do not report, assume, or predict them, and do not poll it with bb thread wait or sleep; continue other work or respond to the user in the meantime.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.";

function resultText(id: string, description: string, { status, output }: { status: string; output: string }): string {
  const capped = truncateUtf8(output, OUTPUT_CAP_BYTES);
  const tail = capped === output ? "" : `\n\n[Output truncated at ${OUTPUT_CAP_BYTES / 1024} KB. Full output: bb thread output ${id}]`;
  return `agentId: ${id}\ndescription: ${description}\nstatus: ${status}\nthread: @thread:${id}\n\n${capped}${tail}`;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function registerBbAgentTools(pi: ExtensionAPI, agents: BbAgents, settings: Settings): void {
  pi.registerCommand("pstack-agents", {
    description: "Show each bb child thread this thread started, with its status",
    async handler(_args, ctx) {
      const listing = await agents.listing();
      ctx.ui.notify(listing.length ? JSON.stringify(listing, null, 2) : "No child threads.", "info");
    },
  });

  pi.registerTool({
    name: "agent",
    label: "Agent",
    exposure: "model-only",
    description:
      "Launch a subagent as a bb child thread of this thread, visible in the bb app. Foreground (default) waits and returns its final reply; run_in_background returns its thread id at once, and bb reports to this thread when it finishes. Use send_message to steer a running agent or continue a finished one, stop_agent to stop one, list_agents to see them.",
    promptSnippet: "Launch a subagent as a bb child thread (foreground or background, optional worktree)",
    parameters: agentParams(loadAgentTypes(settings)),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const id = await agents.start(params, ctx);
      if (params.run_in_background) {
        return { ...text(`${JSON.stringify({ agentId: id, status: "running", thread: `@thread:${id}` })}\n\n${BACKGROUND_NOTE}`), details: { agentId: id, status: "running" } };
      }
      const result = await agents.result(id, signal);
      return { ...text(resultText(id, params.description, result)), details: { agentId: id, status: result.status }, isError: result.status !== "completed" };
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send message",
    exposure: "model-only",
    description:
      "Send a message to a child thread this thread started, by agentId (its thread id) or description (its title). A running agent reads it in its current turn; a finished one starts a new turn with its earlier context. Either way bb reports to this thread when that turn ends.",
    parameters: Type.Object(
      { to: Type.String({ description: "agentId or the agent's description" }), message: Type.String({ description: "The message to send" }) },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      const { id, running } = await agents.send(params.to, params.message);
      return { ...text(JSON.stringify({ agentId: id, status: "running", steered: running })), details: { agentId: id, running } };
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List agents",
    exposure: "model-only",
    description: "List the bb child threads this thread started, with each one's status. running is true while bb reports it pending, starting, active, or stopping.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const listing = await agents.listing();
      return { ...text(JSON.stringify(listing, null, 2)), details: { agents: listing } };
    },
  });

  pi.registerTool({
    name: "stop_agent",
    label: "Stop agent",
    exposure: "model-only",
    description: "Stop a running child thread: bb stops its turn and releases its agent runtime. The thread and its history stay in bb. Stopping a finished agent reports its status unchanged.",
    parameters: Type.Object({ id: Type.String({ description: "agentId (or description) of the agent to stop" }) }, { additionalProperties: false }),
    async execute(_id, params) {
      const thread = await agents.stop(params.id);
      return { ...text(JSON.stringify({ agentId: thread.id, status: thread.status })), details: { agentId: thread.id, status: thread.status } };
    },
  });
}
