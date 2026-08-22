import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export class CodexRpcClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  private readonly lines: readline.Interface;

  constructor(private readonly input: Readable, private readonly output: Writable) {
    super();
    this.lines = readline.createInterface({ input });
    this.lines.on('line', (line) => this.receive(line));
    input.once('end', () => this.close(new Error('Codex app-server closed stdout')));
    input.once('error', (error) => this.close(error));
    output.on('error', (error) => this.close(error));
  }

  request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  respond(id: string | number, result?: unknown, error?: unknown): void {
    this.write(error === undefined ? { id, result } : { id, error });
  }

  close(error = new Error('Codex RPC client closed')): void {
    this.lines.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private receive(line: string): void {
    let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('protocolError', new Error('Codex app-server emitted malformed JSON'));
      return;
    }
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexRpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      this.emit(message.id === undefined ? 'notification' : 'request', message);
    }
  }

  private write(message: unknown): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
