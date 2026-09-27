---
date: 2026-06-26
topic: bot-resume-session
---

# Bot `/resume` 会话切换命令（WeCom + Feishu）

## Summary

为两个 bot 统一会话切换命令 `/resume`。WeCom 新增该命令，回复一张单选模版卡片列出用户会话（标题 + 最近活动时间，取最近 N 个），用户提交后把所选会话设为当前活动会话并回复确认；卡片始终展示、仅用于切换、不含新建会话。飞书将既有的 `/session` 硬重命名为 `/resume`（`/session` 形式不再识别），其卡片与切换逻辑不变。

---

## Problem Frame

WeCom 自 `/clear`/`/new` 上线后，用户可开多个会话；但一旦 `/new` 新建，旧会话就只能留在 GUI 历史查看器里、无法从 bot 侧继续——会话上下文被「搁浅」。`/clear`/`/new` 的需求文档当时已把「列出并切回旧会话的命令」明确列为 Deferred，并指出「显式当前会话标记为此打下基础」。如今该标记（`wecom_user_sessions.isActive`）与按用户列出会话的能力（`listWecomSessionsByUser`）均已就位，基础具备。同时飞书早有等价的 `/session` 能力，但命令名与即将上线的 WeCom 不一致。本次把两边的切换命令统一为 `/resume`，让用户在两个 bot 上用同一个命令恢复旧会话。

---

## Key Decisions

- **复用现有卡片与回调机制，而非新建交互通路。** WeCom 已具备 `vote_interaction` 单选卡片、`template_card_event` 回调解析与所有权校验；`/resume` 卡片照此构建，新增一个会话列表卡片构建器与一个切换回调分支即可。
- **卡片仅用于切换（switch-only），不含「新建会话」。** 新建会话仍走 `/new`/`/clear`；卡片职责单一，避免与既有命令重叠。
- **始终展示卡片，即使会话不足两个。** 不做「不足 2 个就回文本」的特殊分支，保持回复形态一致；实际 0 个会话基本不可达（首条消息即自动建会话）。
- **取最近 N 个，不做分页。** 列表按最近活动倒序、截断到平台选项上限；更早的会话不进卡片，仍可在 GUI 历史查看。
- **跨 bot 统一为 `/resume`，飞书硬重命名。** 飞书既有 `/session` 直接改为 `/resume`、不再保留 `/session`，使两个 bot 命令一致；代价是现有飞书用户的 `/session` 习惯需迁移。
- **切换 = 翻转每用户当前会话标记。** 复用 `setActiveWecomSession`（WeCom）/ `setFeishuActiveSession`（飞书）的既有事务逻辑，激活新会话时令旧活动会话退居非活动；既有会话一律保留。

---

## Requirements

**命令解析与分发**

- R1. 当入站文本消息的起始 token 是 `/resume` 时，WeCom 与飞书 bot 都必须将其识别为命令，并在消息转发给 Claude 会话之前拦截（字面 `/resume` 不得作为一轮对话处理）。
- R2. `/resume` 不接受参数；命令后的任何附加文本被忽略（switch-only，不支持 `/resume <名称|序号>` 直接切换）。

**卡片展示**

- R3. `/resume` 必须回复一张单选模版卡片，列出该用户在所属 workspace 内、来源为该 bot 的会话。
- R4. 卡片始终展示，即使该用户会话不足两个；不得为不足两个的情况回退到纯文本。
- R5. 每个会话选项展示「会话标题 + 最近活动时间」。
- R6. 列表按最近活动倒序排列，并截断到平台单选卡片的选项数上限（最近 N 个）；超过上限的会话不出现在卡片中。
- R7. 用户当前的活动会话也必须出现在卡片中并标注为「当前」；再次选中它等同于确认、不产生切换。
- R8. 已归档（`isArchived`）的会话不得出现在卡片中。

**切换与回调**

- R9. 用户在卡片中提交一个会话后，bot 必须在通过所有权校验（提交者即该会话归属用户）后，把所选会话设为该用户的当前活动会话，令此前活动会话退居非活动；既有会话不得删除。
- R10. 切换只翻转当前会话标记，对用户的下一条消息生效；不强行中断正在处理的轮次。
- R11. 切换成功后，bot 必须回复一条包含所切会话标题的确认消息（文案对齐 `/new` 的确认风格，以 i18n key 形式同时登记到 `en` 与 `zh-CN`）。
- R12. 若用户在卡片过期或被取代后才提交，bot 必须按既有 pending-card 生命周期处理（如「该请求已过期或已处理」），不产生切换。

**跨 bot 一致性**

- R13. 飞书 bot 的既有 `/session` 命令必须硬重命名为 `/resume`；`/session` 形式不再被识别。
- R14. 飞书的会话列表卡片与切换逻辑保持不变（仅命令文本变更）。

---

## Key Flows

- F1. **正常切换**
  - **Trigger:** WeCom 用户发送 `/resume`。
  - **Steps:** bot 拦截命令；列出该用户最近 N 个会话的单选卡片（标题 + 最近活动时间，当前会话标注「当前」）；用户提交其一；通过所有权校验；翻转当前会话标记（旧活动会话退居非活动）；回复带标题的确认消息。
  - **Outcome:** 所选会话成为当前活动会话；用户下一条消息进入该会话。
  - **Covered by:** R1, R3, R5, R6, R7, R9, R11.

- F2. **切回当前会话（无操作）**
  - **Trigger:** 用户在卡片中提交标注「当前」的会话。
  - **Steps:** 所有权校验通过；当前会话标记不变；仍回复确认。
  - **Outcome:** 无实质切换；用户留在原会话。
  - **Covered by:** R7, R9, R11.

- F3. **会话不足两个仍展示卡片**
  - **Trigger:** 用户仅有 1 个会话时发送 `/resume`。
  - **Steps:** bot 仍回复一张只含该会话（标注「当前」）的卡片。
  - **Outcome:** 回复形态一致，不回退纯文本。
  - **Covered by:** R3, R4, R7.

- F4. **超量截断**
  - **Trigger:** 用户会话数超过平台上限 N 时发送 `/resume`。
  - **Steps:** 卡片只列最近 N 个；更早会话不出现。
  - **Outcome:** 列表受控；更早会话仍可在 GUI 历史查看。
  - **Covered by:** R6.

- F5. **过期提交**
  - **Trigger:** 用户在卡片过期或被另一条 `/resume` 取代后才提交。
  - **Steps:** bot 按既有 pending-card 生命周期判定请求已失效。
  - **Outcome:** 回复「该请求已过期或已处理」，不发生切换。
  - **Covered by:** R12.

- F6. **飞书重命名**
  - **Trigger:** 飞书用户发送 `/resume`（或 `/session`）。
  - **Steps:** `/resume` 走既有会话列表卡片与切换逻辑；`/session` 不再被识别为命令。
  - **Outcome:** 飞书与 WeCom 命令一致；`/session` 失效。
  - **Covered by:** R13, R14.

---

## Acceptance Examples

- AE1. **Covers R1, R3, R5, R6, R7, R9, R11.** 已知 WeCom 用户有会话 S1（当前）、S2、S3，当其发送 `/resume`，则卡片列出三者（S1 标注「当前」，按最近活动倒序）；用户提交 S2 后，S2 成为当前活动会话（S1 退居非活动但保留），bot 回复「已切换到会话：【<S2 标题>】，可继续对话」，其下一条消息进入 S2。
- AE2. **Covers R3, R4, R7.** 已知该用户只有 1 个会话 S1，当其发送 `/resume`，则仍回复一张只含 S1（标注「当前」）的卡片，而非纯文本。
- AE3. **Covers R6.** 已知该用户有 12 个会话且平台上限为 N，当其发送 `/resume`，则卡片只列最近 N 个，第 N+1 及更早的会话不在卡片中。
- AE4. **Covers R1.** 已知用户发送 `/resume`，则字面文本 `/resume` 不会被作为用户消息转发给 Claude 会话。
- AE5. **Covers R8.** 已知某会话已归档，则它不出现在 `/resume` 卡片中。
- AE6. **Covers R12.** 已知用户在卡片过期后才提交，则 bot 回复「该请求已过期或已处理」且不发生切换。
- AE7. **Covers R13, R14.** 已知飞书用户发送 `/resume`，则得到与原 `/session` 一致的会话列表卡片与切换行为；发送 `/session` 则不再被识别为命令。

---

## Success Criteria

- 两个 bot 都用 `/resume` 恢复旧会话，命令名一致；飞书 `/session` 不再有效。
- 切换后用户的下一条消息进入所选会话，且所选会话带着原有上下文继续。
- 旧会话永不丢失——切换后仍留在 GUI 会话历史查看器中。
- 卡片始终展示，交互形态一致，不因会话数量变化而在卡片与纯文本间切换。

---

## Scope Boundaries

### Deferred for later

- 分页 / 加载更多（从 bot 侧恢复超出最近 N 的会话）。
- `/resume <名称|序号>` 直接切换（不经过卡片）。
- 卡片内「新建会话」入口（switch-only）。

### Outside this change

- 对 GUI 会话界面的改动。
- 新增 `maxSessionsPerUser` 限制。
- 切换时删除或归档会话（既有会话一律保留）。
- 改动飞书会话列表卡片本身或其切换逻辑（仅命令文本重命名）。

---

## Dependencies / Assumptions

- WeCom 已具备模版卡片 + 提交回调机制：`vote_interaction` 单选卡片构建器、`event.template_card_event` 订阅与 `handleTemplateCardEvent` 路由（含所有权校验），见 `src/server/services/wecom-template-card.ts` 与 `src/server/services/wecom-bot-service.ts`；当前仅处理审批/提问、无切换分支——本次新增。
- 每用户当前会话标记已存在：`getActiveWecomSession`（自愈）、`setActiveWecomSession`（事务内单活动不变量），见 `src/server/storage/sqlite-store.ts`；目前仅在新会话创建时被调用，本次新增切换路径直接调用它。
- `listWecomSessionsByUser` 仅返回 `{sessionId, createdAt}`、按 `createdAt` 升序，见 `src/server/storage/sqlite-store.ts`；构建「标题 + 最近活动时间」的卡片选项需另联查会话表并改倒序、截断。
- pending-card 生命周期（`src/server/services/session-runtime.ts` 的 pending 状态 + 可选 timeout）已用于审批/提问卡片；`/resume` 卡片假设注册同型 pending 条目以获得过期/取代语义。
- 飞书 `/session` 命令、`buildSessionListCard`、`select_session` 回调、`setFeishuActiveSession` 均已存在，见 `src/server/services/feishu-bot-service.ts`、`src/server/services/feishu-card-builder.ts`、`src/server/services/feishu-card-action-handler.ts`；本次仅改命令文本。
- 0 个会话基本不可达：bot 在用户首条消息时即自动创建会话；卡片对该情形作优雅退化（无可选项）。
- 无 `maxSessionsPerUser` 限制：`WeComBotIsolationSettings` 仅含 admin/skills，见 `src/server/models/workspace.ts`。

---

## Outstanding Questions

### Resolve before planning

- （无——产品决策已全部敲定。）

### Deferred to planning

- 平台单选卡片的选项数上限与单条文本长度上限的确切值（决定 N 与标题/时间如何截断）。
- `vote_interaction` 提交回调如何把「所选会话」传回：选项 `id` 是否编码目标 sessionId（现有 button-key 的 action 仅 `allow`/`always_allow`/`deny`，需扩展或另设键方案）。
- 中途切换（当前会话正处理一轮时收到 `/resume`，或切到一个正忙的会话）的确切行为：排队、拒绝，还是放行（默认仅翻标记、下一条消息生效）。
- 确认文案与 i18n key 的最终措辞（含标题占位符）在 `en` 与 `zh-CN`。
- 飞书命令菜单 / 帮助列表中凡引用 `/session` 之处需同步改为 `/resume`（确认这些引用位置）。
- 卡片过期 timeout 时长是否沿用审批/提问卡片既有默认。

---

## Sources / Research

- WeCom `/clear`/`/new` 解析与处理：`src/server/services/wecom-bot-service.ts`（`parseWecomNewSessionCommand`、`handleNewSessionCommand`）。
- WeCom 当前会话标记读写：`src/server/storage/sqlite-store.ts`（`getActiveWecomSession`、`setActiveWecomSession`、`listWecomSessionsByUser`、`wecom_user_sessions` DDL）。
- WeCom 模版卡片与回调：`src/server/services/wecom-template-card.ts`（`vote_interaction` 单选、`isValidAction`、`encodeButtonKey`/`decodeButtonKey`）；事件路由 `handleTemplateCardEvent`（`src/server/services/wecom-bot-service.ts`）。
- pending-card 过期生命周期：`src/server/services/session-runtime.ts`（pending 状态 + 可选 timeout）、`getPendingCardState`。
- 飞书 `/session` 参考（命令、`buildSessionListCard`、`select_session` 处理、`setFeishuActiveSession`）：`src/server/services/feishu-bot-service.ts`、`src/server/services/feishu-card-builder.ts`、`src/server/services/feishu-card-action-handler.ts`。
- 上游决策：本次所补的「列出并切回旧会话」即 `/clear`/`/new` 文档的 Deferred 项，见 `docs/brainstorms/2026-06-25-wecom-clear-new-session-requirements.md`；飞书 `/session` 先例与主动消息会话切换背景，见 `docs/brainstorms/2026-06-21-feishu-auto-create-session-requirements.md`、`docs/brainstorms/2026-06-09-wecom-proactive-message-session-switching-requirements.md`。
