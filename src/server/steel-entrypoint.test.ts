import './test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'net';
import http from 'http';

/**
 * Re-exec-self contract (U2/KTD-2): with COMATE_STEEL=1 the server entrypoint
 * loads the vendored Steel bundle resolved off the real filesystem instead of
 * booting the Comate sidecar API. Verified end-to-end by spawning the actual
 * entrypoint (src/server/index.ts) against a fake Steel bundle.
 */

const FAKE_STEEL_SOURCE = `
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ fakeSteel: true }));
});
server.listen(parseInt(process.env.PORT, 10), '127.0.0.1');
`;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function httpGetJson(port: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

describe('COMATE_STEEL re-exec-self branch', { concurrency: false }, () => {
  it('hosts the resolved Steel bundle instead of the sidecar API', { timeout: 30000 }, async () => {
    const resourceDir = mkdtempSync(join(tmpdir(), 'comate-steel-branch-'));
    const fakeEntry = join(resourceDir, 'steel', 'build');
    mkdirSync(fakeEntry, { recursive: true });
    writeFileSync(join(fakeEntry, 'index.js'), FAKE_STEEL_SOURCE);

    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(process.cwd(), 'src/server/index.ts')],
      {
        env: {
          ...process.env,
          COMATE_STEEL: '1',
          TAURI_RESOURCE_DIR: resourceDir,
          PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    try {
      // Poll until the fake Steel server answers (tsx compile takes a moment).
      let response: { status: number; body: unknown } | undefined;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try {
          response = await httpGetJson(port);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      assert.ok(response, `fake Steel never answered.\nstdout: ${stdout}\nstderr: ${stderr}`);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.body, { fakeSteel: true });

      // The Comate sidecar API must NOT have booted in this process.
      assert.ok(
        !stdout.includes('Server running on'),
        `sidecar API unexpectedly booted.\nstdout: ${stdout}`,
      );
    } finally {
      child.kill('SIGKILL');
      rmSync(resourceDir, { recursive: true, force: true });
    }
  });
});
