export interface ApiInfo {
  port: number;
  token: string;
}

export interface ApiInfoLatch {
  wait(): Promise<ApiInfo>;
  succeed(info: ApiInfo): void;
  fail(error: Error): void;
}

/**
 * Coordinates renderer requests with the one-shot sidecar ready handshake.
 * Early callers wait instead of producing expected IPC errors during boot.
 */
export function createApiInfoLatch(): ApiInfoLatch {
  let resolveReady!: (info: ApiInfo) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<ApiInfo>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  // The shell can fail before a renderer asks for API info. Mark the shared
  // promise as observed while preserving rejection for every wait() caller.
  void ready.catch(() => undefined);

  return {
    wait: () => ready,
    succeed: resolveReady,
    fail: rejectReady,
  };
}
