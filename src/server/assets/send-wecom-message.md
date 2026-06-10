---
name: send-wecom-message
description: Send WeCom messages via the wecom CLI and draft formatted messages with auto markdown detection. Use when the user wants to send a WeCom message, notify someone, or communicate via WeCom.
---

<objective>
Send WeCom messages using the `wecom` CLI command (`@webank/wecom`). Automatically detects structured content and uses markdown formatting when appropriate. Helps draft messages with formatting guidance before sending.
</objective>

<quick_start>
Send a simple message in the current conversation:

```bash
wecom msg send --to-user USERID --message "Hello from the team"
```

Send a markdown message:

```bash
wecom msg send --to-user USERID --message "**Bold** and \`code\`" --msg-type markdown
```

Queue a proactive message to another user (appears in their session history):

```bash
wecom queue enqueue --to-user USERID --message "Hello from the team"
```

If `wecom` is not in PATH, use `npx wecom` or the full path from `WECOM_CLI_PATH`.
</quick_start>

<workflow>
1. **Determine intent**: Is the user asking to send immediately or draft first?
2. **Determine recipient type**:
   - If the user names a recipient **other than themselves** (e.g. "send to ZhangSan", "notify LiSi", "tell WangWu to check the logs"), this is a **proactive send** → use `wecom queue enqueue`
   - If the user does not name a recipient, or names themselves, this is a **current-conversation send** → use `wecom msg send`
3. **Build the message**:
   - If the user provides a message, use it as-is
   - If drafting, help format the message and confirm before sending
4. **Detect markdown**: If the message contains any of these patterns, use `--msg-type markdown`:
   - `**bold**`, `*italic*`, `~~strikethrough~~`
   - `` `code` `` or ``` code blocks ```
   - `- list items` or `1. numbered lists`
   - `[links](url)`
   - `> quotes`
   - `# headings`
   - Tables with `|` separators
5. **Resolve recipient**: Use `--to-user` with the provided user ID
6. **Execute the command**:
   - Current conversation: `wecom msg send --to-user <USERID> --message "<MESSAGE>" [--msg-type markdown]`
   - Proactive send: `wecom queue enqueue --to-user <USERID> --message "<MESSAGE>"`
   
   If `wecom` is not available in PATH, try:
   - `npx wecom msg send ...` / `npx wecom queue enqueue ...`
   - `${WECOM_CLI_PATH} msg send ...` / `${WECOM_CLI_PATH} queue enqueue ...`
7. **Report result**: Show the command executed and the outcome
</workflow>

<examples>
<example number="1">
<input>Send a WeCom message to user "ZhangSan" saying "The deployment is complete"</input>
<output>
```bash
wecom queue enqueue --to-user ZhangSan --message "The deployment is complete"
```
</output>
</example>

<example number="2">
<input>Notify the team that build failed with error logs</input>
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
wecom msg send --to-user TEAM --message "**Build Failed**\n\nError:\n\`\`\`\nTypeError: Cannot read property 'id' of undefined\n    at processData (src/utils.ts:42)\n\`\`\`\n\nPlease check the logs." --msg-type markdown
```
</output>
</example>

<example number="3">
<input>wecom message to LiSi: here is the summary</input>
<output>
The message "here is the summary" is plain text. Sending:

```bash
wecom queue enqueue --to-user LiSi --message "here is the summary"
```
</output>
</example>

<example number="4">
<input>Send a greeting to everyone in this chat</input>
<output>
```bash
wecom msg send --to-user EVERYONE --message "Hello everyone!"
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

<proactive_send_initiate>
When the user asks you to send a message to someone **other than the current conversation participant**, use the proactive send queue so the message appears in the recipient's session history.

**How to recognize a proactive send:**
- Phrases like "send to ZhangSan", "notify LiSi", "tell WangWu to check the logs"
- Any request where the named recipient is different from the person you are currently talking to

**Action:**
1. Extract the recipient user ID and message content from the request
2. Run: `wecom queue enqueue --to-user RECIPIENT --message "MESSAGE"`
3. Report the queue entry ID returned by the CLI

**How to recognize a current-conversation send:**
- The user says "send a message" without naming a recipient
- The user names themselves as the recipient
- The context makes it clear the message is for the current chat

**Action for current-conversation sends:**
Use `wecom msg send` as normal.
</proactive_send_initiate>

<proactive_send>
When you receive a message starting with `[Proactive Send]`, this is a system directive to send a WeCom message on behalf of another user. Extract the recipient and message content, then send it using `wecom msg send` as normal. Do not ask clarifying questions — execute the send immediately.

Expected format:
```
[Proactive Send] Recipient: USERID
Original request: MESSAGE_CONTENT
```

Action:
1. Extract `USERID` after "Recipient: "
2. Extract `MESSAGE_CONTENT` after "Original request: "
3. Run: `wecom msg send --to-user USERID --message "MESSAGE_CONTENT"`
</proactive_send>

<success_criteria>
- Recipient is specified via `--to-user`
- Message is properly quoted for shell execution
- Markdown is auto-detected when appropriate
- The actual CLI command is shown before or during execution
- Results (success or error) are reported clearly
- Proactive sends to other users use `wecom queue enqueue`
- Current-conversation sends use `wecom msg send`
</success_criteria>
