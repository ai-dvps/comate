import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoalPrompt,
  GOAL_BLOCKED_PREFIX,
  GOAL_COMPLETE_MARKER,
  GOAL_TURN_CAP,
} from './goal-wrapper.js';
import { makeScheduledRunStopHook } from './goal-stop-hook.js';
import type { StopHookInput } from '@anthropic-ai/claude-agent-sdk';

function stopInput(lastMessage: string): StopHookInput {
  return { hook_event_name: 'Stop', last_assistant_message: lastMessage } as unknown as StopHookInput;
}

describe('buildGoalPrompt', () => {
  it('wraps the instruction with the completion protocol, markers, and turn cap', () => {
    const prompt = buildGoalPrompt('  deploy the app  ');
    assert.ok(prompt.startsWith('deploy the app'));
    assert.match(prompt, /完成标准/);
    assert.ok(prompt.includes(GOAL_COMPLETE_MARKER));
    assert.ok(prompt.includes(GOAL_BLOCKED_PREFIX));
    assert.match(prompt, new RegExp(`${GOAL_TURN_CAP} 轮`));
    assert.match(prompt, /无人值守/);
  });
});

describe('makeScheduledRunStopHook', () => {
  it('lets the session stop when the COMPLETE marker is present', async () => {
    const hook = makeScheduledRunStopHook('s1');
    const out = await hook(stopInput(`work done\n${GOAL_COMPLETE_MARKER}`), undefined, { signal: AbortSignal.timeout(1000) });
    assert.deepEqual(out, {});
  });

  it('lets the session stop when the BLOCKED marker is present', async () => {
    const hook = makeScheduledRunStopHook('s1');
    const out = await hook(stopInput(`${GOAL_BLOCKED_PREFIX} deploy script missing`), undefined, { signal: AbortSignal.timeout(1000) });
    assert.deepEqual(out, {});
  });

  it('continues the session with guidance when no marker is present', async () => {
    const hook = makeScheduledRunStopHook('s1');
    const out = (await hook(stopInput('still working on it'), undefined, { signal: AbortSignal.timeout(1000) })) as {
      hookSpecificOutput?: { hookEventName: string; additionalContext?: string };
    };
    assert.equal(out.hookSpecificOutput?.hookEventName, 'Stop');
    assert.match(out.hookSpecificOutput?.additionalContext ?? '', /GOAL_STATUS/);
  });

  it('force-stops at the turn cap even without a marker', async () => {
    const hook = makeScheduledRunStopHook('s1');
    let out: unknown;
    for (let i = 0; i < GOAL_TURN_CAP; i++) {
      out = await hook(stopInput('still working'), undefined, { signal: AbortSignal.timeout(1000) });
    }
    assert.deepEqual(out, {});
  });

  it('ignores non-Stop hook events', async () => {
    const hook = makeScheduledRunStopHook('s1');
    const out = await hook({ hook_event_name: 'PreToolUse' } as never, undefined, { signal: AbortSignal.timeout(1000) });
    assert.deepEqual(out, {});
  });
});
