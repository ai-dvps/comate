# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Steel vendoring

### Vendored Steel
The third-party Steel browser engine, repackaged as a pure-JS, dependency-pruned bundle that ships inside the desktop app's resources; the embedded controlled browser runs it locally instead of requiring Docker.

The bundle is rebuilt from a pinned upstream commit and must pass build-time gates before packaging: a pure-JS audit (no native binaries), a size budget, and a dangling-symlink audit. Opt-in heavyweight or native upstream dependencies are replaced by pure-JS stubs that load cleanly and throw only if actually used.

### Production closure
The set of runtime dependencies vendored alongside the Vendored Steel build product, computed from the pinned upstream lockfile rather than from a full npm install, so dev-only and platform-optional packages never reach the app bundle.

## Agent runtime

### Agent 后端 (agent backend)
The runtime layer that executes an agent session (claude via `@anthropic-ai/claude-agent-sdk`, or opencode), distinct from the Provider layer, which only names a model endpoint. The two layers swap independently: an enterprise can run any backend against any Anthropic-compatible endpoint.

### 能力声明表 (capability declaration table)
A per-backend static table declaring which Comate capabilities are full, degraded, or unavailable on that backend. It is the single source of truth driving both the "disabled + reason" degradation UI and the parity acceptance checklist.

### 无 claude 形态 (claude-free distribution form)
A distribution/install form of the app that ships without the Claude Code runtime binary, for enterprises whose security scanning blocks binary presence. Backend availability follows binary presence, so the claude backend simply never appears in this form.

### 会话后端锁定 (session backend lock)
A session is bound to the backend selected at its first message and cannot switch afterward, because transcripts are not portable across runtimes. When the locked backend is unavailable in the current install, the session opens read-only with a notice.

### Session Activity
服务端维护的会话工作状态快照，统一表达 foreground turn、pending interaction、SDK background tasks、stopping 和 interruption。它是前端活跃展示、输入锁定与 runtime idle-close 判定的共同真相源；主 agent 的 `result` 只结束 foreground，不单独决定整个 Session 是否结束。

## Scheduled tasks (定时任务)

### 定时任务 (scheduled task)
绑定单个工作区的可调度执行单元：名称 + 自包含指令 + 调度规则（一次性或周期）+ 通知配置。仅在应用运行期间到点触发；触发时以免审批（auto）模式启动一个全新会话，首条消息为系统包装的 /goal（指令 + 完成标准 + 轮次上限）。聊天中创建必须经用户在 UI 确认才生效，远程入口（如 WeCom）创建的一律需确认。

### 执行会话 (run session)
定时任务单次触发所产生的全新独立会话；同一任务的各次执行互不共享上下文。任务详情中执行历史列表的每条记录对应一个执行会话，状态取值为：已成功 / 已失败 / 已错过（触发时应用未运行，不补跑）/ 已跳过（上一班次仍在执行）。

## Todos

### 来源锚定 (origin-anchored ownership)
每个 todo 的「来源端」（创建方）是它的真相源；同步是有方向的，从来源端流向副本。本地创建的 todo 以本地为准，可发布成 GitHub issue；GitHub 上创建的 issue 以 GitHub 为准，可拉取成本地 todo。副本端对结构字段（标题/正文）的改动以来源端为准，检测到分歧时提示用户处理，不静默覆盖。

### 字段级同步 (field-class sync)
todo 同步行为按字段类别分区，而非单一全局策略：评论双向追加（永不冲突）；协作状态（开/关、标签、指派人）接受远端并镜像回本地；结构字段（标题、正文）来源端为准、冲突时提示。GitHub 是第一个后端适配器，后续其他服务端走同一套通用适配器契约。

## Provider credentials

### Provider 用量令牌 (provider usage token)
Each Provider can carry a second credential alongside its coding API key (`authToken`): a usage token, a web-login session JWT obtained by logging into the provider's website through the embedded browser. It is stored encrypted at rest, used only to query the provider's billing/usage endpoint, and never leaves the server. The coding API key drives model calls; the usage token drives quota/billing reads. Kimi is the first provider to carry one, and this two-credential split is the pattern other providers' usage will follow.
