import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { BbCli } from "./bb.ts";
import type { BbEnv } from "./config.ts";
import type { OneShot } from "./one-shot.ts";
import { expandSlash } from "./slash.ts";

const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;
// setInterval treats a delay above 2^31-1 ms as 1 ms.
const MAX_LOOP_S = 24 * 86400;
const IDLE_RETRY_MS = 1000;
// Text the agent chose (a schedule_wakeup prompt, and what a loop it re-arms sends) goes in as a custom
// message, not a user message. The permission classifier reads user-role messages as what the user asked
// for, so a user message here would let the agent write its own permission.
const AGENT_PROMPT_TYPE = "pstack-wakeup";
const LOOP_COMMAND = /^\/loop(?:\s+([\s\S]*))?$/;
// bb delivers a wakeup as a user message, so this last line says whose text it is (see AGENT_PROMPT_TYPE). It
// is also how this tool tells its own queued messages from the user's.
const BB_WAKEUP_MARKER =
  "[schedule_wakeup] This thread scheduled this message for itself with schedule_wakeup. The text above is the agent's own prompt, not a message from the user.";
const BB_FIXED_LOOP =
  "A fixed-interval /loop cannot run inside bb: its timer lives in this pi process, which bb ends while the thread is idle. Use /loop <prompt>, which paces itself with schedule_wakeup.";
type Send = (prompt: string) => void;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const wakeupParams = Type.Object({
  delaySeconds: Type.Optional(Type.Number({ description: `Seconds until the wakeup (${MIN_DELAY_S}-${MAX_DELAY_S})` })),
  prompt: Type.Optional(Type.String({ description: "The prompt to run when the wakeup fires" })),
  reason: Type.Optional(Type.String({ description: "Why this delay, in one short sentence" })),
  noop: Type.Optional(Type.Boolean({ description: "Mark this wakeup as a routine check; it is scheduled all the same" })),
  stop: Type.Optional(Type.Boolean({ description: "Cancel the pending wakeup; no other field is needed" })),
});

// One pending wakeup, one fixed-interval loop, and one live self-paced loop per
// session. A due wakeup or loop tick runs the delivery its caller chose, at
// once when the agent is idle.
export class Scheduler {
  private wakeup?: NodeJS.Timeout;
  private loop?: NodeJS.Timeout;
  // A self-paced loop has no timer of its own while its iteration runs, so
  // this is what /loop stop finds then.
  private selfPaced = false;
  // Set by a /loop command that ends or replaces the loop while a run is in
  // flight, until that run settles. A schedule_wakeup call names no loop, so
  // nothing tells that run's re-arm of the old loop from any other wakeup. It
  // is refused them all, or the loop the user just ended would come back.
  sealed = false;
  // A run is in flight: set by agent_start, cleared by agent_settled. Not
  // ctx.isIdle(), which is also false during a manual compaction.
  running = false;

  scheduleWakeup(seconds: number, deliver: () => void, ctx: ExtensionContext): void {
    this.cancelWakeup();
    const due = () => {
      // Pi rejects prompts during manual compaction. Keep the wakeup pending
      // until idle, including while a run or compaction is still finishing.
      if (!ctx.isIdle()) {
        this.wakeup = setTimeout(due, IDLE_RETRY_MS).unref();
        return;
      }
      this.wakeup = undefined;
      deliver();
    };
    this.wakeup = setTimeout(due, seconds * 1000);
    this.wakeup.unref();
  }

  cancelWakeup(): boolean {
    const had = this.wakeup !== undefined;
    clearTimeout(this.wakeup);
    this.wakeup = undefined;
    return had;
  }

  startLoop(seconds: number, tick: () => void, ctx: ExtensionContext): void {
    // A tick that lands mid-run is dropped, so a slow iteration cannot pile up a backlog.
    this.loop = setInterval(() => ctx.isIdle() && tick(), seconds * 1000);
    this.loop.unref();
  }

  private stopLoop(): boolean {
    const had = this.loop !== undefined;
    clearInterval(this.loop);
    this.loop = undefined;
    return had;
  }

  startSelfPaced(): void {
    this.selfPaced = true;
  }

  // Ends the loop and the pending wakeup. midRun says a run is in flight,
  // which seals the wakeup slot against it.
  stopAll(midRun = false): boolean {
    const wakeup = this.cancelWakeup();
    const selfPaced = this.selfPaced;
    this.selfPaced = false;
    if (midRun) this.sealed = true;
    return this.stopLoop() || wakeup || selfPaced;
  }
}

// The agent's one pending wakeup, and what the tool's description says about its delivery.
interface Wakeups {
  readonly delivery: string;
  // Set when a fixed-interval /loop's timer would not last between turns.
  readonly fixedLoopRefusal?: string;
  schedule(seconds: number, prompt: string, ctx: ExtensionContext): Promise<{ fireAt: Date; id?: string }>;
  cancel(): Promise<boolean>;
}

interface QueuedMessage {
  id: string;
  state: string;
  sendAt: number | null;
  content: { type: string; text?: string }[];
}

// bb ends an idle thread's pi process, and a timer with it, so inside bb the
// wakeup is a message bb holds and sends to this thread when it is due.
class BbWakeups implements Wakeups {
  readonly delivery =
    "as a message bb holds and sends to this thread then. It survives this pi process, starts a turn or steers the one running, and arrives as a user message whose last line says this thread sent it to itself";
  readonly fixedLoopRefusal = BB_FIXED_LOOP;

  constructor(
    private readonly cli: BbCli,
    private readonly threadId: string,
    private readonly commands: () => readonly SlashCommandInfo[],
  ) {}

  async schedule(seconds: number, prompt: string): Promise<{ fireAt: Date; id: string }> {
    // Pi runs an extension command in a user message as the user's. /loop is the one a wakeup may run.
    const name = /^\/(\S+)/.exec(prompt)?.[1];
    if (name !== "loop" && this.commands().some((c) => c.source === "extension" && c.name === name)) {
      throw new Error(`Inside bb a wakeup arrives as a user message, and pi would run /${name} as the user's command. Schedule a prompt instead.`);
    }
    const loop = LOOP_COMMAND.exec(prompt);
    if (loop && parseLoop(loop[1] ?? "").kind === "fixed") throw new Error(BB_FIXED_LOOP);
    // Expanded here, as the timer path does when it fires, so a template's arguments never take in the marker.
    const text = `${expandSlash(this.commands(), prompt)}\n\n${BB_WAKEUP_MARKER}`;
    await this.cancel();
    const reply = await this.cli.json<{ queuedMessage?: QueuedMessage }>(
      ["thread", "tell", this.threadId, "--send-at", `${seconds}s`, "--mode", "auto", "--message-file", "-"],
      text,
    );
    const queued = reply.queuedMessage;
    if (!queued?.sendAt) throw new Error(`bb did not schedule the wakeup: ${JSON.stringify(reply)}`);
    return { fireAt: new Date(queued.sendAt), id: queued.id };
  }

  // A claimed message is the one bb is delivering now.
  async cancel(): Promise<boolean> {
    const queued = await this.cli.json<QueuedMessage[]>(["thread", "queue", "list", this.threadId]);
    const own = queued.filter((m) => m.state !== "claimed" && m.content.some((c) => c.type === "text" && c.text?.endsWith(BB_WAKEUP_MARKER)));
    for (const m of own) await this.cli.json(["thread", "queue", "delete", this.threadId, m.id]);
    return own.length > 0;
  }
}

// The /loop arguments of a wakeup bb delivered, without its marker.
function bbWakeupLoop(args: string): string | undefined {
  return args.endsWith(BB_WAKEUP_MARKER) ? args.slice(0, -BB_WAKEUP_MARKER.length) : undefined;
}

function clampDelay(seconds: number): number {
  return Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(seconds)));
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

type LoopCommand =
  | { kind: "stop" }
  | { kind: "usage"; reason?: string }
  | { kind: "fixed"; seconds: number; prompt: string }
  | { kind: "dynamic"; prompt: string };

function parseLoop(args: string): LoopCommand {
  const text = args.trim();
  if (!text) return { kind: "usage" };
  if (text === "stop") return { kind: "stop" };
  const m = /^(\d+)([smhd])(?:\s+([\s\S]+))?$/.exec(text);
  if (m) {
    const seconds = Number(m[1]) * UNIT_SECONDS[m[2]];
    if (!m[3]) return { kind: "usage" };
    if (seconds > MAX_LOOP_S) return { kind: "usage", reason: "Intervals over 24 days are not supported." };
    return { kind: "fixed", seconds, prompt: m[3].trim() };
  }
  return { kind: "dynamic", prompt: text };
}

function dynamicPrompt(prompt: string): string {
  return (
    `${prompt}\n\n` +
    `[/loop, self-paced] When this iteration is done, call schedule_wakeup with prompt "/loop ${prompt}" ` +
    `and a delay that fits what you are waiting for (${MIN_DELAY_S} to ${MAX_DELAY_S} seconds) to run it again. ` +
    `Skip the call to end the loop.`
  );
}

// model-only exposure keeps the tool declared under codemode.mode "only".
export function registerSchedule(pi: ExtensionAPI, scheduler: Scheduler, oneShot: OneShot, bb: BbEnv | undefined): void {
  // The prompt's author picks the role: the user's /loop sends user messages, and text the agent chose
  // goes in as a custom message, which the permission classifier does not read as the user's ask. Pi
  // expands slash text only in a user message, so the agent's is expanded before it is sent.
  const sendAsUser: Send = (prompt) => pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: true });
  const sendAsAgent =
    (ctx: ExtensionContext): Send =>
    (prompt) => {
      let content = prompt;
      try {
        content = expandSlash(pi.getCommands(), prompt);
      } catch (e) {
        ctx.ui.notify(`A wakeup's command could not be expanded and was sent as written: ${errorText(e)}`, "error");
      }
      pi.sendMessage({ customType: AGENT_PROMPT_TYPE, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
    };
  const wakeups: Wakeups = bb
    ? new BbWakeups(new BbCli(bb.cli), bb.threadId, () => pi.getCommands())
    : {
        delivery: "once the session is idle",
        async schedule(seconds, prompt, ctx) {
          // A custom message runs no command, so the agent's "/loop ..." re-arm runs the loop here.
          const send = sendAsAgent(ctx);
          const loop = LOOP_COMMAND.exec(prompt);
          const deliver = loop
            ? () => void runLoop(loop[1] ?? "", ctx, send).catch((e) => ctx.ui.notify(`/loop from a wakeup failed: ${errorText(e)}`, "error"))
            : () => send(prompt);
          scheduler.scheduleWakeup(seconds, deliver, ctx);
          return { fireAt: new Date(Date.now() + seconds * 1000) };
        },
        cancel: async () => scheduler.cancelWakeup(),
      };

  pi.registerTool({
    name: "schedule_wakeup",
    label: "Schedule wakeup",
    exposure: "model-only",
    description: `Schedule this session to be re-invoked with a prompt after delaySeconds (clamped to ${MIN_DELAY_S}-${MAX_DELAY_S}), ${wakeups.delivery}. One wakeup is pending at a time: a new call replaces it, and stop: true cancels it. Used by /loop's self-paced mode.`,
    parameters: wakeupParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.stop) {
        // What is pending in a sealed slot is a loop start the user asked for, not this run's.
        // A one-shot run never scheduled one, and inside bb a pi child would otherwise reach its parent thread's.
        const had = !scheduler.sealed && !oneShot.exits(ctx) && (await wakeups.cancel());
        const text = had ? "Pending wakeup cancelled." : "No wakeup was pending.";
        return { content: [{ type: "text", text }], details: { cancelled: had } };
      }
      if (params.delaySeconds === undefined || !params.prompt) {
        throw new Error("schedule_wakeup needs delaySeconds and prompt unless stop is true.");
      }
      if (scheduler.sealed) {
        ctx.ui.notify("A wakeup this run asked for was not scheduled: /loop ended or replaced the loop while it ran.", "warning");
        return {
          content: [{ type: "text", text: "Not scheduled: the user ended or replaced the loop with a /loop command during this run. Do not schedule another wakeup in this run." }],
          details: { refused: true },
        };
      }
      if (oneShot.exits(ctx)) {
        throw new Error(`schedule_wakeup cannot fire in a ${ctx.mode} run: pi exits when this run ends. Finish the work in this run instead.`);
      }
      const seconds = clampDelay(params.delaySeconds);
      const { fireAt: due, id } = await wakeups.schedule(seconds, params.prompt, ctx);
      const fireAt = due.toISOString();
      const clamped = seconds !== params.delaySeconds ? ` (clamped from ${params.delaySeconds})` : "";
      const held = id ? ` bb holds it as queued message ${id}.` : "";
      return {
        content: [{ type: "text", text: `Wakeup scheduled in ${seconds}s${clamped}, at ${fireAt}. It replaces any earlier pending wakeup.${held}` }],
        details: { delaySeconds: seconds, fireAt, noop: params.noop === true, ...(id && { id }) },
      };
    },
  });

  pi.on("agent_start", () => {
    scheduler.running = true;
  });
  pi.on("agent_settled", () => {
    scheduler.running = false;
    scheduler.sealed = false;
  });

  async function runLoop(args: string, ctx: ExtensionContext, send: Send): Promise<void> {
    const cmd = parseLoop(args);
    // Also true during a manual compaction, which no run is behind: the first
    // prompt then waits for idle, but only a run in flight seals the slot.
    const midRun = !ctx.isIdle();
    // sendUserMessage only starts the run, and a one-shot run disposes the
    // session as soon as the command returns, so there the command waits it out.
    const fire = async (prompt: string) => {
      // The slot is sealed against the run in flight, so the loop's first
      // prompt takes the slot and runs once that run has settled. Its own
      // re-arm then comes from a later run and is not refused.
      if (midRun) {
        scheduler.scheduleWakeup(0, () => send(prompt), ctx);
        ctx.ui.notify("The loop starts once the session is idle.", "info");
        return;
      }
      if (!oneShot.exits(ctx)) {
        send(prompt);
        return;
      }
      await oneShot.assertStartsRun(prompt, ctx);
      const settled = oneShot.untilSettled();
      send(prompt);
      await settled;
    };
    switch (cmd.kind) {
      case "usage":
        ctx.ui.notify(`${cmd.reason ? `${cmd.reason} ` : ""}Usage: /loop [interval like 5m or 1h] <prompt>, or /loop stop`, "info");
        return;
      case "stop": {
        const stopped = scheduler.stopAll(scheduler.running);
        const cancelled = await wakeups.cancel();
        ctx.ui.notify(stopped || cancelled ? "Loop stopped." : "No loop was running.", "info");
        return;
      }
      case "fixed": {
        if (wakeups.fixedLoopRefusal) {
          ctx.ui.notify(wakeups.fixedLoopRefusal, "warning");
          return;
        }
        const seconds = Math.max(MIN_DELAY_S, cmd.seconds);
        scheduler.stopAll(scheduler.running);
        scheduler.startLoop(seconds, () => send(cmd.prompt), ctx);
        ctx.ui.notify(`Looping every ${seconds}s. /loop stop ends it.`, "info");
        await fire(cmd.prompt);
        return;
      }
      case "dynamic":
        scheduler.stopAll(scheduler.running);
        await wakeups.cancel();
        scheduler.startSelfPaced();
        await fire(dynamicPrompt(cmd.prompt));
    }
  }

  pi.registerCommand("loop", {
    description: "Run a prompt on an interval (/loop 5m <prompt>), self-paced (/loop <prompt>), or stop (/loop stop)",
    // A wakeup bb delivers runs /loop as the user's command, but what that loop sends is still the agent's.
    handler: (args, ctx) => {
      const own = bbWakeupLoop(args);
      return own === undefined ? runLoop(args, ctx, sendAsUser) : runLoop(own, ctx, sendAsAgent(ctx));
    },
  });
}
