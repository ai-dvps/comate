export type BrowserTaskTraceInput =
  | { kind: 'operation_intent'; taskId: string; taskVersion: number; operationId: string; slotKey: string; operationClass: BrowserTaskOperationClass }
  | { kind: 'receipt'; taskId: string; taskVersion: number; operationId: string; outcome: 'not_dispatched' | 'dispatched_verified' | 'outcome_unknown' }
  | { kind: 'observation'; taskId: string; taskVersion: number; observationId: string; accepted: boolean }
  | { kind: 'validation'; taskId: string; taskVersion: number; slotKey: string; accepted: boolean }
  | { kind: 'recovery'; taskId: string; taskVersion: number; category: 'off_viewport' | 'task_overlay'; claimed: boolean }
  | { kind: 'approval'; taskId: string; taskVersion: number; approved: boolean }
  | { kind: 'transition'; taskId: string; taskVersion: number; from: BrowserTaskTraceLifecycle; to: BrowserTaskTraceLifecycle; reason: BrowserTaskTransitionReason }
  | { kind: 'handoff'; taskId: string; taskVersion: number; disposition: 'requested' | 'returned' | 'cancelled' }
  | { kind: 'terminal'; taskId: string; taskVersion: number; lifecycle: 'blocked' | 'outcome-unknown' | 'complete' | 'abandoned' };

export type BrowserTaskOperationClass = 'field' | 'file' | 'declaration' | 'activation' | 'submit' | 'navigation' | 'control' | 'unclassified';
export type BrowserTaskTraceLifecycle = 'active' | 'awaiting-user' | 'validating' | 'ready' | 'blocked' | 'outcome-unknown' | 'complete' | 'abandoned';
export type BrowserTaskTransitionReason = 'discovery' | 'mutation' | 'validation' | 'authority' | 'approval' | 'recovery' | 'outcome' | 'policy' | 'user' | 'runtime';

export type BrowserTaskTraceEvent = Readonly<
  (BrowserTaskTraceInput | { kind: 'trace_loss'; lostCount: number }) & { sequence: number; monotonicMs: number }
>;

/**
 * Process-local diagnostic trace. It is deliberately positive-shape and has
 * no callback that can mutate task state or authorize dispatch.
 */
export class BrowserTaskTrace {
  private readonly events: BrowserTaskTraceEvent[] = [];
  private readonly listeners = new Set<(event: BrowserTaskTraceEvent) => void>();
  private sequence = 0;
  private lostCount = 0;

  constructor(private readonly capacity = 128, private readonly now: () => number = () => performance.now()) {
    if (!Number.isSafeInteger(capacity) || capacity < 2 || capacity > 4096) {
      throw new Error('invalid_browser_task_trace_capacity');
    }
  }

  append(input: BrowserTaskTraceInput): void {
    if (this.events.length >= this.capacity) {
      this.events.shift();
      this.lostCount += 1;
      const loss = Object.freeze({ kind: 'trace_loss' as const, lostCount: this.lostCount, sequence: ++this.sequence, monotonicMs: this.now() });
      if (this.events[0]?.kind === 'trace_loss') this.events.shift();
      this.events.unshift(loss);
      this.publish(loss);
      while (this.events.length >= this.capacity) this.events.splice(1, 1);
    }
    const event = Object.freeze({ ...input, sequence: ++this.sequence, monotonicMs: this.now() }) as BrowserTaskTraceEvent;
    this.events.push(event);
    this.publish(event);
  }

  snapshot(): readonly BrowserTaskTraceEvent[] {
    return Object.freeze([...this.events]);
  }

  subscribe(listener: (event: BrowserTaskTraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(event: BrowserTaskTraceEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* diagnostics never affect task authority */ }
    }
  }
}

export const browserTaskTrace = new BrowserTaskTrace();
