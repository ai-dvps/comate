---
date: 2026-06-28
topic: bot-workspace-decoupling
---

# Bot 配置与 Workspace 解耦

## Summary

把企微/飞书 bot 提升为独立于 workspace 的一等实体。一个 bot 可以同时连接企微和飞书，按 provider 维护成员身份并共享三角色（所有者/管理员/普通用户），同时持有当前激活的 workspace；workspace 仅保留敏感文件拒绝列表。bot 所有者既能在 Comate GUI 管理 bot 与成员，也能在企微/飞书中切换当前 workspace；切换后新会话进入新 workspace，历史会话留在原 workspace。现有 workspace 的 bot 配置会自动迁移为独立 bot，默认已有 bot 用户为所有者。

---

## Problem Frame

当前 bot 配置嵌入在每个 workspace 的 `settings` 中（`wecomBotId`/`wecomBotSecret`、`feishuAppId`/`feishuAppSecret` 等），bot 与 workspace 是 1:1 或全局单活绑定。当团队希望同一个 bot 服务于多个项目 workspace，或者测试/生产环境需要快速切换时，只能在不同 workspace 里重复配置同一套 bot 凭证，管理成本高。若再引入 RBAC，成员角色也会跟着 workspace 走，换 workspace 就要重新授权。

解耦后，bot 的配置、成员角色、provider 连接与 workspace 分离；切换 workspace 只需改一个绑定关系，成员权限保持不变。

---

## Actors

- A1. **Bot 所有者（Owner）** — 每个 bot 有且只有一个 Owner，即 workspace 原生所有者（本机/Comate 操作员）。可管理 bot 配置、provider 连接、成员角色，可切换当前激活的 workspace，在激活的 workspace 内拥有完整文件/工具/Skill 权限（不受 bot 角色策略限制）。
- A2. **Bot 管理员（Admin）** — 由所有者分配；可在激活的 workspace 内读写所有文件（包括其他用户的 `data/<user>` 目录），使用所有工具/Skill。
- A3. **Bot 普通用户（Normal）** — 新加入 bot 的默认角色；可读取 workspace 共享文件，但只能在 `data/<providerUserId>` 目录下读写自己的文件，不能读取其他用户的私有目录。
- A4. **聊天应用用户** — 通过企微或飞书与 bot 对话的外部用户，对应 bot 成员列表里的某条 provider 身份。
- A5. **Comate 操作员** — 在桌面应用里管理 bot、查看连接状态和会话的人。
- A6. **系统/迁移服务** — 在应用自动升级时执行 bot 配置迁移，无需人工操作员实时参与。

---

## Key Decisions

- **Bot 是一等实体，不再内嵌在 workspace settings 中。** 连接信息、成员角色、当前 workspace 都归 bot 持有。
- **一个 bot 同时支持企微和飞书连接。** 两个 provider 共享同一套角色定义和同一个当前 workspace，管理员在任何一端切换都会同步生效。
- **成员身份按 provider 隔离，角色按 bot 共享。** 例如 `wecom:U123` 和 `feishu:ou_456` 分别属于各自 provider 的列表，但都映射到 bot 的 Owner/Admin/Normal 角色。
- **角色绑定在 bot 上，不跟随 workspace。** 切换 workspace 时，成员的权限集合保持不变。
- **Workspace 只保留敏感文件拒绝列表。** 工具权限、文件访问范围、Bash 白名单、Skill 策略等全部上移到 bot 角色。
- **单活 workspace。** 一个 bot 同一时刻只绑定一个 workspace；新消息路由到该 workspace，旧会话仍归属原 workspace。
- **自动迁移，旧用户默认 Owner。** 升级时从现有 workspace 的 bot 配置生成独立 bot 实体，已有 bot 用户默认成为所有者，避免权限回退。
- **v1 只在 GUI 维护成员角色。** 在企微/飞书中维护成员角色推迟到后续阶段。

---

## Requirements

### Bot 实体与 workspace 绑定

- R1. Bot 作为独立实体创建，包含名称、provider 连接设置和当前激活 workspace 引用。
- R2. 一个 workspace 同一时刻最多被一个 bot 激活绑定。
- R3. 一个 bot 同一时刻只激活一个 workspace（单活）。
- R4. 切换激活 workspace 必须由 Bot 所有者执行。
- R5. GUI 中可查看每个 bot 的 provider 连接状态（已连接/未连接/错误）和当前激活 workspace。

### Provider 连接

- R6. Bot 可配置企微连接信息（bot ID、bot secret 等）。
- R7. Bot 可配置飞书连接信息（app ID、app secret、encrypt key、verification token 等）。
- R8. 启用某 provider 时建立对应连接；禁用时断开连接。
- R9. 两个 provider 可以独立启用/禁用，互不影响；每个 bot 的 provider 连接相互隔离：飞书侧每个 bot 拥有独立的 `lark.Client`、`Chat` 实例与事件通道，系统按入站事件中的 `app_id` 将消息路由到对应 bot；企微侧每个 bot 拥有独立的连接与消息路由上下文。多个 bot 的同名 provider 可同时在线。

### 成员与角色

- R10. Bot 按 provider 维护成员列表，将 provider 用户 ID 映射到角色。
- R11. Bot 角色为 Owner、Admin、Normal，分别对应不同的文件/工具/Bash/Skill 权限。
- R12. 新加入的 bot 成员默认角色为 Normal。
- R13. v1 中仅 Bot Owner 可在 GUI 中分配或修改成员角色。
- R14. 角色变更对 bot 的所有会话/运行时生效；当前正在执行中的工具调用/文件操作按新策略处理。

### 基于角色的权限

- R15. Owner 可管理 bot 配置、成员和当前 workspace；在激活 workspace 内拥有完整文件、工具、Skill 权限（不受 bot 角色策略限制）。
- R16. Admin 可在激活 workspace 内读写所有文件（包括其他用户的 `data/<providerUserId>` 目录），并可使用所有工具/Skill。
- R17. Normal 用户可读取 workspace 共享文件，但只能在自己的 `data/<providerUserId>` 目录下创建或修改文件；不能读取其他用户的 `data/<other>` 目录。`data/<providerUserId>` 按 workspace 隔离，切换 workspace 后在新 workspace 下重新创建。
- R18. Normal 用户访问 workspace 文件时，必须受 workspace 敏感文件拒绝列表约束；命中拒绝列表或越界读取 `data/<other>` 的路径一律禁止，并返回统一错误消息“权限不足：无法访问该路径”。系统不区分“路径不存在”与“无权限”，避免信息泄露；所有拒绝访问必须记录审计日志。Owner/Admin 不受此列表限制。

### Workspace 切换

- R19. Bot Owner 可在 GUI 中查看当前激活 workspace 并切换到其他 workspace。
- R20. Bot Owner 可在企微/飞书聊天中通过发送 `/workspace` 命令或点击卡片切换当前激活 workspace；飞书复用现有 `/workspace` 命令，企微新增 `/workspace` 命令。命令返回可交互 workspace 列表卡片，选择后执行切换。
- R21. 切换 workspace 只更新激活 workspace 引用；已建立的 bot 会话不会被迁移。切换完成后，系统应向聊天应用中的活跃会话发送切换通知（含新 workspace 名称），并明确正在执行中的工具调用/文件生成任务的处理策略。
- R22. 切换后，新的入站消息在激活 workspace 中创建或复用会话。

### 会话与路由

- R23. 入站消息统一按 bot 的当前激活 workspace 路由；企微事件由 bot 级连接接收后，根据 bot 当前激活 workspace 解析目标 workspace，飞书事件按 `app_id` 路由到对应 bot 后再按激活 workspace 处理。
- R24. 每个 provider 用户的会话按 workspace 隔离；会话始终归属创建时所在的 workspace。
- R25. GUI 会话列表对 bot 创建的会话显示来源标识（企微/飞书）。

### 迁移与兼容

- R26. 升级时自动将每个 workspace 中的 bot 配置迁移为独立的 bot 实体；不同 workspace 之间不合并凭证相同的配置，避免跨 workspace 的权限扩散。
- R27. 迁移保留各 provider 的凭证和启用状态；将原 workspace 的 Skill 允许列表（`defaultAllowedSkills`、`adminAllowedSkills`）、Bash 白名单、`wecomToolPermissions` 等按保守策略映射为 bot 级角色策略（Admin 继承原管理员列表对应的权限，Normal 继承默认权限）。
- R28. 迁移后，workspace 原生所有者（Comate 操作员）成为对应 bot 的 Owner；原 workspace 的 `feishuAdminUserIds` / `wecomBotIsolation.adminUserIds` 中的用户成为 Admin；其他已有 bot 用户默认成为 Normal。
- R29. 迁移后，workspace 不再存储 bot 凭证、工具权限、文件访问范围、Bash 白名单、Skill 策略或管理员名单；仅保留 workspace 自身配置（如 `promptHistoryRetentionDays`、`wecomFilePromptTemplate`）和敏感文件拒绝列表（由原先硬编码规则变为可配置）。所有 bot 相关配置上移到 bot 实体。

### GUI

- R30. GUI 在 Settings 中新增“Bot Management”子项，进入 bot 管理页面；页面列出所有 bot、provider 状态、当前 workspace 和成员。
- R31. Workspace 设置页面只展示已绑定的 bot 和敏感文件拒绝列表编辑入口；不再展示 bot 凭证或工具权限配置。
- R32. Bot 删除前需二次确认并展示影响范围（将断开 provider 连接、已有会话保留在 workspace 中但无法通过该 bot 继续访问）；删除后 bot 与 workspace 的绑定自动解除，历史会话保留且 source 标记不变。
- R33. Bot 创建/编辑表单在保存时验证 provider 凭证；凭证错误时显示字段级错误信息；选择已被其他 bot 激活绑定的 workspace 时禁止选择并提示“该 workspace 已被其他 bot 激活绑定，请先解绑”。
- R34. Bot 管理页面的成员管理需覆盖以下状态：空列表提示、Owner 手动添加成员（输入 provider 用户 ID 并选择角色）、移除成员二次确认、修改角色后即时刷新；Normal/Admin 用户看不到成员管理操作入口。
- R35. 迁移在应用启动时自动检测并执行；迁移必须支持 dry-run，允许用户在执行前预览迁移结果；GUI 展示迁移状态；迁移期间 bot 服务暂停；失败时自动回退到旧配置，保证 bot 可继续使用；完成后提示用户。
- R36. Bot 角色策略包含 Skill 允许列表与 Bash 白名单：Owner 可配置这两项策略且自身不受限制；Admin 可使用所有 Skill 且 Bash 不受白名单限制；Normal 只能使用 Skill 允许列表中的 Skill，且 Bash 只能执行白名单中的命令。
- R37. Bot 的 provider 凭证（企微 bot secret、飞书 app secret/encrypt key 等）必须静态加密存储，且不得以明文形式写入日志或诊断信息。
- R38. v1 必须记录以下安全事件的审计日志：bot provider 凭证变更、workspace 绑定切换、角色分配变更、provider 启用/禁用，以及文件访问拒绝。审计日志可先仅写入服务端日志/数据库，查看 UI 可推迟。

---

## Key Flows

- F1. **Owner 创建 bot 并绑定 workspace**
  - **Trigger:** Owner 在 bot 管理页面点击新建 bot，填写名称和 provider 凭证，选择激活 workspace。
  - **Actors:** A1
  - **Steps:** 系统创建 bot 实体；启用指定 provider 连接；建立 bot 与 workspace 的绑定；入站消息开始路由到该 workspace。
  - **Outcome:** Bot 处于在线状态，新消息进入绑定的 workspace。
  - **Covered by:** R1, R2, R5, R6, R7, R8, R9, R23, R30

- F2. **Owner 在 GUI 切换 workspace**
  - **Trigger:** Owner 在 bot 管理页面选择另一个 workspace 并确认切换。
  - **Actors:** A1
  - **Steps:** 系统更新 bot 的激活 workspace；向当前活跃会话发送切换通知（含新 workspace 名称）；后续入站消息路由到新 workspace；旧会话保留在原 workspace。
  - **Outcome:** Bot 上下文切换到新 workspace，历史会话不变。
  - **Covered by:** R3, R4, R19, R21, R22, R23

- F3. **Owner 在聊天应用中切换 workspace**
  - **Trigger:** Owner 在企微或飞书聊天中发送切换 workspace 命令或点击卡片。
  - **Actors:** A1, A4
  - **Steps:** 所有者发送 `/workspace` 命令（飞书复用现有命令，企微新增）或点击历史卡片；系统校验发送者是否为 Bot Owner；返回可交互 workspace 列表卡片；所有者选择目标 workspace 后更新 bot 激活 workspace；返回切换成功提示（含新 workspace 名称，并说明后续消息将进入新 workspace）。
  - **Outcome:** 两端用户收到切换通知，后续消息都进入新 workspace。
  - **Covered by:** R3, R4, R10, R13, R20, R21, R22

- F4. **Normal 用户在 workspace 切换后发送消息**
  - **Trigger:** 某 Normal 用户在 bot 切换 workspace 后再次发消息。
  - **Actors:** A3, A4
  - **Steps:** 系统按当前激活 workspace 查找/创建该用户的会话；使用 Normal 角色策略处理消息和工具调用。
  - **Outcome:** 新会话归属新 workspace，权限按 bot 角色执行。
  - **Covered by:** R12, R14, R17, R18, R22, R23, R24

- F5. **系统自动迁移旧配置**
  - **Trigger:** 应用升级到包含独立 bot 实体的版本。
  - **Actors:** A5（操作员启动升级时）, A6（自动升级时）
  - **Steps:** 扫描所有 workspace 的 bot 配置；为每个 workspace 创建独立的 bot 实体；将 workspace 绑定到对应 bot；将 workspace 原生所有者设为 Owner，其他已有 bot 用户设为 Admin；把敏感路径列表保留在 workspace 上。
  - **Outcome:** 旧 bot 继续工作，配置结构已迁移。
  - **Covered by:** R26–R29

---

## Acceptance Examples

- AE1. **Covers R1, R2, R6, R8.** 给定一个未配置 bot 的 workspace，Owner 创建一个名为“TeamBot”的 bot 并启用企微连接，则 workspace 被绑定为该 bot 的激活 workspace，企微消息开始路由到该 workspace。
- AE2. **Covers R4, R19, R21, R22.** 给定一个已绑定 workspace A 的 bot，Owner 在 GUI 切换到 workspace B，则后续企微/飞书入站消息在 workspace B 创建会话，workspace A 中已存在的会话仍保留在 A。
- AE3. **Covers R13, R17, R18。** 给定一个 Normal 用户，当请求读取 `data/other-user/file.txt` 或被拒绝列表中的 `.env` 时，工具调用被拒绝；请求读写 `data/<self>/file.txt` 时成功。
- AE4. **Covers R16。** 给定一个 Admin 用户，当请求写入 `shared/config.json` 或 `data/other-user/file.txt` 时，工具调用被允许（只要路径不在 workspace 敏感文件拒绝列表中）。
- AE5. **Covers R26–R29。** 升级后，原 workspace 的企微 bot ID/secret 被迁移为一个独立 bot 实体，workspace 仍保持在线；原 workspace settings 中不再包含 `wecomBotId`/`wecomBotSecret`，已有 bot 用户默认成为该 bot 的 Owner。

---

## Success Criteria

- 同一个 bot 可以在不同 workspace 之间切换，无需重新配置 provider 凭证。
- Bot 所有者能在 GUI 和企微/飞书中完成 workspace 切换。
- 切换 workspace 后，新消息进入新 workspace，历史会话不丢失。
- Owner/Admin/Normal 三种角色在文件访问、工具/Skill 使用以及 bot 管理权限上表现出明确差异。
- 现有 workspace 的 bot 配置平滑迁移，升级后 bot 保持可用。

---

## Scope Boundaries

### In scope

- 独立 bot 实体的创建、编辑、删除（如删除不过度影响已有会话）。
- 一个 bot 同时支持企微和飞书连接。
- Bot 级别的 Owner/Admin/Normal 三角色及对应权限。
- Workspace 敏感文件拒绝列表（新增可配置项，替代现有硬编码规则）。
- Bot 与 workspace 的单活绑定及切换。
- 在 GUI 中管理 bot 成员和切换 workspace。
- 在企微/飞书中切换当前 workspace。
- 现有 workspace bot 配置的自动迁移。

### Deferred for later

- 在企微/飞书聊天应用中维护成员角色。
- 角色/workspace 变更的审计日志。
- 切换 workspace 时迁移已有会话。
- 跨 provider 身份合并（把同一个人的企微账号和飞书账号关联）。
- 每个 workspace 对 bot 做额外策略收紧。
- 多 workspace 同时激活（多租户并发）。

### Outside scope

- GUI 会话自身的权限模型变更。
- 企微/飞书以外的 bot provider。
- 改变 workspace 目录边界的安全模型（例如允许 bot 访问 workspace 之外的文件）。

---

## Dependencies / Assumptions

- 企微/飞书 SDK 支持以 bot 为粒度管理连接，而不是依赖全局单例。
- `chat-service` 的 `canUseTool` 回调能够注入当前 bot 用户的角色上下文。
- 文件路径策略可以读取 workspace 的敏感文件拒绝列表并拒绝匹配路径。
- 迁移按 workspace 独立进行，不合并不同 workspace 中凭证相同的 bot 配置；每个 workspace 生成独立的 bot 实体。
- Bot Owner 即 workspace 原生所有者（本机/Comate 操作员），被信任为 workspace 的超级用户；不存在外部聊天用户凌驾于本机所有者之上的情况。
- 飞书已支持通过 `/workspace` 命令和卡片回调切换 workspace；企微目前没有 workspace 级切换命令，但有会话级 `/resume` 切换（`src/server/services/wecom-bot-service.ts:115-118`），需要新增 workspace 切换命令/卡片。

---

## Outstanding Questions

### Resolve before planning

无。

### Deferred to planning

- Q4. Bot 管理页面的具体布局和导航入口。
- Q5. 迁移是否提供 dry-run 或回滚能力。
- Q6. Provider 连接错误的展示与重试策略。

---

## Deferred / Open Questions

### From 2026-06-28 review

- **Migration merges divergent policies for same credentials** — Requirements / R26-R29, Migration (P0, adversarial, confidence 100)

  If two workspaces today share the same WeCom bot ID or Feishu app credentials but have different `wecomToolPermissions`, `wecomBotIsolation`, or `feishuAdminUserIds`, the migration creates one bot per unique credential combination. The secondary workspace's policy configuration is lost without a merge rule, causing a non-recoverable data-loss scenario.

- **Workspace switch via chat lacks authentication mechanism** — Requirements / Workspace 切换 (R19-R22) and Key Flows F3 (P0, security-lens, confidence 100)

  R20/F3 allow a Bot Owner to switch the active workspace via a WeCom/Feishu command or card, but only state "系统校验发送者是否为 Bot Owner" without specifying how spoofing is prevented. If the provider webhook signature is not strictly validated, any chat participant could route the bot to the wrong workspace. Deferred because the current provider SDK integrations already validate webhooks and the project wants to add explicit confirmation only if needed later.

---

## Sources / Research

- 当前 workspace 级 bot 配置字段：`src/server/models/workspace.ts:10-32`
- Workspace 表结构（settings JSON 列）：`src/server/storage/sqlite-store.ts:51-63`
- 企微 1:1 bot-to-workspace 映射：`src/server/services/wecom-bot-service.ts:151-199`
- 飞书全局单活 workspace 绑定：`src/server/storage/sqlite-store.ts:104-108`，`src/server/services/feishu-bot-service.ts:67-76`
- 企微隔离与管理策略：`src/server/services/tool-permission-policy.ts:12-30`，`src/server/services/bot-skill-policy.ts:31-66`
- 飞书 workspace 切换命令/卡片回调：`src/server/services/feishu-bot-service.ts:373`，`src/server/services/feishu-card-action-handler.ts:71-88`
- 企微会话级 `/resume` 切换：`src/server/services/wecom-bot-service.ts:115-118`
- 用户与会话映射表：`src/server/storage/sqlite-store.ts:73-82`（企微），`src/server/storage/sqlite-store.ts:111-118`（飞书）
- Workspace 更新路由（当前启用/禁用 bot）：`src/server/routes/workspaces.ts:71-129`
