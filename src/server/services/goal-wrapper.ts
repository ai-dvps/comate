/**
 * Goal wrapper for scheduled-task runs (KTD-3, path B).
 *
 * The first message of a run session is the task instruction plus an explicit
 * completion protocol: the model must end with a status marker line, and a
 * hard turn cap bounds the loop. This works on every backend — even without
 * the claude-side Stop hook (the completion evaluator), the prompt itself
 * tells the model when to stop and what to report (the degraded mode, R10).
 */
export const GOAL_TURN_CAP = 20;
export const GOAL_COMPLETE_MARKER = 'GOAL_STATUS: COMPLETE';
export const GOAL_BLOCKED_PREFIX = 'GOAL_STATUS: BLOCKED';

export function buildGoalPrompt(instruction: string): string {
  return [
    instruction.trim(),
    '',
    '---',
    '以上是一个无人值守定时任务的完整指令。执行规则：',
    `1. 完成标准：指令所描述的可验证结果已达成（例如测试通过、文件已生成、部署成功）。`,
    `2. 结束时必须单独输出一行状态标记：`,
    `   - 完成：${GOAL_COMPLETE_MARKER}`,
    `   - 无法完成：${GOAL_BLOCKED_PREFIX} <一句话原因>`,
    `3. 轮次上限约 ${GOAL_TURN_CAP} 轮；接近上限时收尾当前工作并如实报告状态（阻塞或部分完成）。`,
    '4. 全程无人值守：不要向用户提问，按指令自主决策并执行。',
  ].join('\n');
}
