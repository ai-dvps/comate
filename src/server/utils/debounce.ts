export interface DebouncedFunction<T extends (...args: unknown[]) => void> {
  (...args: Parameters<T>): void;
  flush(): void;
  abort(): void;
}

export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  waitMs: number,
): DebouncedFunction<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  const debounced = (...args: Parameters<T>) => {
    lastArgs = args;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...lastArgs!);
    }, waitMs);
  };

  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      fn(...lastArgs!);
    }
  };

  debounced.abort = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  return debounced;
}
