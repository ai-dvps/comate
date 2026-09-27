---
date: 2026-06-26
topic: tauri-rust-file-logging
---

# Tauri/Rust 侧 stdout/stderr 持久化文件日志

## Summary

为 Tauri/Rust 进程补上持久化文件日志：去掉只在 Debug 生效的限制，让 Release 打包应用也落盘。日志写到应用数据目录的 `logs/`，通过已有的 `tauri-plugin-log` 增加文件 target，把 Rust 进程自身的诊断、sidecar 的 stderr 与生命周期事件一并记录。

## Problem Frame

Tauri/Rust 外壳早就用 `log::` 宏给关键操作打了点（sidecar 启停、托盘构建、端口发现、关闭流程），并且已经把 Node sidecar 的 stdout/stderr 接进了同一套 `log` 宏。也就是说，Rust 侧几乎所有重要事件在源码层面都"被记录"了。

问题在于：`tauri-plugin-log` 只在 Debug 构建下安装，且只配了控制台/webview 默认 target。在用户实际运行的 Release 打包版本里，这些 `log::` 调用全部是静默的——一行都落不下来。Windows 的 Release 构建甚至没有控制台（`windows_subsystem = "windows"`）。

后果是：当用户反馈 sidecar 启动失败、托盘没建出来、关闭卡住、端口没被发现等问题时，Rust 侧没有任何日志可查。Node 侧维护着自己的日志，但它无法记录发生在自己启动之前或之外的事件（例如 sidecar 根本没起来），也无法记录 Rust 外壳自身的问题。本次要做的是让这些已经打了点的事件在 Release 里真正落盘到一个文件中，并与 Node 日志放在一起。

## Key Decisions

- **复用 `tauri-plugin-log`，不另起 logger。** 它已是依赖、已（仅 Debug）安装，且 sidecar 的 stdout/stderr 早已流经 `log` 宏——给现有 logger 加一个文件 target，就能在一处捕获全部内容，新增代码极少。另起一个 logger（如 `fern`）或把 Rust 日志转发进 Node 侧，只会重复造基建，没有收益。
- **日志写到 app-data `logs/`，不写 repo 相对路径。** 打包后的桌面应用没有可预测的工作目录，repo 相对路径在生产里不可用。应用数据目录的 `logs/` 正是 Node 侧写日志的地方，Rust 日志落在同一处，既一致又便于排查时一并收集。
- **无条件安装（去掉 Debug 限制）。** 整个目的就是 Release 可见性；只在 Debug 安装的 logger 与目标相悖。
- **独立的 Rust 日志文件。** Rust 外壳与 Node sidecar 是不同的进程/层级，各自一个文件，避免两个进程的日志交错混杂。
- **sidecar stdout 回显保持 Debug-only。** Node 侧已经把 sidecar 自己的输出记进 `sidecar.log`，Release 里再回显 sidecar stdout 会与之重复。stderr 透传与生命周期事件保留——它们是 Rust 外壳视角的观测，在 sidecar 尚来不及自记日志就崩溃时尤其关键。

## Requirements

**捕获范围**

- R1. Rust 日志文件记录 Tauri/Rust 进程经 `log` 宏发出的自身诊断（sidecar spawn/kill 失败、托盘构建、端口发现、关闭异常等），以及 Rust 进程已观测到的 sidecar stderr 与生命周期事件（ready、带 code/signal 的 terminated）。
- R2. sidecar stdout 仅在 Debug 构建回显到日志；Release 不回显 sidecar stdout，避免与 Node 侧自己的 `sidecar.log` 重复。

**构建模式与位置**

- R3. logger 在 Debug 与 Release 构建中都安装——去掉当前的 debug-only 限制，使打包应用在磁盘上产出 Rust 日志文件。
- R4. Rust 日志文件写到应用数据目录的 `logs/` 文件夹（与 Node sidecar 写日志的同一文件夹），使用独立文件、与 Node 管理的日志分开，而非 repo 相对路径。
- R5. Debug 构建在文件之外保留控制台/webview target，本地开发仍能看到实时输出；Release 以文件为主要 target（在 Windows 上是唯一 target，因为 Release 构建没有控制台）。

**健壮性与边界**

- R6. 当日志目录无法创建或不可写时，logger 初始化不得中断应用启动——需优雅降级（例如跳过文件 target），而不是让启动失败。
- R7. 日志文件增长有界（基于大小和/或时间的轮转），使其不会在用户磁盘上无限增长；其意图对齐 Node 侧既有清理策略的尺度，具体阈值交由规划决定。

## Acceptance Examples

- AE1. **Release 日志可取。** 给定一个运行在用户机器上的打包 Release 构建，当应用运行且 sidecar 启动/停止/出错时，那么应用数据目录的 `logs/` 下存在一个 Rust 日志文件，内含生命周期事件与任何诊断；在 Windows（无控制台）上，这是看到这些信息的唯一途径。
  - **Covers R1, R2, R3, R4.**
- AE2. **优雅降级。** 给定启动时应用数据目录解析失败或日志目录创建失败，当 logger 初始化时，那么应用仍能正常启动（logger 跳过文件 target），而不是崩溃。
  - **Covers R6.**
- AE3. **Debug 保留控制台。** 给定一个 Debug 构建（`npm run tauri:dev`），当应用运行时，那么日志同时出现在控制台/webview 与文件中。
  - **Covers R5.**

## Scope Boundaries

- 把 Rust 日志转发到 UI，或与 Node 侧日志合并成应用内统一视图——本次只做文件落盘，聚合查看以后再说。
- 跨进程 tracing/关联（贯穿 Rust ↔ Node 的共享 trace ID）。
- 结构化/JSON 日志格式改造——沿用 `tauri-plugin-log` 默认格式。
- OS 级崩溃转储 / 原生崩溃上报——属于另一独立议题。
- 修改 Node 侧的日志写入或其清理策略。

## Dependencies / Assumptions

- 假设 `tauri-plugin-log` 自带的文件 target + 轮转能力已足够，无需引入独立 logger 库。
- 假设应用数据目录在运行时可写（所有支持平台的 `app_data_dir` 均满足）。
- 假设 Rust 文件的轮转由 `tauri-plugin-log` 自行负责，与 Node 侧 `log-cleanup.ts` 相互独立——两套清理机制无需协调，混用归属反而有重复删除风险。

## Sources / Research

- `src-tauri/src/lib.rs`（约 297-305 行）——当前仅 Debug 安装的 `tauri_plugin_log`，未配文件 target。
- `src-tauri/src/lib.rs`（约 427-466 行）——sidecar stdout/stderr 接入 `log::` 的路由；stdout 回显本身受 Debug 限制，stderr 无条件记录。
- `src-tauri/src/lib.rs`（约 385-410 行）——`app_data_dir()` 解析并以 `COMATE_DATA_DIR` 环境变量传给 sidecar。
- `src-tauri/src/main.rs`（第 2 行）——Release 的 `windows_subsystem = "windows"`。
- `src-tauri/Cargo.toml`——`log` 与 `tauri-plugin-log` 已是依赖。
- `src/server/utils/log-cleanup.ts`——Node 侧 `getLogsDir()` 与 7 天 / 100MB 清理策略。
- `src/server/storage/data-dir.ts`——`getStorageDir()` = `$COMATE_DATA_DIR ?? ~/.comate`。

> 一份含逐字引用与 `file:line` 指针的 grounding dossier 已在头脑风暴期间整理，可供 `ce-plan` 参考（临时路径：`/tmp/compound-engineering/ce-brainstorm/rust-logs/grounding.md`）；所有可核查声明均已通过独立验证确认。
