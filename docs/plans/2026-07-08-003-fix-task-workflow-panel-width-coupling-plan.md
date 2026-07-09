---
title: 解耦 TaskPanel 与 WorkflowFloatingPanel 宽度 - Plan
type: fix
date: 2026-07-08
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

## Goal Capsule

- **Objective:** 修复 ChatPanel 右上角浮动区域中 TaskPanel 展开时 WorkflowFloatingPanel 宽度被同步撑大的问题，使两面板宽度独立、仅由自身内容决定。
- **Authority hierarchy:** 仅修改前端 React + Tailwind 布局；不改动业务逻辑、状态管理、后端或桌面壳。
- **Stop conditions:** 当 TaskPanel 展开/收起时，WorkflowFloatingPanel 的渲染宽度不再随之变化；现有单元测试与 lint 通过。
- **Execution profile:** 轻量级单提交修复，优先使用现有 Tailwind 工具类，不引入新依赖。
- **Tail ownership:** 实现后由开发者进行肉眼 UI  smoke 验证。

---

## Product Contract

### Summary

当 TaskPanel 与 WorkflowFloatingPanel 同时出现在聊天区域右上角时，TaskPanel 的展开操作不应把 WorkflowFloatingPanel 的宽度一起拉大。本计划通过调整外层浮动容器的对齐方式、取消子面板的全宽占满，使两面板宽度解耦。

### Problem Frame

当前 `ChatPanel.tsx` 将两个面板放在同一个绝对定位的 flex 列容器中，容器设置了 `max-w-xs`，两个面板自身又都使用 `w-full`。结果是 flex 列的交叉轴默认 stretch，TaskPanel 展开后容器被撑到接近 `max-w-xs`，WorkflowFloatingPanel 也被迫占满同一宽度，出现“同步变宽”的视觉效果。用户期望 WorkflowFloatingPanel 保持自身内容宽度，不被 TaskPanel 的展开状态影响。

### Requirements

- R1. TaskPanel 展开后仍保留 `max-w-xs` 的上限，且可以继续正常显示长任务文本。
- R2. WorkflowFloatingPanel 的宽度由自身内容决定，不再随 TaskPanel 展开而强制变宽。
- R3. 两个面板继续保持在右上角叠加浮动，并保持现有的 pointer-events 行为（容器 `pointer-events-none`、面板 `pointer-events-auto`）。
- R4. 不引入新的依赖或自定义 CSS；仅使用项目已有 Tailwind 工具类。

### Scope Boundaries

- **In scope:** `ChatPanel.tsx` 中浮动容器布局、`TaskPanel.tsx` 与 `WorkflowFloatingPanel.tsx` 根元素宽度类；相关 co-located 单元测试。
- **Out of scope：** 面板内部业务逻辑、拖拽调整大小、面板排序、深色模式/主题色值、Tauri 壳、后端 API。
- **Deferred to follow-up work：** 若解耦后发现 WorkflowFloatingPanel 在某些超长 workflow 名称下需要更严格的宽度策略，可单独评估是否为其增加 `min-w-*` 或固定 `w-*`；本次不处理。

---

## Planning Contract

### Key Technical Decisions

- KTD1. 外层容器改为 `items-end` 的 flex 列。
  - Rationale: flex 列默认 `align-items: stretch` 会导致所有子元素被拉到最宽子元素的宽度。`items-end` 关闭交叉轴拉伸，同时让两个面板右对齐，符合 `top-4 right-4` 的绝对定位语义。
- KTD2. 移除外层容器上的 `max-w-xs`。
  - Rationale: 宽度上限应该由每个面板自己负责，而不是由共享容器统一限制；否则容器宽度仍由最宽子元素决定，WorkflowFloatingPanel 会通过 `w-full` 被动继承。
- KTD3. TaskPanel 与 WorkflowFloatingPanel 根元素取消 `w-full`，并各自保留/增加 `max-w-xs`。
  - Rationale: 取消 `w-full` 后每个面板宽度回归内容决定；保留 `max-w-xs` 可防止任务名或 workflow 名过长时溢出屏幕，同时维持现有的 `truncate` 行为。

### Assumptions

- 项目 Tailwind 默认主题已包含 `max-w-xs`、`items-end` 等工具类（标准 Tailwind v3 默认配置，本项目未覆盖）。
- 现有 `WorkflowFloatingPanel` 内部已使用 `truncate`/`min-w-0` 处理长文本，只要根元素有 `max-w-xs` 即可继续生效。

### Sequencing

1. 修改 `ChatPanel.tsx` 浮动容器。
2. 同步调整 `TaskPanel.tsx` 与 `WorkflowFloatingPanel.tsx` 根元素宽度类。
3. 更新/新增单元测试断言上述类名变化。
4. 运行测试与 lint，最后进行 UI smoke 验证。

---

## Implementation Units

### U1. 解耦右上角浮动容器宽度

- **Goal:** 让 TaskPanel 与 WorkflowFloatingPanel 不再共享同一个被撑大的宽度。
- **Requirements:** R2, R3.
- **Dependencies:** 无。
- **Files:**
  - `src/client/components/ChatPanel.tsx`
  - `src/client/components/ChatPanel.test.tsx`
- **Approach:**
  - 将浮动容器类名从 `absolute top-4 right-4 z-20 flex max-w-xs flex-col gap-2 pointer-events-none` 改为 `absolute top-4 right-4 z-20 flex flex-col items-end gap-2 pointer-events-none`。
  - 移除容器上的 `max-w-xs`，让宽度上限下放到各个面板。
- **Patterns to follow:** 使用现有 `cn()` 工具与 Tailwind 类；保持 `pointer-events-none` 在容器、`pointer-events-auto` 在子面板。
- **Test scenarios:**
  - Happy path: `ChatPanel.test.tsx` 中断言浮动 wrapper 仍包含 `absolute top-4 right-4 z-20 flex flex-col gap-2 pointer-events-none`，并新增断言包含 `items-end`、不包含 `max-w-xs`。
  - Edge case: 当 `tasks` 与 `workflows` 同时存在时，wrapper 只渲染一个 DOM 节点，两个子面板都在其中。
- **Verification:** `npm run test:client src/client/components/ChatPanel.test.tsx` 通过；`npm run lint` 无报错。

### U2. 让 TaskPanel 宽度由自身内容决定

- **Goal:** TaskPanel 展开时只自己占宽，不再通过共享容器强制 WorkflowFloatingPanel 同步变宽。
- **Requirements:** R1, R4.
- **Dependencies:** U1.
- **Files:**
  - `src/client/components/TaskPanel.tsx`
  - `src/client/components/TaskPanel.test.tsx`
- **Approach:**
  - 将根元素类名从 `... w-full max-w-xs` 改为 `... max-w-xs`（保留 `max-w-xs`，移除 `w-full`）。
  - 内部按钮仍使用 `w-full`，仅针对最外层容器解耦。
- **Patterns to follow:** 继续使用 `cn()` 组合类名；保留现有的折叠/展开、Escape 关闭等行为。
- **Test scenarios:**
  - Happy path: 渲染 TaskPanel 后，其根元素 className 包含 `max-w-xs` 且不包含 `w-full`。
  - Edge case: 展开后长任务文本仍正常换行显示（现有 `whitespace-normal break-words` 不变）。
  - Regression: 无任务时组件仍返回 `null`；点击标题仍展开/收起。
- **Verification:** `npm run test:client src/client/components/TaskPanel.test.tsx` 通过；展开/收起交互测试仍通过。

### U3. 让 WorkflowFloatingPanel 宽度由自身内容决定

- **Goal:** WorkflowFloatingPanel 不再因为 TaskPanel 展开而被动变宽。
- **Requirements:** R2, R4.
- **Dependencies:** U1.
- **Files:**
  - `src/client/components/WorkflowFloatingPanel.tsx`
  - `src/client/components/WorkflowFloatingPanel.test.tsx`
- **Approach:**
  - 将根元素类名从 `... w-full` 改为 `... max-w-xs`（即移除 `w-full`，并增加 `max-w-xs` 作为内容上限，保持内部 `truncate` 有效）。
  - 内部 workflow item 按钮仍使用 `w-full`。
- **Patterns to follow:** 保持 `pointer-events-auto rounded-lg border border-border bg-surface p-3 shadow-lg` 等既有样式；`max-w-xs` 与 TaskPanel 一致。
- **Test scenarios:**
  - Happy path: 渲染 WorkflowFloatingPanel 后，根元素 className 不包含 `w-full`、包含 `max-w-xs`，且仍包含 `pointer-events-auto rounded-lg`。
  - Edge case: 当 workflow 名称较长时，内部 `truncate` 仍生效，不撑破面板。
  - Regression: 无 workflow 时组件仍返回 `null`；点击 workflow item 仍调用 `onOpenWorkflow`。
- **Verification:** `npm run test:client src/client/components/WorkflowFloatingPanel.test.tsx` 通过。

### U4. 运行质量门与 UI smoke 验证

- **Goal:** 确保改动不破坏现有行为，并在真实界面中确认宽度解耦。
- **Requirements:** R3.
- **Dependencies:** U1, U2, U3.
- **Files:**
  - `CHANGELOG.md`
- **Approach:**
  - 运行客户端全量测试与 lint。
  - 启动 `npm run dev:client`（或 `npm run tauri:dev`）进入聊天界面，构造同时存在 tasks 与 workflows 的会话，展开 TaskPanel，观察 WorkflowFloatingPanel 宽度是否保持不变。
  - 在 `CHANGELOG.md` 的 Unreleased 区域新增一条用户可见的修复说明。
- **Test expectation: none -- this unit is pure verification/configuration.**
- **Verification:** `npm run test:client` 与 `npm run lint` 全部通过；smoke 验证完成。

---

## Verification Contract

| Gate | Command / Check | When to run | Expected outcome |
|---|---|---|---|
| Unit tests | `npm run test:client src/client/components/{ChatPanel,TaskPanel,WorkflowFloatingPanel}.test.tsx` | 每次代码改动后 | 全部通过 |
| Full client tests | `npm run test:client` | U4 最终验证 | 全部通过 |
| Lint | `npm run lint` | U4 最终验证 | 无错误、无新增警告 |
| UI smoke | `npm run dev:client` 或 `npm run tauri:dev` | U4 最终验证 | 展开 TaskPanel 时 WorkflowFloatingPanel 宽度不变 |

---

## Definition of Done

- [ ] `ChatPanel.tsx` 浮动容器已移除 `max-w-xs` 并新增 `items-end`。
- [ ] `TaskPanel.tsx` 根元素已移除 `w-full` 并保留 `max-w-xs`。
- [ ] `WorkflowFloatingPanel.tsx` 根元素已移除 `w-full` 并新增 `max-w-xs`。
- [ ] 相关单元测试已更新并通过。
- [ ] `npm run lint` 通过。
- [ ] UI smoke 验证通过：TaskPanel 展开/收起时 WorkflowFloatingPanel 宽度不随之变化。
- [ ] `CHANGELOG.md` 已记录本次用户可见修复。
