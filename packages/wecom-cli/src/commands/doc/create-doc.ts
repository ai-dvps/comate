import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class CreateDoc extends BaseDocCommand {
  static override description = 'Create a WeCom document, smartpage, or smartsheet';

  static override flags = {
    'doc-type': Flags.integer({ description: 'Document type (3=document, 4=smartpage, 10=smartsheet)', required: false }),
    'doc-name': Flags.string({ description: 'Document name', required: false }),
    'admin-users': Flags.string({ description: 'Comma-separated admin user IDs', required: false }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CreateDoc);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('create-doc', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags['doc-type'] !== undefined) body.doc_type = flags['doc-type'];
    if (flags['doc-name']) body.doc_name = flags['doc-name'];
    if (flags['admin-users']) body.admin_users = flags['admin-users'].split(',');
    await this.callDocTool('create-doc', body);
  }
}
