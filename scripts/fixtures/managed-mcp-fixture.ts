import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFile } from 'node:fs/promises';

const server = new McpServer({ name: 'managed-mcp-fixture', version: '1.0.0' });
server.registerTool('echo', {
  description: 'Echo a message after an optional delay',
  inputSchema: { message: z.string(), delay: z.number().optional(), link: z.boolean().optional() },
}, async ({ message, delay, link }) => {
  const trace = async (stage: string) => {
    if (process.env.MCP_FIXTURE_TRACE) await appendFile(process.env.MCP_FIXTURE_TRACE,
      JSON.stringify({ stage, message, version: process.env.MCP_FIXTURE_VERSION }) + '\n');
  };
  await trace('start');
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  await trace('done');
  return { content: [{ type: 'text' as const, text: message }, ...(link ? [{ type: 'resource_link' as const, uri: 'fixture://example', name: 'example' }] : [])], structuredContent: {
    message, configured: Boolean(process.env.MCP_FIXTURE_SECRET), argv: process.argv.slice(2),
  } };
});
server.registerPrompt('greet', { argsSchema: { name: z.string() } }, ({ name }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name}` } }],
}));
server.registerResource('example', 'fixture://example', { description: process.env.MCP_FIXTURE_SECRET }, async uri => ({
  contents: [{ uri: uri.href, text: 'fixture resource' }],
}));
await server.connect(new StdioServerTransport());
