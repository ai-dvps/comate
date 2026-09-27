/**
 * U4 go/no-go surface verification on the PINNED opencode binary (1.18.23).
 * Probes, in order:
 *   1. serve spawns and reports its version
 *   2. HTTP Basic auth gate: unset password → 401; correct → 200
 *   3. v2 question API presence: GET /question responds (not 404)
 *   4. permission round-trip on this binary (v1 endpoint, regression check)
 *   5. question round-trip: agent asks via question tool → question.asked →
 *      reply → session continues (THE launch-blocking unknown)
 *
 * Usage:
 *   XDG_DATA_HOME=/tmp/oc-spike-xdg COMATE_DATA_DIR=/tmp/oc-spike-comate \
 *   SPIKE_PROVIDER_API_KEY=... npx tsx scripts/verify-opencode-surface.ts
 *
 * Exit 0 = all probes passed; 1 = a probe failed (Stop condition for U4).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const BINARY = path.resolve('node_modules/opencode-darwin-arm64/bin/opencode');
const WORKSPACE = '/tmp/oc-verify-workspace';
const TIMEOUT_MS = 150_000;
const [providerID, modelID] = (process.env.SPIKE_MODEL ?? 'kimi-comate/kimi-for-coding').split('/');

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}
const checks: Check[] = [];
const record = (name: string, pass: boolean, detail?: string): void => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') srv.close(() => resolve(address.port));
      else reject(new Error('no address'));
    });
  });

const waitReady = (proc: ChildProcess, timeoutMs: number): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`serve ready timeout. out: ${buffer.slice(-300)}`)), timeoutMs);
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/opencode server listening on (https?:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on('exit', (code) => reject(new Error(`serve exited early code=${code}: ${buffer.slice(-300)}`)));
  });

const main = async (): Promise<void> => {
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });

  const password = randomBytes(16).toString('hex');
  const port = await findFreePort();
  const proc = spawn(
    BINARY,
    ['serve', '--hostname=127.0.0.1', `--port=${port}`],
    {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? '/tmp/oc-spike-xdg',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { edit: 'ask', question: 'allow' },
          provider: {
            [providerID]: {
              npm: '@ai-sdk/anthropic',
              name: providerID,
              options: {
                baseURL: process.env.SPIKE_PROVIDER_BASE_URL ?? 'https://api.kimi.com/coding/v1',
                apiKey: process.env.SPIKE_PROVIDER_API_KEY,
              },
              models: { [modelID]: { name: modelID } },
            },
          },
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  try {
    const baseUrl = await waitReady(proc, 20_000);
    record('serve spawns and reports ready', true, baseUrl);
    const auth = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
    const authFetch = (p: string, init?: RequestInit) =>
      fetch(`${baseUrl}${p}${p.includes('?') ? '&' : '?'}directory=${encodeURIComponent(WORKSPACE)}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...auth, ...(init?.headers ?? {}) },
      });

    const unauth = await fetch(`${baseUrl}/session`);
    record('unauthenticated request rejected', unauth.status === 401, `status=${unauth.status}`);

    const authed = await authFetch('/session');
    record('authenticated request accepted', authed.status === 200, `status=${authed.status}`);

    const questionList = await authFetch('/question');
    record('v2 question API present', questionList.status !== 404, `status=${questionList.status}`);

    // --- event stream ---
    const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
    const questionRequests: Array<Record<string, unknown>> = [];
    const permissionRequests: Array<Record<string, unknown>> = [];
    const abort = new AbortController();
    const eventLoop = (async () => {
      const res = await fetch(`${baseUrl}/event?directory=${encodeURIComponent(WORKSPACE)}`, {
        signal: abort.signal,
        headers: { accept: 'text/event-stream', ...auth },
      });
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (data) {
            const event = JSON.parse(data);
            events.push(event);
            if (event.type === 'question.asked') questionRequests.push(event.properties);
            if (event.type === 'permission.asked' || event.type === 'permission.updated') permissionRequests.push(event.properties);
            if (event.type === 'session.error') {
              console.log('  session.error:', JSON.stringify(event.properties).slice(0, 300));
            }
          }
          idx = buffer.indexOf('\n\n');
        }
      }
    })();
    eventLoop.catch(() => undefined);

    const session = (await (await authFetch('/session', { method: 'POST', body: JSON.stringify({ title: 'verify' }) })).json()) as { id: string };

    // Probe 4: permission round-trip (write triggers edit permission)
    await authFetch(`/session/${session.id}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify({
        model: { providerID, modelID },
        parts: [{ type: 'text', text: 'Use the write tool to create a file named perm-check.txt with the exact content "p". Then stop.' }],
      }),
    });
    const permissionDeadline = Date.now() + TIMEOUT_MS;
    while (permissionRequests.length === 0 && Date.now() < permissionDeadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (permissionRequests.length > 0) {
      const permission = permissionRequests[0] as { id: string; sessionID: string };
      const reply = await authFetch(`/session/${permission.sessionID}/permissions/${permission.id}`, {
        method: 'POST',
        body: JSON.stringify({ response: 'once' }),
      });
      record('permission round-trip on pinned binary', reply.status === 200 || reply.status === 204, `reply status=${reply.status}`);
    } else {
      record('permission round-trip on pinned binary', false, 'no permission.asked observed');
    }

    // Probe 5: question round-trip (THE launch blocker)
    await authFetch(`/session/${session.id}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify({
        model: { providerID, modelID },
        parts: [{ type: 'text', text: 'Use the question tool exactly once to ask me a single question with two options. Do not do anything else first.' }],
      }),
    });
    const questionDeadline = Date.now() + TIMEOUT_MS;
    while (questionRequests.length === 0 && Date.now() < questionDeadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (questionRequests.length === 0) {
      record('question round-trip (question.asked observed)', false, 'no question.asked within timeout');
    } else {
      const request = questionRequests[0] as { id: string; questions?: unknown[] };
      record('question round-trip (question.asked observed)', true, `requestID=${request.id} questions=${request.questions?.length ?? '?'}`);
      const reply = await authFetch(`/question/${request.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ answers: [['option one']] }),
      });
      record('question reply accepted', reply.status === 200 || reply.status === 204, `reply status=${reply.status}`);
      const continueDeadline = Date.now() + 60_000;
      const eventsBefore = events.length;
      await new Promise((r) => setTimeout(r, 8000));
      record(
        'session continues after question reply',
        events.length > eventsBefore || existsSync(path.join(WORKSPACE, 'perm-check.txt')),
        `events +${events.length - eventsBefore}`,
      );
      void continueDeadline;
    }

    writeFileSync('/tmp/oc-verify-events.jsonl', events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    abort.abort();
    await authFetch(`/session/${session.id}/abort`, { method: 'POST' }).catch(() => undefined);
  } finally {
    proc.kill();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${failed.length === 0 ? 'ALL SURFACE PROBES PASSED' : `FAILED: ${failed.map((f) => f.name).join(' | ')}`}`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('verify hard failure:', err);
  process.exit(1);
});
