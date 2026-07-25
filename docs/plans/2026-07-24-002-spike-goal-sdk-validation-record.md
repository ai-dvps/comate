---
title: Goal SDK Validation - Record
type: spike
date: 2026-07-24
topic: goal-sdk-validation
---

# Goal SDK Validation - Record

## 背景

定时任务计划（docs/plans/2026-07-24-001-feat-scheduled-tasks-plan.md）的 KTD-3 要求实测 /goal 的程序化可用性并据此二选一执行机制：路径 A（首条消息直接发 `/goal <条件>` 文本）或路径 B（程序化 Stop hook 驱动完成性评估）。本记录是 U1 的实测结论。

## 实测环境结论

**沙箱网络无法完成活体会话实测。** 本会话的 shell 环境无法连通用户的模型端点：bundled claude 二进制（2.1.217）与系统 claude（2.1.205）在沙箱内均报 `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`；关闭沙箱、使用系统 CA、设置本机系统代理（127.0.0.1:6152）后均为连接挂起。用户环境存在本机代理与自定义证书链，且端点为 Kimi 兼容端点（`ANTHROPIC_BASE_URL`），交互式会话可用但无法从子进程复现其网络路径。

## 类型级证据（本地 SDK 定义，@anthropic-ai/claude-agent-sdk 0.3.217）

- `Options.hooks` 支持以编程方式注册 Stop hook（`Partial<Record<HookEvent, HookCallbackMatcher[]>>`，`HookEvent` 含 `'Stop'`）。
- `StopHookInput.last_assistant_message` 提供最后一轮助手文本，无需解析 transcript。
- `StopHookSpecificOutput.additionalContext` 会驱动会话继续一轮（官方注释：the conversation continues so the model can act on it）。
- `PermissionMode` 含 `'auto'`；官方 /goal 文档明确 /goal 本身是"session-scoped prompt-based Stop hook"的封装。

## 决议（对 KTD-3 的偏差）

**采用路径 B 作为首选，且不因路径 A 未验证而阻塞。** 理由：

1. 路径 B 的可行性由 SDK 类型定义完整证明（hooks 选项 + Stop 事件 + additionalContext 续跑），不依赖 CLI 斜杠命令在 stream-json 输入下的解释行为（路径 A 的关键未知）。
2. 路径 B 即 /goal 的同一机制（官方文档：/goal 是 prompt-based Stop hook 的封装），产品意图"目标导向 + 独立完成性评估"完整保留。
3. 路径 B 让评估器归 Comate 所有：轮次上限、完成标记（GOAL_STATUS）与运行状态判定可控，且与 provider 无关（含 Kimi 兼容端点）。
4. 评估器为确定性标记匹配而非二次模型调用：无额外 token 成本，无嵌套调用对兼容端点的依赖。

## 实现落点

- `src/server/services/goal-wrapper.ts`：包装模板（指令 + 完成标准 + GOAL_STATUS 标记契约 + 轮次上限 20）。
- `src/server/services/goal-stop-hook.ts`：Stop hook 评估器，挂入 `session.source === 'scheduled'` 且 claude 后端的会话选项。
- 非 claude 后端退化为纯 prompt 执行（包装文本仍携带完成协议，仅无评估器）；能力声明表登记 `scheduledGoalWrap: degraded`（opencode）。
- `scripts/spike-goal-sdk.ts`：路径 A/B 的活体探针脚本保留在仓库内，具备可用网络环境时可直接运行复验路径 A。

## 待复验项

- 路径 A（`/goal` 文本在 stream-json 输入下是否被解释为命令）：未验证；不影响当前实现。若未来验证可用，可经 `wrapInstructionForRun` 单点切换。
- 端到端活体验证（真实会话跑完包装 + 评估循环）随 U8 之后的整体冒烟执行。
