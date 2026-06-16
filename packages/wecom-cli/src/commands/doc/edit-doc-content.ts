import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class EditDocContent extends BaseDocCommand {
  static override description = 'Edit WeCom document content';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: false }),
    content: Flags.string({ description: 'New document content', required: false }),
    'content-type': Flags.integer({ description: 'Content type (1=text, 2=HTML)', default: 1 }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EditDocContent);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('edit-doc-content', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags.docid) body.docid = flags.docid;
    if (flags.content) body.content = flags.content;
    if (flags['content-type'] !== undefined) body.content_type = flags['content-type'];
    await this.callDocTool('edit-doc-content', body);
  }
}
