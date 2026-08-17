# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Steel vendoring

> **Historical (retired in U9, Tauri→Electron migration):** the vendored Steel
> bundle, the Chrome for Testing payload, and the whole child-process browser
> stack were deleted. The embedded browser now runs as native WebContentsViews
> in the Electron shell (per-session partitions over the KTD-11 control
> channel); the R8 fallback is `COMATE_BROWSER_CDP_TARGET` pointing at an
> operator-supplied external Chromium. These entries remain as vocabulary for
> pre-migration documents.

### Vendored Steel
The third-party Steel browser engine, repackaged as a pure-JS, dependency-pruned bundle that ships inside the desktop app's resources; the embedded controlled browser runs it locally instead of requiring Docker.

The bundle is rebuilt from a pinned upstream commit and must pass build-time gates before packaging: a pure-JS audit (no native binaries), a size budget, and a dangling-symlink audit. Opt-in heavyweight or native upstream dependencies are replaced by pure-JS stubs that load cleanly and throw only if actually used.

### Production closure
The set of runtime dependencies vendored alongside the Vendored Steel build product, computed from the pinned upstream lockfile rather than from a full npm install, so dev-only and platform-optional packages never reach the app bundle.

## Browser API automation

### 独立浏览器窗口 (detached browser window)
内嵌浏览器从聊天右侧面板移出的 OS 级窗口。它固定归属于弹出时的聊天会话，主窗口保留原尺寸占位；关闭窗口只把同一浏览器画面移回原面板，不关闭浏览器会话。

### 受控激活 (controlled activation)
内嵌浏览器对无法证明无外部副作用的页面控件执行一次点击或等价激活的流程。它以来源页、文档、元素身份和动作摘要为批准边界；批准后必须重新校验，且一次批准最多派发一次动作。

### 浏览器动作回执 (browser operation receipt)
浏览器工具对一次修改型动作返回的安全结果摘要，用来区分未派发、已派发且验证、已派发但仅观察到页面变化，以及派发结果未知。回执只携带恢复决策所需的长度、摘要、页面差分和重试安全性，不回显正文、敏感字段或文件内容。

### 工作区文件出站 (workspace file egress)
内嵌浏览器把本地媒体字节交给远程页面文件输入的专用批准流程。它只接受工作区相对路径，并在批准前验证媒体类型与文件身份；批准后从安全重开的文件句柄复制到进程私有暂存，再对壳拥有的浏览器视图执行一次文件赋值。外部 CDP、路径漂移或目标漂移都必须拒绝。

### 浏览器安全清单 (browser security manifest)
提交、受控激活和工作区文件出站共用的应用自有审批呈现。清单始终完整显示解析后的来源、受信任警告、明确标注的未受信任页面文本、文件元数据或漂移摘要，不把安全字段藏在“显示更多”后；通用 `canUseTool` 层只分类，绑定目标的 handler 是唯一审批权威。

### 浏览器任务状态 (browser task state)
内嵌浏览器围绕当前用户目标维护的完成度模型。它把页面控件归入内容类型、主内容、发布元数据、媒体、声明和最终动作等语义槽位，并区分可用、已填写、已验证、受阻、等待用户确认和已完成；动作回执只更新证据，不能单独把任务标记为完成。

### 混合页面观察 (hybrid page observation)
同一页面修订上的结构化浏览器证据与受控视口图像。结构化证据提供稳定目标、状态和几何关系，视觉证据补足布局与非标准控件语义；视觉推断本身不授予执行权，执行前仍须绑定并复核当前受信任目标。

### Sanitized API recipe
A chat-resident description of an HTTP request discovered from one recorded browser action: request shape, variable inputs, authentication placeholders, expected response fields, and bounded response evidence. Credential values and detected secrets are removed before the recipe enters model context, and the recipe is not automatically persisted outside its originating task.

### Authenticated-request broker
The Comate server capability that performs HTTPS requests with saved browser authentication without returning cookies, bearer tokens, or browser storage to the caller. Agents use it through MCP, local scripts use it through the Comate CLI, and both paths require a running Comate instance.

## Agent runtime

### Sidecar(后端伴生进程)
桌面应用的后端:一个被打包成单一自包含二进制的 Node 服务进程,由 Electron 壳拉起并监督其生命周期。开发模式同样构建并运行这个打包二进制(而非直接用系统 Node 跑源码),因此只存在于打包运行时里的缺陷(如原生 API 崩溃)在开发环境会原样复现——不能用系统 Node 下的正常表现来排除打包产物的缺陷。

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

### Workspace Activity
Workspace 内所有 Session 的有效活动新近度聚合。它沿用 Session Activity 的用户关注语义，包括运行或处理中、未读完成和待用户处理，并以最新一次有效活动决定 Workspace 在全局列表中的顺序；选中、打开或展开 Workspace 不产生新的活动权重。

### New Chat
不预先创建会话、直接从第一条 prompt 开始对话的应用级流程：用户选择工作区并输入首条 prompt，发送时才创建会话并由服务端从 prompt 派生标题。它是唯一走“服务端派生标题”的建会话路径，因此会触到手动输入标题的建会话路径永远不会执行的服务端代码。

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

## Skills

### Skill search provider
A remote Skill catalog that contributes normalized results to federated Skill Search. Provider availability means the catalog returned a valid search response; network errors, timeouts, non-success responses, and malformed responses make it temporarily unavailable, while a valid empty result does not.

### 企业专区 (Enterprise Zone)
SkillHub 中以企业为发现入口的标准 Skill 目录。用户先浏览企业，再查看该企业发布的 Skills；安装时仍按普通 `skillhub-cn:` Skill 逐个安装，不产生企业级编排项、批量安装语义或独立的 installed kind。

### 专家包 (Expert Package)
由一个专家包专用编排项和多个标准子 Skills 组成的完整工作流能力。编排项不是业界标准 Skill，但会以运行时可加载的 `SKILL.md` 写入共享作用域，并通过 `skillhub-package:` 来源识别为 `expert-package-orchestrator`，在 Installed 中专门标记。安装专家包会在同一作用域安装编排项与全部子 Skills；从包内 Skill 详情安装时只安装当前 Skill。

## Desktop shell

### Agent Command Center
桌面端常驻左侧的后台工作监督与导航区域。它按 Workspace 组织 Session，承载搜索、状态筛选、Bot 连接状态和需要用户参与的提示；用户在中间区域一次只处理一个激活 Session。

### Typed context tab
桌面端右侧工作区中带有内容类型和归属范围的标签页。Browser tab 归属于 Session，File 与 Changes tab 归属于 Workspace；File 和 Changes 各自在内容右侧携带可收起的导航列表。

### 桥接版本 (bridge release)
Tauri→Electron 壳迁移中，最后一个 Tauri 版本承担的特殊角色：其自动更新通道指向首个 Electron 安装包，把存量用户平滑带到 Electron 线；更新失败时用户可回滚到该版本安装包。Linux 无桥接版本——首个 Linux 版本即 Electron 版本。

## Prompt composer

### Prompt semantic reference
Prompt 中能够被当前工作区确认解析的 Skill 或文件引用，分别采用 `/skill-name` 与 `@path` 形式。它的持久化、复制和提交表示仍是纯文本；编辑器可以在引用完成并解析成功后把它呈现为 Atomic prompt reference。

### Atomic prompt reference
Prompt semantic reference 在当前草稿编辑器中的轻量 chip 形态。光标、选区和删除把它视为一个整体，不能逐字修改；引用在当前草稿中失效后继续保持原子并显示警示，但重新载入时只按当时的解析结果重建，不跨重启保存结构化 token 身份。
