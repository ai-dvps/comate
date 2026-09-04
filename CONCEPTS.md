# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Product identity

### 通用 Agent 任务工作区 (general-purpose Agent task workspace)
Comate 面向身处组织中的个人专业用户的产品定位：以桌面工作区承载研究、分析、写作、运营、项目管理和开发等通用任务，连接用户或企业选择的 Agent 后端、模型、Skills、MCP、文件、浏览器、自动化与 IM。个人任务完成是主叙事，企业模型、权限与集成用于证明它能在真实组织边界内受控运行；编程只是其中一个场景，不是产品类别。

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

### 浏览器面板 (browser pane)
聊天右侧承载内嵌浏览器画面的可收起面板，按会话独立记忆展开/收起状态；在 Typed context tab 体系中是归属于 Session 的 Browser tab 的内容表面。

它是原生浏览器视图的唯一宿主表面：视图只有在面板挂载并向壳上报自身矩形区域后才变为可见，因此任何"浏览器自动出现"的交互都必须显式触发面板展开（handoff 待决与浏览器诞生/崩溃重建时面板自动展开）。面板收起时保持挂载（keep-alive），不卸载浏览器画面；弹出为 独立浏览器窗口 时面板显示占位，收回时恢复。

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
The runtime layer that executes an agent session (Claude Code, Codex, or OpenCode), distinct from the Provider layer. A backend determines session semantics and the client-side protocol it speaks; a Provider supplies the compatible endpoint, credential, model, and any required routing behavior. The two layers are selected independently only where the Provider declares a supported path for that backend.

### 能力声明表 (capability declaration table)
A per-backend static table declaring which Comate capabilities are full, degraded, or unavailable on that backend. It is the single source of truth driving both the "disabled + reason" degradation UI and the parity acceptance checklist.

### 无 claude 形态 (claude-free distribution form)
A distribution/install form of the app that ships without the Claude Code runtime binary, for enterprises whose security scanning blocks binary presence. Backend availability follows binary presence, so the claude backend simply never appears in this form.

### 会话后端锁定 (session backend lock)
A session is bound to the backend selected at its first message and cannot switch afterward, because transcripts are not portable across runtimes. When the locked backend is unavailable in the current install, the session opens read-only with a notice.

### Bot 会话 (bot session)
由远程 IM 入口（WeCom、feishu）创建的会话，判定依据是会话来源（source 为 `wecom`/`feishu`，即 `isBotSession`），与 GUI 会话和定时执行会话在权限派生、可用工具面与消息呈现路径上分流。新 Bot 会话使用创建时设置中选定的默认 Agent，并在首个回合锁定该后端；修改默认 Agent 不会改变已有 Bot 会话，用户创建新的 Bot 会话后才会使用新默认值。

### 子代理事件通道 (subagent event channel)
由 Task 工具派生的子代理所产生的 SDK 消息因携带 parent_tool_use_id 而被服务端分流，不进入主会话的 tool_use 事件流；而是经独立的 subagent_delta 事件送达客户端，并在历史加载时由专门的重建逻辑还原。派生会话级状态（如任务列表、会话变更文件）时，主通道和该通道是两个独立的采集点，漏掉任一都会静默丢失子代理的工具调用。

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

### 多协议 Provider (multi-protocol Provider)
A third-party model-service account shared across Agent backends. It owns one coding API credential plus protocol-specific endpoint configuration, while Claude Code, Codex, and OpenCode keep separate default models; OpenCode also chooses which configured protocol it uses. A Provider is selectable for an Agent only when that Agent has a complete direct or Comate-supported routed path.

### 后端模型能力档案 (backend model capability profile)
A Provider-owned declaration keyed by an exact Agent backend and model ID. It records the limits, capabilities, compatibility behavior, and backend-native reasoning controls that the selected runtime can consume. Codex and OpenCode profiles remain independent even when they name the same upstream model; known presets may seed editable values, while unknown values are omitted so the backend retains its defaults.

### Provider 本地路由 (Provider local route)
A Comate-managed compatibility route started automatically for an Agent session when the Agent's client protocol differs from the Provider's declared upstream format along a supported conversion path. The first supported path translates Codex Responses traffic to an OpenAI Chat Completions upstream. Route failure blocks dispatch and never falls back to another Agent, Provider, or protocol.

### Provider 用量令牌 (provider usage token)
Each Provider can carry a second credential alongside its coding API key (`authToken`): a usage token, a web-login session JWT obtained by logging into the provider's website through the embedded browser. It is stored encrypted at rest, used only to query the provider's billing/usage endpoint, and never leaves the server. The coding API key drives model calls; the usage token drives quota/billing reads. Kimi is the first provider to carry one, and this two-credential split is the pattern other providers' usage will follow.

## Skills

### skill-manager
Comate 内置的 Skills 管理 Skill，负责通过对话发现、安装、删除和更新用户 Skills，并补齐 scope、目标 Agent 与具体 Skill 选择等必要信息。它随应用提供，以标准 Skills 机制供各 Agent 后端加载；已安装页提供使用引导，清单与 Prompt skill picker 展示实际安装和当前会话可用状态。由 `docs/plans/2026-09-03-2124-refactor-conversational-skill-management-plan.md` 定义。

### Skill search provider
A remote Skill catalog used by conversational Skill discovery. Provider availability means the catalog returned a valid search response; network errors, timeouts, non-success responses, and malformed responses make it temporarily unavailable, while a valid empty result does not.

### 企业专区 (Enterprise Zone)
历史 Skills 目录入口，现已从管理界面移除。原有安装仍按实际文件列出，后续管理通过 skill-manager 对话完成。

### 专家包 (Expert Package)
由一个专家包专用编排项和多个标准子 Skills 组成的完整工作流能力。编排项不是业界标准 Skill，但会以运行时可加载的 `SKILL.md` 写入共享作用域，并通过 `skillhub-package:` 来源识别为 `expert-package-orchestrator`，在 Installed 中专门标记。旧专家包的编排项、子 Skills 与来源记录继续保留；新界面不再提供专家包目录和安装表单。

## Desktop shell

### Agent Command Center
桌面端常驻左侧的后台工作监督与导航区域。它按 Workspace 组织 Session，承载搜索、状态筛选、Bot 连接状态和需要用户参与的提示；用户在中间区域一次只处理一个激活 Session。

### 事件驱动 MRU 排序 (event-driven MRU ordering)
Agent Command Center 侧栏 Workspace 与 Session 列表的排序契约：列表顺序只在「回合开始」（用户发送消息，或 bot/定时任务开始一轮执行）时把对应 Session 及其 Workspace 移到顶部；流式增量、状态轮询、回合完成、待处理交互、点击打开都不再改变位置，仅用状态图标/徽标表达。顺序跨重启持久化，新建项一次性插入列表顶部。由 `docs/plans/2026-08-19-001-fix-activity-sort-position-stability-plan.md` 定义，取代此前按活跃时间戳实时重排的契约。

### Typed context tab
桌面端右侧工作区中带有内容类型和归属范围的标签页。Browser tab 归属于 Session，File 与 Changes tab 归属于 Workspace；File 和 Changes 各自在内容右侧携带可收起的导航列表。

### Git Graph
归属于 Workspace 的只读 Typed context tab，用真实的父子关系与 refs 展示分支和 commit 拓扑。多仓库语义下，Workspace 是仓库容器，同一 Graph 内选择一个仓库浏览，各仓库保有独立上下文，不合并不同仓库的历史。选中 commit 后的信息与变更文件保留在 Graph 内，只有具体文件 diff 会像普通文件一样打开独立 Diff Tab；Diff 始终绑定打开时的仓库、commit 和文件，不随 Graph 的仓库选择变化。它不推断主分支或已合并状态，也不执行修改仓库的 Git 动作。

### 会话变更文件 (session changed files)
聊天视图右侧浮动 Task 面板下方的浮动卡片，按会话派生 agent 通过文件工具（Edit/Write/MultiEdit/NotebookEdit）触碰过的文件（新增/修改/删除），供一眼感知与一键打开。它与工作区范围的 Changes tab 是不同表面：不依赖 git 状态、不含 bash 改动、从持久化会话历史重建（重启与历史会话仍可见），且不提供 review/diff 动作。

### Token 结算条 (token settlement bar)
每个 assistant 回合完成后归属于对应回复的用量摘要，显示该轮 Token 总量及后端可提供的输入、输出、缓存和推理拆分；准确值直接展示，推导或估算值标注“约”，后续回合不得覆盖既有结算结果。

### 桥接版本 (bridge release)
Tauri→Electron 壳迁移中，最后一个 Tauri 版本承担的特殊角色：其自动更新通道指向首个 Electron 安装包，把存量用户平滑带到 Electron 线；更新失败时用户可回滚到该版本安装包。Linux 无桥接版本——首个 Linux 版本即 Electron 版本。

## Prompt composer

### Prompt image draft
Prompt 编辑器中尚未被 Agent 后端接受的有序图片附件集合。它与 Prompt 文本分开，由 CoMate 按 Session 在当前应用运行期持有；切换 Session 或发送失败时保留，后端接受后清除，不跨应用重启持久化。

### Backend-owned sent image
Claude Code 或 OpenCode 已接受并写入自身 transcript 的图片消息。后端 transcript 是图片内容与历史可用性的唯一真相源；CoMate 只负责适配和展示，不为已发送图片维护持久化副本或恢复仓库。

### Prompt semantic reference
Prompt 中能够被当前工作区确认解析的 Skill 或文件引用，分别采用 `/skill-name` 与 `@path` 形式。它的持久化、复制和提交表示仍是纯文本；编辑器可以在引用完成并解析成功后把它呈现为 Atomic prompt reference。

### Atomic prompt reference
Prompt semantic reference 在当前草稿编辑器中的轻量 chip 形态。光标、选区和删除把它视为一个整体，不能逐字修改；引用在当前草稿中失效后继续保持原子并显示警示，但重新载入时只按当时的解析结果重建，不跨重启保存结构化 token 身份。
