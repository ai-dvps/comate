export class PushableIterator<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private deferred: {
    resolve: (result: IteratorResult<T>) => void;
  } | null = null;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;

    if (this.deferred) {
      const resolve = this.deferred.resolve;
      this.deferred = null;
      resolve({ value, done: false });
      return;
    }

    this.queue.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.deferred) {
      const resolve = this.deferred.resolve;
      this.deferred = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return { value, done: false };
        }

        if (this.closed) {
          return { value: undefined as unknown as T, done: true };
        }

        return new Promise<IteratorResult<T>>((resolve) => {
          this.deferred = { resolve };
        });
      },
    };
  }
}
