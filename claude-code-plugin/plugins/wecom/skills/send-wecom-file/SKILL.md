---
name: send-wecom-file
description: Send a workspace file to a WeCom user via the wecom CLI. Use when the user wants to send a file, attachment, or document via WeCom.
---

<objective>
Send workspace files to any WeCom user using the `wecom send-file` CLI command (`@webank/wecom`). The skill resolves the target file by searching the workspace, confirms the operation with the user, and sends the file.
</objective>

<quick_start>
Send a file to a specific user:

```bash
wecom send-file --to-user USERID --file-path path/inside/workspace/file.pdf --session-id ${CLAUDE_SESSION_ID}
```

Send a file to yourself (requires `WECOM_USER_ID`):

```bash
wecom send-file --to-user ${WECOM_USER_ID} --file-path path/inside/workspace/file.pdf --session-id ${CLAUDE_SESSION_ID}
```

If `wecom` is not in PATH, use `npx wecom` or the full path from `WECOM_CLI_PATH`.
</quick_start>

<workflow>
1. **Verify CLI version**: Before any send operation, check the installed CLI version:
   ```bash
   wecom --version
   ```
   Expected: `0.3.0` or higher. If the version is lower, advise the user to update:
   ```bash
   npm install -g @webank/wecom@latest
   ```
   If `wecom` is not found, check `npx wecom --version` or `${WECOM_CLI_PATH} --version`.
   If the CLI is not installed at all, advise the user to install it:
   ```bash
   npm install -g @webank/wecom
   ```
2. **Extract intent**: Parse the user's request for:
   - The file name or path they want to send
   - The recipient: `to me` or `to <USERID>`
3. **Resolve recipient**:
   - If the user says `to me`, use the `${WECOM_USER_ID}` environment variable.
   - If `WECOM_USER_ID` is not set, ask the user: "What is your WeCom user ID?"
   - If the user specifies a user ID directly, use it as-is.
   - Never guess a user ID.
4. **Find the file**: Search the workspace recursively for the requested file name:
   ```bash
   find . -type f -name "<file-name>" -not -path "*/node_modules/*" -not -path "*/.git/*"
   ```
   Prefer matches that are closest to the current working directory. If only one match is found, use it. If multiple matches are found, list them and ask the user to choose.
5. **Confirm before sending**: Show the user:
   - The resolved file path
   - The recipient user ID
   - Ask for confirmation: "Send `<file>` to `<user>`?"
   - If the user declines, stop and report that no file was sent.
6. **Execute the command**:
   ```bash
   wecom send-file --to-user <USERID> --file-path "<WORKSPACE_RELATIVE_PATH>" --session-id ${CLAUDE_SESSION_ID}
   ```
   The `--file-path` value must be relative to the workspace root (the directory containing `.claude/wecom-context.json`).
   If `wecom` is not available in PATH, try:
   - `npx wecom send-file ...`
   - `${WECOM_CLI_PATH} send-file ...`
7. **Report result**: Show the command executed and the outcome. Handle CLI exit codes:
   - `0`: Success
   - `1`: Invalid arguments or context file error
   - `2`: No WeCom bot context found
   - `3`: HTTP request failed
</workflow>

<examples>
<example number="1">
<input>Send report.pdf to me</input>
<output>
Resolved file: `./docs/report.pdf`
Recipient: ${WECOM_USER_ID}

Send `./docs/report.pdf` to your WeCom account?
</output>
</example>

<example number="2">
<input>Send report.pdf to ZhangSan</input>
<output>
Resolved file: `./docs/report.pdf`
Recipient: ZhangSan

Send `./docs/report.pdf` to ZhangSan?
</output>
</example>

<example number="3">
<input>Send report.pdf to ZhangSan</input>
<output>
Multiple files matched "report.pdf":
1. `./docs/report.pdf`
2. `./archive/2025/report.pdf`

Which file should be sent?
</output>
</example>

<example number="4">
<output>
```bash
wecom send-file --to-user ZhangSan --file-path "./docs/report.pdf" --session-id ${CLAUDE_SESSION_ID}
```
File sent.
</output>
</example>
</examples>

<anti_patterns>
<pitfall name="guessing_recipient">
Never guess a user ID. If the recipient is unclear or `WECOM_USER_ID` is not set, ask: "Who should receive this file? Provide the WeCom user ID."
</pitfall>

<pitfall name="absolute_paths">
`--file-path` must be relative to the workspace root, not an absolute path. Resolve the file path relative to the directory containing `.claude/wecom-context.json`.
</pitfall>

<pitfall name="skipping_confirmation">
Always confirm the file path and recipient before executing `wecom send-file`. Do not send files silently.
</pitfall>

<pitfall name="missing_quotes">
Always wrap the file path in double quotes. Paths with spaces or special characters will break the shell command otherwise.
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
- CLI version is verified to be `0.3.0` or higher
- Recipient is resolved via explicit user ID or `${WECOM_USER_ID}`
- File is found via workspace-wide recursive search
- Ambiguous matches are presented to the user for selection
- User confirms the file and recipient before sending
- File path passed to the CLI is relative to the workspace root and properly quoted
- Session ID is passed via `--session-id`
- The actual CLI command is shown before or during execution
- Results (success or error) are reported clearly
</success_criteria>
