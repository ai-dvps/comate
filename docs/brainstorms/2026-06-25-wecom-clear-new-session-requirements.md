---
date: 2026-06-25
topic: wecom-clear-new-session
---

# WeCom Bot `/clear` & `/new` Session Commands

## Summary

为 WeCom bot 增加两个等价的斜杠命令 `/clear` 和 `/new`（均可带可选标题）。任一命令都会创建一个新会话，通过**显式的 per-user 标记**把它设为该用户的当前会话（不再用时间戳推断），保留旧会话，并回复一条带新会话标题的确认消息。整体是把飞书 bot 已有的 `/new` 能力移植到 WeCom。

---

## Problem Frame

当前每个 WeCom 用户只有一个永不失效的持久会话——最初的 bot 集成为了简化状态管理，选择了「每用户一个会话、无限复用」。用户没有办法开启一段干净的对话，历史会无限累积，而 WeCom bot 路径根本没有斜杠命令分发机制。飞书 bot 已经上线了 `/new`。本次改动把同样的能力带到 WeCom，并用一个显式的「当前会话」标记取代「按创建时间取最新」的推断方式，使得一个用户拥有多个会话时，当前会话始终明确无歧义。

---

## Key Decisions

- **别名，而非分裂语义。** `/clear` 与 `/new` 行为完全一致——交互面更简单、只需维护一种行为；代价是没有专门的「丢弃当前会话」动作。
- **显式当前会话标记，而非时间戳推断。** 一旦用户拥有多个会话，「按 `createdAt` 倒序取最新」就过于脆弱；改用一个 per-user 的显式标记来标识当前会话。
- **标记以新列形式存放在 `wecom_user_sessions` 表上。** 按用户决定，采用在现有映射表上加列的方式，而非飞书那种独立的 active-sessions 表，使「用户↔会话」映射集中在一处。
- **不为已存在的会话做回填迁移。** 旧会话不会被打上当前标记；这些已有用户在改动上线后的下一条消息会开启一个全新会话，旧会话仍留在会话历史查看器中。这是为避免迁移而接受的代价。
- **默认标题沿用现有 WeCom 模式。** 未提供标题的新会话使用 bot 现有自动创建会话所用的默认标题（由 bot 渠道用户标识派生），与飞书 `/new` 的做法保持一致。
- **复用现有会话创建路径。** 新会话走所有 bot 路径共用的创建方式，不引入 WeCom 专用的创建器。

---

## Requirements

### 命令解析与分发

- R1. 当入站文本消息的起始 token 是 `/clear` 或 `/new` 时，WeCom bot 必须将其识别为命令；命令后可跟一个可选标题（第一个空格之后的全部文本）。
- R2. `/clear` 与 `/new` 行为完全等价（别名）。
- R3. 这两个命令必须在消息被转发给 Claude 会话作为用户内容之前被拦截（字面的 `/new ...` 不得作为一轮对话被处理）。

### 会话创建与当前会话跟踪

- R4. 每个命令必须在用户所属 workspace 中创建一个新会话（`source: wecom`），并将其设为该用户的当前活动会话，取代此前活动的会话。
- R5. 每个 WeCom 用户同一时刻只有一个活动会话；激活新会话必须使此前活动的会话退居非活动。当前会话由一个显式的 per-user 标记标识，不得通过创建时间推断。
- R6. 用户后续的普通（非命令）消息必须发往其当前活动会话。
- R7. 激活新会话时，既有会话必须被保留（不得删除），并在 bot 会话历史查看器中保持可见。
- R8. 改动上线后，对那些已存在会话但没有任何当前标记的已有用户，其下一条入站消息必须开启一个全新会话；既有会话不做回填。

### 标题处理

- R9. 当提供了标题（如 `/new 项目X`）时，新会话使用该标题。
- R10. 当未提供标题时，会话使用默认 WeCom 标题（即 bot 现有为自动创建会话派生的那个默认标题）。
- R11. 用户显式提供的标题优先级高于 WeCom 会话自动改名功能，自动改名不得覆盖用户设定的标题。

### 回复

- R12. 创建并激活成功后，bot 必须向用户回复一条包含新会话标题的确认消息（如「新的会话已创建：【<title>】，可继续对话」），文案以 i18n key 形式同时登记到 `en` 与 `zh-CN` 命名空间。

---

## Key Flows

- F1. **带标题创建新会话**
  - **Trigger:** 用户发送 `/new 项目X`（或 `/clear 项目X`）。
  - **Steps:** bot 识别起始命令；解析出标题；用该标题创建新 WeCom 会话；将其标记为该用户的当前会话（使此前活动会话退居非活动）；保留既有会话；回复带标题的确认消息。
  - **Outcome:** 一个带标题的新会话成为当前会话；用户下一条消息进入该会话。
  - **Covered by:** R1, R2, R3, R4, R5, R6, R7, R9, R12.

- F2. **不带标题创建新会话**
  - **Trigger:** 用户发送 `/new`（或 `/clear`），无标题。
  - **Steps:** 同 F1，但会话使用默认 WeCom 标题。
  - **Outcome:** 一个使用默认标题的新会话成为当前会话。
  - **Covered by:** R1, R4, R5, R10, R12.

- F3. **无当前标记的已有用户发送普通消息**
  - **Trigger:** 改动上线后，一个已存在会话但无任何当前标记的 WeCom 用户发送一条普通消息。
  - **Steps:** bot 发现该用户没有当前活动会话；创建一个全新会话并标记为当前；将消息作为该会话的第一轮处理。
  - **Outcome:** 用户开启一个新会话；旧会话仍留在会话历史查看器中。
  - **Covered by:** R6, R8.

---

## Acceptance Examples

- AE1. **Covers R1-R7, R9, R12.** 已知某 WeCom 用户的当前会话为 S1，当其发送 `/new 项目X`，则创建标题为「项目X」的新会话、被标记为当前（S1 退居非活动但被保留），bot 回复「新的会话已创建：【项目X】，可继续对话」，且其下一条消息进入新会话。
- AE2. **Covers R1, R2.** 已知同一用户，发送 `/clear 项目X` 的结果与 AE1 完全一致。
- AE3. **Covers R10, R12.** 已知用户发送不带标题的 `/new`，则新会话使用默认 WeCom 标题，且确认消息中显示该默认标题。
- AE4. **Covers R3.** 已知用户发送 `/new`，则字面文本 `/new` 不会被作为用户消息转发给 Claude 会话（不产生多余的一轮对话）。
- AE5. **Covers R5, R7, R8.** 已知一个已存在会话但其会话均无当前标记的用户，在改动上线后发送「你好」，则为其创建并标记一个全新会话，「你好」成为其第一轮，且其旧会话在会话历史查看器中仍可见。

---

## Success Criteria

- WeCom 用户可随时用 `/clear` 或 `/new` 开启新会话，其后的消息进入该新会话。
- 旧会话永不丢失——开启新会话后，它们仍留在 bot 会话历史查看器中。
- 当前会话始终是显式标记的那个，绝不靠时间戳推断，因此一个用户拥有多个会话时不会把消息投错会话。
- 已有用户无错误地过渡到新模式（下一条消息时自然开启新会话）。

---

## Scope Boundaries

### Deferred for later

- 从 WeCom 中列出并切回旧会话的 `/session` 命令——显式当前会话标记为此打下基础，但命令本身不在本次范围。

### Outside this change

- 对飞书 bot 行为的任何改动。
- 对 GUI 会话界面的改动。
- 在 `/clear`/`/new` 时删除或归档旧会话（旧会话一律保留）。
- WeCom「首条消息自动创建会话」的既有意图不变；只有「哪个会话是当前会话」的判定机制发生变化。

---

## Dependencies / Assumptions

- WeCom 目前以「按创建时间取最新」推断当前会话（`getWecomSession`，见 `src/server/storage/sqlite-store.ts`）；本次改动用显式标记取代该方式用于当前会话查找。
- `wecom_user_sessions` 表已支持单用户多会话（复合主键，且已有 `listWecomSessionsByUser` 与 `getWecomUserIdBySession`）；新增「当前会话」列是对其的扩展，无需重构。
- WeCom 会话自动改名功能（`<用户> session #序号`）作用于默认标题会话；本次改动假定它必须放过显式带标题的会话（R11），需对照自动改名实现确认。
- WeCom bot 目前无斜杠命令分发，入站文本被直接推入会话，因此命令拦截属于全新能力。
- 飞书 `/new` 命令是标题解析与确认行为的参考实现。

---

## Outstanding Questions

### Resolve before planning

- （无——产品决策已全部敲定。）

### Deferred to planning

- 列名及单活动不变量的强制方式（一个 `isActive`/`isCurrent` 布尔加约束、可空标记、还是单独的活动指针），以及每次激活新会话时使旧活动行退居非活动的更新逻辑。
- 具体的 i18n key 与最终确认文案（含标题占位符）在 `en` 与 `zh-CN` 中的最终措辞。
- 当用户当前会话正处于一轮处理中（runtime 忙）时发送 `/new`/`/clear` 的行为：排队、拒绝，还是放行。
- 确认自动改名路径在改名前会检查是否存在显式标题（R11）。
- 标题长度/校验边界（受 WeCom 消息长度限制）。

---

## Sources / Research

- WeCom 消息处理（当前无命令分发）：`src/server/services/wecom-bot-service.ts`（`handleTextMessage`、`getOrCreateSession`）。
- 当前会话按时间戳取最新：`src/server/storage/sqlite-store.ts:652`（`getWecomSession`）；保留旧行的多会话插入：`src/server/storage/sqlite-store.ts:659`（`setWecomSession`）；`listWecomSessionsByUser`：`src/server/storage/sqlite-store.ts:676`。
- 飞书 `/new` 参考（标题解析、激活、确认）：`src/server/services/feishu-bot-service.ts`（`handleNewSessionCommand`、`instantiateFeishuSession`）；飞书活动会话指针（WeCom 现以列形式采纳的同型模式）：`setFeishuActiveSession`/`getFeishuActiveSession`。
- 本次改动所放松的 WeCom「每用户一个持久会话」基础决策：`docs/brainstorms/2026-05-21-wecom-bot-integration-requirements.md`。
- 飞书 `/new` 需求先例：`docs/brainstorms/2026-06-21-feishu-auto-create-session-requirements.md`。
- WeCom 会话自动改名（R11 须遵守的标题格式规则）：`docs/brainstorms/2026-06-10-wecom-session-auto-rename-requirements.md`。
