import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class SmartsheetAddSheet extends BaseDocCommand {
  static override description = 'Add a smartsheet to a WeCom document';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: true }),
    title: Flags.string({ description: 'Smartsheet title', required: false }),
    index: Flags.integer({ description: 'Insertion position index', required: false }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SmartsheetAddSheet);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('smartsheet-add-sheet', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags.docid !== undefined) body.docid = flags.docid;
    if (flags.title !== undefined) body.title = flags.title;
    if (flags.index !== undefined) body.index = flags.index;
    await this.callDocTool('smartsheet-add-sheet', body);
  }
}
