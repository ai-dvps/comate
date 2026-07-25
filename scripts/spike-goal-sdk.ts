/**
 * U1 spike: /goal programmatic availability via @anthropic-ai/claude-agent-sdk.
 *
 * Probe A: first user message is the text "/goal <condition>" through the same
 * streaming-input shape Comate uses (AsyncIterable<SDKUserMessage>) — does the
 * CLI interpret it as the /goal slash command (goal loop engages) or as plain
 * text?
 *
 * Probe B: programmatic Stop hook via SDK options — does additionalContext
 * drive continuation, does last_assistant_message arrive, can we count rounds
 * and terminate?
 *
 * Run: npx tsx scripts/spike-goal-sdk.ts
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  HookInput,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

const PROBE_TIMEOUT_MS = 240_000;

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

function singleShotStream(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield userMessage(text);
  })();
}

function summarize(msg: SDKMessage): string {
  const anyMsg = msg as unknown as Record<string, unknown>;
  const type = String(anyMsg.type ?? '?');
  const subtype = anyMsg.subtype ? `/${String(anyMsg.subtype)}` : '';
  let detail = '';
  if (type === 'assistant') {
    const content = (anyMsg.message as { content?: Array<{ type: string; text?: string; name?: string }> })?.content ?? [];
    detail = content
      .map((c) => (c.type === 'text' ? `text:"${(c.text ?? '').slice(0, 120)}"` : c.type === 'tool_use' ? `tool:${c.name}` : c.type))
      .join(' ');
  } else if (type === 'result') {
    detail = `turns=${String(anyMsg.num_turns)} result="${String(anyMsg.result ?? '').slice(0, 160)}"`;
  } else if (type === 'system') {
    detail = JSON.stringify(anyMsg).slice(0, 200);
  } else if (type.startsWith('hook') || type.includes('hook')) {
    detail = JSON.stringify(anyMsg).slice(0, 200);
  } else if (type === 'status') {
    detail = JSON.stringify(anyMsg).slice(0, 200);
  }
  return `${type}${subtype} ${detail}`.trim();
}

async function probeA(): Promise<void> {
  console.log('\n=== PROBE A: "/goal ..." as first streamed user message ===');
  const q = query({
    prompt: singleShotStream(
      '/goal Reply with exactly the word done, then stop. Stop after at most 3 turns regardless.',
    ),
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 5,
    },
  });
  for await (const msg of q) {
    console.log('[A]', summarize(msg));
  }
  console.log('=== PROBE A complete ===');
}

async function probeB(): Promise<void> {
  console.log('\n=== PROBE B: programmatic Stop hook continuation ===');
  let stopCalls = 0;
  const q = query({
    prompt: singleShotStream('Reply with exactly the word hello. Nothing else.'),
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 5,
      hooks: {
        Stop: [
          {
            hooks: [
              async (input: HookInput) => {
                stopCalls += 1;
                const stopInput = input as { last_assistant_message?: string };
                console.log(
                  `[B] StopHook call #${stopCalls}, last_assistant_message="${(stopInput.last_assistant_message ?? '<absent>').slice(0, 120)}"`,
                );
                if (stopCalls === 1) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'Stop' as const,
                      additionalContext: 'Now also reply with the word again, exactly once.',
                    },
                  };
                }
                return {};
              },
            ],
          },
        ],
      },
    },
  });
  for await (const msg of q) {
    console.log('[B]', summarize(msg));
  }
  console.log(`=== PROBE B complete (stopCalls=${stopCalls}) ===`);
}

async function main(): Promise<void> {
  const probe = process.argv[2] ?? 'both';
  const watchdog = setTimeout(() => {
    console.error(`\nWATCHDOG: probe exceeded ${PROBE_TIMEOUT_MS / 1000}s — exiting with partial log`);
    process.exit(2);
  }, PROBE_TIMEOUT_MS);
  try {
    if (probe === 'a' || probe === 'both') await probeA();
    if (probe === 'b' || probe === 'both') await probeB();
  } finally {
    clearTimeout(watchdog);
  }
}

main().catch((err) => {
  console.error('SPIKE ERROR:', err instanceof Error ? err.message : err);
  process.exit(1);
});
