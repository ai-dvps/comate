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

## Scheduled tasks (定时任务)

### 定时任务 (scheduled task)
绑定单个工作区的可调度执行单元：名称 + 自包含指令 + 调度规则（一次性或周期）+ 通知配置。仅在应用运行期间到点触发；触发时以免审批（auto）模式启动一个全新会话，首条消息为系统包装的 /goal（指令 + 完成标准 + 轮次上限）。聊天中创建必须经用户在 UI 确认才生效，远程入口（如 WeCom）创建的一律需确认。

### 执行会话 (run session)
定时任务单次触发所产生的全新独立会话；同一任务的各次执行互不共享上下文。任务详情中执行历史列表的每条记录对应一个执行会话，状态取值为：已成功 / 已失败 / 已错过（触发时应用未运行，不补跑）/ 已跳过（上一班次仍在执行）。
