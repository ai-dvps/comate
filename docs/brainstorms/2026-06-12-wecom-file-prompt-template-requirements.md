---
title: "feat: Configurable File Prompt Template for WeCom Bot"
type: feat
status: active
date: 2026-06-12
---

## Problem

When a WeCom user sends a file, image, or video, the bot pushes a hardcoded prompt to the Claude Code session. Teams may want different prompt wording — for example, routing files to a specific skill, adding context about expected processing, or changing the language. Today, changing the prompt requires editing source code.

## Solution

Add a configurable **file prompt template** field to the WeCom bot settings page. The template supports a `$file_name$` placeholder that is replaced with the actual saved file path (e.g. `ZhangWei/report.pdf`) at runtime.

## UI Structure

The current flat WeCom bot settings are reorganized into a **secondary tab bar** with three tabs:

| Tab | Contents |
|-----|----------|
| **Connection** | Enable toggle, bot name, bot ID, bot secret, corp ID, corp secret, connection status indicator |
| **Users** | WeCom users list with encrypted/pending status |
| **Prompts** | File prompt template textarea (new) |

This restructure is driven by growing configuration — credentials, user management, and prompt customization serve different audiences and change at different cadences.

## Requirements

- **R1.** A `wecomFilePromptTemplate` field is added to workspace settings (model, storage, and API).
- **R2.** The WeCom bot settings UI is reorganized into a secondary tab bar: Connection, Users, Prompts.
- **R3.** The Prompts tab contains a textarea labeled "File prompt template" for the `wecomFilePromptTemplate` field.
- **R4.** `$file_name$` in the template is replaced with the relative file path of the saved media file at prompt construction time.
- **R5.** When the template is empty or unset, the current hardcoded prompt is used as default — existing installations are unaffected.
- **R6.** This template applies only to file, image, and video messages. Voice messages use a separate hardcoded prompt and are not affected.

## Scope Boundaries

### In scope
- Secondary tab bar restructure of WeCom bot settings (Connection / Users / Prompts)
- File/image/video prompt template with `$file_name$` variable on the Prompts tab
- Default fallback to current behavior
- Both en and zh-CN translations for new UI elements

### Deferred for later
- Additional template variables (e.g. `$user_name$`, `$content$`)
- Voice message prompt template
- Per-user or per-message-type template overrides

### Outside scope
- Changes to the streaming reply or file storage behavior
- Changes to voice message handling

## Acceptance Examples

- **AE1.** A workspace admin sets the template to `"Please summarize the file $file_name$"`. When a user sends `report.pdf`, the bot pushes `"Please summarize the file ZhangWei/report.pdf"` to the Claude session.
- **AE2.** A workspace has no template configured. A user sends an image. The bot pushes the current default prompt — behavior is identical to before this feature.
- **AE3.** A workspace admin sets the template to `"Process file: $file_name$"`. A user sends a voice message. The voice prompt is unaffected — it still uses the hardcoded transcription-based template.
