// The bb CLI as the agent tools and the batch tracker call it. Plain
// JavaScript, so node runs the tracker on its own, outside pi.
import { spawn } from "node:child_process";

import { OUTPUT_CAP_BYTES, truncateUtf8 } from "./text-cap.mjs";

export const RUNNING = new Set(["pending", "starting", "active", "stopping"]);

// A bb call that hangs would otherwise hold the detached batch tracker forever.
export const CALL_TIMEOUT_MS = 60_000;

// With --json, bb prints {"ok": false, "error": {message, hint}} on a failure.
export function failure(args, r) {
  try {
    const { message, hint } = JSON.parse(r.stdout).error;
    if (message) return new Error(`bb ${args.slice(0, 2).join(" ")}: ${message}${hint ? ` (${hint})` : ""}`);
  } catch {}
  return new Error(`bb ${args.slice(0, 2).join(" ")} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 1000)}`);
}

export class BbCli {
  constructor(cli) {
    this.cli = cli;
  }

  run(args, { input, signal, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cli, args, { stdio: ["pipe", "pipe", "pipe"], signal });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
      child.on("error", (e) => (clearTimeout(timer), reject(e)));
      child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr })));
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    });
  }

  async json(args, input) {
    const r = await this.run([...args, "--json"], { input });
    if (r.code !== 0) throw failure(args, r);
    return JSON.parse(r.stdout);
  }
}

export function resultText(id, description, { status, output }) {
  const capped = truncateUtf8(output, OUTPUT_CAP_BYTES);
  const tail = capped === output ? "" : `\n\n[Output truncated at ${OUTPUT_CAP_BYTES / 1024} KB. Full output: bb thread output ${id}]`;
  return `agentId: ${id}\ndescription: ${description}\nstatus: ${status}\nthread: @thread:${id}\n\n${capped}${tail}`;
}
