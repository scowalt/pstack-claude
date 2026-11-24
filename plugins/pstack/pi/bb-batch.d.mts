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
  seal(): Promise<void>;
  ensure(): Promise<void>;
}

export function track(path: string): Promise<void>;
