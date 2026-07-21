import './test-utils/test-env.js';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { browserService } from './services/browser-service.js';
import { browserViewerProxy } from './routes/browser-proxy.js';
import { chatService } from './services/chat-service.js';
import { teardownServices } from './service-teardown.js';

// F1 regression: graceful shutdown (SIGTERM/SIGINT/POST /shutdown) must stop
// every Steel browser tree — before this wiring existed, up to 4 Chromium
// process trees leaked on every quit.
test('teardownServices shuts browserService down after the viewer proxy stops', async () => {
  const order: string[] = [];
  const stopMock = mock.method(browserViewerProxy, 'stop', async () => {
    order.push('viewerProxy.stop');
  });
  const browserShutdownMock = mock.method(browserService, 'shutdown', async () => {
    order.push('browserService.shutdown');
  });
  const closeRuntimesMock = mock.method(chatService, 'closeAllRuntimes', async () => {
    order.push('chatService.closeAllRuntimes');
  });
  try {
    await teardownServices();
  } finally {
    stopMock.mock.restore();
    browserShutdownMock.mock.restore();
    closeRuntimesMock.mock.restore();
  }
  assert.equal(browserShutdownMock.mock.callCount(), 1);
  assert.deepEqual(order, [
    'viewerProxy.stop',
    'browserService.shutdown',
    'chatService.closeAllRuntimes',
  ]);
});
