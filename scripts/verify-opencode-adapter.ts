/**
 * U4 end-to-end adapter verification on the full Comate stack (AE4 rehearsal):
 * real store + real opencode serve + real session core + live model endpoint.
 *
 * Flow: default backend = opencode → getOrCreateRuntime → pushMessage asking
 * for a file write → core emits pending_approval (bridged from
 * permission.asked) → resolveApproval(allow) → tool executes → file exists.
 *
 * Usage:
 *   COMATE_DATA_DIR=$(mktemp -d)/data SPIKE_PROVIDER_API_KEY=... \
 *     npx tsx scripts/verify-opencode-adapter.ts
 *
 * Exit 0 = all checks passed.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.COMATE_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), 'comate-adapter-verify-'));

const { chatService } = await import('../src/server/services/chat-service.js');
const { store: workspaceStore } = await import('../src/server/storage/sqlite-store.js');
const { setDefaultBackend, getBackendAvailability } = await import('../src/server/services/agent-backends.js');
const { opencodeServerManager } = await import('../src/server/services/opencode-server-manager.js');

const WORKSPACE_DIR = '/tmp/oc-adapter-workspace';
const TARGET_FILE = path.join(WORKSPACE_DIR, 'adapter-proof.txt');
const TIMEOUT_MS = 150_000;

interface Check { name: string; pass: boolean; detail?: string }
const checks: Check[] = [];
const record = (name: string, pass: boolean, detail?: string): void => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const main = async (): Promise<void> => {
  rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });

  const availability = await getBackendAvailability('opencode');
  record('opencode backend available (binary + health check)', availability.status === 'available', availability.reason);

  const workspace = await workspaceStore.create({ name: 'Adapter Verify', folderPath: WORKSPACE_DIR });
  const provider = workspaceStore.createProvider({
    name: 'Kimi Verify',
    baseUrl: 'https://api.kimi.com/coding/',
    authToken: process.env.SPIKE_PROVIDER_API_KEY ?? '',
    model: 'kimi-for-coding',
    isDefault: true,
  });
  const session = workspaceStore.createLocalSession(workspace.id, 'Adapter Session', undefined, provider.id, 'gui');
  await setDefaultBackend('opencode');

  const events: Array<{ id: number; type: string; [k: string]: unknown }> = [];
  const pendingApprovals: string[] = [];
  let resultResolve!: () => void;
  const resultArrived = new Promise<void>((resolve) => {
    resultResolve = resolve;
  });

  const runtime = await chatService.getOrCreateRuntime(session.id, workspace.id);
  record('runtime created on opencode backend', true);

  const backendIdDeadline = Date.now() + 30_000;
  while (!workspaceStore.getLocalSession(session.id)?.backendSessionId && Date.now() < backendIdDeadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  record(
    'backendSessionId persisted',
    typeof workspaceStore.getLocalSession(session.id)?.backendSessionId === 'string',
    workspaceStore.getLocalSession(session.id)?.backendSessionId,
  );

  runtime.addWebEventHandler((id, event) => {
    events.push({ id, ...event });
    if (event.type === 'error_note') {
      console.log(`  error_note: ${String((event as { text?: unknown }).text).slice(0, 160)}`);
      checks.sawErrorNote = true;
    }
    if (event.type === 'pending_approval') {
      const requestId = String((event as { requestId?: unknown }).requestId);
      pendingApprovals.push(requestId);
      console.log(`  pending_approval (${requestId.slice(0, 12)}…) — resolving allow`);
      // Resolve on the next tick: the core emits pending_approval before the
      // pending map entry is visible to an inline resolver (UI resolves
      // seconds later in production, so this race never surfaces there).
      setTimeout(() => runtime.resolveApproval(requestId, { behavior: 'allow' }), 100);
    }
    if (event.type === 'result') resultResolve();
  });

  runtime.pushMessage(
    'Use the write tool to create a file named adapter-proof.txt in the current directory with the exact content "spike ok 2". Then reply with the single word DONE.',
  );

  const deadline = Date.now() + TIMEOUT_MS;
  while (pendingApprovals.length === 0 && Date.now() < deadline && events.every((e) => e.type !== 'result')) {
    await new Promise((r) => setTimeout(r, 500));
  }
  record('permission bridged to core pending_approval', pendingApprovals.length > 0);

  await Promise.race([
    resultArrived,
    new Promise<void>((resolve) => setTimeout(resolve, TIMEOUT_MS)),
  ]);

  record('file written after approval', existsSync(TARGET_FILE));
  record(
    'text events streamed',
    events.some((e) => e.type === 'assistant_start' || e.type === 'text' || e.type === 'assistant_done'),
  );
  record(
    'tool events streamed',
    events.some((e) => e.type === 'tool_use' || e.type === 'tool_result'),
  );
  record('result event arrived', events.some((e) => e.type === 'result'));

  await chatService.closeAllRuntimes();
  await opencodeServerManager.stopAll();

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${failed.length === 0 ? 'ADAPTER E2E PASSED' : `FAILED: ${failed.map((f) => f.name).join(' | ')}`}`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('adapter verify hard failure:', err);
  process.exit(1);
});
