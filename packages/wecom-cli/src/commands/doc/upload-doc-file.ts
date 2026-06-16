import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class UploadDocFile extends BaseDocCommand {
  static override description = 'Upload a file to a WeCom document';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: true }),
    'file-path': Flags.string({ description: 'Path to the file', required: true }),
    'file-name': Flags.string({ description: 'Display file name', required: false }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(UploadDocFile);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('upload-doc-file', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags.docid !== undefined) body.docid = flags.docid;
    if (flags['file-path'] !== undefined) body.file_path = flags['file-path'];
    if (flags['file-name'] !== undefined) body.file_name = flags['file-name'];
    await this.callDocTool('upload-doc-file', body);
  }
}
