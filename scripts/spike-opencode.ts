/**
 * Spike driver: live-validates opencode as an alternative agent runtime for
 * Comate (ce-pov Trial verdict conditions 1, 2, 4, 5).
 *
 * What it proves end-to-end:
 *   1. spawn `opencode serve` → REST session → prompt → SSE event stream
 *   2. permission round-trip: intercept permission.updated, reply "once",
 *      observe the gated tool actually run (condition 1)
 *   3. event fidelity: map every message.part.updated part through
 *      mapOpencodePart and report coverage/gaps (condition 2)
 *   4. REST extras Comate needs: fork, children, todo (feature coverage)
 *   5. runs on a non-Anthropic provider (default MiniMax) (condition 5)
 *
 * Usage:
 *   XDG_DATA_HOME=/tmp/oc-spike-xdg COMATE_DATA_DIR=/tmp/oc-spike-comate \
 *     npx tsx scripts/spike-opencode.ts
 *
 * Env overrides: SPIKE_MODEL=provider/model  SPIKE_TIMEOUT_MS=150000
 *
 * Exits 0 when all checks pass, 2 on timeout/partial, 1 on hard failure.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import {
  spawnOpencodeServer,
  OpencodeRestClient,
  subscribeOpencodeEvents,
  mapOpencodePart,
  type MappedPart,
  type OpencodePermissionRequest,
  type OpencodePart,
} from '../src/server/services/opencode-client.js';

const WORKSPACE = '/tmp/oc-spike-workspace';
const EVENTS_DUMP = '/tmp/oc-spike-events.jsonl';
const TIMEOUT_MS = Number(process.env.SPIKE_TIMEOUT_MS ?? 150_000);
const [providerID, modelID] = (process.env.SPIKE_MODEL ?? 'minimax-cn-coding-plan/MiniMax-M2.5').split('/');

const PROMPT =
  'Use the write tool to create a file named hello-opencode.txt in the current ' +
  'directory with the exact content "spike ok". Do not ask me anything. ' +
  'After the file is written, reply with the single word DONE.';

const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        srv.close(() => resolve(address.port));
      } else {
        reject(new Error('no address'));
      }
    });
  });

interface SpikeReport {
  model: string;
  checks: Record<string, boolean | string>;
  eventCounts: Record<string, number>;
  partTypesSeen: string[];
  mappedPartsSummary: Record<string, number>;
  unmappedGaps: string[];
  permissionPayloads: unknown[];
  todos: unknown[];
  forkedSessionId?: string;
  childSessionCount?: number;
  messageCount?: number;
  fileContent?: string;
  timedOut: boolean;
}

const main = async (): Promise<void> => {
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });

  const port = await findFreePort();

  // Optional custom provider injection (e.g. an OpenAI/Anthropic-compatible
  // enterprise endpoint). The API key arrives via env only and is never
  // written to the report or disk.
  const providerConfig: Record<string, unknown> = {};
  if (process.env.SPIKE_PROVIDER_ID) {
    providerConfig.provider = {
      [process.env.SPIKE_PROVIDER_ID]: {
        npm: process.env.SPIKE_PROVIDER_NPM ?? '@ai-sdk/anthropic',
        name: process.env.SPIKE_PROVIDER_ID,
        options: {
          baseURL: process.env.SPIKE_PROVIDER_BASE_URL,
          apiKey: process.env.SPIKE_PROVIDER_API_KEY,
        },
        models: {
          [modelID]: { name: modelID },
        },
      },
    };
  }

  console.log(`[spike] starting opencode serve on 127.0.0.1:${port} (model=${providerID}/${modelID})`);

  const server = await spawnOpencodeServer({
    port,
    cwd: WORKSPACE,
    env: { XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? '/tmp/oc-spike-xdg' },
    config: {
      permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
      ...providerConfig,
    },
  });

  const report: SpikeReport = {
    model: `${providerID}/${modelID}`,
    checks: {},
    eventCounts: {},
    partTypesSeen: [],
    mappedPartsSummary: {},
    unmappedGaps: [],
    permissionPayloads: [],
    todos: [],
    timedOut: false,
  };

  const rest = OpencodeRestClient.fromHandle(server, WORKSPACE);
  const abort = new AbortController();
  const mappedParts: MappedPart[] = [];
  const rawEvents: string[] = [];
  let sessionId = '';
  let idleResolve!: () => void;
  const idle = new Promise<void>((resolve) => {
    idleResolve = resolve;
  });

  const eventLoop = subscribeOpencodeEvents(
    server.url,
    (event) => {
      rawEvents.push(JSON.stringify(event));
      report.eventCounts[event.type] = (report.eventCounts[event.type] ?? 0) + 1;

      // opencode ≤1.14 emits "permission.asked"; ≥1.15 source renamed it to
      // "permission.updated". Handle both.
      if (event.type === 'permission.asked' || event.type === 'permission.updated') {
        const permission = event.properties as unknown as OpencodePermissionRequest;
        report.permissionPayloads.push({
          id: permission.id,
          permission: (permission as unknown as { permission?: string }).permission,
          type: permission.type,
          title: permission.title,
          payloadKeys: Object.keys(permission),
          metadataKeys: Object.keys(permission.metadata ?? {}),
          hasToolInput: 'input' in permission,
          hasToolJoinKey: 'tool' in permission,
          hasDiff: Boolean((permission.metadata ?? {}).diff),
        });
        console.log(
          `[spike] permission requested (${event.type}): ${permission.title ?? (permission as unknown as { permission?: string }).permission} → replying "once"`,
        );
        rest
          .replyPermission(permission.sessionID, permission.id, 'once')
          .then(() => {
            report.checks.permissionRoundTripReply = true;
          })
          .catch((err: Error) => {
            report.checks.permissionRoundTripReply = `reply failed: ${err.message}`;
          });
      }

      if (event.type === 'message.part.updated') {
        const part = event.properties.part as OpencodePart | undefined;
        if (part) {
          if (!report.partTypesSeen.includes(part.type)) report.partTypesSeen.push(part.type);
          for (const mapped of mapOpencodePart(part)) {
            mappedParts.push(mapped);
            report.mappedPartsSummary[mapped.type] =
              (report.mappedPartsSummary[mapped.type] ?? 0) + 1;
            if (mapped.type === 'unmapped' && mapped.reason.includes('fidelity gap')) {
              report.unmappedGaps.push(`${mapped.partType}: ${mapped.reason}`);
            }
          }
        }
      }

      if (event.type === 'session.idle' || event.type === 'session.status') {
        const props = event.properties as { sessionID?: string; status?: { type?: string } };
        const isIdle =
          event.type === 'session.idle' ? true : props.status?.type === 'idle';
        if (isIdle && (!sessionId || props.sessionID === sessionId)) idleResolve();
      }
    },
    { signal: abort.signal, directory: WORKSPACE },
  );
  eventLoop.catch((err: Error) => {
    if (!abort.signal.aborted) console.error('[spike] event stream error:', err.message);
  });

  const watchdog = setTimeout(() => {
    report.timedOut = true;
    idleResolve();
  }, TIMEOUT_MS);

  try {
    const session = await rest.createSession('spike-opencode');
    sessionId = session.id;
    console.log(`[spike] session created: ${sessionId}`);

    await rest.promptAsync(sessionId, {
      text: PROMPT,
      model: { providerID, modelID },
    });
    console.log('[spike] prompt sent, waiting for idle…');

    await idle;
    clearTimeout(watchdog);

    // --- post-run REST probes (feature coverage) ---
    const messages = await rest.getSessionMessages(sessionId);
    report.messageCount = messages.length;

    report.todos = await rest.getTodos(sessionId);

    const forked = await rest.forkSession(sessionId);
    report.forkedSessionId = forked.id;

    const children = await rest.listChildSessions(sessionId);
    report.childSessionCount = children.length;

    // --- checks ---
    const targetFile = path.join(WORKSPACE, 'hello-opencode.txt');
    const fileWritten = existsSync(targetFile);
    report.checks.serverSpawned = true;
    report.checks.sessionCreated = true;
    report.checks.permissionRequested = report.permissionPayloads.length > 0;
    report.checks.approvedToolActuallyRan = fileWritten;
    report.checks.fileWrittenByAgent = fileWritten;
    report.checks.sawTextParts = (report.mappedPartsSummary.text ?? 0) > 0;
    report.checks.sawToolUseParts = (report.mappedPartsSummary.tool_use ?? 0) > 0;
    report.checks.sawToolResultParts = (report.mappedPartsSummary.tool_result ?? 0) > 0;
    report.checks.noFidelityGaps = report.unmappedGaps.length === 0;
    report.checks.forkWorked = Boolean(report.forkedSessionId);
    report.checks.childrenEndpointOk = typeof report.childSessionCount === 'number';
    report.checks.todoEndpointOk = Array.isArray(report.todos);
    report.checks.nonAnthropicModel = !providerID.includes('anthropic');

    if (fileWritten) {
      report.fileContent = readFileSync(targetFile, 'utf8');
    }
  } finally {
    clearTimeout(watchdog);
    abort.abort();
    if (sessionId) {
      await rest.abortSession(sessionId).catch(() => undefined);
    }
    server.dispose();
  }

  writeFileSync(EVENTS_DUMP, rawEvents.join('\n') + '\n');

  const failed = Object.entries(report.checks).filter(([, v]) => v === false);
  console.log('\n================ SPIKE REPORT ================');
  console.log(JSON.stringify(report, null, 2));
  console.log(`raw events dumped to ${EVENTS_DUMP}`);
  console.log('=============================================');

  if (report.timedOut) {
    console.error('[spike] TIMED OUT — partial report above');
    process.exit(2);
  }
  if (failed.length > 0) {
    console.error(`[spike] FAILED checks: ${failed.map(([k]) => k).join(', ')}`);
    process.exit(1);
  }
  console.log('[spike] ALL CHECKS PASSED');
  process.exit(0);
};

main().catch((err) => {
  console.error('[spike] hard failure:', err);
  process.exit(1);
});
