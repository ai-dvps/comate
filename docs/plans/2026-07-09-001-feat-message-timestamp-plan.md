---
title: Message Timestamp - Plan
type: feat
date: 2026-07-09
topic: message-timestamp
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

## Goal Capsule

- **Objective:** 在聊天会话的每条消息旁展示发送时间，让用户能判断消息发生的时间点。
- **Product authority:** 前端展示层改动，不改变现有消息数据模型或交互流程。
- **Open blockers:** 无。
- **Execution profile:** 纯前端改动，2-3 个原子提交。

## Product Contract

*Product Contract preservation: unchanged.*

### Summary

在会话消息旁添加时间戳，使用 24 小时制绝对时间，非当天消息显示完整日期时间；覆盖 user、assistant、system 和 meta 四类消息。这是一个纯前端展示改动，直接消费 `ChatMessage.timestamp`，不需要后端改动。

### Requirements

- R1. 在 `MessageList` 和 `VirtualizedMessageList` 渲染的每条消息旁显示时间戳。
- R2. 时间戳使用 24 小时制绝对时间格式（`HH:mm`）。
- R3. 非当天发出的消息显示完整日期时间（例如 `2026-07-08 14:32`）。
- R4. 时间戳覆盖 user、assistant、system 和 meta 四类消息。
- R5. 时间戳位于消息气泡/内容外部下方：user 消息右对齐、assistant 消息左对齐、system 和 meta 消息位于容器右下角。
- R6. 时间戳使用现有 muted/tertiary text token，字号小于正文，不抢夺消息主体注意力。
- R7. 不新增后端字段或 API；直接使用已有 `ChatMessage.timestamp`。

### Key Decisions

- **外部时间戳而非气泡内时间戳。** 当前助手消息没有背景气泡，若将时间戳放入气泡内需先为助手消息引入气泡样式；外部时间戳能复用现有布局。
- **绝对时间而非相对时间。** 24 小时制绝对时间无需定时刷新；跨天场景通过完整日期时间直接解决，避免“刚刚 / 2 分钟前”等相对标签的维护成本。
- **完整日期时间处理跨天。** 非当天消息直接显示 `YYYY-MM-DD HH:mm`，不引入“昨天 / 前天”等相对日期标签。

### Scope Boundaries

- 不在消息气泡内部显示时间戳。
- 不添加相对时间标签（如“刚刚 / Just now / 2 分钟前”）或 hover tooltip。
- 不添加用户可配置的时间格式、时区或显示/隐藏开关。
- 不改后端 schema、数据库表结构或 SSE/API 载荷。

### Dependencies / Assumptions

- 依赖 `ChatMessage.timestamp` 已存在且服务器在创建消息时已填充为 `Date.now()`。
- 时间格式化可复用或扩展 `src/client/i18n/{en,zh-CN}/chat.json` 中的 `time.*` 键。

### Sources / Research

- `src/client/types/message.ts:48` — `ChatMessage.timestamp: number`
- `src/server/services/message-normalizer.ts:201` — 消息创建时写入 `timestamp: Date.now()`
- `src/client/components/MessageList.tsx` — 短会话消息列表渲染入口
- `src/client/components/VirtualizedMessageList.tsx` — 长会话虚拟化消息列表渲染入口
- `src/client/components/ChatMessageRenderer.tsx` — 单条消息渲染组件
- `src/client/components/ai-elements/message.tsx` — `Message` / `MessageContent` 基础组件
- `src/client/components/ai-elements/muted-system-note.tsx` — 系统元信息渲染
- `src/client/components/ai-elements/slash-command-message.tsx` — slash command 渲染
- `src/client/components/chat-message-adapter.ts` — `adaptChatMessage` 当前丢弃 `timestamp`
- `src/client/i18n/{en,zh-CN}/chat.json` — 现有 `chat:time.*` 国际化键

## Planning Contract

### Key Technical Decisions

- **在 `adaptChatMessage` 中保留 `timestamp`，而不是在渲染层重新查找原始消息。** `ChatMessageRenderer` 只接收 `RenderableMessage`，因此需要把 `timestamp` 一并适配进渲染类型。这比在每个渲染入口保留原始 `ChatMessage` 更内聚。
- **使用纯 JavaScript `Date` API 格式化，不引入 `date-fns`。** 需求只需要当天 `HH:mm` 与非当天 `YYYY-MM-DD HH:mm` 两种固定格式，标准 `Date` 方法足够；避免新增依赖和包体积。
- **时间戳作为 `Message` 组件外部的独立元素渲染。** `ai-elements/message.tsx` 中的 `Message` / `MessageContent` 保持通用；`ChatMessageRenderer` 负责把 `Message` 和时间戳组合成完整消息行。

### Sequencing

U1 → U2 → (U3, U4 可并行) → U5

## Implementation Units

### U1. 添加时间格式化工具

- **Goal:** 创建可复用的消息时间戳格式化函数，覆盖当天与非当天两种场景。
- **Requirements:** R2, R3
- **Dependencies:** 无
- **Files:**
  - 新建 `src/client/lib/format-message-timestamp.ts`
  - 新建 `src/client/lib/format-message-timestamp.test.ts`
- **Approach:** 函数接收 `timestamp: number`，比较日期与当前日期是否为同一天；当天返回 `HH:mm`，非当天返回 `YYYY-MM-DD HH:mm`。使用 `Date` 的原生方法（`getFullYear`、`getMonth`、`getDate`、`getHours`、`getMinutes`）并补零，避免依赖时区解析歧义。
- **Patterns to follow:** 与 `src/client/components/analytics/analytics-utils.ts` 中纯函数工具风格一致。
- **Test scenarios:**
  - 当天时间戳返回 24 小时制 `HH:mm`。
  - 非当天时间戳返回 `YYYY-MM-DD HH:mm`。
  - 跨午夜边界（本地时间 00:00 前后）被正确识别为不同日期。
  - 非法/缺失时间戳返回空字符串或兜底占位符。
- **Verification:** 新测试通过，格式化输出与需求示例一致。

### U2. 在 `RenderableMessage` 中保留 `timestamp`

- **Goal:** 让 `ChatMessageRenderer` 能在不接触原始 `ChatMessage` 的情况下拿到消息时间。
- **Requirements:** R7
- **Dependencies:** U1
- **Files:**
  - `src/client/components/chat-message-adapter.ts`
  - `src/client/components/ChatMessageRenderer.tsx`（类型引用）
- **Approach:** 在 `RenderableMessage` 接口增加 `timestamp?: number`；在 `adaptChatMessage` 中复制 `msg.timestamp`。`adaptSubagentMessage` 可同步补充，但本次需求范围只要求主会话消息。
- **Patterns to follow:** 保持 `RenderableMessage` 向后兼容，`timestamp` 可选，避免破坏未传入该字段的调用点。
- **Test scenarios:**
  - `adaptChatMessage` 保留输入消息的 `timestamp`。
  - 无 `timestamp` 的输入仍能正常适配。
  - 现有 `ChatMessageRenderer.test.tsx` 中 `makeTextMessage` 可传入 `timestamp`。
- **Verification:** 相关单元测试通过，TypeScript 无新增错误。

### U3. 在 `ChatMessageRenderer` 中渲染时间戳

- **Goal:** 为 user、assistant、system 消息行添加外部时间戳。
- **Requirements:** R1, R2, R3, R4, R5, R6
- **Dependencies:** U2
- **Files:**
  - `src/client/components/ChatMessageRenderer.tsx`
  - `src/client/components/ChatMessageRenderer.test.tsx`
- **Approach:** 在 `Message` 组件外部包裹一个 flex 列，消息内容在下，时间戳在下；user 消息整体右对齐，时间戳右对齐；assistant/system 消息左对齐，时间戳左对齐。system 的 api_retry 小字提示也保留时间戳。使用 U1 的格式化函数和现有 `text-text-tertiary`、`text-xs` 等 token。
- **Patterns to follow:** 复用 `src/client/components/ui/utils.ts` 的 `cn()`；保持 `Message` 和 `MessageContent` 原样不动。
- **Test scenarios:**
  - user 消息渲染出格式化后的时间戳。
  - assistant 消息渲染出格式化后的时间戳。
  - system 消息（含 api_retry）渲染出格式化后的时间戳。
  - 跨天消息渲染完整日期时间。
  - 时间戳不影响搜索高亮布局。
- **Verification:** 组件测试通过，视觉检查 message 行间距不突兀。

### U4. 在 meta 消息组件中渲染时间戳

- **Goal:** 让 slash command 和 muted system note 也显示时间戳。
- **Requirements:** R1, R2, R3, R4, R5, R6
- **Dependencies:** U1
- **Files:**
  - `src/client/components/ai-elements/slash-command-message.tsx`
  - `src/client/components/ai-elements/muted-system-note.tsx`
  - `src/client/components/MessageList.tsx`
  - `src/client/components/VirtualizedMessageList.tsx`
- **Approach:**
  - 给 `SlashCommandMessage` 和 `MutedSystemNote` 增加 `timestamp?: number` prop。
  - 在 `MessageList` 和 `VirtualizedMessageList` 的 `renderViewItem` 中，从原始 `ViewItem` 取得对应消息的 `timestamp` 并传入。
  - 注意 `ViewItem` 的 `meta`/`meta-paired`/`message` 形态需能取到 `timestamp`；若 `pairCliMeta` 未保留，需先让 `ViewItem` 携带该字段。
  - meta 消息的时间戳放在 `NoteFrame` 的右下角或独立一行右对齐，保持与 user/assistant 消息时间戳视觉一致。
- **Patterns to follow:** `MutedSystemNote` 现有 `NoteFrame` 使用 `text-text-tertiary text-xs`；时间戳沿用同一样式。
- **Test scenarios:**
  - slash command 消息显示时间戳。
  - local-stdout / local-stderr / system-reminder 显示时间戳。
  - `VirtualizedMessageList` 中的 meta 消息同样显示时间戳。
- **Verification:** 测试通过，长会话切换到虚拟化列表后时间戳不消失。

### U5. 添加/更新测试

- **Goal:** 保证新时间戳行为有自动化覆盖。
- **Requirements:** R1-R7
- **Dependencies:** U3, U4
- **Files:**
  - `src/client/components/ChatMessageRenderer.test.tsx`
  - `src/client/components/MessageList.test.tsx`
  - `src/client/lib/format-message-timestamp.test.ts`
- **Approach:** 补充 timestamp 字段到测试 fixture；为 user/assistant/system 消息添加“渲染时间戳”断言；为 `MessageList` 添加端到端断言（至少一条消息列表中的时间戳可见）。
- **Patterns to follow:** 现有测试使用 `@testing-library/react` 和 vitest；mock `useTranslation` 返回 key，因此时间戳断言可直接匹配格式化字符串。
- **Test scenarios:**
  - `ChatMessageRenderer` 对每种 role 渲染正确时间戳。
  - `MessageList` 渲染单条 user 消息时显示时间戳。
  - 格式化工具边界正确。
- **Verification:** `npm run test:client` 通过。

## Verification Contract

- **Lint:** `npm run lint` 无错误。
- **Client tests:** `npm run test:client` 全部通过。
- **Browser smoke:** 启动 `npm run dev:server` 与 `npm run dev:client`，发送一条用户消息并等待助手回复，确认两条消息均显示时间戳；切换到一个历史会话，确认非当天消息显示完整日期时间。

## Definition of Done

- 所有四类消息（user、assistant、system、meta）在 `MessageList` 与 `VirtualizedMessageList` 中均显示时间戳。
- 当天消息显示 `HH:mm`，非当天消息显示 `YYYY-MM-DD HH:mm`。
- `adaptChatMessage` 保留 `timestamp`，`RenderableMessage` 类型向后兼容。
- 新增格式化函数有独立单元测试。
- 组件测试覆盖 user、assistant、system 与 meta 消息的时间戳渲染。
- `npm run lint` 与 `npm run test:client` 通过。
- 没有遗留的实现草稿、调试代码或未解决的 review 意见。
