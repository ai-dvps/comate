import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { WebSocketServer } from 'ws';
import {
  CdpConnection,
  CdpNetworkCaptureTransport,
  connectShellPage,
  retryDuringColdStart,
} from '../browser-cdp.js';
import type { CdpEventEnvelope } from '../browser-network-capture.js';

describe('CdpConnection event envelopes', () => {
  it('preserves flattened sessionId and listener teardown', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const peerPromise = new Promise<import('ws').WebSocket>((resolve) => server.once('connection', resolve));
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${address.port}`);
    const peer = await peerPromise;

    const event = new Promise<{ method: string; sessionId?: string; params: unknown }>((resolve) => {
      const off = connection.onEvent((envelope) => {
        off();
        resolve(envelope);
      });
    });
    peer.send(JSON.stringify({
      method: 'Network.requestWillBeSent',
      sessionId: 'child-session',
      params: { requestId: 'same-id' },
    }));
    assert.deepEqual(await event, {
      method: 'Network.requestWillBeSent',
      sessionId: 'child-session',
      params: { requestId: 'same-id' },
    });

    let calls = 0;
    const off = connection.onEvent(() => { calls += 1; });
    off();
    peer.send(JSON.stringify({ method: 'Network.loadingFinished', params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 0);
    connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('BrowserCdpSession lifecycle', () => {
  it('invalidates document identity when the debugger connection closes', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const peerPromise = new Promise<import('ws').WebSocket>((resolve) => {
      server.once('connection', (peer) => {
        peer.on('message', (raw) => {
          const command = JSON.parse(String(raw)) as { id: number; method: string };
          const result = command.method === 'Target.attachToTarget'
            ? { sessionId: 'page-session' }
            : command.method === 'Page.getFrameTree'
              ? { frameTree: { frame: { id: 'main-frame', loaderId: 'loader-1' } } }
              : {};
          peer.send(JSON.stringify({ id: command.id, result }));
        });
        resolve(peer);
      });
    });
    const page = await connectShellPage({
      port: address.port, browserWsUrl: `ws://127.0.0.1:${address.port}`,
      targetId: 'page-target', fingerprint: false, connectReadyTimeoutMs: 0,
    });
    const peer = await peerPromise;
    assert.ok(page.getDocumentIdentity?.());
    const closed = new Promise<void>((resolve) => page.onClose(resolve));
    peer.close();
    await closed;
    assert.equal(page.getDocumentIdentity?.(), null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('closes the page session when its flattened target detaches', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const peerPromise = new Promise<import('ws').WebSocket>((resolve) => {
      server.once('connection', (peer) => {
        peer.on('message', (raw) => {
          const command = JSON.parse(String(raw)) as { id: number; method: string };
          const result = command.method === 'Target.attachToTarget'
            ? { sessionId: 'page-session' }
            : command.method === 'Page.getFrameTree'
              ? { frameTree: { frame: { id: 'main-frame', loaderId: 'loader-1' } } }
            : {};
          peer.send(JSON.stringify({ id: command.id, result }));
        });
        resolve(peer);
      });
    });

    const page = await connectShellPage({
      port: address.port,
      browserWsUrl: `ws://127.0.0.1:${address.port}`,
      targetId: 'page-target',
      fingerprint: false,
      connectReadyTimeoutMs: 0,
    });
    const peer = await peerPromise;
    let closeCalls = 0;
    let closeTimeout: NodeJS.Timeout | undefined;
    const closed = new Promise<void>((resolve) => {
      page.onClose(() => {
        closeCalls += 1;
        resolve();
      });
    });
    const closedOrTimedOut = Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        closeTimeout = setTimeout(
          () => reject(new Error('target detach did not close the page session')),
          1_000,
        );
      }),
    ]);

    try {
      const initial = page.getDocumentIdentity?.();
      assert.deepEqual(initial, {
        targetId: 'page-target', sessionId: 'page-session', frameId: 'main-frame', loaderId: 'loader-1', generation: 0,
      });
      peer.send(JSON.stringify({
        method: 'Page.frameNavigated', sessionId: 'page-session',
        params: { frame: { id: 'main-frame', loaderId: 'loader-1', url: 'https://example.test/#hash' } },
      }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepEqual(page.getDocumentIdentity?.(), initial, 'hash/history navigation with the same loader keeps refs');
      peer.send(JSON.stringify({ method: 'Runtime.executionContextDestroyed', sessionId: 'page-session', params: { executionContextId: 1 } }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(page.getDocumentIdentity?.()?.generation, 1, 'execution-context destruction invalidates the document generation');
      peer.send(JSON.stringify({ method: 'DOM.documentUpdated', sessionId: 'page-session', params: {} }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(page.getDocumentIdentity?.()?.generation, 2, 'document replacement invalidates the document generation');
      peer.send(JSON.stringify({
        method: 'Page.frameNavigated', sessionId: 'page-session',
        params: { frame: { id: 'main-frame', loaderId: 'loader-2', url: 'https://example.test/next' } },
      }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(page.getDocumentIdentity?.()?.loaderId, 'loader-2');
      peer.send(JSON.stringify({
        method: 'Target.detachedFromTarget',
        params: { sessionId: 'page-session', targetId: 'page-target' },
      }));
      await closedOrTimedOut;

      assert.equal(page.closed, true);
      assert.equal(page.getDocumentIdentity?.(), null);
      assert.equal(closeCalls, 1);
    } finally {
      if (closeTimeout) clearTimeout(closeTimeout);
      page.close();
      assert.equal(closeCalls, 1, 'target detach and connection close notify once');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('BrowserCdpSession exact-object extraction', () => {
  it('describes retained candidate handles and releases the object group without XPath search', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    const peerPromise = new Promise<import('ws').WebSocket>((resolve) => {
      server.once('connection', (peer) => {
        peer.on('message', (raw) => {
          const command = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> };
          commands.push(command);
          let result: unknown = {};
          if (command.method === 'Target.attachToTarget') result = { sessionId: 'page-session' };
          else if (command.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'main', loaderId: 'loader' } } };
          else if (command.method === 'Runtime.evaluate') result = { result: { type: 'object', objectId: 'root' } };
          else if (command.method === 'Runtime.getProperties' && command.params.objectId === 'root') {
            result = { result: [{ name: 'identityObjects', value: { objectId: 'identities' } }] };
          } else if (command.method === 'Runtime.getProperties') {
            result = { result: [{ name: '0', value: { objectId: 'exact-node' } }, { name: 'length', value: { value: 1 } }] };
          } else if (command.method === 'Runtime.callFunctionOn') {
            result = { result: { value: {
              url: 'https://example.test/', title: 'Example', docId: 'diagnostic', domEpoch: 0,
              forms: [], standalone: [], contentText: '', contentTruncated: false, alerts: [],
              stats: { linkCount: 0, buttonCount: 0, hasPasswordField: false },
            } } };
          } else if (command.method === 'DOM.describeNode') result = { node: { backendNodeId: 42 } };
          peer.send(JSON.stringify({ id: command.id, result }));
        });
        resolve(peer);
      });
    });
    const page = await connectShellPage({
      port: address.port, browserWsUrl: `ws://127.0.0.1:${address.port}`,
      targetId: 'page-target', fingerprint: false, connectReadyTimeoutMs: 0,
    });
    await peerPromise;
    const bundle = await page.extractPageModel?.('(() => ({ identityObjects: [document.body] }))()');
    assert.deepEqual(bundle?.backendNodeIds, [42]);
    assert.ok(commands.some((command) => command.method === 'Runtime.evaluate' && command.params.includeCommandLineAPI === true));
    assert.ok(commands.some((command) => command.method === 'DOM.describeNode' && command.params.objectId === 'exact-node'));
    assert.equal(commands.some((command) => command.method === 'DOM.performSearch'), false);
    assert.ok(commands.some((command) => command.method === 'Runtime.releaseObjectGroup'));
    page.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('BrowserCdpSession trusted interaction adapter', () => {
  async function withInteractionPeer(
    respond: (command: { id: number; method: string; params: Record<string, unknown> }) =>
      | unknown
      | { protocolError: { code: number; message: string } }
      | undefined,
  ): Promise<{
    page: Awaited<ReturnType<typeof connectShellPage>>;
    commands: Array<{ method: string; params: Record<string, unknown> }>;
    close: () => Promise<void>;
  }> {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    server.once('connection', (peer) => {
      peer.on('message', (raw) => {
        const command = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> };
        commands.push({ method: command.method, params: command.params });
        let result: unknown;
        if (command.method === 'Target.attachToTarget') result = { sessionId: 'page-session' };
        else if (command.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'main-frame', loaderId: 'loader-1' } } };
        else result = respond(command);
        if (result !== undefined) {
          const protocolError = result && typeof result === 'object' && 'protocolError' in result
            ? (result as { protocolError: { code: number; message: string } }).protocolError
            : undefined;
          peer.send(JSON.stringify(protocolError
            ? { id: command.id, error: protocolError }
            : { id: command.id, result }));
        }
      });
    });
    const page = await connectShellPage({
      port: address.port,
      browserWsUrl: `ws://127.0.0.1:${address.port}`,
      targetId: 'page-target',
      fingerprint: false,
      connectReadyTimeoutMs: 0,
      commandTimeoutMs: 25,
    });
    return {
      page,
      commands,
      close: async () => {
        page.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it('scrolls, hit-tests, and emits exactly one trusted mouse press/release pair', async () => {
    const peer = await withInteractionPeer((command) => {
      if (command.method === 'DOM.resolveNode') return { object: { objectId: 'target-node' } };
      if (command.method === 'Runtime.callFunctionOn') {
        return { result: { value: { connected: true, enabled: true } } };
      }
      if (command.method === 'DOM.getBoxModel') {
        return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } };
      }
      if (command.method === 'DOM.getNodeForLocation') {
        return { backendNodeId: 42, frameId: 'main-frame' };
      }
      return {};
    });
    try {
      const receipt = await peer.page.clickBackendNode(42);
      assert.deepEqual(receipt, {
        outcome: 'dispatched_verified',
        dispatchState: 'dispatched',
        verified: true,
        retrySafe: false,
        delta: { kind: 'activation', changed: false },
      });
      assert.deepEqual(
        peer.commands.filter((command) => command.method === 'Input.dispatchMouseEvent').map((command) => command.params.type),
        ['mousePressed', 'mouseReleased'],
      );
      assert.equal(
        peer.commands.some((command) => command.method === 'Runtime.callFunctionOn' && String(command.params.functionDeclaration).includes('.click(')),
        false,
      );
    } finally {
      await peer.close();
    }
  });

  it('rechecks authority after hit-testing and immediately before mouse dispatch', async () => {
    const peer = await withInteractionPeer((command) => {
      if (command.method === 'DOM.resolveNode') return { object: { objectId: 'target-node' } };
      if (command.method === 'Runtime.callFunctionOn') {
        return { result: { value: { connected: true, enabled: true } } };
      }
      if (command.method === 'DOM.getBoxModel') {
        return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } };
      }
      if (command.method === 'DOM.getNodeForLocation') {
        return { backendNodeId: 42, frameId: 'main-frame' };
      }
      return {};
    });
    try {
      let commandsAtAuthorization = 0;
      const receipt = await peer.page.clickBackendNode(42, () => {
        commandsAtAuthorization = peer.commands.length;
        return false;
      });
      assert.equal(receipt.outcome, 'not_dispatched');
      assert.equal(receipt.reason, 'cancelled');
      assert.ok(peer.commands.slice(0, commandsAtAuthorization).some((command) => command.method === 'DOM.getNodeForLocation'));
      assert.equal(peer.commands.some((command) => command.method === 'Input.dispatchMouseEvent'), false);
    } finally {
      await peer.close();
    }
  });

  it('does not dispatch when the fresh hit test is occluded', async () => {
    const peer = await withInteractionPeer((command) => {
      if (command.method === 'DOM.getBoxModel') {
        return { model: { content: [0, 0, 40, 0, 40, 40, 0, 40] } };
      }
      if (command.method === 'DOM.getNodeForLocation') {
        return { backendNodeId: 99, frameId: 'main-frame' };
      }
      if (command.method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
      if (command.method === 'Runtime.callFunctionOn') {
        return String(command.params.functionDeclaration).includes('target.contains')
          ? { result: { value: false } }
          : { result: { value: { connected: true, enabled: true } } };
      }
      return {};
    });
    try {
      const receipt = await peer.page.clickBackendNode(42);
      assert.equal(receipt.outcome, 'not_dispatched');
      assert.equal(receipt.retrySafe, true);
      assert.equal(receipt.reason, 'target_occluded');
      assert.equal(peer.commands.some((command) => command.method === 'Input.dispatchMouseEvent'), false);
    } finally {
      await peer.close();
    }
  });

  it('returns unknown and prohibits retry when the mouse press may have timed out', async () => {
    const peer = await withInteractionPeer((command) => {
      if (command.method === 'DOM.resolveNode') return { object: { objectId: 'target-node' } };
      if (command.method === 'Runtime.callFunctionOn') {
        return { result: { value: { connected: true, enabled: true } } };
      }
      if (command.method === 'DOM.getBoxModel') {
        return { model: { content: [0, 0, 40, 0, 40, 40, 0, 40] } };
      }
      if (command.method === 'DOM.getNodeForLocation') {
        return { backendNodeId: 42, frameId: 'main-frame' };
      }
      if (command.method === 'Input.dispatchMouseEvent' && command.params.type === 'mousePressed') return undefined;
      return {};
    });
    try {
      const receipt = await peer.page.clickBackendNode(42);
      assert.equal(receipt.outcome, 'outcome_unknown');
      assert.equal(receipt.dispatchState, 'dispatched');
      assert.equal(receipt.retrySafe, false);
      assert.deepEqual(
        peer.commands.filter((command) => command.method === 'Input.dispatchMouseEvent').map((command) => command.params.type),
        ['mousePressed'],
      );
    } finally {
      await peer.close();
    }
  });

  it('does not retarget or dispatch when the approved node disappears during geometry lookup', async () => {
    const peer = await withInteractionPeer((command) => {
      if (command.method === 'DOM.resolveNode') return { object: { objectId: 'target-node' } };
      if (command.method === 'Runtime.callFunctionOn') {
        return { result: { value: { connected: true, enabled: true } } };
      }
      if (command.method === 'DOM.getBoxModel') {
        return { protocolError: { code: -32000, message: 'Could not find node with given id' } };
      }
      return {};
    });
    try {
      const receipt = await peer.page.clickBackendNode(42);
      assert.equal(receipt.outcome, 'not_dispatched');
      assert.equal(receipt.reason, 'target_unavailable');
      assert.equal(peer.commands.some((command) => command.method === 'Input.dispatchMouseEvent'), false);
    } finally {
      await peer.close();
    }
  });

  it('replaces long Chinese textarea text and returns only normalized verification metadata', async () => {
    const text = `第一段\n第二段 😀\n${'长文本'.repeat(5_000)}`;
    let calls = 0;
    const peer = await withInteractionPeer((command) => {
      if (command.method === 'DOM.resolveNode') return { object: { objectId: 'textarea-node' } };
      if (command.method === 'Runtime.callFunctionOn') {
        calls += 1;
        return calls === 1
          ? { result: { value: { kind: 'textarea', editable: true } } }
          : { result: { value: { matches: true, normalizedLength: text.length } } };
      }
      return {};
    });
    try {
      const receipt = await peer.page.fillBackendNode(51, text);
      assert.equal(receipt.outcome, 'dispatched_verified');
      assert.equal(receipt.verified, true);
      assert.equal(receipt.matchesRequested, true);
      assert.equal(receipt.normalizedLength, text.length);
      assert.equal(JSON.stringify(receipt).includes('第一段'), false, 'receipt never echoes supplied text');
      assert.deepEqual(
        peer.commands.filter((command) => command.method === 'Input.insertText').map((command) => command.params.text),
        [text],
      );
    } finally {
      await peer.close();
    }
  });

  it('assigns staged paths exactly once and verifies only the bounded file count', async () => {
    const peer = await withInteractionPeer((command) => {
      if (command.method === 'DOM.resolveNode') return { object: { objectId: 'file-node' } };
      if (command.method === 'Runtime.callFunctionOn') return { result: { value: true } };
      return {};
    });
    try {
      const paths = ['/private/staging/a.png', '/private/staging/b.png'];
      const receipt = await peer.page.setFileInputFiles!(61, paths);
      assert.equal(receipt.outcome, 'dispatched_verified');
      const assignments = peer.commands.filter((command) => command.method === 'DOM.setFileInputFiles');
      assert.equal(assignments.length, 1);
      assert.deepEqual(assignments[0].params, { backendNodeId: 61, files: paths });
      assert.equal(JSON.stringify(receipt).includes('/private/staging'), false);
    } finally {
      await peer.close();
    }
  });

  it('falls back to a bounded CDP key event for contenteditable when Input.insertText is unsupported', async () => {
    const text = '中文段落\n第二行 😀';
    let calls = 0;
    const peer = await withInteractionPeer((command) => {
      if (command.method === 'DOM.resolveNode') return { object: { objectId: 'editable-node' } };
      if (command.method === 'Runtime.callFunctionOn') {
        calls += 1;
        return calls === 1
          ? { result: { value: { kind: 'contenteditable', editable: true } } }
          : { result: { value: { matches: true, normalizedLength: text.length } } };
      }
      if (command.method === 'Input.insertText') {
        return { protocolError: { code: -32601, message: "'Input.insertText' wasn't found" } };
      }
      return {};
    });
    try {
      const receipt = await peer.page.fillBackendNode(52, text);
      assert.equal(receipt.outcome, 'dispatched_verified');
      assert.deepEqual(
        peer.commands.filter((command) => command.method === 'Input.dispatchKeyEvent').map((command) => command.params),
        [{ type: 'char', text, unmodifiedText: text }],
      );
    } finally {
      await peer.close();
    }
  });

  it('uses the same bounded key-event fallback for input and textarea targets', async () => {
    for (const kind of ['input', 'textarea'] as const) {
      const text = `${kind} 中文\n😀`;
      let calls = 0;
      const peer = await withInteractionPeer((command) => {
        if (command.method === 'DOM.resolveNode') return { object: { objectId: `${kind}-node` } };
        if (command.method === 'Runtime.callFunctionOn') {
          calls += 1;
          return calls === 1
            ? { result: { value: { kind, editable: true } } }
            : { result: { value: { matches: true, normalizedLength: text.length } } };
        }
        if (command.method === 'Input.insertText') {
          return { protocolError: { code: -32601, message: 'Method not found' } };
        }
        return {};
      });
      try {
        const receipt = await peer.page.fillBackendNode(54, text);
        assert.equal(receipt.outcome, 'dispatched_verified');
        assert.equal(peer.commands.filter((command) => command.method === 'Input.dispatchKeyEvent').length, 1);
      } finally {
        await peer.close();
      }
    }
  });

  it('returns unknown without verification or retry after a possible text dispatch timeout', async () => {
    const peer = await withInteractionPeer((command) => {
      if (command.method === 'DOM.resolveNode') return { object: { objectId: 'textarea-node' } };
      if (command.method === 'Runtime.callFunctionOn') {
        return { result: { value: { kind: 'textarea', editable: true } } };
      }
      if (command.method === 'Input.insertText') return undefined;
      return {};
    });
    try {
      const receipt = await peer.page.fillBackendNode(53, 'possibly inserted');
      assert.equal(receipt.outcome, 'outcome_unknown');
      assert.equal(receipt.verified, false);
      assert.equal(receipt.retrySafe, false);
      assert.equal(peer.commands.filter((command) => command.method === 'Runtime.callFunctionOn').length, 1);
    } finally {
      await peer.close();
    }
  });
});

describe('CdpNetworkCaptureTransport', () => {
  it('recursively enables Network for page and iframe targets without freezing workers', async () => {
    const commands: Array<{ method: string; sessionId?: string; params: Record<string, unknown> }> = [];
    const methodListeners = new Map<string, Set<(event: CdpEventEnvelope) => void>>();
    const fakeConnection = {
      send: async <T>(method: string, params: Record<string, unknown>, sessionId?: string): Promise<T> => {
        commands.push({ method, params, sessionId });
        if (method === 'Target.setAutoAttach' && sessionId === 'page') {
          for (const listener of methodListeners.get('Target.attachedToTarget') ?? []) {
            listener({
              method: 'Target.attachedToTarget',
              sessionId: 'page',
              params: {
                sessionId: 'frame',
                targetInfo: { type: 'iframe' },
                waitingForDebugger: false,
              },
            });
          }
        }
        if (method === 'Target.setAutoAttach' && sessionId === 'frame') {
          for (const listener of methodListeners.get('Target.attachedToTarget') ?? []) {
            listener({
              method: 'Target.attachedToTarget',
              sessionId: 'frame',
              params: {
                sessionId: 'worker',
                targetInfo: { type: 'worker' },
                waitingForDebugger: false,
              },
            });
          }
        }
        return {} as T;
      },
      on: (method: string, listener: (event: CdpEventEnvelope) => void) => {
        const listeners = methodListeners.get(method) ?? new Set();
        listeners.add(listener);
        methodListeners.set(method, listeners);
        return () => listeners.delete(listener);
      },
      onEvent: () => () => {},
      onClose: () => () => {},
    };
    const transport = new CdpNetworkCaptureTransport(
      fakeConnection as unknown as CdpConnection,
      'page',
    );
    await transport.start();

    for (const sessionId of ['page', 'frame']) {
      assert.ok(commands.some((command) => command.method === 'Network.enable' && command.sessionId === sessionId));
      assert.ok(commands.some((command) => command.method === 'Target.setAutoAttach' && command.sessionId === sessionId));
    }
    assert.equal(commands.some((command) => command.sessionId === 'worker'), false);
    assert.ok(commands
      .filter((command) => command.method === 'Target.setAutoAttach')
      .every((command) => (command.params as { waitForDebuggerOnStart?: boolean }).waitForDebuggerOnStart === false));
    assert.deepEqual(
      commands.find((command) => command.method === 'Network.enable' && command.sessionId === 'page')?.params,
      {
        maxTotalBufferSize: 5 * 1024 * 1024,
        maxResourceBufferSize: 1024 * 1024,
        maxPostDataSize: 64 * 1024,
      },
    );
    transport.stop();
    assert.equal(methodListeners.get('Target.attachedToTarget')?.size, 0);
    assert.equal(methodListeners.get('Target.detachedFromTarget')?.size, 0);
  });

  it('rolls back failed startup and permits a clean retry', async () => {
    let failNetwork = true;
    const methodListeners = new Map<string, Set<(event: CdpEventEnvelope) => void>>();
    const fakeConnection = {
      send: async <T>(method: string): Promise<T> => {
        if (method === 'Network.enable' && failNetwork) {
          failNetwork = false;
          throw new Error('network setup failed');
        }
        return {} as T;
      },
      on: (method: string, listener: (event: CdpEventEnvelope) => void) => {
        const listeners = methodListeners.get(method) ?? new Set();
        listeners.add(listener);
        methodListeners.set(method, listeners);
        return () => listeners.delete(listener);
      },
      onEvent: () => () => {},
      onClose: () => () => {},
    };
    const transport = new CdpNetworkCaptureTransport(fakeConnection as unknown as CdpConnection, 'page');
    await assert.rejects(transport.start(), /network setup failed/);
    assert.equal(methodListeners.get('Target.attachedToTarget')?.size, 0);
    assert.equal(methodListeners.get('Target.detachedFromTarget')?.size, 0);
    await transport.start();
    transport.stop();
  });
});

describe('retryDuringColdStart', () => {
  // A fake clock: `now()` returns the current virtual time; `sleep` advances it
  // by the interval so tests run instantly without real timers.
  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    };
  }

  it('returns the value once attempt succeeds on a later try', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryDuringColdStart(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('socket hang up');
        return 'attached';
      },
      { budgetMs: 1_000, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    assert.strictEqual(result, 'attached');
    assert.strictEqual(calls, 3, 'retries until success');
  });

  it('throws the last error once the budget is exhausted', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      retryDuringColdStart(
        async () => {
          calls += 1;
          throw new Error(`attempt ${calls} failed`);
        },
        { budgetMs: 500, intervalMs: 200, now: clock.now, sleep: clock.sleep },
      ),
      /attempt 4 failed/,
    );
    // t0=0; attempts at t=0,200,400,600(exceeds 500 budget → throw after 4th).
    // Actually: attempt1@0 fail (0<500, sleep→200), attempt2@200 fail (sleep→400),
    // attempt3@400 fail (sleep→600), attempt4@600 fail (600>=500 → throw). = 4 calls.
    assert.ok(calls >= 3, `expected several retries, got ${calls}`);
  });

  it('does not retry when the first attempt succeeds', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryDuringColdStart(
      async () => {
        calls += 1;
        return 'ok';
      },
      { budgetMs: 1_000, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 1);
  });
});
