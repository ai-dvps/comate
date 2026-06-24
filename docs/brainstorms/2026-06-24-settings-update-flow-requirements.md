---
date: 2026-06-24
topic: settings-update-flow
---

# Settings 与主窗口统一的更新安装流程

## Summary

将 Settings 面板的「Check for update」扩展为一条完整的更新小流程：检测到新版后在本区域显示版本信息、Download 按钮和下载进度条；下载完成后显示 Install / Restart now。主窗口的现有更新通知继续同步显示同一状态，用户可以在任意一个界面完成下载、安装和重启。

## Problem Frame

当前 Settings 面板只能触发更新检查并显示一段文字状态（checking / available / ready）。当检测到新版本时，用户必须回到主窗口才能看到 `Comate <version> is available` 通知并点击 Download。这造成两个断裂：

- 发起检查的界面不能完成后续操作；
- 设置页面关闭后，如果用户没注意到主窗口通知，整个更新流程就被中断了。

目标是让用户在发起检查的界面就能完成下载和安装，同时保留主窗口作为并行的操作入口。

## Key Decisions

- **单一状态源**：继续使用 `useUpdaterStore` 作为 Settings 和主窗口的共同状态源，两个界面读取同一个 `status`、`downloadProgress`、`update` 对象，天然保持同步。
- **双入口并行**：Settings 打开期间不抑制主窗口通知；用户可随时关闭 Settings，在主窗口继续完成下载/安装。
- **Settings 内联流程**：把下载按钮、进度条、重启按钮直接嵌入 Settings 面板的 updater 区域，而不是弹出新对话框或跳转。

## Requirements

- R1. Settings 面板的 updater 区域实时反映 `useUpdaterStore` 的 `status`（idle / checking / available / downloading / ready / error）。
- R2. 当 `status === 'available'` 时，Settings 面板显示新版本号、release body 摘要，并提供一个 Download 按钮。
- R3. 当 `status === 'downloading'` 时，Settings 面板显示进度条和百分比，百分比来自 `downloadProgress`。
- R4. 当 `status === 'ready'` 时，Settings 面板显示 Install / Restart now 按钮，并提供稍后处理的选项。
- R5. Settings 面板中的 Download / Restart 操作与主窗口通知使用同一组 API（`downloadAndInstallUpdate`、`restartToUpdate`）。
- R6. 主窗口的 `UpdateNotification` 和 `UpdateRestartDialog` 继续同步显示相同状态，并允许相同操作。
- R7. 关闭并重新打开 Settings 时，updater 区域应恢复当前状态，而不是重置为「Check for update」。
- R8. 在任一界面触发 Download / Restart 后，另一界面应立即进入对应状态；重复点击不得产生多个并行的下载或重启请求。

## Key Flows

- F1. **从 Settings 检查更新**
  - **Trigger:** 用户点击 Settings 中的 Check for update。
  - **Steps:** `status` 变为 `checking`；若存在新版则变为 `available`，否则回到 `idle` 并记录最后检查时间。
  - **Outcome:** Settings 和主窗口同时显示 `available` 状态。

- F2. **从 Settings 下载更新**
  - **Trigger:** 用户在 Settings 中点击 Download。
  - **Steps:** `status` 变为 `downloading`；`downloadProgress` 随 `Progress` 事件递增。
  - **Outcome:** Settings 的进度条与主窗口通知的进度条同步更新。

- F3. **从任一界面安装/重启**
  - **Trigger:** 下载完成（`status === 'ready'`）或用户点击 Restart now。
  - **Steps:** `status` 保持 `ready`，两个界面都展示重启入口。
  - **Outcome:** 用户从 Settings 或主窗口点击 Restart 都能触发 `restartToUpdate`。

- F4. **在任一界面忽略更新**
  - **Trigger:** 用户点击 Dismiss / Later。
  - **Steps:** 调用 `dismissUpdate()`，`status` 回到 `idle`。
  - **Outcome:** 两个界面的更新 UI 同时隐藏。

## Acceptance Examples

- AE1. **Settings 下载时主窗口同步**
  - **Covers:** R2, R3
  - **Given:** 已检测到新版本，Settings 显示 Download 按钮。
  - **When:** 用户点击 Download。
  - **Then:** Settings 显示进度条；主窗口通知也显示相同进度。

- AE2. **关闭 Settings 后可在主窗口继续**
  - **Covers:** R6, R8
  - **Given:** 下载正在进行中。
  - **When:** 用户关闭 Settings 面板。
  - **Then:** 主窗口继续显示下载进度，用户可在主窗口完成安装。

- AE3. **重新打开 Settings 保留 ready 状态**
  - **Covers:** R7
  - **Given:** 更新已下载完成，`status === 'ready'`。
  - **When:** 用户关闭并重新打开 Settings。
  - **Then:** Settings 直接显示 Restart now 按钮，无需再次点击 Check for update。

## Scope Boundaries

- **Deferred for later:** 在 Settings 中展示更丰富的 release notes（目前只使用 `update.body` 文本）。
- **Deferred for later:** 修改自动检查更新的频率或后台策略。
- **Deferred for later:** 静默自动下载/自动安装，无需用户确认。
- **Outside this product's identity:** 用另一种 UI 范式（例如模态弹窗或系统托盘菜单）替代主窗口更新通知。

## Dependencies / Assumptions

- `useUpdaterStore` 继续作为更新状态的唯一可信来源。
- `src/client/lib/updater-api.ts` 中的 `downloadAndInstallUpdate` 和 `restartToUpdate` 仍是所有界面的统一操作入口。
- Tauri updater 事件继续按现有约定发送 `Started`（含 `contentLength`）和 `Progress`（含 `chunkLength`）。

## Sources / Research

- 当前主窗口更新通知：`src/client/components/UpdateNotification.tsx`
- 当前重启确认弹窗：`src/client/components/UpdateRestartDialog.tsx`
- Settings 面板 updater 区域：`src/client/components/SettingsPanel.tsx`
- 共享更新状态：`src/client/stores/updater-store.ts`
- 更新 API 与事件处理：`src/client/lib/updater-api.ts`
