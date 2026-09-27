import { Command } from '@oclif/core';
import {
  CONTEXT_FILE_ENV,
  SESSION_TOKEN_ENV,
  readContextFile,
  resolveContextFilePath,
  resolveSessionToken,
  type ContextFile,
} from '../lib/context.js';

export abstract class BaseCommand extends Command {
  protected loadContext(): ContextFile {
    const contextFilePath = resolveContextFilePath();
    if (!contextFilePath) {
      this.error(
        `No WeCom bot context available: the ${CONTEXT_FILE_ENV} environment variable is not set.\n` +
          'The wecom CLI must run inside a Comate bot session (the session injects the context path).',
        { exit: 2 }
      );
    }

    try {
      return readContextFile(contextFilePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error(`Failed to read context file: ${message}`, { exit: 1 });
    }
  }

  /**
   * U12 (KTD-28): the session capability token, sent as a Bearer credential
   * on every loopback API call. Identity is derived server-side from the
   * token — never from a self-asserted sessionId.
   */
  protected authHeaders(): Record<string, string> {
    const token = resolveSessionToken();
    if (!token) {
      this.error(
        `Missing session capability token: the ${SESSION_TOKEN_ENV} environment variable is not set.\n` +
          'The wecom CLI must run inside a Comate bot session (the session injects the token).',
        { exit: 2 }
      );
    }
    return { Authorization: `Bearer ${token}` };
  }

  protected override async catch(err: Error & { exitCode?: number; oclif?: { exit?: number } }): Promise<unknown> {
    // Remap oclif validation errors (default exit 2) to exit 1
    // to avoid colliding with our "missing context/capability" exit code 2
    if (err.oclif?.exit === 2 && !err.message?.includes('context') && !err.message?.includes('capability token')) {
      err.oclif.exit = 1;
      if (err.exitCode === 2) {
        err.exitCode = 1;
      }
    }

    return super.catch(err);
  }
}
