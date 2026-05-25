# Comate

Your friendly AI workspace companion.

<!-- BADGES -->

<!-- SCREENSHOT PLACEHOLDER -->

## Overview

Comate is a desktop AI workspace that brings Claude Code into a polished, native app experience. Organize multiple projects in folder-backed workspaces, chat with AI through streaming sessions, explore files, and manage tasks — all in one place.

## Features

**Workspaces & Projects**
- Folder-backed workspaces — each workspace remembers its own settings, sessions, and configuration
- Chrome-style tabbed navigation for switching between workspaces
- Per-workspace settings for model selection, API keys, skills, MCP servers, and hooks
- Git status awareness in the status bar

**Chat & Sessions**
- Multiple chat sessions per workspace with real-time streaming responses
- Persistent sessions that survive workspace switches and reconnections
- Rich message rendering with Markdown, syntax-highlighted code blocks, and collapsible reasoning
- Tool call display with input arguments and output
- Subagent visibility with live status indicators

**File Explorer**
- Browse workspace folder structure with file type icons
- File preview drawer with syntax highlighting
- Pin files to a side panel for reference while chatting
- Fast file picker powered by ripgrep

**Interactive Surfaces**
- Tool permission approvals with Allow / Allow always / Deny options
- Multi-question stepper for clarifying questions
- Preview panes for side-by-side option comparison

**Prompt Input & Discovery**
- Auto-expanding textarea with configurable font size
- Slash command discovery — type `/` to browse all available commands
- File path autocomplete with `@` references
- Keyboard shortcuts for common actions

**Desktop Experience**
- Native macOS and Windows app via Tauri v2
- System tray / background mode — close to tray, keep sessions alive
- Dark and light themes with OS preference detection
- English and Simplified Chinese (zh-CN) localization

**Task Tracking**
- Real-time task/todo panel extracted from agent tool calls
- Live task status as the model works through multi-step requests

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
- An [Anthropic API key](https://console.anthropic.com/) for AI features

## Contributing

See [development.md](development.md) for setup instructions and contribution guidelines.

## License

No license is currently declared for this project.
