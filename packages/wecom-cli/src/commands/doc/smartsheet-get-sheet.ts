import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class SmartsheetGetSheet extends BaseDocCommand {
  static override description = 'Get smartsheet metadata from a WeCom document';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: true }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SmartsheetGetSheet);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('smartsheet-get-sheet', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags.docid !== undefined) body.docid = flags.docid;
    await this.callDocTool('smartsheet-get-sheet', body);
  }
}
