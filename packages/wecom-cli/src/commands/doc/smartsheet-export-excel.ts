import { Flags } from '@oclif/core';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { BaseCommand } from '../base.js';
import { postForBinary } from '../../lib/http.js';

export default class SmartsheetExportExcel extends BaseCommand {
  static override description =
    'Export every smartsheet in a document to a single .xlsx workbook';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: true }),
    output: Flags.string({ description: 'Destination .xlsx file path', required: true }),
    force: Flags.boolean({ description: 'Overwrite the output file if it exists', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SmartsheetExportExcel);
    const context = this.loadContext();
    if (!context.workspaceId) {
      this.error(
        "This workspace's WeCom context file is missing workspaceId.\n" +
          'Please reconnect the WeCom bot for this workspace to update the context file.',
        { exit: 1 }
      );
    }

    const outputPath = path.resolve(process.cwd(), flags.output);
    const preExisted = existsSync(outputPath);

    if (preExisted && !flags.force) {
      if (process.stdout.isTTY && process.stdin.isTTY) {
        const confirmed = await promptConfirm(`Overwrite ${outputPath}? [y/N] `);
        if (!confirmed) {
          this.log('Aborted.');
          return;
        }
      } else {
        this.error(
          `Output file already exists: ${outputPath}. Pass --force to overwrite.`,
          { exit: 1 }
        );
      }
    }

    const endpointUrl = `${context.serverUrl}/api/workspaces/${context.workspaceId}/wecom/smartsheet-export`;

    try {
      const response = await postForBinary(endpointUrl, { docid: flags.docid });
      if (response.status !== 200) {
        let errorMessage: string;
        try {
          const parsed = JSON.parse(response.body.toString('utf-8')) as {
            error?: string;
            message?: string;
          };
          errorMessage = parsed.message || parsed.error || `HTTP ${response.status}`;
        } catch {
          errorMessage = `HTTP ${response.status}`;
        }
        this.error(`Failed: ${errorMessage}`, { exit: 3 });
      }

      await fs.writeFile(outputPath, response.body);
      this.log(outputPath);
    } catch (err) {
      // Never leave a partial file we created behind.
      if (!preExisted) {
        await fs.unlink(outputPath).catch(() => {});
      }
      const oclifErr = err as { oclif?: { exit?: number } };
      if (oclifErr && oclifErr.oclif) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.error(`Network error: ${message}`, { exit: 4 });
    }
  }
}

function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
