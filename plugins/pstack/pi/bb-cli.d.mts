export const RUNNING: ReadonlySet<string>;
export const TRACKER_CALL_TIMEOUT_MS: number;

export interface BbRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function failure(args: string[], r: BbRun): Error;

export class BbCli {
  constructor(cli: string, options?: { timeoutMs?: number });
  readonly cli: string;
  readonly timeoutMs?: number;
  run(args: string[], options?: { input?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<BbRun>;
  json<T = unknown>(args: string[], input?: string): Promise<T>;
}

export function resultText(id: string, description: string, result: { status: string; output: string }): string;
