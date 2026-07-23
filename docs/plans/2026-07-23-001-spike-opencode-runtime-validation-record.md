# opencode 运行时替代验证 — Spike 记录

日期：2026-07-23 · 类型：spike 验证记录（非实施计划）· 分支：`spike/opencode-runtime-validation`

## 背景

ce-pov 裁决（Trial）：选 opencode 替代 `@anthropic-ai/claude-agent-sdk`，用于禁用 Claude Code 的企业部署。本 spike 实测验证裁决的五个条件。产物：

- `src/server/services/opencode-client.ts` — spawn `opencode serve` + REST + SSE 客户端（对照 `sdk-client.ts` 形状，零新依赖）
- `src/server/services/opencode-client.test.ts` — 16 个单元测试（SSE 解析器、part 映射、spawn 参数）
- `scripts/spike-opencode.ts` — 活验证驱动（真实 serve 进程 + 真实模型端到端）

## 条件验证结果

| # | 条件 | 结果 | 证据 |
|---|------|------|------|
| 1 | 审批回环对等 | **通过（带一个已知差异）** | `permission.asked` → POST `/session/{id}/permissions/{pid}` `{response:"once"}` → `permission.replied` → 工具执行 → 文件落盘内容精确匹配 |
| 2 | 事件流保真 | **通过** | text / reasoning / tool(pending→running→completed) / step-start / step-finish 全部到达；映射到 MessagePart 无 fidelity gap；`message.part.delta` 提供增量流 |
| 3 | 浏览器 MCP 独立化 | 未实测（静态结论） | opencode 支持 stdio/http MCP 配置；需把 `createSdkMcpServer` 进程内服务改造为独立进程，工作量与运行时选型无关 |
| 4 | 二进制打包 | **通过** | npm `opencode-ai@1.18.4`（MIT）以 12 个平台 optionalDependencies 分发（`opencode-darwin-arm64` 等），与 `@anthropic-ai/claude-agent-sdk-{platform}-{arch}` 同构；`resolve-sdk-binary.ts` 四策略可平移 |
| 5 | 非 Anthropic 链路 | **通过** | 自定义 provider（`@ai-sdk/anthropic` + `https://api.kimi.com/coding/v1`，复用 Comate 默认 Kimi 端点）端到端跑通，全链路无 Anthropic 流量 |

## 关键实测事实（集成时直接有用）

1. **审批载荷比 claude 更适合渲染**：`permission.asked` 携带 `metadata.diff`（预算好的 unified diff）、`patterns`、`always`（可持久化规则）、`tool:{messageID,callID}`（关联工具 part 的 join key）。Comate 的 ApprovalSurface 可直接消费。
2. **无"修改输入后批准"**：应答词汇仅 `once|always|reject`。Comate 的 `updatedInput` 实际只有两类用途——echo 原输入（schema 要求，opencode 不需要）和 AskUserQuestion 答案注入（opencode 走独立的 `/question/{requestID}/reply` 通道，v2 API）。**无真实功能损失，但 Question 通道需另行接线。**
3. **事件按 project directory 隔离**：`/event` 订阅必须带 `?directory=`（或 spawn 时以 workspace 为 cwd），否则静默收不到任何会话事件——本次 spike 第一次超时即踩此坑。
4. **事件协议存在版本漂移**：本机 1.14.22 发 `permission.asked`，1.18 源码改名 `permission.updated`。**Comate 必须锁定二进制版本**（用 npm optionalDeps 而非用户机器上的 homebrew 版），与 claude SDK↔CLI 的版本锁定逻辑一致。
5. **自定义 anthropic 兼容 provider 的 baseURL 必须含 `/v1`**（opencode 的 ai-sdk 只追加 `/messages`）。
6. REST 附加面实测通过：`POST /session/{id}/fork`、`GET /session/{id}/children`、`GET /session/{id}/todo`、`GET /session/{id}/message`。

## 缺口与风险清单

1. **AskUserQuestion 等价通道未实测**：`/question/reply` 属 v2 API（本机 1.14 无二进制可验），需在锁定的 1.18.x 二进制上补验。
2. **hooks 未验证**：Comate 用 `Options.hooks`；opencode 对应物是 plugin 体系，接线方式待定。
3. **本环境的两个非阻断异常**：minimax 端点 401（用户 key/额度问题，与 opencode 无关）；opencode zen 免费模型网关 TLS 证书错误（疑似本网络环境特有，待排查——若企业环境普遍如此，免费模型不可作为兜底）。
4. **迁移时需解耦的类型污染**：`src/{server,client}/types/message.ts` 从 claude SDK import `PermissionUpdate` 类型——替换运行时时需先移除该依赖。
5. **进程内 browser MCP 改造**（条件 3）是替换运行时的前置工作，与选型无关但未排期。

## 结论

Trial 的五个条件中四个实测通过、一个静态可解。无推翻性发现。**建议进入 `ce-brainstorm` 界定「可替换 agent 后端」抽象层的产品范围**（运行时选择开关、能力降级矩阵、企业部署形态），再 `ce-plan` 出实施计划。
