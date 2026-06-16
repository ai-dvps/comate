import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class SmartpageGetExportResult extends BaseDocCommand {
  static override description = 'Get the result of a smartpage export task';

  static override flags = {
    'task-id': Flags.string({ description: 'Export task ID', required: false }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SmartpageGetExportResult);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('smartpage-get-export-result', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags['task-id']) body.task_id = flags['task-id'];
    await this.callDocTool('smartpage-get-export-result', body);
  }
}
