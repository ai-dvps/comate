---
name: send-wecom-msg
description: Send a WeCom message to a user via the wecom CLI. Use when the user wants to send a WeCom message, notify someone, or communicate via WeCom.
---

<objective>
Send WeCom messages to any user using the `wecom send` CLI command (`@webank/wecom`). Automatically detects structured content and uses markdown formatting when appropriate. Helps draft messages with formatting guidance before sending.
</objective>

<quick_start>
Send a message to a user:

```bash
wecom send --to-user USERID --message "Hello from the team" --session-id ${CLAUDE_SESSION_ID}
```

Send a markdown message:

```bash
wecom send --to-user USERID --message "**Bold** and `code`" --msg-type markdown --session-id ${CLAUDE_SESSION_ID}
```

If `wecom` is not in PATH, use `npx wecom` or the full path from `WECOM_CLI_PATH`.
</quick_start>

<workflow>
1. **Verify CLI version**: Before any send operation, check the installed CLI version:
   ```bash
   wecom --version
   ```
   Expected: `1.2.0` or higher. If the version is lower, advise the user to update:
   ```bash
   npm install -g @webank/wecom@latest
   ```
   If `wecom` is not found, check `npx wecom --version` or `${WECOM_CLI_PATH} --version`.
   If the CLI is not installed at all, advise the user to install it:
   ```bash
   npm install -g @webank/wecom
   ```
2. **Determine intent**: Is the user asking to send immediately or draft first?
3. **Extract recipient**: Identify the target user ID from the user's request
4. **Build the message**:
   - If the user provides a message, use it as-is
   - If drafting, help format the message and confirm before sending
5. **Detect markdown**: If the message contains any of these patterns, use `--msg-type markdown`:
   - `**bold**`, `*italic*`, `~~strikethrough~~`
   - `` `code` `` or ``` code blocks ```
   - `- list items` or `1. numbered lists`
   - `[links](url)`
   - `> quotes`
   - `# headings`
   - Tables with `|` separators
6. **Get session ID**: Use `${CLAUDE_SESSION_ID}` for the current session
7. **Execute the command**:
   ```bash
   wecom send --to-user <USERID> --message "<MESSAGE>" [--msg-type markdown] --session-id ${CLAUDE_SESSION_ID}
   ```
   If `wecom` is not available in PATH, try:
   - `npx wecom send ...`
   - `${WECOM_CLI_PATH} send ...`
8. **Report result**: Show the command executed and the outcome
</workflow>

<examples>
<example number="1">
<input>Send a message to ZhangSan saying the deployment is complete</input>
<output>
```bash
wecom send --to-user ZhangSan --message "The deployment is complete" --session-id ${CLAUDE_SESSION_ID}
```
</output>
</example>

<example number="2">
<input>Notify LiSi that the build failed with error logs</input>
<output>
Draft message (auto-detected markdown):

```
**Build Failed**

Error:
```
TypeError: Cannot read property 'id' of undefined
    at processData (src/utils.ts:42)
```

Please check the logs.
```

Send with:
```bash
wecom send --to-user LiSi --message "**Build Failed**\n\nError:\n\`\`\`\nTypeError: Cannot read property 'id' of undefined\n    at processData (src/utils.ts:42)\n\`\`\`\n\nPlease check the logs." --msg-type markdown --session-id ${CLAUDE_SESSION_ID}
```
</output>
</example>

<example number="3">
<input>Send a greeting to WangWu</input>
<output>
```bash
wecom send --to-user WangWu --message "Hello WangWu!" --session-id ${CLAUDE_SESSION_ID}
```
</output>
</example>
</examples>

<anti_patterns>
<pitfall name="guessing_recipient">
Never guess a user ID. If the recipient is unclear, ask: "Who should receive this message? Provide the WeCom user ID."
</pitfall>

<pitfall name="missing_quotes">
Always wrap the message in double quotes. Unquoted messages break when the shell interprets special characters.
</pitfall>

<pitfall name="ignoring_exit_code">
The wecom CLI returns specific exit codes:
- `0`: Success
- `1`: Invalid arguments or context file error
- `2`: No WeCom bot context found
- `3`: HTTP request failed

Report the actual exit code and meaning to the user.
</pitfall>
</anti_patterns>

<success_criteria>
- Recipient is specified via `--to-user`
- Message is properly quoted for shell execution
- Markdown is auto-detected when appropriate
- Session ID is passed via `--session-id`
- The actual CLI command is shown before or during execution
- Results (success or error) are reported clearly
</success_criteria>
