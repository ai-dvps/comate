import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'managed-mcp-fixture', version: '1.0.0' });
server.registerTool('echo', {
  description: 'Echo a message after an optional delay',
  inputSchema: { message: z.string(), delay: z.number().optional() },
}, async ({ message, delay }) => {
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  return { content: [{ type: 'text', text: message }], structuredContent: {
    message, configured: Boolean(process.env.MCP_FIXTURE_SECRET), argv: process.argv.slice(2),
  } };
});
server.registerPrompt('greet', { argsSchema: { name: z.string() } }, ({ name }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name}` } }],
}));
server.registerResource('example', 'fixture://example', {}, async uri => ({
  contents: [{ uri: uri.href, text: 'fixture resource' }],
}));
await server.connect(new StdioServerTransport());
