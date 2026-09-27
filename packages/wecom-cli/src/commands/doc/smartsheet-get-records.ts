import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class SmartsheetGetRecords extends BaseDocCommand {
  static override description = 'Get records (rows) from a smartsheet';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: true }),
    'sheet-id': Flags.string({ description: 'Smartsheet ID', required: true }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SmartsheetGetRecords);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('smartsheet-get-records', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags.docid !== undefined) body.docid = flags.docid;
    if (flags['sheet-id'] !== undefined) body.sheet_id = flags['sheet-id'];
    await this.callDocTool('smartsheet-get-records', body);
  }
}
