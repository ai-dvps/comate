import { Command } from '@oclif/core';
import { findContextFile, readContextFile, type ContextFile } from '../lib/context.js';

export abstract class BaseCommand extends Command {
  protected loadContext(): ContextFile {
    const contextFilePath = findContextFile(process.cwd());
    if (!contextFilePath) {
      this.error(
        `No WeCom bot context file found. Searched upward from ${process.cwd()} for .claude/wecom-context.json.\nMake sure a WeCom bot is enabled for this workspace.`,
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

  protected override async catch(err: Error & { exitCode?: number; oclif?: { exit?: number } }): Promise<any> {
    // Remap oclif validation errors (default exit 2) to exit 1
    // to avoid colliding with our "no context file" exit code 2
    if (err.oclif?.exit === 2 && !err.message?.includes('context file')) {
      err.oclif.exit = 1;
      if (err.exitCode === 2) {
        err.exitCode = 1;
      }
    }

    return super.catch(err);
  }
}
