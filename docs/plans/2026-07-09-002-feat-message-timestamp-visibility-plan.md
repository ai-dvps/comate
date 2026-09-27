---
title: Message Timestamp Visibility - Plan
type: feat
date: 2026-07-09
topic: message-timestamp-visibility
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

## Goal Capsule

- **Objective:** 调整前端渲染逻辑，让时间戳只出现在用户消息、Assistant 最终文本回复、stdout/stderr meta 消息和 Interrupt 系统消息上，从而减少消息之间的空白间隔。
- **Product authority:** 纯前端展示层改动，只调整哪些消息渲染时间戳，不修改时间格式、位置或消息数据模型。
- **Open blockers:** 无。
- **Execution profile:** 小范围前端调整，1 个原子提交。

## Product Contract

### Summary

时间戳功能上线后发现消息之间存在较大空白间隔。经过讨论，决定保留时间戳在消息外部下方、hover 显示的位置不变，但只在用户消息、Assistant 最终回复、stdout/stderr 和 Interrupt 消息上显示；thinking、tool_use、subagent 等过程性消息不再显示时间戳，从而自然减少空白间隔。

### Requirements

- R1. 用户消息显示时间戳。
- R2. Assistant 最终回复（普通 assistant 文本消息）显示时间戳。
- R3. stdout / stderr 类型的 meta 消息显示时间戳。
- R4. Interrupt 类型的 system 消息显示时间戳。
- R5. thinking、tool_use、subagent（以 `tool_use` 且 `toolName === 'Agent'` 形式出现）等过程性消息/卡片不显示时间戳。
- R6. 时间戳保持现有位置和 hover 行为：位于消息外部下方，默认隐藏，hover 时渐显。
- R7. 时间戳格式保持不变：当天 `HH:mm`，非当天 `YYYY-MM-DD HH:mm`。

### Key Decisions

- **通过减少显示位置解决间距问题，而不是移动时间戳位置。** 用户最初考虑过把时间戳移入消息内部或 thinking header 末尾，但最终确认减少需要显示时间戳的消息类型后，现有外部位置即可接受，避免引入新的气泡/布局改动。
- **过程性消息不显示时间戳。** thinking、tool_use、subagent 属于中间过程，用户更关注最终回复的时间点；去掉这些时间戳能显著降低视觉噪音和行间距。

### Scope Boundaries

- 不改时间格式、时区或 hover 交互。
- 不改消息气泡样式或给 assistant 消息引入背景气泡。
- 不改后端 schema、数据库或 API。
- 不把时间戳移入消息内容内部或 thinking header。
- 不处理 paired slash-command 输出中可能存在的时间戳重复问题；本次只按消息类型过滤可见性。

## Planning Contract

### Key Technical Decisions

- **KTD-1. 在 `ChatMessageRenderer` 内部按消息角色和 part 类型过滤时间戳。** `ChatMessageRenderer` 已经掌握完整的 `message.parts`，是做出“是否最终回复”判断的最自然位置；调用方只需继续透传 `timestamp`。
- **KTD-2. 在 `MutedSystemNote` 内部按 event kind 过滤时间戳。** `MutedSystemNote` 已经知道自己在渲染哪种 CLI meta 事件，由它决定何时渲染可以避免调用方重复维护条件分支。
- **KTD-3. 复用现有的 `formatMessageTimestamp` 和 hover-reveal 样式。** 时间戳格式、位置、动画已满足需求，本次只改动“是否渲染”这一条件。

### Assumptions

- A1. `slash-command` 属于用户输入的一种表现形式，按“用户消息”处理，继续显示时间戳。
- A2. `system-reminder` 等非 Interrupt 系统消息不显示时间戳。
- A3. Assistant 消息只要包含 thinking、tool_use 或 subagent（以 `tool_use` 且 `toolName === 'Agent'` 形式出现）等过程性 part，整消息即视为“非最终回复”，不显示时间戳；只有纯文本 part 的 assistant 消息才显示。
- A4. 已实现的 `formatMessageTimestamp` 和消息级 `timestamp` 透传保持可用。
- A5. `RenderableMessage.subType` 已能区分 `api_retry` 与 `Interrupt`；`parts` 类型已能区分 thinking、tool_use 与 subagent（`tool_use` 且 `toolName === 'Agent'`）。

## Implementation Units

### U1. Filter timestamps in ChatMessageRenderer

- **Goal:** 让 `ChatMessageRenderer` 只在用户消息、Assistant 纯文本回复和 Interrupt 系统消息上渲染时间戳。
- **Requirements:** R1, R2, R4, R5.
- **Dependencies:** 无.
- **Files:**
  - 修改：`src/client/components/ChatMessageRenderer.tsx`
  - 测试：`src/client/components/ChatMessageRenderer.test.tsx`
- **Approach:**
  - 系统消息分支：仅在 `message.subType === 'Interrupt'` 时渲染 `MessageTimestamp`；`api_retry` 和普通系统消息完全不渲染。
  - user/assistant 分支：在渲染 `MessageTimestamp` 前判断 `message.role === 'user' || message.parts.every((p) => p.type === 'text')`，确保包含 thinking、tool_use、subagent 的 assistant 消息不渲染时间戳（不渲染，而不是仅 opacity-0 隐藏）。
- **Patterns to follow:** 现有 `MessageTimestamp` helper、外层 `group` 容器的 hover-reveal类。
- **Test scenarios:**
  - 用户消息显示当天/跨天时间戳，并带有 `opacity-0` 类。
  - Assistant 纯文本消息显示时间戳。
  - Assistant 消息包含 thinking part 时不渲染时间戳。
  - Assistant 消息包含 tool_use part 时不渲染时间戳。
  - Assistant 消息包含 subagent（toolName === 'Agent'）part 时不渲染时间戳。
  - Interrupt 系统消息显示时间戳。
  - `api_retry` 系统消息不渲染时间戳。
  - 普通系统消息不渲染时间戳。
- **Verification:** `ChatMessageRenderer.test.tsx` 通过；手动验证 hover 渐显行为不变。

### U2. Filter timestamps in MutedSystemNote

- **Goal:** 让 `MutedSystemNote` 只在 stdout、stderr 上渲染时间戳，system-reminder 不渲染。slash-command 由 `SlashCommandMessage` 单独渲染，其时间戳行为已在 R1 下满足。
- **Requirements:** R3, R5.
- **Dependencies:** 无.
- **Files:**
  - 修改：`src/client/components/ai-elements/muted-system-note.tsx`
  - 测试：`src/client/components/MessageList.test.tsx`
- **Approach:**
  - 在 `SystemReminderNote` 中忽略 `timestamp` prop，完全不渲染内联时间戳元素，避免继续占用布局空间；`stdout`/`stderr` 保持现有 hover 样式。
- **Patterns to follow:** 现有 `NoteFrame`、`StdoutBlock`、`StderrBlock` 的 hover-reveal 样式。
- **Test scenarios:**
  - stdout 消息显示时间戳。
  - stderr 消息显示时间戳。
  - system-reminder 消息不渲染时间戳。
- **Verification:** `MessageList.test.tsx` 通过；手动验证 system-reminder 无时间戳留白。

### U3. Update existing timestamp tests

- **Goal:** 调整现有测试，使其准确反映新的时间戳可见性规则。
- **Requirements:** R1-R7.
- **Dependencies:** U1, U2.
- **Files:**
  - 测试：`src/client/components/ChatMessageRenderer.test.tsx`
  - 测试：`src/client/components/MessageList.test.tsx`
- **Approach:**
  - 删除或反转现有 `api_retry` 和 generic system 的“显示时间戳”断言。
  - 在 `ChatMessageRenderer.test.tsx` 中新增 assistant 含 thinking/tool_use 的隐藏断言。
  - 在 `MessageList.test.tsx` 中新增 system-reminder 不显示时间戳的断言。
- **Verification:** 相关测试通过，且没有误将隐藏的时间戳断言为存在。

## Verification Contract

| Gate | Command | Applies to |
|------|---------|------------|
| Unit tests | `npm run test:client -- --run src/client/components/ChatMessageRenderer.test.tsx src/client/components/MessageList.test.tsx` | U1, U2, U3 |
| Lint | `npm run lint` | 全部 |

## Definition of Done

- 用户消息、Assistant 纯文本回复、stdout/stderr meta 消息、Interrupt 系统消息在 hover 时显示时间戳。
- thinking、tool_use、subagent、api_retry、system-reminder 和普通 system 消息不显示时间戳。
- 上述规则被 `ChatMessageRenderer.test.tsx` 和 `MessageList.test.tsx` 覆盖。
- `npm run lint` 与相关单元测试通过。
- 如有用户可见行为变化，更新 `CHANGELOG.md` `[Unreleased]` 条目。

## Deferred / Open Questions

### From 2026-07-09 review

- **Interrupt system message type does not exist** — Requirements / Assumptions / Implementation Unit 1 (P1, feasibility, confidence 100)

  R4 and the U1 test scenario require showing a timestamp on a message type that is never created. The implementer cannot write a correct test or branch for `subType === 'Interrupt'` against the current codebase, and following the plan literally would leave the intended interrupt case unhandled.

- **Requirements mix visibility and presentation without grouping** — Product Contract — Requirements (P3, coherence, confidence 75)

  R1–R5 govern which message types show timestamps, while R6 governs position/hover and R7 governs format. Without thematic grouping, readers may miss that R6/R7 are global invariants and accidentally change them while editing visibility rules, or write tests that conflate the two concerns.

- **Touch devices cannot reveal hover-only timestamps** — Product Contract / Requirements R6 (P1, design-lens, confidence 100)

  The plan preserves a hover-reveal pattern, but touch-based devices have no hover state. Users on tablets, phones, or hybrid devices will be unable to access message timestamps, creating an inconsistent cross-device experience and an accessibility gap.

- **Keyboard and screen-reader access for timestamp reveal is unspecified** — Product Contract / Requirements R6 (P1, design-lens, confidence 100)

  Relying solely on hover excludes keyboard users and may create inconsistent screen-reader output if opacity-hidden timestamps remain in the DOM. The plan needs to specify focus-triggered reveal and whether hidden timestamps are removed from the accessibility tree.
