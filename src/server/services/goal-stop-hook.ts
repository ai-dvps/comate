import type { HookCallback, StopHookInput } from '@anthropic-ai/claude-agent-sdk';
import {
  GOAL_BLOCKED_PREFIX,
  GOAL_COMPLETE_MARKER,
  GOAL_TURN_CAP,
} from './goal-wrapper.js';
import { diagLog } from '../utils/diag-logger.js';

/**
 * The completion evaluator for scheduled runs (KTD-3, path B) — a
 * programmatic prompt-based Stop hook, the same machinery /goal wraps
 * (docs.claude.com/docs/en/goal). After each turn it inspects the last
 * assistant message:
 *
 * - status marker present (COMPLETE / BLOCKED) → let the session stop;
 * - turn cap reached → let the session stop (bounded loop, run record shows
 *   the truncated transcript);
 * - otherwise → continue the session with guidance via additionalContext.
 *
 * The evaluation is deterministic marker matching, not a second model call —
 * the goal prompt (buildGoalPrompt) makes the marker part of the contract.
 */
export function makeScheduledRunStopHook(sessionId: string): HookCallback {
  let turns = 0;
  return async (input) => {
    if (input.hook_event_name !== 'Stop') return {};
    turns += 1;
    const last = (input as StopHookInput).last_assistant_message ?? '';
    if (last.includes(GOAL_COMPLETE_MARKER) || last.includes(GOAL_BLOCKED_PREFIX)) {
      diagLog(`[goal-stop-hook] session ${sessionId} completed after ${turns} evaluated turn(s)`);
      return {};
    }
    if (turns >= GOAL_TURN_CAP) {
      diagLog(`[goal-stop-hook] session ${sessionId} force-stopped at turn cap ${GOAL_TURN_CAP}`);
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'Stop' as const,
        additionalContext: `继续执行定时任务。完成后请单独输出一行 ${GOAL_COMPLETE_MARKER}，无法完成则输出 ${GOAL_BLOCKED_PREFIX} 与原因。（已评估 ${turns}/${GOAL_TURN_CAP} 轮）`,
      },
    };
  };
}
