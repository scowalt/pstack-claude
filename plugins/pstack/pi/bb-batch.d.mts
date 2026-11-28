export interface BatchTiming {
  pollMs: number;
  heartbeatMs: number;
  deadlineS: number;
  staleMs: number;
  boundMs: number;
  maxMs: number;
}

export const DEFAULT_TIMING: BatchTiming;

export class Batches {
  constructor(options: { cli: string; threadId: string; dir: string; timing?: BatchTiming });
  join(start: () => Promise<string>): Promise<string>;
  join(start: () => Promise<unknown>, known: string): Promise<string>;
  pendingBatchOf(id: string): Promise<string | undefined>;
  seal(): Promise<void>;
  ensure(): Promise<void>;
}

export function track(path: string): Promise<void>;
