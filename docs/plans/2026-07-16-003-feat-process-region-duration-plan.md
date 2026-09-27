---
title: Process Region Duration - Plan
type: feat
date: 2026-07-16
topic: process-region-duration
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Process Region Duration - Plan

## Goal Capsule

- **Objective:** 在 result focus 模式下，给每个折叠的 process region ghost 增加累计用时时长显示，让用户一眼看到中间过程已经运行了多久。
- **Product authority:** 来自本次 brainstorm 对话；实现细节由规划阶段决定。
- **Execution profile:** Client-only React 改动，不改动服务端、存储或消息数据模型。
- **Stop conditions:** ghost 正确显示区域累计时长；streaming 时按秒刷新；缺失数据时显示占位符；相关测试通过。
- **Open blockers:** 无。

---

## Product Contract

*Product Contract unchanged from the requirements-only brainstorm (R-IDs preserved). This pass adds the Planning Contract, Implementation Units, Verification Contract, and Definition of Done.*

### Summary

在 result focus 模式下，每个折叠的 process region ghost 除了步骤数和最新步骤名称外，还显示该区域的累计用时时长。时长基于现有消息 timestamp 估算，streaming 时以当前时间为动态终点并按秒刷新，完成后定格为最终时长。

### Problem Frame

当前 result focus 模式下，ghost 只显示步骤数和最新步骤名称。用户无法快速判断这个过程区域已经运行了多久，尤其在长耗时任务或 streaming 过程中，缺少时间感知会造成不确定感。

### Key Decisions

- **用现有消息 timestamp 估算，不新增步骤级时间戳。** 实现成本低，但接受同一消息内多个步骤时长可能接近 0 的精度限制。
- **streaming 时以当前时间为动态终点，每秒刷新。** 让用户实时看到进行中的累计耗时。
- **时长放在步骤数与最新步骤名称之间。** 保持现有信息顺序，新增时长作为中间补充。
- **缺失 timestamp 时显示占位符。** 旧消息或异常数据不隐藏 ghost，而是以占位符提示数据不可用。

### Requirements

- R1. 在 result focus 模式下，每个 process region ghost 显示该区域的累计用时时长。
- R2. 时长显示在步骤数与最新步骤名称之间。
- R3. 区域累计时长以该区域第一个 part 所属消息的 `timestamp` 为起点，以最后一个 complete part 所属消息的 `timestamp` 为终点；若区域仍在 streaming，则以当前时间作为动态终点。
- R4. streaming 中的 ghost 每秒刷新一次已用时间。
- R5. 当无法获取有效时间戳数据时，ghost 的时长位置显示占位符（如 `—`）。
- R6. 时长格式复用现有 `formatDuration` 语义（小于 60 秒显示秒，否则显示分+秒）。
- R7. linear 模式不受此改动影响，保持现有渲染行为。

### Scope Boundaries

- 不增加 `MessagePart` 的 `startedAt` / `endedAt` 等精确时间字段。
- 不显示单个步骤的独立时长或 drawer 内的时间线细节。
- 不修改 linear 模式的消息渲染。
- 不历史回填旧消息的时间数据；旧数据按 R5 显示占位符。

### Dependencies / Assumptions

- `ChatMessage.timestamp` 可用于估算 process region 的起点。
- 现有 `formatDuration` 工具函数位于 `src/client/lib/time.ts`，可直接复用。
- `ProcessRegion` 的数据结构需要把每个 part 所属消息的时间戳传递到渲染层。

### Outstanding Questions

- 无。

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Carry the message timestamp on each `RenderablePart`, not on a new message-model field.** `chat-message-adapter.ts` already maps every `MessagePart` to a `RenderablePart` per message. Adding an optional `timestamp` field there lets `groupMessageParts` compute region duration without changing the server schema, store shape, or persistence layer. Rationale: matches the brainstorm's chosen data granularity and keeps the change client-only.
- **KTD2. Reuse the `useElapsed` timing pattern from `SubagentBriefStatus`.** That component already solves the same problem (live elapsed time while running, final duration when done, 1-second refresh). Copying its shape into `ProcessRegionGhost` keeps behavior consistent across the chat UI. Rationale: avoids inventing a second timing abstraction for the same user-visible need.
- **KTD3. Keep the duration inside the existing ghost layout, between the step count and the latest-step label.** This preserves the current reading order and only adds one extra segment to the one-line button. Rationale: aligns with the brainstorm's placement decision and minimizes visual disruption.
- **KTD4. Treat a missing or invalid timestamp as a placeholder rather than hiding the ghost.** The region is still useful for step count and latest step even when timing data is unavailable. Rationale: matches R5 and avoids losing useful context for old messages.

### Assumptions

- `ChatMessage.timestamp` is present and reliable for messages produced after this change ships; old messages may lack it and fall back to the placeholder.
- A region whose last part is still streaming is considered "running", so duration updates every second until the last part completes.
- Within a single merged assistant turn, all parts from the same underlying `ChatMessage` share that message's timestamp. Duration estimates can be slightly conservative when multiple steps arrive in one message.

### Sequencing

U1 (add timestamp to renderable parts) must land before U2 (grouping exposes timestamps). U3 (ghost renders duration) depends on U2. U4 (renderer-level regression tests) depends on U3. Recommended order: U1 → U2 → U3 → U4.

---

## Implementation Units

### U1. Add message timestamp to RenderablePart

- **Goal:** 让每个 `RenderablePart` 携带所属 `ChatMessage` 的 `timestamp`，为后续 region 时长计算提供数据。
- **Requirements:** R3
- **Dependencies:** 无
- **Files:**
  - `src/client/components/chat-message-adapter.ts` (modify)
  - `src/client/components/chat-message-adapter.test.ts` (create，若不存在)
- **Approach:** 在 `RenderablePart` 的类型联合中为每个分支增加可选的 `timestamp?: number` 字段；在 `adaptChatMessage` 中为每个生成的 part 设置 `timestamp: msg.timestamp`。`adaptSubagentMessage` 可以传 `undefined` 或保留消息时间，视实现方便而定。
- **Patterns to follow:** 保持 `chat-message-adapter.ts` 现有的纯转换风格；不要在这里过滤或解释时间，只传递原始消息 timestamp。
- **Test scenarios:**
  - `adaptChatMessage` 为 text/thinking/tool_use/tool_result part 设置正确的 `timestamp`
  - 现有 part 字段（text、toolName、isStreaming 等）保持不变
  - `buildResultMap` 和 `toToolState` 等下游 helper 不受新字段影响
- **Verification:** 类型检查通过；新/现有测试绿色；没有未使用的字段触发 `noUnusedLocals`。

### U2. Expose per-part timestamps in ProcessRegion

- **Goal:** 让 `ProcessRegion` 携带与其 `parts` 对齐的时间戳数组，方便 `ProcessRegionGhost` 计算区域累计时长。
- **Requirements:** R3
- **Dependencies:** U1
- **Files:**
  - `src/client/components/message-grouping.ts` (modify)
  - `src/client/components/message-grouping.test.ts` (modify)
- **Approach:** 在 `ProcessRegion` 接口中增加 `timestamps: (number | undefined)[]` 字段，与 `parts` 数组一一对应。修改 `groupMessageParts`，在累积 process part 的同时把 `part.timestamp` 放入 `timestamps`；空/空白 text 被跳过时不应影响对齐。
- **Patterns to follow:** 保持 `groupMessageParts` 为纯函数；测试风格与现有 `message-grouping.test.ts` 一致。
- **Test scenarios:**
  - process region 的 `timestamps` 数组长度与 `parts` 一致
  - 空/空白 text 被忽略后，前后 process region 的 timestamps 仍然连续且对齐
  - 单个 thinking/tool 组成的 region 也有正确的 timestamps
  - streaming flag 在 part 上保留（与现有测试一致）
- **Verification:** `npm run test:client` 中 `message-grouping.test.ts` 全绿；类型检查通过。

### U3. Render elapsed duration in ProcessRegionGhost

- **Goal:** 在 ghost 上显示区域累计时长，streaming 时每秒刷新，缺失数据时显示占位符。
- **Requirements:** R1, R2, R3, R4, R5, R6
- **Dependencies:** U2
- **Files:**
  - `src/client/components/ProcessRegionGhost.tsx` (modify)
  - `src/client/components/ProcessRegionGhost.test.tsx` (create)
  - `src/client/i18n/en/chat.json` (modify)
  - `src/client/i18n/zh-CN/chat.json` (modify)
- **Approach:** 复用 `SubagentBriefStatus.tsx` 中的 `useElapsed` 模式：
  - 区域起点：第一个有效 timestamp
  - 区域终点：最后一个 part 的 timestamp（若已 complete）或当前时间（若仍在 streaming）
  - streaming 时用 `setInterval(..., 1000)` 刷新 elapsed
  - 无有效 timestamp 时显示占位符 `—`
  - 用现有 `formatDuration` 格式化
  - 将时长渲染在步骤数与最新步骤名称之间
  - 更新 i18n 键（如 `displayMode.ghostLabel`、`displayMode.duration` 等）以支持时长文案
- **Patterns to follow:** `SubagentBriefStatus.tsx` 的 `useElapsed` hook；`displayMode` i18n 命名空间；`ProcessRegionGhost` 现有的小按钮样式和 `aria-label`。
- **Test scenarios:**
  - 显示格式化后的区域时长（如 `12s`）
  - streaming 时时长按秒递增（可用 Vitest fake timers）
  - 区域完成后时长定格，不再变化
  - 缺失 timestamp 时显示占位符
  - 时长位于步骤数和最新步骤名称之间
  - `aria-label` 包含时长信息（无障碍）
- **Verification:** `ProcessRegionGhost.test.tsx` 全绿；手动在 `npm run dev:client` 中观察 streaming ghost 的时长刷新。

### U4. Regression coverage for result and linear modes

- **Goal:** 确保改动不破坏 result mode 和 linear mode 的现有渲染行为。
- **Requirements:** R7
- **Dependencies:** U3
- **Files:**
  - `src/client/components/ChatMessageRenderer.result.test.tsx` (modify)
- **Approach:** 在现有 result mode 测试中增加对 ghost 时长的断言；在 linear mode 测试中确认没有 ghost 出现。
- **Patterns to follow:** 现有 `ChatMessageRenderer.result.test.tsx` 的测试 helper 和 `I18nextProvider` 包装。
- **Test scenarios:**
  - result mode 下 ghost 渲染包含时长
  - linear mode 下仍不渲染任何 ghost
- **Verification:** `npm run test:client` 中 `ChatMessageRenderer.result.test.tsx` 全绿。

---

## Verification Contract

- `npm run lint` — ESLint passes on all touched `.ts`/`.tsx`.
- `npm run test:client` — Vitest (jsdom) covers:
  - `chat-message-adapter.test.ts` (U1)
  - `message-grouping.test.ts` (U2)
  - `ProcessRegionGhost.test.tsx` (U3)
  - `ChatMessageRenderer.result.test.tsx` (U4)
- Manual check via `npm run dev:client` (or `npm run tauri:dev`): start a new session in result mode, watch a streaming turn, and confirm the ghost shows a live elapsed time that stops updating when the region completes; verify linear mode shows no ghost.

---

## Definition of Done

- U1 implemented and `chat-message-adapter.test.ts` green.
- U2 implemented and `message-grouping.test.ts` green.
- U3 implemented and `ProcessRegionGhost.test.tsx` green.
- U4 implemented and `ChatMessageRenderer.result.test.tsx` green.
- `npm run lint` clean.
- Manual check confirms streaming and completed duration behavior.
- `CHANGELOG.md` updated for the user-facing change.
- No dead-end or experimental code remains in the diff.
