import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class SmartsheetUpdateSheet extends BaseDocCommand {
  static override description = 'Update a smartsheet in a WeCom document';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: true }),
    'sheet-id': Flags.string({ description: 'Smartsheet ID', required: true }),
    title: Flags.string({ description: 'New smartsheet title', required: false }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SmartsheetUpdateSheet);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('smartsheet-update-sheet', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags.docid !== undefined) body.docid = flags.docid;
    if (flags['sheet-id'] !== undefined) body.sheet_id = flags['sheet-id'];
    if (flags.title !== undefined) body.title = flags.title;
    await this.callDocTool('smartsheet-update-sheet', body);
  }
}
