import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { resolveCodexBinary } from '../src/server/utils/resolve-codex-binary.js';

const binary = resolveCodexBinary();
assert.ok(binary, 'pinned Codex binary missing');
const isolatedHome = mkdtempSync(path.join(tmpdir(), 'comate-codex-home-'));
const child = spawn(binary, ['app-server'], {
  env: { ...process.env, CODEX_HOME: isolatedHome },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = readline.createInterface({ input: child.stdout });
const responses = new Map<number, (value: unknown) => void>();
lines.on('line', (line) => {
  const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
  if (message.id !== undefined) responses.get(message.id)?.(message);
});

function request(id: number, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000);
    responses.set(id, (message) => {
      clearTimeout(timeout);
      responses.delete(id);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

try {
  const initialized = await request(1, 'initialize', {
    clientInfo: { name: 'comate', title: 'Comate', version: '0.3.1' },
    capabilities: null,
  }) as { result?: unknown; error?: unknown };
  assert.ok(initialized.result && !initialized.error, JSON.stringify(initialized.error));
  const listed = await request(2, 'thread/list', { limit: 1, useStateDbOnly: true }) as {
    result?: { data?: unknown[] };
    error?: unknown;
  };
  assert.ok(Array.isArray(listed.result?.data) && !listed.error, JSON.stringify(listed.error));
  console.log('Codex app-server initialize + thread/list smoke passed');
} finally {
  child.kill('SIGTERM');
  lines.close();
}
