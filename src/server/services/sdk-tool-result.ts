export function readSdkToolResult(message: { tool_use_result?: unknown; toolUseResult?: unknown }): unknown {
  return message.tool_use_result !== undefined ? message.tool_use_result : message.toolUseResult;
}
