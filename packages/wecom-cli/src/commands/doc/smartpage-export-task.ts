import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class SmartpageExportTask extends BaseDocCommand {
  static override description = 'Export a smartpage document';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: false }),
    'sheet-id': Flags.string({ description: 'Sheet ID for smartsheet export', required: false }),
    format: Flags.string({ description: 'Export format', default: 'pdf', required: false }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SmartpageExportTask);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('smartpage-export-task', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags.docid) body.docid = flags.docid;
    if (flags['sheet-id']) body.sheet_id = flags['sheet-id'];
    if (flags.format !== undefined) body.format = flags.format;
    await this.callDocTool('smartpage-export-task', body);
  }
}
