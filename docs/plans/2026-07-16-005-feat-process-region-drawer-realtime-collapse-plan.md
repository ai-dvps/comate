---
title: Process Region Drawer Real-Time Updates and Default Collapse - Plan
type: feat
date: 2026-07-16
topic: process-region-drawer-realtime-collapse
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Process Region Drawer Real-Time Updates and Default Collapse - Plan

## Goal Capsule

- **Objective:** 在 result focus 模式下打开 process region drawer 时，内部步骤/message 应随 streaming 实时更新，并且默认处于折叠状态。
- **Product authority:** 用户直接提出；scope 已在 planning bootstrap 中确认。
- **Execution profile:** Client-only React 改动，不改动服务端、存储或消息数据模型。
- **Stop conditions:** drawer 内工具卡片默认折叠；streaming 时 drawer 内容实时刷新；现有 linear 模式聊天工具卡片保持默认展开；相关测试通过。
- **Open blockers:** 无。

---

## Product Contract

### Summary

当用户在 result focus 模式下点击 process region ghost 打开侧栏 drawer 后，drawer 中渲染的 thinking/tool 步骤应随消息流实时更新，并且工具卡片默认折叠（仅显示 header，详情通过 toggle 展开）。 Thinking 在 drawer 内保持默认折叠，文本内容保持可见，普通 linear 聊天中的工具卡片行为不变。

### Problem Frame

当前 process region drawer 打开后，用户观察到内部 message 不会实时刷新；同时 drawer 中的工具卡片默认是展开的，导致长步骤占用大量空间，用户需要先滚动才能看清整体流程。这两个问题降低了 result focus 模式下查看中间过程的体验。

### Requirements

- R1. Process region drawer 打开期间，当对应 session 的消息流产生新 part 时，drawer 内容应实时反映这些变化。
- R2. Drawer 中的 tool_use 卡片默认折叠：显示 ToolHeader，工具输入/输出详情默认隐藏，提供 toggle 展开。
- R3. Drawer 中的 thinking 卡片保持默认折叠（复用现有 linear 模式行为）。
- R4. Drawer 中的文本 part 保持可见，不受折叠影响。
- R5. 普通 linear 模式聊天（drawer 外部）中的工具卡片仍默认展开。

### Scope Boundaries

- 不修改 process region ghost 本身（步骤数、时长、最新步骤等保持现有行为）。
- 不修改 subagent drawer 或 workflow drawer 的默认折叠行为。
- 不新增消息字段或服务器 payload。
- 不修改消息分组/region 计算逻辑（`message-grouping.ts` 的 `ProcessRegion` 结构保持不变）。

### Dependencies / Assumptions

- Process region drawer 通过 `DetailDrawer.tsx` 中的 `ProcessBody` 渲染，且 `ProcessBody` 使用 `displayMode="linear"` 调用 `ChatMessageRenderer`。
- `ToolContent` 当前硬编码 `alwaysExpanded`，导致 linear 模式下所有工具卡片默认展开。
- `Reasoning` 在 linear 模式下已因 `defaultOpen={false}` + `disableAutoBehavior` 而默认折叠。
- 消息 store 更新时会产生新的 `ChatMessage` 对象和新的 messages 数组，因此 `ProcessBody` 的 `useChatStore` selector 已经具备实时刷新的订阅基础。

### Outstanding Questions

- 无。

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Add a `defaultToolExpanded` prop to `ChatMessageRenderer`.** Default `true` preserves existing linear-mode behavior outside the drawer. `ProcessBody` passes `false` so tools inside the process region drawer start collapsed. Rationale: scopes the behavior change to the drawer without affecting normal chat.
- **KTD2. Make `ToolContent` accept an `alwaysExpanded` prop instead of hardcoding it.** The prop defaults to `true` (current behavior) and is plumbed into `CompactableContainer`. When `false`, the container renders in its compactable state and shows the "Show details" toggle if content overflows. Rationale: reuses the existing `CompactableContainer` collapse mechanism rather than introducing a new collapsible primitive.
- **KTD3. Keep thinking collapse behavior unchanged.** `ChatMessageRenderer` already passes `defaultOpen={false}` and `disableAutoBehavior` to `Reasoning` in linear mode, which satisfies R3 without additional code. Rationale: avoid duplicating collapse state management that `Reasoning` already handles.
- **KTD4. Treat real-time updates as characterization coverage on existing subscription wiring.** `ProcessBody` already subscribes to `s.messages[sessionId]` and recomputes `region` via `useMemo`. The plan adds tests that exercise streaming updates; if the tests reveal a memoization or caching gap, the implementer fixes it inside this scope. Rationale: the reactive surface appears correct from code inspection, but user-observed staleness needs executable proof.
- **KTD5. Internationalize the toggle labels when they become visible in the drawer.** `CompactableContainer` currently hardcodes "Show details" / "Hide details". Add optional `showMoreLabel` / `showLessLabel` props and pass translated strings from `ToolContent` so the drawer toggle is localizable. Rationale: user-facing text introduced by this change must follow the project's i18n convention.

### Assumptions

- "Collapsed by default" for tool cards means the header is visible and the input/output body is constrained by `CompactableContainer` with a toggle; short content that does not overflow still renders fully.
- The observed real-time staleness is in the React rendering layer, not in the server stream or store update path.
- Existing process region duration plan (`2026-07-16-003-feat-process-region-duration-plan.md`) lands independently; this plan does not depend on it.

### Sequencing

U1 must land before U2 (U2 consumes the new `ToolContent` prop). U2 must land before U3 (U3 passes the new `ChatMessageRenderer` prop). U4 depends on U3 (tests drawer behavior). U5 depends on U4 (real-time tests assume drawer renders correctly). Recommended order: U1 → U2 → U3 → U4 → U5.

---

## Implementation Units

### U1. Make ToolContent expansion configurable

- **Goal:** 让 `ToolContent` 支持 `alwaysExpanded` prop，默认保持当前行为，但允许调用方让工具卡片可折叠。
- **Requirements:** R2
- **Dependencies:** 无
- **Files:**
  - `src/client/components/ai-elements/tool.tsx` (modify)
  - `src/client/components/ai-elements/tool.test.tsx` (modify)
  - `src/client/components/ai-elements/compactable-container.tsx` (modify)
  - `src/client/i18n/en/chat.json` (modify)
  - `src/client/i18n/zh-CN/chat.json` (modify)
- **Approach:**
  - 在 `ToolContentProps` 中新增 `alwaysExpanded?: boolean`，默认 `true`。
  - 将 `alwaysExpanded` 传给 `CompactableContainer`。
  - 在 `CompactableContainerProps` 中新增可选的 `showMoreLabel` / `showLessLabel`，用于替换硬编码的 "Show details" / "Hide details"。
  - 在 `ToolContent` 中通过 `useTranslation('chat')` 读取 `showDetails` / `hideDetails` 并传给 `CompactableContainer`。
  - 在 `chat.json`（en/zh-CN）中新增 `showDetails` / `hideDetails` 键。
- **Patterns to follow:** `CompactableContainer` 的现有用法（如 `SubagentBriefStatus.tsx`）；现有 `tool.test.tsx` 的 provider 包装。
- **Test scenarios:**
  - `ToolContent` 默认渲染无 toggle（向后兼容）。
  - `ToolContent alwaysExpanded={false}` 且内容超过 `compactHeight` 时渲染 "Show details" toggle。
  - 点击 toggle 后内容展开并显示 "Hide details"。
  - `forceExpanded` 为 true 时仍强制展开。
- **Verification:** `npm run test:client` 中 `tool.test.tsx` 全绿；`npm run lint` 通过。

### U2. Add `defaultToolExpanded` prop to ChatMessageRenderer

- **Goal:** 让 `ChatMessageRenderer` 的调用方可以控制工具卡片是否默认展开。
- **Requirements:** R2, R5
- **Dependencies:** U1
- **Files:**
  - `src/client/components/ChatMessageRenderer.tsx` (modify)
  - `src/client/components/ChatMessageRenderer.result.test.tsx` (modify)
  - `src/client/components/ChatMessageRenderer.test.tsx` (modify)
- **Approach:**
  - 在 `ChatMessageRendererProps` 中新增 `defaultToolExpanded?: boolean`，默认 `true`。
  - 在渲染 `tool_use` part 时，将 `defaultToolExpanded` 传给 `ToolContent` 的 `alwaysExpanded`。
  - 更新 `areEqual` 以将该 prop 纳入 memo 比较。
- **Patterns to follow:** 现有 `displayMode` prop 的处理方式；现有 `areEqual` 的字段比较风格。
- **Test scenarios:**
  - Linear 模式下 `defaultToolExpanded` 未传入时工具卡片仍默认展开（向后兼容）。
  - Linear 模式下 `defaultToolExpanded={false}` 时长内容工具卡片显示 toggle。
  - Result 模式下该 prop 不影响 ghost 渲染。
- **Verification:** `ChatMessageRenderer` 相关测试全绿；类型检查通过。

### U3. Configure ProcessBody to collapse tools by default

- **Goal:** 让 process region drawer 中的工具卡片默认折叠。
- **Requirements:** R2
- **Dependencies:** U2
- **Files:**
  - `src/client/components/DetailDrawer.tsx` (modify)
- **Approach:**
  - 在 `ProcessBody` 渲染 `ChatMessageRenderer` 时传入 `displayMode="linear"` 和 `defaultToolExpanded={false}`。
  - 保持其他 props（`message`, `resultMap`, `onOpenDrawer`, `sessionId`）不变。
- **Patterns to follow:** `ProcessBody` 现有构造 `detailMessage` 和调用 `ChatMessageRenderer` 的方式。
- **Test scenarios:**
  - Process drawer 打开时，长工具卡片显示 "Show details" toggle。
  - 点击 toggle 后显示工具输入/输出内容。
  - Thinking 卡片默认折叠（可通过 trigger 展开）。
  - 文本 part 直接可见。
- **Verification:** 手动在 `npm run dev:client` 中打开 process region drawer，观察工具卡片默认折叠。

### U4. Add real-time update coverage for ProcessBody

- **Goal:** 用测试证明 process region drawer 在消息流更新时能实时刷新内容。
- **Requirements:** R1
- **Dependencies:** U3
- **Files:**
  - `src/client/components/DetailDrawer.test.tsx` (modify)
  - `src/client/components/DetailDrawer.tsx` (modify only if tests reveal a gap)
- **Approach:**
  - 将 `DetailDrawer.test.tsx` 中的静态 `useChatStore` mock 替换为可订阅的可变 mock store，参考 `MessageList.result.test.tsx` 中的 `chatStoreMock` 模式。
  - 编写测试：初始渲染一个包含 process region 的消息，打开 drawer，随后更新 store 中的 messages（追加 tool_result、新增 tool_use 或更新 `inputJsonStream`），验证 drawer 中出现新内容。
  - 如果测试失败，定位并修复 `ProcessBody` 或 `ChatMessageRenderer` 中的 memo/缓存问题（例如 `adaptCache` WeakMap 在消息引用未变化时的失效问题）。
- **Patterns to follow:** `MessageList.result.test.tsx` 的 `chatStoreMock` 订阅模式；`ProcessRegionGhost.test.tsx` 的 region 构造 helper。
- **Test scenarios:**
  - 追加新的 tool_use part 后，drawer 中渲染对应工具卡片。
  - 同一 tool_use 的 `inputJsonStream` 更新后，streaming preview 中的文本同步更新。
  - tool_result 到达后，对应工具卡片状态从 running 变为 completed。
  - 未打开 drawer 时，更新消息不会导致 drawer 渲染（ drawer 关闭状态返回 null）。
- **Verification:** `DetailDrawer.test.tsx` 全绿；若发现 bug，修复后测试仍绿。

### U5. Regression tests for default collapse state in process drawer

- **Goal:** 确保 drawer 内默认折叠行为在后续改动中不被破坏。
- **Requirements:** R2, R3, R4, R5
- **Dependencies:** U3, U4
- **Files:**
  - `src/client/components/DetailDrawer.test.tsx` (modify)
- **Approach:**
  - 在 `DetailDrawer.test.tsx` 中补充 process view 的静态用例：包含 thinking、tool_use（长输入/输出）、text 的 region，验证各自的默认可见性。
  - 验证普通 linear 模式（非 drawer）的工具卡片不受 `defaultToolExpanded={false}` 影响。
- **Patterns to follow:** 现有 `ChatMessageRenderer.result.test.tsx` 的 i18n provider 包装；`tool.test.tsx` 的 `ToolRendererProvider` 包装。
- **Test scenarios:**
  - Process drawer 中 thinking trigger 可见，内容默认隐藏。
  - Process drawer 中 tool header 可见，工具输入/输出默认隐藏（有 toggle）。
  - Process drawer 中 text 内容直接可见。
  - Linear 模式 `ChatMessageRenderer` 默认工具卡片展开（无 toggle）。
- **Verification:** `npm run test:client` 全绿。

---

## Verification Contract

- `npm run lint` — ESLint passes on all touched `.ts`/`.tsx`.
- `npm run test:client` — Vitest (jsdom) covers:
  - `src/client/components/ai-elements/tool.test.tsx` (U1)
  - `src/client/components/ChatMessageRenderer.result.test.tsx` (U2)
  - `src/client/components/ChatMessageRenderer.test.tsx` (U2)
  - `src/client/components/DetailDrawer.test.tsx` (U4, U5)
- Manual check via `npm run dev:client` (or `npm run tauri:dev`): start a streaming turn in result mode, open a process region drawer, confirm new steps appear as they stream and tool cards are collapsed by default; verify normal linear chat still expands tool cards.

---

## Definition of Done

- U1–U3 implemented and type-check/lint clean.
- U4 implemented; if it revealed a real-time bug, the fix is included and tests green.
- U5 implemented and all listed regression tests green.
- `npm run test:client` passes for the touched test files.
- `npm run lint` clean.
- `CHANGELOG.md` updated for the user-facing behavior change.
- No dead-end or experimental code remains in the diff.
