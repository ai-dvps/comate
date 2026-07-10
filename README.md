# Comate

Your friendly AI workspace companion.

<!-- BADGES -->

<!-- SCREENSHOT PLACEHOLDER -->

## Overview

Comate is a desktop AI workspace that brings Claude Code into a polished, native app experience. Organize multiple projects in folder-backed workspaces, chat with AI through streaming sessions, explore files, and manage tasks — all in one place.

## Features

**Workspaces & Projects**
- Folder-backed workspaces — every project keeps its own settings, sessions, skills, MCP servers, and hooks
- Chrome-style tabbed navigation with scrollable tabs and a quick-switcher dropdown
- Workspace status indicators on tabs and session rows (streaming, needs-me, unread)
- Git branch and workspace-path awareness in the status bar
- Workspace-scoped todos with status tracking and one-click "chat about this todo"

**Chat & Sessions**
- Multiple persistent chat sessions per workspace with real-time streaming responses
- Sessions survive workspace switches, reconnections, and app restarts
- Session list search, activity sort, archive filter, and Work-in-Progress tags
- Message timestamps, in-session chat search, and session fork
- Rich message rendering with Markdown, syntax-highlighted code blocks, collapsible tool calls, and reasoning blocks

**AI Collaboration Surfaces**
- Tool permission approvals with Allow / Allow always / Deny / Ask options
- Multi-question stepper for clarifying questions with preview panes
- Live subagent status cards and a dedicated subagent drawer
- Async/background subagent lifecycle display
- Workflow status cards, floating panel, and per-subagent detail view

**Files & Context**
- Browse the workspace folder tree and preview files with syntax highlighting
- Workspace-wide file search powered by ripgrep with on-demand indexing
- Persistent, resizable file panel with multiple file tabs and markdown preview
- Pin files to the side panel for reference while chatting
- `@` file references in the prompt input with fuzzy autocomplete
- Clickable, workspace-relative file paths in tool inputs

**Prompt Input & Discovery**
- Auto-expanding multi-line textarea with configurable chat/UI font sizes
- Slash-command / skill discovery triggered by `/` or the Skills button
- Prompt history recall with fuzzy search
- Configurable submit shortcut (Enter vs Ctrl/Cmd+Enter) with IME composition guard

**Bot Integrations (WeCom & Feishu)**
- Connect workspaces to WeChat Work (WeCom) and Feishu (Lark) bots
- Every bot user gets their own persistent Claude session
- Bot sessions shown as read-only history viewers in the GUI
- Dedicated Bot Management page with role-based access (Owner/Admin/Normal)
- Per-channel ownership, member management, and audit logging
- Interactive template-card approvals and AskUserQuestion prompts
- Bot commands: `/status`, `/stop`, `/new`, `/clear`, `/resume`
- Proactive file and message sending via HTTP bridge and `wecom` CLI

**Skills, MCP & Plugins**
- Built-in plugin marketplace and Plugin Manager
- Install, update, enable, and disable Claude Code plugins across user/project/local scopes
- MCP server configuration per workspace
- Skills page for discovering and installing SKILL.md bundles
- WeCom CLI integration for document, smartsheet, and message automation

**Task & Workflow Tracking**
- Real-time task/todo panel extracted from agent `TaskCreate`/`TaskUpdate` calls
- Floating TaskPanel and Workflow panel anchored to the chat area
- Live task status as the model works through multi-step requests

**Desktop Experience**
- Native macOS and Windows app built with Tauri v2
- macOS title-bar overlay with draggable regions
- System tray / background mode — close to tray, keep sessions alive
- Auto-updater checks GitHub Releases and installs in the background
- Dark and light themes with system-preference detection
- English and Simplified Chinese (zh-CN) localization
- Notification sounds for pending approvals/questions and completed turns

**Security & Control**
- Per-workspace API keys and provider settings
- Bot user isolation with file-path, transcript, Bash, and skill restrictions
- Configurable tool-permission presets and Bash allowlists
- Sanitized audit logs for credential changes, member changes, and file denials

## Installation

Download the latest release for your platform:

- **macOS** — `.dmg` installer
- **Windows** — `.msi` installer

> **Note:** Prebuilt releases will be available once the repository is set up for distribution. For now, build from source (see [development.md](development.md)).

## Quick Start

1. **Create a workspace** — Click "New Workspace" and select a local folder
2. **Start a session** — Click "New Session" in the sidebar
3. **Send a message** — Type your request in the prompt input and press `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows)
4. **Approve tool calls** — When Claude requests tool access, review and allow

## System Requirements

- **macOS** 13.0 or later (Ventura+)
- **Windows** 10 or later

## Contributing

See [development.md](development.md) for setup instructions and contribution guidelines.

## License

[Apache License 2.0](LICENSE)
