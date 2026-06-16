import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class SmartsheetAddRecordsAutoFile extends BaseDocCommand {
  static override description = 'Add records with automatic file upload (image_path/file_path fields are resolved server-side)';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: true }),
    'sheet-id': Flags.string({ description: 'Smartsheet ID', required: true }),
    data: Flags.string({ description: 'Raw JSON request body with records containing image_path/file_path fields', required: true }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SmartsheetAddRecordsAutoFile);
    const body = JSON.parse(flags.data) as Record<string, unknown>;
    if (flags.docid !== undefined) body.docid = flags.docid;
    if (flags['sheet-id'] !== undefined) body.sheet_id = flags['sheet-id'];
    await this.callDocTool('smartsheet-add-records-auto-file', body);
  }
}
