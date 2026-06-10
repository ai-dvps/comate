#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { URL } from 'node:url';

const CONTEXT_FILE_NAME = '.claude/wecom-context.json';

function printUsage(): void {
  console.error('Usage:');
  console.error('  wecom msg send --to-user <id> --message <text> [--msg-type text|markdown]');
  console.error('  wecom queue enqueue --to-user <id> --message <text>');
}

function findContextFile(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const filePath = path.join(current, CONTEXT_FILE_NAME);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

interface ContextFile {
  workspaceId?: string;
  botId: string;
  serverUrl: string;
}

function readContextFile(filePath: string): ContextFile {
  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content) as unknown;
  if (
    typeof data !== 'object' ||
    data === null ||
    !('botId' in data) ||
    !('serverUrl' in data) ||
    typeof (data as Record<string, unknown>).botId !== 'string' ||
    typeof (data as Record<string, unknown>).serverUrl !== 'string'
  ) {
    throw new Error('Invalid context file format: missing botId or serverUrl');
  }
  return data as ContextFile;
}

function postJson(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const bodyString = JSON.stringify(body);
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyString),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: responseBody });
        });
      }
    );
    req.on('error', (err) => {
      reject(err);
    });
    req.write(bodyString);
    req.end();
  });
}

async function runMsgSend(args: string[]): Promise<number> {
  let toUser: string | null = null;
  let message: string | null = null;
  let msgType: 'text' | 'markdown' = 'text';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--to-user' && i + 1 < args.length) {
      toUser = args[++i];
    } else if (arg === '--message' && i + 1 < args.length) {
      message = args[++i];
    } else if (arg === '--msg-type' && i + 1 < args.length) {
      const type = args[++i];
      if (type !== 'text' && type !== 'markdown') {
        console.error(`Invalid msgType: ${type}. Must be "text" or "markdown".`);
        return 1;
      }
      msgType = type;
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      return 1;
    }
  }

  if (!toUser || !message) {
    console.error('--to-user and --message are required');
    printUsage();
    return 1;
  }

  const contextFilePath = findContextFile(process.cwd());
  if (!contextFilePath) {
    console.error(
      `No WeCom bot context file found. Searched upward from ${process.cwd()} for ${CONTEXT_FILE_NAME}.`
    );
    console.error('Make sure a WeCom bot is enabled for this workspace.');
    return 2;
  }

  let context: ContextFile;
  try {
    context = readContextFile(contextFilePath);
  } catch (err) {
    console.error('Failed to read context file:', err instanceof Error ? err.message : String(err));
    return 1;
  }

  const endpointUrl = `${context.serverUrl}/api/wecom/send`;

  try {
    const response = await postJson(endpointUrl, {
      botId: context.botId,
      toUser,
      message,
      msgType,
    });

    if (response.status === 200) {
      return 0;
    }

    let errorMessage: string;
    try {
      const parsed = JSON.parse(response.body) as { error?: string };
      errorMessage = parsed.error || `HTTP ${response.status}`;
    } catch {
      errorMessage = `HTTP ${response.status}: ${response.body}`;
    }

    console.error(`Failed to send message: ${errorMessage}`);
    return 3;
  } catch (err) {
    console.error(
      'Failed to send message:',
      err instanceof Error ? err.message : String(err)
    );
    return 3;
  }
}

async function runQueueEnqueue(args: string[]): Promise<number> {
  let toUser: string | null = null;
  let message: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--to-user' && i + 1 < args.length) {
      toUser = args[++i];
    } else if (arg === '--message' && i + 1 < args.length) {
      message = args[++i];
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      return 1;
    }
  }

  if (!toUser || !message) {
    console.error('--to-user and --message are required');
    printUsage();
    return 1;
  }

  const contextFilePath = findContextFile(process.cwd());
  if (!contextFilePath) {
    console.error(
      `No WeCom bot context file found. Searched upward from ${process.cwd()} for ${CONTEXT_FILE_NAME}.`
    );
    console.error('Make sure a WeCom bot is enabled for this workspace.');
    return 2;
  }

  let context: ContextFile;
  try {
    context = readContextFile(contextFilePath);
  } catch (err) {
    console.error('Failed to read context file:', err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!context.workspaceId) {
    console.error('This workspace\'s WeCom context file is missing workspaceId.');
    console.error('Please reconnect the WeCom bot for this workspace to update the context file.');
    return 1;
  }

  const endpointUrl = `${context.serverUrl}/api/workspaces/${context.workspaceId}/wecom-queue`;

  try {
    const response = await postJson(endpointUrl, { toUser, message });

    if (response.status === 202) {
      try {
        const parsed = JSON.parse(response.body) as { id?: string; status?: string };
        if (parsed.id) {
          console.log(`Queued proactive message (id=${parsed.id}, status=${parsed.status || 'pending'})`);
        }
      } catch {
        // Ignore parse error; success is already confirmed by status code
      }
      return 0;
    }

    if (response.status === 400) {
      try {
        const parsed = JSON.parse(response.body) as { error?: string; message?: string };
        const code = parsed.error;
        if (code === 'recipient_not_resolved') {
          console.error(`Failed to enqueue: recipient user ID has not been decrypted yet. The recipient must send at least one message to the bot first.`);
          return 3;
        }
        if (code === 'recipient_no_session') {
          console.error(`Failed to enqueue: recipient has no active session in this workspace.`);
          return 3;
        }
        console.error(`Failed to enqueue: ${parsed.message || code || 'Bad request'}`);
        return 3;
      } catch {
        console.error(`Failed to enqueue: HTTP 400: ${response.body}`);
        return 3;
      }
    }

    let errorMessage: string;
    try {
      const parsed = JSON.parse(response.body) as { error?: string; message?: string };
      errorMessage = parsed.message || parsed.error || `HTTP ${response.status}`;
    } catch {
      errorMessage = `HTTP ${response.status}: ${response.body}`;
    }

    console.error(`Failed to enqueue: ${errorMessage}`);
    return 3;
  } catch (err) {
    console.error(
      'Failed to enqueue:',
      err instanceof Error ? err.message : String(err)
    );
    return 3;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    printUsage();
    return 1;
  }

  const command = args[0];
  const subcommand = args[1];
  const remainingArgs = args.slice(2);

  if (command === 'msg' && subcommand === 'send') {
    return runMsgSend(remainingArgs);
  }

  if (command === 'queue' && subcommand === 'enqueue') {
    return runQueueEnqueue(remainingArgs);
  }

  console.error(`Unknown command: ${command} ${subcommand}`);
  printUsage();
  return 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
