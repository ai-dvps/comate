---
date: 2026-06-19
topic: wecom-bot-user-isolation
title: "feat: Per-user file, transcript and skill isolation for WeCom bot sessions"
---

## Summary

在 WeCom bot 模式下为每个用户建立独立的文件访问、会话历史访问和基于管理员名单的 Skill 调用策略，不复制 workspace，也不影响 GUI 会话。通过增强现有 `canUseTool` 路径策略隔离用户文件与共享 `CLAUDE_CONFIG_DIR` 中的会话 JSONL 访问，通过管理员可配置的 Bash 命令白名单受控开放 shell，通过在 workspace 设置中维护管理员名单区分扩展 Skill 集合与默认受限集合。

---

## Problem Frame

当前每个 WeCom 用户虽然拥有独立的 `Session`，但这些 Session 都运行在同一个 workspace 目录下：

- 用户上传的文件已按用户目录存放，但 Claude 通过 `Write`/`Edit` 生成的文件可以写到 workspace 任意位置。
- 所有 bot 用户的会话历史 JSONL 默认落在同一个 `CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/` 目录下，存在被 prompt injection 读取其他用户对话的风险。
- Skill 调用对 bot 会话完全开放，无法限制特定用户调用特定 Skill。
- 业务上不能完全拒绝 `Bash`，但开放 shell 会削弱文件隔离强度。

本方案在不复制 workspace、不改变 GUI 非 bot 会话的前提下，解决上述四类问题。

---

## Key Decisions

- **路径过滤优于 workspace 复制。** 不引入 worktree 或副本，避免与原 workspace 的双向同步、存储翻倍和 GUI 不兼容问题；通过 `canUseTool` 对所有文件类工具做路径级拦截。
- **会话历史留在共享 `CLAUDE_CONFIG_DIR`，靠路径策略保护。** 不改动 SDK 的 config 根目录，避免对 GUI 会话和 SDK 其他行为产生影响；通过拒绝 bot 读取 `.claude/projects/` 来防止跨用户读取 JSONL。
- **Bash 通过管理员白名单受控开放。** 默认拒绝所有 Bash；管理员可配置允许的命令和参数模式。白名单中的命令若包含文件/路径参数，必须同样通过用户目录白名单校验；允许执行时也必须使用最小化、无敏感凭据的执行上下文。
- **Skill 限制按用户生效。** 在 workspace 设置中维护一个管理员名单；名单内的用户可使用更宽的 Skill 集合，其他用户走默认受限集合。
- **共享项目文件保持可读，但拒绝规则优先。** 用户上传/生成的文件是隔离对象；workspace 原有文件在排除凭据、环境文件、私钥、本地数据库、日志、Claude 配置/运行时目录等敏感路径后，仍可按现有工具策略读取，以保留 bot 对项目代码的查询能力。
- **拒绝时返回通用提示。** 不透露被阻止的具体文件路径、命令或 Skill 名称，降低信息泄露和探测风险。
- **审计级隔离依赖路径策略 + Bash 白名单共同生效。** 单独放开 shell 而不限制参数会导致隔离失效。

---

## Actors

- A1. **WeCom bot 用户**：通过企业微信与 bot 对话的外部用户，不可信，需要被隔离。
- A2. **Workspace 管理员**：在设置中配置 Bash 白名单、Skill 管理员名单和默认 Skill 策略。
- A3. **GUI 用户**：使用原 workspace 的非 bot 会话用户，本方案不对其做额外限制。
- A4. **ChatService / SessionRuntime**：负责创建运行时并把经过验证的 WeCom 用户身份和策略注入 `canUseTool`。
- A5. **WeComBotService**：负责把入站消息映射到对应用户会话并处理上传文件。

---

## Requirements

### 文件隔离

- R1. Bot 会话的所有文件访问类 SDK 工具必须按经过验证的 canonical WeCom user id 执行路径策略；身份缺失、歧义或无法映射时必须拒绝工具访问。
- R2. Bot 用户可以读写的范围限于：自己的用户目录，以及经过拒绝规则过滤后的 workspace 原有共享文件。共享文件允许规则必须排除凭据、环境文件、私钥、本地数据库、日志、Claude 配置/运行时目录和 workspace 策略 denylist 中的路径或类型；拒绝规则优先于共享读取允许规则。
- R3. Bot 用户读取其他用户目录、以及 `.claude/projects/` 等会话历史存储位置的行为必须被拒绝。
- R4. Bot 用户只能在自己的用户目录内创建或修改文件；向共享 workspace 文件写入必须被拒绝。
- R5. 路径策略必须覆盖 `Read`、`Glob`、`Grep`、`Edit`、`Write`、`NotebookEdit`，并对未来新增的文件类工具保持可扩展。路径判断必须基于 canonical resolved path containment；相对路径、symlink、hardlink、通配符展开以及 `Glob`/`Grep` 结果必须先按 deny-before-allow 策略校验，逃逸允许根目录的路径必须被拒绝。

### Bash 控制

- R6. Bot 会话默认拒绝所有 `Bash` 调用；管理员可在 workspace 设置中配置命令白名单。
- R7. Bash 白名单中的每个条目必须指定允许的命令名称及参数模式；未匹配的命令或参数必须被拒绝。
- R8. Bash 调用解析后，任何文件或路径参数必须通过当前用户的路径策略校验；shell 元字符（管道、重定向、命令替换、逻辑运算符、分号等）必须被拒绝。允许执行的 Bash 必须运行在最小化的非敏感环境、受限 working directory 中；除非白名单条目显式允许，默认不得继承 provider/bot 凭据、访问网络、读取进程环境或返回可能包含敏感信息的 stdout/stderr。
- R9. 白名单变更仅对新创建的 bot 运行时生效；已存在的运行时仍按创建时的快照策略执行，直到重建。

### Skill 调用隔离

- R10. Bot 会话中的 Skill 调用必须按经过验证的 canonical WeCom user id 策略进行允许/拒绝判断；不得依据 prompt 内容、显示名或未验证字段决定权限。
- R11. Workspace 设置中支持配置管理员 WeCom 用户名单；名单内用户可使用扩展 Skill 集合。
- R12. 非管理员 bot 用户使用 workspace 默认受限 Skill 集合。

### 配置与交互

- R13. Workspace 设置中提供 Bash 白名单、Skill 管理员名单和默认 Skill 策略的配置界面。
- R14. 当文件访问、Bash 或 Skill 调用被拒绝时，bot 向用户返回通用提示，不暴露具体被拒绝的资源或策略细节。

---

## Key Flows

- F1. **用户上传文件**
  - **Trigger:** WeCom 用户发送文件/图片/视频。
  - **Actors:** A1, A5.
  - **Steps:** 文件保存到 `workspaceFolder/<userFolder>/...`；后续该用户读写此文件被允许。
  - **Covered by:** R2.

- F2. **用户读取自己的生成文件**
  - **Trigger:** 用户请求 bot 查看之前生成的文件。
  - **Actors:** A1, A4.
  - **Steps:** `canUseTool` 判断路径属于当前用户目录，允许 `Read`/`Glob`/`Grep`。
  - **Covered by:** R1, R2.

- F3. **用户尝试读取其他用户文件或会话历史**
  - **Trigger:** 用户通过 prompt 让 bot 读取 `userB/...` 或 `.claude/projects/...`。
  - **Actors:** A1, A4.
  - **Steps:** `canUseTool` 识别路径超出允许范围，拒绝工具调用；bot 返回通用提示。
  - **Covered by:** R1, R3, R14.

- F4. **用户尝试调用受限 Skill**
  - **Trigger:** 用户消息触发 `Skill` 工具调用。
  - **Actors:** A1, A4.
  - **Steps:** `canUseTool` 根据当前用户是否在管理员名单以及 Skill 名称决定是否允许；拒绝时返回通用提示。
  - **Covered by:** R10, R11, R12, R14.

- F5. **管理员名单或白名单变更后生效**
  - **Trigger:** A2 在设置中新增/移除管理员用户、调整默认 Skill 集合或修改 Bash 白名单。
  - **Actors:** A2.
  - **Steps:** 策略保存后，新创建的 bot 会话按新策略执行；已存在的运行时仍按创建时的快照策略执行，直到重建。
  - **Covered by:** R9, R11, R13.

- F6. **用户执行白名单内的 Bash 命令**
  - **Trigger:** Bot 会话尝试调用 `Bash`。
  - **Actors:** A1, A4.
  - **Steps:** 先校验命令和参数是否在白名单；再校验所有路径参数是否属于当前用户目录；全部通过才允许执行；任一检查失败返回通用提示。
  - **Covered by:** R6, R7, R8.

---

## Acceptance Examples

- AE1. **Covers R1, R3.** 用户 A 的 bot 会话尝试 `Read` `userB/report.txt`，调用被拒绝，bot 回复通用提示。
- AE2. **Covers R2, R4.** 用户 A 让 bot 写总结，`Write` `userA/summary.md` 成功；同一会话尝试 `Write` `src/main.ts` 被拒绝。
- AE3. **Covers R1, R3.** 用户 A 尝试让 bot `Glob` `.claude/projects/` 或读取其中的 JSONL，调用被拒绝。
- AE4. **Covers R10, R11, R12.** 非管理员用户调用某 Skill 被拒绝；管理员用户调用同一 Skill 被允许。
- AE5. **Covers R6, R7, R8.** 管理员已配置允许 `python analyze.py`。用户 A 的 bot 调用 `python analyze.py` 成功；调用 `python -c "print(open('userB/file.txt').read())"` 被拒绝；调用 `cat userB/file.txt` 被拒绝（命令不在白名单）。

---

## Success Criteria

- 任意两个 WeCom bot 用户无法通过工具读取对方的文件或会话历史。
- 管理员可以配置哪些 Bash 命令和参数可被 bot 执行，且无法通过路径参数绕过隔离。
- 管理员可以在设置中控制哪些用户能调用更宽的 Skill 集合。
- GUI 非 bot 会话的行为和文件可见性与当前保持一致。
- 拒绝时不泄露被拦截的具体路径、文件名、命令或 Skill 名称。

---

## Scope Boundaries

### In scope

- Bot 会话的文件路径隔离。
- `.claude/projects/` 等会话历史存储路径的访问控制。
- Bot 会话的 Bash 命令白名单及参数/路径校验。
- Bot 会话的 per-user Skill 调用限制。
- Workspace 设置中的 Bash 白名单、管理员名单和 Skill 策略配置。
- 统一的通用拒绝提示。

### Deferred for later

- MCP 工具的权限控制（与 Skill 类似，但工具发现机制不同，需要单独设计）。
- OS 级沙箱或容器隔离（作为方向 B/C 的后续增强）。
- GUI 会话之间的隔离。
- Bot 生成文件自动同步回原 workspace 的双向同步机制。
- 权限变更审计日志。

### Outside scope

- 修改 GUI 会话的权限流程。
- 修改 WeCom 连接、文件上传或 prompt template 逻辑。
- 改变 Claude Agent SDK 的初始化方式（仅通过 `canUseTool` 注入策略）。

---

## Dependencies / Assumptions

- SDK 的 `canUseTool` 回调会在所有文件类工具、`Bash` 和 `Skill` 调用前触发。
- Skill 工具调用可以通过工具名称及输入参数中的 skill 标识符识别。
- Bash 输入可以被安全地解析为命令 + 参数，以识别命令名和路径参数；复杂的 shell 结构（如嵌套命令替换）应直接拒绝。
- 管理员正确配置白名单；系统提供安全的默认拒绝策略。

---

## Outstanding Questions

### Resolve before planning

- Q1. Skill 调用的 SDK 工具名是什么，以及 skill 名称出现在输入的哪个字段？
- Q2. `Glob`/`Grep` 的路径过滤是否能基于输入参数可靠实现，是否需要限制通配符范围？
- Q3. Bash 白名单的配置格式应该支持哪些能力：仅固定命令、带占位符参数、正则匹配参数，还是其他？

### Deferred to planning

- Q4. Workspace 设置中 Bash 白名单、管理员名单和 Skill 策略配置的具体 UI 布局。
- Q5. 通用拒绝提示的文案和 i18n key。
- Q6. Bash 解析器的严格程度：是只允许简单 token，还是支持带引号的参数？

---

## Deferred / Open Questions

### From 2026-06-19 review

- **Deferred MCP conflicts with isolation** — Scope Boundaries / Success Criteria (P1, product-lens, feasibility, scope-guardian, confidence 100)

  The success criterion promises cross-user file and transcript isolation through tools, but the scope explicitly leaves a tool family with similar permission concerns for later. If the release keeps this claim, any enabled MCP tool that can read files or session data creates a gap between the product promise and shipped behavior.

- **Bash whitelist cannot guarantee file isolation** — Bash 控制 / Success Criteria (P1, feasibility, adversarial, confidence 100)

  Argument-level Bash filtering cannot mediate file reads performed inside an allowed process. With Bash allowed for commands such as `python analyze.py` and OS sandboxing deferred, the system can only trust selected commands not to read disallowed paths; it cannot guarantee the stated cross-user file and transcript isolation from path policy alone.

- **Shared workspace reads contradict untrusted-user framing** — Key Decisions / Actors (P1, product-lens, confidence 75)

  Admins can ship a system that blocks user-to-user leakage while still exposing the workspace's existing project files to every bot user. Because the doc labels bot users external and untrusted, keeping shared workspace reads broadly enabled is a product and trust decision that needs explicit authorization before implementation normalizes it.

- **Transcript isolation depends on unproven gate** — Key Decisions / Dependencies (P1, adversarial, confidence 75)

  The document keeps every bot user's session history in one shared storage area and relies on tool interception to protect it. If any file-like tool, SDK access path, path alias, or future tool bypasses `canUseTool`, the transcript isolation guarantee collapses.

- **Policy revocation lacks runtime enforcement** — Bash 控制 / Key Flows (P1, design-lens, scope-guardian, adversarial, confidence 100)

  Admins can change Bash and Skill policy, but the spec says existing bot runtimes keep the old snapshot until rebuild without requiring a rebuild path. That means an admin revoking a dangerous Bash allowance may still have live sessions executing under the stale policy.

- **Skill isolation is only admin-tiered** — Skill 调用隔离 (P2, product-lens, confidence 75)

  Implementers will build a binary admin/default Skill model while the document promises per-user Skill control. Workspace admins who need one user to have one extra Skill will either over-promote that user into the broad admin set or find that the stated per-user outcome is not supported.

- **Bash support lacks workflow evidence** — Problem Frame / Bash 控制 (P2, product-lens, confidence 75)

  The requirements pull a high-complexity admin whitelist and parser into scope without naming the business workflows that justify shell access. Planners will optimize for a generic Bash product surface instead of the few commands users actually need, increasing admin cognitive load and the chance of broad allowlists that weaken the isolation promise.

- **Original shared files lack invariant** — 文件隔离 / Key Decisions (P2, adversarial, confidence 75)

  The read policy needs a stable way to distinguish shared project files from user-owned or generated artifacts. Without that invariant, the allowed read surface can drift as user folders, generated files, renamed paths, or links enter the workspace.

- **Settings validation states are unspecified** — 配置与交互 / Outstanding Questions (P2, design-lens, confidence 75)

  Admins configuring whitelist and Skill policy need clear feedback when required fields are missing, unsupported, or fail to save. The requirements define the settings surface and mandatory whitelist fields, but omit empty, invalid, saving, success, and failure states, leaving implementers to decide whether bad policies are blocked, ignored, or saved but ineffective.

---

## Sources

- 现有 bot 工具权限策略：`src/server/services/tool-permission-policy.ts`
- Bot 会话 `canUseTool` 注入点：`src/server/services/chat-service.ts` 中 `isBotSession` 分支
- WeCom 文件保存路径：`src/server/services/wecom-file-storage.ts`
- WeCom 用户与会话映射：`src/server/services/wecom-bot-service.ts` 与 `src/server/storage/sqlite-store.ts` 中 `wecom_user_sessions`
