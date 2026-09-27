import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class SmartsheetGetFields extends BaseDocCommand {
  static override description = 'Get fields (columns) of a smartsheet';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: true }),
    'sheet-id': Flags.string({ description: 'Smartsheet ID', required: true }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SmartsheetGetFields);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('smartsheet-get-fields', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags.docid !== undefined) body.docid = flags.docid;
    if (flags['sheet-id'] !== undefined) body.sheet_id = flags['sheet-id'];
    await this.callDocTool('smartsheet-get-fields', body);
  }
}
