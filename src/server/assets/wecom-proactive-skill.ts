// Auto-generated from enqueue-wecom-proactive-message.md. Do not edit directly.
export const PROACTIVE_SKILL_MD = `---
name: send-wecom-proactive-msg
description: Send a proactive WeCom message to another user's session. Use when the user wants to send a message to someone else, notify another user, or proactively reach out via WeCom.
---

<objective>
Send proactive WeCom messages to another user's session using the \`wecom queue enqueue\` CLI command. The message will be delivered to the recipient's session history so they can reply in context.
</objective>

<quick_start>
Send a proactive message to another user:

\`\`\`bash
wecom queue enqueue --to-user USERID --message "Hello from the team"
\`\`\`

If \`wecom\` is not in PATH, use \`npx wecom\` or the full path from \`WECOM_CLI_PATH\`.
</quick_start>

<workflow>
1. **Extract recipient**: Identify the target user ID from the user's request
2. **Extract message**: Get the message content the user wants to send
3. **Run the send command**:
   \`\`\`bash
   wecom queue enqueue --to-user <USERID> --message "<MESSAGE>"
   \`\`\`
   If \`wecom\` is not available in PATH, try:
   - \`npx wecom queue enqueue ...\`
   - \`\${WECOM_CLI_PATH} queue enqueue ...\`
4. **Report result**: Show the command executed and confirm the message is queued for delivery to the recipient's session
</workflow>

<examples>
<example number="1">
<input>Send a message to ZhangSan saying the deployment is complete</input>
<output>
Sending proactive message to ZhangSan's session:

\`\`\`bash
wecom queue enqueue --to-user ZhangSan --message "The deployment is complete"
\`\`\`
</output>
</example>

<example number="2">
<input>Notify LiSi that the build failed</input>
<output>
Sending proactive notification to LiSi's session:

\`\`\`bash
wecom queue enqueue --to-user LiSi --message "Build failed — please check the logs"
\`\`\`
</output>
</example>

<example number="3">
<input>Tell WangWu to check the logs</input>
<output>
Sending proactive message to WangWu's session:

\`\`\`bash
wecom queue enqueue --to-user WangWu --message "Please check the logs"
\`\`\`
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
- \`0\`: Success — message queued for delivery
- \`1\`: Invalid arguments or context file error
- \`2\`: No WeCom bot context found
- \`3\`: HTTP request failed (e.g., recipient not resolved, recipient has no session)

Report the actual exit code and meaning to the user.
</pitfall>

<pitfall name="using_msg_send">
Never use \`wecom msg send\` for messages to another user. That command sends directly in the current conversation. Always use \`wecom queue enqueue\` when the recipient is someone other than the current conversation participant.
</pitfall>
</anti_patterns>

<success_criteria>
- Recipient is specified via \`--to-user\`
- Message is properly quoted for shell execution
- The actual CLI command is shown before or during execution
- Results (success or error) are reported clearly, including confirmation that the message is queued for delivery
- Only \`wecom queue enqueue\` is used for proactive sends
</success_criteria>
`;
