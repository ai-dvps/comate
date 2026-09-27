import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class GetDocContent extends BaseDocCommand {
  static override description = 'Get WeCom document content';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: false }),
    url: Flags.string({ description: 'Document URL (alternative to docid)', required: false }),
    type: Flags.integer({ description: 'Document type (1=document, 2=smartpage)', default: 2 }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(GetDocContent);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('get-doc-content', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags.docid) body.docid = flags.docid;
    if (flags.url) body.url = flags.url;
    if (flags.type !== undefined) body.type = flags.type;
    await this.callDocTool('get-doc-content', body);
  }
}
