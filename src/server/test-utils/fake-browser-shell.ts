import { createServer, type Server } from 'node:http';
import type { ShellControlClient, ShellViewEvent } from '../services/browser-shell-client.js';
import type { BrowserCdpTarget } from '../services/browser-target.js';

/**
 * Shared fakes for browser-service tests on the native stack (U9): a fake
 * KTD-11 control client (createView/destroyView/wipePartition + a synchronous
 * stand-in for the SSE event stream) plus a fake /json debug-port endpoint
 * that echoes the last created view's marker. Inject into BrowserService via
 * the `resolveTarget` + `createControlClient` deps:
 *
 *   resolveTarget: shell.resolveTarget,
 *   createControlClient: shell.createControlClient,
 *
 * The REAL control channel + SSE stream are covered end to end in
 * services/__tests__/browser-service-shell.test.ts.
 */

export class FakeControlClient {
  readonly calls: Array<{ method: string; sessionId?: string }> = [];
  readonly reconcileKeeps: string[][] = [];
  lastMarker: string | null = null;
  failCreate: Error | null = null;
  private readonly liveViews = new Set<string>();
  private listener: ((event: ShellViewEvent) => void) | null = null;
  private connectListener: (() => void) | null = null;

  async createView({ sessionId, marker }: { sessionId: string; marker: string }) {
    this.calls.push({ method: 'createView', sessionId });
    if (this.failCreate) throw this.failCreate;
    this.lastMarker = marker;
    this.liveViews.add(sessionId);
    return {
      partition: `persist:comate-browser-${sessionId}`,
      targetMarker: marker,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: null,
      },
    };
  }

  async destroyView(sessionId: string) {
    this.calls.push({ method: 'destroyView', sessionId });
    this.liveViews.delete(sessionId);
    return true;
  }

  /** GET /views/:id/state equivalent: definite answer, never throws. */
  async viewExists(sessionId: string) {
    return this.liveViews.has(sessionId);
  }

  async wipePartition(sessionId: string) {
    this.calls.push({ method: 'wipePartition', sessionId });
  }

  async reconcilePartitions(keep: string[]) {
    this.reconcileKeeps.push(keep);
    return { removed: [], errors: [] };
  }

  subscribeEvents(listener: (event: ShellViewEvent) => void, onConnect?: () => void): () => void {
    this.listener = listener;
    this.connectListener = onConnect ?? null;
    // The fake "connects" synchronously, like the real client's initial 200.
    this.connectListener?.();
    return () => {
      this.listener = null;
      this.connectListener = null;
    };
  }

  /** Synchronous stand-in for the shell's SSE stream. */
  emit(event: ShellViewEvent): void {
    this.listener?.(event);
  }

  /** The view vanished shell-side without any event (SSE outage window). */
  vanishView(sessionId: string): void {
    this.liveViews.delete(sessionId);
  }

  /** Simulates the SSE stream re-establishing after a drop. */
  simulateReconnect(): void {
    this.connectListener?.();
  }

  callsFor(method: string, sessionId?: string): Array<{ method: string; sessionId?: string }> {
    return this.calls.filter(
      (c) => c.method === method && (sessionId === undefined || c.sessionId === sessionId),
    );
  }
}

export interface FakeBrowserShell {
  client: FakeControlClient;
  debugPort: number;
  /** BrowserService dep: a shell target pointing at the fake debug port. */
  resolveTarget: () => BrowserCdpTarget;
  /** BrowserService dep: always returns the fake client. */
  createControlClient: () => ShellControlClient;
  close: () => Promise<void>;
}

/** The baseUrl a shell view handle reports for the fake debug port. */
export function fakeViewBaseUrl(debugPort: number, targetId = 'VIEW-TARGET-1'): string {
  return `http://127.0.0.1:${debugPort}/__comate-cdp__/t/${targetId}`;
}

export async function startFakeBrowserShell(options?: {
  serveJson?: boolean;
}): Promise<FakeBrowserShell> {
  const client = new FakeControlClient();
  const serveJson = options?.serveJson !== false;

  // Fake debug port: /json/list echoes the last view's marker URL.
  const jsonServer: Server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { id: 'UI-TARGET', type: 'page', url: 'app.comate://localhost/index.html' },
          ...(serveJson && client.lastMarker
            ? [{ id: 'VIEW-TARGET-1', type: 'page', url: `about:blank#${client.lastMarker}` }]
            : []),
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => jsonServer.listen(0, '127.0.0.1', () => resolve()));
  const address = jsonServer.address();
  if (!address || typeof address === 'string') throw new Error('json server did not bind');
  const debugPort = address.port;

  return {
    client,
    debugPort,
    resolveTarget: () => ({
      kind: 'shell',
      debugPort,
      controlPort: 1,
      controlToken: 'fake-tok',
    }),
    createControlClient: () => client as unknown as ShellControlClient,
    close: () => new Promise<void>((resolve) => jsonServer.close(() => resolve())),
  };
}
