import './test-utils/test-env.js';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { browserService } from './services/browser-service.js';
import { chatService } from './services/chat-service.js';
import { teardownServices } from './service-teardown.js';
import { providerRouteRegistry } from './services/provider-route-registry.js';

// F1 regression: graceful shutdown (SIGTERM/SIGINT/POST /shutdown) must tear
// every live browser view down — before this wiring existed, browser sessions
// leaked on every quit.
test('teardownServices shuts browserService down before closing chat runtimes', async () => {
  const order: string[] = [];
  const browserShutdownMock = mock.method(browserService, 'shutdown', async () => {
    order.push('browserService.shutdown');
  });
  const closeRuntimesMock = mock.method(chatService, 'closeAllRuntimes', async () => {
    order.push('chatService.closeAllRuntimes');
  });
  const closeRoutesMock = mock.method(providerRouteRegistry, 'closeAll', () => {
    order.push('providerRouteRegistry.closeAll');
  });
  try {
    await teardownServices();
  } finally {
    browserShutdownMock.mock.restore();
    closeRuntimesMock.mock.restore();
    closeRoutesMock.mock.restore();
  }
  assert.equal(browserShutdownMock.mock.callCount(), 1);
  assert.equal(closeRoutesMock.mock.callCount(), 1);
  assert.deepEqual(order, [
    'providerRouteRegistry.closeAll',
    'browserService.shutdown',
    'chatService.closeAllRuntimes',
  ]);
});
