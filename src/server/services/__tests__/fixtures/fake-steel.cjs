'use strict';

/**
 * Fake Steel child for browser-steel-process tests. Emulates the vendored
 * Steel API contract that the orchestrator relies on:
 *  - reads HOST / PORT from the environment and binds there
 *  - answers GET /v1/health (200 once "ready", like Steel after its browser
 *    launches; the response echoes the bound address so tests can assert the
 *    loopback-only discipline)
 *  - ignores SIGTERM (U2 probe found the real Steel does not exit on SIGTERM,
 *    which is why teardown is SIGKILL on the process group)
 *
 * Test knobs via env:
 *  - FAKE_STEEL_CHILD_PIDFILE: spawn a grandchild (Chrome stand-in) and write
 *    its pid to this file, so tests can assert the whole tree dies.
 *  - FAKE_STEEL_NEVER_HEALTHY=1: stay alive but never listen (startup hang).
 */

const http = require('http');
const { spawn } = require('child_process');
const { writeFileSync } = require('fs');

process.on('SIGTERM', () => {
  // Deliberately ignored — mirrors the real Steel's SIGTERM behavior.
});

if (process.env.FAKE_STEEL_CHILD_PIDFILE) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  writeFileSync(process.env.FAKE_STEEL_CHILD_PIDFILE, String(child.pid));
}

if (process.env.FAKE_STEEL_NEVER_HEALTHY === '1') {
  // Hang forever without binding — start() must time out and clean up.
  setInterval(() => {}, 1000);
} else {
  const host = process.env.HOST || '127.0.0.1';
  const port = parseInt(process.env.PORT || '0', 10);
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/health') {
      const address = server.address();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          address: address && typeof address === 'object' ? address.address : null,
          port: address && typeof address === 'object' ? address.port : null,
          pid: process.pid,
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(port, host, () => {
    console.log(`fake-steel listening pid=${process.pid}`);
  });
}
